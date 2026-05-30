# Phase 6 Results — architecture (ensemble DROP; per-cluster marginal)

After two feature negatives, tested the MODEL side on the conformal-gated holdout.

## 6a Ensemble (3 diverse GBMs, depth 4/5/6) — DROP
| crypto holdout | tau | n | win% | EV/trade |
|---|---|---|---|---|
| single GBM (baseline) | 0.374 | 12,336 | 73.4% | +0.754R |
| 3-GBM ensemble | 0.378 | 12,716 | 73.0% | **+0.744R (−0.010)** |

Variance reduction doesn't beat the single GBM — the base learner is already
low-variance at this depth/regularization. Drop.

## 6b Per-cluster (volatility terciles) — marginal positive
Split symbols by median `atrPercent` (fit on selection), meta-model per cluster:

| cluster | n | EV/trade | tau |
|---|---|---|---|
| 0 (low vol) | 3,312 | **+0.854R** | 0.406 |
| 1 (mid vol) | 3,381 | +0.742R | 0.387 |
| 2 (high vol) | 4,860 | +0.746R | 0.371 |
| **pooled** | | **+0.776R** | |

+0.022R/trade over the single global model (+0.754R), driven almost entirely by
the low-vol cluster (+0.854R). Real but marginal. Much of the gain looks like it
comes from the per-cluster *threshold* (low-vol τ=0.406 > global 0.374), not the
per-cluster *model* — so a cheaper capture is a single global model with a
**per-volatility-cluster conformal τ**, avoiding 3 separate models.

## Verdict
- Ensemble: **DROP**.
- Per-cluster: **marginal (+0.022R), optional.** If pursued, do the cheap version
  (one model, per-vol-cluster conformal threshold) rather than per-cluster models.

Stocks abstain throughout. Combined with Phases 4–5, the conclusion is firm: the
Phase 1+2 stack (triple-barrier meta + conformal abstention) is near-saturated on
this feature set; architecture tricks return marginal-to-negative. Remaining real
upside is the LLM layer (Phase 3, live A/B only).

Scripts: phase6_architecture.py. Results in phase_results.json.
