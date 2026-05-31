# ML model versions & reliability

The quality model: direction-agnostic `goodR = fwdMaxFavR >= 1.5` — P(≥1.5 ATR favorable
move in 24h). Answers "trade or not?", not "which way" (that's
[[edge-crypto-direction-model]]). Methodology: [[edge-methodology]]. Heads:
[[ml-additive-heads]].

## Current production
- **Crypto v11** (2026-05-28) — LightGBM depth 4, 150 trees. 77 symbols, 136,551 bars.
  62% WF accuracy (folds 61.6/61.8/62.6). Top-bucket **76.3%**.
- **Stock v13** (2026-05-29) — XGBoost depth 5, 100 trees. 159 symbols, 228,487 bars.
  64.7% WF accuracy (folds 63.4/64.5/66.2). Top-bucket **79.9%**.
- 111 features. Isotonic calibration, cap 0.85. Walk-forward 3-fold expanding, 48-bar
  purge, daily downsample, time-decay weighting (last yr 3×, last 2 yr 2×).

## The "own-data" trap (why headline WF looks lower than predecessors)
v10/v12's stated accuracies (crypto 73.4%, stock 66.8%) were measured **on their own
training data** — not comparable to a fresh-data WF number. On *identical fresh data*:
- v11 beats v10 by +3.6pp raw, **+16.1pp top-bucket** (76.3% vs 60.2%).
- v13 beats v12 by +6.8pp raw, +4.0pp top-bucket.
The new models issue **fewer** high-confidence signals but each wins more often. Lesson:
always state the measurement basis (see [[edge-methodology]]); never compare own-data to
fresh-data accuracy. Comparison: `marketscope-worker/scripts/evaluate-model.ts`.

## Calibrated reliability (full population)
```
v11 crypto (819K bars, 50.5% baseline goodR)      v13 stocks (455K bars, 55.0% baseline)
  <30%:  23.6%                                       <30%:  22.4%
  30-50: 40.2%                                        30-50: 41.2%
  50-60: 56.0%                                        50-60: 59.5%
  60-70: 66.4%                                        60-70: 70.0%
  70-85: 76.3%  ← top bucket                          70-85: 79.9%  ← top bucket
```
Calibration is honest: predicted bands match actual win rates closely. This is what makes
the ML Win number trustworthy as a gate.

## Serving & parity
Worker is the single source of truth (`mlPredict()` in `ml-predict.ts`); iOS reads
`/ml-predict`. Native Swift tree evaluator (no CoreML) for `BacktestEngine`. Worker↔
BacktestEngine parity asserted at **1e-7** (345/345 tests, `parity-vs-backtest.test.ts`).

## Training scripts
`ml-training/calibrate_v11_crypto.py` (LGB d4 t150, reads `csv_exports_v11/`),
`calibrate_v13_stocks.py` (XGB d5 t100, reads `csv_exports_v13/`). Both write worker + iOS
JSONs. CSV regen via Node-CLI `marketscope-worker/scripts/runBacktest.ts`.

## Full-precision tree extraction gotcha
`get_dump`/`trees_to_dataframe` **round** leaf values (~1e-1 error over 100 trees). Must
parse `save_model` JSON where **leaf output is in `split_conditions[i]`** (not
`base_weights`, the pre-shrinkage Newton weight). base_score from `learner_model_param`.
This was the bug behind an early heads-parity failure (see [[ml-additive-heads]]).
