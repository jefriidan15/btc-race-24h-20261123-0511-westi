// Drift Rider — a trend-following cbBTC bot for make.fun btc-race-24h-20261123-0511.
//
// Idea: one-minute cbBTC bars are mostly noise (about 8 bps of standard deviation
// per minute on the dev window) with slow multi-hour drifts on top, and a full-size
// round trip costs roughly 40 bps in fees, slippage and pool impact. Fast
// trend-following bleeds on this market: it buys after the move, sells the
// pullback, and pays the round trip over and over. So this bot trades rarely
// and holds: it enters only when the drift is established on every horizon it
// watches, then stays in until a wide trailing stop or a hard stop says the
// drift is over. It never exits on a fast EMA cross — on a grinding market the
// cross fires on noise and the re-entry comes back late and expensive.
//
// Signals (all on 1-minute closes):
//   - EMA fast (24) above EMA slow (72): the short trend points up.
//   - Close above EMA trend (240, four hours): the bigger drift points up.
//   - 240-bar momentum above +0.30%: the last four hours actually moved up.
// Entry spends all available cash (long only, one position, no leverage).
// Exits: the close falls 2.00% below the peak since entry (trailing stop), or
// 3.00% below the entry close (hard stop). After any exit the bot waits 60
// bars before re-entering, so a whipsaw cannot flip it straight back in.
//
// Tuned on the published dev window (24 Nov 2026 dev: +$21.00, 2 trades, 2.0%
// max drawdown) and checked on the earlier 15 Nov window (a falling day, where
// the same rules lose about $21 — the price of holding through a down day with
// a 2% trailing stop). The dev gate only needs the dev window above zero; the
// race window is unseen, so the rules are kept slow and simple rather than
// fitted to one window's wiggles.
//
// Everything is a pure function of the bars the harness sends: no wall clock,
// no randomness, no network, no files. Two runs on the same data answer alike.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tunable parameters (one place, tuned on the published dev window) ---
const FAST_PERIOD = 24;
const SLOW_PERIOD = 72;
const TREND_PERIOD = 240;
const MOMENTUM_BARS = 240;
const MOMENTUM_MIN_BPS = 30; // +0.30% over the last four hours
const TRAILING_STOP_BPS = 200; // 2.00% below the peak since entry
const HARD_STOP_BPS = 300; // 3.00% below the entry close
const COOLDOWN_BARS = 60;
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

    // --- exits (only when long): wide stops only, never a fast EMA cross ---
    if (isLong) {
      const trailingHit = peakClose > 0 && price < (peakClose * (10000 - TRAILING_STOP_BPS)) / 10000;
      const hardStopHit = entryClose > 0 && price < (entryClose * (10000 - HARD_STOP_BPS)) / 10000;
      if (trailingHit || hardStopHit) {
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
      const fourHoursAgo = closes[closes.length - 1 - MOMENTUM_BARS];
      const momentumBps = ((price - fourHoursAgo) / fourHoursAgo) * 10000;
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
