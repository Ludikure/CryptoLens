# T24 — Remove the 43 features the model never splits on

**Status:** frozen 2026-08-24 before computation. Follows the failed MINIMAL attempt
([[feature-pruning]]) and applies the lesson from it.

## Why this is different from the attempt that just failed

MINIMAL was chosen by **block ablation on per-symbol time-series AUC**. It deleted 33 actively-used
features carrying **53% of all splits in the model** — including nine of the top fifteen — and
collapsed cross-sectional discrimination by −0.1021 AUC.

This candidate is chosen by **direct inspection of the trained model**: the 43 features the trees
literally never consult. A feature never split on cannot affect a prediction. That is arithmetic,
not an inference from a metric that turned out to measure the wrong axis.

## Two separate questions, tested separately

**Q1 — serving path (provable).** Does the CURRENT 110-feature model produce identical predictions
when the 43 dead features are absent? It must, exactly, since the trees never reference them. This
licenses trimming `scoring-full.ts` without retraining anything.

**Q2 — retrain (statistical).** Does a model *retrained* on only the 67 used features match the
110-feature model? Not guaranteed: retraining changes feature subsampling and split availability, so
some of the currently-dead 43 could become useful.

## Ship bar — now with the cross-sectional criterion that was missing

Per the standing requirement recorded after the MINIMAL revert, **both axes must be reported and both
must pass**:

1. **Per-symbol time-series AUC** within **0.005** of FULL
2. **Within-timestamp (cross-sectional) AUC** within **0.010** of FULL ← the criterion whose absence
   let MINIMAL nearly ship
3. **Cross-sectional spread** ≥ **90%** of FULL's
4. Q1 must be **exact** — any difference at all means the dead-feature analysis is wrong

**Pre-registered expectation:** Q1 passes exactly, by construction. Q2 is genuinely open — 67 features
is still a large set and the removed ones contribute nothing to the *current* model, but a retrain is
a different model. The honest prior is that it passes, and the value is a provable serving-path win
either way.
