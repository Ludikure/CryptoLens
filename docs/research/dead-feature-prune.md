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

---

# RESULTS — 2026-08-24

## Q1 — serving path: EXACT, as predicted

| fixture | full | dead features removed | |
|---|---|---|---|
| BTC | 0.298736755406 | 0.298736755406 | IDENTICAL |
| ETH | 0.415477764354 | 0.415477764354 | IDENTICAL |
| TSLA | 0.436893655379 | 0.436893655379 | IDENTICAL |

Bit-identical to 12 decimals. **Trimming the serving path is provably safe** — no retrain, no new
model, no parity risk.

## Q2 — retrain on the 67 used features: PASSES BOTH AXES

| arm | per-symbol AUC | **within-timestamp AUC** | xs spread |
|---|---|---|---|
| FULL 110 | 0.6803 | 0.6664 | 0.0843 |
| **USED 67** | 0.6797 | 0.6662 | 0.0840 |
| Δ | −0.0006 | **−0.0003** | **100% retained** |

All four criteria pass. **Contrast with the MINIMAL attempt**, which the same cross-sectional metric
would have caught immediately:

| | within-timestamp Δ | spread retained |
|---|---|---|
| MINIMAL (block ablation) | **−0.1021** | **51%** |
| **USED-67 (split inspection)** | **−0.0003** | **100%** |

That is the entire difference between choosing features by a metric that measured the wrong axis and
choosing them by reading what the trained model actually consults.

## ⚠️ But the ACTUALLY removable set is 11, not 43

The 43 are dead in the **crypto** model. Two filters shrink that hard:

| | count |
|---|---|
| dead in crypto model | 43 |
| **dead in BOTH crypto and stock** (the stock model uses 77/110) | **19** |
| of those, still referenced by the prompt / worker / UI | 8 |
| **truly removable from the serving path** | **11** |

**The 11:** `dAdxBullish` · `dDivergence` · `hStochCross` · `hMacdCross` · `hDivergence` ·
`last3Green` · `last3Red` · `last3VolIncreasing` · `basisExtreme` · `isMarketHours` · `vpAbovePoc`

**Still needed despite being model-dead:** `dStochCross`, `dBBSqueeze`, `hBBSqueeze`, `oiSignal`,
`takerSignal`, `crowdingSignal`, `derivativesCombined`, `basisPct` — all consumed by the prompt's
positioning/whale-trap sections or the UI.

## Recommendation: do NOT ship a special deploy for this

11 of 111 features is ~10% of the computation, and most are cheap. The only non-trivial saving is RSI
divergence detection (`dDivergence`/`hDivergence`, peak/trough analysis). Volume profile stays because
other VP features are live; `basisExtreme` derives from `basisPct` which is still needed.

**The measured benefit does not justify a model deploy, new JSONs, parity re-verification and a box
restart.** Q2's retrain is −0.0006 — nominally *worse*, statistically nil.

**Fold it into the next scheduled retrain instead**, when the ship cycle is happening anyway. At that
point training on the 67 used features is free and leaves a cleaner model with less overfitting
surface for the retrain after it.

## What this exercise actually produced

Not a smaller model. **A correct method for choosing one**, and a demonstration that the previous
method was wrong by −0.1021 AUC on the axis the product depends on.
