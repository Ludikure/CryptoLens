# What we tried, and why it didn't work

**A complete account of every strategy and feature tested in MarketScope, 2026-04 → 2026-08.**

This is the synthesis layer over the research vault. Each entry names what was asked, how it was
tested, what came back, and why it failed. Detailed designs live in the linked notes; the raw
graveyard is [[rejected-hypotheses]]; methodology is [[edge-methodology]].

> **If you are a future session:** read §2 (the failure taxonomy) before proposing anything. The six
> modes recur, and most new ideas are a member of a category already closed.

---

## Contents

1. [The headline result](#1-the-headline-result)
2. [Six ways a hypothesis dies](#2-six-ways-a-hypothesis-dies)
3. [The data and the discipline](#3-the-data-and-the-discipline)
4. [Part I — Direction](#4-part-i--direction-the-central-question)
5. [Part II — Features](#5-part-ii--features-added-and-tested)
6. [Part III — Strategies end-to-end](#6-part-iii--strategies-tested-end-to-end)
7. [Part IV — What survived](#7-part-iv--what-actually-survived)
8. [Part V — Methodology lessons](#8-part-v--methodology-lessons)
9. [Part VI — What remains untested](#9-part-vi--what-remains-genuinely-untested)
10. [Appendix — script and note index](#10-appendix--script-and-note-index)

---

## 1. The headline result

Around twenty hypotheses tested against **870,000 bars** spanning **77 crypto symbols** and **159
stocks** over six and a half years, using purged walk-forward validation with ship criteria declared
in writing before each result was computed.

**Three findings, in order of importance:**

1. **Direction is not predictable** from public OHLCV-derived features at any horizon tested, from 4
   hours to 30 days. Twelve primitives, two dedicated models, and six strategy formulations all
   return ~50%.
2. **Volatility partly is.** The production models hold walk-forward AUC 0.674 (crypto) and 0.686
   (stocks), with calibration that survives live forward grading. This is a genuine, exploitable
   regularity — it just answers *how big*, never *which way*.
3. **The only strategy that survived cost analysis requires no forecast at all** — and it is capital-
   constrained to the point of impracticality below roughly $100k.

**In every head-to-head comparison run, the best-performing strategy was buy and hold** (561% over
the tested period, against the best active alternative's 325%).

---

## 2. Six ways a hypothesis dies

Grouping by failure mode rather than by date is the single most useful thing in this document,
because the modes recur. Given a new idea, identify its mode first — it usually predicts the outcome
before any compute is spent.

### Mode 1 — The information is public, therefore it is already in the price

The dominant mode. It killed everything directional.

**Mechanism.** A price is the summary of what every participant concluded from the data they share.
Anything computable from free candles has been computed by millions of people and traded until it
stopped paying. It would be *surprising* if a public indicator predicted direction — that would mean
the market had failed to incorporate freely available information.

**What died here:** all 12 direction primitives, both dedicated direction models, level-rejection
direction, trend-following, cross-sectional momentum, and all six level-*strength* metrics.

**Diagnostic:** if the signal is computable by anyone with a charting package, expect ~50%.

**Status: CLOSED.** Do not test another indicator-derived directional signal.

### Mode 2 — Real signal, redundant with what the model already carries

**Mechanism.** Novel-feeling data is not novel *information*. Large trades, liquidations, volume and
ATR are four views of the same underlying quantity — activity. A model already carrying 110 features
has priced it.

| tested | standalone | incremental |
|---|---|---|
| Whale/large-trade flow (2yr Vision backfill, 5 symbols) | AUC ~0.57 — genuinely real | no variant passed the WF bar |
| Liquidation features (CandleFeed archive) | real | redundant vs volume/ATR/ADX/derivatives |

**Diagnostic:** always measure incremental AUC over the existing feature set. Standalone AUC is
nearly meaningless and is how enthusiasm gets manufactured.

### Mode 3 — Real effect, too small to survive costs

| tested | gross | at user's fees (~0.25% RT) |
|---|---|---|
| Tail-gated convex (1R stop / 5R target / 72h) | **+0.151R** | **−0.008R** |
| Trend-continuation | thin positive skew | below Binance fees |
| Level-rejection continuation | +0.005–0.059% | break-even needs ≤0.06% |

**Mechanism.** A round trip is a constant negative drift. A hundred trades a year at 0.25% costs 25%
of the account before the market moves at all. The convex strategy's break-even is a **0.238% round
trip**; Coinbase Intro-1 is ~0.25%. The edge was real, and the venue ate all of it.

**Diagnostic:** compute the break-even cost *first*. Within ~20% of your actual fee, stop.

### Mode 4 — Measurement artifact: the result was never there

The most dangerous mode, because these produce the most *exciting* numbers.

| artifact | apparent | corrected |
|---|---|---|
| **In-progress daily candle** | crypto direction **94.7%** at pUp≥0.70 | **~50%** |
| Day-of-week confound | Fed releases suppress volatility **−10.8pp at z=−10.4** | **−0.57pp** |
| Close-only path simulation | convex net +0.41R | inflated — misses intrabar stop hits |

**The leak is the defining episode of this project and deserves the full story.**
`marketscope-worker/scripts/runBacktest.ts` sliced the daily timeframe with
`sliceUpTo(dailyAll, evalTime)`, which **included the in-progress daily candle** at intraday 4H bars.
Daily features (`dRsi`, `dStochCross`, `dBBPercentB`…) therefore saw the remainder of the current
day — overlapping the 24h forward label they were being asked to predict. Live serving drops the
in-progress bar via `dropInProgress`; the backtest never did.

It was **crypto-fatal and stock-spared**: continuous 24/7 price means the leaked daily close ≈ the
forward price being measured, while overnight gaps decorrelate the two for equities. That asymmetry
is precisely why *"direction works for crypto but not stocks"* looked like a profound structural
finding for weeks. It was the signature of the bug.

Three independent confirmations: (a) the live forward test resolved **3/7 correct**, ~coin flip;
(b) clean-data direction is ~50% even at ML ≥ 85%; (c) the edge appeared in **every** non-overlapping
window — too consistent to be real. Fix: `sliceUpTo(dailyAll, evalTime - 86_400_000)`. Top
feature↔label correlation collapsed from 0.33 to ~0.00.

**Diagnostic:** a too-good number is a bug until proven otherwise.

### Mode 5 — Clean null: the effect simply is not there

| tested | pre-declared bar | actual |
|---|---|---|
| Policy-catalyst proximity (986 Fed releases 2020-26) | +3.0pp goodR lift, ≥5/7 years | **−0.8pp, 4/7** |
| Longer ML horizons (7d, 30d) | AUC +0.02 in all folds | **−0.057 / −0.067**, negative in every fold |
| ML_WIN as position size vs binary gate | beat gate on EV/unit AND Sharpe | lost in **0/3 folds** |

**The horizon result is the most important negative in the vault** and is treated in full in §4.5.

### Mode 6 — Real edge, wrong venue or wrong scale

| tested | works | but |
|---|---|---|
| Cash-and-carry funding harvest | 15.2% CAGR, −3.04% maxDD, Sharpe 6.0 | **measured on Binance — US-geoblocked** |
| Coinbase carry, textbook form | basis 12.5% annualized | spot fees ~0.40-0.60%/side consume it entirely |
| Coinbase carry, **covered** form | **~8% net on total capital** | needs ~$100k to yield $700/month |
| Selling 30d volatility, defined risk | BTC +1.37%/trade, worst year −2.0% | no retail options access |

**Mechanism.** An edge priced at a venue you cannot reach is not an edge. This happened **twice** —
July (the fee wall) and August (the carry measured on Binance funding).

**Diagnostic:** verify venue access and fee tier *before* measuring.

---

## 3. The data and the discipline

**Data.** `csv_exports_v14` (77 crypto symbols) and `csv_exports_v14_stocks` (159 stocks), 2020-01 →
2026-06, generated through `marketscope-worker/scripts/runBacktest.ts`. 110 features per bar.
Supplemented by free Binance Vision daily archives (klines, aggTrades, metrics), one month of
CandleFeed liquidation history, cached Deribit DVOL, and the project's own D1 archive.

**Discipline.** Every test in this vault follows the same protocol, and it is why the conclusions can
be trusted even where they are unwelcome:

- **Pre-declaration.** The ship criterion is written to a markdown note *before* the result is
  computed. When a result misses by a hair, it is recorded as a miss — see [[five-hypotheses]] H3,
  which failed on a 4pp margin against a tolerance that was admittedly arbitrary, and was not
  retroactively widened.
- **Purged walk-forward.** 3-fold expanding window with a 48-bar purge gap between train and test,
  daily downsampling, time-decay sample weighting.
- **Null controls.** Shuffled-target tests (which collapse to 50.1%, proving the pipeline can return
  chance), label-shift decay, and day-of-week stratification.
- **Live forward validation.** `direction_signals` and `ml_calibration` D1 tables grade predictions
  against realised outcomes on a rolling basis, independent of any backtest.

---

## 4. Part I — Direction, the central question

The app was built to answer *"which direction, and is there a setup?"* This section is the record of
that question being asked six different ways and answered the same way each time.

### 4.1 The twelve-primitive sweep

`ml-training/direction_primitive_sweep.py` tested twelve candidate direction signals: bias alignment,
`dStochCross`, `hStochCross`, `hMacdCross`, `dEmaCross`, `dStack`, `dDivergence`, the bias∩Stoch
intersection, the bias∪Stoch union, and variants.

**Result:** the union of bias OR dStochCross won on *total R captured* — but by firing more often at
essentially identical per-trade EV, not by being more accurate. Per-bar directional accuracy sat at
chance for every primitive.

**What this actually showed:** you can increase total exposure, not hit rate. The union shipped as
the notification gate for that reason, and remains there.

### 4.2 The crypto direction model — and the leak

A dedicated XGBoost head targeting `up = fwdReturn24H > 0`. Reported ~80% directional accuracy at
ML≥0.70 and **~94.7% at pUp≥0.70**, holding through the 2022 bear fold. It passed a leakage audit at
the time: max feature↔target correlation 0.273, label-shift decay 79.6→70.3→62.7→52.6→50.8%,
shuffled-target null 50.1%. Three kill-tests, all apparently clean.

**It was still a leak.** See Mode 4 above. The audit tested the wrong thing — it examined the
features' relationship to the label without questioning how the feature slice itself was constructed.

**Post-fix: ~50%.** The `pUp` head now returns `null` unconditionally in `ml-predict.ts`. The entire
2026-05-30 dual-gate direction architecture was retracted, along with every claim built on it.

### 4.3 The stock direction model

Same recipe, applied to equities. Selection accuracy 62.4% → **holdout 53.0%**, flat across all five
regime folds and actively *wrong* at pUp≥0.60. Never shipped. In hindsight this was the control that
should have raised suspicion about the crypto result rather than being explained away as a structural
market difference.

### 4.4 Level rejection → short-horizon direction

`ml-training/level_rejection_direction.py`. At each bar where a major S/R level was poked by the wick
and closed back away by ≥ a threshold, enter the continuation and measure 3–4 bars forward with a
full fee cost-curve.

**Result:** continuation hit-rate **50.1–50.4%** on both markets and both horizons, across 740k
crypto and 207k stock events (and again on the strict-wick subsets). Crypto support→LONG showed
+1.8pp, which is just the known upward drift, while resistance→SHORT was −1 to −1.7pp. Gross EV
+0.005–0.059% implies a break-even round trip of ≤0.06% against Binance's ~0.10%. Walk-forward: 0–2
of 6 positive folds.

### 4.5 Longer horizons — the most important negative

Tested 2026-08-23 ([[five-hypotheses]] H1). If direction is unpredictable at 24h, perhaps the
information simply lives further out — the 2025-26 decline took 261 days.

Targets: `fwdMaxFavR >= k` at 24h, 7d and 30d, with k scaled by √time (1.50 / 3.97 / 8.22 ATR) so
base rates stay comparable. Production config, 3-fold expanding walk-forward.

| horizon | threshold | base rate | folds | mean AUC |
|---|---|---|---|---|
| **24h (control)** | 1.50 ATR | 39.7% | 0.734 / 0.743 / 0.749 | **0.742** |
| 7d | 3.97 ATR | 52.1% | 0.677 / 0.689 / 0.685 | 0.684 |
| 30d | 8.22 ATR | 59.4% | 0.616 / 0.713 / 0.690 | 0.673 |

**Predictability decays with horizon** — −0.057 at 7d, −0.067 at 30d, negative in every fold.

**Why this reframes everything.** A 200D regime rule captured the 2025-26 decline handsomely
(+74.7% against buy-and-hold's −67.8%) — but *not by predicting it*. Longer moves are less
forecastable, not more. The rule works through **payoff structure**: cut losers, ride winners, no
forecast required. **Trend capture and trend prediction are different mechanisms, and only the first
is available.**

### 4.6 Why a 54% move is invisible to a direction test

Measured on the actual 2025-10-06 → 2026-06-25 decline (125,986 → 58,248, −53.8% over 261 days):

| | |
|---|---|
| per-4H drift | **−0.0098%** |
| per-4H noise (sd) | **0.701%** |
| drift/noise ratio | **0.014** |
| share of bars down | **50.6%** |

Every direction primitive would correctly call that a coin flip — and be blind to a 54% move. The
edge lives in *compounding* a tiny bias over 6,284 bars, not in calling any one of them. This
reconciles the two facts that seem contradictory: direction is a coin flip, *and* the bear market was
capturable.

---

## 5. Part II — Features added and tested

### 5.1 Whale / large-trade flow — REJECTED (Mode 2)

The `large_*` archive had a broken definition (0.5 *units* of the asset — ~$30k for BTC, cents for
DOGE-class alts, sampled from spot). Fixed to futures aggTrades at a fixed $100k notional, then
backfilled two years from Binance Vision for BTC/ETH/ADA/XRP/SOL.

Tested via `whale_feature_test.py` and a pre-declared `whale_feature_sweep.py` (alternative windows,
interactions, XGBoost, 72h target). **No variant passed the WF bar.** Standalone AUC ~0.57 — real,
but redundant with existing volume/ATR/ADX/derivatives features. Collector and backfill kept for
display context.

### 5.2 Liquidation features — REJECTED (Mode 2)

One month of CandleFeed per-event liquidation history. Same outcome: real but redundant.

**Not wasted, though.** The same purchase produced two results that *did* ship — see §7.

### 5.3 Level strength — REJECTED (Mode 1)

`level_validation.py` over **58,000 retests**. Six candidate strength metrics tested: test count,
flip role, timeframe, Fibonacci ratio, formation volume, volume-at-price. **None predict
hold-versus-break.**

Consequence: the WORN_Nx_distrust / FRESH_1x / FLIP_ROLE prompt tags were neutralised and the
`entry_at_worn_level_4+_tests` conviction downgrade removed. Snapping targets to levels was
separately measured to *lower* EV (a win-rate illusion).

**But the levels themselves survived** — see §7.

### 5.4 Policy/news catalysts — CLEAN NULL (Mode 5)

Design pre-declared in [[news-catalyst-test]] before any number was computed. `news_backfill.py`
reconstructed **986 Fed releases (2020-2026, 177 of them `monetary`)** from yearly press-release
archives, where the date is encoded in the URL.

Bar: +3.0pp goodR lift at 0-24h on FED_MONETARY with ≥5/7 positive years.
**Actual: −0.8pp, 4/7. NOT SUPPORTED.** Forward up/down excursions were symmetric (+2.71% vs
+2.50%), consistent with direction being a coin flip everywhere else.

**The trap inside this test is worth more than its result.** The naive comparison said Fed releases
*suppress* volatility: FED_ALL 0-24h **−10.8pp at z=−10.4** — exactly the kind of number that gets
written up as a discovery. It is entirely a **day-of-week artifact**. BTC goodR runs Mon 57.9% /
Fri 34.8% / Sat 24.6% / Sun 59.1% — a 34pp swing, consistent with `dayOfWeek` being crypto's top
permutation feature. Releases are dated on weekdays; a conservative end-of-day timestamp pushes the
measurement window onto Friday or Saturday, the two worst days. Day-of-week-stratified, the effect
vanishes to **−0.57pp**.

**Standing methodology rule: any event study on crypto must stratify by day-of-week before believing
an effect.** Every economic, regulatory and corporate calendar clusters on weekdays, so this artifact
is available in all of them.

### 5.5 Volume profile features — ablation neutral

Dropped and re-measured; the difference sat within noise. Retained for display and prompt context,
not because they earn their place in the model.

---

## 6. Part III — Strategies tested end-to-end

### 6.1 Complete comparison

| strategy | result | failure mode |
|---|---|---|
| Directional setups (original design) | direction ~50% | 1 |
| Tail-gated convex perps | +0.151R gross, **−0.008R net** | 3 |
| Buying volatility (straddles) | −0.1 to −1.4%/trade at *zero* friction | structural |
| Selling volatility, defined risk | +1.37%/trade BTC, 4/6 years | 6 |
| Regime hold (200D, short-capable) | 325% vs B&H 561%, −82% maxDD | chop |
| Defensive flat (never short) | 218%, maxDD −59.9% vs −87.8% | **missed bar by 4pp** |
| Cross-sectional momentum | **net −28.3%**, Sharpe −0.06 | 1 |
| Cash-and-carry, covered | ~8% net on total capital | 6 (scale) |
| **Buy and hold** | **561%** | **— beat everything** |

### 6.2 The convex strategy, in detail

The one strategy with a genuine, measured, walk-forward-validated gross edge.

Structure: 1R stop, 5R target, 72h horizon, direction-agnostic (fat tails make 5R outcomes more
frequent than a random walk predicts — 30% versus the theoretical 17%). On 20,053 tail-gated trades:
**gross EV +0.151 R/trade**, 5R win rate 11.8%, **break-even round trip 0.238%**.

Coinbase Intro-1 (~0.25%) yields **−0.008R** — just underwater. Any venue below ~0.20% round trip is
solidly positive; Hyperliquid at ~0.035% taker would flip it to +0.04–0.06 R/trade.

**The 11.8% win rate is the operational catch.** Roughly 88% of trades lose 1R, so it only works
traded mechanically and completely. Any discretionary skipping destroys it — which argues for
automation, and against a human ever running it.

### 6.3 Volatility, both directions

**Buying — REJECTED.** `options_straddle_test.py`, 4 years BTC/ETH. The vol-risk premium is positive
(implied − realised30d = +7.5 BTC / +3.7 ETH vol points), so buying vol is structurally −EV even at
*zero* friction. The "buy when vol is cheap" gate made it **worse**, because a HAR-RV forecast spikes
right after realised vol spikes, and vol mean-reverts.

**Selling — FAILED ITS BAR, but the economics are real.** Tested 2026-08-23. 30d straddle sold, loss
capped at 3× premium, 1% friction: BTC **+1.37%/trade, 62% win, worst year −2.0%, 4/6 positive
years**; ETH indistinguishable from zero (+0.04%).

**Design error acknowledged:** the bar required ≥5 of **7** calendar years, but DVOL history spans
only 6. It was unachievable as written. It missed either way (4 of 6), but the criterion was
malformed and that is recorded rather than quietly corrected.

### 6.4 Regime holds — the near-miss

Origin: the observation that the 2025-26 decline was enormously profitable for anyone who shorted and
held, against a vault in which every direction test returns a coin flip. Design pre-frozen in
[[regime-hold]].

Rule: short below a falling 200D EMA, long above a rising one, flat otherwise, acting on the prior
day's close. Inherited from the app's existing crypto-bear-regime flag — **not tuned**.

| | total | CAGR | maxDD | Sharpe |
|---|---|---|---|---|
| REGIME (with funding) | 325% | 27.9% | −81.8% | 0.70 |
| REGIME (no funding) | 497% | 35.4% | −78.0% | 0.78 |
| **buy & hold** | **561%** | 37.8% | −82.5% | **0.80** |

**Bear-market behaviour — the capability being bought:**

| | regime | B&H | spread |
|---|---|---|---|
| **2025-26 bear** | **+74.7%** | −67.8% | **+142pp** |
| 2022 bear | −9.7% | −80.3% | +71pp |

**But it gives it all back in the chop.** Fold 2 (2022-07 → 2024-07) lost 37.9% while buy-and-hold
made 102.2%. Classic trend-following: wins in sustained moves, bleeds in range-bound recovery.

**A prediction I made in advance and got wrong, recorded deliberately:** I argued a held short would
*earn* funding carry, since funding is normally positive and shorts receive it. Measured contribution:
**−34.6pp**. Funding is highest during bull runs, which is exactly when the strategy is long and
paying it. The carry collected in bears is smaller than the carry paid in bulls.

**The structural problem:** twelve crypto symbols is not a portfolio. They correlate 0.7–0.9 with
BTC, so this is one bet held twelve times — hence the −82% drawdown and enormous fold variance. Real
trend-following systems run dozens of *uncorrelated* markets precisely to smooth this. That
diversification is unavailable inside a crypto-only universe.

### 6.5 Defensive flat — closest of all

Same rule, but position ∈ {0, +1} — never short, on the theory that fold 2's damage came from being
short through a recovery.

| | total | CAGR | maxDD | Sharpe |
|---|---|---|---|---|
| **H3 defensive flat** | 218% | 19.5% | **−59.9%** | 0.63 |
| regime (short-capable) | 16% | 2.4% | −82.2% | 0.35 |
| buy & hold | 306% | 24.1% | −87.8% | 0.69 |

| criterion | result | |
|---|---|---|
| maxDD ≥15pp better | **+27.9pp** | PASS |
| return within 25% of B&H | 71% (needed 75%) | **FAIL** |

2025-26 bear: **−2.6%** against buy-and-hold's −66.5%. It does exactly what it was designed to do —
removes the crash — at a 29% cost in total return, where an arbitrary bar allowed 25%.

**Recorded as a failure because the bar was pre-declared.** It is the one worth re-running with a
justified return tolerance rather than a round number → [[regime-flat-defensive]].

### 6.6 ML_WIN as size rather than gate

1,035,036 simulated convex trades. Arms: binary gate at p≥0.70, size ∝ p, size ∝ p².

| arm | capital | net R/unit | Sharpe |
|---|---|---|---|
| **binary gate p≥0.70** | 97,486 | **+0.4098** | 1.253 |
| size ∝ p | 1,035,036 | +0.2126 | **2.045** |
| size ∝ p² | 1,035,036 | +0.2645 | 1.930 |

Neither sizing arm beat the gate on return per unit of capital, in any fold. **The existing binary
gate is the correct design** — concentrating capital in the top decile extracts more per unit than
spreading it.

**The trade-off the bar obscured:** sizing arms have far higher Sharpe (2.05 vs 1.25) because they
diversify across many more bars. Gate = more return per unit deployed; sizing = smoother ride.
Neither dominates. The bar demanded both, so nothing passed.

*Caveat:* absolute R here is inflated by close-only path simulation, which misses intrabar stop hits.
The OHLC-based +0.151R gross / −0.008R net remains the trustworthy absolute. The relative comparison
stands.

### 6.7 The cash-and-carry — the only survivor

**Why it was never tested before:** every prior strategy takes a DIRECTION at a SHORT horizon with
HIGH turnover. The carry does none of those. Long spot + short perp is delta-neutral, so **the coin
flip is irrelevant by construction**, and it is held for months, so turnover is near zero.

**Measured on Binance funding (12 symbols, 2020-08 → 2026-06):** CAGR 15.2%, max drawdown −3.04%,
Sharpe 6.00, median per-symbol annualised funding 15.7%, negative 17% of days.

Per calendar year: 2020 +8.0, 2021 **+46.3**, 2022 **−2.1**, 2023 +6.3, 2024 +12.5, 2025 +3.3,
2026 +20.6. Above the 200D it pays a median 11%; below it, 3.9%.

**Then Mode 6 struck.** Those are *Binance* rates, and Binance is US-geoblocked for this user — the
reason the backend runs behind gluetun. Measured directly at Coinbase instead:

Coinbase publishes no perp funding (`BIP-20DEC30-CDE` returns `funding_rate: ""`), but lists **dated**
nano futures on the same 0.01 BTC contract size, which price the carry *better* — the basis is locked
at trade time instead of floating.

| contract | price | basis | days | annualized |
|---|---|---|---|---|
| BIT-28AUG26-CDE | 77,570 | 0.26% | 4.9 | 21.5% |
| **BIT-25SEP26-CDE** | 78,195 | **1.07%** | 32.9 | **12.5%** |

**The verdict turns entirely on whether the spot leg must be bought:**

| | cost | net over 33d | annualized |
|---|---|---|---|
| buy spot + sell future | ~1.00% | +0.07% | **~0.8% — dead** |
| at taker spot rates | ~1.40% | −0.33% | **negative** |
| **sell future against BTC already held** | ~0.20% | **+0.87%** | **~10%** |

**So the carry fails in its textbook form and works only covered.** Coinbase retail spot fees
(0.40–0.60% per side) against a 1.07% basis consume the entire edge — the same wall that killed the
convex strategy.

**Why it works at all:** you are being paid for supplying something scarce — capital willing to be
locked up and bear margin risk so someone else can hold leveraged exposure. Convergence is
*contractual*, not predicted: the September contract settles against the index price, so the gap
closes whatever price does. It is underwriting, not forecasting.

**The risks that the Sharpe of 6.0 excludes:**
1. **Venue risk** — FTX is the reference case. A funding time series shows nothing; the position went
   to zero.
2. **Liquidation of the short leg.** The legs are not cross-margined. At Coinbase's ~28.9% overnight
   short margin rate, roughly a **29% rally** drains futures margin while the offsetting spot gain
   sits unreachable in another account. That converts a perfectly hedged position into a realised
   loss. **This is the only way the trade goes badly wrong, and it is controlled by cash cushion.**
3. **Capital scale.** ~$100k total capital for ~$700/month. At a $28k account, roughly $196/month —
   against T-bills at 4–5% risk-free with no operational burden. **Below ~$50k it is not worth the
   complexity.**

Monitoring shipped as `GET /basis` (read-only; no orders, no trade credentials).

---

## 7. Part IV — What actually survived

Not everything failed. And the *pattern* of what held up is coherent rather than random, which is
itself evidence the measurements are sound.

**The ML volatility model.** Crypto v14 LightGBM d4/t150: WF AUC **0.674** (folds
0.672/0.670/0.678), top-decile precision 76.6%, on 145,045 bars across 77 symbols. Stocks v14
XGBoost d5/t100: WF AUC **0.686** (0.678/0.687/0.693), top-decile 78.3%, 252,215 bars across 159
symbols. Calibration is monotone and survives live forward grading via the `ml_calibration` table.

| predicted | crypto actual | stock actual |
|---|---|---|
| 30-50% | 39.4% | 38.9% |
| 50-60% | 55.9% | 55.0% |
| 60-70% | 64.1% | 66.5% |
| **70-85%** | **75.9%** | **73.8%** |

**Support/resistance as locations.** +4.3pp hold rate over random lines across 58,000 retests, both
markets. The levels are real; only their *strength* is unrankable.

**The whale-trap warning, short side.** −18pp long-liquidation share across **25 distinct episodes**
(after collapsing consecutive days), 95% CI [−24.0, −12.9]pp, present in every year. The long side
came in at +4.8pp against a pre-declared +5.0pp bar — recorded as a failure, and the prompt wording
softened accordingly. **A failed test that improved the product.**

**Cascade zones.** Replicated 30–40× across 32 symbols.

**The binary ML gate at p≥0.70.** Beat both sizing alternatives on return per unit of capital in 3/3
folds. The current design is correct and should not be changed.

**The pattern is the finding.** Risk premia and volatility structure survive; directional forecasting
from public data does not. That is exactly what efficient-market reasoning predicts. If these results
were noise, they would not line up so neatly with theory.

---

## 8. Part V — Methodology lessons

These outlast every specific finding.

1. **Pre-declare the bar before computing the result.** It is why "missed by 4pp" is recorded as a
   failure instead of the tolerance quietly becoming 30%.
2. **A too-good number is a bug until proven otherwise.** 94.7% was a leak. −10.8pp was a day-of-week
   artifact. Both were exciting; both were wrong.
3. **Run the null controls.** Shuffled targets, label-shift decay, day-of-week stratification. The
   pipeline must be shown capable of returning 50% before its 76% means anything.
4. **Audit the data slice, not just the features.** The leak audit tested feature↔label correlations
   and passed — while the *slice construction* was the bug. Ask how each input was built.
5. **Measure incremental value over the existing feature set, never standalone.** Mode 2 exists
   entirely because of this.
6. **Compute break-even costs first.** Mode 3 is avoidable arithmetic.
7. **Verify venue access and fee tier before measuring.** Mode 6, twice.
8. **Stratify crypto event studies by day-of-week.** BTC goodR swings 34pp Monday to Saturday.
9. **A control that disagrees is information, not an inconvenience.** The stock direction model
   returning chance should have prompted suspicion of the crypto result, not a structural
   explanation for why they differ.
10. **Effort and edge are unrelated.** Analysing public data harder converges *faster* on "it's
    already priced." Good work does not make the answer better.

---

## 9. Part VI — What remains genuinely untested

Stated honestly, so a future session neither re-litigates closed categories nor assumes the space is
exhausted.

- **Order-flow microstructure** at sub-minute resolution. `depth_snapshots` exists but at ~20-minute
  cadence — far too coarse. Requires a tick feed and infrastructure not currently present.
- **On-chain flows** — wallet movements to exchanges ahead of sales.
- **Sequence models** on raw price paths rather than tree models on tabular features. Weak prior; the
  finance literature is not encouraging.
- **Defensive-flat with a justified return tolerance** → [[regime-flat-defensive]]. The one near-miss
  worth re-running.
- **Delisted-symbol behaviour.** ICX and STORJ (delisting 2026-09-03) will be the first non-survivors
  the dataset has ever held. **Keep them in training data** — stripping them would restore a
  survivors-only dataset and deepen a documented weakness.

Everything in Modes 1–6 is closed.

---

## 10. Appendix — script and note index

**Research notes:** [[edge-methodology]] · [[edge-direction-primitive]] ·
[[edge-crypto-direction-model]] · [[edge-stock-direction-rejected]] · [[live-validation]] ·
[[ml-model-versions]] · [[ml-additive-heads]] · [[strategy-targets-bands]] · [[strategy-levels]] ·
[[strategy-mixed-gate]] · [[strategy-breakeven]] · [[news-catalyst-test]] ·
[[liquidation-features]] · [[whale-trap-validation]] · [[liquidation-map]] ·
[[cascade-exhaustion]] · [[regime-hold]] · [[five-hypotheses]] · [[funding-carry]] ·
[[rejected-hypotheses]]

**Key scripts** (`ml-training/`): `direction_primitive_sweep.py` · `direction_model_compare.py` ·
`direction_leak_audit.py` · `edge_revalidate.py` · `level_validation.py` ·
`level_rejection_direction.py` · `trend_direction_test.py` · `strategy_breakeven.py` ·
`strategy_tail_test.py` · `options_straddle_test.py` · `whale_feature_sweep.py` ·
`liquidation_feature_test.py` · `news_backfill.py` · `news_catalyst_test.py` · `mixed_gate_test.py` ·
`regime_hold_test.py` · `h1_horizon_test.py` · `h2_h3_test.py` · `h4_h5_test.py`

---

## The bottom line

The app was built to answer *"which direction, and is there a setup?"* That question appears
unanswerable at the horizons it operates on, with data available to retail. What it became instead is
a **risk and discipline system that is honest about what it does not know** — measuring an 86.6%
auto-FLAT rate that, given everything above, is mostly the app being *right*.

**The cheapest thing in this project was the answer.** The expensive path would have been trading the
hypothesis: at 0.25% round trip on a $28k account, a hundred trades a year is ~$7,000 in fees alone
before coin-flip variance does its work. Months of that would have taught the same lesson far less
clearly, because luck and strategy are indistinguishable without the measurement infrastructure that
produced this document.
