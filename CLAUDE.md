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

## Research Vault (`docs/research/`)

The empirical "why" layer — backtest findings, EV measurements, model decisions, and the
**rejected-hypotheses graveyard** — lives in `docs/research/` as linked markdown (start at
`docs/research/README.md`; openable as an Obsidian vault). **This doc (CLAUDE.md) is the
current-state operational reference; the vault is the deep archive + reasoning.** Before
re-proposing an experiment, check `docs/research/rejected-hypotheses.md`. When a research
finding changes, update the relevant note *and* the one-line summary here. Key entry points:
`edge-methodology`, `edge-direction-primitive`, `edge-crypto-direction-model`,
`edge-stock-direction-rejected`, `live-validation`, `ml-model-versions`, `ml-additive-heads`,
`strategy-targets-bands`, `rejected-hypotheses`.

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

TypeScript worker that proxies API calls, handles auth, push notifications (APNs), and alert checking via cron. Deployed to `marketscope-proxy.ludikure.workers.dev`. Cron runs every minute. Single file `src/index.ts` (~2,600 lines) holds the router, the cron orchestrator, and all endpoint handlers. Tests in `test/` exercise feature parity vs the iOS BacktestEngine at 1e-7 tolerance.

#### Endpoint inventory

Auth gate at `index.ts:158` routes through D1 validation for every endpoint EXCEPT the public ones listed below. All requests must carry `X-App-ID: marketscope-ios` regardless. POST body size capped at `MAX_BODY_BYTES` except `/history`.

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/` `/health` | GET | none | Liveness check |
| `/register` | POST | X-App-ID only (IP rate-limited 3/24h) | Issue auth token for a new device; idempotent for existing device_id with valid token |
| `/alerts` | POST/GET/DELETE | required | Sync alerts list to D1 / fetch active / clear |
| `/pending-setups` | POST/GET | required | Register conditional setups for entry-zone touch monitoring |
| `/watchlist` | POST | required | Set symbols to monitor + ML thresholds (symbols are sanitized + uppercased) |
| `/analyze` | POST | required (60/min rate-limited) | Proxy AI provider call (Claude/Gemini/DeepSeek) with allowlist enforcement |
| `/outcomes` | POST/PUT/GET | required | Trade outcome capture, update closed-trade, fetch device history (optional symbol/model_version/prompt_version filters) |
| `/scores` | GET | required | Per-device score history (ML probability time series) |
| `/notifications` | GET | required | Per-device push notification log |
| `/performance` | GET | required | Per-symbol win/loss aggregate stats |
| `/ml-predict?symbol=…` | GET | required | Read ML prediction from `ml_preds:all` KV (5-min TTL, written by cron). Returns `{symbol, probability, probabilityH72, features, timestamp, isCrypto}` |
| `/ml-models/version` | GET | required | Model JSON metadata (version, features, trees, uploaded date) |
| `/history` | GET/POST | required (POST: 5/5min rate-limit) | D1 candle archive read / upload from app backtest |
| `/macro` | GET | required | FRED economic data proxy |
| `/yahoo/quote` `/yahoo/summary` `/yahoo/options` | GET | required (cached 60s–10min) | Yahoo Finance proxy |
| `/tiingo/candles` | GET | required (cached 10min) | Tiingo stock candles |
| `/twelvedata/candles` `/twelvedata/quote` | GET | required (cached 10min) | TwelveData stock candles + quotes |
| `/alphavantage/intraday` | GET | required | AlphaVantage historical 1H fallback |
| `/finnhub/market-status` `/finnhub/*` | GET | required (cached 60s–1h) | Finnhub proxy (market status, analyst recs, earnings, news) |
| `/bls/actuals` | GET | none (public) | BLS economic indicators |
| `/derivatives` | GET | none (public) | Binance derivatives proxy (cached 5min) |
| `/spot` | GET | none (public) | Spot price (cached 60s) |
| `/candles/crypto` | GET | none (public) | Crypto candles (variable TTL) |
| `/sentiment` | GET | none (public) | Fear & Greed proxy (cached 10min) |
| `/darkpool?symbol=…` | GET | none (IP rate-limited 60/min) | FINRA dark pool ratio + Z-score |
| `/direction-accuracy` | GET | required | Live forward track record of the dual-gate direction model (universe-wide, not per-device). Overall accuracy + by-confidence-band + recent graded signals + pending count. Reads `direction_signals` D1 |
| `/ml-calibration` | GET | required | Live calibration of the ML *quality* model: realized goodR rate by predicted-probability bucket. Drift detector. Reads `ml_calibration` D1 |
| `/cron-health` | GET | none (public) | Dead-man's-switch: returns **503** when the cron heartbeat is stale (>10 min), 200 otherwise. Point an external uptime monitor here. Reads `cron:heartbeat` KV |
| `/debug/features` | GET | required | Read `debug:<sym>_features` KV for parity investigation |
| `/debug/backfill-derivatives` | POST | required (X-App-ID gated) | One-off derivatives backfill from Binance to D1 |

**Cron-only operations (no endpoint):**
- `checkAllDeviceScores` (orchestrator) → `computeSymbolPredictions` (symbol pass, writes `ml_preds:all` etc.) → `processDeviceNotifications` (per-device gating + APNs)
- `checkAllDeviceAlerts` (price-alert evaluation, `Promise.allSettled` for fault isolation)
- `archiveShortInterest` (daily FINRA pull → `short_interest_history` D1)
- `cleanupStaleDevices` (daily, 30-day inactivity sweep)
- `dedupe_old_setups` (in pending-setup loop)

#### D1 schema reference

Migrations under `marketscope-worker/migrations/*.sql`. **Note:** Some columns and the `pending_setups` table were added out-of-band (via `wrangler d1 execute`) and aren't in any migration file — flagged below. A fresh D1 created from `migrations/*.sql` alone would fail.

| Table | Created | Columns | Indexes |
|---|---|---|---|
| `devices` | 001 | device_id PK, push_token, auth_token, platform, created_at, last_seen | (primary key) |
| `alerts` | 001 | id PK, device_id FK, symbol, target_price, condition, note, triggered, triggered_at, created_at | `idx_alerts_device(device_id, triggered)` |
| `watchlist` | 001 | device_id+symbol PK, crypto_threshold, stock_threshold | (composite PK) |
| `score_history` | 001 | id PK, device_id FK, symbol, timestamp, daily_score, four_h_score, ml_probability, bias, notification_sent | `idx_scores_device_symbol(device_id, symbol, timestamp DESC)` |
| `trade_outcomes` | 001 + 003 + OOB | id PK, device_id FK, symbol, direction, entry_price, stop_loss, tp1, tp2, ml_probability, daily_score, four_h_score, conviction, opened_at, closed_at, outcome, pnl_percent, notes, model_version (003), **prompt_version (OOB — no migration)** | `idx_outcomes_device(device_id, opened_at DESC)`, `idx_outcomes_model(device_id, symbol, model_version)` (003), `idx_outcomes_prompt(device_id, prompt_version)` (006) |
| `notifications` | 001 | id PK, device_id FK, symbol, type, ml_probability, score, direction, sent_at | `idx_notif_device(device_id, sent_at DESC)` |
| `candles` | 001 | symbol+interval+timestamp PK, open, high, low, close, volume | `idx_candles_lookup(symbol, interval, timestamp DESC)` |
| `derivatives_history` | 001 + 002 + OOB | symbol+timestamp PK, funding_rate, open_interest, long_percent, taker_ratio, top_trader_long_pct (002), taker_buy_vol (002), taker_sell_vol (002), mark_price (002), index_price (002), basis_pct (002), **large_buy_vol (OOB)**, **large_sell_vol (OOB)**, **large_buy_count (OOB)**, **large_sell_count (OOB)** | `idx_deriv_lookup(symbol, timestamp DESC)` |
| `short_interest_history` | 004 | symbol+date PK, short_volume, total_volume, short_ratio, short_zscore | `idx_short_lookup(symbol, date DESC)` |
| `notif_claims` | 005 | push_token+symbol PK, expires_at | `idx_notif_claims_expires(expires_at)` |
| `pending_setups` | OOB (lazy `CREATE IF NOT EXISTS` at `index.ts:219`) | id PK, device_id, symbol, direction, entry, atr, ml_at_registration, expires_at, registered_at, notified | `idx_pending_setups_symbol`, `idx_pending_setups_device` (both lazy) |
| `direction_signals` | OOB (lazy `CREATE IF NOT EXISTS`, `ensureDirectionSignalsTable`) | id PK, symbol, fired_at, entry_price, ml_win, p_up, predicted_dir, model_version, is_crypto, resolve_at, resolved, exit_price, fwd_return, actual_dir, correct | `idx_dirsig_unresolved(resolved, resolve_at)`, `idx_dirsig_symbol(symbol, fired_at DESC)` (both lazy) |
| `ml_calibration` | OOB (lazy `CREATE IF NOT EXISTS`, `ensureCalibrationTable`) | id PK, symbol, is_crypto, logged_at, entry_price, atr_price, predicted_prob, resolve_at, resolved, fav_r, good_r | `idx_cal_unresolved(resolved, resolve_at)`, `idx_cal_symbol(symbol)` (both lazy) |

**Schema drift items** (low-severity, but flagged): `trade_outcomes.prompt_version`, four `derivatives_history.large_*` columns, and the entire `pending_setups` table aren't in any migration file. Consolidation to a `006_schema_drift.sql` is in the postponed-work doc.

#### KV blob inventory (`env.ALERTS` namespace)

Single Cloudflare KV namespace. All blobs JSON-encoded except where noted. TTLs are seconds.

| Key pattern | TTL | Written by | Read by | Content |
|---|---|---|---|---|
| `ml_preds:all` | 300 (5 min) | cron `computeSymbolPredictions` | `/ml-predict` endpoint | `{symbol: {symbol, probability, probabilityH72, features, timestamp, isCrypto}}` for all archive symbols |
| `ml_snapshots` | 86400 (24 h) | cron | cron next-tick | Per-symbol prev-bar values for rate-of-change deltas (dRsi/dAdx/hRsi etc.) |
| `prev_oi:all` | 86400 | cron | cron | Per-symbol last-bar OI for delta computation |
| `deriv_archive:all` | 14400 (4 h) | cron | cron | Per-symbol last derivatives-archive timestamp (D1 write gate) |
| `candles:all:1d` `:4h` `:1h` | 300 | cron (only on miss) | cron | Per-symbol candle arrays for cron reuse across ticks |
| `darkpool:latest` | (no TTL — daily refresh) | `archiveShortInterest` | `/darkpool` endpoint | FINRA dark pool ratios + Z-scores per symbol |
| `short_arch:last_date` | (no TTL) | `archiveShortInterest` | `archiveShortInterest` | Daily dedupe gate |
| `cleanup:last_date` | 86400 × 2 | `cleanupStaleDevices` | `cleanupStaleDevices` | Daily dedupe gate |
| `debug:<sym>_features` | 3600 (1 h) | cron (BTC/ETH/TSLA/NVDA only) | `/debug/features` | Features dict + mlProbability for parity investigation |
| `auth:<deviceId>` | 86400 × 90 (90 d) | `/register` | auth gate (D1 fallback) | Legacy KV auth token (D1 is primary; this is the fallback) |
| `device:<deviceId>` | (no TTL — legacy) | (legacy `/register`) | `getPushToken` (fallback) | Legacy device blob with push token |
| `watchlist:<deviceId>` | 86400 × 30 | `/watchlist` | cron device pass | Per-device watchlist + ML thresholds (cron reads from KV during migration) |
| `reg-ip:<ip>` | 86400 | `checkRateLimit` (in `/register`) | `checkRateLimit` | IP-based registration rate limit counter (3/24h) |
| `global:<deviceId>` | 60 | auth gate `checkRateLimit` | auth gate | Per-device global rate limit (60/min) |
| `analyze:<deviceId>` | 60 | `/analyze` | `/analyze` | Per-device AI proxy rate limit |
| `history-upload:<deviceId>` | 300 | `/history` POST | `/history` POST | Per-device candle upload rate limit (5/5min) |
| `darkpool-ip:<ip>` | 60 | `/darkpool` | `/darkpool` | Per-IP dark pool rate limit (60/min) |
| `yahoo:*` `tiingo:*` `twelvedata:*` `finnhub:*` `alphavantage:*` | 60–3600 | various provider proxies | same | Upstream API response caches |

The cron writes are batched to avoid KV write amplification: pre-2026-05 the cron wrote 4-5 blobs per symbol per minute (~76 × 5 × 60 = 22,800 KV writes/hour). Now batched per-cron blobs: 5 blobs total per minute regardless of symbol count.

#### Auth flow

1. **First launch:** iOS generates a `device_id` UUID, stores in UserDefaults under key `device_id`.
2. **Registration:** iOS calls `POST /register` with `X-App-ID: marketscope-ios`, `X-Device-ID: <uuid>`, and optionally `deviceToken` body for APNs. Worker writes `(device_id, push_token, auth_token)` row to D1 + KV mirror, returns `{authToken}`.
3. **Token storage:** iOS stores `authToken` in Keychain under `worker_auth_token`.
4. **Subsequent requests:** `PushService.addAuthHeaders(_:)` (`nonisolated` for thread-safety — see Concurrency Model section) adds three headers: `X-App-ID`, `X-Device-ID`, `X-Auth-Token`. Worker auth gate at `index.ts:158` validates the token against D1 (with KV fallback for legacy migration). Constant-time comparison via `timingSafeEqual()`.
5. **401 handling:** `AlertsStore.syncFromServer` and `PushService.syncAlerts` both treat a 401 response as a signal to call `PushService.handleAuthFailure()` — which clears the auth token, generates a NEW `device_id`, and re-registers. The old D1 row stays as an orphan; `cleanupStaleDevices` daily cron prunes them after 30 days inactivity.
6. **Cooldowns and gates** (notification + analyze + global rate-limit) are keyed by `push_token` rather than `device_id` for the notification path — iOS rotates `device_id` on auth recovery but the underlying physical device's APNs token stays stable, so push_token-keyed cooldowns correctly dedupe across rotated rows.

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
- **Structure Levels** (2026-05-29; strength tags neutralized 2026-05-31): 4H swing levels within 2× ATR of price, tagged with direction (RES above / SUP below), neutral `tested_Nx` count, and `FLIP` (appeared as both a recent swing high AND low). The former WORN_Nx_distrust / FRESH_1x_strongest_reaction / FLIP_ROLE-stronger *strength* tags were dropped after `ml-training/level_validation.py` (58k retests) showed test-count and flip do **not** predict hold-vs-break; the `entry_at_worn_level_4+_tests` conviction downgrade was removed too. The levels themselves are validated locations (hold +4.3pp vs random lines, both markets) — only the strength scoring was unsupported. Full finding: `docs/research/strategy-levels.md`. Target-selection still weights by test count (`AnalysisPrompt.swift:2156`) — flagged for a target-specific test.
- **Sector Strength** (stocks, 2026-05-29): `XLK OUTPERFORMING vs SPY (+1.8%) → risk-on tailwind` when relativeStrength1d + outperformingSector are set.
- **Insider Cluster** (stocks, 2026-05-29): `N buys in 30d from K officers ($X.XM total) — fundamental buy signal` when 3+ buys from 3+ distinct names (or 5+ sells from 4+ names for distribution signal).
- **Earnings Proximity** (stocks, 2026-05-29): Hard-wired into the Conviction Envelope, not advisory. 0–2d → moderateBlock (cap LOW = no trade); 3–7d → highBlock (cap MODERATE); 8–14d → downgrade tier (LLM applies).
- **Active Trade State** (continuous values, 2026-05-29): Replaces the older INTRA_24H/IN_PROFIT/UNDERWATER/FLAT buckets. Emits elapsed hours, PnL in R units, peak excursion R, TP1 % reached, ML delta from registration, milestone flags (T+24h crossed, TP1 hit, partial taken, BE-stop active), and a concrete `Action:` line keyed on actual R thresholds (≤ -0.7R → cut, ≥ +0.5R → trail to BE, etc.).
- **STOCH_CROSS** (2026-05-30, treatment-prompt-active = always since A/B collapse): Daily + 4H Stochastic RSI crossover direction ("bullish" / "bearish" / "none"). Co-equal direction primitive with bias alignment per the direction_primitive_sweep backtest. Four rules: (a) Stoch + bias agree → high-conviction, (b) Stoch + bias contradict → flag tension, cap MODERATE unless structural evidence supports bias, (c) bias MIXED + Stoch decisive + ML≥65 → Stoch overrides auto-FLAT (catalyst-driven case), (d) Stoch 'none' both TFs → bias drives. Backtest basis: dStoch + ML≥65 captured +0.190R EV on stocks (vs +0.079R bias-alone) and +0.998R on crypto top-10.
- **LONG_CONFIRMATION** (2026-05-30, stocks only): relStrengthVsSpy ≥ 1 AND dRsiDelta ≥ 1. PASS → unrestricted LONG; PARTIAL → cap LOW; FAIL → no LONG trade. Backtest: lifts aligned_bullish + ML EV from +0.122R to +0.171R, rescues stocks fold-5 (current bull) from −0.069R to +0.067R. Crypto has neither field — gate inactive (returns "n/a").
- **BB_EXTREME** (2026-05-30): When dBBPercentB ≤ 0.1 or ≥ 0.9, prompt emits explicit "DO NOT short this — fading band touches LOSES money (-0.052R EV)". Treat as continuation, not fade.
- **MACRO_CONTEXT** (2026-05-30): Labeled DXY / SPY / VIX state pulled from crossAsset + stockSentiment. Surfaces direction-relevant macro signals the LLM previously had to infer from raw numbers.
- **CRYPTO REGIME** (2026-05-30, crypto only): survivorship + leverage tail-risk overlay computed from the analyzed symbol's daily EMA200. BEARISH (price < 200D EMA AND 200D sloping down over last 20 daily bars) → caps LONG conviction at MODERATE + halve size, SHORTs unaffected; also adds `crypto_bear_regime_LONG_cap_MODERATE_halve_size` to the envelope downgrade list. WEAK (below 200D, slope not yet down) → one-line "LONGs need extra confirmation". Rationale: `edge_revalidate.py` showed the ML edge stays +EV in 2022-bear folds, but only on symbols that survived — the dataset has no delisted tokens, so a real leveraged bear is an unmodeled tail risk. Advisory + envelope downgrade, not a hard FLAT (the historical edge is real).
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
3. **Step 3 — Directional thesis**: LLM reads raw candles/indicators across timeframes and forms its own thesis. Direction predictability is **market-specific** (measured 2026-05-30, `ml-training/direction_accuracy*.py`): for **stocks**, next-bar direction is essentially random absent structural evidence (~50% on 235K stock bars), so continuation and reversal carry equal evidentiary burden. For **crypto at high ML it is NOT random** — holdout directional accuracy at ML_WIN ≥ 70% is ~76% (daily Stoch cross alone) / ~79% (bias∪Stoch) / **~94% (bias AND daily Stoch agree)** vs a balanced ~52% base rate. This survives the 2022-bear fold (not trend-following) and a momentum-lag test (dStoch[T] 76% → [T-1] 64% → [T-2] 58% → shuffled-null 50% — real persistence, not leakage). Mechanism: crypto is momentum-driven, and high ML selects big-move bars where a fresh Stoch cross is a directional initiator. So the prompt now lets the LLM commit to crypto direction with HIGH conviction when ML_WIN ≥ 70% and momentum aligns; stocks (and crypto conflict/low-ML) keep the equal-burden structural workflow. Caveats: surviving-symbol universe; net-24h direction (live, after stops/funding, lower).
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
| Timing | **Real-time** (fires the cron tick a 4H close crosses up) | **Real-time** |
| Days | Every day | Every day (no weekday gate — market-closed bars just don't cross) |
| Threshold | ML rising-edge >= 70% | ML rising-edge >= 70% |
| Direction primitive | bias-aligned OR dStochCross (union, skip conflicts) | bias-aligned OR dStochCross (union, skip conflicts) |
| Cooldown | 3.5 hours per (push_token, symbol) | 3.5 hours per (push_token, symbol) |

**Real-time gate (2026-05-30):** the notification fires the instant a cross is detected (`if (!pred.crossed || !pushToken) continue` in `processDeviceNotifications`), gated only by the 3.5h cooldown. The previous fixed notify-window gate (8/12/16/20/23:30 ET crypto; 8/12/16 ET weekday stocks) silently **dropped** crosses landing off-window rather than deferring them: `mlProb` only moves on a 4H close and `crossed` is true for a single cron tick (`prevMl` = previous minute, cron runs `* * * * *`), so any 4H close outside a window was missed entirely. With crypto closing 24/7, most signals were lost. Quiet-hours is delegated to the user's iOS Focus/DND. The `computeNotifyFlags`/`NotifyFlags`/`NOTIFY_TZ` window machinery was removed.

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

### Model Comparison Results

Crypto LGB d4 t150, stocks XGB d5 t100 (deeper/more-trees showed diminishing returns; d4 = d5 accuracy). Carried from v10 selection into v11/v13. **Full reliability tables, the "own-data vs fresh-data" accuracy trap, and parity details: `docs/research/ml-model-versions.md`.**

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

### Crypto Runner Widening (2026-05-30)

Within the tighter-band (`isWideBand`) path, the TP2 runner is now market-aware: **crypto** uses ideal 3.0 ATR (band 2.0–3.5, R:R cap 1.75), **stocks** stay at ideal 2.5 ATR (band 2.0–3.0). Justification: `ml-training/composite_band_backtest.py` models the actual execution (50% off at TP1, stop trails to break-even, runner to TP2) on the clean multi-fold WF (incl. 2022 bear). Once TP1 books and the stop is at BE the runner is downside-free, so a wider TP2 only adds upside — crypto blended EV climbs +1.29R→+1.37R going 2.5→3.0 ATR (+1.42R at 3.5; knee ~3.0–3.5). Stocks gain only +0.007R from the same widening and carry overnight gap risk through the BE stop, so they're left at 2.5. The ATR-fallback TP2 multiple matches (crypto wideBand 3.0×, else 2.5×). `isCrypto` = `symbol` ends in `USDT`.

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

`ml-training/direction_primitive_sweep.py` tested 12 direction primitives; the union of bias OR dStochCross won on **total R captured** on both markets (stocks 12× / crypto 1.9× the former bias-alone production), per-trade EV nearly identical — it wins by firing more often without diluting EV. Leakage-free re-validation (`edge_revalidate.py`) reproduced the per-trade numbers within ~0.03R and held through the 2022-bear fold. **Full sweep tables, the leaky-vs-clean comparison, and why bias differs on stocks (~5% fire, no derivatives/cross-asset) vs crypto (88% bias∩Stoch agreement): `docs/research/edge-direction-primitive.md`.**

### Tested-but-rejected

The full graveyard — rejected direction primitives (hStochCross, hMacdCross, dEmaCross, dStack, dDivergence, the bias∩Stoch intersection), the Stoch-only notification gate (shipped + rolled back same-day for −80% R), the stock direction model, the exhaustion gate, ML phases 4/5/6 — with the killing numbers: **`docs/research/rejected-hypotheses.md`. Check it before re-proposing anything.**

### Coherence between worker + iOS

The worker decides whether to notify based on the union primitive. The iOS prompt (treatment-conditional STOCH_CROSS block, now always active) has explicit rules for how the LLM should weigh Stoch direction relative to bias direction (agree → high conviction; contradict → flag tension; bias MIXED + Stoch decisive + ML≥65 → override auto-FLAT; both 'none' → bias drives). The result is a system where the notification gate and the LLM analysis see Stoch the same way.

## Known Remaining Issues (Low Severity)

- No certificate pinning on network calls
- Missing App Group entitlement on main app target (widget can't share data)
- Worker: APNs tries sandbox first then production (doubles latency). Transient-error fallback was improved 2026-05-30 (only conclusive token-level errors like 410 Unregistered now break the loop; 429/5xx still attempt prod). JWT now cached for 50 min per cron (was rebuilt per send pre-2026-05-30).
- Parity fixtures (BTC/ETH/TSLA at 2026-05-04) still in use under v11/v13 — `expected.mlProbability` values were updated in-place via `marketscope-worker/scripts/update-fixture-ml.ts`. Feature-level parity assertions are still measured against the 2026-05-04 feature snapshots; capturing fresh fixtures at a current date is a low-priority follow-up.
- Backtester: crypto regen ~7h at concurrency 8 (Binance rate-limit cascade); stocks regen ~3.5h across two passes (Yahoo TCP drops at concurrency 8). Section H/K of `/Volumes/External/Downloads/marketscope-postponed-work.md` documents the concurrency tuning + raw candle cache opportunity.
- ~~72h persistence model not yet retrained on fresh data~~ — RESOLVED 2026-06-05: retrained crypto on leak-clean `csv_exports_v11_fixed` (stock was leak-spared, reproduced identically). See the 2026-06-05 decision entry.
- Schema drift: `derivatives_history` table has 4 columns (`large_buy_vol`, `large_sell_vol`, `large_buy_count`, `large_sell_count`) added out-of-band; `trade_outcomes.prompt_version` similarly added without a migration file. A fresh D1 created from `migrations/*.sql` alone would fail INSERTs. Migration file consolidation is a low-priority follow-up.
- Derivatives D1 archive runs ~9× per day per symbol vs the intended 6.85× (3.5h gate). The `deriv_archive:all` KV blob occasionally evicts across overlapping crons, resetting per-symbol last-archive times. Storage cost minor (~700 extra rows/day across 76 symbols); fix is to move the per-symbol gate state from KV to D1.

## Recent Architectural Decisions

Reverse-chronological log of major architectural changes. New sessions should scan from the top — most recent context is most relevant for understanding the current system state.

### 2026-07-05 — Live-price anchor (AI + charts) + chart gesture fixes + 429 poll fix

Three user-reported bugs, all stemming from the closed-bar-only data contract:
- **AI told the user "if price holds over 62,900" when live was 63,700.** `/full-analysis` never fetched the live price — the whole prompt is closed-bar (training parity), so the LLM believed price = the last closed 4H bar. Fix: `runFullAnalysisCore` fetches `fetchLivePrice`, and `buildUserPrompt` (new `livePrice` input) opens with `=== LIVE PRICE (authoritative current price) ===` instructing the model to anchor all current-price/trigger/proximity statements to live and to call out already-passed triggers. Asserted in prompt-parity tests.
- **Charts ended at different stale prices per TF.** Worker serves closed bars only, so the 4H chart's newest bar was up to 4h old. Fix (iOS `WorkerIndicatorsService`): synthesize the **forming bar** from livePrice (open = last close, close = live; wick approximate, self-corrects at close) and append to `tf.candles` + set `inProgressCandle`. Indicator math untouched (computed server-side on closed bars).
- **Chart gestures janky (body pan + pinch) while price-axis drag was fine.** The tell: only time-scale-changing gestures were bad. Pane sync used time-based `setVisibleRange` per gesture frame (expensive + bar-snapping). Fix (`chart.html`): logical-range sync (`subscribeVisibleLogicalRangeChange`) with sub-series whitespace-padded to the candle range (`padToTimes`) so bar indices align across panes; `touch-action:none` on panes; WKWebView scrollView pan/pinch recognizers disabled + `delaysContentTouches=false` (`WebChartView`).
- **429 killed analyses.** The global 60/min device budget was drained by the 3s result-poll (20/min) + refresh traffic, and a rate-limited POLL failed the UI while the box job kept running. Fix: `/full-analysis/result` exempt from the global budget (worker) + iOS treats poll-429 as transient and keeps polling.
- Also this session: the MetroNow Android project accidentally duplicated into `MarketScopeWidget/app/` (6,327 files staged, broke the Xcode build with "no rule to process .java") was verified byte-identical to its real repo (`/Volumes/External/metronow-android`), unstaged, deleted, and the Xcode project regenerated clean.

### 2026-07-05 — Full feature+model audit (both markets): configs hold; derivatives features were never trained

`ml-training/feature_model_audit.py` (pre-declared: canonical folds/weights/purge mirrored from the calibrate scripts; model bar = ΔAUC>+0.005 in ALL folds; ablation bar = ±0.005). Findings:
- **Models keep their seats.** Crypto LGB d4/t150: no challenger passes (best +0.0015, 2/3 folds). Stocks XGB d5/t100: deeper configs (XGB/LGB d6-t200, LGB d5-t300) beat prod in **3/3 folds** at +0.0033..+0.0044 with better top-decile+Brier — under the bar, but re-validate d6-class capacity at the next stock retrain.
- **The 20 derivatives features contributed ZERO splits — a coverage artifact, not a signal verdict.** Training data (v11_fixed): OI/taker/long%/crowding populated on only 1–2.5% of bars (30-day API window); funding 50% (yet still zero splits); `basisPct`/`basisExtreme` MISSING from the CSVs entirely → **train/serve skew** (live computes real basis; model trained on constant 0). Next regen must: emit basis, backfill funding to full history (Binance serves it retroactively), and will inherit the growing full-fidelity archive (real coverage started 2026-04).
- **`volScalarML` ≡ `atrPercentile` (r=1.000)** — literal duplicate, drop one at next retrain.
- **What carries crypto:** temporal group (−0.023 ablation; `dayOfWeek` is the top permutation feature +0.048 — real weekend/weekday vol seasonality) and 4H core (−0.009). Daily core near-neutral post-leak-fix. **Stocks:** `regimeCode`+`tfAlignment` dominate; `earningsProximity` earns its place; macro group is dead weight (+0.002 when dropped).
- **~40–60 dead-weight features** (cross-market constants, 1H entry, 6-bar deltas, accel, macro-on-stocks): individually tiny, prune candidate list for next retrain (train pruned ~60 vs 111 on same folds, ship the winner). No permutation-negative features on either market (no overfit-suspects). Baselines reproduced doc numbers (crypto top-decile 0.768 ≈ 76.3%).

### 2026-07-04 — Whale-trade collection fixed + Binance Vision historical backfill

The `large_*` whale-flow archive (derivatives_history) had a broken definition: threshold was `0.5 × price` = 0.5 UNITS of the asset (~$30k for BTC, literal cents for DOGE-class alts), sampled from **spot** aggTrades. Fixed in `fetchLiveDerivatives` (`src/index.ts`): **futures** aggTrades (`fapi/v1/aggTrades` — where whales actually trade, same venue as the other derivatives signals) + fixed **$100k notional** threshold (`WHALE_NOTIONAL_USD` export, uniform across symbols; zero counts on illiquid alts are honest signal, not a bug). This is a definition discontinuity in the archived series — acceptable because the backfill regenerates history under the new definition.

**New `scripts/backfill-whale-trades.ts`**: reconstructs per-4h-bar whale flow from **Binance Vision** (`data.binance.vision`) daily futures aggTrades dumps — free, no auth, full history. Output CSVs (`ml-training/whale_backfill/<SYM>.csv`: timestamp [4h UTC bucket open], large_buy_vol/sell_vol/buy_count/sell_count). Resumable (continues from last CSV timestamp), streams via `unzip -p` (disk holds only one day's zip), 3-retry then stop-symbol-contiguous. Smoke-tested (ETH 2026-06-28→30: $45–260M per bucket, hundreds of prints; BEL: zero prints — correct for an illiquid alt). SCALE: majors ~50–150MB/day download (2yr BTC ≈ 60–100GB, streamed) — run per-symbol/overnight. Purpose: `large_*` columns are archived but NOT among the 111 model features; the backfill makes the whale-feature hypothesis walk-forward testable NOW instead of after a year of live archiving. 425/425 tests green. **Collector fix deployed to the box 2026-07-04.** **OUTCOME (2026-07-05): whale features REJECTED as ML features** — 2yr backfill (BTC/ETH/ADA/XRP/SOL) tested via `ml-training/whale_feature_test.py` + pre-declared `whale_feature_sweep.py` (alt windows, interactions, XGBoost, 72h target): no variant passed the WF bar; standalone whale AUC ~0.57 = real but REDUNDANT with existing volume/ATR/ADX/derivatives features. Full entry: `docs/research/rejected-hypotheses.md`. Collector + backfill kept (display/whale-trap context).

### 2026-07-04 — Chart tab: dedicated full-screen non-scrolling screen (TradingView-style)

The interactive chart moved OFF the scrolling Overview tab into its own **Chart tab** (`ChartScreenView`, tag 4; tab bar now Overview·Chart·Market·Analysis·Alerts). Key architecture: (a) **fit-to-screen panes** — `chart.html` panes flex proportionally (main 3 : each sub 1) so any panel combination fits one screen, nothing scrolls, the chart owns every gesture; (b) **persistent pre-warmed WKWebView** (`ChartWebViewStore.shared` in `WebChartView.swift`) — created once at app launch, `warmPush` renders data into it from ContentView while other tabs are showing, survives tab switches (the old per-view WKWebView paid full web-process+JS startup every tab visit = "chart loads late"); (c) **WebKit double-tap recognizers disabled natively** post-load (they misclassified fast single-finger drags) + LWC `axisDoubleClickReset` OFF, replaced by an explicit ⟲ reset button (autoscale + default barSpacing + newest bar); (d) **data-identity reset** — payload carries `symbol|tf`; when it changes JS re-enables autoscale on all panes (a manual BTC ~60k price range left ETH ~3k off-screen) while preserving pan/zoom within the same instrument; (e) **drag-resizable panes** (dividers shift flex-grow between neighbors, min 0.25 share); (f) EMA legend (colored EMA 20/50/200, only entries with data); (g) FavoritePillsView on the Chart tab for symbol switching; (h) payload memoized behind a signature (symbol|dataTs|tf|panels|vol|dark) instead of rebuilt every SwiftUI pass; (i) `chart_tf_index` persisted (@AppStorage, shared with warmPush); (j) webview opaque (transparent WKWebView disables compositing fast paths). Overview keeps price header + indicators (IndicatorTableView now defaults expanded, `indicators_expanded` AppStorage) + analysis. TradingView attribution link on the Chart tab (Apache-2.0 requirement).

### 2026-07-03 — Price chart migrated to TradingView Lightweight Charts (WKWebView); Canvas chart deleted

The main price chart (Chart tab) is now **TradingView Lightweight Charts v4.2** (Apache-2.0), hosted in a `WKWebView`, replacing the hand-rolled SwiftUI Canvas `CandlestickChartView`. Plan: `docs/tradingview-chart-plan.md`. Built in phases (POC → parity → sub-panels → cutover), each validated on-device by the user:
- **`CryptoLens/Resources/chart/`** — `lightweight-charts.standalone.production.js` (~160KB, bundled locally, offline) + `chart.html` (multi-pane port of `web/src/components/{ChartPanel,SubPanels}.tsx`, exposes `window.setChart()`).
- **`CryptoLens/Views/WebChartView.swift`** — `UIViewRepresentable` over `WKWebView` + a Codable `ChartPayload` (candles + EMA20/50/200 + curated `WatchLevels` price-lines + volume + dynamic sub-panels). Pushes via `evaluateJavaScript`; Coordinator dedups by encoded-JSON so a re-push doesn't flicker/reset pan-zoom; series are tail-aligned to the candle window (indicator warmup).
- **Features:** timeframe selector (Daily/4H/1H), volume histogram, watch-levels overlay (S/R, VWAP, POC/VA, Entry/SL/TP colored by role), and **toggleable sub-panels RSI/MACD/Stoch/ADX/Vol** (chips above the chart, persisted to `chart_rsi/macd/stoch/adx/vol` UserDefaults; RSI/MACD/Vol default on). Chart height is adaptive (320 + 140/enabled sub-panel). All panes time-synced via `subscribeVisibleTimeRangeChange`; shared axis on the bottom pane.
- **Cutover (commits 8c9b884 + ee93a7e):** deleted `CandlestickChartView.swift` (951 lines: Canvas chart + Canvas sub-panels + custom pan/scrub/zoom gestures) and the `use_webview_chart` flag + Settings toggle — the WebChartView is now unconditional. `LevelsChartView` + `TradeSetupChartView` (compact SwiftUI charts under the analysis) are untouched.
- Requires an iOS rebuild+install. **NOTE (env):** the dev Mac's Data volume hit 100% full mid-session (blocked builds) — cleared DerivedData/SwiftPM cache to recover; `~/Library/Developer/CoreSimulator` (~26GB) is the next freeable chunk if it recurs.

### 2026-07-02 — Conviction Envelope symmetry: auto-FLAT the mature-aligned chase (commit 5581423)

User-spotted contradiction: the envelope hard-blocked MIXED biases ("no trade — wait for alignment") but only *warned* on the opposite bad state, an aligned trend that had already run (CHASE HIGH). So it green-lit the late chase while forbidding mixed. `ml-training/trend_direction_test.py` measured that a **mature aligned trend (30-80 bars since regime change) has ~0% forward 24h EV** — the move already happened; hit rate ~47-49% at every trend age (direction stays a coin flip); the only cell with any edge is the **young/just-confirmed** window (3-10 bars, +0.245% gross ≈ break-even after costs). Fix (`prompt.ts`): hoisted `envChaseLevel` and added `chase_into_extended_aligned_trend` to the auto-FLAT list when `envChaseLevel === 'HIGH'` and biases are aligned (not MIXED/UNKNOWN). The envelope now blocks BOTH incoherent (mixed) and spent (mature-chase) states. **Deliberately MORE selective** (more FLATs) — the honest direction. **Also validated this session (all in `ml-training/`, negative/thin results — see the graveyard):** trend-following is ~coin-flip hit-rate with thin positive-skew EV that doesn't beat fees (`trend_direction_test.py`); bear+high-vol direction is STILL a coin flip, worse under strong ADX (49.4%); the annual-return projection for a $25k Binance bot is ~+5-15% in a good year with a ~40% chance of a red year, gated on the thin +0.03R edge surviving live; win rate is low purely because of the 5R:1R target geometry (a 1R:1R target gives ~49% = the coin flip); 72h hold is near-optimal via capital-turnover (net EV/trade ~flat across horizons).

### 2026-07-02 — Strategy direction: fee break-even (#2) + volatility-pricing / long-gamma read (#1)

The user's goal is "enter good trades." Honest framing (see the reasoning in this session): direction is a coin flip (proven, leak-retracted), so the app's ONLY surviving edge is **volatility** (ML_WIN + tail head = when a move is coming, direction-agnostic), and it's been expressed with the WRONG instrument (directional futures + stop, killed by fees + coin-flip direction). Two shipped:

- **#2 Fee break-even model** (`ml-training/strategy_breakeven.py`, commit bd57c19): one WF pass → the full cost-sensitivity curve (per-trade cost is linear in round-trip %). On 20,053 tail-gated convex trades (1R stop / 5R target / 72h): **GROSS EV +0.151 R/trade, break-even round-trip = 0.238%** (mean cost multiplier 0.635 R per 1% round-trip; 5R win rate 11.8%). Coinbase Intro-1 (~0.25%) = −0.008R (just underwater); any venue under ~0.20% round-trip is solidly +EV. **Actionable: the edge is real but thin and fee-gated — a lower-fee venue (e.g. Hyperliquid ~0.035% taker) flips it from break-even to +0.04–0.06 R/trade; verify current fee schedules. Also: 11.8% win rate = ~88% of trades lose 1R, so it only works traded MECHANICALLY/completely (argues for automation, not discretionary entry).**
- **#1 Volatility pricing — BUILT then the edge was REJECTED (commit e8d78fa built it, e9c3709 reframed it).** Added `fetchImpliedVol` (Deribit DVOL, public 30d IV) + a forecast-vs-implied "buy the straddle when vol is cheap" read. Then **validated it and it FAILED** (`ml-training/options_straddle_test.py`, 4yr BTC/ETH): the vol-risk-premium is positive (implied − realized30d = +7.5 BTC / +3.7 ETH vol pts) so buying vol is structurally −EV even at ZERO friction (−0.1 to −1.4%/trade), and the "cheap vol" gate makes it WORSE (mildly backwards — HAR-RV forecast spikes right after realized vol spikes, as vol mean-reverts). **The long-gamma path is a dead end; the only +EV vol trade is SELLING premium, which is tail-risk-heavy / not retail-safe.** The prompt line was reframed to `Options-Implied Vol (context)` — a DVOL regime read with an explicit "NOT a trade signal, buying vol is −EV" caveat. **KEY LESSON added to the graveyard: validate before trading — this cost an afternoon, not capital.**
  - **Net strategy conclusion after #1+#2:** both retail vol-monetization paths are now closed — directional futures (coin-flip direction + thin post-fee edge) and long options (negative vol-risk-premium). The ONE validated +EV edge remaining is the **tail-gated convex perps strategy** (+0.15R gross, +~0.03R at Binance ~0.10% fees), which is thin and demands MECHANICAL/automated execution (11.8% win rate). Binance access unlocks the low fees to make it +EV; the open build is a mechanical signal export/automation (option (b)).

### 2026-07-02 — "Constant auto-FLAT" fix: ML calibration drift + low-ML-in-trend reframe (commit 3bfaace)

User: "no trade / auto-FLAT for two days while BTC ran 5%." Diagnosed from live `/ml-calibration` (4290 graded samples): the static isotonic ML calibration has **drifted and compressed** — predicted 30-50% bucket realizes **65%**, the whole curve sits flat ~62-67% instead of spanning 30→80% (top bucket 70-85 realizes only 67%). So the `ML_WIN < 50 → auto_FLAT` gate was firing on bars with genuinely ~65% move odds. Two fixes (worker-only, commit 3bfaace):
1. **Recalibrated the GATE, not just the display:** `runFullAnalysisCore` computes `calibratedMlWin = 0.35·raw + 0.65·(live bucket realized rate)` when n≥100; the Conviction Envelope auto-FLAT keys on that. Symmetric (also lowers the over-confident top bucket) → a re-calibration, not a loosening. Raw ML_WIN still shown + the audited-calibration line.
2. **Reframed the honest low-ML-in-trend case:** ML_WIN gauges a SHARP ≥1.5-ATR/24h move, so a slow trend grind is a low-ML state *by design*. When the ONLY auto-FLAT reason is ML and Environment Risk is ELEVATED/HIGH, the prompt emits a `FRAMING:` line ("no volatility-edge entry, NOT nothing happening — trend intact, riding it is your call, this tool doesn't gate that") and the system prompt honors it instead of a bare "stand aside." BTC at raw 26% (bucket realizes 36%) still flats — correctly, a slow +5%/2d isn't a vol event — but the systematic over-FLAT across the huge 30-50 bucket is fixed and the message is honest. **KEY LESSON: ML_WIN measures volatility events, not trend participation; the static calibration drifts and the live `ml_calibration` curve is the truth — consider periodic model retrains when the live curve flattens.**

### 2026-07-01 — 4-agent code review: CRITICAL notification bug found + batch-1 fixes (commit 787dc40)

A full 4-agent review (worker core / analysis brain / iOS services / iOS views) surfaced ~35 verified issues. Batch 1 shipped:

- **CRITICAL — every ML-crossing push since the TrueNAS cutover was silently lost.** The `notif_claims` atomic claim (`index.ts` `processDeviceNotifications`) used `?N` numbered placeholders; better-sqlite3 (the box's D1 adapter) rejects them with "Too many parameter values were provided" — reproduced empirically. The throw fired only on ticks where `crossed` was true (one tick per crossing), aborting the device pass exactly when a push should have sent, and the outer catch hid it. Fixed with positional `?`; claim semantics re-verified. **Lesson recorded in `server/d1-adapter.ts` header: positional `?` only, never `?N`.**
- **HIGH — outcome feedback loop was dead: three model-version registries disagreed.** Worker queried `model_version = 11/13`; iOS stamped 10/12; the shipped model JSONs both say `version: 12` (NOTE: the stock JSON is v12, not v13 as this doc's ML section claims — doc drift). The query matched nothing → `outcomeHistory` always []. Worker now queries `IN(10,11,12)` crypto / `IN(12,13)` stock; iOS `currentModelVersion` returns 12/12. Keep all three in sync on retrains.
- **HIGH — fire-and-forget fixes:** iOS pendingJob staleness 180s→3600s (matches box KV TTL; the 3-min prune made push-tap recovery re-run the analysis = double LLM spend) + one final poll after the wall-clock deadline (the deadline also elapses while the app is suspended — resume-after-long-lock is the normal path, not an edge case).
- **HIGH — `aiLoadingPhase`/`isLoading` reset unconditionally** on completion (were gated on `symbol == currentSymbol`; switching favorites mid-analysis bricked the AI buttons until relaunch).
- **MED — failed analyses are no longer recorded as real analyses** (were saved to history, registered FLAT outcomes, and wiped the previous setup's alerts). **MED — SINCE LAST ANALYSIS baseline advances only on `llm.ok`** (failed/dry runs re-baselined it; null ML no longer erases the baseline). **MED — reentrancy guard on `runFullAnalysis`** (recovery Task + user tap could double-start → 2× LLM spend + duplicate tracked setups, since `parseSetups` mints fresh UUIDs per decode).

**Batch 2 (honesty) SHIPPED 2026-07-02, commit 0cdcc69:** `/direction-accuracy` serves `backtestBaseline: null + retracted: true` (iOS section relabeled "RETIRED (historical)"); candle patterns are trend-aware (shape picks the family, 5-bar preceding trend picks the name — Hammer vs Hanging Man / stars now gated; 2 regression tests; ML features in scoring-full.ts untouched, parity unaffected); pattern significance direction-aware (bearish-at-support tagged `[counter-context]`, not promoted); Environment-Risk wording computed from ATR percentile ("deeply extended but COILED" when <40th pct — level unchanged) + stretch-only ELEVATED requires non-RANGING; Parabolic Risk revived (fresh 1H close vs PRIOR daily close — was identically 0); "(forming)" label removed; `score_history.bias` writes real biasAlignment not an ML_WIN-fabricated direction.

**Review cleanup SHIPPED 2026-07-02, commits 1bac72c (worker) + 41c4628 (iOS):** the medium-severity backlog, cleared.
- **Worker:** CVD trend sign-aware (mis-signed for negative CVD); whale-trap funding-stretched 0.01→0.03; dark-pool Z appends ≤1×/day (was ~6× → 3.3d window); heartbeat stamped on empty-watchlist early return; failed (all-zero) derivatives fetches never cached/archived (was ML-poisoning + training-poisoning); callLLM logs error bodies + effort-family max_tokens 32k→16k (undici 300s timeout); async job ownership check + stuck-pending→error; ML-UNAVAILABLE line on cache miss (was silent); stock ATR-based Expected Range fallback; trendDominates aligned to ELEVATED gate; big-move thresholds from tailRiskInfo; positional-timeframe guard.
- **Worker stock-enrichment revival:** `fetchStockEnrichment` now populates relativeStrength1d + sectorETF + outperformingSector (Yahoo) and insiderTransactions + newsHeadlines (Finnhub) — reactivating the backtest-validated LONG_CONFIRMATION gate (was permanently "n/a") + Sector Strength / News-Thesis / Insider Cluster prompt sections.
- **iOS:** deleted the legacy inline contracts sizing block (3-way conflict); register account/risk/leverage UserDefaults defaults at launch (fresh installs sent NO sizing to the LLM); tf2 label 4H→`tf2.label` (stocks are 1H) in LevelsChart + SanityCheck; WatchLevels setup-level cap exemption + stable id; LevelsChart candle-scaled y + hoisted bounds + label de-confliction; SanityCheck chase 0.3% tolerance; PositionSizer thousands separators; calculator local scratch state + "Save as my default"; TradeSetupChartView empty-candle guard; fire-and-forget recovery scans ALL pending jobs + didReceive push-tap handler + `AnalysisService.shared`; error banner not cleared by background refreshes.
- **Explicitly DEFERRED (low-severity, reasoned):** `syncResolvedOutcomes` double-POST guard (needs an ioQueue in-flight flag; D1 side is idempotent-ish via id) and `restoreFromServer` timestamp threading (F-4 nudge over-counts right after a reinstall only) — both low blast-radius; PositionSizer `contractSize` rounding (broker granularity — nice-to-have); the review's insight projects (Your Leaks rollup, expected-range band on LevelsChart, portfolio correlation vs activeSetups, tappable-levels→alerts, big-move UI chip) remain as future work.

**Insights batch 1 SHIPPED 2026-07-02, commit c58b0f7 (worker-only):** the prompt now carries (a) **ML Calibration (live, audited)** — realized goodR rate for the current prediction's bucket from `ml_calibration` D1 (90d, universe-wide, n≥20 gate); (b) **stop noise-hit per CANDIDATE SETUP** — `risk-engine.stopQuality()` (reflection-principle P(noise wicks the stop in 24h) at the HAR-RV σ) finally wired to the analysis path, "~34% (TIGHT — widen or skip)"; (c) **ML_WIN 24h trajectory** from `score_history` ("31→44→62% (RISING — vol regime building)"); (d) **BTC CONTEXT on every alt analysis** from the already-fetched `ml_preds:all` blob (ML_WIN / Big-Move bucket / persistence — "alt beta amplifies any BTC move"). All best-effort; each line self-describes its interpretation to the LLM.

**Batch 3 (security) SHIPPED 2026-07-02, commit fbde1a3:** `/debug/*`, `/twelvedata/*`, `/finnhub/*` now behind the auth gate (the endpoint table above is correct again); Content-Length REQUIRED on POST/PUT (411) closing the chunked-encoding RAM-exhaustion bypass, `/history` hard-capped at 10MB; backfill `days` clamped [1,400].

**Review backlog (not yet fixed, ranked):** (mediums) stock enrichment subset leaves LONG_CONFIRMATION permanently "n/a" on the live path; CVD trend mis-signs for negative CVD; whale-trap funding threshold fires at baseline funding; dark-pool Z window is ~3.3d not 20d (dup daily samples); dead-man's-switch false-alarms on empty watchlist; failed derivatives fetches cached+archived as zeros; Sonnet 5 32k non-streaming may hit undici's 300s header timeout (should stream); cold-launch/switched-symbol job recovery + `didReceive` push-tap handler missing; three conflicting position-size numbers on one screen (legacy inline block vs PositionSizeCard vs server); stocks' tf2 (1H) mislabeled 4H in LevelsChartView/SanityCheck; LevelsChartView label overlap + TP2 eviction by the 8-level cap. **Top insight opportunities (all from existing data):** live ML calibration into prompt+UI; `risk-engine.noiseHitProb` per candidate setup ("stop noise-hit ~34%"); derivatives-history percentiles (funding percentile vs 90d); ML_WIN trajectory from `score_history`; BTC-regime context for alts; expected-range × levels + band track record; "Your Leaks" rollup + honest realized-R expectancy; portfolio correlation vs activeSetups; iOS big-move chip + expected-range band on LevelsChartView + tappable levels→alerts.

### 2026-07-01 — Claude Sonnet 5 + fire-and-forget analysis + position-size calculator

Three changes shipped together.

**Claude Sonnet 5 (new default).** Sonnet 5 removed the manual extended-thinking API: `thinking:{type:enabled,budget_tokens}` AND non-default `temperature`/`top_p`/`top_k` both return **400**. It uses **adaptive thinking** (on by default) with depth set by the `effort` param (`output_config.effort`, default `high`; `low`/`medium`/`high`/`xhigh`/`max`). Opus 4.7/4.8 made the same change — so the pre-existing "Opus 4.7 + Extended Thinking" picker option was already silently 400ing on the live API. Fix in `callLLM` (`marketscope-worker/src/index.ts`): split the Claude branch into an `EFFORT_MODELS` family (`claude-sonnet-5`, `claude-opus-4-7`, `claude-opus-4-8`) → `thinking:{type:adaptive}` + `output_config:{effort:high}`, NO temperature, `max_tokens` 32k (hard cap on thinking+text; Sonnet 5's tokenizer runs ~30% hotter) — vs the legacy `budget_tokens`+temperature path for Sonnet 4.6 / Opus 4.6 / Haiku 4.5. `thinkingBudget` from the client is now just an ON/OFF signal on the effort family. iOS: Sonnet 5 is the recommended default (`Constants.defaultModel` + top of `AIProvider.models`); the `@thinking-N` suffix still carries on/off, honored as a literal budget only on the legacy path. **Effort stays at `high`** (deliberately not `xhigh`): the analysis is a bounded single-shot synthesis, not a long agentic loop, and `xhigh` would add latency — worsening the very screen-lock timeout #1 below fixes — for marginal gain. Live-verified: a real `/full-analysis` returned `model: claude-sonnet-5`, 200 not 400. **Kept for reference:** Sonnet 5 is GA to all customers, same $3/$15 pricing (intro $2/$10 through 2026-08-31).

**#1 Fire-and-forget analysis (permanent screen-lock fix).** The recurring "AI analysis fails when the screen turns off mid-call" bug is now fixed at the architecture level. `/full-analysis`'s pipeline was extracted into `runFullAnalysisCore()` (sync endpoint unchanged, 420/420 tests green); two new endpoints: **`POST /full-analysis/async`** mints a `jobId`, runs the ~30-90s pipeline **detached on the box's Node event loop** (persists past the HTTP response — no `ctx.waitUntil` needed since the box is a long-lived process, not a Worker isolate), returns `{jobId}` instantly, caches the result in KV on completion, and 5s later fires an APNs "ready" push UNLESS the job was already `claimed` by a foreground poll (suppresses the redundant banner; push body = the Bottom Line). **`GET /full-analysis/result?jobId=`** polls `{status, result?}` and flips `claimed`. iOS `WorkerFullAnalysisService.analyze` now starts/RESUMES a job and polls every 3s (jobId persisted per symbol <3 min → a force-kill resumes the same job, no second LLM spend); `CryptoLensApp` scenePhase `.active` triggers recovery (also where a tapped push lands). The box finishes regardless of the phone, so a screen-lock can't kill it — the poll resumes on foreground with the result waiting. **Live smoke-test of the async endpoints is pending the box redeploy.**

**#2 Position-size calculator (iOS).** Correct sizing was buried in prompt text; now it's a first-class card on every setup. `PositionSizer` (`Utils/PositionSizer.swift`) computes the exact risk-based quantity **client-side** from the setup's entry/stop + account/risk settings (never the LLM's loose JSON qty): `qty = (account × risk%) / |entry-stop|`. `PositionSizeCard` shows quantity, dollars-at-risk, notional, and implied leverage with an over-cap warning; "Adjust" opens `PositionSizeCalculatorView` for a live recompute on a different fill. New `max_leverage` setting (default 3×) in Settings → Risk Management. iOS build green (xcodegen regenerated for 3 new files).

Commits: Sonnet 5 `6d713b8`, worker async `2b0a63f`, iOS `11b68f2`. **Both require the iOS rebuild + a box redeploy (Stop/Start) to take effect.** Next candidates from the same product pass (not started): "Your Leaks" behavioral rollup, inline model track-record, portfolio/correlation risk view.

### 2026-06-29 — Analysis prompt retune: collapse skeleton, mode switch, prior-analysis delta

**Fixes the "every analysis feels the same / too long" complaint at the structural level.** Root cause was the OUTPUT FORMAT, not the content: it mandated **8 `##` sections**, three of which (Environment Risk / Move Likelihood / Regime) answered the same "how dangerous/active is the tape" question, and "use `##` headers exactly" fought "LENGTH MATCHES SUBSTANCE" — so the model emitted all 8 every time. Six changes to `marketscope-worker/src/prompt-system.json` (both crypto + stock) + plumbing in `src/prompt.ts` / `src/index.ts`:

- **#1 Merged the three tape sections into one `## The Tape`** + added an explicit **SHORT vs FULL mode switch** with a concrete checkable trigger (auto-FLAT AND Env Risk MODERATE/LOW AND no HIGH/ELEVATED flag AND no IN_PLAY level AND ML_WIN < FAVORABLE AND no event AND nothing changed → SHORT = Bottom Line + What to Watch only). A binary mode beats "be as short as the tape is boring."
- **#2 Bottom Line: hard ≤35-word plain-English cap** (was "two sentences", which let the model cram 5 hazards into two 40-word sentences).
- **#3 Dropped the standalone `## Direction` section** (boilerplate with one word swapped) — the one-word lean now folds into the Bottom Line.
- **#4 De-duplicated the "ML_WIN is ATR-normalized, low ≠ safe" lecture** (~5× → once); restating it trained the model to re-derive the caveat in every output, itself a source of same-y boilerplate.
- **#5 Added two end-to-end worked examples** (quiet SHORT-mode + eventful FULL-mode) to each market, prefaced illustrative-only (don't reuse the numbers). FULL-mode word cap tightened 400→300.
- **#6 SINCE LAST ANALYSIS delta (the structural cure for serial sameness):** `PromptState` now carries `prevMlWin` / `prevBottomLine` / `prevAnalysisMs`. `buildUserPrompt` emits a `=== SINCE LAST ANALYSIS ===` block (age, ML then→now with pp delta, prior Bottom Line) when prior state is present and <3 days old, and re-stamps `newState` with this run's ML + timestamp. `/full-analysis` extracts the fresh Bottom Line from the LLM output post-call (regex on the `## Bottom Line` section, capped 320 chars) and persists it to KV `prompt:<symbol>` so the **next** run leads with what moved. The system prompt instructs the LLM to lead the Bottom Line with the change when material (ML ≥15pp / regime flip / flag fired-cleared / level newly IN_PLAY), else "largely unchanged" + stay short.

`prompt-system.json` was regenerated via a one-off build script (authoring the text as JS template literals + `JSON.stringify`, far safer than hand-escaping the `\n` in the single-line JSON values). **420/420 worker tests green** (added a #6 test; updated the systemPrompt-structure assertions for the merged section + dropped Direction header). Server bundle builds clean. Committed `5e3b41c`, pushed → GHCR Action built `ghcr.io/ludikure/marketscope:latest` (28s). **Live after a TrueNAS Update (pull_policy: always).** No iOS rebuild needed (display-only consumer of the worker analysis).

### 2026-06-27 — ⚠️ NO CLOUDFLARE WORKERS: the backend runs on the TrueNAS box. NEVER `wrangler deploy`.

**The live backend is the self-hosted TrueNAS box at `marketscope.ludikure.org`** (the same `src/index.ts` worker code running on Node via the `server/` adapters — KV→SQLite, D1→better-sqlite3, R2→filesystem, cron→node-cron; commit `21bc0e7`). Its KV is a local SQLite table with **no put limits**. Cloudflare is NOT in the data path.

**Incident (root cause of the 2026-06-27 Cloudflare KV "put limit exceeded" email):** to ship worker prompt changes (F-1/F-2) I ran `npm run deploy` (= `wrangler deploy`), which redeployed the **full Cloudflare Worker** from the old `wrangler.toml` — **resurrecting the Cloudflare cron (`*/5`) + KV bindings** that the June 13 cutover had intentionally retired. The CF cron then wrote ~10 KV blobs every 5 min → blew the 1,000/day free-tier limit, and CF started serving app traffic directly (bypassing the box, double crons). **Fix:** redeployed the passthrough (`npx wrangler deploy -c wrangler.passthrough.toml`) → CF cron/KV stopped; deleted `wrangler.toml`; neutralized `npm run deploy` (now errors out).

**Architecture now:**
- **iOS** (`PushService.workerURL`) points **directly at the box** `https://marketscope.ludikure.org` — no Cloudflare Worker in the path. (Requires a rebuild+install to take effect on-device.)
- **Shipping worker changes** = rebuild the TrueNAS container: `cd marketscope-worker && npm run build:server` → `node dist/server.mjs` (`docker compose up -d --build` on the box). **Never `wrangler deploy`** — `npm run deploy` is now a guard that errors with this reminder. `wrangler.toml` (the full-worker cron+KV+D1+R2 config) is deleted so it can't be redeployed.
- **ZERO Cloudflare Workers (as of 2026-06-28).** The transitional passthrough Worker was deleted (`wrangler delete`) once the iOS app was rebuilt on the box URL; `passthrough.ts` + `wrangler.passthrough.toml` were removed from the repo. `…workers.dev` now 404s. The box (`marketscope.ludikure.org`, via the cloudflared tunnel) is the sole backend. NOTE: the frozen Cloudflare **D1 / KV / R2 resources still exist** (passive, free, no writes) — the Node-CLI training scripts (`scripts/fetchers/*`) still read the CF **D1 archive** via `wrangler d1 execute --remote`, so don't delete the D1 database without migrating that data first.

