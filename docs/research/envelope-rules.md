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

## PART 6 CORRECTION — the daily "signal" was autocorrelation; the 4H one is real

Prompted by the user asking the obvious question: *"if daily divergence predicts upside, why not use
that?"* Checking it properly overturned half of Part 6's reasoning.

**Divergence persists.** It is the same condition re-read every 4h, so BARS are not independent
observations. The honest unit is the EPISODE — a contiguous run of the condition.

| cell | bars | episodes | bars/ep | per-BAR p | **per-EPISODE p** | verdict |
|---|---:|---:|---:|---:|---:|---|
| DAILY bullish | 21,449 | 510 | 42.1 | 0.070 | **0.719** | **NOISE** |
| DAILY bearish | 15,399 | 352 | 43.7 | **4.0e−04** | **0.324** | **NOISE** |
| 4H bullish | 17,284 | 2,451 | 7.1 | 3.9e−09 | **<0.001** | **real** |
| 4H bearish | 16,167 | 2,280 | 7.1 | 4.8e−05 | **<0.001** | **real** |

**A daily divergence episode lasts ~44 bars — over a week.** Counting each bar as an observation
inflates significance by ~6.6×. Corrected, the daily "bearish divergence precedes UP" result goes
from +1.43pp at p = 4.0e−04 to **+0.73pp at p = 0.32**: nothing.

The 4H episodes last ~7 bars, so the correction is milder and both cells survive it.

### What this overturns in Part 6

Part 6 concluded: *"The same indicator on two timeframes gives opposite signs. That is not what a
real mechanism looks like."* **That reasoning was wrong.** There was no contradiction to explain —
the daily was never a signal, and the apparent inversion was an artifact of treating a week-long
condition as 44 independent readings. **The 4H effect is real and points exactly where classical TA
says it should.**

### What it does NOT overturn

The decision stands, on the two grounds that were always the load-bearing ones:

- **The money test.** Part 6B measured the 4H reversal trade directly: lift **−0.0048R at 4/9
  periods**. A +2.24pp shift on a 49.3% base is a 51.5% coin, and the median fee at a 2-ATR stop is
  **0.032R** per round trip. Rough ceiling on the gross edge is ~0.05R; most of it is eaten before
  anything is left.
- **The gate test.** Twelve variants of the app's actual rules, zero passes, every LONG lift negative.

**So: 4H divergence is a genuine directional signal that is too small to trade, and daily divergence
is not a signal at all.** Demoting both to context remains correct.

### The methodology lesson, now recorded four times

This is the **fourth** occasion in three days that treating dependent observations as independent
nearly produced a finding: T3's market-wide features (34,821 rows → 684 timestamps), Control 2's mean
over five periods, Part 3's gate-selection mean, and now this. **Any claim from this dataset must
state its effective n.** Bars are almost never the right unit.

---

# PART 7 — sweep EVERY remaining testable envelope condition — PRE-DECLARED 2026-08-25

Parts 1-6 tested the conditions I reached for. This tests **everything left that the data can
express**, so the envelope's untested surface is enumerated rather than assumed.

## Testable here

| condition | envelope tier | reconstruction |
|---|---|---|
| `counter_move_volume_exceeds` (kill) | AUTO-FLAT via ANY_KILLED | elevated volume ratio while price moves against bias |
| `funding_supports_counter` (kill) | AUTO-FLAT via ANY_KILLED | funding sign favouring the counter direction |
| `continuation < 2` | cap LOW | momentum-alignment magnitude |
| `continuation < 3` | cap MODERATE | same, stricter |
| `counter_trend_pullback` (1H opposes) | downgrade | 1H bias opposing the daily |
| `macro` proxy (VIX regime) | cap tiers | high-VIX state, the only macro variable present |
| `structureAlignment` | (feeds continuation) | included so its own contribution is visible |

## NOT testable, and excluded rather than guessed

`macro_IMMINENT` (no economic calendar in this dataset), `news_thesis_conflict` (no news), all
earnings gates and `treatment_short_gate_stocks` (stocks only, no stock paths here),
`treatment_long_confirm_*` (needs `relStrengthVsSpy`, which is null on crypto), and
`data_stale_N_sources` (a runtime condition with no historical analogue).

**These stay in the envelope regardless of what Part 7 finds.** Several guard exogenous events and
never claimed predictive power — the distinction established in Part 6.

## Same bar as every previous part

A condition **earns its place** if blocking its bars raises the mean net-R of the remainder by
**≥ 0.02R** at the app's geometry (2 ATR stop, TP2 1.25R), **positive in ≥ 6 of 9** six-month periods
by **sign count**, retaining **≥ 20%** coverage. Entry is the Part 4/5 discipline (0.25 ATR pullback,
unfilled = 0), so no condition is judged under the market-entry handicap that made Parts 1-3
uninformative.

**Effective n is reported for every condition.** Four times in three days a dependent-observation
error nearly produced a finding here; any condition that persists across many bars gets its episode
count printed beside its p-value.

## Expected outcome

Null across the board, consistent with Parts 1-3 and 6. Recorded in advance.

## PART 7 RESULTS — nothing earns its place; two more conditions are INVERTED

| condition | fires | episodes | SHORT lift | LONG lift | verdict |
|---|---:|---:|---:|---:|---|
| `counter_move_volume_exceeds` (kill) | 1.2% | 3,501 | +0.0001 | −0.0004 | noise, and near-inert |
| **`funding_supports_counter` (kill)** | 29.2% | 14,401 | **−0.0119** (3/9) | +0.0132 (6/9) | **INVERTED on SHORT** |
| `1H opposes daily` (downgrade) | 18.7% | 18,711 | +0.0028 (6/9) | −0.0026 (4/9) | noise |
| **`structureAlignment` weak** | 82.4% | 4,880 | **−0.0098** (4/9) | +0.0124 (6/9) | **INVERTED on SHORT** |
| macro proxy: VIX high | 25.5% | 942 | +0.0066 (7/9) | **−0.0084** (4/9) | noise / inverted |
| `continuation < 2` / `< 3` | **100%** | — | — | — | **PROXY BROKEN — not tested** |

**Zero conditions clear the bar on either side.**

### `funding_supports_counter` blocks the best bars on the short side

It discards bars averaging **+0.0911R** against a **+0.0624R** baseline and keeps **+0.0506R** — the
same block-the-best-bars signature as `biases_MIXED`, `alignment_not_full` and the divergence rules.
On LONG it is +0.0132 at 6/9: consistent but under the +0.02 magnitude bar, so it does not earn its
place there either.

**This is a prediction claim, not a structural guard.** It asserts that funding paying the counter
side makes the counter move more likely. By the Part 6 principle that has to be earned, and it is
not. Removed from `ANY_KILLED`.

### A failed reconstruction, reported rather than dressed up

`continuation < 2` and `< 3` fired on **100% of bars**. That is not a finding, it is a broken proxy:
`momentumAlignment` ranges −1..+1, so `|mom| < 2` is trivially always true. The envelope's
continuation count is a different quantity that this dataset does not carry. **Recorded as NOT
TESTED.** A 100% fire rate is the tell that a reconstruction is wrong, not that a condition is
universal — and reporting the resulting `nan` lift as a result would have been worse than useless.

### What stays, and why

- **`counter_move_volume_exceeds`** — noise, not inverted, and fires on 1.2% of bars. Removing it
  would change almost nothing either way, and "does nothing measurable" is not "proven wrong". Left
  in place.
- **`macro_IMMINENT`, earnings, news conflict, staleness, the stock gates** — not testable here and
  excluded from every arm. The macro *proxy* above is VIX regime, which is not the same thing as a
  scheduled release, so it says nothing about the real rule.
- **`chase_into_extended_aligned_trend`** — the only envelope condition with positive evidence, via
  Part 4: it defends the −0.125R chase arm.

## The envelope after Parts 1-7

| kept | removed / demoted |
|---|---|
| ML_WIN thresholds (only component with positive lift) | `biases_MIXED_and_ML<70` — blocked +0.0503R bars |
| `chase_into_extended_aligned_trend` — Part 4 | `alignment_not_full` on SHORT — kept the losers |
| `alignment_not_full` on LONG only | `divergence_escalated_6+` — 12 tests, 0 passes |
| macro / earnings / news / staleness (untestable, exogenous) | `divergence_against_bias` — same |
| `counter_move_volume_exceeds` (inert) | `funding_supports_counter` — blocked +0.0911R bars |
| | `conformal_abstain` — dead code |

Every removal was a condition that **claimed predictive power and measured inverted**. Every
retention is either measured-positive, exogenous-event cover, or inert.

## PART 7 FOLLOW-UP — two "untestable" conditions were testable after all

Prompted by the user asking what remained untestable. Checking rather than asserting overturned two
of the exclusions.

### `continuation` — the variable was wrong, not the data

The envelope counts specific 4H signals (EMA-stack alignment, direction-supporting funding), and both
are in the feature set. My Part 7 proxy used `momentumAlignment`, which is simply a different
quantity. Reconstructed properly:

| | SHORT | LONG |
|---|---:|---:|
| `continuation < 2` (cap LOW) | +0.0220 lift, **5/9** | **−0.0218**, 4/9 |
| `continuation < 3` (cap MODERATE) | degenerate — fires 100% | — |

SHORT clears the magnitude bar and **fails consistency at 5/9**; LONG is inverted. Neither earns its
place. **`< 3` is still not tested**: my reconstruction captures only two of the envelope's signals
so it maxes at 2, making `< 3` trivially true — the same 100%-fire tell as before, from the same
cause. Even the `< 2` figure is a **partial proxy**, not the real rule.

### `macro` — testable against the 986 Fed releases, and day-of-week changes the answer

| | raw SHORT | **DoW-stratified SHORT** | raw LONG | **DoW-stratified LONG** |
|---|---:|---:|---:|---:|
| IMMINENT (≤4h) | −0.0032 | **−0.0053** | +0.0043 | +0.0082 (7/9) |
| NEARBY (≤24h) | −0.0128 | **−0.0231** | +0.0107 | **+0.0284 (6/9)** |

Stratification **flipped the LONG result into a pass** — the artifact running the other way this
time. But three things make that pass weak: it is one side only, it appears only after a correction,
and Fed releases are a **subset** of the calendar the real rule uses (no CPI, no NFP).

### The framing that actually settles macro

**EV is the wrong test for it.** Per the Part 6 distinction, `macro_IMMINENT` guards an EXOGENOUS
SCHEDULED EVENT — it never claimed to predict direction, it claims a release can gap the price. The
right question is whether macro proximity raises the chance of a large ADVERSE move, not whether
avoiding it raises mean EV. **A null or even inverted EV result does not refute a variance guard.**

So macro stays, and the EV numbers above are recorded as context rather than as grounds for action.

## What remains genuinely untestable, and why

| condition | why | could it become testable? |
|---|---|---|
| `news_thesis_conflict` | `news_items` D1 only starts 2026-08-22 — ~3 days | yes, with months of accumulation |
| earnings gates (0-2d / 3-7d / 8-14d) | stocks only; no stock intraday paths in `vision_backfill` | **yes** — needs a stock kline pull |
| `treatment_short_gate_stocks` | stocks only | same |
| `treatment_long_confirm_*` | needs `relStrengthVsSpy`, which is **0.0 on 100% of crypto rows** | only on stocks |
| `data_stale_N_sources` | a pipeline-health condition with no market-state analogue | **no** — not a market claim at all |
| `continuation < 3` | reconstruction captures 2 of N signals | yes, with the full signal list ported |
| full economic calendar | only Fed releases backfilled; no CPI/NFP | yes, with more backfill |

**The honest count: of ~20 envelope conditions, 13 are now directly tested, 2 are tested on partial
proxies, and 5 remain untested — 4 of which are stock-only or need data accumulation, and 1 of which
(`data_stale`) is not a market claim and never will be testable this way.**
---

# PART 8 — the four stock-only conditions (PRE-DECLARED, nothing computed yet)

Part 7 listed four conditions as untestable "stocks only; no stock intraday paths". That was wrong
in the same way the `continuation` exclusion was wrong: I checked the crypto backfill directory,
found no stock paths, and stopped. **The stock hourly bars have been in the box's own candle archive
since 2019-01-07** — 13,063 bars for AAPL, deeper than any crypto symbol — and a 1.0 GB local
snapshot of that archive sits in the repo working tree. No tunnel, no `/history` fan-out, no new
data source. Extracted with `stock_klines_extract.py`.

**Second time in two days that "untestable" meant "I did not look".** The rule this earns: before
recording a condition as untestable, name the specific data that is missing and where it would have
to come from. "No stock paths in `vision_backfill`" describes a directory, not a data gap.

## The data

| | |
|---|---|
| symbols | **159** (the full stock universe) |
| joinable opportunities | **490,794** (97.6% exact-timestamp join to `csv_exports_v14_stocks`) |
| span | 2020-01 → 2026-06 |
| price paths | `stock_klines/` — hourly, from the D1 snapshot |
| features | `csv_exports_v14_stocks/` — the existing v14 regen, unchanged |

Coverage ends 2026-06-12 (the snapshot date) against crypto's 2026-07-31. Periods are scored
per-window, so the shorter tail costs at most the final half-year window, not the comparison.

## Declared BEFORE computing

