[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/jefriidan15/btc-race-24h-20261123-0511-westi/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/jefriidan15/btc-race-24h-20261123-0511-westi/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

# Drift Rider — cbBTC trend bot

Entry for the [make.fun bounty](https://make.fun/bounty/btc-race-24h-20261123-0511): race a BTC trading bot live for 24 hours. Simulation only — paper money against real on-chain cbBTC prices, no real money traded.

## Strategy

One-minute cbBTC bars are mostly noise (~8 bps standard deviation per minute on the dev window) with slow multi-hour drifts on top, and a full-size round trip costs roughly 40 bps in fees, slippage and pool impact. So this bot only trades when three independent trend readings agree, holds through the drift, and exits on the first sign the drift turned:

- **Enter long** when EMA-16 is above EMA-48, the close is above EMA-192, and the 60-bar momentum is above +0.10%. Spends all available cash (long only, one position, no leverage).
- **Exit** when EMA-16 crosses back below EMA-48, or the close falls 0.90% below the peak since entry (trailing stop), or 1.20% below the entry close (hard stop).
- **Cooldown** of 30 bars after any exit, so a whipsaw cross cannot flip it straight back in.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only). Speaks `agent-fun/bars-replay/v1` through the kit shim.
- `vendor/makefun-bars.ts` — the kit's protocol shim, copied byte-for-byte from the competition kit.

## Local grade

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

The bot is a pure function of the bars the harness sends: no wall clock, no randomness, no network, no files outside the repository. Two runs on the same data answer alike.
