# T14 — Honest mechanism portfolio (the closing portfolio experiment)

**Status:** pre-declared by the user. Static allocations only. Three things declared by me before the
run: "structural premium" = covered carry; the T9 overlay and convex appear in the eligible list but
in **none** of the three declared allocations, so the three are run exactly as written and a
T9-overlaid variant is reported separately **as my addition**; carry is a constant 8%/yr (measured
Coinbase covered rate, no Binance data).

## Verdict: DOES NOT MEET THE BAR — no declared portfolio passes all seven

| arm | CAGR | maxDD | Calmar | Sharpe | Sortino | terminal | worst yr | recovery |
|---|---|---|---|---|---|---|---|---|
| **B1 100% BTC** | 36.8% | −76.6% | 0.48 | 0.83 | 1.19 | 6.5 | −64% | 846d |
| B2 80/20 BTC-cash | 32.8% | −67.4% | 0.49 | 0.85 | 1.21 | 5.5 | −54% | 841d |
| B3 equal-weight (T7) | 26.9% | −26.4% | 1.02 | 1.19 | 1.43 | 4.2 | −1% | 962d |
| **B4 random 7/18/1/74** | 14.1% | −17.8% | **0.79** | 1.23 | 1.72 | 2.2 | +3% | 939d |
| P1 RETURN | 38.3% | −65.7% | 0.58 | 0.92 | 1.33 | 7.0 | −50% | 840d |
| P2 BALANCED | 37.3% | −52.4% | 0.71 | 1.01 | 1.46 | 6.7 | −32% | 1032d |
| P3 DEFENSIVE | 30.7% | −36.8% | 0.83 | 1.11 | 1.56 | 5.0 | −17% | 964d |

| portfolio | 1 Calmar | 2 dd−20pp | 3 CAGR≥60% | 4 positive | 5 beats random | 6 regimes≥3/5 | 7 no Binance |
|---|---|---|---|---|---|---|---|
| P1 RETURN | PASS | **FAIL** | PASS | PASS | **FAIL** | **FAIL** (1/5) | PASS |
| P2 BALANCED | PASS | PASS | PASS | PASS | **FAIL** | **FAIL** (0/5) | PASS |
| P3 DEFENSIVE | PASS | PASS | PASS | PASS | PASS | **FAIL** (0/5) | PASS |

## The two findings that kill it

**1. The permutation control inverts.** Permuting component histories with a single shared
permutation — preserving mean, volatility and cross-correlation exactly, destroying only the time
ordering — produces **better** results than the real data:

| | real Calmar | permuted | real maxDD | permuted maxDD |
|---|---|---|---|---|
| P1 RETURN | 0.58 | **0.74** | −65.7% | **−53.4%** |
| P2 BALANCED | 0.71 | **0.88** | −52.4% | **−43.2%** |
| P3 DEFENSIVE | 0.83 | **1.01** | −36.8% | **−31.0%** |

The real sequence of returns is *worse* than a random shuffle of itself. **Nothing about the actual
market dynamics is being exploited — the entire benefit is variance reduction from mixing assets**,
and the real world's clustered crashes make it worse than the shuffled counterfactual. This is
exactly what the control was written to detect.

**2. The random allocation beats two of the three designed portfolios.** B4 — drawn before any
result, landing on 7% BTC / 18% trend / 1% carry / 74% cash — scores Calmar 0.79 against P1's 0.58
and P2's 0.71. **"Less BTC = lower drawdown" is doing the work**, which is precisely why B4 was in
the design.

**3. Regime sweep: 1/5, 0/5, 0/5.** No declared portfolio beats BTC on Calmar in even three of the
five windows. The full-period advantage is an aggregate artifact, not consistent behaviour.

## ⚠️ Carry is modelled as a zero-volatility asset, which flatters P2 and P3

Constant 8%/yr with **0% drawdown**. No such asset exists — the real covered basis varies, and its
venue risk (FTX) is invisible in any return series. Since P2 and P3 hold 10-20% of it, their
drawdown numbers are optimistic. Declared in advance; restated because it bounds the conclusion.

## The T9-overlaid variants (MY ADDITION — cannot count toward the bar)

| arm | CAGR | maxDD | Calmar | terminal | worst yr | recovery |
|---|---|---|---|---|---|---|
| **P1 RETURN +T9** | **58.5%** | −40.1% | **1.46** | **15.8** | −3% | 521d |
| P2 BALANCED +T9 | 50.7% | −38.5% | 1.32 | 11.7 | −2% | 569d |
| P3 DEFENSIVE +T9 | 38.3% | −30.9% | 1.24 | 7.0 | +1% | 569d |

These dominate everything — higher CAGR than BTC *and* roughly half the drawdown. **They are not a
pass**: they are not among the three declared portfolios, and they inherit every documented T9
caveat — episodic protection (absent through five 2023-25 drawdowns), ~35×/year turnover, and the
tax consequences of 375 exposure changes.

They matter only as confirmation of the pattern already established: **the crash overlay is the one
component doing real work, and static mixing is not.**

## NULL RESULT — the declared conclusion

The design specified what a failure means, and the evidence supports it exactly:

> BTC buy-and-hold is the optimal return engine. Crash protection can materially reduce drawdown but
> has a large opportunity cost. Structural premia are interesting but insufficiently
> scalable/reachable. No tested public-feature directional strategy adds enough value.

**Mechanism diversification does not produce an attractive risk-adjusted BTC portfolio under
currently reachable inputs.** Static mixes dilute rather than improve; the permutation control shows
they exploit nothing about real dynamics; and a random allocation beats most of them.

The only thing that survived every audit is the crash overlay applied to a full-size position — with
turnover, tax and episodic reliability as its unavoidable price ([[entry-filter]]).

**This was the final portfolio-level experiment. On this evidence the research question is answered.**
