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
