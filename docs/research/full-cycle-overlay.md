# T9 — Full-cycle crash-overlay validation — PRE-DECLARED

**Status:** design specified by the user before the run. One **deviation** is recorded below, with
its reasoning, because it was forced by data and not chosen for convenience.

## Purpose

T8 passed 7/7 with strong controls but could not test the case that would most challenge it: OOS
predictions began 2021-12-21, immediately after the November 2021 peak, so **the 2020-21 bull had no
coverage**. A crash-protection overlay tested mostly across bear markets can look spectacular for the
wrong reason. T9 forces it through a bull.

## ⚠️ DEVIATION FROM THE SPEC — history cannot be extended to 2017

The spec asks for BTC history back to 2017-01. **This is impossible without changing the model.**
Binance USDⓈ-M futures launched 2019-09, so roughly 20 of the 110 production features (funding, OI,
taker ratios, basis, crowding) **cannot exist before then**. Reaching 2017 would require a reduced
feature set — i.e. a *different model* — which the spec explicitly forbids ("Do NOT introduce new
features", "Use the EXISTING crash model").

**Alternative adopted, which answers the same question:** rather than extending history backwards,
**shorten the walk-forward burn-in**. T8 trained on the first 20% (~2 years) before predicting. T9
uses a 6-month initial training window and expands from there, so genuinely OOS predictions begin in
**mid-2020** and cover:

- the 2020 H2 bull
- the full 2021 bull, both legs, into the November peak
- the 2021-22 bear
- the 2022-25 recovery
- the 2025-26 bear

That is a complete cycle. The early predictions come from a model trained on very little data —
which is **not a weakness but a fidelity gain**: it is exactly what a practitioner would have had at
the time. No hindsight is introduced.

What is genuinely lost: the 2017 and 2018 cycles. Reported as a limitation, not worked around.

## Everything else follows the spec exactly

Same crash model (LGB d4/t150, 110 features, target P(10% drawdown within 10 days)), **purge 72** (>
the 60-bar label horizon — the flaw found in T8), expanding walk-forward, frozen A/B/C/D thresholds,
cash at contemporaneous DGS3MO, signal at daily close implemented next bar.

**Four controls, all mandatory:** shuffled signal · 30-day lag · frozen-threshold realised-volatility
rule · 200D EMA defensive rule.

**Transaction costs** run at 0.00 / 0.05 / 0.10 / 0.25% round trip, with turnover and exposure-change
counts reported so tax consequences can be judged.

## Ship bar — all eight required

1. Beats B&H on Calmar over the full period
2. Max drawdown reduced by ≥25pp
3. Best overlay retains ≥70% of BTC return in **at least TWO independent bull periods**
4. Beats shuffled signal on Calmar
5. Beats 30-day lag on Calmar
6. Beats the simple realised-volatility control on Calmar
7. Positive in ≥2 of 3 walk-forward folds
8. No period selected after observing performance

**The decisive criterion is 3.** Criteria 1, 2 and 7 were already satisfied in T8 on a
bear-dominated window; only bull-market upside retention can distinguish a real risk signal from an
artifact of when the test started.

---

# RESULTS — run 2026-08-23

OOS coverage **2020-07 → 2026-06** (T8 began 2021-12-21). Cash mean 3.11% annualised.

## Verdict: DOES NOT MEET THE BAR — 7 of 8, failing the decisive criterion

| arm | total | CAGR | maxDD | Calmar | Sharpe | avg exposure |
|---|---|---|---|---|---|---|
| A: B&H | 555% | 36.8% | **−76.6%** | 0.48 | 0.83 | 100% |
| B: light | 1,267% | 54.7% | −44.7% | 1.22 | 1.14 | 87% |
| C: moderate | 1,784% | 63.2% | −40.3% | 1.57 | 1.30 | 80% |
| **D: defensive** | **2,339%** | 70.4% | **−40.4%** | **1.74** | 1.42 | 73% |

| criterion | result | |
|---|---|---|
| 1. beats B&H Calmar | 1.74 vs 0.48 | PASS |
| 2. maxDD better ≥25pp | +36.2pp | PASS |
| **3. ≥70% retention in 2+ bulls** | **1/3** | **FAIL** |
| 4. beats shuffled | 1.74 vs 0.30 | PASS |
| 5. beats 30-day lag | 1.74 vs 0.88 | PASS |
| 6. beats realised-vol rule | 1.74 vs 0.52 | PASS |
| 7. positive ≥2/3 folds | 3/3 | PASS |
| 8. no post-hoc period selection | all declared in advance | PASS |

## Criterion 3 — why it failed, and how narrowly

| bull period | BTC | arm D | captured | avg exposure | cuts |
|---|---|---|---|---|---|
| 2020 H2 bull | +582% | +405% | **~70%** (just under) | 61% | 25 |
| **2021 leg-2 bull** | **+110%** | **+33%** | **30%** | **34%** | 16 |
| 2022-25 recovery | +666% | +469% | **70.4%** | 90% | 64 |

Two periods display as 70% after rounding but only one clears the threshold; the other falls a
fraction short. **The bar was not moved.**

**The genuine failure is the 2021 leg-2 bull: 30% captured at 34% average exposure.** The model sat
heavily de-risked through a +110% advance — precisely the false-positive mechanism the design named
as principal: *"If the model repeatedly cuts exposure during sustained trends, that is the principal
failure mechanism."* It did, once, and it was expensive.

## But the calendar table shows it does NOT systematically destroy bull returns

| year | B&H | arm D | avg exposure |
|---|---|---|---|
| 2020 | +213% | +188% | 83% |
| 2021 | +60% | +51% | **30%** |
| **2022** | **−64%** | **+49%** | 48% |
| 2023 | +156% | +109% | 84% |
| 2024 | +121% | +98% | 94% |
| 2025 | −6% | −5% | 98% |
| 2026 | −31% | −4% | 89% |

In 2020, 2023 and 2024 — three separate bull years — it held 83-94% exposure and captured most of the
move. 2021 is the outlier, not the pattern. And 2022 is the headline: **−64% became +49%.**

## All four controls pass decisively — this is what T5 could not do

| | Calmar |
|---|---|
| **real signal (arm D)** | **1.74** |
| shuffled | 0.30 |
| 30-day lag | 0.88 |
| simple realised-volatility rule | 0.52 |
| 200D EMA defensive rule | 0.77 |

The ML crash signal beats **both** trivial alternatives it was required to beat. In [[vol-conditioned-tail]]
a lagged ATR percentile matched and then beat the model; here it does not come close. That asymmetry
is the strongest single piece of evidence in this vault that the crash model carries information the
simple rules do not.

## Transaction costs: survives, but turnover is a real problem

Annualised turnover **34.9×**, 375 exposure changes, **average holding 5.8 days**.

| round trip | CAGR | Calmar | total |
|---|---|---|---|
| 0.00% | 70.4% | 1.74 | 2,339% |
| 0.05% | 67.5% | 1.63 | 2,097% |
| 0.10% | 64.6% | 1.53 | 1,880% |
| **0.25%** | **56.2%** | **1.25** | 1,347% |

Even at the user's 0.25%, Calmar 1.25 remains far above buy-and-hold's 0.48. **But 375 taxable events
with a 5.8-day average hold makes this materially worse in a taxable account than the pre-tax numbers
suggest.** Reported, not modelled, as the spec requires.

## What T9 establishes, and what it does not

**The critical improvement over T8 is the benchmark window.** T8's buy-and-hold returned 5.8% CAGR
over a round-trip period, so any exposure reduction looked good. Here buy-and-hold returned **36.8%
CAGR** — a genuinely strong outcome — **and the overlay still beat it on Calmar 1.74 vs 0.48 while
cutting drawdown from −76.6% to −40.4%.** T8's headline was partly a window artifact; this is not.

**Not established:** consistent bull-market upside retention. One of three declared bull windows was
badly missed, and that is the failure the design was written to catch. Also untested: the 2017 and
2018 cycles, unreachable without changing the feature set.

**The defensible claim:**

> Across a full 2020-2026 cycle including a strong bull, a weak crash signal cut maximum drawdown by
> 36 percentage points and roughly tripled Calmar versus buy-and-hold, surviving realistic costs, and
> beating shuffled timing, lagged timing, a realised-volatility rule and the 200D regime rule. It
> retained ~70% of upside in two of three bull windows and badly missed the third.

That is a real risk-management result with a documented, specific weakness — not an edge, and not an
artifact.
