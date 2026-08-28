# Pre-declared: do sloped trendlines / channels hold better than the horizontal levels we already have?

**Status: PRE-DECLARATION. Written and committed before any number in the RESULT section was
computed.**

Related: [[strategy-levels]], [[level-daily-close]], [[level-monthly-extremes]],
[[edge-methodology]], [[rejected-hypotheses]].

## Why this is NOT the ninth repeat of the same test

The previous eight level tests (test-count, flip-role, timeframe, Fibonacci ratio, formation
volume, volume-at-price, day boundary, monthly extreme) all asked one question in different
clothes: **"which VISITED price is special?"** The answer was always *none*. What survived was
a single fact — prices the market has recently traded at hold ~5-7pp better than prices it has
not.

**A trendline is a different object.** Its projected value at time *t* is, in general, a price
the market has **never traded**. It cannot inherit the visited-price effect, so if it works at
all the mechanism must be genuinely different — plausibly self-fulfilling coordination (many
participants draw the same line from the same two obvious pivots and act on it).

That is a real mechanism, unlike "a month ended here". **My prior on the null is therefore
weaker here than in any of the previous eight**, and this is recorded before running so the
result cannot be read as confirming a foregone conclusion.

## The three traps, and how each is handled

1. **Lookahead in the fit.** Fatal and common. Every line is fitted using only bars whose
   index is <= the anchor bar, and evaluated strictly from anchor+1 forward.
2. **Degrees of freedom.** A horizontal level is 1 parameter; a trendline is 2. With K swing
   points there are K(K-1)/2 candidate lines, so "the channel that worked" is trivially
   selectable in hindsight. **Construction is mechanical and deterministic** — the two most
   recent confirmed swing pivots of the relevant kind, no discretion, no "the line a chartist
   would pick".
3. **The wrong control.** The actionable question is not "do trendlines work" but **"do they
   beat the horizontal levels already implemented"**. That is the control that decides
   whether anything gets built.

## Arms

| arm | construction | what it isolates |
|---|---|---|
| `channel` | line through the two most recent confirmed swing lows (support) / highs (resistance), projected forward | the claim |
| **`horizontal at anchor`** | horizontal line at the price of the SAME most-recent anchor pivot | **the incumbent — what the app already has** |
| **`random slope`** | same anchor, slope drawn from the empirical slope distribution | does the FITTED slope carry information, or would any slope do? |
| `regression channel` | least-squares fit over trailing N bars, rails at +/- k * residual sd | the quant form of the same idea |
| `random line 0.5-3.0 ATR` | ancestral control | comparability with Finding 4 |

## Outcome logic — and a mandatory parity assertion

Outcome is `LV.forward_outcome`'s definition, unchanged, so the numbers are directly
comparable to all eight previous tests: leave the zone, re-enter (a genuine retest), then
BREAK if a bar closes >= 0.5 ATR beyond, HOLD if price rejects >= 0.5 ATR first, dropped if
unresolved in 12 bars.

A trendline's price moves each bar, so this needs a sloped variant taking `level_at(j)`
instead of a constant. **The script asserts at startup that the sloped function with slope 0
reproduces `LV.forward_outcome` EXACTLY on a real sample, and refuses to run otherwise.**

This is not ceremony. The 2026-08-25j retraction found `envelope_sweep.py` reconstructing a
live rule as its exact logical complement, and the standing rule from it is that any
reconstruction must be asserted against the original on shared inputs before its output is
used. A sloped generalisation of a horizontal function is exactly such a reconstruction.

## Ship bar — pre-declared

A channel layer gets built only if **all three**:

- **(a)** `channel` beats **`horizontal at anchor`** by **>= +2.0pp** on crypto,
- **(b)** positive in **>= 7 of 9** half-year periods,
- **(c)** same sign on stocks.

Reported with symbol-level block-bootstrap CIs (B=2000), per the estimator lesson from
[[level-monthly-extremes]], where a Kish design effect went unstable on sparse arms and
reported eff_n of 21. Verdict rule for a null is the same: **CI upper bound below +2.0pp ->
NOT SUPPORTED; CI spanning +2.0pp -> INCONCLUSIVE, never "no effect"**.

Secondary, reported but not gating: `channel` vs `random slope`. If the two are within noise
the anchor is doing the work and the slope is decoration; if `channel` beats `random slope`
the fitted slope carries real information.

## Predictions, recorded in advance

1. **`channel` will not clear +2.0pp over `horizontal at anchor`.** Eight metrics flat is a
   strong prior — but see the header: my confidence is genuinely lower here than in any
   previous one, because the mechanism is different rather than a re-slicing of the same fact.
2. **`random slope` will land close to `channel`.** Over a bounded projection a modest slope
   error moves the line only a fraction of an ATR, so slope precision may not matter. If this
   holds, "draw the trendline accurately" is not the skill it is sold as.
3. **If anything shows, it shows on stocks, not crypto.** Same directional prediction that
   held for the session-close effect in [[level-daily-close]]: stocks mean-revert, and the
   momentum thesis says crypto runs through boundaries rather than respecting them.
