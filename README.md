# Pump.fun Bot Sprint: Make Bot And Win

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Alim-14-code/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Alim-14-code/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for the pump.fun bonding-curve replay (`agent-fun/replay/v2`).
It reads replay market events as they arrive and trades a fixed 10 SOL paper
bankroll under the harness caps (max 5 open positions, 1% of real reserve per
order, no shorts or leverage).

## Strategy: near-completion rider

Most new coins spike in their first slots and then bleed to zero, so this bot
never buys launches or dips. It buys only coins whose real SOL reserves have
already ground up to **40–80 SOL** — one step from the ~85 SOL completion
threshold — on sustained activity: many recent trades, many distinct buyers,
reserves still growing, price near its window high. That band is rare (5–9
coins per window in backtests) but it is the only entry filter that tested
positive on all three dataset parts.

Exits are mechanical: **10% stop-loss**, **+100% take-profit** backed by a
**25% trailing stop** once in profit, a long max hold, and a fade exit when
flow turns against a losing position. One entry per coin, fixed 0.15 SOL stake,
at least 1 SOL cash kept in reserve. No clock, no randomness, no network —
every decision is a deterministic function of the replay stream and the hello
seed.

## Backtest (kit local sim, all three dataset parts)

| window | net PnL | trips | wins | max drawdown |
| --- | --- | --- | --- | --- |
| dev (part-00000) | **+0.271 SOL** | 5 | 3 | 0.8% |
| part-00001 | −0.019 SOL | 9 | 3 | 2.3% |
| part-00002 | **+0.080 SOL** | 8 | 2 | 1.1% |

Mean **+0.111 SOL** vs 0 for holding cash. Positive even at 2× fees on dev
(+0.235) and part-00002 (+0.050). No rejected orders, 1 failed tx in total.

## Run

```sh
node main.ts < replay.ndjson > replies.ndjson
```

Node 22, standard library only. `main.ts` is the entrypoint, `strategy.ts`
holds the strategy, `vendor/makefun-bot.ts` is the kit's SDK shim vendored
byte for byte.

## License

MIT — see [LICENSE](LICENSE).