**Remaining Cloudflare touchpoints (not yet removed — flagged for a decision):** (a) the **AI Gateway** indirection (`AI_GATEWAY_BASE` / `aiGatewayURL()` in `index.ts`) — inert on the box (env unset → direct LLM call), safe to delete on request; (b) the **`web/` app** is deployed to **Cloudflare Pages** (a separate client — keep or move); (c) **ingress**: how `marketscope.ludikure.org` is exposed (likely a cloudflared tunnel — free, no KV limit, ingress-only) vs. a direct DNS/TLS setup.

### 2026-06-27 — Persona features F-3 (pre-trade sanity check) + F-6 (5-second decision cards)

Two more iOS-side persona features, both pure-iOS off the already-loaded analysis (no worker call):
- **F-3 pre-trade sanity check** (`Views/SanityCheckCard.swift` + `SanityCheck` logic struct): a 3-question gut check rendered above the analysis in `ContentView` whenever `result.tradeSetups` is non-empty. Derived from the loaded `AnalysisResult`: (1) pullback vs chasing (`entry` in the breakout direction vs `daily.price`), (2) stop inside/outside the noise zone (`setup.risk` vs 4H ATR; <1× = tight/likely-wicked), (3) high-impact event within 6h (`economicEvents` filtered by `isUpcoming && isHighImpact`). Color-coded; forces a 5-second pause at the impulsive moment.
- **F-6 5-second decision cards** (`Views/WatchlistView.swift`, `decisionVerdict(for:)`): each watchlist card now leads with an at-a-glance verdict + one-line reason — CONDITIONS PRESENT (a viable setup exists → direction + ML%), STAND ASIDE (AI ran, no setup → no edge), or WATCH (indicators only, not yet analyzed → bias + ML, tap to analyze). Plain-language read without opening the chart.

