# Phase 2 Results — conformal abstention

Principled abstention: pick the smallest calibrated-meta-prob cutoff whose
selected-set win-rate clears a target with a Wilson 90% lower bound (selective
risk control), per regime, validated on the frozen holdout. Resolves the full
tradeable population (every bar where a direction fires), gated by the cutoff.

## Crypto — DOMINANT win (ship)
Target win-rate ≥ 0.60. Conformal threshold τ ≈ **0.374** (calibrated meta-prob).

| holdout gate | traded | win% | EV/trade | total R |
|---|---|---|---|---|
| trade-all (no abstain) | 97.4% | 53.9% | +0.245R | +8,855 |
| **conformal τ=0.374** | **33.3%** | **73.4%** | **+0.754R** | **+9,302** |

Better on every axis at once: 3× EV/trade, +19.5pp win-rate, **higher total R**,
and **one-third the exposure**. The guarantee held out-of-sample (target 60%,
achieved 73.4%). Per-regime thresholds collapsed to the global value (the meta
head already encodes regime), so a single global τ suffices.

## Stock — conformal enforces (near) full abstention
Target win-rate ≥ 0.50. **No global threshold** satisfies the guarantee; only
regime-2 found one (0.456). Holdout: trade-all is +0.010R (breakeven) at 42.9%
win; the gate abstains entirely. Correct and honest — formalizes Phase 1's
finding that stock setups at this horizon aren't tradeable-win-positive. Don't
notify on stock setups under this regime; revisit only with the relative-threshold
follow-up or a different horizon.

## Ship decision
- **Crypto: GO.** Serve `confident = metaProb >= 0.374` (the `conformal.threshold`
  in the model JSON). Trade/notify only on confident bars. This *replaces* the
  hand-picked Phase 1 thresholds with a guarantee.
- **Stock: abstain** by default at this horizon (the gate already does this).

Rolls into the same crypto serving rollout as Phase 1 (model JSON `conformal`
block + the `confident` flag in `/ml-predict` + the prompt/notify gate). Thresholds
saved in `phase_results.json`.
