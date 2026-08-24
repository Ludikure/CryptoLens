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

---

# RESULTS — SECTION F first, because it settles the ship bar

## Simple-rule baselines vs the model (AUC on `y_crash`)

| rule | BTC | ETH | SOL | XRP | **mean** |
|---|---|---|---|---|---|
| **realised vol (20d)** | **0.597** | 0.601 | 0.550 | **0.646** | **0.598** |
| BB bandwidth | 0.556 | 0.572 | 0.526 | 0.651 | 0.576 |
| ATR percentile | 0.501 | 0.530 | 0.536 | 0.622 | 0.547 |
| drawdown from 60d high | 0.575 | 0.565 | 0.527 | 0.481 | 0.537 |
| vol expansion (rv20/rv60) | 0.479 | 0.511 | 0.470 | 0.560 | 0.505 |
| distance below 200d EMA | 0.515 | 0.485 | 0.480 | 0.364 | 0.461 |
| | | | | | |
| **T17 arm E (ML)** | 0.583 | 0.600 | **0.631** | 0.638 | **0.613** |
| T17 arm A (ML, full) | 0.611 | 0.601 | 0.584 | 0.640 | 0.609 |

## Verdict: T18 identifies a CORRELATE, not a mechanism

**The ML model beats 20-day realised volatility by +0.015 AUC — and loses to it on two of four
assets.**

- **BTC: 0.583 (ML) vs 0.597 (realised vol)** — the one-line rule *wins*
- **XRP: 0.638 vs 0.646** — the one-line rule wins
- ETH: 0.600 vs 0.601 — tie
- SOL: 0.631 vs 0.550 — the model wins clearly, and is the sole source of its mean advantage

Ship-bar criterion 1 (material improvement over the strongest simple baseline) **fails**. Criterion 2
(survives ≥3/4 assets) **fails** — the model's edge over the baseline appears on 1 of 4.

The comparison is if anything generous to the model: the simple rule is a fixed formula with no
fitted parameters, while the ML AUCs come from walk-forward leave-one-symbol-out training.

## The reconciliation with T15 — and it is a calibration finding, not a mechanism finding

T15's CTRL3 built exposure from realised volatility and scored **Calmar 0.25**, against T9's **1.53**.
Yet here realised volatility *ranks* crash risk about as well as the model does.

Both are true because **AUC measures ranking; the T9 rule needs calibrated probabilities.** A raw
volatility percentile mapped through fixed 0.30/0.50 thresholds produces a badly-timed exposure
schedule; the model's calibrated output does not. This is T17's artifact 1 seen from the other side.

**So the model's contribution is substantially CALIBRATION rather than superior discrimination.**
That is a real and useful thing — it is what makes a fixed-threshold rule work at all — but it is not
the interpretable price-structure mechanism T18 set out to find.

## What this means for T16 and T17 — stated plainly

T16's replication stands: the crash-probability → extreme-drawdown relationship *does* generalise
across assets and survives placebo four times. **But T18 shows much of what replicated is the
well-known fact that volatility clusters and elevated volatility precedes drawdowns.**

That is a genuine phenomenon. It is not a novel one, and it does not need a 120-feature
gradient-boosted model to express — except that expressing it as a *calibrated probability* is
apparently what makes it usable.

**SOL is the honest open question.** The model beats realised volatility there by +0.081 AUC, by far
the largest gap, and SOL was also the asset where T16 anticipated 8/8 large drawdowns. Whether that
is a real asset-specific mechanism or the one place noise favoured the model is not resolved here,
and a single asset is not evidence.

---

# RESULTS — SECTION B: group ablation

Group sizes: 1 TREND/MOMENTUM=43 · 2 REALISED VOL=8 · 3 TAIL SHAPE=3 · 4 PRICE STRUCTURE=26 ·
5 LIQUIDITY=7 · 6 CROSS-HORIZON=3.