iOS build green. **Requires an iOS rebuild+install.** This completes the persona feature set F-1…F-6 (F-1 chase guard + F-2 whale-trap are live on the worker; F-3/F-4/F-5/F-6 are iOS).

### 2026-06-27 — Persona features F-4 (overtrading guard) + F-5 (post-trade debrief)

Two iOS-side persona-protection features in the Outcome dashboard, both pure-iOS off existing tracked-setup data (no worker / schema change):
- **F-4 overtrading / cooling-off guard** (`OutcomeTracker.overtradingNudge()` / `setupsConsideredToday()`): counts setups surfaced today (local day) vs the `daily_trade_cadence` UserDefault (default 2, Stepper in Settings → Risk Management). When exceeded, `OutcomeDashboardView` shows a gentle "you've had N setups today — stepping back is usually +EV" banner. Counters the dopamine loop without hard-blocking.
- **F-5 post-trade debrief** (`OutcomeTracker.debrief(for:)`): plain-language autopsy for each RESOLVED tracked trade — outcome (WIN/LOSS/BE), the realized excursion in R, the entry context honestly reconstructed from what was recorded (chase entry = `entry` vs `priceAtSetup` in the trade direction; ML quality; archetype), and a lesson from that archetype's own track record (`archetypeRecord`, e.g. "your counter-trend trades are 2–7 — demand stronger confirmation"). Rendered under each row in the dashboard's Recent Setups. Turns the tracker into a teacher.

