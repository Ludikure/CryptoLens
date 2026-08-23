# Multi-month regime holds — PRE-DECLARED DESIGN

**Status:** design frozen 2026-08-23, BEFORE any multi-symbol result. A single exploratory BTC probe
was run first (recorded below as PRIOR EVIDENCE) — that probe is not the test.

**Origin:** user observation that BTC fell 125,986 → 58,248 (−53.8% over 261 days) and "anyone who
entered a short and waited made a fortune", against a vault in which every direction test returns a
coin flip.

## Why every prior direction test missed this — the arithmetic

Measured on the actual decline: per-4H drift **−0.0098%** against noise of **0.701%**. A
drift/noise ratio of **0.014**, and **50.6%** of bars down. Every direction primitive in the vault
would correctly report a coin flip — and be blind to a 54% move, because the edge lives in
COMPOUNDING a tiny bias over 6,284 bars, not in calling any one of them.

**Every horizon in this project is 24h, and the longest anything reaches is 72h.** The graveyard's
trend-following rejection ([[rejected-hypotheses]], 2026-07-02) measured *forward 24h EV on mature
trends* — a different question, and it does not cover this.

## Why the fee mathematics finally work

The structural reason every prior strategy died is turnover. The BTC probe made **89 position
changes in 6.4 years** = **8.9% total fee drag** at 0.10% round trip. Compare the mixed-gate test
just rejected: 251,880 trades. Fees are the binding constraint on everything short-horizon and are
nearly irrelevant here. **This is the first hypothesis tested with a favourable cost structure.**

Additional uncounted upside: on perps a short RECEIVES funding while funding is positive, which is
the normal crypto state. Over a 261-day hold that is material carry — this test will count it.

## PRIOR EVIDENCE (exploratory BTC probe, not the test)

200D EMA + 20-day slope; short below a falling EMA, long above a rising one, flat otherwise; act on
the prior day's signal.

| | |
|---|---|
| during the −54% decline | **+23.5%** (short 86% of days) |
| full period net | +339% |
| buy & hold | **+571%** |
| max drawdown | **−70.8%** |

So it captured the bear and **underperformed buy-and-hold overall**, with a brutal drawdown. Real
but not obviously good — which is exactly why it needs a proper test rather than a verdict.

## Design

- **Universe:** the 12 crypto symbols with full 2019+ history (BTC, ETH, SOL, XRP, ADA, DOGE, BNB,
  DOT, AVAX, LINK, LTC, UNI). Per-symbol signals, equal-weight portfolio.
- **Data:** `csv_exports_v14` prices + Vision klines through 2026-08.
- **Signal:** price vs 200D EMA with a 20-day slope filter, acting on the PRIOR day's close. No
  parameter sweep in this test — 200/20 is the value already in the app's crypto-bear-regime flag,
  so it is inherited, not fitted. A sweep would be a separate experiment.
- **Costs:** 0.10% round trip per position change, plus **funding**: shorts receive / longs pay the
  realised funding rate from `fundingRateRaw`, accrued daily.
- **Walk-forward:** 3 expanding folds, and the 2022 bear and 2025-26 bear reported separately.
- **Benchmark:** buy-and-hold the same equal-weight basket, same costs.

## Ship bar — declared now

To justify building multi-month regime holds into the product:

1. **Net-of-funding return beats buy-and-hold** on the full period, AND
2. **Max drawdown is lower than buy-and-hold's**, AND
3. It is **positive in the bear folds specifically** (that is the capability being bought), AND
4. Position changes stay under **50 per symbol per 6 years** (a fee-light hold, not a trend system
   in disguise).

Criterion 2 matters as much as 1: a strategy that matches buy-and-hold's return at half the drawdown
is worth building; one that beats it while losing 70% is not something a single user can hold.

