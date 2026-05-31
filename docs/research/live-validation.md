# Live validation — the dual-gate scoreboard

Turns the backtest's direction claims into a **forward, out-of-sample** track record that
accumulates autonomously, server-side, across the whole crypto universe. Built 2026-05-30.
This is the one thing that measures the survivorship + execution gap the backtest can't.
Models being validated: [[edge-crypto-direction-model]], [[edge-direction-primitive]].

## What fires
A "dual-gate signal": on a cron tick, for any crypto symbol,
- ML Win **crosses up** through 0.70 (rising edge, not just sitting above), **and**
- the direction model commits: `pUp ≥ 0.70` (long) or `≤ 0.30` (short).

Deduped to **one open signal per symbol** (so ML chatter across 0.70 doesn't spam the same
move). Crypto only — stocks have no `pUp` ([[edge-stock-direction-rejected]]).

## How it grades
- `logDirectionSignals` writes a row (symbol, entry price, predicted dir, pUp, ml_win) to
  the `direction_signals` D1 table at fire time.
- `resolveDirectionSignals` grades each against the realized price **24h later**
  (`fwd_return`, `actual_dir`, `correct`).
- Both run in the cron symbol pass (`marketscope-worker/src/index.ts`), fault-isolated from
  notifications.
- `GET /direction-accuracy` serves the aggregate: overall accuracy, by confidence band,
  **by direction** (long vs short separately), **by symbol** (per-instrument, with L/S
  split), recent signals, pending count, vs the 94.7 backtest baseline.

## Where it shows
iOS: `DirectionAccuracyService` → Settings → Data → Outcome Tracking → "Direction Model —
Live (crypto)" + "By Instrument — Live (crypto)". Gated to hide until ≥1 signal exists.

## Universe, not watchlist
Logs across all 76 `ARCHIVE_CRYPTO` symbols regardless of watchlist — maximizes sample
size so the live number converges in **weeks not years** (~15/day universe-wide). Same
universe the backtest measured → apples-to-apples (same survivorship caveat).

## What it measures vs doesn't
- ✅ Is the model's **direction call** right, on the realized 24h sign.
- ❌ Your actual fills — pre-slippage, pre-funding, like the backtest. Pair with the
  in-app `OutcomeTracker` (LLM-setup outcomes) for the execution half.

## What to watch
1. Does live accuracy track the 94.7% backtest as N grows?
2. **Does accuracy rise with confidence band** (pUp 70-80 < 80-90 < 90+) the way it does
   in the backtest? If yes → the model is genuinely calibrated, not curve-fit.
3. **Long vs short asymmetry** — holdout was 64% short-skewed; does either side underperform?
4. Per-symbol — weight by n; "100% (3/3)" is noise, "94% (15/16)" is signal.
