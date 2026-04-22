# CLAUDE.md — MarketScope (CryptoLens)

## Project Overview

MarketScope is an iOS app for multi-timeframe technical analysis of crypto and stock markets. It computes indicators locally, fetches market data from multiple providers, and sends it to Claude/Gemini AI for analysis with trade setups.

- **Bundle ID:** `com.ludikure.CryptoLens`
- **App Store name:** MarketScope
- **Version:** 1.2 (build 22)
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
3. **Step 3 — Directional thesis**: LLM reads raw candles/indicators across timeframes and forms its own thesis. Momentum continuation (75% base rate at 4H) is the default; reversal calls require 3+ exhaustion signals at a key level.
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

## ML Scoring Pipeline

### Overview

v10 dual models predicting direction-agnostic `goodR = fwdMaxFavR >= 1.5` — probability of a ≥1.5 ATR favorable move within 24H. The LLM determines direction from momentum; ML answers "trade or not?"

- **Crypto model:** LightGBM depth=4, 150 trees — 76 symbols, 141,786 bars, **73.4% WF accuracy**
- **Stock model:** XGBoost depth=5, 100 trees — 83 symbols (82 configured, 2 missing CSVs), 96,301 bars, **66.2% WF accuracy**
- **Features:** 107
- **Target:** `goodR = fwdMaxFavR >= 1.5` (max favorable excursion in ATR multiples)
- **Training:** Walk-forward CV (3-fold expanding window), purged 48-bar gap, daily downsampled, time-decay sample weighting (last year 3x, last 2 years 2x)
- **Calibration:** Isotonic regression fit on out-of-fold predictions, capped at 0.85.
- **Inference:** Native Swift tree evaluator reads same JSON as worker (no CoreML — eliminated 6pp conversion loss). Both iOS and worker use identical tree evaluation logic on identical model JSONs.

### Calibrated Reliability

| Predicted Range | Crypto Actual | Samples | Stock Actual | Samples |
|----------------|---------------|---------|--------------|---------|
| < 30% | 25.7% | 12,810 | 27.0% | 551 |
| 30-50% | 37.4% | 21,323 | 39.3% | 30,923 |
| 50-60% | 56.2% | 11,550 | 54.6% | 1,113 |
| 60-70% | 64.0% | 11,325 | 64.6% | 4,383 |
| 70-85% | 74.8% | 8,332 | 74.8% | 19,528 |

### Feature Groups (107 total)

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

### Files

| File | Purpose |
|------|---------|
| `Models/BacktestResult.swift` | `MLFeatures` struct (107 fields), `BacktestDataPoint` |
| `ML/MLScoring.swift` | Native XGBoost/LightGBM tree evaluator; reads same JSON as worker |
| `ML/ml-model-{crypto,stock}.json` | Model JSONs (trees + embedded calibration), shared with worker |
| `Services/BacktestEngine.swift` | Backtest loop, feature extraction, CSV export, batch export |
| `Services/AnalysisService.swift` | `buildMLFeatures()` for live predictions; `fetchAndCompute()` returns full daily candles |
| `Services/DarkPoolData.swift` | Loads bundled `dark_pool_history.json` for backtester lookups |
| `Services/EarningsCalendar.swift` | Stock earnings date lookup from bundled JSON |
| `Services/FearGreedService.swift` | Historical Fear & Greed from Alternative.me |
| `Resources/dark_pool_history.json` | FINRA RegSHO data, 85 symbols × 1,579 days (from `finra_dark_pool.py`) |
| `Resources/earnings_history.json` | Earnings dates for 73 stocks + 9 ETFs (from `earnings_backfill.py`) |
| `marketscope-worker/src/ml-predict.ts` | Worker `mlPredict()` evaluates tree JSONs, applies embedded calibration |
| `marketscope-worker/src/ml-model-{crypto,stock}.json` | Worker model JSONs (same files as iOS) |
| `marketscope-worker/src/scoring-full.ts` | Worker 107-feature computation |
| `ml-training/calibrate_v9.py` | Training script — LightGBM crypto + XGBoost stocks, exports unified JSON |
| `ml-training/model_comparison.py` | Hyperparameter comparison (XGBoost d3-5 × t100-200 + LightGBM) |
| `ml-training/finra_dark_pool.py` | Downloads FINRA RegSHO daily files, computes short volume Z-scores |
| `ml-training/earnings_backfill.py` | Downloads historical earnings via yfinance |

### ML in Live Predictions

- `AnalysisService.buildMLFeatures()` constructs `MLFeatures` from live indicator data
- **Full daily candles** (250 from Yahoo, 300 from Binance) passed via `fetchAndCompute()` return value — not `tf1.candles` (which is trimmed to 50 for chart display)
- SPY daily candles cached (5min staleness) for stock beta + relStrengthVsSpy
- Dark pool fetched from worker `/darkpool` endpoint (1hr cache)
- Rate-of-change deltas computed from `prevMLSnapshots` (stored per-symbol between refreshes)
- Funding rate history tracked in `fundingHistory` dict for slope computation
- Basis fetched from Binance `/fapi/v1/premiumIndex`
- Fear & Greed from CoinGecko (already fetched for sentiment)
- ETH/BTC from Binance ETHBTC candles
- Earnings proximity from bundled `EarningsCalendar`

### Worker ML Scoring (Cron)

