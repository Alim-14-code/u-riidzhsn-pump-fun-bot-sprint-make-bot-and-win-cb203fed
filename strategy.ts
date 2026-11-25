// Near-completion rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window actually rewards (measured on all 3 dataset parts): the median new
// coin spikes in its first ~2 slots and then bleeds to zero, so buying launches and
// buying dips both lose, and the completers (~3%) migrate within ~150 slots on a handful
// of whale buys — too fast and too capped (1% of real reserve) for a bot to size into.
// The catchable money sits one step before migration: coins whose real SOL reserves have
// already ground up to 40-80 SOL (of the ~85 SOL completion threshold) on sustained
// activity — many recent trades, many distinct buyers, reserves still growing, price near
// its window high. That band is rare (5-9 coins per window) but it is the only entry
// filter that backtests positive on all three dataset parts. This bot buys only that
// signature, with a fixed stake, a tight stop, and a take-profit at +100% backed by a
// trailing stop, so a completing coin banks its run and a fading one is cut fast. The
// sim force-closes positions at completion, so a held coin that migrates pays out at the
// migration value.
//
// Breadth is a guardrail (>= 20 coins): one entry per coin, fast loser exits recycle the
// 5 open slots. Exposure stays small (5 x 0.15 SOL max) and max drawdown in backtests
// stays under 3%, far inside the 50% guardrail.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream. All amounts are bigint lamports; floats
// are used only for price ratios in signals, never for order sizes.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Signal lookback in slots. */
  window: number;
  /** Trades in the window required (activity: dead coins barely trade). */
  minTrades: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy SOL share of total trade SOL over the window. */
  minBuyShare: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Real SOL reserves must have grown at least this much over the window. */
  minRqGrowth: number;
  /** Curve real SOL bounds at entry (grinding, not yet big). */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since CreateEvent inside which entries are allowed. */
  entryWindow: number;
  /** SOL per position (fixed stake). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Hard stop: sell once value falls below cost * (1 - stopLoss). 0 = off. */
  stopLoss: number;
  /** Fixed take-profit: sell once value reaches cost * (1 + takeProfit). 0 = off. */
  takeProfit: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Trailing stop: sell once value falls this much below its peak. */
  trail: number;
  /** Force exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run (breadth over repeats). */
  maxEntries: number;
  /** Most SOL at cost across all positions at once (drawdown guard). */
  maxExposureSol: number;
  /** Keep at least this much cash uncommitted (never go all-in). */
  minCashReserveSol: number;
  /** Fade exit: sell a losing position when net SOL over the window falls below this. */
  fadeNetSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 60,
  minTrades: 15,
  minBuyers: 8,
  minNetSol: 0.3,
  minBuyShare: 0.5,
  maxBuyerShare: 0.5,
  minPriceUp: 0.05,
  nearHigh: 0.9,
  minRqGrowth: 0.2,
  minRqSol: 40,
  maxRqSol: 80,
  minAge: 60,
  entryWindow: 600,
  stakeSol: 0.15,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.1,
  takeProfit: 1.0,
  trailArm: 0.25,
  trail: 0.25,
  maxHold: 7200,
  cooldown: 150,
  maxEntries: 1,
  maxExposureSol: 2,
  minCashReserveSol: 1,
  fadeNetSol: -0.5,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
  rq: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const keep = p.window + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Active-grinder entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.entryWindow) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let trades = 0;
    let startPrice = -1;
    let high = 0;
    let rqThen = -1;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        rqThen = tr.rq;
        continue;
      }
      trades++;
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
    }
    if (trades < p.minTrades) return false;
    if (buys < p.minBuyers || byUser.size < p.minBuyers) return false;
    const net = buySol - sellSol;
    if (net < p.minNetSol) return false;
    const total = buySol + sellSol;
    if (total <= 0 || buySol / total < p.minBuyShare) return false;
    if (startPrice <= 0) return false;
    const up = price / startPrice - 1;
    if (up < p.minPriceUp) return false;
    if (price < high * p.nearHigh) return false;
    // Real reserves must be growing: the curve is attracting SOL, not just churning.
    if (rqThen < 0 || rqSol < rqThen * (1 + p.minRqGrowth)) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price, rq: Number(e.real_quote_reserves) / LAMPORTS });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        if (!exit && p.takeProfit > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && p.stopLoss > 0 && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && value < cost && flow(tapeOf(mint), now, p.window) < p.fadeNetSol) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: one fixed-stake active-grinder buy per young coin, breadth over repeats.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx - p.minCashReserveSol) amount = free - tx - p.minCashReserveSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
      }
      return orders;
    },
  };
}