4. Projection distance will matter — lines evaluated far from their anchor should decay toward
   the random-line floor. Reported as a gradient, since a decay curve is more informative than
   a single pooled number.

## RESULT — NOT SUPPORTED on both markets, and the gap is significantly NEGATIVE

`ml-training/level_channel_test.py`. Slope-0 parity gate passed first (2,800 cases, 0
mismatches vs `LV.forward_outcome`), so these numbers are directly comparable to all eight
previous level tests.

| arm | crypto HOLD | vs random line | stock HOLD | vs random line |
|---|---:|---:|---:|---:|
| **horizontal at same anchor** | **89.81%** | +5.20pp | **85.09%** | +5.98pp |
| regression channel | 89.32% | +4.71pp | 83.97% | +4.86pp |
| random slope | 88.90% | +4.29pp | 83.32% | +4.21pp |
| **channel (fitted slope)** | 88.69% | +4.09pp | 83.34% | +4.23pp |
| random line 0.5-3.0 ATR | 84.61% | — | 79.11% | — |

| comparison | crypto | stock |
|---|---|---|
| **channel vs horizontal** (the ship bar) | **−1.12pp** [−1.36, −0.86] | **−1.75pp** [−2.17, −1.33] |
| periods positive | **0 of 10** | 1 of 10 * |
| paired, both arms resolved | −0.33pp [−0.62, −0.05] | −0.81pp [−1.28, −0.34] |
| **channel vs random slope** | −0.21pp [−0.48, +0.07] | **+0.03pp** [−0.40, +0.45] |

\* the single positive stock period is 2021H2 at n=64, a stub at the start of the tape.

All three ship criteria fail, and not by falling short — **the sloped line is significantly
WORSE than a flat line through the same pivot, on both markets, in 19 of 20 half-year
periods.** This is the first of the nine level tests where the tested object underperforms
the incumbent rather than merely matching it.

### This is the exact shape of the trap the whole series exists to catch

A fitted trendline beats a random line by **+4.09pp on crypto and +4.23pp on stocks**.
Measured against nothing — which is how chart TA is normally "verified" — you would conclude
trendlines work, and conclude it from a large, consistent, real effect. Against the control
that matters they are strictly worse. **The anchor pivot does all the work; the slope
subtracts from it.**

### The fitted slope is worth exactly nothing

−0.21pp on crypto and **+0.03pp** on stocks against a *randomly drawn* slope through the same
anchor, both CIs straddling zero. Prediction 2 held, and this is the sharpest single result in
the test: the skill the technique is sold on — drawing the line correctly through the right
two pivots — **carries no information at all.** A random slope performs the same.

### A projected line is also less often actionable

From identical anchors, the channel arm resolved 85,014 events against the horizontal's
107,531 on crypto (−21%), and 42,083 against 55,233 on stocks (−24%). Roughly a fifth of the
time price simply never reaches the projected line. That gap is why the pooled and paired
estimates differ, and the **paired** numbers (−0.33pp / −0.81pp) are the honest ones — still
significantly negative, so selection explains part of the pooled gap but not the sign.

### Decay is level staleness, not slope drift

Prediction 4 was half right. Absolute hold does fall as a line is evaluated further from its
anchor (crypto channel 88.86 → 87.84 → 86.46 toward the 84.61 random floor) — but the
horizontal decays in lockstep (90.08 → 88.92 → 87.90), so the **gap is flat** at −1.22 /
−1.08 / −1.43. Levels of every kind go stale with distance from formation; the slope is not
what is decaying.

### Predictions scored

| # | prediction | outcome |
|---|---|---|
| 1 | channel will not clear +2.0pp over horizontal | **held** — it is negative |
| 2 | random slope will land close to fitted | **held exactly** (+0.03pp on stocks) |
| 3 | if anything shows, it shows on stocks | **failed** — stocks are the MORE negative market |
| 4 | lines decay with projection distance | **half** — absolute yes, gap no |

**Calibration note, recorded against myself.** The pre-declaration argued this had the
*weakest* null prior of the nine, because a trendline is a genuinely different object that
cannot inherit the visited-price effect and would imply a real coordination mechanism. That
reasoning was sound and the conclusion was wrong: it is not merely absent, it is the only one
of the nine that is significantly *harmful*. Naming a plausible mechanism in advance did not
make the effect more likely, and I should weight that argument less next time.

### Verdict

Nothing ships. **Ninth level-selection metric to measure flat, and the first to measure
negative.** The standing conclusion is unchanged and now stronger:

> Prices the market has recently traded at hold ~5-6pp better than prices it has not. No
> method of selecting *which* traded price has ever measured better than the others — and
> extending a level off its anchor with a slope makes it measurably worse.

### Product implication

Confirms an existing choice rather than changing one. The app builds horizontal swing levels
(`supportResistance` in `indicators-full.ts`) and has no channel concept; grep confirms the
LLM system prompt never mentions trendlines, channels, wedges or triangles either (the
`sloping` hits are the 200D EMA). **No code change.** The value is preventive: a channel
overlay is an obvious-looking feature request, and this is the measurement that says building
one would make the level layer worse, not better.
