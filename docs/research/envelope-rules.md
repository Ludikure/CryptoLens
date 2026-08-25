# Which Conviction Envelope rules earn their place — PRE-DECLARED 2026-08-25

## Why

The envelope carries ~20 conditions across four tiers. Some have measurements behind them
(`chase_into_extended_aligned_trend` from `trend_direction_test.py`, the ML-gating of `biases_MIXED`
from `mixed_flat_test.py`); several were reasoned from first principles and never tested; one
(`conformal_abstain_not_confident`) is provably dead code that can never fire.

The user's observation that prompted this: *"Timeframes are rarely aligning and when they do the move
happened."* Both halves were checked — full alignment is 24.2% of bars (rare, confirmed) and aligned
bars carry the WORST barrier outcome (confirmed) — but the *mechanism* was wrong: outcome is flat
across trend age, so aligned is uniformly bad rather than bad-because-late. That is enough of a
contradiction with a HIGH-conviction gate keyed on alignment to justify testing the whole set.

## The geometry must match what the envelope actually gates

Every measurement so far used a **1 ATR stop / 5R target / 72h** structure. **That is not what the
envelope governs.** The envelope gates the LLM's setup construction, and those setups use the tighter
bands: **stop 2.0 ATR, TP1 1.5 ATR, TP2 2.5 ATR** — i.e. TP1 at **0.75R** and TP2 at **1.25R**.

Testing guards against 5R would answer a question the app never asks. This test therefore uses the
app's real geometry, and reports TP1 and TP2 separately.

## The question, stated as the product asks it

Not *"does this condition correlate with bad outcomes?"* but:

> **Does blocking these bars improve the average outcome of the bars that REMAIN?**

That is what a gate does. A condition can correlate with poor outcomes and still be a bad gate if it
also removes good bars, or removes so many that what is left is unusable.

## Conditions tested

Reconstructible from the v14 feature set:

| condition | envelope tier | reconstruction |
|---|---|---|
| `ML_WIN < 50` | AUTO-FLAT | walk-forward goodR prediction, purged |
| `ML_WIN < 60` | cap LOW | same |
| `ML_WIN < 70` | cap MODERATE | same |
| `biases_MIXED and ML < 70` | AUTO-FLAT | `tfAlignment == 0` AND ML < 70 |
| `alignment_not_full` | cap MODERATE | `abs(tfAlignment) < 2` |
| `chase_into_extended_aligned_trend` | AUTO-FLAT | aligned AND stretched ≥2 ATR from the 200D mean |
| `crypto_bear_regime` | downgrade | price < EMA200 and EMA200 falling |
| `continuation < 2` / `< 3` | cap LOW / MODERATE | momentum-alignment count |

**Not testable here** and excluded rather than guessed: kill conditions, macro proximity, news
conflict, earnings, stock-specific gates (no stock paths in this dataset), and
`conformal_abstain_not_confident` (dead — its flag is declared `false` and never assigned).

## Pre-declared bar

A condition **earns its place** only if ALL hold:

1. **Improves the remainder** — blocking its bars raises the mean net-R of what remains by **≥ 0.02R**
   at TP2 geometry.
2. **Consistent** — positive in **≥ 6 of 9** non-overlapping six-month periods. **Sign count, not
   mean**: on 2026-08-24 a control passed on a mean carried entirely by one outlier period, and the
   same trap is available here.
3. **Not ruinous to coverage** — leaves **≥ 20%** of bars tradeable. A gate that blocks 90% of the
   tape to gain 0.02R has not improved anything, it has stopped trading.

A condition that fails 1 is **noise**. One that passes 1 but fails 2 is **regime-dependent**. One that
passes 1 and 2 but fails 3 is **too expensive to run**.

## What this test cannot conclude

Net R is negative nearly everywhere in this dataset, so "improves" mostly means "less negative". This
ranks the guards against each other; it does **not** establish that any surviving combination is
profitable, and a clean sweep would mean the honest envelope is "do not trade" — which is a real
possible outcome, not a failure of the test.

Nor does it license removing a guard that fails: several exist to prevent a specific known harm
(macro events, earnings) rather than to raise average EV, and those are not measured here at all.

---

## RESULTS

194,964 bars with out-of-fold ML_WIN, 2022-04 → 2026-03. Geometry: stop 2.0 ATR, TP2 2.5 ATR
(= 1.25R), net of fees. Baselines: **SHORT +0.0197R, LONG −0.0993R**.

### SHORT side — nothing earns its place, and three gates are BACKWARDS

