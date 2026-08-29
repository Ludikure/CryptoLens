# The graveyard — rejected hypotheses

Everything tested and discarded, with the number that killed it. **Consult before
re-proposing anything** — "did we try X?" lives here. Methodology for all of these:
[[edge-methodology]]. When something here gets revived and works, move it to its own note
and link back.

## Stop × target, jointly — REJECTED 2026-08-27

**Both sides fail period consistency at 5 of 10 half-year windows.** Design and bar pre-declared at
e286e31 in [[stop-target-joint]]; full map there.

- SHORT `2 ATR @ 1.5R` → `1 ATR @ 5R`: **+0.0340R**, CI [+0.0132, +0.0559], gross agrees (+0.0692),
  effective n 4,444 — clears magnitude, power and the fee control, and dies on **5/10 periods**.
- LONG `4 ATR @ 1.5R` → `3 ATR @ 5R`: +0.0186R, under the +0.0200 bar, and also **5/10 periods**.

Real in aggregate over the window, not stable within it — a regime finding, not a geometry finding.
Partial support does not ship, so the shipped stops and targets are unchanged.

**What survives as a measurement rather than a rule:** the reward:risk gradient is LARGER than the
stop gradient (+0.056R across the R:R range at a fixed 2 ATR LONG stop, against +0.0362R for the
whole 2→4 ATR stop-width effect), and the app's shipped SHORT geometry sits in the worst region of
its own grid. Neither is actionable without a period criterion it can pass.

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

## Policy-catalyst proximity → volatility — REJECTED (2026-08-22)

`ml-training/news_catalyst_test.py` + `news_backfill.py`, design pre-declared in
[[news-catalyst-test]]. 986 Fed press releases 2020-2026 (177 `monetary`) vs BTCUSDT 4H bars from
`csv_exports_v14`. Question: does being within 24h of a policy release raise `goodR`?

**Clean null.** Pre-declared bar was +3.0pp in 0-24h on FED_MONETARY with positivity in ≥5/7 years;
actual **-0.8pp, 4/7**. Day-of-week-stratified (the honest comparison, see below): **-0.57pp**
FED_MONETARY, **-1.68pp** FED_ALL, **+1.20pp** at 0-48h. Nothing near the bar in either direction.
Forward up/down excursions symmetric (+2.71% vs +2.50%), consistent with direction being a coin flip.
Do NOT add catalyst proximity to the feature set.

**The trap this one exposed, which is the reusable part:** the naive numbers looked like a large
NEGATIVE effect (FED_ALL 0-24h **-10.8pp**, z=-10.4) — entirely a day-of-week artifact. BTC goodR
runs Mon 57.9 / Fri 34.8 / Sat 24.6 / Sun 59.1, a 34pp swing. Releases are dated on weekdays, and a
conservative end-of-day timestamp pushes the measurement window onto the following day (Fri/Sat for
most releases — the two worst days), while a ">72h from any event" baseline systematically excludes
weekends (83% weekday vs a calendar-neutral 71%). Event window and baseline end up on opposite ends
of a strong seasonal gradient. **Any event study on crypto must stratify by day-of-week before
believing an effect** — every economic, regulatory and corporate calendar clusters on weekdays, so
this artifact is available to manufacture a double-digit "finding" in any of them.

**Kept regardless:** the news collector itself (`src/news.ts`) — it was shipped as narrative context
and explicitly not as an edge, and this result confirms that label rather than contradicting it.
Not tested: H3 (chase-guard FLATs on catalyst days), pre-declared underpowered at ~50 FOMC events.

## Liquidation features → ML_WIN — REJECTED (2026-08-22)

`ml-training/liquidation_feature_test.py`, design pre-declared in [[liquidation-features]]. Prior-day
aggregated liquidation features (total USD, long/short asymmetry, 30d z-score, magnitude×OI-move)
over 26,416 daily bars on the 12 symbols with complete 2019+ history.

**Mean ΔAUC +0.0006, positive in 1/3 folds** against a pre-declared bar of +0.005 in all folds.

**The diagnostic that makes this conclusive rather than inconclusive:** the split-share criterion
PASSED — the trees spend 4.64% of splits on these four features, *more than the entire 20-feature
derivatives group earns in production (0.82%)*. So this is not the thin-coverage artifact of the
2026-07-05 audit. The model reaches for them and gains nothing, which is the signature of
**redundancy**: forced-flow magnitude substitutes for volatility already encoded in `atrPercentile`,
`volumeRatio`, `dAdx`, `oiChangePct`. Identical to the whale-feature rejection — same family, same
failure.

Even `liqAsymmetry` (22 splits) failed to help, despite being the one input nothing else encodes:
a 27:1 short-to-long day (2026-08-19, $311M vs $11M) is apparently inferable from what the model
already has. **Do not add liquidation columns to the feature set.** Tick-level data is kept for the
heatmap/cascade work, which asks a different question.

