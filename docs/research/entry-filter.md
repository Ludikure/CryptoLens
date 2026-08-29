# T13 — Crash signal as an entry filter on NEW capital

**Status:** pre-declared by the user. Existing holdings never sold; no shorting, leverage or options.

**Premise:** T9's problem may be implementation, not prediction. Selling on a false alarm can cost an
entire bull leg; *declining to buy* on a false alarm only means buying later. T13 applies the same
signal to new capital only.

## ⚠️ An implementation error of mine, corrected mid-test

My first run used a **fixed dollar** contribution while the portfolio compounded 10×. By the end the
daily contribution was ~0.01% of the portfolio, cash never accumulated (avg 0.1%), and **all six arms
returned identical numbers** — a degenerate experiment, not a null result. Corrected to a
contribution proportional to portfolio value (~44%/yr), as the spec originally specified. The
results below are from the corrected run.

## Verdict: DOES NOT MEET THE BAR — 4 of 6

| arm | CAGR | maxDD | Calmar | Sharpe | final wealth | avg cash | max cash |
|---|---|---|---|---|---|---|---|
| A: BTC buy & hold | 37.2% | −76.6% | 0.49 | 0.84 | — | — | — |
| B: untimed DCA | 37.2% | −76.6% | 0.49 | 0.84 | 59.11 | 0.0% | 0.0% |
| C: randomised timing | 37.2% | −76.6% | 0.49 | 0.84 | 59.08 | 0.1% | 0.7% |
| **D: T13 crash signal** | **37.7%** | **−75.9%** | **0.50** | 0.84 | **60.56** | 0.4% | 7.8% |
| E: 30-day lag | 37.5% | −76.2% | 0.49 | 0.84 | 59.85 | 0.4% | 6.6% |
| F: realised vol >80th | 37.1% | −76.6% | 0.48 | 0.84 | 58.97 | 0.1% | 2.7% |

| criterion | result | |
|---|---|---|
| 1. beats untimed DCA on Calmar AND Sharpe | 0.50/0.84 vs 0.49/0.84 | PASS |
| 2. beats randomised timing | 0.50 vs 0.49 | PASS |
| 3. survives holdout | −0.47 vs −0.47 | **FAIL** |
| 4. not driven by one episode | largest year **69%** | **FAIL** |
| 5. <50% of period in cash | avg 0.4%, deferred 35% of days | PASS |
| 6. survives 0.25% costs | 0.50 vs 0.49 | PASS |

## The direction is right; the magnitude is negligible

| arm | contribution-weighted entry price | deferrals | avg delay |
|---|---|---|---|
| B: untimed | 66,742 | 0 | — |
| C: randomised | 66,739 | 761 | 1.5d |
| **D: crash signal** | **66,460** | 761 | 6.2d |
| F: realised vol | 66,786 | 192 | 11.3d |

**D deployed capital at a 0.4% better average price than untimed DCA, and randomised timing captured
none of that benefit** (66,739 ≈ untimed). So the signal *is* doing something real — consistent with
[[t9-attribution-audit]] — and the placebo behaves exactly as a placebo should.

But the total effect over six years is **+2.5% final wealth** (60.56 vs 59.11) and **+0.7pp of
drawdown**. That is not an economically meaningful improvement.

## Why the framing cannot work — a structural limit, not a tuning problem

High-crash-probability episodes average **6.2 days**. At any sane contribution rate, six days of
deferred contributions is a fraction of a percent of an accumulated portfolio — average cash reached
just **0.4%**, peaking at 7.8%, never approaching the 30% cap.

**T9 achieved Calmar 1.74 because it moved the ENTIRE portfolio. T13 moves only new contributions,
which are a rounding error against existing holdings.** The asymmetry the design hoped to exploit is
real — declining to buy is a much cheaper error than selling — but the benefits shrink in exactly the
same proportion as the costs. Cheap errors, cheap benefits.

## This is the declared endpoint for the branch

The design named this outcome: *"If T13 fails: stop trying to monetize the crash model through spot
timing."* The accumulated evidence across T9-T13 now supports precisely that:

| | finding |
|---|---|
| T9 | crash probability carries genuine anticipatory information (Calmar 1.74 vs 0.48) |
| T11 | the information is real (placebos collapse) but **episodic** — absent through five 20-28% drawdowns in 2023-25 |
| T12 | requiring confirmation **destroys the lead time** that is the entire source of value |
| T13 | applying it to new capital only makes the benefit **as small as the risk** |

**Conclusion for this branch:** the crash model produces real information about forward risk, and it
is economically useful only if applied to an *existing portfolio at full size*, accepting ~35×/year
turnover and episodic protection as the unavoidable price. There is no cheaper, safer or
smaller-footprint way to monetise it. Every attempt to reduce the cost removed the benefit in the
same measure.

That is a genuine endpoint, not a failure to find one.
