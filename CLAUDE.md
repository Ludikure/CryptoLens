# CLAUDE.md — MarketScope (CryptoLens)

## Project Overview

MarketScope is an iOS app for multi-timeframe technical analysis of crypto and stock markets. It computes indicators locally, fetches market data from multiple providers, and sends it to Claude/Gemini AI for analysis with trade setups.

- **Bundle ID:** `com.ludikure.CryptoLens`
- **App Store name:** MarketScope
- **Version:** 1.2 (build 23)
- **Deployment target:** iOS 17.0
- **Xcode:** 16.0
- **Project generator:** XcodeGen (`project.yml`)
- **Xcode project:** `MarketScope.xcodeproj` (not `CryptoLens.xcodeproj`)

## Build & Run

```bash
# Build (must specify project — two .xcodeproj exist)
xcodebuild -project MarketScope.xcodeproj -scheme MarketScope -destination 'generic/platform=iOS' build

# Generate project from project.yml (if changed — required after adding/removing files)
xcodegen generate

# Build + install on simulator
xcodebuild -project MarketScope.xcodeproj -scheme MarketScope -destination 'platform=iOS Simulator,id=<DEVICE_ID>' install DSTROOT=/tmp/MarketScope.dst && xcrun simctl install <DEVICE_ID> /tmp/MarketScope.dst/Applications/MarketScope.app
```

No tests exist. No package manager dependencies (no SPM, CocoaPods, or Carthage).

## Architecture

### Swift App (`CryptoLens/`)

```
App/            → CryptoLensApp.swift (entry), ContentView.swift (4-tab layout)
Services/       → Network services, data stores, push notifications, outcome tracking
Views/          → SwiftUI views (charts, indicators, alerts, settings, outcome dashboard)
Models/         → Data models (Candle, AnalysisResult, TradeSetup, TradeOutcome, etc.)
Indicators/     → Technical indicator computation (RSI, MACD, Bollinger, ADX series, etc.)
Analysis/       → Price action & positioning analyzers
ML/             → ML model JSONs + native tree evaluator (MLScoring.swift)
Utils/          → Constants, formatters, helpers, ViewHelpers (shared UI functions), MarketHours
Resources/      → Assets.xcassets, earnings_history.json, dark_pool_history.json
```

### Cloudflare Worker (`marketscope-worker/`)

TypeScript worker that proxies API calls, handles auth, push notifications (APNs), and alert checking via cron. Deployed to `marketscope-proxy.ludikure.workers.dev`.

### Key Patterns

- **`AnalysisService`** (`@MainActor`, `ObservableObject`) is the central coordinator. Owns all network services, publishes results. Hooks into `OutcomeTracker` on each refresh.
- **`YahooFinanceService`** is an **actor** (not a class) — all calls require `await`.
- **`AlertsStore`** and **`FavoritesStore`** are `@MainActor` — all mutations must happen on main thread. `AlertsStore` has `processPendingBackgroundAlerts()` for bridging background-triggered alerts.
- **`Constants.customStocks`** and its accessors (`stock(for:)`, `asset(for:)`) are `@MainActor`.
- **Symbol selection** is unified in `AnalysisService.switchToSymbol()` — both `ContentView` and `FavoritePillsView` delegate to it. It handles cancellation of in-flight requests.
- **Indicator computation** happens in `IndicatorEngine.computeAll()` — pure functions, no side effects. Includes full MACD/ADX/volume ratio series for chart sub-panels. **In-progress candle is dropped at the top of `computeAll`** (if `last.time + interval > now`) so live price ticks don't mutate indicators between refreshes. Same logic mirrored in `marketscope-worker/src/index.ts` via `dropInProgress()`. **Chart candles are trimmed to last 50** in `computeAll` — use `fullDailyCandles` (returned from `fetchAndCompute`) for ML features, not `tf1.candles`.
- **`AnalysisHistoryStore`** serializes all disk I/O on a dedicated `DispatchQueue`.
- **`OutcomeTracker`** tracks trade setup outcomes (entry/SL/TP hits, max excursions) and FLAT/kill outcomes (false conservatism detection). Persists to `~/Library/Caches/trade_outcomes/`. Syncs resolved outcomes to D1 via `/outcomes` endpoint.
- **Cache:** `AnalysisService` caches results per-symbol in memory (`resultsBySymbol`) and on disk (`~/Library/Caches/analyses/`). `loadCache` is `nonisolated` to avoid blocking main thread.

### Pre-Computed Flags (Swift → LLM)

The app pre-computes authoritative flags passed to the LLM in the `PRE-COMPUTED FLAGS` section of the user prompt. The LLM must not override these:

- **Regime**: TRENDING/RANGING/TRANSITIONING from ADX + MA alignment + BB squeeze. Staleness tracked via UserDefaults.
- **Bias Alignment**: Daily/4H/1H bias labels with counter-trend pullback detection.
- **Kill Conditions**: divergence_against_bias, counter_move_volume_exceeds, funding_supports_counter, macro_event_within_4h. Duration tracked in candles. Kills-clearing flags (divergence_weakening, volume_normalizing).
- **Macro Risk**: IMMINENT/NEARBY/UPCOMING/ON_HORIZON with conviction caps.
- **Tagged Levels**: S/R, VWAP, POC/VAH/VAL with IN_PLAY/NEARBY/DISTANT proximity and ATR distance.
- **Worn Levels** (2026-05-29): 4H structure levels within 2× ATR of price, tagged with direction (RES above price / SUP below) and FLIP_ROLE when a level appears as both a recent swing high AND swing low (broken and reclaimed → stronger than never-broken). Test count → FRESH_1x / RECENT_Nx / WORN_Nx_distrust.
- **Sector Strength** (stocks, 2026-05-29): `XLK OUTPERFORMING vs SPY (+1.8%) → risk-on tailwind` when relativeStrength1d + outperformingSector are set.
- **Insider Cluster** (stocks, 2026-05-29): `N buys in 30d from K officers ($X.XM total) — fundamental buy signal` when 3+ buys from 3+ distinct names (or 5+ sells from 4+ names for distribution signal).
- **Earnings Proximity** (stocks, 2026-05-29): Hard-wired into the Conviction Envelope, not advisory. 0–2d → moderateBlock (cap LOW = no trade); 3–7d → highBlock (cap MODERATE); 8–14d → downgrade tier (LLM applies).
- **Active Trade State** (continuous values, 2026-05-29): Replaces the older INTRA_24H/IN_PROFIT/UNDERWATER/FLAT buckets. Emits elapsed hours, PnL in R units, peak excursion R, TP1 % reached, ML delta from registration, milestone flags (T+24h crossed, TP1 hit, partial taken, BE-stop active), and a concrete `Action:` line keyed on actual R thresholds (≤ -0.7R → cut, ≥ +0.5R → trail to BE, etc.).
- **STOCH_CROSS** (2026-05-30, treatment-prompt-active = always since A/B collapse): Daily + 4H Stochastic RSI crossover direction ("bullish" / "bearish" / "none"). Co-equal direction primitive with bias alignment per the direction_primitive_sweep backtest. Four rules: (a) Stoch + bias agree → high-conviction, (b) Stoch + bias contradict → flag tension, cap MODERATE unless structural evidence supports bias, (c) bias MIXED + Stoch decisive + ML≥65 → Stoch overrides auto-FLAT (catalyst-driven case), (d) Stoch 'none' both TFs → bias drives. Backtest basis: dStoch + ML≥65 captured +0.190R EV on stocks (vs +0.079R bias-alone) and +0.998R on crypto top-10.
- **LONG_CONFIRMATION** (2026-05-30, stocks only): relStrengthVsSpy ≥ 1 AND dRsiDelta ≥ 1. PASS → unrestricted LONG; PARTIAL → cap LOW; FAIL → no LONG trade. Backtest: lifts aligned_bullish + ML EV from +0.122R to +0.171R, rescues stocks fold-5 (current bull) from −0.069R to +0.067R. Crypto has neither field — gate inactive (returns "n/a").
- **BB_EXTREME** (2026-05-30): When dBBPercentB ≤ 0.1 or ≥ 0.9, prompt emits explicit "DO NOT short this — fading band touches LOSES money (-0.052R EV)". Treat as continuation, not fade.
- **MACRO_CONTEXT** (2026-05-30): Labeled DXY / SPY / VIX state pulled from crossAsset + stockSentiment. Surfaces direction-relevant macro signals the LLM previously had to infer from raw numbers.
- **Conviction envelope treatment gates** (2026-05-30): aligned_bearish SHORTs gated by `isStock && ML≥70 && STOCH_CROSS bearish && regime TRENDING` (stock SHORTs lose in every backtest regime; crypto SHORTs are best cell, unrestricted). TRANSITIONING regime + aligned_bullish + ML≥65 + LONG_CONFIRMATION PASS → removes continuation-count + ML<70 highBlocks so HIGH conviction can fire.
- **Candle Close Timestamps**: Next 4H and Daily close times.

