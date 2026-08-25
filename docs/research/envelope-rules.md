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

## PART 3 RESULTS — gate selection does NOT generalise, on either side

### The overfitting is visible in one column

| side | fold | selected on train | **train R** | **TEST R** |
|---|---:|---|---:|---:|
| SHORT | 2 | ml≥0.70 + crash<0.45 | **+0.2396** | **−0.0586** |
| SHORT | 3 | ml≥0.70 + atr_low + mixed only | **+0.1322** | **−0.1598** |
| SHORT | 4 | crash≥0.45 + mixed only + trend mature | +0.1304 | +0.0878 |
| LONG | 3 | atr_high + crash<0.45 + not full stack | **+0.1136** | **−0.0926** |

Selection reliably finds gate sets worth **+0.13 to +0.24R in-sample** that are **negative
out-of-sample**. That is the entire finding, and it is what a "best gate set" quoted without
held-out evaluation would have looked like.

### The selected sets contradict each other

SHORT fold 2 chose `crash < 0.45` (trade when crash risk is LOW). SHORT fold 4 chose
`crash >= 0.45` (trade when it is HIGH). **Opposite gates on the same signal, two folds apart, each
justified by its own training data.** That is noise being fitted, not a rule being discovered.

### Against the pre-declared bar

| | SHORT | LONG |
|---|---|---|
| 1 beats no-gate (median) | FAIL −0.0032 | PASS +0.0222 |
| 2 beats coverage-matched random | FAIL −0.0005 | PASS +0.0238 |
| 3 consistent across six-month periods | FAIL 4/8 | FAIL 4/7 |
| 4 coverage floor every fold | FAIL 2.7%, 3.5% | FAIL 2.8% |
| | **DO NOT ADOPT** | **DO NOT ADOPT** |

**A process note.** The first version of this script evaluated only criteria 1 and 2, on the MEAN,
and printed **ADOPT** for LONG — carried by one fold at +0.1483R on 2.8% coverage. Enforcing the
criteria that were actually pre-declared (median, period sign count, coverage floor) flips it to DO
NOT ADOPT. **Third time in two days that a mean over few observations nearly produced a finding**;
the pre-declaration is what caught it each time.

## Conclusion — the honest gate configuration

**No gate set generalises.** Not the envelope's, and not one selected from evidence with a much
richer candidate pool that included the validated crash model.

This is the outcome the pre-declaration named in advance, which is the only reason it can be reported
without suspicion:

> *"the most likely result is that out-of-sample gate lift is near zero and no set is adopted."*

**What follows:**

1. **Adding gates is not the answer.** A larger, better-motivated pool did no better than the
   envelope's own — and the envelope beats random by +0.0012R.
2. **The envelope's complexity is unjustified by evidence.** Its ML component is the only part with
   any positive lift (Part 1), and ML alone beat the full envelope fourfold (Part 2).
3. **The untestable safety guards still stay.** Kill conditions, macro proximity, earnings, news
   conflict — never measured here, and they exist to prevent identified harms rather than to raise
   average EV. "No gate improves EV" is not "no gate should exist".
4. **The gap that could still overturn this**: every test enters at the BAR CLOSE. Real setups enter
   at a level the LLM picks. If gating value lives in level selection rather than bar selection, none
   of these three parts would see it — and that is the one experiment left worth running.

---

# PART 4 — does the value live in LEVEL selection? — PRE-DECLARED 2026-08-25

Parts 1-3 all enter at the **bar close**. Real setups name a LEVEL and enter only if price comes to
it — the ADA example: *"wait for a pullback to $0.2140"* while price sat at $0.2210. If gating value
lives there, none of the previous three parts could have seen it.

## What a conditional entry actually changes

Two distinct effects, and they pull in opposite directions:

1. **A better price.** Entering on a pullback means a tighter stop distance in absolute terms and a
   larger move to target from the fill.
2. **A selection effect, and it is adverse.** You only trade when price comes BACK. Bars where price
   runs away without retracing are exactly the strongest moves — and a pullback rule **systematically
   misses them**. This is the trap: any measurement that ignores unfilled setups will look great and
   mean nothing.

## Method

At each bar: place an entry `depth × ATR` against the direction, wait up to **12 hours** (the app's
own pending-setup expiry), and:

- **filled** → enter at the level, then run stop (2 ATR) and targets (1.5 / 2.5 ATR) from THERE;
- **unfilled** → no trade, recorded as such.

