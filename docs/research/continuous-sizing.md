# T15 — Continuous crash-risk position sizing

**Status:** pre-declared by the user, frozen mapping and 10pp rebalance band. Control mappings for
CTRL3/CTRL4 declared by me before the run (each builds a risk score in [0,1] fed through the *same*
frozen exposure curve, so arms differ only in what generates the score).

## Verdict: DOES NOT MEET THE BAR — 6 of 10

| arm | CAGR | maxDD | Calmar | Sharpe | Sortino | avg exp | turn/y | tax events |
|---|---|---|---|---|---|---|---|---|
| BTC 100% | 36.8% | −76.6% | 0.48 | 0.83 | 1.19 | 100% | 0.0 | 0 |
| **CTRL1 T9 baseline** | **64.6%** | −42.3% | **1.53** | 1.34 | 1.94 | 73% | 34.9 | 375 |
| **T15 continuous** | 59.0% | −42.2% | 1.40 | 1.23 | 1.90 | 81% | **19.9** | 485 |
| CTRL3 vol sizing | 17.5% | −69.8% | 0.25 | 0.60 | 0.82 | 72% | 7.3 | 205 |
| CTRL4 200D sizing | 37.2% | −38.6% | 0.96 | 1.11 | 1.61 | 54% | 3.0 | 126 |
| CTRL5 static 70% BTC | 30.2% | −61.8% | 0.49 | 0.85 | 1.22 | 70% | 0.0 | 0 |
| CTRL2 shuffled runs | 27.7% | −71.3% | 0.40 | 0.74 | 1.02 | — | — | — |

| criterion | result | |
|---|---|---|
| 1. Calmar > T9 | 1.40 vs 1.53 | **FAIL** |
| 2. maxDD not worse by >5pp | −42.2% vs −42.3% | PASS |
| 3. CAGR ≥ 80% of T9 | 59.0% vs 51.7% | PASS |
| 4. beats static 70% BTC | 1.40 vs 0.49 | PASS |
| 5. beats vol sizing | 1.40 vs 0.25 | PASS |
| 6. beats 200D sizing | 1.40 vs 0.96 | PASS |
| 7. beats shuffled decisively | 1.40 vs 0.40 | PASS |
| 8. persists on holdout | −0.21 vs −0.04 | **FAIL** |
| 9. survives 0.25% costs vs T9 | 1.24 vs 1.25 | **FAIL** (by 0.01) |
| 10. no episode >50% | 57% | **FAIL** |

## The Pareto question — answered, and the answer is no

> *"Can continuous sizing move the T9 point toward MORE RETURN + LESS DRAWDOWN?"*

| | CAGR | maxDD | Calmar |
|---|---|---|---|
| BTC | 36.8% | −76.6% | 0.48 |
| T9 | **64.6%** | −42.3% | **1.53** |
| T15 | 59.0% | −42.2% | 1.40 |

**T15 is strictly dominated: −5.6pp of CAGR for +0.0pp of drawdown.** It moved along no useful axis.

## Why — the 25% floor did exactly what it was designed to do, and that was the problem

| regime | BTC | T9 | T15 | T15 avg exp |
|---|---|---|---|---|
| 2020 bull | +582% | +391% | **+442%** | 74% |
| **2021 bull** | +3% | −9% | **−3%** | 56% |
| **2022 bear** | −76% | **+19%** | **−30%** | 61% |
| 2022-25 recovery | +666% | +434% | **+580%** | 93% |
| 2025-26 bear | −51% | **−32%** | −38% | 92% |

Continuous sizing **improved every bull window**, including the 2021 leg that T10 could not fix
(−9% → −3%). And it **destroyed the 2022 crash protection: +19% → −30%.**

The floor was added deliberately — *"a continuous strategy should retain permanent BTC participation
rather than completely exiting"* — to address 2021 without breaking 2022. It fixed 2021 and broke
2022. Holding 61% average exposure through a −76% collapse is what a 25% floor guarantees.

**The economic value of this signal lies specifically in the ability to go FULLY defensive.** Every
attempt to soften that — confirmation (T12), new-capital-only (T13), a floor (T15) — removes the
benefit in proportion to the softening.

## One narrow observation, recorded but not acted on

At 0.25% costs T15 loses **0.16** of Calmar against T9's **0.28** — its 43% lower turnover does
reduce cost sensitivity, it simply starts too far behind (1.24 vs 1.25, a tie). At meaningfully
higher friction the ranking would likely invert. **Not pursued: selecting a cost level at which T15
wins would be exactly the post-hoc tuning this vault forbids.** Noted for anyone facing much higher
transaction costs than assumed here.

## The controls, again, all pass

T15 beats shuffled runs (1.40 vs 0.40, distribution *and* turnover preserved), realised-vol sizing
(0.25), 200D sizing (0.96) and static 70% BTC (0.49). **The signal is real — that is now confirmed
five independent ways.** Only its implementation keeps failing.

Worth noting: CTRL3, volatility-based continuous sizing, scores **0.25 — worse than BTC itself**.
Volatility is not a usable substitute for the crash model in this framework.

## The declared failure interpretation applies

> *"If T15 cannot beat T9 without giving back most of the drawdown protection, then the research
> conclusion becomes substantially stronger: the crash signal contains real information, but its
> economic value is intrinsically tied to large, early exposure changes. In that case, T9 really may
> be the endpoint."*

That is precisely what happened. **T9 is the endpoint.**