### Data Flow

1. User selects symbol → `switchToSymbol()` → `selectSymbol()` → `refreshIndicators()`
2. `refreshIndicators` fetches candles from Binance (crypto) or Yahoo/TwelveData/Tiingo (stocks)
3. Candles → `IndicatorEngine.computeAll()` → `IndicatorResult` per timeframe
4. Results assembled into `AnalysisResult` with enrichment (sentiment, fundamentals, derivatives)
5. AI analysis: `runFullAnalysis()` builds prompt from indicators → Claude/Gemini → markdown + trade setups
6. Post-analysis: setups registered with `OutcomeTracker`, FLAT outcomes tracked
7. Each refresh: `OutcomeTracker.trackSetupOutcomes()` and `trackFlatOutcomes()` check prices

### Chart Rendering

`CandlestickChartView` uses **SwiftUI Canvas** for all rendering (candlesticks, grid, EMAs, S/R, Bollinger, selection). Sub-chart panels (RSI, MACD, StochRSI, ADX, Volume) also use Canvas. Gestures are a single unified `DragGesture(minimumDistance: 0)`:
- Quick horizontal swipe (movement before 0.3s) → horizontal pan
- Hold 0.3s then drag → crosshair scrub (Apple Stocks style)
- Vertical movement → passes through to parent ScrollView
- Pinch → zoom (separate MagnificationGesture)

### Market Data Providers

| Provider | Used For | Actor/Class |
|----------|----------|-------------|
| Binance | Crypto candles, derivatives, spot pressure | `BinanceService` (class) |
| Yahoo Finance | Stock candles, quotes, fundamentals, options, DXY | `YahooFinanceService` (actor) |
| TwelveData | Stock 4H/1H candles (fallback) | `TwelveDataProvider` (class) |
| Tiingo | Stock candles (fallback) | `TiingoProvider` (class) |
| CoinGecko | Crypto sentiment, Fear & Greed | `CoinGeckoService` (class) |
| Finnhub | Market status, analyst recs, earnings | `FinnhubProvider` (class) |
| FRED (via worker) | Macro data (rates, yields) | `MacroDataService` (@MainActor) |
| FairEconomy | Economic calendar (client-side) | `EconomicCalendarService` (class) |
| FINRA | Dark pool short sale volume (daily) | `DarkPoolData` (enum, bundled) + worker cron |

### Navigation

4-tab layout in `ContentView`: Chart (0), Market (1), Analysis (2), Alerts (3). Tabs 0-2 share a `NavigationStack`; tab 3 (`AlertsView`) gets its own `NavigationStack` from `ContentView`. **Do not add a NavigationStack inside AlertsView.**

## System Prompt Architecture

The AI system prompt (`AnalysisPrompt.swift`) is momentum-based with ML directional quality as a gate. Old architecture (LABEL AUTHORITY, Rule 1/2/3, anti-gaming, score conviction gate) was removed — linear score is now diagnostic only. Steps:

1. **Step 1 — Regime**: Pre-computed label (TRENDING/RANGING/TRANSITIONING), authoritative
2. **Step 2 — Playbook**: Per-regime trading rules
3. **Step 3 — Directional thesis**: LLM reads raw candles/indicators across timeframes and forms its own thesis. 4H next-bar direction is essentially random absent structural evidence (~50% empirical continuation rate on 235K stock bars; crypto unmeasured). Continuation and reversal carry equal evidentiary burden — direction confidence comes from multi-timeframe alignment, S/R confluence, volume/VWAP positioning, and exhaustion signals at key levels, not from "recent direction" alone.
4. **ML Quality Filter**: `ML_WIN` is a direction-agnostic calibrated probability. `>=60%` favorable, `50–59%` marginal, `<50%` no trade.
5. **Kill Condition Gate**: Pre-computed kill conditions block setup construction if ANY_KILLED=true.
6. **Step 4 — Trade Setup**: Level + Signal + Risk. Conviction HIGH/MODERATE/LOW based on evidence quality + ML_WIN.

Output includes: Market Regime, Key Levels, Bias (with evidence + ML_WIN value), Trade Setup table, Risk Factors (max 3 bullets), Next Decision Point, JSON block.

Economic events split into RECENTLY RELEASED (with actuals, beat/miss) and UPCOMING sections.

## Secrets & API Keys

- **No API keys in the codebase.** All keys are proxied through the Cloudflare Worker.
- `Secrets.xcconfig` exists but contains empty values and is gitignored.
- Worker secrets are set via `wrangler secret put`.
- DXY fetched from Yahoo Finance (`DX-Y.NYB`) via worker with User-Agent header.

## Concurrency Model