- Runs every minute via `scheduled()` handler
- Fetches candles (in-progress dropped via `dropInProgress()`), computes all 107 features via `scoring-full.ts`
- **Stocks:** fetches 1H candles from Yahoo (`range=6mo`), aggregates to 4H (~216 bars, above 210 threshold)
- **Crypto:** fetches 4H + 1H directly from Binance
- Fetches SPY daily candles (`range=6mo`) for stock beta/relStrengthVsSpy
- Fetches FINRA dark pool data daily, stores in KV with rolling 20-day history for Z-score
- Fetches live: VIX/DXY (Yahoo), Fear & Greed (Alternative.me), ETH/BTC (Binance), derivatives (Binance fapi)
- Rate-of-change + acceleration + funding slope from KV-persisted snapshots
- Archives derivatives to D1 every 4H for future training
- Writes calibrated goodR probability to `score_history.ml_probability` per cron per symbol

### Notifications

| | Crypto | Stocks |
|---|---|---|
| Hours (ET) | 8am, 12pm, 4pm, 8pm, 11:30pm | 8am, 12pm, 4pm |
| Days | Every day | Weekdays only |
| Threshold | ML >= 70% | ML >= 70% |
| Cooldown | 3.5 hours per (device, symbol) | 3.5 hours per (device, symbol) |

### Backtest & Training

- `BacktestEngine` runs walk-forward eval on historical candles
- Fetches from D1 archive first, falls back to Binance/Yahoo/TwelveData
- Crypto clamped to Jan 2020 start (derivatives coverage)
- Exports CSV with all 107 features + forward returns + trade outcomes
- Batch export: separate "Crypto Only" / "Stocks Only" buttons
- 3-second delay between stock symbols to avoid rate limiting
- Training: `calibrate_v9.py` with LightGBM (crypto) + XGBoost (stocks), purged time-series CV, daily downsampling, sample weighting

### Backtester Symbols

- **Crypto (76):** 56 pre-2021 (BTC, ETH, BCH, XRP, LTC, TRX, ETC, LINK, XLM, ADA, XMR, DASH, ZEC, XTZ, BNB, ATOM, ONT, IOTA, BAT, VET, NEO, QTUM, IOST, THETA, ALGO, ZIL, KNC, ZRX, COMP, DOGE, KAVA, BAND, RLC, SNX, DOT, YFI, CRV, TRB, RUNE, SUSHI, EGLD, SOL, ICX, STORJ, UNI, AVAX, ENJ, KSM, NEAR, AAVE, FIL, RSR, BEL, AXS, SKL, GRT) + 20 post-2021 (SAND, MANA, HBAR, MATIC, ICP, DYDX, GALA, IMX, GMT, APE, INJ, LDO, APT, ARB, SUI, PENDLE, SEI, TIA, JUP, PEPE)
- **Stocks (85):** Mega-cap tech (AAPL, TSLA, MSFT, NVDA, GOOGL, META, AMZN, CRM, NFLX, AMD, ORCL, ADBE, INTC, CSCO) + Semis (AVGO, QCOM, MU, AMAT, LRCX, MRVL) + Growth (PLTR, ROKU, SHOP, SQ, SNAP, COIN, RBLX) + Meme (BYND, GME) + Financials (JPM, GS, MS, BAC, WFC, BLK, SCHW) + Healthcare (UNH, LLY, ABBV, JNJ, PFE, MRK, TMO) + Biotech (REGN, VRTX, GILD, BIIB) + Consumer (HD, MA, V, DIS, NKE, SBUX, MCD, WMT, COST) + Cyclicals (CAT, DE, X, BA) + Energy (XOM, OXY, FANG, CVX, SLB) + Defense (LMT, RTX, GD) + Transport (UNP, FDX, DAL) + Telecom (T, VZ, CMCSA) + REITs (SPG, O) + ETFs (SPY, QQQ, IWM, XLE, XLF, XLK, XLV, GLD, TLT)

### Worker/iOS Feature Parity

After v10 sync (2026-04-18): iOS and worker use the same native tree evaluator on the same JSON model files. Worker now fetches stock 1H/4H candles from Yahoo. Remaining ~2-3pp score gap from minor indicator computation differences:

- `dStructBull/Bear` — both sides use EMA stack as proxy
- `hAboveVwap` — VWAP session-anchoring differs subtly
- `hVolumeRatio` — worker returns 0 for stocks (not computed in `extractFeatures`)
- Volume profile POC/VA binning has small residual differences
- `relStrengthVsSpy` — worker doesn't compute (SPY candles available but not used in `computeAllFeatures`)
- `earningsProximity` — worker defaults to 0 (no earnings calendar data)

### Model Comparison Results (v10)

Tested 10 configurations (7 XGBoost + 3 LightGBM). All within 72.9-73.4% crypto, 66.0-66.5% stocks. Selected:
- Crypto: LGB d4 t150 — best WF accuracy (73.4%) + top-bucket reliability (78.7%)
- Stocks: XGB d5 t100 — best top-bucket reliability (77.0%)

Deeper models (d5) and more trees (t200) showed diminishing returns. LightGBM d4 = d5 accuracy, confirming d4 captures all useful interactions.

## Known Remaining Issues (Low Severity)

- No certificate pinning on network calls
- Missing accessibility labels on charts and several interactive elements
- Missing App Group entitlement on main app target (widget can't share data)
- `aps-environment` hardcoded to `development` in entitlements
- Worker: APNs tries sandbox first then production (doubles latency); JWT not cached per cron; cron processes devices sequentially
- CoreML .mlmodel files still in bundle (unused — can be removed to reduce app size)
- MLCalibration.swift still in project (unused — calibration embedded in model JSON)
- `ml-training/calibrate_v9.py` name is stale (actually trains v10 models)