Depths tested: 0.00 (market, the control), 0.25, 0.50, 1.00 ATR.

**Fill rate is reported alongside every result.** A depth that fills 20% of the time is trading a
fifth as often, and per-trade R is not comparable across depths without it — so total R per
*opportunity* (filled and unfilled together) is the primary number.

## Hypotheses

- **H1** — pullback entry beats market entry on R per opportunity.
- **H2** — gates that failed under market entry pass under level entry.

## Pre-declared bar

- **H1 supported** if some depth beats depth-0.00 by **≥ 0.02R per opportunity**, positive in
  **≥ 6 of 9** six-month periods by sign count.
- **H2 supported** if out-of-sample gate-selection lift under the best depth reaches **≥ 0.02R**
  against both no-gate and coverage-matched random — the same bar Part 3 failed.

## Expected outcome, recorded in advance

The adverse-selection effect is mechanical and I expect it to dominate: better fills on the trades
you get, paid for by missing the runners. Most likely **H1 is null or negative on R per opportunity
while looking positive on R per filled trade** — and the per-filled number is the one that would be
quoted by someone trying to sell the result.

## PART 4 RESULTS — the value IS in the entry level, and it survives every control

### H1: strongly supported

| SHORT | fill | R/opportunity | vs market | periods+ |
|---|---:|---:|---:|---:|
| market (control) | 100% | −0.0036 | — | — |
| **pullback 0.25 ATR** | 88.3% | **+0.0624** | **+0.0660** | **9/9** |
| pullback 0.25 STRICT fill | 84.0% | +0.0431 | +0.0467 | **9/9** |
| delay 12h, then market | 100% | −0.0032 | +0.0003 | 2/9 |
| **CHASE 0.25 (adverse)** | 99.9% | **−0.1288** | **−0.1252** | **0/9** |

| LONG | fill | R/opportunity | vs market | periods+ |
|---|---:|---:|---:|---:|
| market (control) | 100% | −0.0709 | — | — |
| **pullback 0.25 ATR** | 92.2% | **+0.0210** | **+0.0919** | **9/9** |
| pullback 0.25 STRICT fill | 88.7% | +0.0081 | +0.0790 | **9/9** |
| delay 12h, then market | 100% | −0.0637 | +0.0072 | 8/9 |
| **CHASE 0.25 (adverse)** | 99.9% | **−0.1954** | **−0.1245** | **0/9** |

Measured **per opportunity**, so the adverse selection is already paid for — unfilled setups score
exactly zero and are counted.

### The three controls all land the right way

**Delay is not the mechanism.** Waiting the same 12 hours and then entering at market gives
+0.0003R (SHORT, 2/9 periods). The benefit is the LEVEL, not the patience. This was the control most
likely to kill the result and it passes cleanly.

**Conservative fills survive.** Requiring price to trade THROUGH the level by 0.05 ATR rather than
merely touch it — a limit order at a price the market kisses once often does not fill — attenuates
the effect by roughly a third and leaves it at +0.0467 / +0.0790, still 9/9 periods.

**The adverse arm is almost perfectly symmetric.** Chasing 0.25 ATR the wrong way costs −0.125R on
BOTH sides, **0/9 periods**. Buying dips helps by ~+0.09; buying rips hurts by ~−0.125. A simulation
bug would not produce that symmetry — it is the signature of a real price-level effect, namely
short-horizon mean reversion.

### Scale, against everything else measured

| finding | effect |
|---|---:|
| best gate set over random (Part 3) | +0.0012R |
| whole envelope over random (Part 2) | +0.0012R |
| **entry level, strict fill (Part 4)** | **+0.047 to +0.079R, 9/9** |

**Entry discipline is worth roughly 40-60× the entire gating apparatus.**

## Why Parts 1-3 found nothing

They all entered at the bar close — which is the WORST arm here, and the one arm that is negative on
both sides. Gates were being asked to rescue an entry method that loses by construction. The pre-
declaration for this part named that possibility, and it turned out to be the whole story.

## What this means for the app

**The app already does the right thing, and it was the untested part.** The LLM names an entry LEVEL,
frequently a pullback — *"wait for a pullback to $0.2140"* in the ADA example. That mechanic, not the
envelope wrapped around it, is where the measurable value lives.

It also rehabilitates one guard: `chase_into_extended_aligned_trend` defends against precisely the
−0.125R arm. Part 1 dismissed it because it was tested as a BAR filter under market entry; as an
entry-level rule it is guarding the single most expensive mistake measured here.