- `AnalysisService`, `AlertsStore`, `FavoritesStore`, `MacroDataService`, `ConnectionStatus`, `NetworkMonitor` are all `@MainActor`.
- `YahooFinanceService` is an `actor`.
- Other services (`BinanceService`, `CoinGeckoService`, etc.) are plain classes with no mutable shared state — safe because they're only accessed from `@MainActor` `AnalysisService`.
- `PushService` is an `@MainActor` `enum`. All state (`deviceId`, `authToken`, `isAuthenticating`) is serialized through MainActor. `addAuthHeaders` is `nonisolated` and inlines the keychain key string to avoid actor isolation issues.
- `NavigationCoordinator` is `@MainActor`.
- `OutcomeTracker` and `AnalysisHistoryStore` use dedicated `DispatchQueue`s for disk I/O.
- Use `.task { }` instead of `.onAppear { Task { } }` for async work in views (auto-cancels on disappear).
- Use iOS 17 `onChange` form: `.onChange(of: value) { }` (zero-parameter) or `.onChange(of: value) { old, new in }`.
- `AnalysisPrompt.promptVersion` is a `@TaskLocal` (see A/B Testing Infrastructure section). Bound around `provider.analyze()` in `AnalysisService` so concurrent symbol analyses each see their own A/B bucket without races.

## ML Scoring Pipeline

### Overview

Direction-agnostic `goodR = fwdMaxFavR >= 1.5` — probability of a ≥1.5 ATR favorable move within 24H. The LLM determines direction from momentum; ML answers "trade or not?"

- **Crypto model (v11, retrained 2026-05-28):** LightGBM depth=4, 150 trees — 77 symbols, 136,551 bars, **62% WF accuracy** (folds 61.6/61.8/62.6). On identical fresh data, v11 beats v10 by +3.6 pp raw accuracy and +16.1 pp on the trade-critical top bucket (76.3% vs 60.2% for v10). The lower WF headline vs v10's stated 73.4% is because v10's number was measured on its own training data, not on fresh data — apples-to-oranges. See `marketscope-worker/scripts/evaluate-model.ts` for the apples-to-apples comparison.
- **Stock model (v13, retrained 2026-05-29):** XGBoost depth=5, 100 trees — 159 symbols, 228,487 bars, **64.7% WF accuracy** (folds 63.4/64.5/66.2), top bucket **79.9%**. On identical fresh data, v13 beats v12 by +6.8 pp raw accuracy and +4.0 pp top bucket reliability. v12's stated 66.8% / 75.5% were measured on v12's own training data — same caveat as crypto.
- **Features:** 111
- **Target:** `goodR = fwdMaxFavR >= 1.5` (max favorable excursion in ATR multiples)
- **Training:** Walk-forward CV (3-fold expanding window), purged 48-bar gap, daily downsampled, time-decay sample weighting (last year 3x, last 2 years 2x)
- **Calibration:** Isotonic regression fit on out-of-fold predictions, capped at 0.85.
- **Serving architecture (post-Phase 5, 2026-05-04):** Worker is the **single source of truth** for displayed ML and notifications. iOS reads from `/ml-predict?symbol=…` (cron-cached, 5-min KV TTL); local `MLScoring.predict` is retained only for `BacktestEngine` (training canonical). No local fallback in production — UI shows nothing if cache is missing.
- **Inference:** Native Swift tree evaluator reads same JSON as worker (no CoreML). Worker `mlPredict()` (`marketscope-worker/src/ml-predict.ts`) uses identical tree evaluation logic. Worker↔BacktestEngine parity is asserted at 1e-7 absolute tolerance via `marketscope-worker/test/parity-vs-backtest.test.ts` (345/345 passing as of 2026-05-29 under v11/v13).

### Calibrated Reliability (measured on /tmp/retrain_{crypto,stocks} regen data, full population)

v11 crypto (819,231 bars, 50.5% baseline goodR):

| Predicted Range | Crypto Actual | Samples |
|----------------|---------------|---------|
| < 30% | 23.6% | 77,359 |
| 30-50% | 40.2% | 318,198 |
| 50-60% | 56.0% | 216,906 |
| 60-70% | 66.4% | 114,163 |
| 70-85% | **76.3%** | 92,605 |

v13 stocks (455,131 bars, 55.0% baseline goodR):

| Predicted Range | Stock Actual | Samples |
|----------------|---------------|---------|
| < 30% | 22.4% | 30,358 |
| 30-50% | 41.2% | 191,358 |
| 50-60% | 59.5% | 53,646 |
| 60-70% | 70.0% | 109,674 |
| 70-85% | **79.9%** | 70,095 |

For reference: v10 crypto on the same data hit top-bucket 60.2% (32% of bars in top bucket, overpredicting). v12 stocks on the same data hit top-bucket 75.9%. The new models issue fewer high-confidence signals but each one wins more often.

### Feature Groups (111 total)

| Group | Count | Source |
|-------|-------|--------|
| Daily core + momentum + vol/volume | 19 | IndicatorEngine |
| 4H core + momentum + vol/volume | 19 | IndicatorEngine |
| 1H entry | 4 | IndicatorEngine |
| Derivatives discrete | 5 | Binance fapi |
| Derivatives raw | 4 | Binance fapi (fundingRateRaw, oiChangePct, takerRatioRaw, longPctRaw) |
| Macro | 3 | VIX (Yahoo), DXY, volScalar |
| Candle patterns | 3 | Computed |
| Stock-only (OBV, A/D) | 2 | IndicatorEngine |
| Context | 2 | atrPercent (4H), atrPercentile (daily) |
| Cross-TF interactions | 3 | tfAlignment, momentumAlignment, structureAlignment |
| Temporal | 3 | dayOfWeek, barsSinceRegimeChange, regimeCode |
| Rate-of-change (6-bar) | 5 | Delta vs 6 bars ago |
| Sentiment | 2 | Fear & Greed (Alternative.me) |
| Cross-asset crypto | 2 | ETH/BTC ratio (Binance) |
| Basis | 2 | Futures premium (Binance fapi premiumIndex) — `basisPct`, `basisExtreme` |
| Volume profile | 6 | vpDistToPocATR, vpVAWidth, vpInValueArea, etc. |
| 1-bar deltas | 3 | Momentum spikes |
| Acceleration | 3 | Delta of deltas |
| Time-of-day | 2 | hourBucket (crypto sessions), isWeekend |
| Stock features | 9 | fiftyTwoWeekPct, gap analysis, relStrengthVsSpy, beta, vixLevelCode, isMarketHours |
| Earnings proximity | 1 | `earningsProximity` = exp(-daysToNearest/7) from bundled JSON |
| Dark pool | 2 | FINRA RegSHO shortVolumeRatio + 20-day Z-score |
| Derivatives interactions | 2 | oiPriceInteraction (OI×price), fundingSlope (last 4 rates) |
| Candle structure | 1 | bodyWickRatio (avg body/range over 5 bars) |
| Cross-market breadth | 4 | relStrengthVsSector, vixTermStructure, dxyMomentum, iwmSpyRatio |

### Files

