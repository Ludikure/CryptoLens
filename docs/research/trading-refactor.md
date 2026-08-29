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

## Phases 3-4 — shipped, 18 further tests, 652/652 green

| module | responsibility |
|---|---|
| `trading/portfolio.ts` | multi-candidate allocation with evolving state; effective-bets accounting |
| `trading/journal.ts` | append-only prediction record — the permanent OOS dataset |

### Allocation updates state between candidates, and that is the whole point

`sizePosition` enforces limits for ONE candidate against a fixed portfolio. Allocating a ranked list
needs the state to evolve as each position is taken, or the third candidate is sized against a
portfolio that no longer exists.

This matters more in crypto than it sounds. T7 measured mean pairwise correlation across the twelve
liquid crypto symbols at **0.62** against 0.32 for a mixed universe — a book of "five different
crypto trades" is closer to one bet held five times, which is exactly how the regime-hold test
reached an −82% drawdown while looking diversified. `effectiveBets()` reports it directly:
**five positions at ρ̄ = 0.62 are worth about 1.5 independent bets**, and the test asserts that
rather than letting the UI imply five.

`simultaneousStopLoss()` reports what the book loses if every stop fills at once — not a tail
scenario when the constituents gap together.

### The journal is append-only, and `recordOutcome` throws rather than overwriting

Spec §18 says never rewrite historical predictions after a model update. The rule is enforced where
it would actually be violated: attempting to resolve an already-resolved entry raises. "Just
correcting" a resolved outcome is how an out-of-sample record quietly becomes an in-sample one.

Every row carries the full config chain, so `statsByConfig()` can compare a model or parameter change
**on the trades each version actually made** — as opposed to re-scoring history with the new model,
which is the failure mode the whole module exists to prevent.

`evError` (realized minus predicted EV) is the honesty metric: persistently negative means the
generator oversells, and it is visible per config rather than buried in an aggregate.

`not_taken` predictions are stored but excluded from performance — they are evidence about the
generator, not about execution.

## Phase 5 — shipped, 22 further tests, 674/674 green

| module | responsibility |
|---|---|
| `trading/metrics.ts` | performance + discrimination, **both AUC axes** |
| `trading/harness.ts` | evaluation with mandatory controls, cost sweep, regime slices |

### The standing requirement is now structural

`discrimination()` returns `perSymbolAuc` **and** `withinTimestampAuc` together — they cannot be
requested separately. `evaluate()` emits an explicit warning when the cross-sectional axis cannot be
computed at all: *"this evaluation covers ONE axis only, which is the configuration that let a bad
prune pass three validations."*

`survivesControls()` requires an edge on **both** axes, because a model can beat shuffled timing on
per-symbol AUC while carrying no cross-sectional information — precisely the state the pruned model
reached before being reverted. A test asserts a time-series-skill-only signal FAILS.

### Controls are mandatory, not optional

`MANDATORY_CONTROLS` = shuffled timing · random labels · 30-day lag. The random-label arm is the
pipeline's own sanity check: `evaluate()` warns if it returns anything materially off 0.500, because
a harness that cannot produce chance on random labels cannot be trusted when it produces 0.76 on
real ones. Permutations are seeded, so every control result in a report is reproducible from it.

The header records why this is not procedural fussiness: T5 passed all five numbered criteria
including an untouched holdout and was killed by a control; T6 was killed by equal-weight; T14's
permutation control **inverted**; T22 passed three validations on the wrong axis. In every case the
ship bar said yes and the controls were right.

### Honest NaN over misleading numbers

Calmar with no drawdown returns NaN rather than Infinity. AUC with one class present returns NaN
rather than 0.5. `stats()` on an unresolved journal returns NaN rather than zero. A metric that
cannot be computed should say so.

### Two fixture errors the tests caught, both mine

`auc([1,2,3,4],[0,1,0,1])` is genuinely **0.75** — three of four pos/neg pairs are concordant — and I
had asserted 0.5. And the Sortino guard required more than one downside observation, silently
returning NaN for low-drawdown series; downside deviation is well-defined at n=1.

## Integration — `GET /opportunities`, additive and read-only

`trading/service.ts` wires the pipeline to live data and `GET /opportunities` exposes it. **Nothing
about the existing analysis path changes** — no cron behaviour, no notifications, no model serving.

### ⚠️ The excursion model is PROVISIONAL, and that is the honest gap

`generateCandidate` needs `P(reach +NR before −1R)`. **No such model has been trained.** What exists
is `ML_WIN = P(fwdMaxFavR >= 1.5 ATR within 24h)` — a genuine excursion probability, but at ONE
point, on a 24h horizon, and direction-agnostic.

`provisionalCurve()` anchors on that real number and damps toward the random-walk tail as R grows,
because an edge measured at 1.5R is weak evidence about 8R. **That is an assumption about tail shape,
not a measurement.** The response says so in three places, and `modelVersion` carries a
`provisional-` prefix so no journal row can later be mistaken for trained-model output. Fabricating a
confident curve would have been easy and would have poisoned the OOS record the journal exists to
protect.

### A real architectural gap the integration exposed

First live run: the pipeline produced **+0.234R on both sides** and then declined to trade, because a
direction-agnostic anchor makes LONG and SHORT exactly tied and `chooseDirection` returns null on a
near-tie.

Correct by its own logic — and wrong for the product. **The convex structure this project validated
is itself direction-agnostic**: its edge is excursion probability × payoff geometry, and T5 measured
the two sides at −0.1033R and +0.0151R ungated. Refusing to trade whenever the model cannot pick a
side would discard the one edge the research actually found.

`GenerateResult.directionAgnostic` now marks that case: the trade executes with a nominal direction,
and the flag tells the UI the choice is immaterial rather than implying a view the model does not
have. Tests assert both branches.

## Phase 6 — the Opportunity Feed (shipped)

`WorkerOpportunitiesService` + `OpportunityFeedCard` on the Now tab, scoped to the user's favourites
and sized against their real `account_size`.

**The honesty requirement drove the design.** The model behind this ranks (cross-sectional AUC 0.62,
verified as genuine asset selection) but its profitability is regime-dependent — 1 of 5 rising-market
periods, +0.109R gross with a **median of zero**. A card rendering "EV +0.34R" in confident green
would present a regime bet as a model output. So:

- the regime caveat is **on the face**, not behind a disclosure arrow;
- expected values are rendered **untinted** — a green +EV reads as a promise the median outcome does
  not support;
- the model's own **holdout AUC is displayed**, so the ceiling on the claim is visible;
- `effectiveBets` is shown next to the position count, because at crypto's measured ρ̄ = 0.62 five
  positions are ~1.5 independent bets and a book that looks diversified is not;
- an **empty book renders as "nothing clears the bar"** rather than hiding — a real answer that
  would otherwise look like a broken feature.

## Not yet built

Phase 6 remainder: portfolio exposure management beyond the per-candidate limits already enforced, the trade
journal, the research harness, and the new UI. Phases 1-2 are the substrate those attach to and are
independently testable, per the spec's instruction not to rewrite the application at once.
