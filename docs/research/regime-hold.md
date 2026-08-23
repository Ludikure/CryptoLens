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
