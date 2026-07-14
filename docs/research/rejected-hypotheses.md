# The graveyard — rejected hypotheses

Everything tested and discarded, with the number that killed it. **Consult before
re-proposing anything** — "did we try X?" lives here. Methodology for all of these:
[[edge-methodology]]. When something here gets revived and works, move it to its own note
and link back.

## ⚠️ Crypto direction prediction — RETRACTED, was a leak (2026-06-02)
The [[edge-crypto-direction-model]] (94.7% dual-gate, `pUp` head) **and** the indicator
direction edge were artifacts of the daily in-progress-candle leak ([[edge-leak-daily-candle]]).
Clean: crypto direction ~50% even at ML≥85%; first-passage ordering pinned at the random-walk
null (`barrier_ordering.py`); live forward test 3/7. **Do not re-attempt direction/timing
prediction without first confirming the higher-TF slice drops the in-progress bar.** The real
edge is variance, not direction: [[strategy-variance-harvest]].

## Strategy structures that DON'T monetize the variance edge (2026-06-02)
On clean data + Binance fees, tail-gated convex baseline = single-shot trailing +0.060R/signal
([[strategy-variance-harvest]]). What failed against it:
```
fixed +1.5R/-1R bracket        EV→0 gross at the 40% random-walk null, negative after costs
ML_WIN gating (vs tail gate)   −0.110 vs −0.061  (predicts the body that hits your stop)
blind re-entry after stop      −0.031 .. −0.061  (re-bets the random entry direction)
wide fixed targets (TP 8/12)   only 1-4% ever fill — a non-binding cap, not a level reached
```
What *did* beat it (kept, in [[strategy-variance-harvest]]): pyramiding into winners (+0.216),
breakout-reset re-entry (+0.157). The difference is start-vs-continuation: blind re-entry
re-bets the random start; pyramiding/breakout press an *established* (mildly persisting) move.

## Tradeable at Coinbase Intro-1 fees — REJECTED (2026-06-02)
The variance-harvest strategy is net-negative (−0.04..−0.07R) at Coinbase derivative fees
(~0.23-0.28% round-trip); break-even is ~0.165%. Viable only on a cheaper venue (Binance
regular ~0.06-0.13%). Not a model problem — a cost-tier problem. `strategy_stop_sweep.py`.

## Rejection at a major S/R level → short-horizon direction — REJECTED (2026-07-14)
"Given a CONFIRMED rejection (wick pierces a major level, closes back away), is the 3-4 bar
continuation tradeable?" Motivated as an *observed event at a known location*, not a momentum
prediction — the category that could carry an edge where direction-prediction (a coin flip here)
does not. `ml-training/level_rejection_direction.py` (740k crypto / 207k stock loose events;
300k / 80k strict-wick, on the same validated swing-level detection as `level_validation.py`).
```
DIRECTION hit-rate (continuation)   crypto 50.1-50.4%   stock 50.2%   ← coin flip, both horizons
  crypto support→LONG     +1.8pp vs base P(up)     (just the known upward drift)
  crypto resistance→SHORT −1.0 to −1.7pp           (WORSE than base — anti-predictive)
gross EV/trade            crypto +0.005..+0.059%   stock ~0   → break-even round-trip ≤0.06%
walk-forward @0.10% fees  0-2 / 6 positive folds   (negative EVERY year incl. 2022 bear)
```
Files under the same coin-flip null as every other direction test. Fully consistent with
[[strategy-levels]]: a level is a real REACTION *location* (+4.3pp hold rate) but that reaction
carries **no tradeable directional EV** — a location, not a direction signal. Short horizons are
where fees bite hardest, and there was no gross edge to spend on them anyway. The "it's an observed
event, not a prediction" framing did not rescue it.

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

## Volume as a level-strength signal — REJECTED
`ml-training/volume_at_level.py` (daily OHLCV w/ volume). Neither formation volume (swing-bar
vol vs avg) nor volume-at-price (volume-profile node) predicts hold/break: ±1-2pp across
within-symbol terciles, non-monotonic, inconsistent sign (crypto high-formation-vol holds
−2pp). The "high-volume node = strong S/R" thesis fails. SIXTH and final strength metric to
fall — level strength is unrankable. [[strategy-levels]]

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

## Liquidation zones predict BIG MOVES (magnitude, not direction) — REJECTED (2026-06-04)
Follow-up to the heatmap *direction* null: do liquidation clusters predict big moves *either
way* (the tail-head target)? `ml-training/liq_bigmove_test.py` + `liq_bigmove_auc.py` on the
Coinglass set (25 majors, ~6mo 4H, real `long_liq`/`short_liq` + reconstructed ex-ante
near-price fuel). Predicting a big RAW move (top-decile, ≥6.8%/24h), frozen holdout:
**volatility alone AUC 0.824; vol + liquidation 0.812 (−0.012, *worse*); liquidation alone
0.558 (~random).** Vol-controlled (near-fuel tercile within each vol half): more fuel →
*fewer* big moves in both regimes (−1.5pp low-vol, −3.1pp high-vol) — backwards from the
cascade-magnet thesis. Realized liquidation *spikes* (actual data, not reconstructed) also
add nothing beyond vol. Mechanism: liquidations are the *effect* (the cascade IS the move),
not a leading predictor; whatever positioning signal exists is already in OI/funding/vol
features, and **volatility itself** (vol clustering) is the real big-move predictor — already
in the tail head (`atrPercent`/`atrPercentile`/BB bandwidth). Implication: do NOT build a
Coinglass liquidation feed into the model. Liquidation zones stay a **risk-map visual** (where
a cascade *could* accelerate IF price reaches them), never a quantitative predictor. Caveat:
6mo/25-symbol single-regime data + single-leverage (25×) reconstruction — but the realized-liq
null is the reliable half. Consistent with the earlier heatmap-direction null
([[edge-direction-primitive]]).

## Whale-trade flow ($100k+ futures prints) as ML features — REJECTED (2026-07-05)
The `large_*` archive columns (broken until 2026-07-04: spot trades, 0.5-UNIT threshold ≈
cents on cheap alts; fixed to futures + $100k notional, `WHALE_NOTIONAL_USD`) were never model
features. Backfilled 2yr of consistent whale flow from **Binance Vision** daily futures
aggTrades dumps (`marketscope-worker/scripts/backfill-whale-trades.ts` → per-4h-bucket
buy/sell vol+count, BTC/ETH/ADA/XRP/SOL) and tested 6 engineered features (imbalance 4h/24h,
activity z-scores 7d, imbalance momentum, buy-share vs week) against the production 111 on
the leak-clean v11_fixed bars, conservative one-bucket lag, canonical WF + purge
(`ml-training/whale_feature_test.py`). **Δ AUC negative in 0/4 folds (goodR), inconsistent on
tail4, both samplings.** Pre-declared robustness sweep (`whale_feature_sweep.py`): alt
windows (2d/30d/8h/48h), whale×vol interactions, XGBoost cross-check, 72h slow target — **no
variant passed** (best cell 3/4 folds at noise-level mean). Key nuance: **standalone whale
features hit AUC ~0.57 on every target/fold** — the data is REAL but REDUNDANT: whale
activity proxies the same volatility/activity state already encoded in volume ratio, ATR
percentile, ADX, and derivatives features. Direction-flavored whale features (imbalance,
buy-share) sit at/below 0.5 univariate — whales don't predict direction either. Untested
residual: minutes-scale whale prints for entry timing (different labels; execution-layer
question). Keep: the fixed collector + backfill script (data useful for display/whale-trap
context); do NOT add whale columns to the feature set.