**Pre-registered expectation:** roughly even. The probe underperformed on return but that was
long-only-equivalent exposure in a bull-dominated sample; the honest question is whether SHORT
capability plus funding carry closes the gap. If it fails, the finding is still valuable — it would
mean the product's inability to express a multi-month view is an accepted limit, not an oversight.

## Explicitly out of scope

- **Parameter tuning.** 200/20 is inherited from production. Sweeping would manufacture a fit.
- **Direction at short horizons.** Settled, coin flip. This test is about compounding, not calling.

---

## RESULTS

Run 2026-08-23 (`ml-training/regime_hold_test.py`). 12 symbols, 2,152 portfolio days
(2020-08-08 → 2026-06-29), funding counted.

### Verdict: DOES NOT MEET THE BAR — 1 of 4 criteria passed

|  | total | CAGR | maxDD | Sharpe |
|---|---|---|---|---|
| REGIME (with funding) | 325% | 27.9% | −81.8% | 0.70 |
| REGIME (no funding) | 497% | 35.4% | −78.0% | 0.78 |
| **buy & hold** | **561%** | **37.8%** | −82.5% | **0.80** |

| criterion | result | |
|---|---|---|
| 1. beats buy & hold | 325% vs 561% | **FAIL** |
| 2. lower max drawdown | −81.8% vs −82.5% | PASS (trivially) |
| 3. positive in both bear folds | 2022 −9.7%, 2025-26 +74.7% | **FAIL** |
| 4. <50 position changes/symbol | median 81, max 112 | **FAIL** |

### But the user's specific claim is VALIDATED, and strongly

| | regime | buy & hold | spread |
|---|---|---|---|
| **2025-26 bear** (the one asked about) | **+74.7%** | −67.8% | **+142pp** |
| 2022 bear | −9.7% | −80.3% | +71pp |

The move from 125,986 → 58,248 **was** capturable, and not marginally: a rule already present in the
codebase, acting only on the prior day's close, turned a −68% basket into +75%. The observation that
prompted this test was correct.

### Why it still fails: it gives it all back in the chop

| fold | regime | B&H | |
|---|---|---|---|
| 1 (2020-08 → 2022-07) | +423.9% | +392.4% | win |
| 2 (2022-07 → 2024-07) | **−37.9%** | +102.2% | **lose badly** |
| 3 (2024-07 → 2026-06) | +30.8% | −33.6% | win |

This is the classic trend-following signature: wins in sustained moves, bleeds in range-bound
recovery. Fold 2 alone erases the bear-market gains. **It is not a standalone strategy; it is
regime-conditional insurance — you pay premiums in chop and collect in crashes.**

### The prediction I got wrong: funding HURTS, by 34.6pp

Before running this I argued that a multi-month short would earn carry, since funding is normally
positive and shorts receive it. **The measured contribution is −34.6pp — it made the strategy
materially worse.** The reason is a correlation I did not think through: funding is highest exactly
during bull runs, which is when this strategy is LONG and paying it. The carry the shorts collect in
bears is smaller than the carry the longs pay in bulls. Recorded here because it was a specific,
falsifiable claim made in advance and the data refuted it.

### The structural problem, stated plainly

12 crypto symbols is not a portfolio. They correlate 0.7–0.9 with BTC, so this is one bet held
twelve times — which is why the drawdown is −82% and the fold variance is enormous. Real
trend-following systems run dozens of *uncorrelated* markets to smooth exactly this. That
diversification is not available inside a crypto-only universe, and it is the reason this shape of
strategy struggles here specifically.

### What survives, as a NEW hypothesis needing its own pre-declaration

Fold 2's damage comes from being SHORT during a recovery. The obvious variant — **go FLAT rather
than short in bear regimes** — would keep the "don't hold through a crash" benefit while removing
the whipsaw cost. That is a risk-management rule, not an alpha rule, and it is a different claim
from the one tested here. **It is not tested in this document, and choosing it after seeing these
folds would be fitting.** It needs its own frozen design → [[regime-flat-defensive]].