**1. Horizon — hold ATR-periods constant, not clock hours.** Barrier distances are in units of the
**4H** ATR, so the horizon must be counted in 4H-bars or the two markets get different tests. Crypto
used WAIT 12 / HOLD 72 hourly bars = **3 / 18 ATR-periods**. A stock "4H" bar is ET-session
aggregated — two bars per 6.5-hour session, so **3.25 trading hours each**. Holding 3/18 periods
gives **WAIT_H = 10, HOLD_H = 59** stock trading-hour bars. Robustness re-run at HOLD_H = 72
(22 periods); a conclusion that flips between the two is reported as unstable, not as a finding.

**2. Fee = 0.05% round trip.** Retail stock commissions are zero; this covers spread and slippage on
liquid large caps. Crypto's 0.171% is a derivatives taker fee and does not apply. Sensitivity at
0.00% and 0.171% — a verdict that depends on the fee is reported as fee-dependent.

**3. Primary metric — `d0.25_{side}_oppR`**, R per OPPORTUNITY at the shipped 0.25 ATR pullback
entry, unfilled setups scoring exactly 0. Same as Parts 4-7.

**4. The exact conditions, transcribed from `prompt.ts`, not from memory.**

| condition | fires when |
|---|---|
| `treatment_long_confirm_FAIL` (auto-FLAT) | aligned LONG, alignment ≠ MIXED, and **neither** `relStrengthVsSpy ≥ 1.0` **nor** `dRsiDelta1 ≥ 1.0` |
| `treatment_long_confirm_PARTIAL` (cap LOW) | aligned LONG and **exactly one** of the two passes |
| `treatment_short_gate_stocks` (auto-FLAT) | aligned-bearish SHORT, unless **all** of ML ≥ 70, 4H Stoch bearish, regime TRENDING |
| `earnings_in_0-2d` (cap LOW) / `3-7d` (cap MODERATE) / `8-14d` (downgrade) | forward days to the next earnings date |

**The column choice is declared in advance because Part 7 got exactly this wrong.** `prompt.ts`
computes `rsiSeries[last] − rsiSeries[last−1]` — a **ONE-bar** daily RSI delta. That is the CSV's
`dRsiDelta1` (std 3.33, passes on 20.9% of bars), **not** `dRsiDelta`, which is the 6-bar
rate-of-change (std 8.54, passes on 46.5%). `dRsiDelta1` is primary; the 6-bar column is reported as
a sensitivity only, and a pass that appears only on the wrong column is not a pass.

Earnings days come from `earnings_history.json` (161 symbols, real dates) as **forward** days to the
next report. The `earningsProximity` feature is deliberately NOT used: it is `exp(−daysToNearest/7)`
over the nearest report in **either** direction, so it cannot distinguish "two days before" — the
gap risk the gate exists for — from "two days after", when the risk has already resolved.

**5. Ship bar (unchanged from Parts 1-7):** lift ≥ **+0.02R**, positive in ≥ **6 of 9** half-year
periods, and kept coverage ≥ **20%**. Both sides reported separately; a rule that passes on one side
and inverts on the other is scoped, not adopted whole — the `alignment_not_full` precedent.

**6. Day-of-week stratification is mandatory for the earnings arms.** Earnings land on weekdays and
cluster in four seasonal windows, so the baseline "far from earnings" set is not calendar-neutral.
`news-catalyst-test.md` recorded a −10.8pp result at z = −10.4 that was entirely this artifact.

**7. Episode-level reporting for anything that persists.** The Part 6 correction — daily divergence
looked significant at p = 4.0e−04 and collapsed to p = 0.32 once ~44-bar episodes were counted
instead of bars — applies to every condition here. `treatment_long_confirm` keys on a daily bias and
a daily RSI delta, so consecutive 4H bars are NOT independent observations. Any claim states its
effective n.

## The earnings gates get a SECOND, different test — and the EV test cannot refute them

By the Part 6 principle, a condition that guards an **exogenous scheduled event** never claimed
predictive power, so a null EV result does not refute it. `macro_IMMINENT` was retained on exactly
this ground. Earnings gates are the same class: the code's own words are *"gap risk 5-20%, stop will
not hold"* — a **variance** claim, not a direction claim.

So the EV sweep is recorded as CONTEXT for the earnings arms and cannot remove them. The claim they
actually make is tested separately and directly:

> **Do large adverse GAPS cluster near earnings?** For every opportunity, take the largest
> overnight gap `|open[t] − close[t−1]|` inside the hold window, in ATR units, and measure
> `P(max gap ≥ 2 ATR)` — a gap that jumps clean over the app's 2 ATR stop.
>
> **Bar: the rate inside the earnings window must be ≥ 1.5× the far-from-earnings baseline, in ≥ 6
> of 9 periods.** Below that, the guard is not doing what it says, and the specific windows that
> fail are the ones to narrow — 8-14d being the least plausible on its face.

This is the one arm where a null result is genuinely actionable, because it tests the stated
mechanism rather than a proxy for it.

## What this part CANNOT settle

`data_stale_N_sources` is a pipeline-health condition with no market analogue and is not tested here
or ever. `news_thesis_conflict` still needs months of `news_items` accumulation. `continuation < 3`
still needs the full signal list ported. Those three remain genuinely open.

## PART 8 RESULTS — the earnings gates are the first envelope conditions to PASS

Run at 8396f25 against the declarations above. **487,155 opportunities, 159 symbols, 2020-01 →
2026-05**; 299,377 of them carrying an out-of-fold ML_WIN.

### First, the entry finding replicates out of sample

Not a gate result, but the most important line in this Part. Parts 4-5 measured entry discipline on
crypto only. On stocks, untouched by that work:

| entry | SHORT | LONG |
|---|---:|---:|
| at MARKET | −0.0794R | +0.0562R |
| **0.25 ATR PULLBACK** | **−0.0333R** | **+0.0810R** |
| **gain** | **+0.0461R** | **+0.0248R** |

Crypto measured +0.066 / +0.092. Same sign, same order of magnitude, a different asset class, a
different market structure, 159 symbols. **Entry discipline is the one finding this project has that
replicates across markets** — and it is still ~20-40× anything the gating layer produces.

Note also that stock LONGs are positive at market (+0.056R) where crypto LONGs were negative. The
2020-2026 tape is the obvious reason and it is not a claim about the future.

### A simulator limitation I built in, found here, and corrected

`stock_rows.py` — like every payoff script in Parts 1-7 — prices a stopped trade at **exactly −1R**.
Real stops do not fill at the stop price when the market gaps through them overnight. So the EV arm
could not see gap damage **by construction**, and its earnings null was an artifact rather than
evidence.

