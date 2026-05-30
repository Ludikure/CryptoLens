# Phase 1 Results — triple-barrier meta-model + quantile TP2

Experimental case complete. All numbers on the Phase 0 clean split; the **holdout
exam** is on the frozen last-6-months never seen during selection/calibration.

## 1. The label is materially optimistic (the problem, quantified)
Of rising-edge `goodR=1` tradeable bars, the fraction that are actually
triple-barrier **losses** (stopped before the favorable target):
- **Stocks 49.1%** · **Crypto 17.3%**. The current target ignores the adverse
  excursion and overcounts wins — worst for stocks.

## 2. Crypto — SHIP IT (holdout-confirmed)
Calibrated direction-conditioned meta gate vs the current goodR gate:

| | EV/trade | n | total R |
|---|---|---|---|
| baseline goodR (holdout) | +1.017R | 1,491 | +1,516 |
| **meta-filter @0.60** (holdout) | **+1.131R** | 1,323 | +1,496 |
| **meta-primary @0.55** (holdout) | +0.973R | 2,889 | **+2,812** |

Two usable modes, both improving on baseline out-of-sample:
- **Precision mode** (meta-filter): +0.11–0.13R/trade at ~10% fewer trades.
- **Volume mode** (meta-primary): ~**2× total R** at ≈baseline EV/trade.

**Quantile head (1c):** adaptive TP2 = clip(predicted q75 of fwdMaxFavR, 2–5 ATR)
beats the fixed 3.0 ATR runner: **+1.567R vs +1.493R (+0.075R/trade)**, median
TP2 2.93 ATR. The fixed 3.0 we shipped was already near the mean-optimum; the gain
is from per-bar adaptation. Small but free.

## 3. Stocks — the meta head says "mostly don't trade" (honest negative)
Even calibrated, stock meta-prob rarely clears 0.55 (holdout: n=0 at 0.55–0.65).
This is not a broken model — it correctly reflects that **stock setups at this
horizon are mostly not tradeable-win-positive** (49% of even "good" bars lose, and
the stock baseline itself is only +0.05R on the recent holdout). The few bars that
do clear (selection n=5–10) are high-EV (+0.95–1.4R).

Actionable conclusion for stocks: the meta head functions as an **extreme
selectivity filter** — trade very few stock setups, only the top sliver. A fixed
crypto-style threshold won't fire; a **relative threshold** (e.g. top-decile
meta-prob per regime) is the follow-up. Stocks deserve deprioritization at this
horizon regardless.

## 4. Ship decision
- **Crypto: GO.** Add the calibrated meta head + quantile TP2 to serving.
- **Stocks: HOLD as a gate; keep the triple-barrier relabel as the honest target.**
  Pursue relative-threshold ranking before gating stock notifications on meta.

## 5. Remaining Phase 1 work to make crypto LIVE (serving + parity)
Experiment is proven in Python; production rollout is a distinct effort:
1. Retrain the production crypto quality + **meta** + **quantile** heads via the
   `calibrate_*` scripts; write `heads.meta` / `heads.quantiles` into the model
   JSON per `MODEL_JSON_SCHEMA.md` (additive — quality head unchanged).
2. Implement the meta + quantile read paths in `ML/MLScoring.swift` (iOS) and
   `marketscope-worker/src/ml-predict.ts` (worker) at 1e-7 parity.
3. **Capture new parity fixtures** — *requires the manual iOS BacktestView →
   "Capture Parity Fixture" (DEBUG) step*; assert `probabilityMeta` / `q75` in
   `test/parity-vs-backtest.test.ts`. (Blocker that needs the user.)
4. Serve `probabilityMeta` / `q75` via `/ml-predict`; gate the prompt + notify on
   `ML_META` (precision or volume mode, TBD) and feed q75 into target selection.
5. Deploy worker + install iOS; validate on the frozen holdout once more post-ship.

Scripts: `phase1_meta.py` (initial), `phase1_final.py` (calibration + quantile +
holdout). Results in `phase_results.json`.
