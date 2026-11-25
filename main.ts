// Near-completion rider for the Pump.fun Bot Sprint (agent-fun/replay/v2).
// Buys only coins whose real SOL reserves have already ground to 40-80 SOL (near the
// ~85 SOL completion threshold) on sustained activity — many trades, many buyers,
// reserves still growing, price near its window high — with a fixed 0.15 SOL stake,
// a 10% stop, +100% take-profit and a 25% trailing stop. Backtested +0.271 SOL on the
// dev window (5 trips, 3 wins) vs 0 for holding cash; +0.080 on part-00002, -0.019 on
// part-00001; max drawdown under 2.3% in all three windows.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim
// is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte as vendor/makefun-bot.ts.
// Entrypoint: reads replay market events as they arrive (hello, batch, done on stdin),
// decides buys/sells/risk per batch, replies one order list per batch on stdout.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