**And it explains the new `WAIT FOR LONG ENTRY` state.** Rendering a pullback entry as though it were
actionable at market invites the user into the −0.125R arm instead of the +0.079R one.

## Limits

- Strict fill still assumes execution on a 0.05 ATR penetration.
- Fees are charged at the **taker** rate both ways; a limit entry would be maker, so this is
  conservative.
- Short-horizon mean reversion is well known and crowded — it is measured net of fees here, but this
  is not a private discovery.
- **H2 is NOT yet run**: whether gates that failed under market entry pass under level entry. Given
  the entry effect is ~50× the gate effect, it is secondary, but it remains open and is recorded as
  such rather than quietly dropped.

---

# PART 5 — do STRUCTURAL levels beat a mechanical pullback? — PRE-DECLARED 2026-08-25

Part 4 used a synthetic `0.25 x ATR` pullback. The app uses levels the LLM picks — recent swing
structure, S/R, value-area edges. Nobody has checked which is better, and the answer decides how much
of the analysis layer is load-bearing.

## Arms (all entered as limit orders, 12h wait, unfilled = 0, R per OPPORTUNITY)

| arm | entry |
|---|---|
| market | at the close — the control Part 4 showed is the worst |
| mechanical 0.25 ATR | fixed depth against the direction |
| **swing 24h** | recent 24h low (LONG) / high (SHORT) — a real structural level |
| **swing 72h** | the same over 72h — a more significant level, further away |
| VP value-area edge | VAL (LONG) / VAH (SHORT), the app's own volume-profile levels |

## Pre-declared bar

A structural arm **beats mechanical** only if it exceeds the 0.25 ATR arm by **≥ 0.02R per
opportunity** and is positive in **≥ 6 of 9** six-month periods by sign count.

## Why both outcomes are useful

- **Structure wins** → the analysis layer's level-picking is load-bearing and worth its cost.
- **Mechanical ties or wins** → a fixed-depth limit order captures the entire effect, and the app can
  be dramatically simpler than it is.

## Expected outcome, recorded in advance

`strategy-levels.md` already found levels are real LOCATIONS (+4.3pp hold vs random lines) but that
their *strength* is unrankable and snapping TARGETS to them lowers EV. I therefore expect structure
to be roughly comparable to mechanical on entry, not clearly better — with deeper levels filling less
often and trading that away.

## PART 5 RESULTS — a SHALLOW mechanical pullback beats structural levels

| SHORT | fill | mean depth | R/opp | vs mechanical | periods+ |
|---|---:|---:|---:|---:|---:|
| market | 100% | 0.00 | −0.0035 | −0.0660 | 0/9 |
| **mechanical 0.25 ATR** | 88.3% | 0.25 | **+0.0625** | — | — |
| swing 24h | 25.8% | 0.63 | +0.0067 | −0.0558 | 1/9 |
| swing 72h | 15.4% | 0.80 | +0.0023 | −0.0602 | 1/9 |

| LONG | fill | mean depth | R/opp | vs mechanical | periods+ |
|---|---:|---:|---:|---:|---:|
| market | 100% | 0.00 | −0.0710 | −0.0919 | 0/9 |
| **mechanical 0.25 ATR** | 92.2% | 0.25 | **+0.0209** | — | — |
| swing 24h | 26.5% | 0.69 | −0.0027 | −0.0237 | 5/9 |
| swing 72h | 15.4% | 0.85 | −0.0027 | −0.0236 | 5/9 |

**Structure loses, and it is not merely a depth effect.** Part 4 measured a mechanical 0.50 ATR
pullback at **+0.0555 (SHORT)** — comparable depth to swing-24h's 0.63, but nearly 8× the return, and
it fills 65% of the time against swing's 26%.

So a swing level at the same nominal distance both fills far less often AND performs no better when
it does. That makes sense mechanically: a recent swing low is a price the market has *already
rejected once*, and reaching it again requires a move large enough to change the situation the setup
was premised on.

### The dominant variable is FILL RATE, not level quality

Per opportunity, missing 74% of trades costs far more than a better entry price gains. Ranked by
what actually matters:

| depth | fill | R/opp (SHORT) |
|---|---:|---:|
| 0.00 (market) | 100% | −0.0036 |
| **0.25** | **88%** | **+0.0624** |
| 0.50 | 65% | +0.0555 |
| 0.80 (swing 24h) | 26% | +0.0067 |
| 1.00 | 29% | +0.0215 |

