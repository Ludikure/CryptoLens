# T18 — Price-structure feature decomposition

**Status:** pre-declared by the user. **Explanation, not optimisation.** No threshold, exposure or
turnover tuning — T17 showed threshold placement swings portfolio metrics without changing AUC, so
**AUC is the primary metric throughout.**

**Question:** is T17's surviving asset-specific signal concentrated in a small, interpretable subset
of the ~99 price/volatility features, or is it an opaque ensemble effect?

## ⚠️ Group 3 is essentially unrepresented in the v14 feature set — declared before running

The spec asks for six groups. Classifying the actual columns, **RETURN DISTRIBUTION / TAIL SHAPE
(skew, kurtosis, downside asymmetry, tail frequency, extreme-return counts) has almost no
representatives** — the production feature set never computed distributional moments. Its only
near-members are `bodyWickRatio`, `last3Green`, `last3Red`.

This is itself a finding: **if tail shape matters, this model cannot be using it**, because it was
never given it. Reported rather than worked around.

## Frozen partition (disjoint; each feature assigned once)

| group | members |
|---|---|
| **1 TREND/MOMENTUM** | d/h/e RSI, MACD hist, ADX(+Bullish), EmaCross, StackBull/Bear, Ema20Rising, MacdCross, all RsiDelta/AdxDelta/MacdHistDelta/Delta1/Accel, scores, biases, biasAlignment, regimeCode, barsSinceRegimeChange |
| **2 REALISED VOLATILITY** | atrPercent, atrPercentile, volScalar, volScalarML, d/hBBBandwidth, d/hBBSqueeze |
| **3 TAIL SHAPE** | bodyWickRatio, last3Green, last3Red *(near-empty — see above)* |
| **4 PRICE STRUCTURE** | d/hStructBull/Bear, d/hBBPercentB, d/hAboveVwap, fiftyTwoWeekPct, distToFiftyTwoHigh, all vp\* (POC/VA), gapPercent/Filled/DirectionAligned, d/hDivergence, d/h/eStochK, d/hStochCross |
| **5 LIQUIDITY/MICRO** | d/hVolumeRatio, last3VolIncreasing, obvRising, adLineAccumulation, shortVolumeRatio, shortVolumeZScore |
| **6 CROSS-HORIZON** | tfAlignment, momentumAlignment, structureAlignment |

## Method

Same LOSO + walk-forward framework as T17 (quarterly refits, purge 72, identical folds). For each
group: FULL versus FULL-minus-group, measuring ΔAUC, Δtop-decile precision, ΔBrier.

**Deviation declared:** permutation importance is computed on the **test** fold with the model held
fixed (the standard method), not by refitting per permuted feature — 99 refits per fold is
computationally infeasible and test-set permutation is what "do not use raw model importance" points
toward.

## Ship bar — all eight, else "T18 identifies a correlate, not a mechanism"

1. AUC improves materially over the strongest simple baseline
2. Same group survives ≥3/4 LOSO assets
3. Temporal permutation destroys the advantage
4. Survives the feature-level placebo
5. Calibration remains monotonic
6. No single asset supplies most of the effect
7. No single feature supplies most of the effect
8. Survives an untouched holdout

**Pre-registered expectation:** the simple-rule baselines in section F are the most likely to settle
this. T15 already showed realised-volatility-only sizing scores Calmar 0.25 — far below the model —
so if a simple drawdown-from-high or volatility-expansion rule reproduces the AUC, that is the
discovery. If none does, the mechanism is genuinely interactive and stays unnamed.