| config | BTC | ETH | SOL | XRP | mean AUC | **ΔAUC** | top-dec | Brier |
|---|---|---|---|---|---|---|---|---|
| FULL (arm B) | 0.552 | 0.595 | 0.600 | 0.667 | 0.6036 | — | 51.1% | 0.1974 |
| **minus 1 TREND/MOMENTUM** | 0.515 | 0.559 | 0.523 | 0.618 | 0.5536 | **−0.0501** | 36.4% | 0.2089 |
| minus 2 REALISED VOL | 0.529 | 0.570 | 0.616 | 0.675 | 0.5973 | −0.0063 | 51.8% | 0.2015 |
| minus 3 TAIL SHAPE | 0.550 | 0.593 | 0.601 | 0.668 | 0.6031 | −0.0005 | 50.9% | 0.1974 |
| **minus 4 PRICE STRUCTURE** | 0.558 | 0.600 | 0.605 | 0.667 | 0.6074 | **+0.0038** | **52.7%** | **0.1964** |
| minus 5 LIQUIDITY | 0.550 | 0.594 | 0.602 | 0.669 | 0.6035 | −0.0001 | 50.4% | 0.1978 |
| minus 6 CROSS-HORIZON | 0.547 | 0.593 | 0.601 | 0.667 | 0.6018 | −0.0018 | 50.7% | 0.1977 |

## Attribution: TREND/MOMENTUM, and nothing else

**Removing trend/momentum costs −0.0501 AUC — roughly 8× the next-largest group — and it drops on
all four assets (BTC −0.037, ETH −0.036, SOL −0.077, XRP −0.049).** Top-decile precision collapses
from 51.1% to 36.4% and Brier degrades. That is a stable attribution across leave-one-symbol-out
folds, which is what the design asked for.

**Three findings that are more interesting than the headline:**

**1. The explicit volatility features are nearly redundant (−0.0063).** Given section F showed
realised volatility *alone* scores 0.598, this looks contradictory — but it is not. The
trend/momentum block is full of volatility-correlated quantities: ADX measures trend strength, RSI
extremes track volatility regimes, MACD-histogram magnitude scales with volatility, and the group
holds every delta and acceleration term. **The volatility information is duplicated inside the
momentum block**, so deleting the eight explicit vol features changes little.

**2. PRICE STRUCTURE is net noise — removing it IMPROVES every metric** (AUC +0.0038, top-decile
51.1%→52.7%, Brier 0.1974→0.1964). Twenty-six features covering VWAP position, POC/value-area
distances, 52-week position, gaps, divergences and Stoch levels are, in aggregate, hurting the model.
**Noted and deliberately NOT acted on** — dropping them now would be exactly the post-hoc
optimisation this test forbids, and it is one measurement.

**3. TAIL SHAPE (−0.0005) and LIQUIDITY (−0.0001) contribute nothing measurable.** For tail shape
that is unsurprising and was declared in advance: the group is near-empty because the production
feature set never computed distributional moments. **The model cannot be using tail shape, because
it was never given it.**

## Final verdict on T18

**FAIL — "identifies a correlate, not a mechanism."** Ship-bar criterion 1 fails decisively (+0.015
AUC over a one-line realised-volatility rule, losing on 2 of 4 assets), so criteria 3-8 are moot.

But the decomposition succeeded at its stated purpose. The information the model uses is now located:

> **The crash signal lives in the trend/momentum feature block, whose predictive content is largely
> volatility-correlated. Price structure, tail shape and liquidity contribute nothing or worse. The
> model's advantage over a plain volatility rule is +0.015 AUC and is not consistent across assets —
> its real contribution is calibration, not discrimination.**

The mechanism, stated without the machinery: **elevated and accelerating momentum-indicator activity
— which is largely a proxy for volatility regime — precedes extreme drawdowns across crypto assets.**
That replicates out of sample (T16) and is genuinely general. It is also, essentially, the volatility
clustering that was already known.