There is a sweet spot at **shallow**: deep enough to avoid paying the spread into a move, shallow
enough to actually fill.

## Conclusion — the analysis layer's level-picking is NOT load-bearing

This is the outcome that simplifies the app. A **fixed shallow limit order captures the entire
effect**, and choosing a "good" structural level makes it worse by trading away fill rate for a price
the market has already rejected.

Consistent with `strategy-levels.md`, which found levels are real LOCATIONS but their strength is
unrankable and snapping TARGETS to them lowers EV. The same now holds for entries.

**Caveat on the proxy:** swing here is the extreme low/high of the prior 24h/72h, which is cruder
than an LLM's choice — a model might pick a nearer, more relevant level. But the mechanism found
(fill rate dominates, and shallow wins) does not depend on the proxy's precision, and the mechanical
0.50 ATR comparison isolates it from depth.

---

# PART 6 — does RSI divergence mean anything? — PRE-DECLARED 2026-08-25

The user's observation: *"Traders use them to predict the move. We say stay put. We do the opposite."*

The envelope has **two** divergence rules, neither ever tested:
- `divergence_escalated_6+_candles` — a hard AUTO-FLAT
- `divergence_against_bias` — a kill condition, which feeds `ANY_KILLED` → also a hard AUTO-FLAT

Classical technical analysis says divergence **predicts a reversal**. The app says **stand aside**.
Those cannot both be right, and there is a third possibility neither side considers.

## The three outcomes, all of which are findings

1. **Divergence predicts REVERSAL** → traders right, the app's rules are backwards, and a divergence
   should be a setup trigger rather than a FLAT.
2. **Divergence predicts NOTHING** → both wrong. The rules are noise and should go, and the classical
   claim joins the graveyard.
3. **Divergence predicts CONTINUATION** → the app is accidentally right, for the wrong reason. Its
   rules would then be worth keeping but should be re-described honestly.

## Method

`dDivergence` / `hDivergence` are already computed (+1 bullish, −1 bearish, 0 none; each fires on
~12% of bars), ported from the iOS peak/trough detector. Two questions, kept separate:

**A — DIRECTION.** P(up over 24h) after bullish divergence vs after bearish vs the unconditional
base. **Measured against the ACTUAL base rate, not 50%.** On 2026-08-23 two "findings" at p≈e−88
evaporated when tested against the real 48.18% base instead of a coin flip.

**B — MONEY.** Net R at the app's own geometry, taking the trade classical TA implies — LONG on
bullish divergence, SHORT on bearish — with the entry discipline Part 4/5 established (shallow
0.25 ATR pullback, unfilled = 0), so the test is not sabotaged by the market-entry problem that made
Parts 1-3 uninformative.

**C — THE APP'S RULE.** Does flatting on divergence improve the bars that remain? The same gate
question as Part 1: a condition can correlate with poor outcomes and still be a bad gate.

## Pre-declared bar

- **Reversal supported** if the implied trade beats no-divergence bars by **≥ 0.02R** and is positive
  in **≥ 6 of 9** six-month periods by **sign count**.
- **Continuation supported** if the OPPOSITE trade clears the same bar.
- **The app's FLAT justified** if blocking divergence bars raises the remainder by **≥ 0.02R**, ≥ 6/9.
- Anything else is **null**, and both rules should be removed as unsupported.

## Expected outcome, recorded in advance

Null. Every direction primitive tested in this vault has come back a coin flip, and divergence is a
direction claim. But `alignment_not_full` measured inverted rather than merely useless, so an
inverted result here would not be unprecedented.

## PART 6 RESULTS — divergence is statistically real and economically worthless

### A. Direction — and the two timeframes CONTRADICT each other

Unconditional P(up 24h) = **0.4930**, not 0.50.

| | n | P(up24) | vs base | p | classical TA expects |
|---|---:|---:|---:|---:|---|
| **DAILY** bullish div | 21,449 | 0.4868 | **−0.0062** | 0.070 | UP — **wrong sign** |
| **DAILY** bearish div | 15,399 | 0.5072 | **+0.0143** | 4.0e−04 | DOWN — **wrong sign** |
| **4H** bullish div | 17,284 | 0.5154 | **+0.0224** | 3.9e−09 | UP — correct |
| **4H** bearish div | 16,167 | 0.4770 | **−0.0160** | 4.6e−05 | DOWN — correct |

On the **4H** divergence behaves exactly as traders claim, at p = 3.9e−09. On the **DAILY** it is
**inverted** — bearish divergence is followed by UP more often than baseline, significantly.

