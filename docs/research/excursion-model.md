# Excursion model — PRE-DECLARED 2026-08-24, before any number was computed

## Why this exists

`src/trading/generator.ts` needs `P(reach +R×risk before −1×risk within H)`. No such model exists.
`provisionalCurve()` currently anchors on ML_WIN at 1.5R and extrapolates toward `1/(1+R)` — an
assumption about tail shape, not a measurement. Every expected value the pipeline produces inherits
that assumption, so the pipeline cannot be trusted or shown in a UI until this is measured.

## The target is NOT goodR

`goodR = fwdMaxFavR >= 1.5` asks *did price ever get 1.5 ATR in my favour*. It ignores what happened
first. A bar that fell 3 ATR and then rallied 2 ATR scores `goodR = 1` while a real position was
stopped out long before.

**The barrier target asks the question a trade actually faces:**

> Starting at this bar's close, with a stop at 1.0 ATR and a target at R ATR, which is touched first
> within 72 hours?

Labels: `1` = target first, `0` = stop first or neither within the horizon. Labelled independently
for LONG and SHORT, because the barrier is directional even though the structure is not.

`R ∈ {1, 1.5, 2, 3, 5, 8}` — the grid `provisionalCurve` emits, so the trained model is a drop-in.

## Data

- **Features**: `csv_exports_v14/` — the audited 110-feature set, 4H cadence.
- **Paths**: `vision_backfill/klines_long/` — 1h OHLC, 1.24M bars, 2020-01 → 2026-07.
- **Universe**: the 24 symbols present in both.
- 1h resolution gives 72 observations inside a 72h horizon rather than 18 at 4H — stop/target
  ordering resolves far more accurately, which is the entire reason for using OHLC.

**Intra-bar ambiguity**: when one 1h bar's range spans both barriers, ordering is unknowable at this
resolution. **The stop is assumed to fill first.** This is the conservative convention and matches
`stepSetup`'s existing handling. It biases measured probabilities DOWN, which is the correct
direction for a number that will size positions.

## Validation

Purged walk-forward, 3 expanding folds, **purge ≥ 18 bars** (72h ÷ 4h) so no training row's label
window overlaps its test fold.

**Both AUC axes are reported, always.** On 2026-08-24 a pruned model passed three separate
validations on per-symbol AUC and was shipped, then reverted within the hour: its within-timestamp
AUC had collapsed 0.7607 → 0.6586, roughly 70× the per-symbol gain it was approved on. The app ranks
symbols side by side, so cross-sectional discrimination is the axis the product depends on.

**Mandatory controls**, per `harness.ts`: shuffled timing, random labels, lag-30.

## Pre-declared ship bar