| condition | fires | blocked bars | kept bars | lift | periods+ | verdict |
|---|---:|---:|---:|---:|---:|---|
| ML_WIN < 50 | 48.1% | 0.0110 | 0.0278 | +0.0081 | 6/9 | noise |
| ML_WIN < 60 | 69.4% | 0.0127 | 0.0356 | +0.0159 | 5/9 | noise |
| ML_WIN < 70 | 89.2% | 0.0178 | 0.0359 | +0.0162 | 4/9 | noise |
| **biases_MIXED and ML<70** | 23.8% | **0.0503** | 0.0102 | **−0.0096** | 2/9 | **backwards** |
| **alignment_not_full** | 75.2% | **0.0288** | **−0.0079** | **−0.0276** | 3/9 | **backwards** |
| chase: aligned + full stack | 15.4% | 0.0102 | 0.0215 | +0.0017 | 5/9 | noise |
| crypto_bear_regime | 46.6% | 0.0240 | 0.0160 | −0.0037 | 5/9 | backwards |
| RSI stretched | 9.8% | −0.0844 | 0.0310 | +0.0113 | 7/9 | noise (under bar) |
| **trend mature (age≥30)** | 72.5% | **0.0235** | 0.0099 | **−0.0098** | 4/9 | **backwards** |

**Read the "blocked bars" column.** `biases_MIXED` blocks bars averaging **+0.0503R** — nearly 3× the
+0.0197R baseline. `alignment_not_full` blocks bars averaging +0.0288R and keeps bars averaging
**−0.0079R**: it converts a positive-expectancy set into a negative one. These gates are not weak,
they are inverted.

**Ungated shorts (+0.0197R) beat every alignment-gated subset.** The envelope's alignment machinery
is worse than no machinery at all on this side.

### LONG side — exactly one passes, and it is probably regime

| condition | fires | blocked | kept | lift | periods+ | verdict |
|---|---:|---:|---:|---:|---:|---|
| **alignment_not_full** | 75.2% | −0.1080 | −0.0729 | **+0.0264** | **6/9** | **EARNS ITS PLACE** |
| biases_MIXED and ML<70 | 23.8% | −0.1219 | −0.0922 | +0.0071 | 7/9 | noise |
| ML_WIN < 70 | 89.2% | −0.0929 | −0.1516 | **−0.0524** | 5/9 | backwards |
| RSI stretched | 9.8% | 0.0070 | −0.1108 | −0.0115 | 1/9 | backwards |

The single pass clears the pre-declared bar honestly (+0.0264R, 6/9 by sign count). But **it improves
a losing proposition to a less-losing one** — kept bars still average −0.0729R — and its likely
mechanism is regime: "only go long in a confirmed uptrend" simply means *fewer longs* over a window
where the equal-weight basket fell 83%. That is a regime bet, not an edge.

Note the same gate is the **worst** condition on the short side (−0.0276). A rule that helps one
direction and hurts the other by a similar magnitude is doing selection, not risk management.

**RSI-stretched is coherently asymmetric** and worth noting: blocking it helps SHORTS (+0.0113, 7/9 —
shorting into an oversold reading is bad) and hurts LONGS (−0.0115, 1/9 — buying into one is fine).
The envelope treats "stretched" as uniformly dangerous; the data says it is direction-specific.

## Conclusion

**No tested envelope condition earns its place on the short side, and three are inverted.** The
alignment gates in particular select the worse cell — which is the mechanical version of the user's
observation that "timeframes are rarely aligning and when they do the move happened".

The mechanism is not exhaustion, though. Outcome is flat across trend age (0.072 / 0.064 / 0.058 /
0.058 / 0.065 fresh → 80+ bars), so **aligned is uniformly bad, not bad-because-late**. Both `goodR`
and the barrier are ATR-normalised, and aligned trends are the compressed state where a large
excursion relative to ATR is simply less available.

## What this does NOT license

- **Removing the untested guards.** Macro proximity, earnings, kill conditions and the stock gates
  are not measured here at all, and several exist to prevent a specific known harm rather than to
  raise average EV.
- **Believing the LONG pass.** One condition, plausibly regime, on a deeply negative baseline.
- **Assuming the entry is right.** This test enters at the bar close. Real setups enter at a LEVEL
  the LLM picks, which may behave materially differently — an untested gap between this measurement
  and the product.
- **Concluding anything is profitable.** Ungated shorts at +0.0197R on 1.25R targets is thin, one
  dataset, one period, and the basket it is measured on fell 83%.


---

# PART 2 — the envelope as a WHOLE — PRE-DECLARED 2026-08-25, before computing

Part 1 tested conditions one at a time. That cannot answer the real question, which the user put
directly: *"I feel like envelope was a thesis that wasn't verified."*

## What the envelope actually is

Not a filter — a **sizing function**. Four tiers, and conviction is what the LLM is told it may
express:

