# CLAUDE.md — MarketScope (CryptoLens)

## Project Overview

MarketScope is an iOS app for multi-timeframe technical analysis of crypto and stock markets. It computes indicators locally, fetches market data from multiple providers, and sends it to Claude/Gemini AI for analysis with trade setups.

- **Bundle ID:** `com.ludikure.CryptoLens`
- **App Store name:** MarketScope
- **Version:** 1.2 (build 21)
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
Utils/          → Constants, formatters, helpers, ViewHelpers (shared UI functions), MarketHours
Resources/      → Assets.xcassets
```

### Cloudflare Worker (`marketscope-worker/`)

TypeScript worker that proxies API calls, handles auth, push notifications (APNs), and alert checking via cron. Deployed to `marketscope-proxy.ludikure.workers.dev`.

### Key Patterns

- **`AnalysisService`** (`@MainActor`, `ObservableObject`) is the central coordinator. Owns all network services, publishes results. Hooks into `OutcomeTracker` on each refresh.
- **`YahooFinanceService`** is an **actor** (not a class) — all calls require `await`.
- **`AlertsStore`** and **`FavoritesStore`** are `@MainActor` — all mutations must happen on main thread. `AlertsStore` has `processPendingBackgroundAlerts()` for bridging background-triggered alerts.
- **`Constants.customStocks`** and its accessors (`stock(for:)`, `asset(for:)`) are `@MainActor`.
- **Symbol selection** is unified in `AnalysisService.switchToSymbol()` — both `ContentView` and `FavoritePillsView` delegate to it. It handles cancellation of in-flight requests.
- **Indicator computation** happens in `IndicatorEngine.computeAll()` — pure functions, no side effects. Includes full MACD/ADX/volume ratio series for chart sub-panels. **In-progress candle is dropped at the top of `computeAll`** (if `last.time + interval > now`) so live price ticks don't mutate indicators between refreshes. Same logic mirrored in `marketscope-worker/src/index.ts` via `dropInProgress()`.
- **`AnalysisHistoryStore`** serializes all disk I/O on a dedicated `DispatchQueue`.
- **`OutcomeTracker`** tracks trade setup outcomes (entry/SL/TP hits, max excursions) and FLAT/kill outcomes (false conservatism detection). Persists to `~/Library/Caches/trade_outcomes/`.
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

v9 dual XGBoost binary classifiers (crypto / stock) predicting direction-agnostic `goodR = fwdMaxFavR >= 1.5` — probability of a ≥1.5 ATR favorable move within 24H. The LLM determines direction from momentum; ML answers "trade or not?"

- **Features:** 101 (stripped from 105: removed dailyScore, fourHScore, scoreSum, scoreDivergence — 0-6 tree splits each, noise-level; removed daysToEarnings, daysSinceEarnings, isEarningsWeek — 0 splits, no signal)
- **Crypto model:** 76 symbols (56 pre-2021 + 20 post-2021), 141,742 bars, **72.6% WF accuracy**
- **Stock model:** 43 symbols (mega-cap + growth + cyclicals + energy + biotech + REITs + financials + ETFs), 47,829 bars, **66.4% WF accuracy**
- **Target:** `goodR = fwdMaxFavR >= 1.5` (max favorable excursion in ATR multiples)
- **Training:** Walk-forward CV (3-fold expanding window), purged 48-bar gap, daily downsampled, time-decay sample weighting (last year 3x, last 2 years 2x), hyperparams `depth=3, n_estimators=100, lr=0.03, reg_alpha=0.1, reg_lambda=1.0`
- **Calibration:** Isotonic regression fit on out-of-fold predictions, capped at 0.85. Top-bucket reliability: crypto [0.70, 0.85) = 73.1% actual on 8,834 samples; stocks [0.70, 0.85) = 75.1% on 10,901 samples.
- **Abandoned experiments:** v10 signed models (goodR_long/short) — identical top-bucket, crypto-short too sparse (9 samples), stock-short saturates at 0.43. Earnings calendar features (3) — 0 tree splits, no signal. Score-derived features (4) — noise-level splits, create unnecessary ScoringFunction→ML dependency.

### Feature Groups (101 total)

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
| Computed | 4 | volWeightedRsi, hVolWeightedRsi, atrExpansionRate, fundingSlope |

### Files

| File | Purpose |
|------|---------|
| `Models/BacktestResult.swift` | `MLFeatures` struct (101 fields), `BacktestDataPoint` |
| `ML/MLScoring.swift` | CoreML inference; `predict(features:)` returns calibrated goodR |
| `ML/MLCalibration.swift` | Isotonic calibration; 2 maps loaded from bundle JSONs |
| `ML/MarketScoreML_{crypto,stock}.mlmodel` | 2 CoreML models |
| `ML/{crypto,stock}_calibration.json` | iOS sidecar calibration maps |
| `Services/BacktestEngine.swift` | Backtest loop, feature extraction, CSV export, batch export |
| `Services/AnalysisService.swift` | `buildMLFeatures()` for live predictions; stores `mlWinProbability` on `IndicatorResult` |
| `Services/FearGreedService.swift` | Historical Fear & Greed from Alternative.me |
| `marketscope-worker/src/ml-predict.ts` | Worker `mlPredict()` evaluates tree JSONs, applies embedded calibration |
| `marketscope-worker/src/ml-model-{crypto,stock}.json` | 2 worker model JSONs (trees + calibration block) |
| `marketscope-worker/src/scoring-full.ts` | Worker 101-feature computation (Wilder ADX/ATR, 4H-ATR-normalized volume profile, %-scale BB bandwidth, ported ScoringFunction for tfAlignment — must match `IndicatorEngine` to stay in training distribution) |
| `Services/EarningsCalendar.swift` | Stock earnings date lookup from bundled JSON (not used in ML — 0 tree splits — but available for future use) |
| `Resources/earnings_history.json` | Bundled earnings dates for 39 stocks, 2020-2026 (from yfinance via `ml-training/earnings_backfill.py`) |
| `ml-training/calibrate_v9.py` | Training + isotonic calibration script — trains 2 models, exports CoreML + worker JSON |
| `ml-training/train_signed_v10.py` | Abandoned signed-model experiment (kept as reference) |

### ML in Live Predictions

- `AnalysisService.buildMLFeatures()` constructs `MLFeatures` from live indicator data
- Rate-of-change deltas computed from `prevMLSnapshots` (stored per-symbol between refreshes)
- Basis fetched from Binance `/fapi/v1/premiumIndex`
- Fear & Greed from CoinGecko (already fetched for sentiment)
- ETH/BTC from Binance ETHBTC candles
- Previous 1-bar deltas stored for acceleration computation
- Regime changes tracked via `lastRegime` dict

### Worker ML Scoring (Cron)

- Runs every minute via `scheduled()` handler
- Fetches candles (in-progress dropped via `dropInProgress()`), computes all 101 features via `scoring-full.ts`
- Fetches live: VIX/DXY (Yahoo), Fear & Greed (Alternative.me), ETH/BTC (Binance, 1-bar 4H delta), funding rate + OI + L/S + taker + basis (Binance fapi)
- Rate-of-change + acceleration from KV-persisted snapshots
- Volume profile computed via TypeScript port of `VolumeProfile.swift`, ATR-normalized by 4H ATR (matches training)
- Archives derivatives to D1 every 4H for future training
- Writes calibrated goodR probability to `score_history.ml_probability` per cron per symbol
- Notifications: fires when ML_WIN >= 0.70 (top-bucket only, 73% actual win rate), at hours 9/15/21 `America/New_York`, with 5h KV-backed cooldown per (device, symbol). Max 3 notifications/day/symbol.

### Backtest & Training

- `BacktestEngine` runs walk-forward eval on historical candles
- Fetches from D1 archive first, falls back to Binance/Yahoo/TwelveData
- Crypto clamped to Jan 2020 start (derivatives coverage)
- Exports CSV with all 101 features + forward returns + trade outcomes
- Batch export: separate "Crypto Only" / "Stocks Only" buttons
- 3-second delay between stock symbols to avoid rate limiting
- Training: `calibrate_v9.py` with purged time-series CV, daily downsampling, sample weighting

### Backtester Symbols

- **Crypto (76):** 56 pre-2021 (BTC, ETH, BCH, XRP, LTC, TRX, ETC, LINK, XLM, ADA, XMR, DASH, ZEC, XTZ, BNB, ATOM, ONT, IOTA, BAT, VET, NEO, QTUM, IOST, THETA, ALGO, ZIL, KNC, ZRX, COMP, DOGE, KAVA, BAND, RLC, SNX, DOT, YFI, CRV, TRB, RUNE, SUSHI, EGLD, SOL, ICX, STORJ, UNI, AVAX, ENJ, KSM, NEAR, AAVE, FIL, RSR, BEL, AXS, SKL, GRT) + 20 post-2021 (SAND, MANA, HBAR, MATIC, ICP, DYDX, GALA, IMX, GMT, APE, INJ, LDO, APT, ARB, SUI, PENDLE, SEI, TIA, JUP, PEPE)
- **Stocks (44):** Mega-cap (AAPL, TSLA, MSFT, NVDA, GOOGL, META, AMZN, JPM, UNH, HD, MA, ABBV, V, AMD, NFLX, BA, XOM, CRM, LLY, DIS) + Growth (PLTR, ROKU, SHOP) + Short-interest (BYND, GME) + Cyclicals (CAT, DE, X) + Energy (OXY, FANG) + Biotech (REGN, VRTX, GILD, BIIB) + REITs (SPG, O) + Financial (GS) + ETFs (SPY, QQQ, IWM, XLE, XLF)

### Worker/iOS Feature Parity

After the 2026-04-16 port audit + scoring port, most features are synced:

**Fixed:** ADX (Wilder smoothing), ATR (Wilder + 4H source), BB bandwidth (×100), atrPercent (4H), volume profile ATR normalization (4H), ethBtcDelta6 (1-bar), ScoringFunction ported faithfully to TypeScript (`computeScore` in `scoring-full.ts` matches iOS's `ScoringFunction.score()`), score-derived features removed (no longer a divergence source).

**Remaining minor gaps:**
- `dStructBull/Bear` — both sides use EMA stack as proxy (consistent approximation; iOS's MarketStructure.analyze not ported but both sides approximate the same way)
- `oiSignal` — worker has no prev-OI state tracking (`oiChangePct=0` always)
- `hAboveVwap` — VWAP session-anchoring differs subtly
- Volume profile POC/VA binning has small residual differences

## Known Remaining Issues (Low Severity)

- No certificate pinning on network calls
- Missing accessibility labels on charts and several interactive elements
- Missing App Group entitlement on main app target (widget can't share data)
- `aps-environment` hardcoded to `development` in entitlements
- Worker: APNs tries sandbox first then production (doubles latency); JWT not cached per cron; cron processes devices sequentially
- Worker VIX/DXY hardcoded default as fallback (low importance features)
- Some stock ML features default in live (relStrengthVsSpy, beta, gapFilled — would need SPY candle fetch + intraday tracking)