The model ships only if ALL of these hold at the primary target (**R = 5**, the structure's target):

1. **Discrimination** — AUC ≥ 0.55 on BOTH the per-symbol and within-timestamp axes.
2. **Controls** — beats shuffled-timing and lag-30 by ≥ +0.02 on BOTH axes.
3. **Sanity** — the random-label control returns 0.50 ± 0.03. A harness that cannot produce chance
   on random labels cannot be believed when it produces 0.65 on real ones.
4. **Calibration** — reliability is monotonic across predicted deciles (at most one inversion).
5. **Beats the incumbent** — exceeds ML_WIN-as-barrier-predictor by ≥ +0.01 AUC in ALL 3 folds.

## The outcome that would mean "do not train"

Criterion 5 is not a formality. **ML_WIN may already rank barrier outcomes competently.** If it does,
the honest answer is *recalibrate ML_WIN onto the barrier target* — a mapping, not a model — which is
simpler, has fewer moving parts, and follows the recalibrate-before-retrain ladder established
2026-08-14.

A finding of "no dedicated model needed" is a successful outcome of this test, not a failure.

## What a pass does NOT license

Passing makes the curve *measured* instead of *assumed*. It does not establish that trading the
structure is profitable — that is `strategy_breakeven.py`'s +0.151R gross against a 0.238% break-even,
already measured, and unchanged by this work. Nor does it grant direction: the barrier model is
fitted per side and may well be symmetric, which would confirm rather than contradict the twenty-odd
direction tests in [[what-we-tried]].

---

## RESULTS

### The base rates are BELOW the random-walk benchmark at every R

| R | LONG | SHORT | random walk 1/(1+R) | edge |
|---:|---:|---:|---:|---:|
| 1 | 0.4661 | 0.5230 | 0.5000 | −0.034 |
| 1.5 | 0.3437 | 0.3926 | 0.4000 | −0.056 |
| 2 | 0.2630 | 0.3012 | 0.3333 | −0.070 |
| 3 | 0.1616 | 0.1799 | 0.2500 | −0.088 |
| **5** | **0.0664** | **0.0670** | **0.1667** | **−0.100** |
| 8 | 0.0206 | 0.0189 | 0.1111 | −0.091 |

`1/(1+R)` assumes *infinite* time. A 72h cap means many paths reach neither barrier, and those are
not wins. **`provisionalCurve` extrapolated toward a benchmark the real data sits 10pp below**, so
every expected value the pipeline has produced was optimistic.

### The binary EV formula is wrong by half an R

`opportunity.ts:expectedValueR` is `p·winR − (1−p)·lossR`, which has no room for the third outcome.
Measured pooled at 5R, **20-25% of trades hit neither barrier** and exit at the 72h mark:

| | P(target) | P(stop) | P(timeout) | E[R \| timeout] | EV real | EV if binary | error |
|---|---:|---:|---:|---:|---:|---:|---:|
| LONG 5R | 0.066 | 0.729 | 0.205 | +1.431 | −0.103 | −0.602 | **+0.498** |
| SHORT 5R | 0.067 | 0.682 | 0.252 | +1.435 | +0.015 | −0.598 | **+0.613** |

Timeout exits average **+1.43R** — they are not neutral, and pricing them at zero (or ignoring them)
is the difference between "this structure is hopeless" and "this structure is roughly flat".

### Against the pre-declared bar

| | LONG | SHORT |
|---|---|---|
| 1 AUC ≥ 0.55 both axes | PASS 0.648 / 0.562 | PASS 0.646 / 0.619 |
| 2 beats controls +0.02 | **FAIL** (lag-30 xs +0.014) | PASS |
| 3 random-label ≈ 0.50 | PASS 0.5015 | PASS 0.5036 |
| 4 monotonic calibration | PASS (1 inversion) | PASS (1 inversion) |
| 5 beats incumbent all folds | PASS +0.047/+0.032/+0.060 | PASS +0.051/+0.072/+0.182 |
| | **DO NOT SHIP** | **SHIP** |

Criterion 5 passing is the least interesting result here — training on the actual target ought to
beat training on a proxy. The informative ones are 1 and 2.

LONG's failure is specific and honest: its cross-sectional information barely decays under a 30-day
lag, which means it reads something slow-moving rather than timing — precisely what that control
exists to catch ([[crash-overlay]], T12).

### And then the regime control killed the profitability

The SHORT holdout EV looked strong (+0.27R net at top-10%). **That holdout contains BTC's run to
~124k and the crash to ~59k**, so a window-wide number cannot separate "the model selects" from
"the window fell". Nine non-overlapping 6-month periods, each trained only on prior data:

| control | result | verdict |
|---|---|---|
| 1 — beats always-short | +0.154R vs −0.014R | PASS |
| 2 — profitable in rising markets | **1 of 5 periods**, median −0.047R, corr(EV, BTC ret) = **−0.509** | **FAIL** |
| 3 — top-decile beats bottom-decile | +0.443R, **9 of 9 periods** | PASS |

**A control-design error worth recording**: the first version of Control 2 tested `mean > 0` and
PASSED. The mean was +0.111R — carried entirely by one period (2025-01 at +0.768R). Remove it and
the mean is **−0.054R**. Five observations cannot support a mean; the sign count and median can, and
on those the control fails cleanly.

## CORRECTION — the first conclusion overstated the spread by 4×

Feature importance was checked *after* writing the conclusion above, and the top five splits are
`ethBtcRatio`, `dxyMomentum`, `vixTermStructure`, `vix`, `fearGreedIndex` — **all market-wide**,
identical across all 24 symbols at any timestamp. That prompted a test of whether the model selects
assets or times the market (`excursion_selection_vs_timing.py`).

**Test B — which block carries the signal** (holdout, trained on each alone):

| features | per-symbol AUC | within-timestamp AUC |
|---|---:|---:|
| all 117 | 0.6084 | 0.6330 |
| 29 market-wide only | 0.5718 | **0.5000** |
| 88 asset-specific only | 0.6233 | 0.6198 |

The market-wide block scores **exactly 0.5000** cross-sectionally — as it must, since constant scores
cannot rank. So the within-timestamp AUC ≈ 0.62 **is** genuine asset selection, and that metric was
constructed correctly.

**Test A — but the tradeable spread was not.** The earlier Control 3 pooled its deciles across
symbols *and time*, so its "top decile" was substantially "the worst days" — market timing wearing
cross-sectional clothes, the same error class as the T3 non-independence mistake. Ranking *within*
each timestamp, so market-wide state cancels exactly between the legs:

| | value |
|---|---:|
| pooled spread (what was reported above) | +0.4427R |
| **true within-timestamp spread** | **+0.1086R** |
| per-timestamp median | **0.0000R** |
| per-timestamp share positive | **34.4%** |

**The mean is outlier-driven** — the same shape that broke Control 2. At 5R the win rate is 7-12%, so
most timestamps contain no winner at all and the spread is exactly zero; the positive mean comes from
a minority of timestamps where a rare 5R hit lands in the top decile.

**Test C — effective sample size.** 97,672 holdout rows across 4,244 timestamps = 23 rows each. For
any market-wide signal, n is the timestamp count, and a p-value computed on rows is overstated by
~4.8×. Recorded so it is not repeated.

**Two independent measurements now agree**, which is the one genuinely reassuring thing here: this
spread is +0.1086R gross against a ~0.075R median fee, i.e. **~+0.034R net** — and
`strategy_breakeven.py` measured +0.151R gross / +0.042R net at the corrected fee tier by a
completely different route.

## Conclusion

**Asset selection is real but thin and violently high-variance. Profitability is a regime bet.**

The model orders assets by barrier outcome cross-sectionally at AUC ~0.62, and Test B proves that
number is asset selection rather than shared market state. But it converts to only **+0.109R gross
per trade, realised in 34% of timestamps with a median of zero** — mostly nothing, occasionally a
large hit. That is the convex profile, and it means the edge exists only if traded mechanically
across many opportunities. But the SHORT-only structure it ranks
only pays when the tape falls, so shipping "short the top-ranked asset" would be a directional bet
wearing a model's clothes — the same mistake [[regime-hold]] documented.

**What this licenses:**
- Replacing the extrapolated curve with **measured** barrier probabilities.
- Fixing the binary EV formula, which is wrong by ~0.5R at the structure's own target.
- Using the model to **rank**, with EV stated honestly and its regime dependence surfaced.

**What it forbids:** presenting any of this as a profitable signal. It is not, in rising markets,
which is 5 of the 9 periods measured.
