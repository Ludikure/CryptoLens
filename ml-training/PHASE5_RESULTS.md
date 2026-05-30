# Phase 5 Results — direction enhancements (path features NEGATIVE; regime gradient noted)

Direction is the ~50/50 weak spot. Tested whether path/sequence features (which
capture path SHAPE the point-in-time features miss) improve the conformal-gated
meta-model, plus whether direction quality varies by regime.

## Path/sequence features — no improvement (dropped)
Added: efficiencyRatio10 (Kaufman), runLength, volRatio (compression), rangePosition.

| crypto holdout (conformal-gated) | tau | n | win% | EV/trade |
|---|---|---|---|---|
| baseline (111 feats) | 0.374 | 12,336 | 73.4% | +0.754R |
| + path/sequence | 0.384 | 12,017 | 73.3% | **+0.754R (+0.000)** |

Zero delta. The 111 features already include momentum deltas, acceleration
(hRsiAccel/hMacdAccel/dAdxAccel), 1-bar deltas, and bodyWickRatio — path shape is
already represented. **Drop.** Stocks abstain either way.

## Regime gradient (informative, mostly already captured)
dStoch direction quality on the full holdout tradeable set, by `regimeCode`:

| regime | n | win% | EV/trade |
|---|---|---|---|
| 0 | 6,178 | 57.3% | +0.319R |
| 1 | 5,391 | 58.4% | +0.358R |
| 2 | 4,981 | 62.0% | **+0.417R** |

There's a real gradient (regime 2 setups are ~+0.10R better than regime 0), but the
conformal meta gate already exploits it — Phase 2's per-regime τ collapsed to the
global value because the meta head already encodes regime. So regime-conditional
direction machinery isn't worth building; the existing stack captures it. A mild
"prefer regime-2 setups" tilt is the only residual, and it's marginal.

## Verdict
- Path/sequence features: **DROP** (zero EV).
- Regime-conditional direction: **not worth dedicated machinery** (already captured).

Combined with Phase 4, this is the second consecutive feature-side negative — a
meaningful signal that the Phase 1+2 stack (triple-barrier meta + conformal
abstention) already extracts most of the available edge from this feature set. The
remaining upside is the LLM layer (Phase 3, live A/B) and architecture (Phase 6).

Scripts: phase5_direction.py. Results in phase_results.json.
