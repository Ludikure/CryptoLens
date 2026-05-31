# Crypto direction model

A dedicated ML head predicting **direction** (`up = fwdReturn24H > 0`), not just trade
quality. Crypto only — stocks failed the same test ([[edge-stock-direction-rejected]]).
Built + validated 2026-05-30. Scripts: `crypto_direction_model.py`, `export_heads.py`,
`direction_leak_audit.py`. Methodology: [[edge-methodology]]. The indicator-based version:
[[edge-direction-primitive]].

## The model
XGBoost (depth 5, 100 trees), target `up`, all 111 features, **uniform sample weights**
(recency weighting biases UP in a bull). Calibrated (isotonic, cap 0.95). Ships as
`heads.direction` in `ml-model-crypto.heads.json` (additive — evaluator reads known heads,
ignores unknown). Worker: `mlPredictDirection()` in `marketscope-worker/src/ml-predict.ts`.
Parity worker↔Python at 1.25e-07.

## Holdout results (frozen, never-selected)
```
overfit check: selection 68.4%  holdout 69.1%  (gap −0.7 → generalizes cleanly)
high-ML (ML≥0.70) directional accuracy:
  pUp≥0.50 (100% cover):  79.7%
  pUp≥0.70 ( 60% cover):  94.7%
per-regime (WF): 81 / 79 / 84 / 85 / 83%  — holds through the 2022 bear
```
The model **beats the indicators** it was built alongside: dStoch 76% / union 79% at full
coverage vs the model's 79.7%, rising to 94.7% on its confident subset. Indicators were
already good on crypto; the model extracts a bit more.

## Why crypto direction is learnable (and stocks isn't)
Crypto is **momentum-driven**: today's momentum state genuinely predicts the next few
hours. High ML selects big-move bars where a fresh Stoch cross is a directional initiator.
Stocks are efficient/mean-reverting — no such persistence. This bimodality is the central
finding; see [[edge-stock-direction-rejected]] for the controlled proof.

## Leakage audit — three kill-tests, all clean
`ml-training/direction_leak_audit.py`. 94.7% is the kind of number that demands proof it
isn't look-forward:

1. **Correlation scan** — max |corr| of any feature with the target = **0.273** (dRsiDelta).
   No column near a leak signature (>0.5). Top correlates are all momentum/rate-of-change.
2. **Label-shift decay** — predict k bars ahead from today's features:
   `k=0: 79.6% → k=1: 70.3% → k=2: 62.7% → k=3: 52.6% → k=6: 50.8%`. Clean monotonic fade
   to chance = genuine momentum persistence. A leak would stay pinned high.
3. **Shuffle null** — shuffle the target → model collapses to **50.1%** (vs 79.7% real).
   No structural/index leakage path.

Matches the earlier single-indicator lag test (dStoch 76→64→58→50). **Not cheating.**

## Residual caveats (not leakage)
Survivorship (winners-only universe) and execution cost (raw 24h sign, pre-slippage/
funding). [[live-validation]] measures the live gap.

## Serving (live)
Cron computes `pUp` per symbol → `/ml-predict` → `IndicatorResult.mlDirectionUp` → both the
LLM prompt (DIRECTION MODEL line) and the indicators table ("Direction" row, crypto-only).