iOS build green. **Requires an iOS rebuild+install.** Remaining persona features: F-3 (pre-trade sanity check) and F-6 (5-second decision cards) — both benefit from a worker-emitted structured risk-flags block (not yet built).

### 2026-06-27 — Analysis reliability (background URLSession) + F-2 whale-trap guard

**Analysis no longer fails when the screen auto-locks mid-call.** The `/full-analysis` LLM call (Claude + extended thinking, ~30-90s) runs on `URLSession.shared`, which iOS suspends within seconds of the app backgrounding — so a screen auto-lock failed the analysis. Fix:
- **Keep-alive** (`AnalysisService.runFullAnalysis`): disables the idle timer (no auto-lock) + holds a finite-length `beginBackgroundTask` assertion for the whole run. Ref-counted, UIKit-gated. This is the working fix for the auto-lock case.
- **Transient retry** (`WorkerFullAnalysisService.analyze`): one retry on a transient blip (HTTP 0 / connection lost / box hiccup) so a single network stumble during a long extended-thinking call doesn't sink the analysis.
- **Background URLSession — TRIED AND REVERTED (2026-06-27).** A `URLSessionConfiguration.background` upload-task approach (`BackgroundAnalysisService`) was built to survive full app suspension, but **upload-task responses are not delivered reliably on a background session** — it returned **HTTP 0 even with the screen ON** (the `didReceive response` delegate never fired, so status stayed 0). It was removed; the live path uses the foreground `WorkerFullAnalysisService.analyze`. Recoverable from git (commit `2fe92b7`) if revisited with on-device delegate logging. Net: the foreground + keep-alive path is the shipped solution; a manual screen-off for the full ~60s of a slow call can still time out (idle-timer only prevents *auto*-lock), which is an accepted limitation. **Requires an iOS rebuild+install.**

