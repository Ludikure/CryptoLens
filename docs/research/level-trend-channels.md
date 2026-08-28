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

## RESULT

*(empty — to be filled after the run)*
