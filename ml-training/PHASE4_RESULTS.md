# Phase 4 Results — context features (NEGATIVE, dropped)

Hypothesis: market breadth + weekly trend add context the 111 point-in-time
features miss. Tested as a clean ablation on the conformal-gated frozen holdout.

Added features (all trailing, no lookahead):
  breadth50/200  — fraction of the universe above its trailing 50/200-bar (4H) MA
  breadthDelta   — 6-bar change in breadth
  weeklyDist     — price vs 42-bar (~1wk) MA
  weeklyMom      — 42-bar return

## Result — no improvement

| crypto holdout (conformal-gated) | tau | n | win% | EV/trade |
|---|---|---|---|---|
| baseline (111 feats) | 0.374 | 12,336 | 73.4% | +0.754R |
| + context (breadth+weekly) | 0.374 | 12,723 | 73.1% | **+0.746R (−0.008)** |

Stocks abstain either way (consistent with Phase 2). The delta is essentially
zero / marginally negative. The existing feature set (which already includes
`regimeCode`, cross-asset DXY/VIX, `atrPercentile`, ETH/BTC ratio) apparently
already encodes the relevant backdrop for the high-confidence subset the gate
selects — adding breadth/weekly is redundant.

## Verdict — DROP
Breadth + weekly context features do not earn their place. Not shipping them.

## Untested (4c)
Levels-as-features (distance-to-nearest-untested-level, confluence density,
room-to-run) needs structural level data not in the current CSVs, so it wasn't
ablated. Given breadth+weekly — the two most promising context features — added
nothing, 4c is low priority; revisit only if a cheap level-feature extraction
appears. The existing `vp*` (volume-profile) features already cover part of it.

Scripts: phase4_context.py. Results in phase_results.json.
