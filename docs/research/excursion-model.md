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

*(to be filled after the run — nothing below this line existed when the bar above was fixed)*
