# Stock direction model — REJECTED

Tested whether the crypto direction success ([[edge-crypto-direction-model]]) transfers to
stocks. It does not. Same recipe → chance. Decisive negative; no stock direction head ships.
Script: `ml-training/direction_model_compare.py` (runs both markets head-to-head).
Methodology: [[edge-methodology]]. Logged in [[rejected-hypotheses]].

## Result
```
STOCK — direction model vs indicators (frozen holdout)
  overfit check: selection 62.4%  holdout 53.0%   (gap +9.5 → MEMORIZES, no signal)
  high-ML P(up)=51%, majority baseline 51%
  DIRECTION MODEL by confidence:
    pUp≥0.55:  50% cover  52.4%  (+1.5 vs maj)   ← noise
    pUp≥0.60:  16% cover  44.7%  (−6.2)          ← WORSE than chance
    pUp≥0.65:   3% cover  40.7%  (−10.1)
    pUp≥0.70:   0% cover                          ← never gets that confident
  per-regime WF: 50.6 / 51.5 / 54.1 / 51.1 / 54.8%  — flat at chance, all 5 folds
```

The +9.5pp selection→holdout gap is the tell: the model memorizes the training set and
generalizes to nothing. When it *does* get "confident" (pUp≥0.60) it's actively wrong.

## Why — bimodality, proven at the model level
| | Indicators @ high ML | Dedicated model |
|---|---|---|
| **Crypto** | dStoch 76%, union 79% | **94.7%** — model beats indicators |
| **Stocks** | dStoch 45%, union 46% | **chance** — can't beat a coin flip |

For crypto the signal is real (momentum-driven market), so both indicators *and* the
111-feature model find it. For stocks neither does — 24h direction is genuinely
unpredictable (efficient/mean-reverting). The model can't manufacture signal that isn't
there.

## Architectural consequence
- **Crypto** → ML quality gate **plus** the direction model feeding the LLM a directional
  lean.
- **Stocks** → ML quality gate **only**; the LLM forms direction from structure/levels/
  confluence. `mlPredictDirection` returns null for stocks; the prompt + indicators-table
  Direction row hide for stocks; the [[live-validation]] dual-gate never fires on stocks
  (52% directional accuracy on Tier-1 ML signals — a coin flip).

This is *why* the live scoreboard is crypto-only. The discipline of shipping the negative
result is the point — the alternative was a random-number generator dressed up as a
probability.
