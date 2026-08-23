# Four untested hypotheses — PRE-DECLARED DESIGNS

**Status:** frozen 2026-08-23, BEFORE any result. Written in one pass so no design is tuned with
knowledge of the others.

**Origin:** a 32-item strategy list was triaged against [[what-we-tried]]. Roughly a third was
already closed. These four are the genuinely untested items with a plausible mechanism, a tractable
data path, and a reason to think they attack a MEASURED weakness rather than proposing a new signal.

---

## T1 — Multi-asset trend portfolio with volatility targeting

**Why this is the strongest candidate.** [[regime-hold]] did NOT fail because trend-following
doesn't work — it captured the 2025-26 decline at +74.7% against buy-and-hold's −67.8%. It failed
because **twelve crypto symbols correlated 0.7–0.9 is one bet held twelve times**, producing an −82%
drawdown and enormous fold variance. Real trend systems run dozens of *uncorrelated* markets
precisely to smooth this. That is a structural fix to a measured cause, not a new prediction claim.

Volatility targeting (scaling position inversely to realised volatility) is folded in because it is
among the most replicated results in the trend-following literature and has never been tested here.

- **Universe:** 12 crypto + 17 ETFs = **29 instruments, 5 asset classes** (crypto, equity indices,
  equity sectors, bonds TLT/HYG, commodities GLD, volatility VXX). 2020-07 → 2026-06.
- **Signal:** continuous trend score = mean sign of price vs the 20/50/100/200-day EMAs, so a
  fully-aligned uptrend scores +1 and full disagreement scores 0. Not a single-EMA switch.
- **Sizing:** position ∝ trendScore / realised-vol(20d), gross exposure normalised to 1, per-asset
  cap 15% to prevent a single low-vol instrument dominating.
- **Costs:** 0.10% round trip on turnover. Rebalanced weekly.
- **Controls, both required:** the same engine on **crypto-only** (isolating diversification) and
  **without vol targeting** (isolating the sizing rule). Without these the test cannot attribute.
- **SHIP BAR:** Sharpe **> 0.8** AND max drawdown better than **−40%** AND positive in **≥2 of 3**
  expanding folds. (Crypto-only was Sharpe 0.35–0.70 at −82%; buy-and-hold crypto was 0.80.)
- **Expectation:** the drawdown should improve materially. Whether Sharpe clears 0.8 is genuinely
  open — diversification cuts volatility and return together.

## T2 — Crash-probability model

**Why:** the production target is `goodR` — a *favourable* excursion, direction-agnostic. Nothing has
ever modelled **downside** risk directly, yet that is what the defensive-flat rule actually needs and
what a user holding spot actually fears.

- **Target:** `P(max drawdown > 10% within the next 10 days)`, computed from closes.
- **Features/model/folds:** identical to production (110 features, LGB d4/t150, 3-fold expanding WF,
  48-bar purge). Inherited, not tuned.
- **SHIP BAR:** WF AUC **> 0.65 in ALL folds** (comparable to goodR's 0.674) AND a monotone
  reliability curve across predicted-probability buckets.
- **Second question, reported but not gating:** does de-risking on high predicted crash probability
  improve **Calmar** versus static exposure?
- **Expectation:** plausible. Volatility clusters and drawdowns cluster with it, so this may largely
  re-express the volatility edge — which the reliability curve will reveal.

## T3 — Conditional direction inside extreme states

**Why, and the danger.** Direction was tested GLOBALLY and returns ~50%. It has never been tested
*conditionally*. But this is **the highest-risk test in the vault**: slicing into eight states and
hunting for one where P(up) departs from 50% is textbook multiple testing — with eight states, one
will clear p<0.05 by chance. This is exactly how 94.7% felt before the audit.

Discipline is therefore declared up front and is not negotiable after the fact:

- **Eight states, named now:** extreme volatility (top 5% ATR percentile), extreme funding (top/bottom
  5%), extreme volume (top 5%), major S/R interaction (<0.25 ATR from a level), regime transition
  (barsSinceRegimeChange ≤ 3), weekend, extreme RSI (<20 / >80), BTC-alt divergence (top 5% |ethBtc
  6-bar delta|).
- **Test:** P(up) over the next 24h within each state, versus a 50% null.
- **Bonferroni:** α = 0.05 / 8 = **0.00625**. A raw p of 0.03 is NOT a finding here.
- **SHIP BAR:** at least one state with **p < 0.00625** AND **|P(up) − 50%| > 3pp** AND the **same
  sign in all 3 folds** AND surviving on a **holdout period the search never touched** (final 20%).
- **Expectation:** null. Recorded in advance so a marginal hit is not retrofitted into a discovery.

## T4 — Conditional payoff: model MFE/MAE, choose R:R dynamically

**Why:** the convex strategy uses a FIXED 1R stop / 5R target everywhere. [[five-hypotheses]] H1
showed capture works through payoff structure rather than prediction — so optimising the payoff
structure per-bar is the natural extension, and it needs no directional claim.

- **Method:** model expected forward MFE and MAE (in ATR units, 72h) from the existing features, then
  select the R:R from {1:2, 1:3, 1:5, 1:8} maximising predicted net EV per bar.
- **Costs:** 0.25% round trip, the user's actual fee.
- **Benchmark:** fixed 1:5, the current design.
- **SHIP BAR:** beats fixed 1:5 on **net EV per unit of capital** in **≥2 of 3** folds AND produces
  positive net EV in at least one fold (a less-negative loser is not a strategy).

---

## Scale caveat, applying to all four

A statistically real result here may still be untradeable. Modes 3 and 6 in [[what-we-tried]] have
already killed two validated edges on fees and venue access. T1 in particular would require futures
margin across several asset classes. **These are research questions about whether the mechanisms
survive, not proposals to trade next quarter**, and results must be reported that way.