**The same indicator on two timeframes gives opposite signs.** That is not what a real mechanism
looks like; it is what a weak effect looks like when it is sliced two ways.

### B. Money — neither trade clears the bar

| | R/opp | vs no-div | periods+ |
|---|---:|---:|---:|
| DAILY: reversal (classical TA) | 0.0307 | −0.0108 | 5/9 |
| DAILY: continuation (opposite) | 0.0551 | +0.0135 | 4/9 |
| 4H: reversal (classical TA) | 0.0371 | −0.0048 | 4/9 |
| 4H: continuation (opposite) | 0.0447 | +0.0029 | 5/9 |

**The 4H direction effect is significant at p = 3.9e−09 and does not convert into money.** A +2.24pp
edge on a near-coin-flip is real and far too small to survive the payoff geometry. This is the
cleanest example in the vault of statistical significance without economic significance — and with
290,000 rows, almost anything reaches significance.

### C. The app's own rule — noise

| | blocked bars | kept bars | lift | periods+ |
|---|---:|---:|---:|---:|
| DAILY, SHORT | 0.0453 | 0.0649 | +0.0025 | 5/9 |
| DAILY, LONG | 0.0405 | 0.0182 | −0.0028 | 4/9 |
| 4H, SHORT | 0.0674 | 0.0618 | −0.0007 | 4/9 |
| 4H, LONG | 0.0143 | 0.0219 | +0.0009 | 6/9 |

Every lift is within ±0.003R of zero. Flatting on divergence neither helps nor hurts.

## Verdict — NULL on all three questions

Traders are **not** right (the money test kills the reversal trade, and the daily direction is
inverted). The app is **not** right either (its FLAT does nothing). And the opposite trade does not
work. Per the pre-declaration, that is the null branch.

**So the user's framing — "traders predict a move, we say stay put, we do the opposite" — resolves
as: everyone is arguing about a signal that carries no usable information.**

## What this does NOT license, stated carefully

I tested the **raw divergence flag**. The envelope's two rules are narrower:
- `divergence_escalated_6+_candles` requires divergence *worsening over 6+ candles*
- `divergence_against_bias` requires divergence *opposing the current bias*

A null on the underlying signal makes a real effect in a subset unlikely, but this is **not a direct
test of either rule**, and removing them on this evidence would be the same over-reach the alignment
result was nearly subjected to. The honest status is **unsupported, not disproven** — and the
narrower variants are a cheap follow-up whenever it is worth running.

## PART 6 FOLLOW-UP — the two ACTUAL rules, tested directly: unsupported

Part 6 tested the raw flag. These are the envelope's real conditions.

| rule | fires | SHORT lift | periods+ | LONG lift | periods+ |
|---|---:|---:|---:|---:|---:|
| escalated 6+ (daily) | 11.2% | +0.0022 | 5/9 | **−0.0028** | 4/9 |
| against bias (daily) | 7.5% | +0.0019 | 7/9 | **−0.0024** | 2/9 |
| escalated 6+ (4H) | 4.1% | +0.0006 | 5/9 | −0.0007 | 3/9 |
| against bias (4H) | 7.5% | −0.0002 | 4/9 | −0.0003 | 4/9 |
| escalated 6+ (either) | 14.9% | +0.0028 | 6/9 | **−0.0035** | 2/9 |
| against bias (either) | 14.4% | +0.0011 | 6/9 | **−0.0021** | 2/9 |

**Twelve tests, zero pass.** Best SHORT lift is +0.0028R against a +0.02R bar. **Every LONG lift is
negative**, and `against bias (daily)` blocks bars averaging **+0.0504R** while keeping bars
averaging **+0.0186R** — the same block-the-best-bars signature as `biases_MIXED` and
`alignment_not_full`.

### Why these are removed while macro and earnings stay

The distinction matters and is worth stating once, because it governs every future decision of this
kind:

- **`macro_IMMINENT`, earnings proximity** — guard against an EXOGENOUS EVENT. Their justification is
  that a scheduled release can gap the price regardless of what any indicator says. They were never
  claiming predictive power, so a null EV test does not refute them.
- **The divergence rules** — claim PREDICTIVE POWER. Divergence is asserted to foretell a reversal.
  A claim of prediction must be earned empirically, and this one is not: the underlying signal
  carries a real but economically worthless direction effect (Part 6), and both narrow variants gate
  nothing (above).

Removing them, so the envelope stops asserting something the data does not support.