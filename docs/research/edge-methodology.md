# Edge measurement methodology

How every EV/accuracy claim in this vault is measured. If a number wasn't produced this
way, distrust it. Related: [[edge-direction-primitive]], [[edge-crypto-direction-model]],
[[rejected-hypotheses]].

## Frozen holdout (the non-negotiable)
`ml-training/_harness.py` reserves the most recent **6 months** (`HOLDOUT_MONTHS = 6`,
boundary ≈ `t_max − 6mo`) as a frozen holdout. **Only `selection_df` may ever feed model
fitting or threshold/hyperparameter choices.** `holdout_df` is touched once, at the end of
a phase, to report the final number. Every phase script imports `split_holdout()` so
experiments are compared apples-to-apples on the same split.

## The leakage trap (why old WF numbers were wrong)
The original walk-forward scripts split by **row index** with a 48-*row* purge. With 159
stock symbols sharing each timestamp, 48 rows ≈ 0 elapsed time — so the "purge" leaked
across correlated symbols. The fix (`edge_revalidate.py` / `_harness.wf_clean`):

- Split by **timestamp**, not row index.
- **14-day time embargo** between train and validation.
- **5 folds spanning the 2022 bear**, so a finding has to survive a real downtrend.

Re-running the leaky sweeps clean reproduced the per-trade numbers within ~0.03R — the
leakage was real but **immaterial** here, because it only affects which bars the ML model
*selects*; each trade's R resolves from genuinely-future candles in a separate file, and
`fwdMaxFavR` is direction-agnostic. So no circularity. See [[edge-direction-primitive]]
for the clean-vs-leaky comparison.

**This does not rescue every claim.** The residual risks that methodology *can't* fix:
survivorship (no delisted symbols) and execution cost (pre-slippage/funding). Those are
real and unmodeled — only [[live-validation]] measures them.

## Standard scorecard
`_harness.scorecard()` resolves a setup bar-by-bar (SL-first tie-break on same-bar
stop+target) and reports win%, EV/trade in R, total R, coverage. `_resolve()` is the
canonical fill simulator: `SL_ATR=1.0, TP_ATR=1.5, HORIZON=6` bars (24h on 4h candles).

## Overfit check pattern
Always report **selection accuracy vs holdout accuracy**. A large positive gap =
memorization. Examples:
- Crypto direction model: selection 68.4% / holdout 69.1% (gap −0.7) → generalizes. ✅
- Stock direction model: selection 62.4% / holdout 53.0% (gap +9.5) → memorizes. ❌
  (see [[edge-stock-direction-rejected]])

## Key files
- `ml-training/_harness.py` — holdout split, model factory, scorecard, fill sim.
- `ml-training/edge_revalidate.py` — clean multi-fold WF spanning 2022 bear.
- `ml-training/edge_validation.py` — `FEATURES` list (111), feature loader, candle index.