| File | Purpose |
|------|---------|
| `Models/BacktestResult.swift` | `MLFeatures` struct (107 fields), `BacktestDataPoint` |
| `ML/MLScoring.swift` | Native XGBoost/LightGBM tree evaluator; used by `BacktestEngine` only (live serving goes through worker) |
| `ML/ml-model-{crypto,stock}.json` | Model JSONs (trees + embedded calibration), shared with worker |
| `Services/BacktestEngine.swift` | Backtest loop, feature extraction, CSV export, batch export, parity-fixture capture |
| `Services/AnalysisService.swift` | Live analysis pipeline; `fetchWorkerML(symbol:)` reads worker `/ml-predict` for displayed probability |
| `Services/WorkerMLService.swift` | Thin GET wrapper for `/ml-predict?symbol=…` (auth + 5s timeout + decode) |
| `Services/ParityFixture.swift` | Codable I/O snapshot used by worker parity tests |
| `Services/DarkPoolData.swift` | Loads bundled `dark_pool_history.json` for backtester lookups |
| `Services/EarningsCalendar.swift` | Stock earnings date lookup from bundled JSON |
| `Services/FearGreedService.swift` | Historical Fear & Greed from Alternative.me |
| `Resources/dark_pool_history.json` | FINRA RegSHO data, 85 symbols × 1,579 days (from `finra_dark_pool.py`) |
| `Resources/earnings_history.json` | Earnings dates for 73 stocks + 9 ETFs (from `earnings_backfill.py`) |
| `marketscope-worker/src/ml-predict.ts` | Worker `mlPredict()` evaluates tree JSONs, applies embedded calibration |
| `marketscope-worker/src/ml-model-{crypto,stock}.json` | Worker model JSONs (same files as iOS) |
| `marketscope-worker/src/scoring-full.ts` | Worker 111-feature computation (sector ETF mapping, VP from last 30 candles) |
| `marketscope-worker/test/parity-vs-backtest.test.ts` | 1e-7 fixture-driven worker↔BacktestEngine parity (`npm test`) |
| `marketscope-worker/test/fixtures/backtest-canonical/*.json` | I/O snapshots produced by `BacktestEngine` "Capture Parity Fixture" button |
| `ml-training/calibrate_v13_stocks.py` | Active stock training script — XGBoost d5 t100, reads `csv_exports_v13/`, writes both worker + iOS JSONs |
| `ml-training/calibrate_v11_crypto.py` | Active crypto training script — LightGBM d4 t150, reads `csv_exports_v11/`, writes both worker + iOS JSONs |
| `ml-training/calibrate_v12_stocks.py` | Predecessor stock script (kept for reference; reads `csv_exports_v12/`) |
| `ml-training/csv_exports_v11/` | 77-symbol crypto CSVs from Node-CLI regen (2026-05-28). Gitignored. |
| `ml-training/csv_exports_v13/` | 159-symbol stock CSVs from Node-CLI regen (2026-05-29). Gitignored. |
| `ml-training/csv_exports_v12/` | Predecessor 159-symbol stock CSVs (2026-05-04). Kept for v12 reproducibility. |
| `ml-training/calibrate_v9.py` | Legacy combined crypto+stock script — name is stale (was used to bootstrap v10 crypto model) |
| `ml-training/model_comparison.py` | Hyperparameter comparison (XGBoost d3-5 × t100-200 + LightGBM) |
| `ml-training/finra_dark_pool.py` | Downloads FINRA RegSHO daily files, computes short volume Z-scores |
| `ml-training/earnings_backfill.py` | Downloads historical earnings via yfinance |

### ML in Live Predictions

iOS displays ML by reading `/ml-predict?symbol=…` from the worker (`WorkerMLService.predict`). Returns nil on cache miss (UI shows "—") — there is **no** local fallback in production. `AnalysisService.buildMLFeatures()` is still compiled but only inside `#if DEBUG` for parity-investigation feature dumps.

`BacktestEngine` is the one place still calling `MLScoring.predict` directly — it's the canonical training source whose CSV output the model is fit to.

### Worker ML Scoring (Cron)

The cron is split into a **symbol pass** (compute once per symbol, regardless of how many devices watchlist it) and a **device pass** (read predictions from a Map, apply per-device gating, send APNs). Pre-refactor (commit `4b2a3a2` and earlier) the cron iterated devices first and re-ran the entire candle/derivative/feature pipeline for each device, taking 2-3 minutes per pass and triggering concurrent runs that produced duplicate APNs. The per-symbol structure cuts work ~13× and finishes in seconds.

```
checkAllDeviceScores                                          (orchestrator)
  └─ computeSymbolPredictions(env, allSymbols)                (symbol pass)
       writes ml_pred:<symbol>, ml_snapshots, deriv archive,
       returns Map<symbol, prediction>
  └─ for each device: processDeviceNotifications(...)         (device pass)
       reads its watchlist's predictions from Map, writes
       score_history per (device, symbol), applies notify gate,
       sends APNs
```

Per-cron flow (every minute via `scheduled()` handler):
- Fetches candles (in-progress dropped via `dropInProgress()`), computes all 111 features via `scoring-full.ts`
- **Stocks:** fetches 1H candles from Yahoo (`range=6mo`), aggregates to 4H via `aggregate1HTo4H_ET` (~216 bars, above 210 threshold)
- **Crypto:** fetches 4H + 1H directly from Binance
- Fetches SPY / IWM / VIX3M / DXY / sector ETF candles (closed-bar, `dropInProgress` applied) for stock cross-asset features
- Fetches FINRA dark pool data daily, stores in KV with rolling 20-day history for Z-score
- Fetches live: VIX/DXY (Yahoo), Fear & Greed (Alternative.me), ETH/BTC (Binance), derivatives (Binance fapi)
- Rate-of-change + acceleration + funding slope from KV-persisted snapshots (single global blob, not per-device)
- Archives derivatives to D1 every 4H for future training (`deriv_archive:<symbol>` 4H KV gate)
- Writes calibrated goodR probability to `score_history.ml_probability` per (device, watchlisted symbol)
- Writes `ml_pred:<symbol>` KV blob (5-min TTL) with full features dict — read by `/ml-predict` endpoint
- ARCHIVE_CRYPTO (76 fixed crypto symbols) is processed every cron regardless of watchlist for D1 archive coverage; predictions are computed but no `score_history` row is written for non-watchlisted devices

### Notifications

| | Crypto | Stocks |
|---|---|---|
| Hours (ET) | 8am, 12pm, 4pm, 8pm, 11:30pm | 8am, 12pm, 4pm |
| Days | Every day | Weekdays only |
| Threshold | ML rising-edge >= 70% | ML rising-edge >= 70% |
| Direction primitive | bias-aligned OR dStochCross (union, skip conflicts) | bias-aligned OR dStochCross (union, skip conflicts) |
| Cooldown | 3.5 hours per (push_token, symbol) | 3.5 hours per (push_token, symbol) |