**F-2 whale-trap detector (live worker prompt, crypto-only).** New `WHALE TRAP: HIGH/ELEVATED` flag in `buildUserPrompt` (`src/prompt.ts`, end of the DERIVATIVES POSITIONING block) that NAMES the crowding trap in plain language: fires when retail is crowded one side (`globalLong/Short ≥ 60%` or `crowdingCode`) AND ≥2 tells stack up — top traders leaning the opposite way, funding stretched in the crowd's direction, CVD diverging against the crowd, OI building. Emits "N% of retail is LONG/SHORT here — going that way means joining the crowd most exposed to a flush" + names the cascade direction. `prompt-system.json` (crypto only) instructs the LLM to surface it prominently in the Risk Map as a RISK flag, never a direction call. 2 tests added; **419/419 worker tests green.** Companion to F-1 (chase/exhaustion). **Requires a worker deploy.**

### 2026-06-27 — Dead local-prompt path DELETED + F-1 chase/exhaustion guard (live worker prompt)

Acted on a (heavily-stale, e1fb510-era) external review after re-validating every claim against HEAD. Most of the review was already done or superseded (CR-2 div-by-zero already guarded; CR-5 time features already pinned to `etCalendar`; CR-8 redundant `resolved` clause already removed; the entire Phase-3 "risk platform" already built as `vol.ts`/`risk-engine.ts`/`risk-states.ts`/`StressTest.tsx`). Two genuinely-actionable items shipped:

