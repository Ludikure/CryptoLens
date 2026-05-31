# The graveyard — rejected hypotheses

Everything tested and discarded, with the number that killed it. **Consult before
re-proposing anything** — "did we try X?" lives here. Methodology for all of these:
[[edge-methodology]]. When something here gets revived and works, move it to its own note
and link back.

## Direction primitives (vs the [[edge-direction-primitive]] union)
Sweep: `ml-training/direction_primitive_sweep.py`, re-validated `edge_revalidate.py`.
```
hStochCross (4H Stoch alone)      stocks +0.047R   too noisy
hMacdCross  (4H MACD alone)       stocks +0.107R   modest, fires less than dStoch
hEmaCross / dEmaCross             stocks +0.014-0.028R   fires on too many noise bars
dStack (bull/bear EMA stack)      stocks +0.007R   stale state, not a transition
dDivergence (RSI divergence)      stocks −0.006R   contrarian, contradicts rising-edge ML
bias AND Stoch agree (intersect)  stocks +0.222R, n=90   high EV but tiny volume
```
Intersection has the best per-trade EV but trades too rarely — reserved as a possible
future "priority alert" tier (triple-confirmation: bias+Stoch+MACD all agree, untested,
likely high-EV very-low-N).

## Stoch-only notification gate — SHIPPED then ROLLED BACK same day (2026-05-30)
Added Stoch-cross as a filter *on top of* bias-alignment (intersection) as the notify gate.
`ml-training/notification_compare.py`: **−80% total R** on both markets, per-trade EV
slightly worse too. The earlier "dStoch+ML → +0.129R" finding was on the *full* universe
(no bias prefilter); once aligned-bullish/bearish is already required, Stoch becomes
redundant and over-restricts. The **union** resolves this — that's the shipped state.

## Stock direction model — REJECTED (2026-05-30)
Own note: [[edge-stock-direction-rejected]]. selection 62.4% → holdout 53.0%, flat across
all regimes, actively wrong at high confidence. Stocks' 24h direction is unpredictable.

## Exhaustion gate — NEGATIVE
Hypothesis: gate entries on momentum exhaustion. Tested (user-requested). Crypto:
exhaustion uncorrelated / *positively* correlated with EV (i.e. fading exhaustion loses).
Stocks: marginal. No gate shipped. Related: BB-extreme finding (don't fade band touches,
−0.052R EV) in [[strategy-targets-bands]].

## ML enhancement phases 4/5/6 — NEGATIVE (the wins were phases 1–2)
8-phase ML enhancement plan (`ML_ENHANCEMENTS_PLAN.md`). Wins → [[ml-additive-heads]]
(Phase 1 triple-barrier meta-labeling, Phase 2 conformal abstention). Negatives:
- **Phase 4 (context features)** — no holdout lift.
- **Phase 5 (path-dependent / sequence features)** — no holdout lift.
- **Phase 6 (model ensemble)** — no holdout lift over the single calibrated model.
Recurring theme: the ML quality gate + dStoch were already near-saturated on *entry
quality*; the remaining edge was in **direction** (crypto only) and **execution** (targets/
bands), not more entry-quality features.

## A/B testing — COLLAPSED (2026-05-30)
Not "rejected" but retired: n=1 user can't generate statistical power. Both prompt-version
constants set equal. Infra preserved (`promptVersion` TaskLocal, deterministic bucketing)
to restart if user count grows. The worker's union-notification change had also created an
asymmetric UX for baseline users whose prompt couldn't interpret Stoch-routed notifications.

## S/R strength tags (WORN / FLIP_ROLE) — REJECTED as predictors
`ml-training/level_validation.py`, 58k+ retests. Test-count and FLIP_ROLE do **not** predict
hold vs break — 3+-tested levels hold as often as fresh (crypto 88.7% vs 89.1%), flip is
flat/backwards. The `WORN_Nx_distrust` rule had no basis. **But the levels themselves are
real**: swing levels hold +4.3pp vs random lines on both markets (so the *detection* stays;
only the *strength scoring* was decoration). Acted on: neutralized prompt tags + removed the
`entry_at_worn_level_4+_tests` conviction downgrade. Full write-up: [[strategy-levels]].

## Fibonacci ratios as special S/R — REJECTED (location artifact)
`ml-training/level_validation_fib.py`. Fib levels hold +6.7pp (crypto) vs a far random line
— but vs **random retracement ratios in the same leg** they win by **+0.1pp** (450k samples).
The edge is being a mid-range line, not the Fibonacci ratio; 0.618 "best" was noise. Golden
ratio = pareidolia. Fib levels redundant with the swings they're built from. [[strategy-levels]]

## HTF level folklore (weekly > daily > 4H) — REJECTED
`ml-training/level_validation_htf.py`. Daily closes are the strongest class; "weekly is
stronger S/R" is false — weekly close middling (good on stocks, weak crypto +3.0pp), weekly
high/low weak-to-random on crypto (+0.3pp). Higher TF ≠ stronger level. [[strategy-levels]]

## Recency-weighted direction training — REJECTED
Time-decay sample weighting (used for the *quality* model) biases a *direction* model
toward UP in a bull market. The crypto + stock direction models use **uniform weights**.
See `calibrate_direction_stocks.py` note + [[edge-crypto-direction-model]].