| tier | trigger | assumed size |
|---|---|---:|
| HIGH | nothing blocking | 1.00 |
| MODERATE | any `highBlock` | 0.66 |
| LOW | any `moderateBlock` | 0.33 |
| FLAT | any `autoFlat` | 0.00 |

The size mapping is an **assumption** — the prompt says "conviction", not "fraction" — so the result
is reported at a second mapping (1.0/0.5/0.25/0) as a sensitivity check. If the verdict flips between
them, that is itself the finding.

## Arms

| arm | description |
|---|---|
| **A — no envelope** | trade every bar at full size. The thing to beat. |
| **B — envelope as built** | faithful reconstruction of the tier logic |
| **C — B minus the inverted three** | drop `biases_MIXED`, `alignment_not_full`, `trend_mature` |
| **D — ML only** | the one component that showed any positive lift |
| **E — random, coverage-matched** | **the control that decides this** |
| **F — inverted envelope** | size = 1 − envelope size. If B is worse than nothing, F should beat it |

**Arm E is the point.** Any gate that reduces exposure will change returns; the question is whether
the envelope's *specific* choices beat a random gate that trades equally often. Part 1's biggest
finding — that the alignment gates keep the worse bars — predicts the envelope loses to random here.

## Pre-declared bar

The envelope is **verified** only if arm B:

1. beats arm A (no envelope) by **≥ 0.02R** per trade, AND
2. beats arm E (coverage-matched random) by **≥ 0.02R**, AND
3. does both in **≥ 6 of 9** six-month periods, by **sign count**, AND
4. holds under both size mappings.

Failing 2 while passing 1 means the envelope is **merely trading less**, not choosing better — the
outcome Part 1 predicts.

## Outcomes that are NOT failures of the test

- **B loses to A**: the envelope is net harmful and should be cut back to what survives.
- **B ties E**: the structure is decorative; any equally-sparse rule would do as well.
- **F beats B**: the strongest possible statement that the thesis is inverted.

## Honest limits, stated in advance

Untestable conditions (kills, macro, earnings, news, stock gates) are **absent from every arm**, so
this measures the envelope's *reconstructible core*, not all of it. Entry is at the bar close, while
real setups enter at a level the LLM picks. And `continuation` is approximated by momentum alignment.
None of that is fixable with this dataset and all of it is stated rather than papered over.


---

## PART 2 RESULTS — NOT VERIFIED, on both sides, under both size mappings

### SHORT (baseline: trade everything = +0.0197R at 100% exposure)

| arm | exposure | net R | vs A | periods+ |
|---|---:|---:|---:|---:|
| A no envelope | 100.0% | +0.0197 | — | — |
| **B envelope as built** | **8.5%** | +0.0225 | **+0.0028** | **5/9** |
| C minus the inverted three | 12.5% | +0.0250 | +0.0053 | 5/9 |
| **D ML component only** | 26.0% | **+0.0318** | **+0.0121** | 5/9 |
| **E random, coverage-matched** | 8.5% | **+0.0213** | +0.0016 | — |
| F inverted envelope | 91.5% | +0.0195 | −0.0003 | — |

**The envelope beats a coin flip by +0.0012R.** That is the whole result. Arm E trades exactly as
often on randomly chosen bars and lands within a rounding error, so the envelope's *specific*
choices — the alignment logic, the mixed-bias rule, the chase guard — contribute essentially nothing.

It reaches that by **cutting exposure to 8.5%**: it discards 91.5% of the tape to gain +0.0028R per
unit of exposure, and 0.0012 of that is attributable to its actual reasoning.

**Arm D beats arm B.** The ML component ALONE (+0.0121R at 26% exposure) outperforms the full
envelope (+0.0028R at 8.5%) more than fourfold. Everything bolted around ML is subtracting value.

### LONG (baseline −0.0993R)

| arm | exposure | net R | vs A | periods+ |
|---|---:|---:|---:|---:|
| A no envelope | 100.0% | −0.0993 | — | — |
| **B envelope as built** | 11.2% | −0.1159 | **−0.0166** | **3/9** |
| C minus inverted three | 16.5% | −0.1131 | −0.0138 | 3/9 |
| D ML only | 30.9% | −0.1260 | −0.0268 | 2/9 |
| E random, matched | 11.2% | −0.0995 | −0.0002 | — |
| **F inverted envelope** | 88.8% | **−0.0972** | **+0.0021** | — |

On longs the envelope is **worse than random** (−0.0164R vs arm E) and **its own inverse beats it**.
Arm F was written as the strongest possible statement that a thesis is backwards, and it fires.

### Against the pre-declared bar

