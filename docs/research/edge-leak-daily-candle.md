# The daily in-progress-candle leak (the one that faked crypto direction)

**Found 2026-06-02.** The most consequential data leak in the project. It invalidated the
entire crypto **direction** edge — the 94.7% dual-gate, the `pUp` head, the dual-gate live
loop — while leaving the **quality** (ML_WIN) edge essentially intact. Methodology context:
[[edge-methodology]]. What it killed: [[edge-crypto-direction-model]]. What survived and how
we monetize it: [[strategy-variance-harvest]].

## The mechanism
`marketscope-worker/scripts/runBacktest.ts` built each bar's feature vector from
`const dailyFull = sliceUpTo(dailyAll, evalTime)` — which **includes the in-progress
(current-day) daily candle** at every intraday 4H evaluation. So the daily-timeframe features
(`dRsi`, `dRsiDelta`, `dStochCross`, `dBBPercentB`, …) at, say, 04:00 UTC already "saw" the
daily bar's eventual close — i.e. the rest of the day. That window **overlaps the 24h forward
label**. Live serving drops the in-progress daily via `dropInProgress()`; the backtest never
did. Training learned a relationship live could never reproduce.

Fix (one line): `const dailyFull = sliceUpTo(dailyAll, evalTime - 86_400_000)` — exclude the
in-progress day. Verified closed: top feature↔forward-label correlation (`dRsiDelta`)
collapsed **0.33 → ~0.00**; a full 77-symbol clean regen (`csv_exports_v11_fixed`) reproduced
honest numbers.

## Why crypto-fatal, stock-spared (the tell)
Crypto trades **24/7** — the leaked daily close is ≈ the forward price the 24h label measures,
so the leaked daily features were almost a copy of the answer. Stocks **gap overnight** — the
leaked close decorrelates from the next session's move, so the same leak barely bit. This is
the entire explanation for the most seductive false signal in the project: *"direction works
for crypto but not stocks."* It was never a market-structure truth ([[edge-stock-direction-rejected]]
read it as crypto-is-momentum / stocks-are-efficient). It was a leak that only fires on
continuous-price instruments. **The crypto-vs-stock asymmetry was the diagnostic, not the finding.**

## Three independent confirmations it was a leak
1. **Live forward test:** the dual-gate signals resolved **3/7 correct** (~coin flip), not 94.7%.
2. **Clean-data re-measure:** direction is ~50% even at ML_WIN ≥ 85% across every primitive
   (direction model, daily Stoch, bias) — `strategy_clean_test.py`, `barrier_ordering.py`.
3. **Multi-period probe** (`ml-training/direction_multiperiod.py`): the leaked pipeline showed
   94–97% in *every* non-overlapping holdout window (mean 95.4%, std 1.0). Too-consistent
   across regimes is itself a leak signature — a real edge breathes with the market.

## What survived (important)
The **quality** model (`goodR = fwdMaxFavR ≥ 1.5`, direction-agnostic) barely moved: clean
WF **62/62/63%**, top-bucket **76.4% vs ~51% base** — vs the leaked v11's 61.6/61.8/62.6. The
leak rode on *daily* features predicting *direction*; the quality target is about *magnitude*
and was largely immune. So ML_WIN was honest all along; only the direction layer was fake.

## Shipped on discovery (deployed worker `93a6cc67`, commit `dd89230`)
- `mlPredictDirection()` returns **null unconditionally** — `pUp` no longer served; the
  dual-gate `direction_signals` logger goes quiet; iOS/web hide the direction row.
- Honest crypto quality model retrained on clean data: `ml-training/calibrate_v12_crypto_clean.py`
  → worker + iOS `ml-model-crypto.json` (`version 12`, `v12-CLEAN`). Leaked model backed up at
  `/tmp/ml-model-crypto.LEAKED.bak.json`.
- Parity fixtures' crypto ML updated to honest values (BTC .527→.386, ETH .653→.502);
  377/377 worker tests green.

## The lesson
A continuous-price market will leak the in-progress bar's close into any feature computed from
the "current" higher-timeframe candle. **Any crypto timing/direction backtest must confirm the
higher-TF slice drops the in-progress bar.** And when a number is suspiciously stable across
regimes, or holds only on the 24/7 instrument and not the gapping one, suspect the clock.