**Direction primitive (2026-05-30):** `notificationDirection(biasAlignment, dStochCross)` in `marketscope-worker/src/index.ts`. Returns +1 (LONG), −1 (SHORT), or 0 (skip). Bars where bias and Stoch disagree are skipped. Backtest (direction_primitive_sweep, 4.4 yr): union captured 12× more total R on stocks and 1.9× on crypto top-10 vs bias-aligned-alone, with per-trade EV nearly identical. Bias-and-Stoch are largely orthogonal on stocks (53% agreement when both fire) but 88% correlated on crypto.

**Notification body format (2026-05-30):** Single-symbol notifications include the inferred direction: `"AAPL LONG — ML 73%"`. Multi-symbol notifications group by direction: `"LONG: AAPL, NVDA | SHORT: TSLA"`. Direction is derived from the union primitive.

**SymbolPrediction now carries:** `biasAlignment: string` (from worker's `computeScore` on daily + 4H candles → `biasAlignmentFromLabels`) and `dStochCross: number` (from `features.dStochCross`). Both inlined helpers live in `marketscope-worker/src/index.ts`.

Cooldown is keyed by `push_token`, not `device_id` — iOS rotates `device_id` on auth recovery (creates a new D1 row pointing at the same physical device's APNs token), and a `device_id`-keyed cooldown would let both rows fire the same notification. Switching to `push_token` makes the cooldown share across rotated rows.

### Backtest & Training

- `BacktestEngine` runs walk-forward eval on historical candles
- Fetches from D1 archive first, falls back to Binance/Yahoo/TwelveData
- Crypto clamped to Jan 2020 start (derivatives coverage)
- Exports CSV with all 111 features + forward returns + trade outcomes
- Batch export: separate "Crypto Only" / "Stocks Only" buttons
- 1-second delay between stock symbols to avoid rate limiting
- Stock daily features (`gapPercent`, `gapFilled`, `gapDirectionAligned`, `relStrengthVsSpy`, `relStrengthVsSector`, `iwmSpyRatio`, `beta`, `fiftyTwoWeekPct`, `distToFiftyTwoHigh`) read from a **post-drop** daily slice (`dailySliceForFeatures`) — pre-fix these used `dailyCandles[dailyIdx-1]` which pointed at today's in-progress bar, leaking intraday data into training that live cron (which drops in-progress) could never reproduce. Live cross-asset slices (`spyClosed`, `iwmClosed`, `sectorClosed`) are also `dropInProgress`-applied.
- Active training: `ml-training/calibrate_v11_crypto.py` reads `csv_exports_v11/` (77-symbol crypto, 2026-05-28 regen); `ml-training/calibrate_v13_stocks.py` reads `csv_exports_v13/` (159-symbol stocks, 2026-05-29 regen). Both regens were done via the Node-CLI runner `marketscope-worker/scripts/runBacktest.ts`; the iOS BacktestEngine path is no longer used for production CSV generation.

### Backtester Symbols

- **Crypto (76):** 56 pre-2021 (BTC, ETH, BCH, XRP, LTC, TRX, ETC, LINK, XLM, ADA, XMR, DASH, ZEC, XTZ, BNB, ATOM, ONT, IOTA, BAT, VET, NEO, QTUM, IOST, THETA, ALGO, ZIL, KNC, ZRX, COMP, DOGE, KAVA, BAND, RLC, SNX, DOT, YFI, CRV, TRB, RUNE, SUSHI, EGLD, SOL, ICX, STORJ, UNI, AVAX, ENJ, KSM, NEAR, AAVE, FIL, RSR, BEL, AXS, SKL, GRT) + 20 post-2021 (SAND, MANA, HBAR, MATIC, ICP, DYDX, GALA, IMX, GMT, APE, INJ, LDO, APT, ARB, SUI, PENDLE, SEI, TIA, JUP, PEPE)
- **Stocks (159, expanded from 85):** Mega-cap tech (AAPL, TSLA, MSFT, NVDA, GOOGL, META, AMZN, CRM, NFLX, AMD, ORCL, ADBE, INTC, CSCO) + Software/SaaS (NOW, INTU, CRWD, PANW, FTNT, SNOW, DDOG, NET, ZS, WDAY, TEAM, MDB) + Semis (AVGO, QCOM, MU, AMAT, LRCX, MRVL, TXN, KLAC, ON, MCHP) + Growth (PLTR, ROKU, SHOP, SNAP, COIN, RBLX) + Meme (BYND, GME) + Internet/travel (UBER, ABNB, BKNG, DASH, PYPL, SPOT, F, GM) + Financials (JPM, GS, MS, BAC, WFC, BLK, SCHW, AXP, C, COF, USB, PNC, CME, ICE, AIG) + Healthcare (UNH, LLY, ABBV, JNJ, PFE, MRK, TMO, AMGN, BMY, ABT, MDT, DHR, ISRG, BSX, SYK, CVS, ELV) + Biotech (REGN, VRTX, GILD, BIIB) + Consumer (HD, MA, V, DIS, NKE, SBUX, MCD, WMT, COST, LOW, TGT, TJX, CMG, MAR, HLT, MGM) + Cyclicals (CAT, DE, BA, HON, MMM, GE, EMR, ETN, ITW, PH) + Energy (XOM, OXY, FANG, CVX, SLB, COP, EOG, PSX, VLO) + Defense (LMT, RTX, GD, NOC) + Transport (UNP, FDX, DAL) + Telecom (T, VZ, CMCSA, TMUS, CHTR) + REITs (SPG, O, AMT, EQIX, PLD, CCI, PSA) + ETFs (SPY, QQQ, IWM, XLE, XLF, XLK, XLV, GLD, TLT, DIA, XLY, XLP, XLI, XLU, XLC, HYG, VXX). SQ excluded (Yahoo ticker change), X excluded (acquisition).

### Worker/iOS Feature Parity

**Status (2026-05-04): 345/345 tests passing at 1e-7 absolute tolerance.** Three fixtures (BTC, ETH, TSLA), every feature individually asserted. `cd marketscope-worker && npm test` runs the suite; `predeploy` hook on `npx wrangler deploy` runs it too so a failing parity blocks deploy.

Generation: iOS BacktestView → "Capture Parity Fixture" (DEBUG only) → copies the JSON from sim's `Documents/ml_exports/fixtures/` → user moves to `marketscope-worker/test/fixtures/backtest-canonical/`. Fixtures contain candle slices, derivatives signals, prev snapshots (with 7-bar history windows), `evalTimestampMs`, and the expected feature dict + ML probability.

Fixes landed during the parity push (commits `2ead207`, `e0f6ea1`, `5fe608d`, `732c154`, `c13be74`):
- Worker EMA seed corrected (was `values[0]`, now SMA of first `period` to match iOS `MovingAverages.computeEMA`)
- MACD trail-aligned across the two EMAs and the signal line
- BB squeeze: 120-bar lookback × 0.5 threshold (was 20-bar × 0.75)
- VP features use the 4H reference price (worker was using daily close)
- d/h/eEmaCross + d/hAboveVwap recomputed in `computeAllFeatures` against 4H close (matches `BacktestEngine` MLFeatures lines 576/607/646/603/643)
- RSI divergence ported from iOS `RSIDivergence.detect` peak/trough analysis (worker had a naive slope check)
- 7-bar Hist windows in `PreviousSnapshot` (`dRsiHist7`, `hRsiHist7`, …) so `*Delta = current - hist[0]` matches BacktestEngine `current - history[count-7]`
- `barsSinceRegimeChange` increments via `prevSnapshot.prevRegimeCode` + `prevBarsSinceRegimeChange`
- `fundingSlope` appends current `fundingRateRaw` to prev hist before regression (matches iOS BE lines 895-896)
- Daily VWAP, AboveVwap, and EmaCross all reference 4H close
- BacktestEngine fixture-capture off-by-one fix (snapshotted post-update history → was producing `prevSnapshot.hRsi == current_rsi`)
- Lookahead fix on stock daily features (gap/relStrength/beta/52week now use post-drop daily slices — see `Backtest & Training` section)
- Worker temporal features (`hourBucket`, `isWeekend`, `dayOfWeek`, `earningsProximity`) use the fixture's `evalTimestampMs` instead of `Date.now()` so tests reproduce iOS canonical at the bar boundary

### Model Comparison Results (v10 era — kept for historical reference)

Tested 10 configurations (7 XGBoost + 3 LightGBM) during the v10 selection. All within 72.9-73.4% crypto, 66.0-66.5% stocks **on each version's own training data**. Selected hyperparameters carried forward into v11/v13:
- Crypto: LGB d4 t150 — selected for top-bucket reliability under v10's training distribution. v11 retained the same hyperparameters and ships at 76.3% top-bucket on fresh data.
- Stocks: XGB d5 t100 — same recipe. v13 retains it and ships at 79.9% top-bucket on fresh data.

Deeper models (d5) and more trees (t200) showed diminishing returns. LightGBM d4 = d5 accuracy, confirming d4 captures all useful interactions.

## UI Enhancements (2026-04-25)

- **Setup overlay on chart**: Entry (cyan), SL (red), TP1/TP2 (green) lines drawn on candlestick chart
- **Analysis summary card**: Compact direction/entry/SL/TP/ML card above AI markdown
- **ML Win badges**: Each favorite pill shows ML probability percentage
- **Active trade banner**: Unrealized PnL and distance to TP1 for tracked trades
- **Symbol swipe**: Horizontal swipe on price header switches favorite symbols
- **Win/loss streak**: `5W 2L` indicator below candle momentum pills
- **Regime badge**: TRENDING/RANGING/TRANSITIONING capsule on price header
- **Event countdown**: Live countdown timer to next high-impact economic event

## Outcome Feedback Loop

The LLM prompt includes recent resolved trade outcomes for the current symbol (if >= 3 exist with the current model_version: 11 for crypto, 13 for stocks). Shows win/loss rate by direction and last 3 outcomes with ML probability. LLM instructed to calibrate confidence based on patterns. Outcomes stored in D1 `trade_outcomes` table with `model_version` column; each `TrackedSetup` also carries a `promptVersion` field (see A/B Testing Infrastructure) so we can compare populations by system iteration as well as by model.

## A/B Testing Infrastructure (2026-05-29; collapsed 2026-05-30)

Setups are bucketed at registration time into `baseline` or `treatment` prompt versions. The bucket is deterministic on `(deviceId, day)` via UTF-8 byte parity, so a single user's day isn't split mid-session but different days re-randomize. Honors the `experiments_enabled` UserDefault (default ON) — toggling OFF in Settings always returns baseline.

**A/B collapse (2026-05-30):** Both constants now equal `"2026-05-30-stoch-direction"`. MarketScope has a single user (the developer); n=1 cannot generate statistical power. The collapse also resolved an asymmetric-UX problem: the worker notification gate change to bias-OR-Stoch union (same date) fed Stoch-routed notifications to baseline users whose prompt had no STOCH_CROSS block — those analyses dead-ended at "biases_MIXED auto-FLAT → NO SETUP". Collapsing means every analysis runs the consolidated treatment prompt (which understands Stoch as a co-equal direction primitive). All historical `prompt_version` tags on resolved outcomes remain — only new outcomes get the consolidated version. To restart A/B testing if user count grows, bump `treatmentPromptVersion` to a new tag while leaving `baselinePromptVersion` at `"2026-05-30-stoch-direction"`.

- **Bucket assignment**: `OutcomeTracker.assignedPromptVersion(deviceId:date:)` still routes via UTF-8 byte parity, but both branches now return the same string post-collapse.
- **Plumbing**: `AnalysisService` computes the assigned version once per analysis run, then wraps `provider.analyze()` with `AnalysisPrompt.$promptVersion.withValue(...)` (TaskLocal) so the prompt-build sees the same bucket the resulting `TrackedSetup` gets stamped with. Prompt and outcome stay in sync — no risk of prompting under one bucket and recording under another.
- **Per-version stats**: `OutcomeTracker.versionStats(lookbackDays:)` slices the existing tracked-setup archive by `promptVersion` (no separate storage). Returns `[String: VersionStats]` with counted/resolved/wins/losses/winRate/avgRR per version. After collapse, the dashboard shows historical versions (legacy, 2026-05-09-multihorizon, 2026-05-29-experiment) as closed cohorts plus growing 2026-05-30-stoch-direction.
- **Dashboard**: `OutcomeDashboardView` "A/B: Prompt Version (30d)" section still renders; useful for comparing the consolidated current prompt against the closed historical cohorts.
- **Active treatment behavior (now active for everyone)**: see "Direction Primitive Architecture" section for the full list of treatment-conditional code blocks (all `isTreatment` checks now evaluate true).

## Historical Analysis Sharing (2026-05-04)

`AnalysisHistoryView` → tap a row → `HistoryDetailView` shows the snapshot. Toolbar's right side has a `ShareLink` (`square.and.arrow.up`) that exports plain text mirroring the live-screen share format: symbol/timestamp, price-then/now (with delta if currentPrice is available), bias snapshot, trade setup if any, and the full Claude/Gemini markdown.

## Target Selection System

Three-layer quality scoring for TP1/TP2 selection (replaced naive "nearest 3 levels"):
- **Layer 1**: Hard R:R/ATR band constraints (TP1 1.0-2.5, TP2 1.8-4.0)
- **Layer 2**: Quality scoring (1.5×strength + rrFit + clearance + freshness)
- **Layer 3**: ATR fallback with snap-to-nearest-level
- Level confluence: levels within 0.3 ATR merged into reinforcing clusters
- Weighted clearance: obstacles penalized by their strength
- Counter-trend: tighter bands (TP1 0.8-1.5, TP2 1.3-2.5) when 4H opposes daily

### Band-Default Inversion (A/B treatment, 2026-05-29)

Per-symbol EV analysis on `csv_exports_v11/` + `csv_exports_v13/` (n=237) showed 86% of symbols see ≥ +0.01 R/trade gain from the tighter DOGE-style bands (TP1 1.5 / TP2 2.5 / stop 2.0 ATR) over the historical wide defaults (TP1 2.0 / TP2 4.0). Inversion lives in the treatment A/B bucket only — baseline keeps the previous behavior so the archive stays comparable.

- `useTighterBands(symbol:)` in `AnalysisPrompt.swift` is the single switch:
  - Baseline bucket: tighter only for `wideBandSymbols` (DOGEUSDT). Preserves the pre-A/B archive's behavior.
  - Treatment bucket: tighter by default; `trendingSymbols` whitelist (~17) opt back to wide.
- `trendingSymbols` (whitelist that keeps wide defaults under treatment): GLD, COIN, PFE, GME, CAT, JUPUSDT, INTC, MU, HBARUSDT, NEOUSDT, ENJUSDT, CMG, TIAUSDT, TEAM, XLC, SNAP, ON, NVDA. Edge values from the EV analysis are inline in the doc-comment.
- Both buckets and the whitelist apply only outside counter-trend setups — counter-trend keeps its own dedicated band block.

## Counter-Trend Reversal Setup

Backtesting (850K+ crypto, 192K+ stock bars) shows counter-trend setups (4H reverses vs daily) have 73-86% goodR vs 38-43% for aligned. Prompt allows counter-trend reversal when ML_WIN >= 70%, with tighter targets (TP1 1.0 ATR, TP2 2.0 ATR) and MODERATE conviction cap.

## Direction Primitive Architecture (2026-05-30)

The system uses **two direction signals as a union** rather than picking one primitive:

```
notificationDirection(biasAlignment, dStochCross) → +1 / -1 / 0
  if bias and Stoch both fire and disagree → 0 (skip)
  else                                     → bias direction if set, else Stoch direction
```

Implementation lives in `marketscope-worker/src/index.ts` (notification gate) and `CryptoLens/Services/AnalysisPrompt.swift` (LLM prompt rules — STOCH_CROSS block in the treatment-conditional section, which is now always active after the A/B collapse).

### Why this primitive

`ml-training/direction_primitive_sweep.py` tested 12 direction primitives on 4.4 years of bars (rising-edge ML cross + each primitive → bar-by-bar fill resolution). The union of bias OR dStochCross was the clear winner on both markets:

```
STOCKS (159 symbols, 11,498 rising-edge ML events)
                                    n        win%   EV/trade   total R
bias-aligned (former production)    613     44.7%   +0.079R     +48.4
dStochCross alone                 2,974     49.7%   +0.190R    +566.3
union (current production)        3,339     49.2%   +0.179R    +599.2   ← 12× total R
... 9 other primitives tested, none beat the union

CRYPTO TOP-10 (3,541 rising-edge events)
bias-aligned (former production)    789     82.3%   +1.040R    +820.4
dStochCross alone                   912     81.0%   +0.998R    +910.4
union (current production)        1,517     81.9%   +1.024R   +1,553.1  ← 1.9× total R
```

### Why bias and Stoch are different on stocks vs crypto

The bias scoring system (in `ScoringFunction.swift`) is a 6-layer composite (EMA position, ADX, RSI/MACD, VWAP, OBV/A/D, and on crypto: cross-asset + derivatives). On stocks the system has fewer confirmation channels (no derivatives, no cross-asset), making it more restrictive — bias fires on only ~5% of rising-edge ML stock bars. Stoch picks up the missing direction on the other ~25%. On crypto, all 5 confirmation lenses (technical + positioning + cross-asset) align together more often, so bias and Stoch agree 88% of the time when both fire.

### Tested-but-rejected alternatives

```
hStochCross (4H Stoch alone)     stocks +0.047R   too noisy
hMacdCross  (4H MACD alone)      stocks +0.107R   modest, fires less often than dStoch
hEmaCross / dEmaCross            stocks +0.014-0.028R   fires on too many noise bars
dStack (bull/bear EMA stack)     stocks +0.007R   stale state, not transition
dDivergence (RSI divergence)     stocks −0.006R   contrarian, contradicts rising-edge ML
bias AND Stoch agree (intersection) stocks +0.222R, n=90    high EV but tiny volume
```

Triple-confirmation cells (bias + Stoch + MACD all agreeing) untested — likely high EV at very low N. Reserved as a possible "priority alert" tier for future work.

### Tested-but-rejected configuration

A Stoch-only gate (i.e., bias-AND-Stoch as the notification filter) was shipped briefly on 2026-05-30 and rolled back the same day. `ml-training/notification_compare.py` showed it dropped total R by ~80% on both markets while making per-trade EV slightly worse. The earlier `dStochCross + ML → +0.129R` finding was measured on the full universe (no bias-alignment prefilter); once aligned-bullish/bearish is already required, Stoch becomes redundant and over-restricts. The union resolves this.

### Coherence between worker + iOS

The worker decides whether to notify based on the union primitive. The iOS prompt (treatment-conditional STOCH_CROSS block, now always active) has explicit rules for how the LLM should weigh Stoch direction relative to bias direction (agree → high conviction; contradict → flag tension; bias MIXED + Stoch decisive + ML≥65 → override auto-FLAT; both 'none' → bias drives). The result is a system where the notification gate and the LLM analysis see Stoch the same way.

## Known Remaining Issues (Low Severity)

- No certificate pinning on network calls
- Missing App Group entitlement on main app target (widget can't share data)
- Worker: APNs tries sandbox first then production (doubles latency). Transient-error fallback was improved 2026-05-30 (only conclusive token-level errors like 410 Unregistered now break the loop; 429/5xx still attempt prod). JWT now cached for 50 min per cron (was rebuilt per send pre-2026-05-30).
- Parity fixtures (BTC/ETH/TSLA at 2026-05-04) still in use under v11/v13 — `expected.mlProbability` values were updated in-place via `marketscope-worker/scripts/update-fixture-ml.ts`. Feature-level parity assertions are still measured against the 2026-05-04 feature snapshots; capturing fresh fixtures at a current date is a low-priority follow-up.
- Backtester: crypto regen ~7h at concurrency 8 (Binance rate-limit cascade); stocks regen ~3.5h across two passes (Yahoo TCP drops at concurrency 8). Section H/K of `/Volumes/External/Downloads/marketscope-postponed-work.md` documents the concurrency tuning + raw candle cache opportunity.
- 72h persistence model (threshold 2.5 ATR) not yet retrained on fresh data — section F of postponed-work doc.
- Schema drift: `derivatives_history` table has 4 columns (`large_buy_vol`, `large_sell_vol`, `large_buy_count`, `large_sell_count`) added out-of-band; `trade_outcomes.prompt_version` similarly added without a migration file. A fresh D1 created from `migrations/*.sql` alone would fail INSERTs. Migration file consolidation is a low-priority follow-up.
- Derivatives D1 archive runs ~9× per day per symbol vs the intended 6.85× (3.5h gate). The `deriv_archive:all` KV blob occasionally evicts across overlapping crons, resetting per-symbol last-archive times. Storage cost minor (~700 extra rows/day across 76 symbols); fix is to move the per-symbol gate state from KV to D1.

## Recent Architectural Decisions

Reverse-chronological log of major architectural changes. New sessions should scan from the top — most recent context is most relevant for understanding the current system state.

### 2026-05-30 — A/B collapse + Direction Primitive Architecture

**Worker notification gate switched to bias-OR-Stoch union** (`marketscope-worker/src/index.ts`). Universal change, applies to all devices regardless of A/B bucket. Notification body now direction-explicit ("AAPL LONG — ML 73%"). Backed by `ml-training/direction_primitive_sweep.py` showing union beats 11 alternatives (including bias-alone) on total R captured.

**Prompt STOCH_CROSS framing broadened** from "primary only when MIXED" to "co-equal direction primitive with 4 explicit rules" (`AnalysisPrompt.swift`). Required to make iOS analyses coherent with the worker's new union notification semantics.

**A/B test collapsed** (`OutcomeTracker.swift`): `baselinePromptVersion = treatmentPromptVersion = "2026-05-30-stoch-direction"`. Rationale: n=1 user can't generate statistical power; the asymmetric UX created by the worker change (baseline users got Stoch-routed notifications their old prompt couldn't interpret) wasn't worth tolerating. Historical `prompt_version` tags preserved on resolved outcomes; new outcomes uniformly tagged.

**Failed experiment, then rolled back same day:** Stoch-cross gate added on top of bias-alignment as a notification filter (intersection). `ml-training/notification_compare.py` measured this and showed −80% total R captured. Rollback committed; resulting state (union) is the right interpretation of the standalone Stoch+ML backtest finding.

### 2026-05-30 — Treatment prompt bundle (six changes)

Bundled into prompt version `"2026-05-30-stoch-direction"` (which after the A/B collapse is now the universal prompt). Changes:
- STOCH_CROSS direction signal + conviction envelope override for biases_MIXED
- LONG_CONFIRMATION gate (relStrengthVsSpy ≥ 1 AND dRsiDelta ≥ 1; stocks only)
- BB extreme inversion ("DO NOT short BB touches")
- Aligned_bearish SHORT restriction (stocks only — crypto SHORTs are +0.95R EV, would be wrong to restrict)
- TRANSITIONING regime conviction boost
- MACRO_CONTEXT interpretive labels (DXY/SPY/VIX)

Backtest scripts that motivated these: `setup_execution_backtest_v3.py` (5-fold WF on stocks + crypto), `setup_execution_indicator_sweep.py`, `fold5_investigation.py`, `fold5_feature_diagnostic.py`.

### 2026-05-30 — Crypto setup-execution backtest validation

Ran `setup_execution_backtest_v3_crypto.py` on 75 cryptos. Aggregate finding: crypto aligned_bullish + ML high → +0.777R EV (vs +0.122R on stocks, ~6× better). Crypto SHORTs work (+0.952R EV in every fold including 2022 bear) where stock SHORTs structurally lose. Driven by crypto bias having derivatives + cross-asset confirmation channels stocks lack. Top-10-liquid restriction (`crypto_top10.py`) preserved the edge (slightly stronger), disproving the survivorship-bias hypothesis.

### 2026-05-30 — Setup-execution backtest infrastructure built

`ml-training/setup_execution_backtest_v1/v2/v3.py` series. v1 used 24h summary stats (pessimistic/optimistic bounds). v2 added bar-by-bar fill resolution via D1 OHLC cache (`fetch_stock_candles.py`, `fetch_crypto_candles.py`). v3 added 5-fold walk-forward CV. This is now the canonical methodology for any strategy-level backtest in `ml-training/`.

### 2026-05-29 — Code review + critical/high/medium fixes

Full code review across iOS + worker. Fixed 6 critical (alert 401 handling, score_history batching + real dailyScore, SettingsView state desync, symbol-switch race, runFullAnalysis UI guard, AlertsStore debounce) + 6 high (`/history` POST auth, `/darkpool` rate-limit, watchlist symbol sanitize, candle Y-axis with setup lines, async OutcomeTracker reads, pending-setup entry-zone formula) + 5 medium (M3 JWT caching, M4 APNs transient retry, M5 Promise.allSettled, M9 outcome index migration, M10 momentum-pill accessibility). Detailed commits 6f4ece4, 35b312e, 4f3597d.

### 2026-05-29 — A/B testing infrastructure landed

`promptVersion` TaskLocal, deterministic UTF-8 byte-parity bucketing on (deviceId, day), `OutcomeDashboardView` A/B section with chi-square verdict. See "A/B Testing Infrastructure" section above for current state (collapsed 2026-05-30).

### 2026-05-29 — Pre-computed flags expansion

Worn levels with FLIP_ROLE detection, sector strength, insider cluster, earnings proximity hard-wired into conviction envelope, Active Trade State continuous values + concrete Action line. See "Pre-Computed Flags" section.

### 2026-05-04 → 2026-05-29 — ML model retrains (v11 crypto, v13 stocks)

v11 crypto: LightGBM d4 t150, 77 symbols, 136K bars, 62% WF accuracy, top-bucket 76.3%. v13 stocks: XGBoost d5 t100, 159 symbols, 228K bars, 64.7% WF accuracy, top-bucket 79.9%. Both calibrated via isotonic regression with cap at 0.85. Worker↔BacktestEngine parity holds at 1e-7 (345/345 tests). See "ML Scoring Pipeline" section.

### Older — Phase 5 ML serving consolidation (worker as single source of truth)

iOS reads displayed ML from worker `/ml-predict?symbol=…` (cron-cached, 5-min KV TTL). Local `MLScoring.predict` retained only for `BacktestEngine`. No local fallback in production — UI shows "—" on cache miss.

## How to keep this doc current

When making a material change to architecture, prompt logic, ML pipeline, notification gating, or A/B configuration:

1. Update the relevant in-line section (Pre-Computed Flags, Notifications, A/B Infrastructure, etc.).
2. Add a dated entry to "Recent Architectural Decisions" at the top of that section. Include: what changed, where (file path), why (one paragraph with rationale + supporting data if relevant), and what was rolled back / superseded if applicable.
3. If the change adds new ml-training scripts, add their paths to the Files reference table.
4. If the change closes a known issue, remove it from "Known Remaining Issues".

The doc is auto-loaded into every Claude Code session, so it's the right place for knowledge that should persist between sessions. Treat it like a system-level changelog — future sessions read this to catch up quickly.