Re-priced at the honest fill (breaching bar's OPEN when that open is already beyond the stop):

| window | stops | **gapped through** | mean slip | idealR | **realR** | cost of the assumption |
|---|---:|---:|---:|---:|---:|---:|
| LONG 0-2d | 4,768 | **42.7%** | −0.408R | +0.0296 | **−0.1565** | **−0.186R** |
| LONG 3-7d | 9,145 | 30.6% | −0.260R | +0.0864 | −0.0222 | −0.109R |
| LONG 8-14d | 12,791 | 20.5% | −0.105R | +0.0809 | +0.0392 | −0.042R |
| LONG >14d | 133,418 | 16.8% | −0.057R | +0.0833 | +0.0629 | −0.020R |
| SHORT 0-2d | 4,987 | **44.6%** | **−1.434R** | −0.0100 | **−0.6933** | **−0.683R** |

The average stopped SHORT inside two days of earnings loses **2.43R against a 1R risk budget**. The
cost rises monotonically as earnings approach, exactly as a gap-risk guard would predict.

**Parts 1-7 are unaffected.** The same measurement on crypto: **0.3% of stops gap through, −0.0013R
across all stops.** A 24/7 tape has no session boundary to gap across, so the −1R assumption is
near-exact there. This is a stocks-only correction.

### The earnings gates' own claim, tested directly

The code says *"gap risk 5-20%, stop will not hold"*. Baseline P(overnight gap ≥ 2 ATR inside the
hold window) away from earnings = **0.0737**.

| window | n | P(gap ≥ 2 ATR) | ratio | periods+ | verdict |
|---|---:|---:|---:|---:|---|
| 0-2d | 6,320 | 0.5217 | **7.08×** | **8/8** | **REAL** |
| 3-7d | 13,427 | 0.5181 | **7.03×** | **9/9** | **REAL** |
| 8-14d | 20,194 | 0.3680 | **4.99×** | **9/9** | **REAL** |

**All three clear the pre-declared 1.5× bar by a factor of three to five, in every period.**
Including 8-14d, which the pre-declaration called "the least plausible on its face" — wrongly: a
9-trading-day hold opened 8-14 days out straddles the report about half the time, so the exposure
is real even that far ahead.

### The global-lift bar cannot validate a low-coverage guard — an arithmetic correction

The earnings arms still score "noise" on global lift (+0.006 / +0.003 / +0.003). That is not a
verdict about the gate; it is the arithmetic of the metric.

**CORRECTED 2026-08-25 (Part 9).** The first version of this section said the gate "delivers 100% of
its theoretical maximum". True, but **tautologically** so — `lift ≡ fire_rate × penalty` is an
algebraic identity for every gate, not a property of this one:

> `lift = kept − mean_all = kept − [f·blocked + (1−f)·kept] = f·(kept − blocked)`

The non-trivial statement is what that identity implies about the BAR. A +0.02R lift bar silently
demands `penalty ≥ 0.02 / fire_rate`:

| coverage | penalty the +0.02R bar demands |
|---:|---:|
| 20% | 0.10R |
| 6.75% | 0.30R |
| 4.5% | 0.44R |
| **2.15%** | **0.93R** |
| 1.2% | 1.67R |

**At 2% coverage the bar requires blocked bars to be nearly a full R worse than kept ones** — a
standard no realistic guard meets. The Parts 1-7 bar is therefore only meaningful above ~20%
coverage, which is exactly where it was originally calibrated and never restated.

So the bar declared in Parts 1-7 is only meaningful for conditions firing on ≳20% of bars. For
anything sparser, the right statistics are the **per-blocked-bar penalty** and its **period
consistency**, both of which the earnings windows pass emphatically (0.21R worse per trade on
LONG 0-2d, 8/9 and 9/9 periods). Recorded as a correction to the harness, not to the earnings result.

### The two stock gates

| condition | fires | blocked | kept | global lift | periods+ | applicable-only lift |
|---|---:|---:|---:|---:|---:|---:|
| `treatment_short_gate_stocks` (SHORT) | 14.7% | **−0.1123** | −0.0343 | +0.0114 | **8/9** | n/a — see below |
| `treatment_long_confirm_FAIL` (LONG) | 9.5% | +0.0838 | +0.0906 | +0.0007 | 4/9 | **−0.0070** |
| `treatment_long_confirm_PARTIAL` (LONG) | 14.5% | +0.0597 | +0.0951 | +0.0052 | 6/9 | +0.0074 |

Stable across all four robustness arms (HOLD 72, fee 0.00%, fee 0.171%, day-of-week stratified).

**`treatment_short_gate_stocks` is a blanket ban wearing a three-way confirmation.** Of 43,904
aligned-bearish bars, ML ≥ 70 fires on 1.4%, 4H Stoch bearish on 11.5%, TRENDING on 32.0% — and
**all three together on 0.02%: seven bars in four years**, which averaged −0.2082R, worse than the
43,897 it blocked. The ban itself is right (blocked bars −0.1123R against a −0.0457R stock-SHORT
average — aligned-bearish shorts are 2.5× worse than stock shorts generally, 8/9 periods). The
escape hatch is inert and, per the Part 6 principle, makes a PREDICTION claim it has never once
demonstrated. **Simplified to the ban it measurably is.**

**`treatment_long_confirm_FAIL` does not earn its auto-FLAT.** 4/9 periods, +0.0007 global, and
**−0.0070 on the LONG bars it actually governs** — mildly inverted where it matters. Same class as
`biases_MIXED` and `alignment_not_full` on SHORT: a hard block with no measured benefit. **Removed.**
The PARTIAL cap is kept — it measures mildly positive (+0.0074, 6/9), it is a soft conviction cap
rather than a block, so the cost of being wrong is much lower, and nothing about it inverted.

Both LONG_CONFIRMATION numbers are noise-scale. The asymmetric action — drop the hard block, keep the
soft cap — reflects the asymmetric cost of being wrong, not a claim that either was measured.

### Where Part 8 leaves the count

**Of ~20 envelope conditions, 16 are now directly tested.** Three remain genuinely open
(`news_thesis_conflict` needs months of accumulation, `continuation < 3` needs the full signal list,
`data_stale` is not a market claim). And for the first time, a condition has been **positively
validated on its own stated mechanism** rather than merely surviving: the earnings gates guard a
gap that is 5-7× more likely inside their windows, in every period tested.

---

# PART 9 — `continuation`, the last testable condition (PRE-DECLARED)

Part 7 tested `continuation` on a proxy that was wrong (`momentumAlignment`), then reconstructed two
of its signals and recorded `< 3` as untestable because the reconstruction maxed at 2. Reading the
actual code closes it: **`envContinuationCount` counts exactly THREE signals**, all reconstructible.

| # | signal | reconstruction |
|---|---|---|
| 1 | `volume_confirming_up/down` | last three 4H candles all the same direction AND mean(last 3 vol) / mean(prior 20 vol) > 1.2 |
| 2 | `ema_stack_bullish/bearish_aligned` | 4H EMA20 > EMA50 > EMA200 (or the reverse) — features `hStackBull` / `hStackBear` |
| 3 | `funding_negative_supports_long` / `funding_positive_supports_short` | 4H bias + `fundingRatePercent` beyond ∓0.005 (raw ∓0.00005) |

All three key off the **4H** bias, so the count is direction-conditional by construction.

## A structural defect found by reading the list, no backtest required

Signal 3 requires `derivatives`, and `index.ts:492` is
`isCrypto ? fetchDerivativesEnrichment(...) : Promise.resolve(null)`. **For stocks `derivatives` is
always null, so the count can never exceed 2, so `continuation_N/3+_required` fires on 100% of stock
bars.** HIGH conviction has been structurally unreachable for every stock since the rule shipped —
reachable only through the narrow `transitioningHighOk` hatch (TRANSITIONING + ALIGNED_BULLISH +
ML ≥ 65), which is LONG-only.

This is the third unreachable-gate defect in this codebase (the 2026-08-22 calibration-ceiling
mandate, the `conformal_abstain` flag that was declared and never assigned). **The shared
fingerprint: a threshold compared against a quantity whose attainable RANGE was never checked.** A
fire rate of 0% or 100% is the tell, and it is cheap to assert.

## Declared before computing

Same harness, same primary metric (`d0.25_{side}_oppR`), same ship bar: **lift ≥ +0.02R, ≥ 6/9
half-year periods, kept coverage ≥ 20%.** Crypto and stocks reported separately, since only crypto
can reach a count of 3.

**Plus the Part 8 arithmetic correction, applied to this and retroactively to every sparse
condition.** Global lift is capped at `fire_rate × (kept − blocked)`, so for anything firing below
~20% the informative statistics are the **per-blocked-bar penalty** and its **period consistency**.
Both are reported for every arm. A condition that fails global lift purely on coverage arithmetic is
NOT recorded as noise — that was the error the earnings gates exposed.

**Retroactive re-examination:** `counter_move_volume_exceeds` (kill) fires on 1.2% of bars and Part 7
recorded it "noise, near-inert, kept". Under the corrected statistics its maximum achievable global
lift is ~0.012 × spread — far below the bar it was judged against. Re-tested here on the
per-blocked-bar penalty, which is the only statistic that can see it.

**Prediction stated in advance, so it cannot be fitted afterwards:** the three signals are momentum
persistence (volume), trend structure (EMA stack) and positioning (funding). Parts 1-7 found every
trend-alignment condition either inverted or noise, and Part 2 established the mechanism — goodR and
the barrier target are both ATR-normalised, so compressed/aligned tape is systematically WORSE. I
therefore expect `continuation` to be **inverted or noise on LONG**, and I am recording that before
looking. A pass would be evidence against the mechanism, not for the rule.

## PART 9 RESULTS — `continuation` is direction-dependent, and `< 3` never fired on a stock

### The structural defect, confirmed empirically

| market | P(count = 3) | `< 3` fire rate | `< 2` fire rate |
|---|---:|---:|---:|
| crypto | 0.87% | 99.1% | 77.5% |
| **stocks** | **0.0000%** | **100.0%** | 97.4% |

Exactly as the code predicted. **`continuation < 3` has fired on every stock bar ever evaluated** —
HIGH conviction was unreachable for the entire stock universe, and on crypto it leaves 0.87% of bars
tradeable, far under the declared 20% floor.

Signal fire rates (crypto / stocks): volume confirmation 5.0% / 4.1%, EMA stack 50.5% / 56.6%,
funding 34.3% / **0.0%**. Requiring all three of a 5%-frequency signal, a 50% signal and a
crypto-only signal was never going to clear.

### Crypto — the one cell that passes, and the one that inverts

| condition | side | fires | blocked | kept | lift | periods+ | verdict |
|---|---|---:|---:|---:|---:|---:|---|
| `< 3` | SHORT | 99.1% | +0.0613 | +0.1970 | +0.1345 | 7/9 | **FAILS coverage** — 0.87% kept |
| `< 3` | LONG | 99.1% | +0.0219 | −0.0771 | −0.0981 | 3/9 | **INVERTED** |
| `< 2` | SHORT | 77.5% | +0.0537 | +0.0927 | **+0.0303** | **6/9** | **EARNS IT** (22.5% kept) |
| `< 2` | LONG | 77.5% | +0.0293 | −0.0074 | −0.0284 | 3/9 | **INVERTED** |

The `< 3` SHORT lift is the largest number in this entire document and is **not** adopted: it rests
on 2,523 kept bars, 0.87% coverage, against a declared 20% floor. This is the same trap Part 3
caught — an ADOPT verdict carried by one thin slice — and the floor exists precisely to stop it.

**The pre-declared prediction was confirmed.** Part 9 stated in advance that `continuation` should
be *"inverted or noise on LONG"* because goodR and the barrier target are both ATR-normalised, so
trend-confirmed tape is systematically worse. LONG measured −0.0981 and −0.0284, inverted on both
thresholds, 3/9 on both. That is the fifth condition to behave this way, and the mechanism now has
predictive rather than merely explanatory standing.

### Stocks — both thresholds fail

`< 3` is degenerate (100%). `< 2` fires on 97.4%, leaving 2.56% coverage: SHORT +0.0139 at 3/9,
LONG +0.0190 at 7/9 — both under the bar, both far under the coverage floor. **Neither applies.**

### Actions

- **`continuation < 3` removed entirely** — degenerate on stocks, coverage-failing on crypto,
  inverted on LONG. Its removal makes HIGH conviction reachable on stocks for the first time.
- **`continuation < 2` scoped to crypto SHORT** — the only cell clearing all three pre-declared
  criteria. Same treatment as `alignment_not_full` (LONG-only) and for the same reason: one rule
  averaged across two sides was averaging a working gate with an inverted one.

**Honest caveat, recorded as it was for `alignment_not_full`:** the crypto SHORT pass sits in a
window where the equal-weight basket fell 83%, so "only short a confirmed downtrend" may be regime
rather than mechanism. It is kept because it passed a bar declared in advance, across 9 periods
spanning both directions of that regime — not because the mechanism is understood.

### Retroactive re-check of the sparse conditions — nothing re-opens

Part 9 committed to re-judging every Parts 1-7 condition on coverage-independent statistics. Result:

| condition | fires | penalty (SHORT) | pen+ | penalty (LONG) | pen+ | re-open? |
|---|---:|---:|---:|---:|---:|---|
| `counter_move_volume_exceeds` (kill) | 1.2% | +0.0051 | 4/9 | −0.0334 | 2/9 | no |
| `1H opposes daily` (downgrade) | 18.7% | +0.0148 | 6/9 | −0.0140 | 4/9 | no |
| `structureAlignment weak` | 82.4% | −0.0119 | 4/9 | +0.0151 | 6/9 | no |
| `crypto_bear_regime` (downgrade) | 41.0% | +0.0040 | 6/9 | +0.0059 | 4/9 | no |
| `funding_supports_counter` (REMOVED Part 7) | 29.2% | −0.0405 | 3/9 | +0.0450 | 6/9 | see below |

**`counter_move_volume_exceeds` survives the corrected statistics** — its penalty is small and
inconsistent on SHORT (4/9) and mildly NEGATIVE on LONG. Part 7's "inert, kept" verdict stands, now
on a statistic that could actually have overturned it.

**`funding_supports_counter` was flagged by my re-open rule and should not have been.** The rule
tested `penalty ≥ 0.02 AND consistent AND lift < 0.02` without also requiring the condition to be
SPARSE — and at 29.2% coverage the lift metric is perfectly capable of expressing its effect
(+0.0132, below the bar). The Part 8 correction rescues coverage-limited conditions; this one is not
coverage-limited, it is simply below the bar. It stays removed. Recorded because a re-open criterion
that fires on a non-sparse condition is a bug in the criterion, and a "finding" produced by it would
have been an artifact — the fifth near-miss of that shape in this document.


---

## CORRECTION (2026-08-25) — a reported entry-discipline violation that never happened

Two live BTC analyses were read as proposing entries at **0.99 ATR and 0.96 ATR**, twice the
measured 0.2-0.5 band, and a fix was shipped on that basis. **The diagnosis was wrong.** Verified
with `promptOnly` against the deployed build:

| quantity | value (2026-08-25) |
|---|---:|
| daily ATR | $2,248.35 |
| **4H ATR** — the unit Parts 4-5 measured in (`atrPercent`) | **$1,282.43** |
| **1H ATR** — the unit TAGGED LEVELS and CANDIDATE SETUPS use (`atrForRR`) | **$669.40** |

The analysis quoted a pullback zone of $77,958-$78,343 against a live price of $78,599.64. On the 4H
ATR that is **exactly 0.500 and 0.200** — the band's boundaries to three decimals. **The model was
in perfect compliance.** I had inferred the ATR from the level-proximity figures ("$78,266.50 ... at
0.5 ATR"), which are stated in 1H ATR, and the ~1.9x unit error turned 0.50 into 0.99.

**What was actually wrong is the collision itself**: one prompt using three different quantities all
called "ATR", unlabelled, where a reader — human or model — is expected to compare a level against a
band expressed in a different one. That is now fixed by naming the units (`x 1H-ATR from live`) and
by an explicit instruction never to convert between them, only to compare prices against prices.

**The lesson, which is the reason this is recorded rather than quietly amended:** I checked the
model's output against a number I had *derived from the output itself* instead of from the input.
`promptOnly` returns the exact prompt for free in ~5 seconds and would have settled it before any
code changed. The 2026-08-22j entry already recorded that lesson for a different question, and I did
not apply it here. **Read the input before diagnosing the output.**

The `SHALLOW PULLBACK BAND` line shipped alongside the bad diagnosis is kept: it removes an ATR→price
conversion the model would otherwise do in its head, and the post-deploy analysis quotes the band's
bounds exactly. It is a good change that was justified by a wrong reason.

## Open, NOT asserted — the app's stop is not the researched stop

Found while checking the above, recorded so it is not lost. The Parts 4-5 measurement used a
mechanical **2.0 x 4H-ATR** stop. The app places stops at a **structural swing ± 0.3-0.5 x 1H-ATR**
buffer (`prompt.ts` candidate setups). On the 2026-08-25 tape that was a risk of $1,559 against a
researched $2,565 — about **61%** of the measured stop distance, with the same targets.

A tighter stop with unchanged targets changes both the R multiple and the noise-hit probability, so
the shipped geometry may not inherit the measured entry edge cleanly. This needs a pre-declared test
(re-run the Part 4 arms at the app's actual stop construction), not an assertion — and certainly not
a change to a stop rule on the strength of one screenshot.

---

# PART 10 — the chase guard vs the app's own entry rule, and the stop it actually ships (PRE-DECLARED)

Two questions raised by a live BTC analysis on 2026-08-25, neither answerable from a screenshot.

## Q1 — does the chase guard earn its auto-FLAT under a PULLBACK entry?

Part 1 dismissed `chase_into_extended_aligned_trend` as a bar filter. Part 4 **rehabilitated** it on
the grounds that it defends the CHASING arm, which measured −0.129R (short) / −0.195R (long), 0/9
periods — the worst outcome in the whole study.

But the app **never chases**: `ENTRY DISCIPLINE` (shipped 2026-08-25b) forbids a market entry
outright and requires a 0.2-0.5 ATR pullback. A pullback entry into an extended trend is the
OPPOSITE of a chase. So the guard may now be defending against something the app already cannot do,
while blocking the entry that Parts 4-5 measured as the single most valuable decision in the system.

**The cost of being wrong is concrete and visible.** On a chase-FLAT the analysis computes the
measured pullback band, tells the user to wait for it, and then emits `[]` — and `index.ts:3443`
monitors only `kind='setup' AND state='pending'`, so a FLAT row is never watched. The app names a
price 0.33% away and has no mechanism to say when it arrives.

**The decisive comparison is the guard's lift under MARKET entry versus under PULLBACK entry**, on
the same bars. If it helps at market and not at pullback, it is redundant with the entry rule.

### Reconstruction, and its two declared gaps

`chaseLevel` is transcribed from `prompt.ts`:

```
chaseScore = (stretch>=2) + rsiHot + stochHot + intoLevel + (exhaustionCount>=1)
coreChase  = stretch>=2 || exhaustionCount>=2
HIGH       = coreChase && chaseScore>=3
```

| component | reconstructed from | status |
|---|---|---|
| `stretch` = \|price − EMA200\| / daily ATR | daily bars aggregated from the hourly klines | exact |
| `rsiHot` (dRsi≥70 or hRsi≥72; inverted for bearish) | `dRsi`, `hRsi` | exact |
| `stochHot` (dStochK≥85 or hStochK≥85; inverted) | `dStochK`, `hStochK` | exact |
| exhaustion: RSI divergence | `dDivergence` / `hDivergence` | exact |
| exhaustion: volume diverging | 4H candles (3 same-direction bars, vol ratio < 0.8) | exact |
| exhaustion: rejection wick | 4H candles (wick > 2× body) | exact |
| exhaustion: crowded positioning | `crowdingSignal` | exact |
| **`intoLevel`** (a level within 0.6× 4H ATR in the chase direction) | — | **MISSING** — no S/R in the feature set |
| **exhaustion: CVD divergence** | — | **MISSING** — no spot-pressure in the feature set |

Both gaps can only LOWER `chaseScore`, so the reconstruction fires **less often** than the real
guard and classifies a strict subset as HIGH. That is a conservative bias and it is declared here
rather than discovered later. A robustness arm uses the unambiguous `stretch >= 2` alone.

## Q2 — does the entry edge survive the stop the app actually uses?

Parts 4-5 measured at a mechanical **2.0 × 4H-ATR** stop. The app places stops at a structural swing
± 0.3-0.5 × **1H**-ATR: on the 2026-08-25 tape, a risk of $1,559 against the researched $2,565 —
about **61%**, roughly **1.22 × 4H-ATR**. A tighter stop with unchanged target distance changes both
the R multiple and the noise-hit probability, and fees rise in R terms as the stop tightens.

Sweep the stop over {1.0, 1.25, 1.5, 2.0, 2.5, 3.0} × 4H ATR with TP2 held at a fixed **2.5 ATR**
absolute distance, and re-measure market vs pullback at each.

## Declared before computing

**Primary metric** is unchanged: R per OPPORTUNITY, unfilled scoring exactly 0.

**Q1 bar:** the guard earns its auto-FLAT if, *under the 0.25 ATR pullback entry*, blocking chase-HIGH
bars lifts the mean by ≥ **+0.02R** with ≥ **6/9** periods positive and ≥ **20%** coverage retained.
Per-blocked-bar penalty and its period consistency are reported alongside, per the Part 8 correction,
so a sparse guard is not dismissed on coverage arithmetic.

**Q2 bar:** the entry edge survives if `oppR(pullback) − oppR(market)` is ≥ **+0.02R** with ≥ **6/9**
periods positive at a **1.25 ATR** stop.

**Stated explicitly, because it is the finding most likely to matter:** a surviving RELATIVE gain is
NOT sufficient. The absolute `oppR` of the pullback arm is reported at every stop, and if it is
negative at the app's geometry then the entry rule is real while the trade as shipped is
unprofitable — a different and more serious result than either question asks on its own.

**Predictions recorded in advance, so neither can be fitted afterwards:**
1. The chase guard **helps under MARKET entry and not under PULLBACK entry** — i.e. it is redundant
   with `ENTRY DISCIPLINE`. If it helps under BOTH, it stays and Q1 is closed in its favour.
2. The pullback-minus-market gain **shrinks as the stop tightens**, because a tighter stop converts
   the pullback's better fill price into a smaller edge while fees grow in R terms.

## PART 10 RESULTS — the chase guard is noise, and the app's tighter stop makes entry discipline MORE valuable

274,079 opportunities, 24 symbols, 2020-07 → 2026-06. Chase HIGH fires on **27.2%** of bars in the
conservative reconstruction (the real guard fires more, since `intoLevel` and CVD are missing).

### Q1 — the chase guard earns nothing, at EITHER entry style

| gate | entry | side | blocked | kept | lift | periods+ | verdict |
|---|---|---|---:|---:|---:|---:|---|
| chase HIGH | MARKET | SHORT | +0.0037 | +0.0017 | −0.0005 | 4/9 | noise |
| chase HIGH | MARKET | LONG | −0.0833 | −0.0754 | +0.0022 | 5/9 | noise |
| chase HIGH | **PULLBACK** | SHORT | +0.0730 | +0.0667 | −0.0017 | 3/9 | noise |
| chase HIGH | **PULLBACK** | LONG | +0.0178 | +0.0160 | −0.0005 | 4/9 | noise |
| stretch≥2 | PULLBACK | SHORT | +0.0654 | +0.0761 | +0.0077 | 6/9 | noise |
| stretch≥2 | PULLBACK | LONG | +0.0191 | +0.0098 | **−0.0067** | 3/9 | **INVERTED** |

**Prediction 1 was half right.** I predicted the guard would help at MARKET and not at PULLBACK. It
helps at NEITHER — the largest lift anywhere in the faithful arm is +0.0022R at 5/9. As a bar filter
it does nothing, on either side, at either entry.

That does not contradict Part 4, it narrows it. Part 4 rehabilitated the guard because chase-HIGH
bars punish the **CHASING** arm (entering 0.25 ATR the WRONG way, −0.129R/−0.195R at 0/9). That
remains true — and it is now **moot**, because `ENTRY DISCIPLINE` forbids the app from chasing at
all. The guard defends against a move the app can no longer make, while blocking 27% of bars from
producing the entry that is the best action in the system.

By the Part 6 principle the guard makes a PREDICTION claim — that entering after an extended move is
worse — and a prediction claim must be earned. It measured noise across four cells.

### Q2 — the edge does not merely survive the tighter stop, it GROWS. Prediction 2 was WRONG.

TP2 held at a fixed 2.5 ATR; fees scale with the stop.

| stop (×4H ATR) | R at TP2 | SHORT mkt | SHORT pullback | gain | LONG mkt | LONG pullback | gain |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1.00 | 2.50 | −0.0626 | +0.1177 | **+0.1803** | −0.2074 | +0.0187 | **+0.2261** |
| **1.25** (≈ the app) | 2.00 | −0.0247 | **+0.1029** | **+0.1276** | −0.1515 | **+0.0194** | **+0.1710** |
| 2.00 (researched) | 1.25 | +0.0023 | +0.0684 | +0.0661 | −0.0775 | +0.0165 | +0.0940 |
| 3.00 | 0.83 | −0.0011 | +0.0400 | +0.0411 | −0.0490 | +0.0102 | +0.0591 |

**9 of 9 periods at every single stop, both sides.**

I predicted the gain would shrink as the stop tightened. It roughly **triples** going from 3.0 to
1.0 ATR. The mechanism is obvious in hindsight and worth stating: entering 0.25 ATR better is 12.5%
of the risk distance at a 2.0 ATR stop but **20% at 1.25** — so the tighter the stop, the more the
entry price is worth. The pullback arm barely moves (+0.0165 → +0.0194 on LONG) while the market arm
collapses (−0.0775 → −0.1515).

**The absolute level answers the question the pre-declaration flagged as most serious:** at the app's
~1.25 ATR geometry the pullback arm is **positive on both sides** (+0.1029 / +0.0194), so the shipped
trade is not merely relatively better, it is profitable. **A market entry at that stop is −0.15R on
LONG** — the app's tighter stop makes "never enter at market" considerably more important than Parts
4-5 implied, not less.

### Action

**`chase_into_extended_aligned_trend` removed from the auto-FLAT list.** It measured noise in every
cell, its robust arm inverted on LONG, and the thing it protects against is already forbidden.

**It stays as CONTEXT** — the loud `CHASE / EXHAUSTION RISK` line, the "prefer a pullback entry"
directive and the Risk Map instruction are untouched. Same treatment as divergence in Part 6: the
reading survives, the gate does not.

**The product consequence is the point.** A chase-HIGH bar can now produce a CONDITIONAL setup at the
measured pullback band instead of `[]`. That setup registers in `tracked_setups`, the cron monitors
it, and the entry-zone push fires when price actually arrives — closing the gap where the app named a
price 0.33% away and had no way to tell the user it got there.

---

# PART 11 — how the ML gate should be PARAMETERIZED (PRE-DECLARED)

The live PAV calibration is self-updating and correct; nothing needs re-fitting. What broke is that
recalibrating moved the SCALE while the cutoffs built on it stayed fixed, so the gates silently
changed meaning. Measured on the 2026-08-25 curve (9,490 graded samples, live base rate **58.3%**
against v14's **50.5%** training base):

| gate | needs raw | fires on |
|---|---:|---:|
| ML auto-FLAT (calibrated < 50) | < 30.3% | **8.0%** of bars |
| FAVORABLE (calibrated ≥ 60) | ≥ 44.1% | **66.0%** of bars |
| notify (calibrated ≥ 65) | ≥ 62.5% | 23.7% |

The floor was meant to block dead tape at raw < 50 — 45% of bars — and now fires on 8%. **A ~5×
loosening that nobody decided.** "FAVORABLE" now describes two thirds of all bars.

## The question is not which numbers — it is which PARAMETERIZATION

Two candidates, and they differ exactly when the base rate moves:

- **ABSOLUTE** — `gate = calibrated_ML >= t`. Correct if the trade decision depends on the true
  probability of the event, since EV at fixed ATR-normalised geometry depends on the probability
  itself, not on how it ranks against other bars.
- **COVERAGE / QUANTILE** — `gate = ML in the top q of the recent distribution`. Correct if what was
  validated was a level of SELECTIVITY. Part 1's finding — the ML component alone beating the full
  envelope fourfold — was measured at **26% exposure**, an exposure level, not a probability.

Both arguments are real. Rather than choose by argument, choose by **which one generalizes**.

## Design — walk-forward parameter selection, the decisive test

For each half-year period from the 4th onward: fit the parameter on **all earlier periods only**,
apply it to the held-out period, record realized R per opportunity. Repeat for both
parameterizations on identical bars.

- **Arm A (absolute):** pick the threshold `t` maximising oppR on the training periods; apply that
  same `t` to the test period.
- **Arm B (coverage):** pick the coverage `q` maximising oppR on the training periods; apply that
  same `q` to the test period, re-deriving the threshold from the TEST period's own ML distribution.
  This is what makes it self-adjusting.
- **Control 1 — no gate:** trade every bar.
- **Control 2 — the shipped gate**, at its current effective coverage.

**Decision rule, declared now:** adopt the parameterization with the higher out-of-sample mean oppR
across held-out periods AND the higher count of periods where it beats no-gate. If they split, or if
the difference is under **+0.01R**, keep ABSOLUTE — it is the incumbent and the simpler object, and
a tie is not a reason to add machinery.

**Reported regardless, because it may matter more than the winner:** the spread of the per-period
optimum for each parameterization. A parameter whose best value swings wildly between periods is not
a parameter, it is noise being fitted, and that would argue against gating on ML at all beyond the
crude floor.

**Geometry is the app's:** 0.25 ATR pullback entry, unfilled scoring 0, stop **1.25 ATR** (the
shipped geometry per Part 10) with 2.0 ATR as a robustness arm, fees scaling with the stop.

**A structural argument recorded in advance so it is not mistaken for a result:** a coverage gate is
scale-invariant and therefore transfers from backtest to live without a scale-matching step, while
an absolute threshold learned on the training scale (base 50.5%) cannot be applied to live-calibrated
values (base 58.3%) without exactly the correction that is at issue here. That is an argument for
coverage, but it is an argument, not evidence, and the walk-forward test above is what decides.

**Prediction recorded before running:** coverage wins, because the base rate demonstrably moves and
an absolute threshold cannot track it. If ABSOLUTE wins instead, that is evidence the probability —
not the ranking — is what carries the edge, and the gates should simply be restated once against the
current base and left alone.

## PART 11 RESULTS — fitting the gate destroys it; a FIXED gate works, on SHORT only

### The declared arms both lose to no gate

Walk-forward parameter selection, fit on earlier periods only:

| stop 1.25 (the app) | absolute | coverage | **no gate** | periods beating no-gate |
|---|---:|---:|---:|---|
| SHORT | −0.0062 | +0.0027 | **+0.0711** | absolute 1/5, coverage 1/5 |
| LONG | +0.0217 | +0.0382 | **+0.0432** | absolute 0/5, coverage 0/5 |

**No gate wins every cell.** The declared rule ("if they split or the gap is under +0.01R, keep
ABSOLUTE") technically returns ABSOLUTE, but that is choosing between two losers and is not
actionable. The cause is visible in the selection: argmax on training data picked thresholds
admitting **0.2-4.5%** of bars, one of which returned **−0.5342R** on its held-out period, and the
coverage arm repeatedly converged on **q = 1.00** — the optimizer choosing "no gate" itself.

That is a property of FITTING, not of gating. Which is why Control 2 was declared.

### Control 2 — a fixed, never-fitted gate, and it changes the answer

| gate | coverage | SHORT oppR | vs no gate | periods+ | LONG vs no gate | periods+ |
|---|---:|---:|---:|---:|---:|---:|
| ML ≥ 0.40 | 71.6% | +0.1107 | +0.0079 | 6/8 | −0.0084 | 1/8 |
| ML ≥ 0.50 | 52.0% | +0.1205 | +0.0177 | 7/8 | −0.0175 | 2/8 |
| **ML ≥ 0.55** | **41.3%** | **+0.1285** | **+0.0257** | **7/8** | −0.0247 | 2/8 |
| ML ≥ 0.60 | 30.4% | +0.1149 | +0.0121 | 4/8 | −0.0231 | 3/8 |
| ML ≥ 0.65 | 20.1% | +0.0984 | **−0.0044** | 3/8 | −0.0213 | 4/8 |
| ML ≥ 0.70 | 11.1% | +0.0844 | **−0.0183** | 3/8 | +0.0002 | 5/8 |

(no gate: SHORT +0.1028, LONG +0.0139. Stop 2.0 reproduces the same shape.)

**SHORT at ML ≥ 0.55 clears the standing bar** — +0.0257R, 7/8 periods, 41.3% coverage. It is the
first ML gate configuration in this vault to do so against a no-gate control rather than against the
envelope.

**LONG fails at every threshold.** Every sensible cut is negative against no gate; only 0.70 reaches
+0.0002 at 5/8, which is nothing. The ML gate is **direction-dependent**, the sixth envelope
condition with that signature.

**Thresholds above 0.60 are WORSE than no gate on SHORT.** The notify threshold at calibrated 65
sits past the point where the gate stops helping.

### The parameterization question, answered by the transfer

The prediction was that coverage wins, and it does — not through the fitted arms, but concretely:

> ML ≥ 0.55 admits **41.3%** of backtest bars. On the live distribution the same absolute 0.55
> admits only **36.3%**. Reproducing the *measured selectivity* on live data needs **raw ≥ 47.9%**.

An absolute threshold carried across the base-rate shift (50.5% → 58.3%) silently tightens by ~5
percentage points of coverage. A coverage gate transfers exactly. This is the same failure that
loosened the ML floor 5× in the first place, running the other way.

### Shipped

- **The ML gate is scoped to SHORT** and set at the measured **41% selectivity**, derived from the
  live `ml_calibration` distribution rather than from a fixed number, so it cannot drift again.
- **LONG keeps its existing loose floor.** The accidental loosening to ~8% turns out to be roughly
  correct for LONG, where no threshold helps — an accident that landed on the right answer, kept
  deliberately now that it has been measured.

**Regime caveat, recorded as it was for `alignment_not_full` and `continuation`:** this window is a
crypto bear (equal-weight basket −83%), and SHORT is the better side ungated (+0.1028 vs +0.0139).
7/8 period consistency spanning both directions of that regime is strong evidence, but the mechanism
may be regime rather than skill, and it is kept because it passed a bar declared in advance.

## PART 11 RETRACTED (same day) — the shipped gate did not follow from the measurement

A max-effort review of `83e56a5` returned 15 findings. Three are disqualifying, and I verified each
myself before acting rather than taking the report on trust. **The code is reverted. The
measurements below stand; the implementation built on them did not follow from them.**

### 1. The measurement was UNCONDITIONAL; the implementation was CONDITIONAL

Control 2 gates every bar and reads the SHORT payoff column — `m = w & (d.ml >= t)`, no bias filter
anywhere in `ml_gate_param.py`. So "41.3% coverage" is 41.3% **of all bars**. Production applied the
cut only where `alignedDirection === 'SHORT'`, a subpopulation whose ML runs materially lower — the
reviewer measured the realised selectivity at **~24%**, which lands inside the band this very
document declares *worse than no gate* (ML ≥ 0.65, 20.1% coverage, −0.0044R at 3/8).

**I measured one thing and shipped another.**

### 2. The transfer argument was a cross-model artifact, and my stated mechanism was backwards

I justified shipping COVERAGE rather than an absolute threshold on this: `0.55` admits 41.3% of
backtest bars but only 36.3% of live ones, therefore the base rate moved and coverage transfers
where a number does not.

`ml_gate_param.py:90` fits a **local LightGBM**. Production's `predicted_prob` is **shipped v14 with
its embedded isotonic** (floor 0.2498, cap 0.85). Two different models with different output
distributions — the 41.3 vs 36.3 gap says nothing about base rates. And the mechanism as stated is
backwards on its own terms: **a higher base rate pushes predictions UP, admitting MORE above 0.55,
not fewer.** Coverage selection is invariant under monotone rescaling only if the two models RANK
identically, which was never tested.

The coverage form rested entirely on this argument, so the shipped artifact was **never the tested
artifact** — Control 2 swept fixed ABSOLUTE thresholds, and the pre-declared decision rule had
returned ABSOLUTE.

### 3. It blocked LONG on the bars that measure as the best LONG bars

The gate was scoped to `alignedDirection === 'SHORT'` but pushed to `autoFlat`, which emits
**"Output NO SETUP regardless of any other reasoning"** — killing any counter-trend LONG on a
daily-bearish bar. On the commit's own dataset those blocked bars average **+0.0725R on LONG against
a +0.0107R all-bar mean, 6/8 periods**.

That is the block-the-best-bars signature used four days earlier to kill `biases_MIXED` (+0.0503R
blocked vs +0.0197R kept) and SHORT-side `alignment_not_full`. **I shipped the exact defect this
document was written to eliminate.** It also re-FLATs the counter-trend reversal playbook that
2026-07-06 deliberately unblocked.

### Also real, and each independently sufficient to hold the ship

- **The three-verdict contradiction, re-created one commit after fixing it.** The new auto-FLAT keys
  on the RAW scale, so at raw 44 / calibrated 60 the prompt emits `NOT auto-FLAT on ML alone`, then
  `auto_FLAT_active: ML_SHORT_selectivity_raw_44%`, then `POSITION SIZING: 0.5x base risk` — sizing a
  trade the envelope just forbade. Verbatim the failure `4c3ece8` was written to eliminate.
- **The FRAMING hatch dies silently.** `isQualityGateReason` prefix-matches only `ML_WIN_` /
  `biases_MIXED_and_ML_`, so `ML_SHORT_selectivity_…` classifies as a HAZARD and suppresses the
  hatch — including on bars that previously earned it from an `ML_WIN_*` reason alone. The 2026-07-24
  "week of silence through a +7.5% advance" failure, reintroduced.
- **The notify precheck never saw the gate.** `calForPrecheck` returns only `{ calibratedMlWin }`, so
  the precheck builds a prompt where this FLAT cannot appear — destroying the "zero drift with the
  actual analysis by construction" property that is the precheck's entire justification, and paging
  the user into auto-FLAT analyses that then burn a Sonnet-5 run.
- **No `isCryptoSym` guard.** Measured on 24 crypto symbols, shipped active for 159 stocks whose
  `ml_calibration` rows are so thin that `fitCalibrationCurve` returns null while `coverageCut` still
  returns a cut — the gate most active exactly where the calibration layer declares the data
  untrustworthy. Part 9 records what happened last time a crypto-measured rule reached stocks.
- **`coverageCut` skipped the trust filters** `fitCalibrationCurve` applies to the same array, so one
  D1 result set got two opposite verdicts and the permissive one blocked trades. A non-finite
  `predMean` returned NaN, which passes a `!= null` check and silently disables the gate.
- **Provenance error in the shipped comment:** it cites "274,079 opportunities", which is Part 10's
  figure. `ml_gate_rows.pkl.gz` holds **191,935 rows** — the comment overstates its evidence base by
  ~43%. The script's folds also silently differ from `envelope_test.py` (`range(6)` @ 0.30/0.10 vs
  `range(4)` @ 0.35/0.15) while commented "same recipe", so Part 11's ML column is not the one Parts
  1-10 were measured against.

### What survives

The Control 2 table is a real measurement and is retained above: **a fixed absolute ML ≥ 0.55,
applied to all bars, beats no-gate on the SHORT payoff by +0.0257R at 7/8 periods.** That is worth
re-testing properly. What does not survive is every step between that number and the code:
the conditioning, the parameterization, the gate class, and the market scope.

**The lesson, which is the reason this is a retraction rather than a patch:** I answered "which
parameterization?" and then shipped an artifact that no arm of the test had evaluated, on a
subpopulation no arm had measured, using a gate class (`autoFlat`) whose blast radius I did not
check. Fifteen findings is not a set of patches — it is a change that was not ready, and the six
prior parts of this document exist precisely to stop rules like it from shipping.

---

# PARTS 4-5 RETRACTED — entry discipline was a 4-hour lookahead

A second max-effort review attacked the MEASUREMENT code rather than the shipped code. Six findings;
**five confirmed by re-running, and one of them invalidates the headline finding of this entire
document.**

## The defect

`level_entry.py` starts its fill window at `base + 1` where `base` is the hourly bar opening at the
feature row's timestamp T. But the feature row's `price` is the **CLOSE of the bar spanning
T..T+4h** — verified by nearest-match against the hourly klines, where offset **+3** fits at
4.6e-04 relative error against 2.4e-03 for the next best. So the row is evaluated at T+4h while the
simulation began filling at T+1h: **a pullback that had already happened inside the signal bar
counted as a fill.**

## Re-run on the same 290,791 opportunities, one offset changed

| | market | pullback | gain | fill | periods+ |
|---|---:|---:|---:|---:|---:|
| **as shipped** SHORT | −0.0036 | +0.0624 | **+0.0660** | 88.3% | **9/9** |
| **corrected** SHORT | −0.0001 | −0.0297 | **−0.0296** | 76.5% | **0/9** |
| **as shipped** LONG | −0.0709 | +0.0210 | **+0.0919** | 92.2% | **9/9** |
| **corrected** LONG | −0.0670 | −0.0661 | **+0.0009** | 79.6% | 7/9 |

**It fully inverts on SHORT (9/9 → 0/9) and vanishes on LONG.** The fill rate drop (88% → 76%) is
the leak's fingerprint: a tenth of all "fills" were prices the strategy could not have traded.

## Everything that rested on it

- The `ENTRY DISCIPLINE` block in **both** markets' `prompt-system.json` — **removed**, replaced by
  an explicit retraction that forbids the model citing the withdrawn numbers.
- The computed `SHALLOW PULLBACK BAND` — **removed**; it enforced a rule that measures negative.
- **Part 10's chase-guard removal**, argued partly as "ENTRY DISCIPLINE forbids chasing, so the
  guard is moot". That premise is gone → **UNSUPPORTED**.
- **Part 8's stock replication** (+0.046 / +0.025) — same script, same bug → **UNSUPPORTED**.
- Every "40-60× the gating layer" and "the only finding that replicates across markets" claim.

## The other four confirmed defects, each of which drove a live change

| script | defect | what it drove |
|---|---|---|
| `chase_stop_test.py:55` | `searchsorted(...)-1` selects the day CONTAINING t — **83.3% of bars read their own in-progress day** (0% at 00:00, 100% at every other 4H boundary) | Part 10 removing `chase_into_extended_aligned_trend` |
| `envelope_sweep.py:25` | `funding_supports_counter` reconstructed as `sign(funding) == −bias`; the live rule (`prompt.ts:868`) is `sign(funding) == sign(bias)` — the **exact complement, disjoint sets** — and the magnitude threshold was dropped | Part 7 deleting `killFunding` from `ANY_KILLED` |
| `envelope_whole.py:53` | `cont = \|momentumAlignment\|` ∈ {0,1}, so `<2` and `<3` fire on **100.0000%** of rows; arms B/C collapse to {LOW, FLAT} | **Part 2's "envelope NOT VERIFIED"** — the verdict that motivated Parts 6-10 and deleted `OpportunityFeedCard.swift` |
| `level_entry_controls.py:24` | the "CHASE" arm sets entry ABOVE price but keeps the pullback fill test `low <= entry`, so it fills instantly — a market entry charged 0.25 ATR of forced slippage, not a chase | the `−0.129R / −0.195R` numbers shipped in both prompts |

**Part 7 had already recorded that `momentumAlignment` is the wrong variable** ("PROXY BROKEN — not
tested", with the note that a 100% fire rate is the tell). That correction was never propagated back
to Part 2, whose verdict the rest of the programme was built on.

## Fixed now

Only one thing was both certain and shipped-and-false: the ML Persistence ladder hardcoded a **54%**
base — the crypto figure — in a block with no market gate, while a stock h72t25 model ships.
Measured: **54.1% crypto, 60.8% stocks**. A stock reading of 60-69% printed "ABOVE AVERAGE" while
sitting at or below its real base, telling the model to hold longer on a sub-par bar. Now derived
per market.

## What is NOT being done, and why

**The gate removals are not reverted.** They are *unsupported*, not *proven wrong* — and re-adding
gates whose own evidence is equally broken would not be an improvement, it would be a second
unvalidated change. Each needs re-running against a corrected harness.

## The lesson

Five defects, all in measurement code, all of which reached production. Not one was caught by the
test suite, because **the worker tests are source-text regexes over `prompt.ts` and the research
scripts have no parity harness at all** — the ML pipeline has one asserting worker↔backtest agreement
at 1e-7, and the research layer that decides what ships has nothing equivalent. Every defect here was
found by re-running a script or diffing a reconstruction against `prompt.ts` by hand. Both are cheap.
Neither was automated.

**The concrete rule this earns:** any reconstruction of a live rule must be asserted against the live
rule on shared inputs before its result is used — and any simulation that indexes price paths from a
feature timestamp must state, and test, which bar that timestamp denotes.

## CORRECTION TO THE RETRACTION (2026-08-26) — my fix was wrong too, and the finding half-survives

An adversarial design review caught the retraction making the same class of error it was written to
fix. **`close[base+3]` and `open[base+4]` are the same instant** — verified at **2.79e-07** relative
difference. The first legitimately-future bar is `base+4`, and its OPEN is the entry price, so the
scan must run `base+4 + arange(0, H)` — **offsets from zero**. My re-run used `arange(1, …)`, which
starts an hour late and discards the highest-hazard bar of every trade.

Re-measured properly on the same 290,791 opportunities:

| | as shipped (leaky) | my retraction (an hour late) | **true** |
|---|---:|---:|---:|
| SHORT gain | +0.0660 (9/9) | −0.0296 (0/9) | **−0.0123 (2/9)** |
| LONG gain | +0.0919 (9/9) | +0.0009 (7/9) | **+0.0216 (8/9)** |
| SHORT fill / LONG fill | 88.3% / 92.2% | 76.5% / 79.6% | **78.3% / 82.2%** |

**So entry discipline is direction-dependent, like almost every other condition here.** On SHORT it
inverts. On LONG it survives at +0.0216R across 8 of 9 periods, which clears the standing bar.

**Two caveats that stop this being a finding yet.** Both LONG arms are NEGATIVE in absolute terms
(market −0.0675R, pullback −0.0459R) — a pullback makes a losing proposition less bad, it does not
make it good. And the 8/9 period count is computed on non-independent samples: the hold is 72h at 4h
spacing, so each outcome is shared across ~18 consecutive rows. No `eff_n`, no block bootstrap.

**Nothing is shipped from this.** The prompt says explicitly that no entry-method rule is in force
and that the surviving LONG number is being re-measured under a verified harness.

**The lesson, and the reason the plan changed shape because of it:** this number has now been
hand-computed three times, in three throwaway scripts, producing three different answers — +0.0919,
+0.0009, +0.0216. Each was reported with confidence. The defect is not any one of the three
calculations; it is that a load-bearing number was computed in a heredoc at all. **The shared payoff
module is the fix, and no further one-off simulation may be used to justify a production change.**

### Also corrected in the same pass

- **`prompt.ts:1390`** emitted the reason string `aligned_bearish_stock_SHORT_measured_-0.11R` into
  live prompt text. That −0.11R came from `stock_gates.py` scoring the retracted column. **The number
  is withdrawn**; the gate stands for now on an anchor-independent fact — the escape hatch it
  replaced fired on 7 bars in four years — and is re-tested in Phase 3.
- **The earnings 0-2d line** claimed "43% of stops fill BEYOND the stop, averaging 1.4R lost".
  That came from `stock_gap_fill.py` on the same anchor and is **removed**. The gap RATES survive the
  retraction — they compare gap frequency near vs far from earnings, which a few bars of window shift
  does not move — and are re-run in Phase 2 regardless.
- **The image build had no test gate.** `.github/workflows/build-box-image.yml` checked out, built and
  pushed to `:latest` with no test step; the 758-test suite only ever ran on a developer machine by
  choice. `CLAUDE.md` documents a `predeploy` hook, but that belongs to `wrangler deploy`, which this
  box does not use. **This was the channel through which every broken prompt reached production.** A
  `test` job now gates `build-and-push` via `needs:`.

---

# THE RECONSTRUCTIONS, MEASURED — 2026-08-26 (plan steps 1.8-1.10)

Everything above measured the Conviction Envelope by **rebuilding its rules in Python** from the v14
feature columns. Two reviews found five defects in that rebuild, each of which had already driven a
live change. The repair was not to test the rebuild harder — it was to stop having a second
implementation.

`marketscope-worker/src/envelope.ts` now holds the rules as `evaluateEnvelope()`, `buildUserPrompt`
returns its verdict, and `scripts/exportEnvelope.ts` replays the real builder bar by bar into
`ml-training/envelope_exports/`. Research reads that by **joining on (symbol, timestamp)**.

## Why the verdict had to be returned rather than parsed

`buildUserPrompt` renders `HIGH_blocked_because` / `MODERATE_blocked_because` /
`downgrade_one_tier_if_LLM_decides` only in the `else` branch of `if (autoFlat.length)`. On a FLAT
bar all three are computed and discarded. Measured on the real BTC tape at ML 0.30: **66 of 139 bars
FLAT, and the block lists were invisible on 66 of 66 of them.** FLAT bars are both the majority and
the ones a gate study is about, so a replay that reads the rendered prose is blind exactly where it
needs to see.

## The join gate, and the data defect it found

The export refuses to write unless its bars agree with `csv_exports_v14` on **price and three
slice-sensitive columns** — `dRsi` (daily slice), `hRsi` (4H slice), `atrPercentile` (daily
population). Price alone is not enough: it is read off the bar, so an `i-300..i` mutation passed a
price-only check silently. Mutation-tested — three deliberate slice errors, three catches, each by a
different column, including **restoring the in-progress-day leak** (the 2026-06-02 defect behind the
retracted 94% direction claim), which shows up as a 0.15 dRsi difference and is now a standing test.

It immediately found that the local box snapshot carries **mid-bar cron writes**. ADAUSDT's 4H bar at
2026-04-14 00:00 is stored closing 0.2461 on 5.9M volume where the settled bar closed 0.2447 — and
that settled close appears as the NEXT bar's open. Handled as a longest-agreeing-prefix with the
divergence recorded per symbol: **75 symbols, 799,193 rows, 97.0% kept, 137 isolated blips (0.017%),
73 symbols tail-truncated (mostly April 2026).**

> **Consequence for the frozen holdout.** The holdout is the last six months — precisely the span
> this archive cannot reproduce. **It must be built from Binance Vision, not from this snapshot.**

## Funding is not optional dressing

The first export ran without derivatives and returned an ADAUSDT `continuationCount` that could never
reach 3 — the exact structural degeneracy Part 9 found on stocks, on a crypto symbol, for the same
reason: the third continuation signal is funding support (`prompt.ts:1038`). With funding taken from
the v14 row itself:

| count | 0 | 1 | 2 | 3 |
|---|---:|---:|---:|---:|
| share | 26.7% | 50.0% | 22.4% | **0.86%** |

P(count = 3) = 0.86% against the **0.87%** Part 9 reported, and `continuation < 2` fires on 76.7%
against its **77.5%**. Part 9's continuation figures were a CODE reading rather than a simulation,
and they replicate — worth recording, since most of what this programme re-checked did not.

Blast radius, measured: funding moves `continuationCount` on 29.1% of rows, `moderateBlocks` on
10.4%, and **`max_allowed` on 8.7%**. An envelope study run without derivatives is not approximately
right; it is wrong on about one bar in eleven.

*(Unit trap, avoided by checking: `fundingRateRaw` is ALREADY IN PERCENT — `scripts/derivatives.ts:20`
documents it as "% (already × 100)". The name invites a `× 100` that would be a 100× error.)*

## How wrong the reconstructions were

`ml-training/envelope_reconstruction_audit.py`, **799,193 bars, 75 symbols**:

| condition | true fires | reconstructed | agreement | Jaccard |
|---|---:|---:|---:|---:|
| `continuation < 2` | 0.754 | **1.000** | 0.754 | 0.754 |
| `continuation < 3` | 0.991 | **1.000** | 0.991 | 0.991 |
| `biases_MIXED` | 0.639 | 0.295 | 0.611 | 0.411 |
| `alignment_not_full` | 0.761 | 0.757 | 0.827 | 0.796 |
| `funding_supports_counter` (sign only) | 0.365 | 0.320 | 0.314 | **0.000** |
| `funding_supports_counter` (as gated) | **0.028** | 0.320 | 0.652 | **0.000** |
| `ANY_KILLED` domain | **0.066** | 1.000 | 0.066 | 0.066 |
| `1H opposes daily` | 0.066 | 0.199 | 0.853 | 0.287 |
| **`max_allowed`** (ML excluded) | | | **0.113** | |

Four findings, each previously an argument and now a measurement:

1. **`|momentumAlignment|` takes values {0, 1}** — confirmed empirically, not inferred. Both
   continuation thresholds fire on every row, so the reconstructed tier emits **only FLAT and LOW**:
   across 799k bars it never once produced MODERATE or HIGH. **Part 2's "NOT VERIFIED" verdict — the
   premise the entire Parts 6-10 programme was built on — rests on that.**
2. **`funding_supports_counter` has Jaccard 0.0000.** Not inaccurate: the reconstruction is the exact
   logical complement, so the masks are disjoint by construction. And the live rule fires on 2.8% of
   bars where the sweep scored 32.0% — a sign inversion on top of an 11× population error.
3. **`ANY_KILLED` exists on 6.6% of bars.** Part 7 scored every kill rule on 100% of them — a 15.1×
   inflation contaminating BOTH kill rows, `counter_move_volume_exceeds` included.
4. **The real MIXED state covers 63.9% of bars** where `tfAlignment == 0` covers 29.5%. Part 1's
   biases_MIXED arm missed more than half of its own population.

`envelope_sweep.py`, `envelope_whole.py`, `stock_gates.py` and `chase_stop_test.py` are **retracted in
place** — docstring carrying these numbers, plus a hard `sys.exit` so a stale invocation cannot
quietly produce another figure. Nothing imported them.

## What this does NOT establish

The audit computes **no payoffs and reaches no trading conclusion**. It says the reconstructions
described a different population from the one the app gates; it does not say what the right gate
configuration is. The payoff layer is separately retracted (the 4-hour anchor) and its replacement is
plan step 1a. Mixing the two is how the original numbers got their credibility.

**Unsupported is still not the same as proven wrong.** Every removal made in Parts 1-11 remains in
force pending Phase 3, and re-adding a gate whose evidence is equally broken would be a second
unvalidated change.

---

# PHASE 2 — C1: ENTRY DISCIPLINE, RE-RUN WITH CONTROLS (2026-08-26)

C1 runs first because its answer is already known, which makes it a **free oracle** on the rebuilt
stack (`_payoff` at `anchor='bar_close'`, `_report`'s intervals, `_guards`). It reproduces
**−0.0125 / +0.0211 exactly**, so nothing moved underneath the migration.

It also does something the original Part 4/5 did not: it asks what the gain is actually made of.

## The arms, with intervals that account for dependence

290,373 opportunities, 24 symbols — **~16,131 independent**, because a 72h hold at 4h spacing means
~18 consecutive rows resolve against overlapping paths. Bar: **lift ≥ +0.02R and ≥ 6/9 periods.**

| side | depth | gain | block 95% CI | cluster 95% CI | periods | verdict |
|---|---:|---:|---|---|---:|---|
| SHORT | 0.25 | −0.0125 | [−0.0160, −0.0092] | [−0.0192, −0.0064] | 2/9 | fails |
| SHORT | 0.50 | −0.0157 | [−0.0213, −0.0102] | [−0.0264, −0.0061] | 1/9 | fails |
| SHORT | 1.00 | −0.0138 | [−0.0226, −0.0054] | [−0.0281, −0.0009] | 2/9 | fails |
| LONG | 0.25 | +0.0211 | [+0.0182, +0.0241] | [+0.0174, +0.0249] | 8/9 | passes |
| LONG | 0.50 | +0.0337 | [+0.0287, +0.0388] | [+0.0274, +0.0400] | 8/9 | passes |
| LONG | 1.00 | +0.0523 | [+0.0443, +0.0606] | [+0.0424, +0.0626] | 8/9 | passes |

Both bootstraps exclude zero on every row, in both directions. On SHORT the rule is not merely
unsupported — it is confidently harmful.

## The LONG dose-response is abstention, not entry quality

Deeper pullback, bigger gain, monotone — which reads as a mechanism until you notice that an
unfilled setup scores **exactly 0**, and 0 beats a **−0.0673R** market baseline. So a rule that fills
less often looks better without entering anywhere better.

    gain = (1 − fill) × (0 − market)     ABSTENTION
         + fill × (fillR − market)       SELECTION

| depth | fill | gain | abstention | **selection** | selection share |
|---:|---:|---:|---:|---:|---:|
| 0.25 | 82.2% | +0.0211 | +0.0120 | **+0.0091** | 43% |
| 0.50 | 63.6% | +0.0337 | +0.0245 | **+0.0092** | 27% |
| 1.00 | 34.6% | +0.0523 | +0.0440 | **+0.0083** | 16% |

**Selection is FLAT at ~+0.009R.** The entire dose-response is abstention.

## The control: a coin flip reproduces it

Abstain at random on the same fraction of bars the rule misses:

| side | depth | rule | random | **rule − random** | block 95% CI |
|---|---:|---:|---:|---:|---|
| SHORT | 0.25 | −0.0125 | +0.0000 | **−0.0125** | [−0.0157, −0.0100] |
| SHORT | 1.00 | −0.0138 | −0.0001 | **−0.0138** | [−0.0156, −0.0091] |
| LONG | 0.25 | +0.0211 | +0.0120 | **+0.0091** | [+0.0068, +0.0119] |
| LONG | 0.50 | +0.0337 | +0.0243 | **+0.0093** | [+0.0063, +0.0130] |
| LONG | 1.00 | +0.0523 | +0.0441 | **+0.0082** | [+0.0063, +0.0131] |

## C1 verdict

**Entry discipline has a real but small selection edge on LONG: ~+0.009R, CI ≈ [+0.006, +0.013],
flat in depth — below the pre-declared +0.02 bar. On SHORT it is worse than random abstention at
every depth. The headline +0.0211 (and +0.0523 at 1 ATR) is dominated by abstention, which a coin
flip reproduces.**

This corrects Parts 4-5 a second time. The anchor retraction already removed the SHORT arm; this
removes the *interpretation* of the LONG arm. "The value was in the ENTRY LEVEL all along" and
"roughly 40-60× the entire gating apparatus" both compared a number that is mostly abstention against
a gating layer measured on coverage-matched controls. Against its own proper control the entry rule
is worth **+0.009R**, not +0.066R.

**What survives:** entering at a level is mildly better than entering at market on LONG, and clearly
worse on SHORT. **What does not:** that this is a large effect, that deeper is better, or that it is
the biggest thing in the system. And all LONG arms remain **negative in absolute terms** — the best
of them is −0.0150R. A pullback makes a losing proposition less bad.

---

# PHASE 2 — C2: THE EARNINGS GATES SURVIVE, AT LOWER MAGNITUDES (2026-08-26)

The three earnings conditions are the only ones in the envelope whose code states a **mechanism**
rather than a payoff claim: *"gap risk, the stop will not hold"*. By the Part 6 principle an EV null
cannot refute an exogenous-event guard, so the test is the variance claim itself.

486,900 stock bars, 159 symbols, 89.9% with a known next report. Baseline is bars **more than 14
days** from any report — not all bars, which would dilute the baseline with the windows under test.
**Bar: ratio ≥ 1.5× with a majority of periods clearing it.**

| window | bars | P(gap ≥ 2 ATR) | ratio | cluster 95% CI | periods | verdict |
|---|---:|---:|---:|---|---:|---|
| baseline (>14d) | — | 0.0805 | 1.00× | — | — | — |
| 0-2d | 16,951 | 0.3265 | **4.06×** | [3.68×, 4.43×] | 9/9 | **PASSES** |
| 3-7d | 21,796 | 0.4738 | **5.88×** | [5.46×, 6.30×] | 9/9 | **PASSES** |
| 8-14d | 31,885 | 0.3321 | **4.13×** | [3.86×, 4.39×] | 9/9 | **PASSES** |

**All three keep their justification.** The gates stand, and they remain the best-supported
conditions in the envelope.

## Two honest discrepancies against Part 8

**The magnitudes are lower.** Part 8 reported 7.08× / 7.03× / 4.99× against a 7.4% baseline; this run
gives 4.06× / 5.88× / 4.13× against 8.05%. Same direction, same verdict, materially smaller. The
inputs differ in three ways — corrected anchor, full 300-bar warm-up on all three timeframes, and a
baseline computed on >14d bars — and **I cannot attribute the gap to any one of them.** The
conclusion does not depend on which: every window clears 1.5× by a wide margin under both runs.

**The ordering flipped, and it is not an ATR artifact.** Part 8 had 0-2d highest; here 3-7d is
highest and 0-2d is the *lowest* of the three. The obvious explanation — implied vol running up into
a report inflating ATR and deflating gap/ATR — is **wrong**: ATR is flat across the windows (baseline
2.070 vs 1.94-2.00 inside them), and the ordering **persists on an ATR-free metric**:

| window | mean atrPct | P(gap ≥ 2% of price) | ratio |
|---|---:|---:|---:|
| baseline | 2.070 | 0.3670 | 1.00× |
| 0-2d | 1.999 | 0.5689 | 1.55× |
| 3-7d | 1.943 | 0.7187 | **1.96×** |
| 8-14d | 1.961 | 0.6032 | 1.64× |

**No mechanism is offered for why 3-7d exceeds 0-2d.** It is recorded as an unexplained detail rather
than given a story. It does not affect the decision: all three windows carry materially elevated gap
risk on both metrics, which is the whole of the gates' claim.

*(The ATR-free ratios are smaller because a 2%-of-price gap is far commoner than a 2 ATR one — a
36.7% baseline against 8.05% — which compresses every ratio toward 1. The ATR-normalised figure is
the operative one, because the gate's claim is about a stop placed at 2 ATR.)*

## The prompt numbers need updating

`prompt.ts` currently tells the model **"52% of bars see an overnight gap >= 2 ATR against a 7.4%
baseline (7.1x)"**. The measured values are now **32.65% against 8.05% (4.06×)** for 0-2d, **47.38%
(5.88×)** for 3-7d, and **33.21% (4.13×)** for 8-14d. Deferred to Phase 3 with the other prompt-text
decisions, so the corrections land in one pass rather than drifting again.

---

# PHASE 2 — C3: A LIVE GATE FAILS ITS OWN BAR (2026-08-26)

The open production decision. These removals stand today on evidence that has been retracted, and
*unsupported is not the same as proven wrong* — so each is re-decided on evidence rather than left
where a broken measurement put it.

**What is different this time:** every earlier test RECONSTRUCTED these conditions in Python, and the
audit measured that reconstruction against the real envelope at **11.3% agreement**. This joins
`envelope_exports/` — the verdict recorded by the real `buildUserPrompt` — to the payoff rows on
`(symbol, timestamp)`. 271,479 rows, 24 symbols, ~15,082 independent. **The conditions are read, not
rebuilt.**

Bar: **lift ≥ +0.02R AND ≥ 6/9 periods AND coverage ≥ 20%.** Both entry styles reported, because C1
showed a pullback entry is mostly abstention — a gate that helps under only one is a weaker finding.

| side | condition | entry | lift | block 95% CI | cluster 95% CI | periods | verdict |
|---|---|---|---:|---|---|---:|---|
| SHORT | `alignment_not_full` | market | −0.0086 | [−0.0328, +0.0148] | [−0.0317, +0.0133] | 4/9 | fails |
| SHORT | `alignment_not_full` | pullback | −0.0061 | [−0.0248, +0.0122] | [−0.0231, +0.0097] | 3/9 | fails |
| SHORT | **`continuation < 2`** | market | **+0.0385** | [+0.0095, +0.0658] | [+0.0047, +0.0753] | 7/9 | **PASSES** |
| SHORT | **`continuation < 2`** | pullback | **+0.0306** | [+0.0071, +0.0515] | [+0.0036, +0.0586] | 7/9 | **PASSES** |
| SHORT | `continuation < 3` | market | +0.2322 | [+0.1528, +0.3135] | — | 7/9 | fails — **1% coverage** |
| **LONG** | **`alignment_not_full`** | market | **−0.0096** | [−0.0391, +0.0192] | [−0.0476, +0.0238] | **2/7** | **fails** |
| **LONG** | **`alignment_not_full`** | pullback | **−0.0106** | [−0.0350, +0.0133] | [−0.0404, +0.0151] | **2/7** | **fails** |
| LONG | `continuation < 2` | market | −0.0149 | [−0.0725, +0.0473] | [−0.0896, +0.0517] | 2/7 | fails |
| LONG | `continuation < 2` | pullback | +0.0080 | [−0.0423, +0.0617] | [−0.0502, +0.0597] | 4/7 | fails |

## The headline: `alignment_not_full` is live on LONG and fails on the true conditions

Part 1 called it *"the one condition that cleared the pre-declared bar"* — **+0.0264R at 6/9 on
LONG** — and scoped it to LONG for exactly that reason. It is in force in production today.

Measured on the real envelope it is **−0.0096 / −0.0106, at 2 of 7 periods, with both intervals
spanning zero on both entry styles.** Verified independently of the harness. Part 1's LONG result was
a reconstruction artifact: `tfAlignment == 0` covers 29.5% of bars where the real MIXED state covers
63.9%, so that arm was scored on a mask that missed more than half its own population.

**This does not mean "remove it".** The measurement says *unsupported*, not *harmful* — the intervals
include zero. It joins the contested set as the first gate to fail its bar while live, and Phase 3
decides it with the others. No interim change.

## What else the join settles

**`continuation < 2` on crypto SHORT is confirmed, and more strongly than Part 9 found it**
(+0.0385 / +0.0306 against its +0.0303, 7/9 against 6/9, both CIs clear of zero on both entry
styles). It is the only condition in the envelope that has now passed the bar on data that was never
reconstructed. Its removal on LONG is also confirmed — 2/7 and 4/7, intervals spanning zero.

**`continuation < 3` behaves exactly as Part 9 predicted and the coverage floor exists to catch:**
the largest lift in the vault (+0.2322) on **1% coverage**. Correctly not adopted, twice.

**`alignment_not_full` on SHORT stays removed** — 4/9 and 3/9, intervals spanning zero, consistent
with Part 1's removal even though Part 1's reasoning was measured on a broken mask.

## Not yet testable, and why

`funding_supports_counter` and both divergence rules **cannot be read from the export**, because they
were removed from the code and so are no longer computed. Testing them needs the exporter extended to
emit them as diagnostics from the real implementation — the alternative is a reconstruction, which is
the thing this phase exists to stop. Carried to Phase 3 as an explicit gap, not silently dropped.

---

# PHASE 2 — C4: THE ML GATE IS DIRECTION-DEPENDENT, AND STRONGLY (2026-08-26)

C3 asked whether the removals were right. C4 asks the more urgent question: **are the gates still
standing earning their place?** The cost of error here is an over-restrictive app — the complaint that
started this programme.

Conditions read from `envelope_exports/`. ML from `phase2_oof.py`: walk-forward, **production target**
(`goodR = fwdMaxFavR >= 1.5`), **production 110-feature list read from the shipped model JSON**,
3 folds, 48-bar purge, provenance recorded. Mean OOF AUC **0.6767** against production v14's 0.674 —
the OOF reproduces the shipped model's discrimination.

Thresholds are swept on the **raw** scale. Production gates on a live-calibrated value, but the PAV
layer refits from forward data a historical bar does not have, and calibrating on the same rows being
scored would be circular. 154,348 joined rows, 24 symbols.

*(`oof_24h.csv` was already on disk and is NOT used: its producer targets a forward max over feature-row
CLOSES, never seeing an intrabar high, on "everything numeric not in DROP" rather than the shipped
110. A file whose semantics differ from production cannot re-decide a production threshold.)*

| side | gate | blocks | coverage | blocked R | kept R | lift | block 95% CI | periods |
|---|---|---:|---:|---:|---:|---:|---|---:|
| SHORT | ML < 0.50 | 65.6% | 34% | −0.0298 | +0.0336 | **+0.0416** | [+0.0036, +0.0812] | 5/7 |
| SHORT | ML < 0.55 | 77.9% | 22% | −0.0264 | +0.0571 | **+0.0650** | [+0.0199, +0.1109] | 5/7 |
| SHORT | ML < 0.60 | 87.6% | 12% | −0.0192 | +0.0712 | +0.0792 | [+0.0231, +0.1373] | 5/7 |
| **LONG** | ML < 0.50 | 71.8% | 28% | **+0.0022** | **−0.1378** | **−0.1005** | [−0.1549, −0.0483] | **1/5** |
| **LONG** | ML < 0.55 | 84.7% | 15% | −0.0141 | −0.1667 | **−0.1293** | [−0.2020, −0.0597] | **0/5** |
| **LONG** | ML < 0.60 | 94.5% | 5% | −0.0259 | −0.2349 | **−0.1976** | [−0.3087, −0.0871] | **0/5** |
| SHORT | `crypto_bear_regime` | 86.1% | 14% | +0.0035 | −0.0789 | **−0.0709** | [−0.1338, −0.0086] | 2/7 |
| SHORT | `ANY_KILLED` | 5.8% | 94% | −0.0354 | −0.0063 | +0.0017 | [−0.0246, +0.0282] | 4/7 |
| SHORT | 1H opposes | 14.1% | 86% | −0.0414 | −0.0025 | +0.0055 | [−0.0208, +0.0321] | 6/7 |

The pullback-entry table has the same shape throughout: SHORT lifts positive but smaller
(+0.0276 / +0.0394), LONG lifts inverted (−0.0881 / −0.1173 / −0.1926).

## The ML gate helps SHORT and actively harms LONG

**On LONG, filtering by ML makes the kept set dramatically worse, monotonically in the threshold.**
At ML < 0.50 the BLOCKED bars average **+0.0022R** while the KEPT bars average **−0.1378R**. Both
bootstraps exclude zero. 0-1 of 5 periods positive.

The mechanism is not a broken model. `goodR` is **direction-agnostic** — it predicts a large
excursion *either way*. In a window where the equal-weight crypto basket fell 83%, a bar flagged
"big move likely" is disproportionately a big move DOWN. That pays a SHORT and stops a LONG. This is
the same regime caveat the vault already records for `alignment_not_full` and `continuation`, now
visible in the component Part 2 called *"the only one with positive lift"* — a claim measured
without splitting by side.

**Nothing is changed on this basis.** The ML floor is the last thing standing between the app and
trading every bar, the effect is plausibly regime rather than mechanism, and 5 periods is thin. It
goes to Phase 3 with the rest, flagged as the largest open question in the envelope.

## `crypto_bear_regime` measures inverted where it fires

It is live as a LONG-side downgrade. On SHORT bars it blocks bars averaging **+0.0035R** and keeps
**−0.0789R** — lift **−0.0709**, CI [−0.1338, −0.0086], 2/7. Its own side (LONG) is a null
(−0.0062, CI spanning zero). Recorded; not acted on.

## Confirmed inert

`ANY_KILLED` (5-6% fire rate, lift ±0.002, CI spanning zero on both sides) and the 1H-opposes
downgrade (±0.005, spanning zero). Part 7 reached the same conclusion on a population **15× too
large**; on the true 6.6% domain it is inert for real. Harmless, and cheap to keep.

## Not tested, and not testable

`macro_IMMINENT` / `macro_NEARBY` / `macro_UPCOMING`, `news_thesis_conflict`, `data_stale`. No
historical economic-calendar or feed archive exists to replay against. Under the Part 6 principle
they guard **exogenous events** and never claimed predictive power, so an EV null could not refute
them. They stay, untested, and this is stated rather than glossed.

## The honest limit on every row above

The OOF window starts where the first walk-forward fold ends, so these arms have **5-7 half-year
periods, not 9**. The pre-declared bar wants 6, which several SHORT arms miss on period count alone
despite large lifts and intervals clear of zero. That is a real limitation of the design, not a
verdict, and it is why C4 changes nothing by itself.

---

# PHASE 2 — C5: PART 2 WAS HALF RIGHT, AND THE HALF THAT WAS RIGHT WAS LONG (2026-08-26)

**This is the premise check.** Part 2 concluded *"the envelope is NOT VERIFIED"*, and every removal
and rescoping in Parts 6-10 was built on that verdict. The audit then measured Part 2's
implementation against the real envelope at **11.3% agreement**, and showed its reconstructed tier
**never emitted MODERATE or HIGH across 799,193 bars** — `cont = |momentumAlignment|` takes values
{0,1}, so both continuation thresholds fired on every row and the tier collapsed to {FLAT, LOW}.

The real envelope, with walk-forward OOF ML injected via `exportEnvelope.ts --ml`:

| tier | share |
|---|---:|
| MODERATE | 40.7% |
| FLAT | 27.6% |
| LOW | 22.7% |
| HIGH | 9.0% |

Part 2 cut exposure to **8.5%** of bars. The real envelope FLATs 27.6% and reaches HIGH on 9%. It was
measuring a different function.

## The result, per unit of exposure

Scored as the sizing function it is — R per unit of exposure, so a gate cannot look good merely by
trading less. The control is trade-everything, which is a coverage-matched random gate's
*expectation*: random allocation is independent of the payoff, and the measured random arms confirm
it (SHORT −0.0219 vs −0.0147, LONG −0.0326 vs −0.0342).

| entry | side | envelope | control | **difference** | block 95% CI | cluster 95% CI |
|---|---|---:|---:|---:|---|---|
| market | **SHORT** | +0.0072 | −0.0147 | **+0.0219** | [+0.0052, +0.0386] | [+0.0099, +0.0333] |
| market | **LONG** | −0.0531 | −0.0342 | **−0.0189** | [−0.0355, −0.0013] | [−0.0337, −0.0062] |
| pullback | **SHORT** | −0.0092 | −0.0319 | **+0.0227** | [+0.0093, +0.0352] | [+0.0131, +0.0320] |
| pullback | **LONG** | −0.0455 | −0.0295 | **−0.0161** | [−0.0298, −0.0018] | [−0.0277, −0.0054] |

**Every interval excludes zero, in both directions, under both entry styles and both size mappings.**

## What this does to Part 2

**On SHORT, Part 2 is overturned.** It reported the envelope beating a coverage-matched random gate
by **+0.0012R**; the real envelope beats it by **+0.0219R** — roughly eighteen times larger, with
intervals clear of zero. The envelope is a working SHORT-side risk gate.

**On LONG, Part 2 is confirmed, twice over.** The envelope is **worse than random** (−0.0189), and
its own **inversion beats it** (−0.0214 against the envelope's −0.0531). Both were Part 2's claims,
and both survive measurement on the real verdicts.

**"The ML component alone beats the full envelope" survives on SHORT** (+0.0336 against +0.0072 at
lower exposure, ~4.7×) and inverts on LONG (−0.1378 against −0.0531), exactly as C4 predicted.

## The shape of the whole thing

C3 found direction-dependence in `alignment_not_full`, C4 found it in the ML floor, and C5 now finds
it **in the aggregate**: the Conviction Envelope is a **working gate on SHORT and an inverted one on
LONG**. Part 2 averaged the two into "NOT VERIFIED" and Parts 6-10 then removed conditions on that
average — which is the same error, one level up, that made a single rule averaged across two sides
hide an inverted gate inside a working one.

**Regime caveat, unchanged and load-bearing:** the window is a crypto bear in which the equal-weight
basket fell 83%, and SHORT is the better side ungated. A gate that "works on SHORT" in that window
may be reading the regime rather than the bar. This is why C5 changes nothing on its own.

---

# PHASE 2 — C6: ABSOLUTE VS COVERAGE IS A NON-QUESTION ONCE YOU CONDITION ON SIDE (2026-08-26)

Part 11 asked how the ML gate should be parameterised, and its shipped artifact was retracted the
same day for a specific reason: it **measured unconditionally** (`m = w & (d.ml >= t)`, no bias
filter, so 41.3% was 41.3% of *all* bars) and then **shipped conditionally on SHORT**, whose ML runs
lower — a realised selectivity of ~24%, which the same research called worse than no gate.

C4 and C5 established that side is the dominant term. C6 therefore conditions every arm on the side
the gate would govern, which is exactly what the retraction demanded.

## SHORT — the two parameterisations are the same curve

| arm | coverage | lift | block 95% CI | periods |
|---|---:|---:|---|---:|
| ABS ML ≥ 0.50 | 34.4% | +0.0416 | [+0.0036, +0.0812] | 5/7 |
| COV top 30% (≥ 0.517) | 30.0% | +0.0537 | [+0.0133, +0.0942] | 5/7 |
| ABS ML ≥ 0.55 | 22.1% | +0.0650 | [+0.0199, +0.1109] | 5/7 |
| COV top 20% (≥ 0.559) | 20.0% | +0.0719 | [+0.0261, +0.1195] | 5/7 |
| ABS ML ≥ 0.65 | 6.0% | +0.0542 | [−0.0230, +0.1277] | 4/7 |

**At matched coverage the two are indistinguishable.** The absolute-vs-coverage debate that produced
`coverageCut()` is not a real choice: **coverage is the parameter, and side is the conditioner.**
Part 11 shipped machinery to solve a problem that does not exist at the level where it matters — and
missed the one that does.

## LONG — inverted at every coverage, under both parameterisations

| arm | coverage | lift | block 95% CI | periods |
|---|---:|---:|---|---:|
| ABS ML ≥ 0.50 | 28.2% | −0.1005 | [−0.1549, −0.0483] | 1/5 |
| COV top 30% (≥ 0.494) | 30.0% | −0.0966 | [−0.1490, −0.0446] | 1/5 |
| ABS ML ≥ 0.60 | 5.5% | −0.1976 | [−0.3087, −0.0871] | 0/5 |
| COV top 20% (≥ 0.531) | 20.0% | −0.1192 | [−0.1835, −0.0558] | 0/5 |

Monotone in tightness, in the wrong direction, on both scales.

## Fitting the threshold is inadmissible — Part 11's control replicates

| side | walk-forward mean | out-of-sample by period | thresholds chosen |
|---|---:|---|---|
| SHORT | +0.0516 (3/5) | +0.195, −0.125, +0.098, +0.211, −0.121 | 0.60, 0.60, 0.60, 0.55, 0.60 |
| LONG | −0.0471 (1/4) | −0.046, −0.107, +0.037, −0.073 | **0.40, 0.40, 0.40, 0.40** |

On SHORT, fitting does not destroy the edge outright but makes it **wildly unstable** — the
out-of-sample result swings across a 0.34R range period to period, on a signal whose whole size is
0.05R. On LONG, **the optimizer picks the loosest available threshold every single time**: it is
trying to switch the gate off, and still loses. Part 11 saw the same thing as its coverage arm
converging on q = 1.00. That behaviour replicates exactly.

**Verdict: the threshold must stay FIXED and never fitted** — which is what production does today,
and the one Part 11 conclusion that survives contact with the corrected stack.

## The limit that applies to all of C4-C6

The OOF window begins where the first walk-forward fold ends, so these arms have **5-7 half-year
periods, not 9**. Every SHORT arm above sits at 5/7 — a majority, but short of the pre-declared 6.
Nothing here clears the bar outright, and that is why C6, like C4 and C5, changes nothing by itself.

---

# PHASE 3 — THE VERDICTS (2026-08-26)

Every envelope condition, with what the corrected stack says and what changes. The standing rule
governs throughout: **unsupported is not the same as proven wrong**, and re-deciding a gate on
evidence that is itself thin would repeat the error this programme exists to fix.

## Verdict table

| condition | status | evidence | verdict |
|---|---|---|---|
| `biases_MIXED` | removed | `mixed_flat_test` on 870K+503K bars, independent of the anchor; plus 71/73 BTC bars FLAT through a +7.5% advance | **stays removed** |
| `alignment_not_full` SHORT | removed | C3: −0.0086 / −0.0061, CIs span zero, 4/9 and 3/9 | **stays removed** (noise) |
| **`alignment_not_full` LONG** | **IN FORCE** | C3: **−0.0096 / −0.0106, 2/7, CIs span zero** | **contested — no change** |
| `continuation < 3` | removed | code fact (P=0 on stocks); C3: 1% coverage against a 20% floor | **stays removed** |
| **`continuation < 2` crypto SHORT** | IN FORCE | C3: **+0.0385 / +0.0306, both CIs clear of zero, 7/9, 34% coverage** | **PASSES — stays** |
| `continuation < 2` LONG / stocks | removed | C3: 2/7 and 4/7, CIs span zero | **stays removed** |
| `funding_supports_counter` | removed | Phase 3: −0.0036 / +0.0146 on its **own 6.4% domain**, CIs span zero | **stays removed** |
| divergence (kill + escalated) | removed | Phase 3: +0.0044 / +0.0038 on own domain, CIs span zero | **stays removed** |
| **earnings 0-2d / 3-7d / 8-14d** | IN FORCE | C2: **4.06× / 5.88× / 4.13×, 9/9 periods**, cluster CIs far above the 1.5× bar | **PASSES — stays; prompt numbers corrected** |
| ML thresholds (50/60/70) | IN FORCE | C4/C6: SHORT +0.0416…+0.0650; **LONG −0.1005…−0.1976** | **contested — no change** |
| `crypto_bear_regime` | IN FORCE | C4: **−0.0709 on SHORT** (CI clear of zero); null on its own side | **contested — no change** |
| `ANY_KILLED` (volume ∥ macro) | IN FORCE | C4 + Phase 3: inert, ±0.005, CIs span zero | **stays** (harmless, cheap) |
| 1H-opposes downgrade | IN FORCE | inert, ±0.005 | **stays** |
| macro ×3, news conflict, data stale | IN FORCE | **no historical archive exists** | **stay, untested by design** |
| `treatment_long_confirm_*` | mixed | **not re-runnable** — the live day-over-day daily-RSI delta is exported under no name | **unchanged, untested** |
| aligned-bearish stock SHORT ban | IN FORCE | not re-tested: no stock envelope export | **unchanged, untested** |

## What actually changes in production

**One thing: the earnings numbers in the prompt.** They were overstated — 7.08× / 7.03× / 4.99×
where the re-run measures 4.06× / 5.88× / 4.13×. The gates are unaffected; the model was being fed
figures too large by roughly half. Corrected, with the ordering flip recorded and no mechanism
invented for it.

**No gate is added, removed or rescoped.** That is the finding, not an absence of one. Three
conditions now have evidence they never had (`continuation < 2` on crypto SHORT passes on data that
was never reconstructed; the three earnings windows pass on their own stated mechanism; the removed
kills are noise on their true domain rather than inverted on an inflated one). Everything contested
fails on **5-7 half-year periods against a bar of 6**, in a window that is a crypto bear where SHORT
is the better side ungated. That is not enough to move a live gate.

## The three contested gates, stated plainly

**`alignment_not_full` on LONG** is the sharpest: Part 1 called it *"the one condition that cleared
the pre-declared bar"* and it does not clear it on the real conditions. But its interval spans zero —
**unsupported, not harmful** — and removing it would leave LONG conviction governed by ML alone, the
component C4 shows is inverted there.

**The ML floor** is the largest open question in the system. It lifts SHORT and inverts LONG,
monotonically, with intervals clear of zero on both. The mechanism is understood — `goodR` is
direction-agnostic, and in an 83%-drawdown window "big move likely" is disproportionately a move down
— which is exactly why it may be **regime rather than mechanism**. It is also the last thing between
the app and trading every bar.

**`crypto_bear_regime`** measures inverted where it fires and null on the side it governs. Small,
and the cheapest of the three to revisit.

## An honesty problem with the holdout, stated rather than worked around

Plan step 1.11 reserved the last six months as a frozen holdout, untouched until Phase 3. **It was
never implemented, and C1-C6 consumed the entire span.** There is now no unseen data in this dataset,
so running a "holdout" on it would report a number I have already looked at — which is the shape of
the error this whole programme is repairing.

Two consequences, both accepted rather than patched:

1. **No holdout number is reported.** Reporting one would be worse than reporting none.
2. **The only honest holdout left is FORWARD.** `direction_signals` and `ml_calibration` already
   accumulate live graded outcomes; the equivalent for the envelope is to log each bar's
   `max_allowed` and grade it at +72h. That is a build, not an analysis, and it is the right next
   piece of work — it is also the only way the regime caveat above ever gets resolved, since it needs
   a window that is not this one.

## What this programme actually delivered

Not a better gate configuration — the configuration is almost unchanged. What changed is that the
**measurement layer is now trustworthy**: one payoff simulator with a proved-identical port, one
envelope implementation that production and research share, a join gate that has already caught a
data defect, guards that each reproduce a defect that shipped, and provenance on every artifact. The
five defects the reviews found are structurally unable to recur, and the numbers above are the first
in this vault that were measured rather than reconstructed.
