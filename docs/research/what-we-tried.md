# What we tried, and why it didn't work

**A synthesis of every strategy and feature tested in MarketScope, 2026-04 → 2026-08.**

This is the summary layer. Each entry links to the note holding the full design, numbers, and
pre-declared bar. For the raw graveyard see [[rejected-hypotheses]]; for methodology see
[[edge-methodology]].

---

## The one-paragraph version

Roughly twenty hypotheses were tested against 870,000 bars across 77 crypto symbols and 159 stocks,
using purged walk-forward validation with bars declared before each result was computed. **Direction
is not predictable from public OHLCV-derived features at any horizon from 4 hours to 30 days.**
Volatility partly is. The only strategy that survived cost analysis is one that requires no forecast
at all — and it is capital-constrained to the point of being impractical below ~$100k. The
best-performing strategy in every comparison run was **buy and hold**.

---

## Six ways a hypothesis died

Grouping by failure mode is more useful than grouping by date, because the modes recur and knowing
them lets you predict the outcome of a new idea before spending on it.

### 1. The information is public, therefore it is already in the price

The dominant failure mode, and the one that killed everything directional.

| tested | result |
|---|---|
| 12 direction primitives (bias, dStochCross, hStochCross, hMacdCross, dEmaCross, dStack, dDivergence, unions, intersections) | all ~50% |
| Dedicated crypto direction model | ~50% after the leak fix |
| Dedicated stock direction model | 62.4% selection → 53.0% holdout, flat across 5 folds |
| Level rejection → 3-4 bar direction | 50.1–50.4%, gross EV below fees, 0-2/6 folds |
| Trend-following, mature aligned trends | ~0% forward 24h EV, 47-49% hit rate at every trend age |
| Cross-sectional momentum (long top quintile / short bottom) | **negative gross**, net −28.3%, Sharpe −0.06 |
| Level *strength* — 6 metrics (test count, flip role, timeframe, Fibonacci ratio, formation volume, volume-at-price) | none predict hold-vs-break |

**Why:** your RSI is everyone's RSI. Any pattern computable from free candles has already been
computed by millions of participants and traded until it stopped paying. A price is the summary of
what the market collectively concluded from exactly this data. It would be *surprising* if a public
indicator predicted direction — that would mean the price had failed to incorporate free information.

**Implication:** do not test another indicator-derived directional signal. The category is closed.

### 2. Real signal, but redundant with what the model already has

| tested | standalone | after controls |
|---|---|---|
| Whale/large-trade flow (2yr Vision backfill, 5 symbols) | AUC ~0.57 — real | no variant passed the WF bar |
| Liquidation features (CandleFeed archive) | real | redundant with volume/ATR/ADX/derivatives |

**Why:** large trades, liquidations, volume and ATR are different views of the same underlying
quantity — activity. A model already carrying 110 features has priced that in. Novel-feeling data is
not the same as novel information.

**Implication:** measure incremental AUC over the existing feature set, never standalone AUC.

### 3. Real effect, too small to survive costs

| tested | gross | at user's fees |
|---|---|---|
| Tail-gated convex (1R stop / 5R target / 72h) | **+0.151R** | **−0.008R** |
| Trend-continuation | thin positive skew | below Binance fees |
| Level rejection continuation | +0.005–0.059% | break-even needs ≤0.06%, actual ~0.10% |

**Why:** a 0.25% round trip is a constant negative drift. A hundred trades a year costs 25% of
account before the market moves at all. Break-even for the convex strategy is a **0.238% round
trip**; Coinbase Intro-1 is ~0.25%. The edge was real and the venue ate it.

**Implication:** compute the break-even cost first. If it's within ~20% of your actual fees, stop.

### 4. Measurement artifact — the result was never there

The most dangerous category, because these produce *exciting* numbers.

| artifact | apparent result | after correction |
|---|---|---|
| **In-progress daily candle** (the big one) | crypto direction **94.7%** at pUp≥0.70 | **~50%** |
| Day-of-week confound in the news study | Fed releases suppress volatility −10.8pp at z=−10.4 | −0.57pp |
| Close-only path simulation | convex strategy +0.41R net | inflated; misses intrabar stop hits |

**The leak is the defining episode of this project.** `runBacktest.ts` sliced the daily timeframe
with `sliceUpTo(dailyAll, evalTime)`, including the in-progress daily candle at intraday bars — so
daily features saw the rest of the current day, overlapping the 24h forward label. Crypto-fatal
(continuous price), stock-spared (overnight gaps decorrelate), which is *exactly* why "direction
works for crypto but not stocks" looked like a real finding for weeks. Three independent checks
confirmed it: live forward test resolved 3/7, clean-data direction was ~50% at every ML level, and
the edge appeared in *every* non-overlapping window — too consistent to be real.

**Implication:** a too-good result is evidence of a bug until proven otherwise. Run the shuffled-target
null, the label-shift decay, and a live forward test before believing anything.

### 5. Clean null — the effect simply isn't there

| tested | pre-declared bar | actual |
|---|---|---|
| Policy-catalyst proximity (986 Fed releases, 2020-26) | +3.0pp goodR lift, ≥5/7 years | **−0.8pp, 4/7** |
| Longer ML horizons (7d, 30d) | AUC +0.02 in all folds | **−0.057 / −0.067**, negative in every fold |
| ML_WIN as position size vs binary gate | beat gate on EV/unit + Sharpe | lost in **0/3 folds** |

