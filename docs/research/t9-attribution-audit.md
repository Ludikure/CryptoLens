# T11 — T9 attribution / placebo audit

**Status:** design pre-declared by the user. No new signal, no features, no optimisation.

**Question:** is T9's improvement attributable to the crash model, or to generic exposure reduction
and a lucky sequence of 2020-2026 regimes?

## Verdict: 5 of 7 pass. **The signal is real; its application is NOT consistent.**

| # | pass condition | result | |
|---|---|---|---|
| 1 | drawdowns preceded by lower exposure than random | +48.8pp vs +13.4pp, p=0.000 | PASS |
| 2 | survives placebo controls | 1.74 vs 0.34-0.36 | **PASS decisively** |
| 3 | not dependent on one threshold | Calmar 1.42-2.52 across p 0.20-0.40 | PASS |
| 4 | **consistently** de-risks before large drawdowns | **protection absent 2023-2025** | **FAIL** |
| 5 | false-alarm cost measurable and acceptable | net **−27.8pp** (a gain) | PASS |
| 6 | no single episode is the majority of the improvement | **54.8%** from one regime | **FAIL** |
| 7 | no lookahead anywhere | signal lagged 1d throughout | PASS |

## TEST 1 — the finding that matters: protection is CONCENTRATED, not consistent

| peak | BTC dd | exp at peak | T9 dd | verdict |
|---|---|---|---|---|
| 2021-01-08 | −25% | **0%** | −2% | protected |
| 2021-04-13 | −23% | **0%** | −14% | protected |
| 2021-05-08 | −49% | 50% | −30% | partial |
| **2021-11-08** | **−77%** | **0%** | **−14%** | **protected superbly** |
| 2023-07-13 | −20% | **100%** | −19% | **no protection** |
| 2024-03-13 | −20% | **100%** | −19% | **no protection** |
| 2024-05-20 | −22% | **100%** | −21% | **no protection** |
| 2024-07-28 | −21% | **100%** | −21% | **no protection** |
| 2025-01-21 | −28% | **100%** | −28% | **no protection** |
| 2025-10-06 | −52% | 100% | −32% | reacted (45d to min exposure) |

**The model anticipated the 2021 crashes and did essentially nothing in 2023-2025.** Five consecutive
20-28% drawdowns passed with 100% exposure at the peak and T9's drawdown within 1pp of BTC's. The
2025-26 crash was *reacted to*, not anticipated — 0 days of lead, 45 days to reach minimum exposure —
which still helped (−32% vs −52%) but by a different mechanism.

This is condition 4, and it fails clearly.

## TEST 2 — but the core claim holds: low exposure genuinely precedes worse risk

| exposure | n | fwd 30d | fwd 60d | fwd 90d | **fwd 90d maxDD** |
|---|---|---|---|---|---|
| 0-20% | 406 | +0.7% | +3.7% | +5.2% | **−21.9%** |
| 40-60% | 355 | +1.5% | +3.2% | +2.9% | −18.1% |
| 80-100% | 1,428 | +6.1% | +13.1% | +23.0% | **−12.2%** |

Forward drawdown is **monotone** in exposure. When the model de-risks, the next 90 days really are
riskier. *(The 20-40% and 60-80% buckets are empty by construction — T9 exposure takes only three
values.)*

## TEST 3/5 — event study on ≥30% drawdowns

| peak | BTC loss | exp at peak | days to min exp | loss avoided | lead days |
|---|---|---|---|---|---|
| 2021-04-13 | −53% | 0% | 0 | 22pp | 27 |
| 2021-11-08 | −77% | 0% | 0 | **104pp** | 22 |
| 2025-10-06 | −52% | 100% | 45 | 20pp | **0** |

**Real mean loss avoided +48.8pp against random timing's +13.4pp, p=0.000.** Two of three were
anticipated with 22-27 days of lead; the third was not anticipated at all.

## TEST 4 — false alarms are cheap, and mostly not costly at all

| continuation | n | mean upside sacrificed |
|---|---|---|
| ordinary <10% | 12 | **−2.78pp** (i.e. a gain) |
| strong 10-30% | 11 | −0.77pp (a gain) |
| parabolic >30% | 6 | **+2.33pp** (a real cost) |

Net across 29 episodes: **−27.8pp — being early was net beneficial.** Cash yield plus avoided
volatility more than compensated except during parabolic continuations, which is where the cost is
concentrated and where T9's 2021 miss came from.

## TEST 6 — placebos collapse. This is the strongest evidence the signal is real.

| | Calmar | maxDD | CAGR |
|---|---|---|---|
| **real T9** | **1.74** | **−40.4%** | 70.4% |
| A shuffled probabilities | 0.35 | −70.8% | 23.8% |
| B permuted weights | 0.34 | −70.4% | 23.3% |
| C block-shuffled (30d) | 0.36 | −71.3% | 24.6% |

Exposure distribution and turnover identical; **only timing changed**, and the entire benefit
disappears. Generic exposure reduction explains none of it.

## TEST 7 — no magic threshold

| rule | CAGR | maxDD | Calmar |
|---|---|---|---|
| p>0.20 | 76.5% | −30.3% | **2.52** |
| p>0.25 | 69.2% | −32.7% | 2.12 |
| **p>0.30 (T9)** | 70.4% | −40.4% | 1.74 |
| p>0.35 | 71.8% | −36.2% | 1.98 |
| p>0.40 | 65.8% | −46.4% | 1.42 |

Every threshold beats buy-and-hold's 0.48 by a wide margin, and **T9's own 0.30 is not the best** —
0.20 scores 2.52. The result is not perched on a tuned value. *(Noted, not acted on: selecting 0.20
now would be exactly the post-hoc tuning this vault forbids.)*

## TEST 8 — contribution is concentrated (condition 6 fails)

| regime | BTC | T9 | BTC dd | T9 dd | avg exp | log-return share |
|---|---|---|---|---|---|---|
| 2020 bull | +582% | +405% | −25% | −16% | 61% | 51.0% |
| 2021 bull | +3% | −6% | −53% | −34% | 36% | −1.9% |
| 2022 bear | −76% | **+28%** | −76% | −14% | 43% | 7.7% |
| **2022-25 recovery** | +666% | +469% | −28% | −28% | 90% | **54.8%** |
| 2025-26 bear | −51% | −31% | −52% | −32% | 91% | −11.6% |

One regime supplies **54.8%** of total log return, above the 50% limit. Though note the two largest
contributors are both *bull* regimes where the overlay simply stayed invested — the crash protection
itself (2022 bear, +7.7%) is a small share of return while being most of the drawdown benefit.

## Conclusion

**The signal is real.** Placebos collapse from 1.74 to ~0.35 with identical exposure distribution and
turnover; forward drawdown is monotone in exposure; the event study beats random timing at p=0.000;
and nothing depends on a tuned threshold.

**But its protection is not consistently delivered.** It anticipated 2021, reacted to 2025, and did
nothing at all through five drawdowns of 20-28% in 2023-2025. An investor holding it through
2023-2024 would have received no benefit and paid the turnover.

**The honest characterisation:** T9 is a genuine but *episodic* risk signal — it fires well before
large regime-level crashes and is blind to ordinary 20% corrections. That is a defensible thing for a
crash model to be (its target is a 10% drawdown in 10 days, and the 2023-24 declines were slower),
but it must be stated, because "cuts drawdown from −76.6% to −40.4%" implies a consistency the
per-episode table does not support.