| criterion | required | actual |
|---|---|---|
| 1 beats no-envelope | ≥ +0.02R | +0.0028 short / **−0.0166 long** — FAIL |
| 2 beats coverage-matched random | ≥ +0.02R | **+0.0012 short / −0.0164 long** — FAIL |
| 3 consistent | ≥ 6/9 periods | 5/9 short, 3/9 long — FAIL |
| 4 holds under both size mappings | yes | fails identically under both — FAIL |

**Comprehensively NOT VERIFIED.** The pre-declaration named this outcome in advance: *"Failing 2
while passing 1 means the envelope is merely trading less, not choosing better."* It does not even
pass 1.

## Conclusion

The user's read was right: **the envelope was a thesis, and it does not survive verification.** Its
reconstructible core is statistically indistinguishable from a random gate of the same sparsity on
shorts, and worse than one on longs.

The mechanism is now clear from Part 1: the alignment gates **keep the worse bars**. `biases_MIXED`
blocks bars averaging +0.0503R against a +0.0197R baseline; `alignment_not_full` keeps bars averaging
−0.0079R. The envelope is not a weak filter — it is inverted, and its aggressive sparsity means it
acts on that inversion hard.

**What the evidence supports:** the three inverted gates should go (arm C beats arm B on both sides,
consistently), and the ML component is the only part carrying signal (arm D beats arm B fourfold on
shorts).

**What it does NOT support:** deleting the envelope. The untestable guards — kill conditions, macro
proximity, earnings, news conflict — are absent from every arm here and exist to prevent specific
identified harms rather than to raise average EV. Removing an earnings gate because it did not appear
in a crypto backtest would be a category error.

## The limits that keep this from being final

- **Reconstructible core only.** Roughly half the envelope's conditions are not represented.
- **Entry is at the bar close**; real setups enter at a LEVEL the LLM picks, and the whole point of a
  conviction tier is to shape a setup that is then entered elsewhere. This gap is real.
- **`continuation` is approximated** by momentum alignment.
- One dataset, 24 symbols, a window in which the equal-weight basket fell 83%.

---

# PART 3 — what SHOULD the gates be? — PRE-DECLARED 2026-08-25, before computing

Part 2 established the envelope is not verified. This asks the constructive question, and the design
has to survive the obvious objection: **searching combinations and reporting the winner is
overfitting.** A "best gate set" found in hindsight proves nothing.

## Method: the SELECTION is what gets tested

Greedy forward selection, done **inside each training fold only**, then applied unchanged to the
held-out fold:

1. On train, start with no gates. Add the single gate that most improves net R per trade.
2. Repeat while an addition improves train by ≥ 0.005R and coverage stays ≥ 5%.
3. **Freeze that set. Evaluate on the test fold. Never look at test while choosing.**

So the reported number answers *"does evidence-driven gate selection generalise?"* — not *"what was
optimal in hindsight?"* If out-of-sample lift is ~0 while in-sample lift is large, the honest answer
is that gate selection itself does not survive, and the correct gate set is **none**.

## Candidate pool

Beyond the envelope's own conditions, the pool includes signals the research says are real and which
the envelope never used:

| candidate | why it is in the pool |
|---|---|
| `crash prob` low / high | the ONE validated model — replicated leave-one-symbol-out |
| ML_WIN thresholds (50/60/70) | the only envelope component with positive lift in Part 1 |
| ATR percentile high / low | volatility regime; the barrier target is ATR-normalised |
| realised-vol vs ATR | T20 found realised vol captures most of the ML's discrimination |
| RSI stretched | Part 1 found it **direction-specific**, which the envelope ignores |
| alignment / mixed / mature | the envelope's own, included so they can be beaten fairly |
| funding extreme | crowding, cheap to compute, never gated on |

Gates are evaluated **per direction**, because Part 1 showed the same condition can help one side and
hurt the other — a fact the current envelope has no way to express.

## Pre-declared bar

An evidence-selected gate set is **adopted** only if, on HELD-OUT folds:

1. it beats no-gates by **≥ 0.02R** per trade, AND
2. it beats a **coverage-matched random gate** by **≥ 0.02R**, AND
3. it is positive in **≥ 6 of 9** six-month periods by **sign count**, AND
4. it retains **≥ 5%** coverage.

## The outcome I expect, stated in advance so it cannot be rationalised later

Given that direction has failed 20+ tests and the envelope beats random by +0.0012R, the most likely
result is that **out-of-sample gate lift is near zero and no set is adopted**. That would mean the
honest configuration is the ML gate alone, or no gate at all, plus the untestable safety guards.

Recording that expectation now so a small positive result is not talked up, and a null is not
quietly reframed as a discovery.