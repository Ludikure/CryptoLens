# Trading-engine refactor — Phase 1

**Spec:** reorient MarketScope from directional prediction to opportunity ranking + position sizing.
*(The spec says "MetroScope"; the product is MarketScope / `com.ludikure.CryptoLens`.)*

## The one substantive deviation, and why

**Spec §3 asks the opportunity model to estimate `P(win)` for a LONG-vs-SHORT candidate. Taken
literally that is directional prediction**, which this project has measured as a coin flip across 12
primitives, 2 dedicated models, 8 conditional states and every horizon from 4h to 30d
([[what-we-tried]] mode 1). If `P(direction) ≈ 0.5`, expected value is set almost entirely by payoff
geometry, and an "opportunity model" built on direction would be re-litigating a closed question.

**Resolution, encoded in the types:** `winProbability` is documented as *P(the payoff structure
resolves favourably)* — dominated by excursion probability and stop placement — explicitly NOT
*P(price rises)*. Direction selects a side of an inherently two-sided setup and contributes little.
That is the convex structure measured at +0.151R gross ([[strategy-breakeven]]), expressed so no
downstream component can quietly reintroduce a directional claim.

`chooseDirection()` returns **null** on a near-tie for the same reason: with direction a coin flip, a
marginal EV gap between LONG and SHORT is noise, and rendering it as a choice manufactures confidence
the evidence does not support.

## Phase 1 — shipped, 35 tests, 609/609 green

| module | responsibility |
|---|---|
| `trading/candidate.ts` | canonical `TradeCandidate` + full provenance; geometry validation; explicit `noTrade` |
| `trading/provenance.ts` | anti-lookahead enforcement (§20) |
| `trading/crash-risk.ts` | crash model interface + frozen sizing curves (§5-§7) |
| `trading/sizing.ts` | position-sizing engine + hard portfolio limits (§9, §10) |
| `trading/opportunity.ts` | expected-value scoring and ranking (§3, §8) |

### Design decisions that encode research findings structurally

**Lookahead is now assertable, not remembered.** This project shipped lookahead twice and found both
by accident — the 2026-06-02 in-progress-candle leak (94.7% → ~50%) and T10's persistence mask
(Calmar 1.43 → 2.75, ranking inverted). `assertNoLookahead`, `assertPurgeCoversHorizon` (the T2
48-vs-60-bar defect) and `assertBackwardOnly` (full-sample statistics applied historically) make the
invariant a check the pipeline runs.

**Sizing is binary in the model's contribution, not proportional.** `baseRiskFraction` returns the
full risk budget or zero. T22's H4 tested proportional sizing directly: size ∝ p and ∝ p² both LOST
to a flat gate on return-per-unit-of-capital in every fold. Expected value decides *whether*, not
*how much*.

**Crash risk can only scale a position that already exists.** `applyCrashOverlay` takes a position
fraction and returns a smaller one — there is no code path by which a risk signal opens or reverses a
trade (§7).

**No exposure floor and no confirmation filter**, despite both being the obvious fixes for high
turnover. T15 showed a 25% floor fixed 2021 and destroyed the 2022 protection; T12 showed volatility
confirmation turned the 2022 bear from +28% to −70% by removing the lead time that *is* the value.
Their absence is deliberate and tested for.

**Every config is versioned.** `PLACEHOLDER_CURVE.id`, `DEFAULT_LIMITS.id`, `DEFAULT_SCORING.id` are
recorded on each candidate, so a silently retuned parameter is visible in the trade journal rather
than quietly altering historical comparability.

**The placeholder curve is labelled as one.** Its `description` reads *"NOT fitted, NOT validated"*,
per §6's insistence that those numbers must not become a research result by default. `NEUTRAL_CURVE`
exists as the mandatory control arm.

**Ranking is anchored on expected value in R, not probability** (§8). The asymmetry, confidence and
crash terms are deliberately small — they break ties between similar EVs rather than overriding them,
because none has independent evidence of predicting returns. Crash risk appears in ranking only as a
mild penalty; the material reduction happens in sizing, and double-counting would let a risk signal
suppress an opportunity it should merely shrink.

## Phase 2 — shipped, 25 further tests, 634/634 green

| module | responsibility |
|---|---|
| `trading/payoff.ts` | conditional excursion curves, expected value of a target, random-walk baseline |
| `trading/calibration.ts` | leak-guarded isotonic calibration, reliability / Brier / log loss |
| `trading/generator.ts` | LONG / SHORT / NO-TRADE generation end to end |

### The random-walk baseline is now a first-class control

`randomWalkCurve()` encodes `P(reach +bR before −1R) = 1/(1+b)` — the driftless barrier result. A
1R/5R structure should hit its target **16.7%** of the time and be a *fair bet*; the tail-gated
version measured **~30%**. `edgeOverRandomWalk()` isolates exactly that gap, so a payoff model that
has merely rederived the geometry is immediately visible rather than looking like a discovery. Tests
assert the baseline is EV-zero at every multiple.

### `bestTargetR` exists but production does not use it

T4 tested per-bar dynamic target selection and it lost in every fold (+0.0911R against fixed 1:5's
+0.4261R) because predicted excursions regress to the mean and the model kept choosing tight targets.
The function is kept for corpus-level research and the generator uses a **fixed** multiple; the
docstring says so at the call site.

### Calibration refuses to run when misapplied

`applyCalibration` throws if the calibrator's `fitThroughTimestamp` is at or after the moment it is
applied. Fitting on the test period is the most flattering error available — it produces a perfect
reliability curve that means nothing — so this is an exception, not a warning. Sparse buckets are
dropped (`minBucketN`, default 40) rather than allowed to fit a step to a handful of points and then
govern every future prediction landing in it.

### Expected value is deliberately understated

`expectedValueOfTarget` treats anything short of the target as a full −1R. Real outcomes include
timeouts exiting between the barriers (T5 measured ~20%), which softens the loss side. Understating
is the correct direction for a number that drives position sizing.

### A units bug the tests caught

`noiseHitProb` takes sigma as a **log-return fraction**, compared against `|log(stop/entry)|`. The
first test pass supplied price units and every stop looked like noise — 99% hit probability, every
candidate rejected. The interface now documents the units at the field, because the failure mode is
silent: wrong units do not error, they just decline every trade.

## Not yet built

Phases 3-6: portfolio exposure management beyond the per-candidate limits already enforced, the trade
journal, the research harness, and the new UI. Phases 1-2 are the substrate those attach to and are
independently testable, per the spec's instruction not to rewrite the application at once.