**The horizon result is the most important negative in the vault.** Predictability *decays* with
horizon: AUC 0.742 at 24h → 0.684 at 7d → 0.673 at 30d. This reframes what trend capture actually
is — the 200D regime rule captured a 54% decline (+74.7% vs −67.8%) **without predicting it**. It
works through payoff structure: cut losers, ride winners, no forecast required. Trend *capture* and
trend *prediction* are different mechanisms and only the first is available.

### 6. Real edge, wrong venue or wrong scale

| tested | works | but |
|---|---|---|
| Cash-and-carry (funding harvest) | 15.2% CAGR, −3.0% maxDD, Sharpe 6.0 | **measured on Binance, which is US-geoblocked** |
| Coinbase carry, textbook form | basis 12.5% annualized | spot fees ~0.40-0.60%/side consume it entirely |
| Coinbase carry, **covered** form | **~8% net on total capital** | needs ~$100k for $700/month |
| Selling 30d volatility, defined risk | BTC +1.37%/trade, worst year −2.0% | no retail options access; 4/6 positive years |

**Why:** an edge priced at a venue you cannot reach is not an edge. This was discovered twice — once
in July with the fee wall, and once in this session when the carry's headline number turned out to be
Binance funding.

**Implication:** verify venue access and fee tier *before* measuring, not after.

---

## Strategies tested end-to-end

| strategy | result | why it failed |
|---|---|---|
| Directional setups (the app's original design) | direction ~50% | mode 1 |
| Tail-gated convex perps | +0.151R gross, −0.008R net | mode 3 |
| Buying volatility (straddles) | −0.1 to −1.4%/trade at zero friction | vol risk premium is positive; buying it is structurally −EV |
| Selling volatility | +1.37%/trade BTC | mode 6 (access) |
| Regime hold (200D EMA, short-capable) | 325% vs B&H 561%, −82% maxDD | wins in trends, bleeds in chop; 12 correlated symbols ≠ a portfolio |
| Defensive flat (never short) | 218%, maxDD −59.9% vs −87.8% | **missed its bar by 4pp** — closest of all |
| Cross-sectional momentum | net −28.3% | mode 1 |
| Cash-and-carry, covered | ~8% net | mode 6 (scale) |
| **Buy and hold** | **561%** | **beat everything tested** |

---

## What actually survived

Not everything failed, and the pattern of what held up is coherent rather than random:

- **ML_WIN volatility model** — crypto WF AUC 0.674, stocks 0.686; top decile 76.6% / 78.3%;
  calibration monotone on live forward data. Predicts *how big*, never *which way*.
- **Support/resistance as locations** — +4.3pp hold rate vs random lines across 58,000 retests, both
  markets. The *levels* are real; their *strength* is unrankable.
- **Whale-trap warning, short side** — −18pp long-liquidation share across 25 distinct episodes,
  present every year. (Long side softened to +4.8pp — real but near the base rate.)
- **Cascade zones** — replicated 30-40× across 32 symbols.
- **The binary ML gate at p≥0.70** — beat both sizing alternatives on return per unit of capital in
  3/3 folds. The current design is correct.

**The pattern is the point.** Risk premia and volatility structure survive; directional forecasting
from public data does not. That is precisely what efficient-market reasoning predicts, and the
coherence is itself evidence the measurements are sound rather than noise.

---

## Methodology lessons, which outlast the findings

1. **Pre-declare the bar before computing the result.** Every test in this vault names its ship
   criterion in advance. It is why "missed by 4pp" gets recorded as a failure instead of the
   tolerance quietly becoming 30%.
2. **A too-good number is a bug until proven otherwise.** 94.7% was a leak. So was −10.8pp.
3. **Run the null tests.** Shuffled targets, label-shift decay, day-of-week stratification. The
   pipeline must be shown capable of returning 50% before its 76% means anything.
4. **Measure incremental value, never standalone.** Mode 2 exists entirely because of this.
5. **Compute break-even costs first.** Mode 3 is avoidable arithmetic.
6. **Check venue access and fee tier before measuring.** Mode 6, twice.
7. **Any crypto event study must stratify by day-of-week.** BTC goodR swings 34pp Monday to
   Saturday; every calendar clusters on weekdays, so the artifact is available in all of them.
8. **Effort and edge are unrelated.** Analysing public data harder converges faster on "it's priced
   in." The work being good does not make the answer better.

---

## What remains genuinely untested

Stated honestly, so nobody re-litigates the closed categories while believing the space is exhausted:

- **Order-flow microstructure** at sub-minute resolution. `depth_snapshots` exists but at ~20-minute
  cadence, far too coarse. Needs a tick feed.
- **On-chain flows** — wallet movements to exchanges ahead of sales.
- **Sequence models** on raw price paths rather than tree models on tabular features. Weak prior;
  the finance literature is not encouraging.
- **Defensive-flat with a justified return tolerance** — [[regime-flat-defensive]]. The one
  near-miss worth re-running.

Everything in modes 1–6 above is closed. Check this document and [[rejected-hypotheses]] before
proposing anything.

---

## The honest bottom line

The app was built to answer "which direction, and is there a setup?" That question appears to be
unanswerable at the horizons it operates on, using data available to retail. What it became instead
is a risk and discipline system that is honest about what it does not know — measuring an 86.6%
auto-FLAT rate that, given everything above, is mostly the app being *right*.

The cheapest thing in this project was the answer. The expensive path would have been trading the
hypothesis: at 0.25% round trip on a $28k account, a hundred trades a year is ~$7,000 in fees alone,
before coin-flip variance. Months of that would have taught the same lesson less clearly, because
luck and strategy are indistinguishable without the measurement infrastructure.