**1. Completed Phase 4 step 3 — deleted the dead on-device prompt path (the real dedup payoff).** The live LLM path has been 100% server-side (`WorkerFullAnalysisService.analyze` → `/full-analysis` → `src/prompt.ts`) since the thin-client migration; the local `AnalysisPrompt.buildUserPrompt` + `systemPrompt` + `parseSetups` and the `ClaudeService`/`GeminiService`/`DeepSeekService` provider classes were unreachable. Deleted all three service files, the `AIProvider` protocol (kept the `AIProviderType` enum — still drives the Settings picker + worker provider routing), the unread `AnalysisService.aiProvider` property + its `configure()` switch, and gutted `AnalysisPrompt.swift` from **2,707 → ~64 lines** (only `classifyArchetype` survives — still used at setup-registration for OutcomeTracker archetype slicing). This also permanently removes the **leaked-94%-directional-claim** text (CR-1) that lived inside the dead `buildUserPrompt` — the live worker prompt was already clean (`prompt.ts:589` retraction). Consequence: `scripts/extract_system_prompt.py` is now **defunct** (its Swift source is gone) and `marketscope-worker/src/prompt-system.json` is the **canonical** system-prompt source, hand-maintained going forward (comment updated at `prompt.ts` top). iOS build green; no on-device fallback by design (cron dead-man's-switch covers worker uptime).

**2. F-1 "buying-the-top / shorting-the-bottom" exhaustion guard (worker prompt, live path).** New direction-AGNOSTIC `CHASE / EXHAUSTION RISK: HIGH/ELEVATED` flag in `buildUserPrompt` (`src/prompt.ts`, Phase C7b, right after the Exhaustion/Continuation tally). Synthesizes signals already gathered — extension from the 200D mean (`stretch ≥ 2 ATR`), stretched RSI/Stoch, running into a level in the chase direction (resistance/VAH for longs, support/VAL for shorts within 0.6×ATR), and the existing exhaustion tally (crowded same-side, CVD divergence, rejection wick, RSI divergence). HIGH requires a CORE chase ingredient (extended OR ≥2 exhaustion signals) plus confirmation (score ≥3) so two oscillators alone can't trip it. Emits a loud plain-language directive; `prompt-system.json` (crypto + stock) instructs the LLM to lead the Risk Map with it and, if a setup is still permitted, label it a CHASE and steer toward a pullback. Aimed squarely at the target persona's #1 loss (entering after a move has already run). 2 unit tests added (HIGH-fire + quiet-tape); **417/417 worker tests green**. **Requires a worker deploy to take effect on the live box.**


### 2026-06-13 — iOS thin client: indicators + crypto candles moved to the Worker (kills the 451)

**The iOS app stopped computing indicators on-device and stopped fetching Binance directly.** Motivation: the fat client duplicated the Worker's analysis brain and, post-TrueNAS-migration, the phone's residential IP hits Binance's **HTTP 451 geoblock** (only the box, behind NordVPN/gluetun, can reach Binance) — the user asked to make iOS "as thin as possible, all calculations on the worker, ideally just a display."

**What changed (all behind a master switch, default ON):**
- **`thin_client_mode` UserDefault is the master switch** (default ON; Settings → "Compute → Server mode (thin client)" is the manual kill-switch). `AnalysisService.thinClient` reads it (`object(forKey:) as? Bool ?? true`). NB: a *fresh* key was used deliberately — the legacy `use_server_analysis` key carries a stale persisted `false` on devices that used the old "Server analysis (beta)" toggle, which silently kept thin mode OFF.
- **New `Services/WorkerIndicatorsService.swift`** — `GET /indicators?symbol=` → tolerant DTO → `IndicatorResult` ×3 (daily/4H/1H) + livePrice. Bridges the worker JSON↔Swift shape gaps (`macd{histogram,crossover}`→macd/signal from series; bare `vwap`→`VWAPResult`; `atr` gets computed `suggestedSL*`; `volumeProfile{poc,vah,val}`→`valueAreaHigh/Low`; `obv/adLine` get `current:0`). Nested types whose keys already match (stochRSI/adx/fibonacci/supportResistance/candlePatterns/marketStructure) decode straight into the iOS `Codable` structs. Built via `IndicatorResult`'s memberwise init. Live-verified vs the deployed `/indicators` payload (every field maps).
- **New `Services/WorkerCandlesService.swift`** — `GET /candles/crypto?interval=15m` for the OutcomeTracker wick-detection feed.
- **`AnalysisService` rewired** (`fetchAndCompute`, `quickFetch` early-return to the worker when thin; OutcomeTracker 15m feed via the box; all geoblocked Binance/spot calls — `fetchCandles`, `fetchPremiumIndex`, ETHBTC, `SpotPressureAnalyzer`, `DerivativesService` — guarded behind `!thinClient`; local crossAsset/SPY/weekly skipped since they only fed the now-server-side prompt).
- **Analysis was already 100% server-side** — `runFullAnalysis` already called `WorkerFullAnalysisService` unconditionally (line ~890); the old `use_server_analysis` "flag-gated OFF" comment was stale. So Phase B was a no-op beyond flipping the default + adding the UI toggle.
- `IndicatorEngine`/`MLScoring`/provider services stay **compiled** (BacktestEngine depends on them); only the *live* path stops calling them. Pure thin / SPOF accepted — no automatic local fallback; `/cron-health` + `CronHealthService` surface box outages.

**Build SUCCEEDED.** Verified headless: `/candles/crypto` + `/indicators` shapes decode. **Remaining on-device verification (user):** charts/sub-panels render from worker series, no `fapi.binance.com`/451 in console, analysis returns setups, OutcomeTracker advances. **Documented follow-ups:** ~~(a) derivatives display card is empty in thin mode~~ — RESOLVED by Phase E (see next entry); (b) Phase D — retire `AnalysisPrompt.buildUserPrompt` from the live path for the dedup payoff. Plan: `~/.claude/plans/valiant-brewing-lamport.md`.

### 2026-06-13 — Provider selection (Claude/Gemini/DeepSeek) on the server-side analysis path

**The Settings AI-provider picker was a no-op in thin mode** — `/full-analysis` hardcoded Anthropic Claude, so picking Gemini/DeepSeek only affected the dead local `/analyze` path. Fixed: extracted the multi-provider routing that already lived in `/analyze` into a shared `callLLM(env, {provider, model, system, prompt, thinkingBudget})` helper (`marketscope-worker/src/index.ts`) that routes Claude / Gemini / DeepSeek, allowlists the model per provider, and normalizes each response to plain text + the resolved model. `/full-analysis` now reads `body.provider` + `body.model` and calls it (Claude keeps extended-thinking default 8000; Gemini bumped to 8000 maxOutputTokens to avoid truncation). `/analyze` left unchanged (legacy local path).

- **iOS:** `AnalysisService.currentModelID` (set in `configure`, persisted to `ai_model` UserDefault + restored in `autoConfigureKey`); `WorkerFullAnalysisService.analyze(symbol:provider:modelID:)` splits the iOS `@thinking-N` model-id suffix into the clean worker model + a `thinkingBudget` (Claude only; a suffix-less Claude model sends `thinkingBudget:0` to disable, Gemini/DeepSeek ignore it). `runFullAnalysis` passes `providerType.rawValue` + `currentModelID`. SettingsView restores the persisted model in the picker. All iOS-offered models are worker-allowlisted (Claude sonnet-4-6/opus-4-6/opus-4-7/haiku-4-5; Gemini 2.5 pro/flash; DeepSeek reasoner/chat).
- Build green (iOS) + 415/415 worker tests. **Requires a worker deploy to take effect** on the live box.

### 2026-06-13 — Phase E: per-symbol display enrichment via the Worker `/market` (truly thin)

**Closes the last direct-provider fetches in thin mode + fixes the empty derivatives card.** In thin mode the per-symbol *display* enrichment for **crypto** now comes from ONE worker call (`GET /market?symbol=`) instead of on-device fetches: derivatives + positioning (were skipped — Binance fapi is 451 from the phone, so the card was empty), spot pressure (was guarded off — Binance spot), and CoinGecko sentiment + fear&greed (worked, but were direct provider calls). **Stock** fundamentals stay on the on-device Yahoo/Finnhub path (the worker `/market` `stockInfo` is a strict subset — no Finnhub analyst/insider/news — and Yahoo isn't geoblocked, so routing stocks through `/market` would *regress* the display). Macro stays on `/macro` (already worker-routed, shared cache). The LLM analysis was already fully enriched server-side inside `/full-analysis`; this is display-only.

- **New `Services/WorkerMarketService.swift`** — `GET /market?symbol=` → tolerant DTOs → `{sentiment, fearGreed, derivatives, positioning, spotPressure, macro}` optionals, best-effort (nil on failure → caller carries forward), one 401 self-heal. The worker shapes (`src/enrichment.ts`) are **subsets** of the iOS `Codable` models, so each DTO defaults the missing fields: `DerivativesData` 11/18 (mark/index/OI-base/fundingHistory/takerSell defaulted), `SqueezeRisk.description`→"", `FearGreedIndex.classification`←worker `label`, `CoinInfo` keeps only the 4 %-change fields, `SpotPressure` is 1:1. `CrowdingState`/`OITrend` decode from their string raw values.
- **`AnalysisService` thin crypto path rewired** — `refreshIndicators` fetches the bundle once per enrichment cycle (honors the `needsEnrichment` cadence; carries forward otherwise) and populates sentiment/fearGreed/derivData/positioning + sets `self.spotPressure`; `runFullAnalysis` does the same once per run (positioning gets recomputed locally via `PositioningAnalyzer` off the bundle's derivData, restoring the squeeze `description`). Non-thin path unchanged.
- **Build SUCCEEDED**, no warnings. **On-device verification pending (user):** crypto derivatives + positioning + spot-pressure + fear&greed cards populate in thin mode; device logs show `/market` per crypto symbol and no CoinGecko/Binance-fapi lines.

### 2026-06-05 — Calibration floor fix (no more dishonest 0%) + 72H leak-clean retrain

**Calibration floor.** BTC (and every crashed major) served `ML_WIN = 0%` literally — the isotonic calibration's lowest breakpoints were `y=0.0` (overfit on a tiny low-prediction bin), and `calibrate()` clamps anything below `x[0]` to `y[0]`. A 0% calibrated prob claims a ≥1.5 ATR move is *impossible*, which is never true; in the all-crashed regime every major's raw score dipped into that bucket → all pinned at 0. Fixed by flooring the calibration `y` at the **bottom-bucket realized rate** (Wilson LB on a clean holdout): **main model crypto 0.12 / stock 0.18; h72 crypto 0.06 / stock 0.14** — all 4 main JSONs (worker + iOS) + the 2 worker-only h72 JSONs. The 0.85 cap already existed; this adds the missing floor. Isotonic monotonicity preserved (only the lowest breakpoints lifted). The repositioning meant the 0% never actually misled output (Environment Risk HIGH was the headline, ML_WIN demoted) — this just makes the secondary number honest. `calibration.floor` recorded in each JSON.

**72H retrain.** The persistence model (`P(fwdMaxFavR72H ≥ 2.5 ATR)`) was trained on leak-era CSVs. Retrained crypto on `csv_exports_v11_fixed` via `calibrate_horizon.py --horizon 72 --threshold 2.5 --suffix h72t25`. Leak impact (direction-AGNOSTIC magnitude target → leak-light, as predicted): **~8pp mean per-prediction** on a clean holdout (corr 0.87); the old leaked-era model under-predicted (mean 0.513 vs true 55.3% base → new 0.557). **Stock h72 reproduced identically** — stocks were leak-*spared* (overnight gaps), `csv_exports_v13` unchanged + deterministic recipe → same model; only the floor is new for stocks. Parity fixtures' `mlPersistenceProbability` refreshed via `scripts/update-fixture-ml.ts` (BTC 0.53→0.66, ETH 0.59→0.78; TSLA unchanged — same signature). 380/380 green. Deployed a3182bd9.

### 2026-06-04 — Risk repositioning: Environment Risk headline + big-move/tail head (ML_WIN demoted)

**Triggered by a real failure the user caught: ML_WIN read 25–40% across 2026-05-31→06-03 while BTC fell $73k→$64k in 4.2–5.6 ATR moves (every `ml_calibration` bar resolved goodR=1).** Pulled the live D1 series to confirm, then investigated whether a better model is achievable before building.

**Finding (ml-training/retrain_diagnostic.py + predictability_test.py, 141K clean OOS bars):** ML_WIN is NOT broken — it is well-calibrated even in the high-ADX/high-ATR tail (top ADX decile: actual goodR 42.8% vs predicted 43.6%). goodR genuinely *falls* in strong trends because it is **ATR-normalized** (a ≥1.5-ATR move on top of already-high vol is genuinely less likely, ~42% vs ~62% calm). So a low ML_WIN in a violent trend is *correct but misleading* as a risk signal. A monotonic-constraint retrain is **rejected** (would force goodR up with ADX — backwards). The BTC streak was a true ~40% bar resolving 1 in an autocorrelated window. BUT the huge moves are *partially* predictable: a head aimed at ≥4 ATR moves holds AUC ~0.67 (vs the ≥1.5 model's 0.63 at that target), +4–5pp catch — real but modest (rare events; top decile ~2× base).

**Shipped (deployed worker d9a9210e):**
- **Environment Risk flag** (`prompt.ts buildUserPrompt`): HIGH/ELEVATED/MODERATE/LOW from regime + ADX(daily,4H) + price-stretch-from-200D-in-ATR — a *non-ATR-normalized* trend-danger read. Now the **output headline** (`prompt-system.json`, both markets); ML_WIN demoted to "Move Likelihood (secondary)" with an `ML_WIN Context` line (ATR-normalized, correctly-but-misleadingly low in trends; never "safe").
- **Big-move/tail head** (`ml-training/train_tail_head.py`): LightGBM d4 t150, target `P(fwdMaxFavR>=4 ATR in 24h)`, clean `csv_exports_v11_fixed`, WF-OOF isotonic (cap 0.60), OOF AUC 0.646, monotonic calibration (20%+ bucket → 23.7% realized, 3.7× base). Embedded as `heads.tail` in the **clean** `ml-model-crypto.json` (worker + iOS) — separate from the leak-era heads file. `mlPredictTail()` + `tailRiskBucket()` in `ml-predict.ts` (1e-6 Python parity, all-zero ref 0.1654135338). Crypto-only (stocks → null). Cron writes `bigMoveProb` into `ml_preds:all`; `/ml-predict` + `/full-analysis` (`ml.bigMove`) serve it; folds into Environment Risk (a HIGH tail bucket escalates the headline — the "ML_WIN calm but outsized move brewing" case). Verified live: all 76 crypto symbols populated. **iOS/web "Big-move risk" UI label is the remaining step.** 379/379 worker tests green.

### 2026-06-02 — 🚨 DATA LEAK FOUND: crypto direction model DROPPED, honest ML_WIN retrained + deployed

**The single most important correction in the project's history. The crypto direction edge (the "~94.7% at pUp≥0.70" claim, the `pUp` head, the entire 2026-05-30 dual-gate direction architecture) was an ARTIFACT OF A DATA LEAK. It is gone.**

**The leak:** `marketscope-worker/scripts/runBacktest.ts` sliced the daily timeframe with `sliceUpTo(dailyAll, evalTime)`, which **included the in-progress (current-day) daily candle** at intraday 4H bars. So daily features (`dRsi`, `dRsiDelta`, `dStochCross`, `dBBPercentB`, …) saw the *rest of the current day* — overlapping the 24h forward label. Live serving drops the in-progress daily via `dropInProgress`; the backtest never did. **Crypto-fatal** (continuous 24/7 price → the leaked daily close ≈ the forward price the label measures), **stock-spared** (overnight gaps decorrelate the leaked close from the next session) — which is *exactly* why "direction worked for crypto but not stocks." That asymmetry was the tell. Fix: `sliceUpTo(dailyAll, evalTime - 86_400_000)` (drop the in-progress day). Leak verified closed: top feature↔forward-label correlation collapsed from 0.33 → ~0.00 after the fix; a 77-symbol clean regen (`csv_exports_v11_fixed`) confirms.

**Three independent confirmations it was a leak, not a real edge:** (a) the live forward test resolved **3/7 correct** (~coin flip), not 94.7%; (b) clean-data direction is ~50% even at ML_WIN ≥ 85%, across direction-model / daily-Stoch / bias primitives; (c) the multi-period harness showed 94–97% in *every* non-overlapping window (too-consistent = leak signature). Direction is a **coin flip**. Full reasoning in `docs/research/` + the rejected-hypotheses graveyard.

**What was REAL and survived:** **ML_WIN** (direction-AGNOSTIC quality, `goodR = fwdMaxFavR ≥ 1.5`). Clean retrain top-bucket **76.4% vs ~51% base**, WF 62/62/63% — essentially identical to the leaked v11 (the leak barely touched the quality target; it was a *direction* problem). ML_WIN predicts **volatility/variance**, not drift.

**Strategy implication (tested):** a direction-agnostic convex / let-winners-run strategy (1R stop, 5R target, long+short) has a real **gross** edge from crypto fat tails (win 30% vs 17% random-walk theory at 5:1). A dedicated **tail model** (predict `fwdMaxFavR72H ≥ 5`, 29% vs 17% base) improves selection over ungated and crushes ML_WIN-gating (ML_WIN predicts the *body* that hits your stop, not the *tail*). BUT after the user's real **Coinbase Intro-1 derivative fees** (0.10% taker / 0.095% maker per side ≈ 0.23–0.28% round trip) it's **net negative** (TAIL-gated −0.04 to −0.07R). Break-even ≈ 0.165% round trip — only reachable at a much higher volume/fee tier. Conclusion: the system is an honest **volatility + risk + analysis** tool, not a retail-fee alpha engine. Scripts: `ml-training/strategy_clean_test.py`, `strategy_tail_test.py` (env `COSTS=`), `direction_multiperiod.py`.

**Shipped (deployed worker version 93a6cc67):**
- `mlPredictDirection()` (`marketscope-worker/src/ml-predict.ts`) returns **null unconditionally** — `pUp` no longer served. The cron's `logDirectionSignals` (dual-gate forward validation) now skips (pUp null), `/ml-predict` serves `mlDirectionUp: null`, iOS prompt/table hide the row. The `ml-model-crypto.heads.json` direction head file is retained on disk but no longer consulted.
- Honest crypto quality model retrained on clean data: `ml-training/calibrate_v12_crypto_clean.py` reads `csv_exports_v11_fixed/`, writes worker + iOS `ml-model-crypto.json` (`version: 12`, `v12-CLEAN` description). Leaked model backed up at `/tmp/ml-model-crypto.LEAKED.bak.json`.
- `src/prompt.ts` already had the DIRECTION MODEL / CONFORMAL blocks removed and STOCH_CROSS reframed as "momentum context only, NOT directional (~51% coin flip)"; POSITION SIZING rewritten direction-agnostic. Notification body dropped LONG/SHORT labels → "big move likely".
- Parity fixtures' crypto `expected.mlProbability` updated via `scripts/update-fixture-ml.ts` (BTC 0.527→0.386, ETH 0.653→0.502); `heads-parity.test.ts` direction case asserts null. **377/377 worker tests green.**

**NOT yet done (follow-ups):** iOS bundled `ml-model-crypto.json` was overwritten but needs a **rebuild+install** to take effect in `BacktestEngine` (live iOS serving is the worker, so this is low-priority/training-canonical only). The inline **direction-model claims elsewhere in this doc** (System Prompt Architecture Step 3's "~94% crypto direction", the 2026-05-30 dual-gate entries, the Direction Primitive section) are now **superseded by this entry** — direction is a coin flip; treat those sections as historical. The `csv_exports_v11` (leaked) crypto CSVs remain on disk for the record; `csv_exports_v11_fixed` is canonical going forward.

### 2026-05-31 — 🚧 IN PROGRESS: Web app migration (Cloudflare Pages + dedup Swift→Worker)

**A multi-phase migration is underway and PARTIALLY COMPLETE. If resuming: read the plan at `~/.claude/plans/goofy-knitting-turing.md`, then `git log --oneline` for the latest, then continue from "Next step" below.**

Goal: add a browser-accessible **web app** (React + Vite + lightweight-charts on Cloudflare Pages, full parity), **keep the iOS app**, and **eliminate duplicate logic** by moving the analysis brain (indicators + prompt building) into the Worker so both clients are thin. Notifications via a Telegram bot. AI Gateway for LLM observability. Cost impact ~zero (Pages/AI-Gateway/Telegram free).

Phases (see plan file for detail):
- **Phase 0 — AI Gateway** ✅ DONE (commit 5849e26, deployed). `aiGatewayURL()` routes /analyze through a CF AI Gateway when `AI_GATEWAY_BASE` is set; currently empty (inactive). **Manual step pending the user: create a gateway in Dashboard→AI→AI Gateway named `marketscope`, set `AI_GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1/a14bb8d9f546f17633ad8a7f22863cfe/marketscope"` in wrangler.toml, redeploy.**
- **Phase 1 — shared analysis brain on the Worker** 🚧 ~90% done:
  - `src/scoring-ios.ts` ✅ — faithful port of ScoringFunction.swift (granular bias + signed score). The existing `scoring.ts` computeScore is a SIMPLIFIED 3-way scorer (ML gate only); scoring-ios is the exact one for display/parity (commit 3085951).
  - `src/indicators-full.ts` ✅ — port of IndicatorEngine.computeAll (series + S/R + Fib + patterns + structure + VP), reuses scoring-full.ts math + scoring-ios bias (commit a4cff53). Now also exposes `atrPercentile` + `atrPercentileLabel`.
  - `GET /indicators?symbol=` ✅ — live, verified end-to-end on BTCUSDT (commit 0e9223e). Serves the full IndicatorResult across daily/4H/1H. crossAsset/derivatives default 0 (full-analysis supplies them).
  - `src/prompt.ts` ✅ — `systemPrompt`, `classifyArchetype`, `useTighterBands`, `parseSetups`, `formatPrice` (commits b76b2f8 +), **and `buildUserPrompt` — the full ~2,090-line / ~40-section pre-computed-flags core, ported faithfully (treatment branch, always active post-collapse) at commit aac4c69.** Pure + STATEFUL: `buildUserPrompt(input) → {prompt, newState}` takes `prevState` (regime / killDur / nakedPOC) + `nowMs` in, returns `newState` for the caller to persist. Ported helper analyzers (DivergenceDetector, PriceActionAnalyzer, MomentumAlignment, computeClearance, pocAlignment) + ET timestamp formatter (Intl) + US-holiday calendar live in the same file. Data contract = `PromptIndicator` (computeFullIndicators output + ML overlay) + ~14 enrichment interfaces + `BuildPromptInput`/`PromptState`/`PromptSettings`. 2 end-to-end tests (crypto + stock over real computeFullIndicators output) pass; 368/368 worker tests green.
  - `POST /full-analysis?symbol=` ✅ BUILT + **DEPLOYED + SMOKE-TESTED LIVE** (commit 7b06775; deployed version 7aa75df1). Pipeline: candles (`fetchAllTimeframes`) → `computeFullIndicators` per TF → ML overlay from cron-cached `ml_preds:all` (win/persistence/pUp/meta/q75/confident onto daily) → enrichment (derivatives/positioning/spot/macro) → outcome-history from `trade_outcomes` D1 → KV-backed prevState (`prompt:<symbol>`, 7d TTL) → `buildUserPrompt` → persist newState → `systemPrompt` → Claude via `aiGatewayURL` → `parseSetups` → return `{analysis, setups, ml, bias}`. Auth-gated + rate-limited (`analyze:<device>` 30/h). **Live verification (2026-05-31, throwaway device, cleaned up):** BTCUSDT + ETHUSDT both returned well-formed JSON, real ML overlay (e.g. ETH win 0.469 / persist 0.423 / pUp 0.591), computed bias (Bearish/Bearish/Strong-Bearish via scoring-ios), Claude sonnet-4-6 analysis (~3.7–3.9K chars) consuming the pre-computed flags (regime/levels/VWAP/POC), 0 setups (ML<50 → Conviction-Envelope auto-FLAT, correct).
  - `src/enrichment.ts` ✅ — faithful ports feeding `/full-analysis` (commits a982af2 + 154bb69): **crypto derivatives + positioning** (DerivativesService.buildResult + PositioningAnalyzer, byte-matched labels/signals), **spot pressure** (SpotPressureAnalyzer — 24×1h klines CVD + depth), **macro** (FRED/DXY from the `/macro` cache → MacroSnapshot). All best-effort + parallel; crypto path now well-enriched (the user's primary market). Unit-tested vs known payloads.
  - **NEXT STEP (Phase 1 tail — pick by priority):** (a) **Remaining enrichment** — `sentiment` (CoinInfo via CoinGecko, crypto), `crossAsset` (DXY/SPY EMA20+trend+summary — parity-sensitive summary string), and the **stock** set (`stockInfo`/`stockSentiment` via Yahoo, `economicEvents`) — all optional in the builder, additive. (b) **Captured-Swift prompt-parity test** — run iOS `buildUserPrompt` for a fixture symbol, snapshot to `test/fixtures/`, assert byte-equality (the parity gate). (c) **Deploy + smoke-test** `/full-analysis` on the live worker with a throwaway device-id (clean up; never the user's real device-id). Known parity caveats to reconcile vs the fixture: per-TF MACD line/signal scalars from series-last values; ActiveTrade/archetype/outcomeHistory passed IN (D1); stock smaCross/gap/addv optional; ET strings via Intl spacing.
- **Phase 2 — React web app** (Cloudflare Pages) 🚧 **DEPLOYED + LIVE at https://marketscope-web.pages.dev** (project `marketscope-web`, deploy via `cd web && npm run build && npx wrangler pages deploy dist --project-name marketscope-web --commit-dirty=true`). `web/` = Vite + React 18 + TS + lightweight-charts, thin client over the Worker. `src/api.ts` mirrors iOS auth (localStorage device_id + token, 3 headers, 401→rotate+re-register). **Shipped:** Markets view (editable localStorage **watchlist**, price/bias header, **multi-TF candlestick chart** [Daily/4H/1H selector] with EMA20/50/200 + S/R + Entry/SL/TP lines, **RSI + MACD sub-panels**, IndicatorTable, **Run AI Analysis** → markdown + setups + ML card); **Scoreboard view** (Direction Model live accuracy vs 94.7% baseline + ML calibration, from `/direction-accuracy` + `/ml-calibration`); **Settings view** (account size + risk% → localStorage → sent to `/full-analysis` → CANDIDATE SETUPS sizing). **Worker changes for web:** CORS `Allow-Origin: *` (was iOS-only capacitor origin — blocked the browser); `/register` IP limit 3→20/24h (smoke tests exhausted it → 429); `/full-analysis` reads accountSize/riskPercent from body. **Known web gotcha fixed:** chart Y-axis must tear down prior symbol's price lines on switch or it stays pinned to the old scale (commit 40d8146). **Remaining parity:** alerts, per-device outcome/trade-history dashboard, Stoch/ADX/Volume sub-panels, prompt-parity fixture, stock enrichment. Live Worker ver d2525efe (full crypto enrichment + CORS + settings).
- **Phase 3 — Telegram notifications** — NOT started.
- **Phase 4 — migrate iOS onto the shared brain** 🚧 **Step 1 DONE (commit a9a443d, default OFF):** flag-gated server-analysis path. `use_server_analysis` UserDefault (Settings → "Server analysis (beta)") routes `AnalysisService.runFullAnalysis` through `WorkerFullAnalysisService` → `POST /full-analysis` (Sonnet **+ extended thinking**, 8000-budget) instead of building the prompt on-device; markdown+setups feed the SAME downstream (AnalysisResult/OutcomeTracker/alerts); indicators stay local (chart/table/tracking). Nothing deleted — `AnalysisPrompt.buildUserPrompt` remains for OFF + comparison. iOS BUILD SUCCEEDED; not installed on sim. **Step 2** = make ON the default after the user compares outputs; **Step 3** = delete the Swift prompt builder (the actual dedup payoff). `/full-analysis` text extraction pulls the first `text` content block (thinking responses lead with a `thinking` block).

All work committed + green (365/365 worker tests). Parity discipline: indicator scalars + bias come from parity-tested paths; display series are visual-only; the prompt port needs a captured Swift fixture for byte parity.

### 2026-05-31 — Live calibration monitor + dead-man's-switch + position sizing

Three gaps closed from a system-wide audit. (1) **ML quality calibration monitor** — the cron samples each symbol's ML Win ~once/20h into `ml_calibration` D1 and grades it 24h later against realized goodR (≥1.5 ATR move in 24h, direction-agnostic); `/ml-calibration` serves realized-vs-predicted by bucket; iOS `MLCalibrationService` + dashboard card. Companion to the direction scoreboard — drift detector for the core quality gate. (2) **Dead-man's-switch** — cron stamps `cron:heartbeat` KV each full pass; public `/cron-health` returns 503 when stale (>10 min) for an external uptime monitor; iOS `CronHealthService` shows a stale banner. (3) **Position sizing** — `AnalysisPrompt.swift` POSITION SIZING flag couples ML Win × direction conviction: high quality + undecided direction (pUp~50%) → HALF size (the direction-agnostic ML Win is a likely-move-but-coin-flip-entry, not a high-confidence trade); hard cap 1.25× given leverage. Motivated by the S/R investigation's broader finding that the measured edge is ML + direction + bands, plus the "ML Win ≠ profit" realization.

### 2026-05-31 — S/R subsystem fully characterized (see docs/research/strategy-levels.md)

Exhaustive teardown of the support/resistance subsystem. **Levels are real locations** (+4-6pp hold vs random; daily closes best) but **level *strength* is unrankable** — six metrics tested (test-count, flip-role, timeframe, Fibonacci ratio, formation volume, volume-at-price), NONE predict hold/break. **Snapping targets to levels LOWERS EV** (win-rate illusion). **Volume-profile features don't earn their place** in the model (ablation within noise). Acted on: neutralized the WORN/FLIP prompt strength tags + removed the `entry_at_worn_level_4+_tests` conviction downgrade (false signal). Scripts: `ml-training/level_validation*.py`, `setup_execution_snap_test.py`, `volume_at_level.py`, `ablation_vp.py`. Full findings + the rejected-hypotheses graveyard in `docs/research/`.

### 2026-05-30 — Crypto direction model + live dual-gate validation

**Crypto direction head shipped + a forward live-validation loop.** A dedicated XGBoost direction model (target `up = fwdReturn24H > 0`, 111 features, uniform weights) was trained, parity-proven (1.25e-07), and deployed as `heads.direction` in `ml-model-crypto.heads.json`. The cron computes `pUp = mlPredictDirection(features, isCrypto)` per symbol; iOS reads it via `/ml-predict` → `IndicatorResult.mlDirectionUp` → both the LLM prompt (DIRECTION MODEL line) and the indicators table (`IndicatorTableView` "Direction" row, crypto-only). Holdout: ~80% direction accuracy at ML≥0.70 full-coverage, ~94.7% at pUp≥0.70 (60% of high-ML bars), holds through the 2022 bear.

**Leakage audited, not assumed** (`ml-training/direction_leak_audit.py`): max feature↔target corr 0.273; label-shift decay 79.6→70.3→62.7→52.6→50.8% as the predicted horizon pushes out (genuine momentum fade, not a leak); shuffled-target null collapses to 50.1%. Three independent kill-tests, all clean.

**Stock direction model tested and REJECTED** (`ml-training/direction_model_compare.py`): same recipe yields chance on stocks (selection 62.4% → holdout 53.0%, flat across all 5 regime folds, actively wrong at pUp≥0.60). No stock direction head ships — `mlPredictDirection` returns null for stocks, the prompt/table hide the row. Confirms the bimodal thesis at the model level (crypto momentum-driven, stocks efficient).

**Live dual-gate validation loop** (`marketscope-worker/src/index.ts`): new `direction_signals` D1 table (lazy-created). The cron `logDirectionSignals` records every dual-gate fire (rising-edge ML≥0.70 AND pUp≥0.70/≤0.30) with entry price + predicted dir, deduped to one open signal per symbol. `resolveDirectionSignals` grades each against the realized price 24h later (`fwd_return`, `correct`). `/direction-accuracy` (GET, auth) serves the aggregate; iOS `DirectionAccuracyService` + `OutcomeDashboardView` "Direction Model — Live (crypto)" section display live accuracy vs the 94.7% backtest baseline, broken out by confidence band. This is the out-of-sample, forward test of the backtest claim — accumulates autonomously across the universe whether or not the app is open. Frequency (`ml-training/dual_gate_frequency.py`): ~6.6 dual-gate signals/month per crypto symbol on the holdout, short-skewed in the current regime; pre-cost. Residual caveats remain survivorship + execution, not leakage.

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