## Cascade exhaustion / continuation — REJECTED (2026-08-22)

`ml-training/cascade_exhaustion.py`, pre-declared in [[cascade-exhaustion]]. 32 symbols, 69,776
symbol-hours of per-event liquidation data. Does an extreme one-sided cascade (99th pctl hour, ≥70%
one side) change forward 24h volatility?

**Long flush 0.90x baseline, short squeeze 1.29x — opposite directions, so the "consistent across
sides" criterion fails and neither reaches the ±20% bar.** The long-side exhaustion is REAL but
small (episode CI [0.85x, 0.93x] excludes 1.0); the short-side continuation is suggestive
(CI [0.99x, 1.37x], 74 episodes). Not shipped: a 10% shift in a volatility baseline that varies far
more than that hour-to-hour cannot change a stop or a target, which is the only place it would act.

**Design flaw recorded:** criterion 2 assumed the sides would agree in sign. They do not. If ever
re-run, test the sides separately with separate bars. The bar was not re-interpreted to rescue the
result.

## Loosening the `biases_MIXED` ML gate — REJECTED (2026-08-23)

`ml-training/mixed_gate_test.py`, executing the design pre-declared 2026-07-24 in
[[strategy-mixed-gate]]. 489,906 affected bars (non-aligned, calibrated ML in [50,70)).

**All three variants negative in every fold, gross AND net:** gate→60 −0.0325R gross / −0.0511R net;
gate→55 −0.0320 / −0.0506; MODERATE-cap −0.0255 / −0.0441. Ship bar wanted positive net in all folds
beating control by +0.02R. **Gate stays at 70.**

Gross EV is already negative, so this is not a fee-margin rejection — the trades lose before costs.

Context: a 12-month envelope replay measured **86.6% of BTC 4H bars auto-FLAT**, this rule being the
largest single contributor (48.5% of all bars). High firing frequency confirmed; loosening is not the
remedy. The internal contradiction (gate at 70 unlocking a cell whose base rate is 61%) is now an
accepted cost WITH evidence rather than an open question.

Caveat recorded: the pre-declared bands (TP1 1.0 ATR vs 2.0 ATR stop) are unfavourable geometry, so
this rejects the window-as-traded, not the existence of an edge in MIXED bars.

## Daily-close levels as a level source — REJECTED 2026-08-28

**Claim:** daily closes are the strongest S/R class (crypto +5.8pp vs random, beating the
4H swings the app uses); adding them as a level source is "the one genuinely actionable
find" of [[strategy-levels]] Finding 4.

**Killed by:** a matched control. The original comparison was against random lines 0.5-3.0
ATR from price, which differ from a daily close in three ways at once — visited price,
distance 0 at formation, day boundary — only the last being the hypothesis. Evaluating
EVERY 4H close as a level and splitting on the day boundary matches all three:

| | daily close | other 4H close | gap | periods+ |
|---|---:|---:|---:|---:|
| crypto | 91.36% | **91.62%** | **−0.26pp** | 4/10 |
| stock | 85.65% | 83.99% | +1.66pp | 10/10 |

Pre-declared bar was ≥2.0pp on crypto AND ≥7/9 periods AND same sign on both markets.
**All three fail.** An arbitrary 4H close beats the random control by **+6.95pp**, more than
the daily close (+6.69) or the 4H swing (+5.13) — the effect is "the market traded here",
not "a day ended here". All six hour buckets lie in a 0.85pp band, boundary hour second worst.

The stock gap is real (10/10) but is the **afternoon bar vs the morning bar** (+1.70pp by
within-session position, reproducing it) — intraday, not calendar, and structurally absent
from a 24/7 tape.

**Seventh level-selection metric to measure flat**, after test-count, flip-role, timeframe,
Fibonacci ratio, formation volume and volume-at-price. The standing conclusion: prices the
market recently traded at hold ~7pp better than prices it has not, and *which* traded price
you pick has never mattered.

**Nothing shipped** — it had sat NOT YET IMPLEMENTED for three months. Full write-up:
[[level-daily-close]]. Script: `ml-training/level_daily_close_test.py`.

## Monthly extremes as a level source — REJECTED 2026-08-28

**Claim:** reversals cluster at monthly maximums/minimums, or close to them.

**Matched control:** the trailing-W-bar extreme anchored at a NON-month-end bar, same window
length — identical object (the highest/lowest price of the trailing ~30 days, known at
formation), differing only in whether the window ends on a calendar boundary.

