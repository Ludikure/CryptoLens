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

---

# RESULTS — run 2026-08-23. **All four fail. No bar was moved.**

## T1 — multi-asset trend: FAIL (0 of 3 criteria)

29 instruments, 2,178 days. **The diversification premise was confirmed** — mean pairwise
correlation **0.621 (crypto-only) → 0.324 (full universe)**, and max drawdown improved from −75.2%
to −41.3%. The mechanism worked exactly as intended.

|  | total | CAGR | maxDD | Sharpe | Calmar |
|---|---|---|---|---|---|
| **T1 multi-asset + volTarget** | **−11%** | −1.9% | −41.3% | **−0.06** | −0.05 |
| ctrl: multi-asset, no volTarget | 54% | 7.5% | −55.8% | 0.39 | 0.13 |
| ctrl: crypto-only + volTarget | 465% | 33.7% | −75.2% | 0.77 | 0.45 |
| bench: equal-weight buy & hold | 340% | 28.2% | −50.0% | **0.91** | 0.61 |

**Diversification bought a smoother ride and destroyed the return.** The controls localise why:
inverse-volatility sizing moves capital toward whatever is *quiet*, and quiet is not the same as
profitable. Bonds and equity sectors received most of the weight and did not trend profitably over
2020-2026 (a period containing a historic bond drawdown), while crypto — where the trend signal
actually paid — was down-weighted for being volatile. Crypto-only + volTarget beat the diversified
version outright.

Bear behaviour still worked: 2022 −16.9% vs B&H −47.5%; 2025-26 **+3.3% vs −32.5%**.

**Limitation, stated plainly and not as an excuse:** this is a *shallow* multi-asset universe.
Thirteen of the seventeen ETFs are US equity beta (9 sectors + 4 indices), leaving two bond ETFs,
one commodity and one volatility product. That is not the 50-100 genuinely uncorrelated markets a
real CTA runs — no FX, no international rates, no energy/metals/ags. **The negative result is
therefore weaker evidence than the instrument count suggests**, and a proper test needs a real
futures dataset. Six years is also short for a strategy evaluated over decades.

## T2 — crash probability: FAIL, narrowly, and it is the most useful of the four

870,093 bars, base rate 40.9%.

| folds | mean AUC |
|---|---|
| 0.645 / **0.617** / 0.650 | 0.637 |

Bar required **>0.65 in ALL folds**; fold 2 came in at 0.617.

**But the reliability curve is cleanly monotone**, which is what actually matters for using it:

| predicted | actual crash rate | n |
|---|---|---|
| 0.0–0.1 | **24.5%** | 19,185 |
| 0.1–0.2 | 31.8% | 60,990 |
| 0.2–0.3 | 32.3% | 100,916 |
| 0.3–0.5 | 38.5% | 186,688 |
| 0.5–1.0 | **45.4%** | 154,277 |

So downside risk **is** partially predictable — a bar in the bottom bucket carries roughly half the
crash rate of one in the top bucket. It missed a bar calibrated against `goodR`'s 0.674, but a
monotone risk gauge does not need to beat a return model to be useful for sizing. **This is the one
worth revisiting**, with a bar justified by its actual use (de-risking) rather than by parity with an
unrelated model.

## T3 — conditional direction: FAIL, after catching two of my own errors

**This test initially reported a PASS. Both apparent findings were artifacts, and the corrections
are the most valuable output here.**

**Error 1 — wrong null.** The test compared each state against 50%. The unconditional P(up24) in
this dataset is **48.18%**, not 50% (returns are right-skewed, so the median bar is slightly down).
Against the correct null, the two "survivors" collapse:

| state | vs 50% | **vs true base** |
|---|---|---|
| weekend | −3.1pp | **−2.2pp** — below the 3pp threshold |
| extreme RSI | −3.3pp | **−2.4pp** — below the threshold |

A different state then appeared to pass: **BTC-alt divergence, +3.7pp at p=1.46e-42**, strengthening
to +4.9pp on the untouched holdout.

**Error 2 — non-independent observations.** `ethBtcDelta6` is a single market-wide series, so the
state fires on every symbol simultaneously. The 34,821 "observations" are **684 distinct
timestamps** — 50.9 symbols each. Collapsing to independent time points:

| | raw | corrected |
|---|---|---|
| n | 34,821 | **684** |
| deviation | +3.7pp | **+2.36pp** |
| p | 1.46e-42 | **0.081** |

Against a Bonferroni α of 0.00625, **it does not survive**. (Weekend, same correction: −1.83pp,
p=1.98e-03 — clears the α but not the 3pp effect-size threshold.)

**Direction remains a coin flip, now including conditionally.** And the episode is a live
demonstration of why the pre-declared thresholds exist: without the 3pp effect-size floor and the
holdout, error 1 alone would have shipped two false findings with p-values in the e-88 range.

## T4 — dynamic R:R: FAIL (0 of 3 folds)

864,683 bars. Modelled E[MFE] and E[MAE] per bar, then selected the R:R maximising predicted net EV.

| arm | mean net R | folds |
|---|---|---|
| fixed 1:2 | +0.0212 | +0.094 / +0.021 / −0.051 |
| fixed 1:3 | +0.2229 | +0.301 / +0.223 / +0.145 |
| **fixed 1:5 (current design)** | **+0.4261** | +0.507 / +0.427 / +0.345 |
| fixed 1:8 | +0.5312 | +0.613 / +0.534 / +0.446 |
| **DYNAMIC** | **+0.0911** | +0.148 / +0.127 / −0.001 |

Dynamic selection loses to the fixed benchmark in **every fold**. The mechanism is regression to the
mean: predicted MFE is smoothed toward the average, so the model rarely forecasts a large excursion
and therefore keeps choosing tight targets — which the same table shows are the worst option.
**Payoff structure should be fixed and wide, not predicted.**

*Caveat on the absolute numbers:* excursions here come from closes, not highs/lows, which understates
MAE and therefore under-triggers stops. All arms inherit the bias equally so the ranking holds, but
these are not tradeable magnitudes — the OHLC-based +0.151R gross / −0.008R net from
[[strategy-breakeven]] remains the trustworthy absolute. **The apparent "1:8 beats 1:5" is suspect
for the same reason** and should not be acted on without an OHLC re-run.

---

## What these four add to [[what-we-tried]]

- **Mode 1 extends to conditional direction.** Eight extreme states, none survive correction.
- **A new lesson: check the null and check independence.** Both errors in T3 produced
  overwhelming-looking p-values. Test against the *unconditional base rate*, and collapse market-wide
  states to distinct timestamps before counting evidence.
- **Diversification is not free.** It worked mechanically (correlation halved, drawdown cut by 34pp)
  and still destroyed the return, because inverse-vol sizing allocates to quiet assets rather than
  profitable ones.
- **T2 is the one genuinely worth another pass**, on a bar tied to its actual use.
