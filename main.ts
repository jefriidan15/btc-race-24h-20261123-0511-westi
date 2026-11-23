// Drift Rider — a trend-following cbBTC bot for make.fun btc-race-24h-20261123-0511.
//
// Idea: one-minute cbBTC bars are mostly noise (about 8 bps of standard deviation
// per minute on the dev window) with slow multi-hour drifts on top, and a full-size
// round trip costs roughly 40 bps in fees, slippage and pool impact. So the bot
// only trades when three independent trend readings agree, holds through the drift,
// and exits on the first sign the drift turned. It never chases one-minute noise.
//
// Signals (all on 1-minute closes):
//   - EMA fast (16) above EMA slow (48): the short trend points up.
//   - Close above EMA trend (192, about 3.2 hours): the bigger drift points up.
//   - 60-bar momentum above +0.10%: the last hour actually moved up.
// Entry spends all available cash (long only, one position, no leverage).
// Exits: fast EMA crosses back below slow EMA, or the close falls 0.90% below
// the peak since entry (trailing stop), or 1.20% below the entry close
// (hard stop). After any exit the bot waits 30 bars before re-entering, so a
// whipsaw cross cannot flip it straight back in.
//
// Everything is a pure function of the bars the harness sends: no wall clock,
// no randomness, no network, no files. Two runs on the same data answer alike.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tunable parameters (one place, tuned on the published dev window) ---
const FAST_PERIOD = 16;
const SLOW_PERIOD = 48;
const TREND_PERIOD = 192;
const MOMENTUM_BARS = 60;
const MOMENTUM_MIN_BPS = 10; // +0.10% over the last hour
const TRAILING_STOP_BPS = 90; // 0.90% below the peak since entry
const HARD_STOP_BPS = 120; // 1.20% below the entry close
const COOLDOWN_BARS = 30;
const MAX_SLIPPAGE_BPS = 150; // generous vs ~8 bps/min noise; impact counts toward it

// --- running state (bars only; the account itself comes from the harness) ---
const closes: number[] = [];
let emaFast = 0;
let emaSlow = 0;
let emaTrend = 0;
let barsSeen = 0;
let entryClose = 0;
let peakClose = 0;
let cooldownUntil = -1;
let wasLong = false;

function emaUpdate(previous: number, price: number, period: number): number {
  const k = 2 / (period + 1);
  return price * k + previous * (1 - k);
}

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    // Warm-up batches cannot trade; just observe them.
    if (state.warmingUp) return [];

    const closeRaw = state.close(SYMBOL);
    if (closeRaw === null) return [];
    const symbol = state.hello.symbols.find((s) => s.symbol === SYMBOL);
    if (symbol === undefined) return [];
    const price = Number(closeRaw) / 10 ** symbol.price_scale;

    // Fold this bar into the indicators.
    if (barsSeen === 0) {
      emaFast = price;
      emaSlow = price;
      emaTrend = price;
    } else {
      emaFast = emaUpdate(emaFast, price, FAST_PERIOD);
      emaSlow = emaUpdate(emaSlow, price, SLOW_PERIOD);
      emaTrend = emaUpdate(emaTrend, price, TREND_PERIOD);
    }
    closes.push(price);
    barsSeen += 1;

    const position = state.positions.get(SYMBOL);
    const qty = position === undefined ? 0n : position.qty;
    const isLong = qty > 0n;

    // Track entry / peak while long; arm the cooldown on the bar we exit.
    if (isLong) {
      if (!wasLong) entryClose = price;
      if (price > peakClose) peakClose = price;
    } else if (wasLong) {
      cooldownUntil = barsSeen + COOLDOWN_BARS;
      entryClose = 0;
      peakClose = 0;
    }
    wasLong = isLong;

    // --- exits (only when long) ---
    if (isLong) {
      const crossedDown = emaFast < emaSlow;
      const trailingHit = peakClose > 0 && price < (peakClose * (10000 - TRAILING_STOP_BPS)) / 10000;
      const hardStopHit = entryClose > 0 && price < (entryClose * (10000 - HARD_STOP_BPS)) / 10000;
      if (crossedDown || trailingHit || hardStopHit) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- entries (only when flat) ---
    if (barsSeen < TREND_PERIOD) return [];
    if (barsSeen <= cooldownUntil) return [];
    if (!(emaFast > emaSlow)) return [];
    if (!(price > emaTrend)) return [];
    if (closes.length > MOMENTUM_BARS) {
      const hourAgo = closes[closes.length - 1 - MOMENTUM_BARS];
      const momentumBps = ((price - hourAgo) / hourAgo) * 10000;
      if (momentumBps < MOMENTUM_MIN_BPS) return [];
    } else {
      return [];
    }

    const spend = state.weightRoom(SYMBOL);
    const cash = state.cash;
    const notional = spend < cash ? spend : cash;
    if (notional <= 0n) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