| market | arm | gap vs matched | 95% CI | periods+ | verdict |
|---|---|---:|---|---:|---|
| crypto | monthly HIGH | +1.68pp | [−0.03, +3.53] | 6/9 | inconclusive |
| crypto | monthly LOW | **−2.19pp** | [−3.67, **−0.64**] | 3/9 | **inverted** |
| crypto | monthly CLOSE | −0.68pp | [−1.66, +0.26] | 6/9 | not supported |
| stock | monthly HIGH | −0.62pp | [−1.41, +0.20] | **2/9** | not supported |
| stock | monthly LOW | −0.39pp | [−1.42, +0.58] | 4/9 | not supported |
| stock | monthly CLOSE | +0.95pp | [−0.01, +1.88] | 6/9 | not supported |

Pre-declared bar was ≥ +2.0pp on crypto AND ≥7/9 periods AND same sign on stocks. **The only
cell not rejected outright — crypto monthly high — fails all three on its own point estimate.**

**Crypto monthly LOWS hold significantly WORSE than a matched non-calendar low** (CI excludes
zero). Both crypto extremes also sit below the random-line control. Consistent with the
momentum thesis: on a 24/7 tape a widely-watched extreme is where the stops are, and price
runs them. Same shape as Finding 4's weekly high at +0.3pp.

**The stock month-end close is ~90% the afternoon-bar effect.** A month-end close is always an
afternoon bar and the control is ~50% afternoon, so the +1.70pp afternoon effect from
[[level-daily-close]] predicts +0.85pp of the observed +0.95pp. Residual ~0.10pp.

**Eighth level-selection metric to measure flat or inverted**, after test-count, flip-role,
timeframe, Fibonacci ratio, formation volume, volume-at-price and the day boundary.

Full write-up: [[level-monthly-extremes]]. Script: `ml-training/level_monthly_test.py`.

## Sloped trendlines / channels as a level source — REJECTED 2026-08-28

**Claim:** price bounces between two sloping trendlines; channels are levels.

**Matched control:** a HORIZONTAL line at the same anchor pivot — the incumbent the app
already builds. Secondary control: the same anchor with a RANDOM slope.

| comparison | crypto | stock |
|---|---|---|
| channel vs horizontal | **−1.12pp** [−1.36, −0.86] | **−1.75pp** [−2.17, −1.33] |
| periods positive | **0 of 10** | 1 of 10 (n=64 stub) |
| paired subset | −0.33pp [−0.62, −0.05] | −0.81pp [−1.28, −0.34] |
| channel vs **random slope** | −0.21pp [−0.48, +0.07] | **+0.03pp** [−0.40, +0.45] |

**The sloped line is significantly WORSE than a flat line through the same pivot, on both
markets, in 19 of 20 half-year periods.** First of nine level tests where the tested object
underperforms the incumbent rather than matching it.

**The trap, in its purest form:** a fitted trendline beats a *random line* by +4.09pp
(crypto) / +4.23pp (stock). Measured against nothing it looks like a large, consistent, real
effect — which is presumably why the technique is universally believed. Against the right
control it loses.

**The fitted slope carries no information**: indistinguishable from a randomly drawn slope
through the same anchor on both markets. The anchor does all the work.

A projected line is also ~21-24% less often reached than the horizontal from the same anchor.
Regression channels lose to horizontal too (89.32 vs 89.81 crypto; 83.97 vs 85.09 stock).

Ninth level-selection metric to measure flat, and the first to measure negative. No code
change — the app has no channel concept and the prompt never mentions one; the value is
preventive. Full write-up: [[level-trend-channels]]. Script:
`ml-training/level_channel_test.py`.

## An LLM choosing take/skip over the scanner's proposals — REJECTED 2026-08-28

**Claim:** an AI judge selecting which of the system's proposals to take beats taking them all.

**Test:** 1,825 blinded proposals (symbol, date, price withheld; exactly the population the
scanner would have shown — OOF SHORT head, base-rate LONG, floor, greed cancel), two judges at
temperature 0 on a verbatim committed prompt, against take-all and against the EV already on the
card. Pre-declared bar: gap ≥ +0.05R, day-clustered CI excludes 0, ≥ 8/11 half-years, beats the
card, coverage ≥ 20%.

| arm | coverage | gap vs take-all | CI | periods+ |
|---|---:|---:|---|---:|
| card number (top half by EV) | 50% | **+0.120** | [−0.028, +0.277] | **8/10** |
| DeepSeek v4-pro TAKE | 30% | +0.007 | [−0.186, +0.216] | 7/10 |
| Claude Sonnet 5 TAKE | **5%** | −0.023 | [−0.428, +0.401] | — |

DeepSeek's picks ARE the population, in both directions. Sonnet declined to select (90 of
1,825) even when told the structure is +EV and that skipping everything is abstention, and its
picks did slightly worse. **The model's own EV number beat both** — a model trained on 110
features outperforms a language model reading a printout of them.

Cost ~$14. Nothing ships; the take/skip decision stays with the user and the journal measures
it. Full write-up with amendments and scored predictions: [[llm-selection-test]]. Scripts:
`ml-training/llm_selection_{build,run,analyze}.py`.

