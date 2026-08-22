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
| `/tracked-setups` | GET | required | Full per-device server-resolved setup/FLAT lifecycle rows (2026-07-09 cutover) — the iOS dashboard's data source. Registered by `/full-analysis`, resolved by the cron (`outcome-tracking.ts`) |
| `/liquidations` | GET | required | Per-symbol observed forced-liquidation aggregates + recent events (box websocket collector, 2026-07-10). Sampled feed — lower bounds |
| `/scores` | GET | required | Per-device score history (ML probability time series) |
| `/notifications` | GET | required | Per-device push notification log |
| `/performance` | GET | required | Per-symbol win/loss aggregate stats |
| `/ml-predict?symbol=…` | GET | required | Read ML prediction from `ml_preds:all` KV (5-min TTL, written by cron). Returns `{symbol, probability, probabilityH72, features, timestamp, isCrypto}` |
| `/notify-debug` `?symbol=…` | GET | required | Why no notification fired. Serves the cron's OWN recorded gate decisions (`notify_debug:all` KV, 15-min TTL) plus per-device gates (push token, watchlist, `notif_claims`, `autorun` guard). `blockedBy` names the FIRST closed gate; null = all open |
| `/auto-analysis?symbol=…` | GET | required | Cached result of a server-side auto-run (`autoanalysis:<symbol>` KV, 1h TTL, written by `runAutoAnalysis`). Same shape as `/full-analysis` + `at`; 404 when nothing cached. Read-only (no claim/delete) — iOS tracks consumption locally in `autoanalysis_seen_<SYM>` |
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
| `/ml-calibration` | GET | required | Live calibration of the ML *quality* model: realized goodR rate by predicted-probability bucket. Drift detector. Reads `ml_calibration` D1. `?market=crypto\|stock` filters to one model AND returns `curve` — the fitted live mapping (2026-08-21 PAV refit) the gates actually apply |
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
| `tracked_setups` | OOB (lazy `ensureTrackedSetupsTable`, `outcome-tracking.ts`) | id TEXT PK (uuid), device_id, symbol, is_crypto, kind ('setup'\|'flat'), direction, entry/stop_loss/tp1/tp2, reasoning, price_at_setup, atr, ml_at_registration, conviction, model_version, prompt_version, archetype, setup_type, state, terminal, entry_hit(+_at), stop_hit, tp1_hit, tp2_hit, breakeven_activated, partial_taken, max_favorable, max_adverse, outcome, invalid_reason, flat_reason, false_flat, price_after, pending_expires_at, registered_at, resolved_at, last_checked_at, outcome_row_id | `idx_tracked_open(terminal, symbol)`, `idx_tracked_device(device_id, registered_at DESC)` |
| `direction_signals` | OOB (lazy `CREATE IF NOT EXISTS`, `ensureDirectionSignalsTable`) | id PK, symbol, fired_at, entry_price, ml_win, p_up, predicted_dir, model_version, is_crypto, resolve_at, resolved, exit_price, fwd_return, actual_dir, correct | `idx_dirsig_unresolved(resolved, resolve_at)`, `idx_dirsig_symbol(symbol, fired_at DESC)` (both lazy) |
| `liquidations` | OOB (lazy, `server/liquidations.ts`) | id PK, symbol, ts (ms), side ('long'\|'short' — the LIQUIDATED side), price, qty, notional | `idx_liq_symbol(symbol, ts DESC)`, `idx_liq_ts(ts)` |
| `oi_snapshots` | OOB (lazy CREATE in the cron, since 2026-06-03) | symbol+timestamp PK, open_interest, mark_price, funding_rate, long_percent, basis_pct — dense ~20-min snapshots for the future homemade liquidation heatmap | `idx_oi_snap(symbol, timestamp DESC)` |
| `depth_snapshots` | OOB (lazy CREATE in the cron, since 2026-07-10) | symbol+timestamp PK, mid, best_bid/ask, bid/ask USD depth within ±0.5/1/2% of mid, per-side actual span pct (truncation self-describing) — ~20-min cadence, crypto only | `idx_depth_snap(symbol, timestamp DESC)` |
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
- **`OutcomeTracker`** is a READ-ONLY display store since the 2026-07-09 cutover: the box registers every setup/FLAT at analysis time and resolves them on its per-minute cron (`marketscope-worker/src/outcome-tracking.ts`); iOS pulls `GET /tracked-setups` via `refresh()` and caches a snapshot in `~/Library/Caches/trade_outcomes/server_*.json` (legacy per-symbol archives merge in as terminal history).
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

### Chart Rendering (LWC v5, 2026-07-08)

The price chart is **TradingView Lightweight Charts v5.2** in a persistent `WKWebView` (`ChartWebViewStore.shared`, one instance for the app lifetime; `Resources/chart/chart.html` + vendored `lightweight-charts.standalone.production.js`). **v5 native panes**: ONE chart hosts the main pane + each enabled indicator sub-pane (RSI/MACD/Stoch/ADX), all sharing one time scale — no per-pane chart instances, no range-sync layer (that was the v4 multi-pane jank). Pane separators are native + draggable.

**Gestures are handled INSIDE the page** (no UIKit recognizers, no Swift→JS per-touch bridge — Swift only disables WebKit's interfering double-tap/long-press recognizers and drives the ⟲ reset):
- One finger on bars → free 2D pan, native LWC (`horzTouchDrag` + `vertTouchDrag`; a capture-phase touchstart flips the price scale to manual so vertical pan engages, and a bare TAP restores autoscale on release)
- Two fingers → time zoom, custom DOM pinch (Euclidean spread, `PINCH_AMP` amplification; LWC's native pinch is OFF — it had a slow startup threshold)
- One finger on the price axis → price zoom via the `#priceGrip` DOM strip → `IPriceScaleApi.get/setVisibleRange` (v5 API, ≥5.0.7; anchored on last close — LWC's touch layer doesn't drive the price axis)
- Time-axis drag → native LWC axis scaling; ⟲ reset chip → `nativeReset()`

A unified touch-state machine in chart.html owns gesture bookkeeping with staleness failsafes (eaten touchend from tab switches can't wedge data updates, the pinch, the grip, or autoscale). Data pushes are deferred while a finger is down and flushed on release. `ChartGesturesUITests` pixel-diffs every gesture with real synthesized touches on the simulator.

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

- **Crypto model (v14, retrained 2026-07-06):** LightGBM depth=4, 150 trees — 77 symbols, 145,045 daily-downsampled bars from the full-coverage derivatives regen (`csv_exports_v14`), **WF AUC 0.674** (folds 0.672/0.670/0.678), top-decile precision 76.6%. Config challengers (d5/d6-class) and the pruned-71 feature set all failed the pre-declared ship bar → incumbent config on the FULL (110-feature) set shipped.
- **Stock model (v14, retrained 2026-07-06):** XGBoost depth=5, 100 trees — 159 symbols, 252,215 bars (`csv_exports_v14_stocks`), **WF AUC 0.686** (folds 0.678/0.687/0.693), top-decile 78.3%. d6-class challengers again beat prod in 3/3 folds (Δ+0.0042..+0.0043 — second consecutive retrain) but stayed under the +0.005 ship bar → incumbent shipped. If a third retrain repeats this, consider revising the bar.
- **Features:** 110 (111-feature serving contract minus `volScalarML`, an r=1.000 duplicate of `atrPercentile`; the worker evaluates trees by feature name, so the trimmed training list is serving-safe)
- **Target:** `goodR = fwdMaxFavR >= 1.5` (max favorable excursion in ATR multiples)
- **Training:** Walk-forward CV (3-fold expanding window), purged 48-bar gap, daily downsampled, time-decay sample weighting (last year 3x, last 2 years 2x)
- **Calibration:** Isotonic regression fit on out-of-fold predictions, capped at 0.85.
- **Serving architecture (post-Phase 5, 2026-05-04):** Worker is the **single source of truth** for displayed ML and notifications. iOS reads from `/ml-predict?symbol=…` (cron-cached, 5-min KV TTL); local `MLScoring.predict` is retained only for `BacktestEngine` (training canonical). No local fallback in production — UI shows nothing if cache is missing.
- **Inference:** Native Swift tree evaluator reads same JSON as worker (no CoreML). Worker `mlPredict()` (`marketscope-worker/src/ml-predict.ts`) uses identical tree evaluation logic. Worker↔BacktestEngine parity is asserted at 1e-7 absolute tolerance via `marketscope-worker/test/parity-vs-backtest.test.ts` (fixture ML values refreshed for v14, 2026-07-06; 425/425 total worker tests green).

### Calibrated Reliability (v14, out-of-fold on the 2026-07 full-coverage regen)

v14 crypto (145,045 bars, 50.5% baseline goodR; calibration floor 0.2498):

| Predicted Range | Crypto Actual | Samples |
|----------------|---------------|---------|
| < 30% | 23.7% | 6,356 |
| 30-50% | 39.4% | 32,656 |
| 50-60% | 55.9% | 23,153 |
| 60-70% | 64.1% | 15,189 |
| 70-85% | **75.9%** | 9,136 |

v14 stocks (252,215 bars, 57.0% baseline goodR; calibration floor 0.3193 — no bucket below 30%):

| Predicted Range | Stock Actual | Samples |
|----------------|---------------|---------|
| 30-50% | 38.9% | 63,141 |
| 50-60% | 55.0% | 11,419 |
| 60-70% | 66.5% | 31,651 |
| 70-85% | **73.8%** | 43,256 |

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
| `ml-training/calibrate_v14.py` | Active training script (both markets) — `crypto\|stocks [--ship]`, challenger evaluation under the audit ship bar, staging in `models_v14/`, ship copies to worker + iOS |
| `ml-training/calibrate_horizon.py` | 72h persistence retrain — writes worker `ml-model-{market}-h72t25.json` DIRECTLY (running it IS shipping) |
| `ml-training/train_tail_head.py` | Tail head (crypto big-move) — embeds `heads.tail` into the shipped ml-model-crypto.json; run AFTER the main --ship |
| `ml-training/calibrate_v13_stocks.py` / `calibrate_v11_crypto.py` / `calibrate_v12_stocks.py` | Predecessor scripts (kept for reference) |
| `ml-training/csv_exports_v14/` | 77-symbol crypto CSVs, full-coverage derivatives regen (2026-07-05/06). Gitignored. Canonical. |
| `ml-training/csv_exports_v14_stocks/` | 159-symbol stock CSVs, same regen. Gitignored. Canonical. |
| `ml-training/csv_exports_v11_fixed/` `csv_exports_v13/` `csv_exports_v12/` | Predecessor CSV sets (leak-fixed v11, v13/v12 stocks). Kept for reproducibility. |
| `ml-training/calibrate_v9.py` | Legacy combined crypto+stock script — name is stale (was used to bootstrap v10 crypto model) |
| `ml-training/model_comparison.py` | Hyperparameter comparison (XGBoost d3-5 × t100-200 + LightGBM) |
| `ml-training/finra_dark_pool.py` | Downloads FINRA RegSHO daily files, computes short volume Z-scores |
| `ml-training/news_backfill.py` | Reconstructs a historical policy-event list from the Fed yearly press-release archives (dates are encoded in the release URLs; listing pages only, no article bodies) |
| `ml-training/news_catalyst_test.py` | Tests whether policy-catalyst proximity predicts `goodR` — REJECTED (clean null; the apparent −10.8pp was a day-of-week artifact). See `docs/research/news-catalyst-test.md` |
| `ml-training/level_rejection_direction.py` | Tests whether a confirmed rejection at a major S/R level predicts 3-4 bar direction — REJECTED (coin flip, gross EV below Binance fees, 0-2/6 folds). Reuses `level_validation.py` detection. See graveyard |
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
| Threshold | calibrated ML level >= 65% (2026-08-21; level not edge since 2026-08-06) | calibrated ML level >= 65% |
| Direction primitive | bias-aligned OR dStochCross (union, skip conflicts) | bias-aligned OR dStochCross (union, skip conflicts) |
| Cooldown | 3.5 hours per (push_token, symbol) | 3.5 hours per (push_token, symbol) |

**Envelope precheck (2026-07-11):** an ML rising-edge alone no longer pages the user — before notifying, the symbol pass builds the REAL analysis prompt from the candles it already has and parses the Conviction Envelope's `auto_FLAT_active:` line (`envelopePrecheck` + `parseAutoFlatReasons` in `src/index.ts` — zero drift with the actual analysis by construction). If the envelope would auto-FLAT (chase into extended trend, kills, macro IMMINENT, mixed biases below the calibrated gate…), the cross is SUPPRESSED — but per the 2026-05-30 notify-window lesson it DEFERS rather than drops: the suppressed cross (KV `notif_suppressed:all`, 24h expiry) is re-checked every tick and fires the moment the envelope clears with ML still ≥ threshold; it cancels silently if ML fades below threshold first. The precheck runs without enrichment (no derivatives/stock inputs) so it can only UNDER-suppress, never over-suppress; precheck errors fail open (notify). The calibrated-ML blend is shared via `fetchMlCalibration` (extracted from `runFullAnalysisCore`). **Extended to ALL proactive push types (2026-07-11b):** one `pred.envelopeFlat` verdict per symbol per tick now also gates the risk-state transition push (COMPRESSION heads-up — skipped outright; it fires in exactly the coiled tape that auto-FLATs) and the entry-zone-reached push (skipped WITHOUT marking `notified`, so it re-checks each tick and fires when the envelope clears while price is still in the zone). The precheck therefore also runs for symbols with new HIGH risk states or live pending setups. `/health` now returns `build` (the GIT_SHA baked in via workflow build-arg → Dockerfile ENV) so a TrueNAS deploy is remotely verifiable.

**Automated analysis push (2026-07-14):** a surviving ML-cross no longer sends a bare "ML 73%" ping — it now runs the FULL LLM analysis server-side (`runAutoAnalysis` in `src/index.ts`, called `void`-detached from `processDeviceNotifications` so a 30-90s call never blocks the minute cron; the box is a persistent process so it outlives the pass) and pushes the **Bottom Line** instead, titled "setup ready" when a concrete setup came out. It also auto-registers the setups into `tracked_setups` (fully autonomous outcome tracking — no app open needed) and caches the result to KV `autoanalysis:<symbol>` (1h) for the app to pick up on open (iOS pickup = fast-follow). Scope = the device's synced watchlist (the trigger loop is `for (symbol of watchlist)`). Fixed to Sonnet 5 + extended thinking (auto-runs don't see the per-request model the app sends; the user's standing pick). Cost-bounded: the 3.5h `notif_claims` cooldown + a per-symbol `autorun:<sym>` KV guard (cooldown TTL) cap it at ~one LLM run per symbol per 3.5h. Best-effort — any failure falls back to the bare move-likelihood push so a cross is never lost.

**Real-time gate (2026-05-30):** the notification fires the instant a cross is detected (`if (!pred.crossed || !pushToken) continue` in `processDeviceNotifications`), gated only by the 3.5h cooldown (and, since 2026-07-11, the envelope precheck above). The previous fixed notify-window gate (8/12/16/20/23:30 ET crypto; 8/12/16 ET weekday stocks) silently **dropped** crosses landing off-window rather than deferring them: `mlProb` only moves on a 4H close and `crossed` is true for a single cron tick (`prevMl` = previous minute, cron runs `* * * * *`), so any 4H close outside a window was missed entirely. With crypto closing 24/7, most signals were lost. Quiet-hours is delegated to the user's iOS Focus/DND. The `computeNotifyFlags`/`NotifyFlags`/`NOTIFY_TZ` window machinery was removed.

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
- Active training: `ml-training/calibrate_v14.py crypto|stocks` reads `csv_exports_v14/` (77-symbol crypto) + `csv_exports_v14_stocks/` (159 stocks), both from the 2026-07-05/06 full-coverage derivatives regen via the Node-CLI runner `marketscope-worker/scripts/runBacktest.ts`; the iOS BacktestEngine path is no longer used for production CSV generation.

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

## Outcome Feedback Loop (server-side since 2026-07-09)

The FULL setup lifecycle runs on the box (`marketscope-worker/src/outcome-tracking.ts`): `/full-analysis` registers every parsed setup (or the FLAT decision) into `tracked_setups` at analysis time, and the cron's `resolveTrackedSetups` pass advances them every ~5 min against 15m crypto klines / 1h stock candles (entry touch, +1R break-even, same-bar open-proximity ambiguity, 12h pending expiry with simplified re-eval, 7d untriggered prune, FLAT graded at +24h `|move| > 1.5%`). Counted terminals (tp2_win/tp1_win/partial_be/loss ONLY) are inserted into `trade_outcomes` — outcomes resolve whether or not the app is ever opened. `TRACKED_MODEL_VERSION` / `TRACKED_PROMPT_VERSION` in outcome-tracking.ts are the version registry of record.

The LLM prompt includes recent resolved trade outcomes for the current symbol (if >= 3 exist matching the worker's model_version filter — IN(10,11,12,14) crypto / IN(12,13,14) stock as of v14), and reads Active Trade State from its own `tracked_setups` (body.activeSetups is a legacy-app fallback only). LLM instructed to calibrate confidence based on patterns.

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

Re-validated CLEAN 2026-07-06 (`ml-training/mixed_flat_test.py`, v14 regen — the original 73-86% numbers were leak-era): non-aligned bars (daily/4H conflict or neutral) carry ~2× the goodR rate of aligned bars — crypto 61/59% vs 33/30%, stocks 70/71% vs 39/35%; flat across trend age. Direction stays a coin flip in every state (P(up24) 48-53%). Prompt allows counter-trend reversal when ML_WIN >= 70%, with tighter targets (TP1 1.0 ATR, TP2 2.0 ATR) and MODERATE conviction cap. Since 2026-07-06 the Conviction Envelope's `biases_MIXED` auto-FLAT is ML-gated (fires only when ML < 70) so this playbook is actually reachable — see the 2026-07-06 decision entry.

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

Four of the eight items here were fixed 2026-07-24 (see the decision entry below): the redundant
`pending_setups` table, the missing App Group entitlement, the APNs sandbox-first latency, and the
derivatives archive over-writing. Schema drift is closed by `migrations/007_schema_drift.sql`. What
remains:

- **No certificate pinning on network calls — deliberate WON'T-DO, not a backlog item.** Verified
  2026-07-24: `marketscope.ludikure.org` serves a **90-day Google Trust Services cert** (issuer
  `GTS WE1`, CN=ludikure.org, e.g. Jun 5 → Sep 3 2026) via the cloudflared tunnel. Pinning the leaf
  SPKI would brick every install at each auto-renewal (~quarterly, silently, with no server-side
  signal); pinning the intermediate or root is weaker AND still breaks whenever Cloudflare rotates
  CA (it issues from both GTS and Let's Encrypt and can switch without notice). The asset being
  protected is a device auth token to a single-user hobby backend, already over TLS with a public CA
  — so pinning trades a real, recurring self-inflicted-outage risk for a marginal reduction in an
  already-remote CA-compromise threat. Revisit only if the backend moves to a cert whose rotation we
  control.
- Parity fixtures (BTC/ETH/TSLA at 2026-05-04) still in use under v14 — `expected.mlProbability`
  values were updated in-place via `marketscope-worker/scripts/update-fixture-ml.ts`. Feature-level
  parity assertions are still measured against the 2026-05-04 feature snapshots. **Low value, and
  it needs you:** fixtures are captured by the DEBUG-only "Capture Parity Fixture" button in
  BacktestView on a simulator, then hand-copied out of the sim container — it can't be automated
  headlessly. And parity is computed from each fixture's OWN candle slices, so a stale capture date
  doesn't weaken the 1e-7 assertion; it only means the fixtures don't cover recent market
  conditions. Worth doing when you're next in the simulator anyway, not before.
- Backtester: crypto regen ~7h at concurrency 8 (Binance rate-limit cascade); stocks regen ~3.5h
  across two passes (Yahoo TCP drops at concurrency 8). Section H/K of
  `/Volumes/External/Downloads/marketscope-postponed-work.md` documents the concurrency tuning +
  raw candle cache opportunity. **Genuinely open**, but it's a multi-hour perf project whose only
  honest validation is a full regen, so it wants a dedicated session.
- ~~72h persistence model not yet retrained on fresh data~~ — RESOLVED 2026-06-05: retrained crypto
  on leak-clean `csv_exports_v11_fixed` (stock was leak-spared, reproduced identically). See the
  2026-06-05 decision entry.

## Recent Architectural Decisions

Reverse-chronological log of major architectural changes. New sessions should scan from the top — most recent context is most relevant for understanding the current system state.

### 2026-08-22j — Proved the news reaches the model, then split "what it was TOLD" from "what it CONCLUDED" (iOS)

User: *"I ran ai analysis, it gave no info about the news"* — again, after the system-prompt fix. This time it was NOT a bug.

**`promptOnly` already existed** (`runFullAnalysisCore`, `body.promptOnly === true`) — a dry-run returning the REAL built prompt with no LLM call. I nearly built a duplicate debug endpoint before finding it. It answers this class of question in ~5s for free, and is the tool to reach for whenever "is this input actually reaching the model?" comes up. Result on BTCUSDT: **`POLICY / MACRO HEADLINES` present, all six items**, including the Treasury-buyback story. The news IS sent.

The model stayed silent because the guidance shipped hours earlier tells it to: *"if nothing in the block plausibly explains this tape, say NOTHING about news."* That run's tape was "largely unchanged since the last check (47m ago), ML flat at 49%", coiled at the POC — and the freshest primary item was 77h old. Nothing explained it, so nothing was said. **Correct behaviour**, and the guard against exactly the post-hoc "X rose because Y" narration the measured null (`news-catalyst-test.md`) says carries no information.

**But the product was still wrong**, and this is the generalisable bit: *"the model may cite news when it explains the move"* and *"show me what's happening in the world"* are DIFFERENT features, and only the first was built. On a quiet day the second is invisible, and the user cannot distinguish working-as-designed from broken — which is why this question came up twice and cost a paid analysis to answer.

Fix (iOS): `WorkerNewsService` + `NewsCard` on the Now tab, reading the same `/news` rows the prompt gets from the same `fetchRecentNews`. Always visible when items exist, whether or not the analysis cited any. Primaries ranked first and marked "official"; a `LIVE CATALYST` pill when `catalystActive`; top-3 collapsed with expand; and the card says **"Background for the read — not a trade signal. Measured: policy timing doesn't predict the next move."** on its face, so the split is legible: what the model was TOLD is here, what it CONCLUDED is the analysis. Best-effort — any failure hides the card rather than surfacing an error. Re-fetches on symbol change since scope differs (crypto = macro + crypto sources; stocks = macro primaries only). iOS build green — **needs a rebuild+install**; no worker change.

### 2026-08-22i — Collector switched to `ws` + HttpsProxyAgent (code fix, NOT the compose change)

The probe's verdict pointed at `network_mode: service:gluetun`, but reading the real `truenas-compose.yml` changed the call. That compose has a deliberate design — `PROXIED_HOSTS` routes ONLY the exchange hosts through the VPN while Claude/APNs/Yahoo/Finnhub go direct — and `network_mode` discards it, forcing all egress through Switzerland AND putting the whole backend behind gluetun's killswitch. That converts a VPN drop from "one dataset degrades" into "the app and its ingress are down". It also requires moving the 8787 publish to gluetun plus `FIREWALL_INPUT_PORTS`.

**The defect is narrow, so the fix should be too:** undici's `WebSocket` ignores `options.dispatcher`. The `ws` package honors `agent`, and `https-proxy-agent` performs a real CONNECT tunnel through gluetun's `:8888`. The collector now uses `new WsClient(wsUrl, { agent: new HttpsProxyAgent(proxyUrl) })`. Two runtime deps added (`ws`, `https-proxy-agent`) to a near-zero-dep project — the one genuine argument for the compose route instead; `ws` is externalized in the esbuild bundle and survives `npm prune --omit=dev` as a runtime dependency.

**The probe now runs BOTH clients** (`undiciViaProxy` vs `wsViaProxy` vs `direct`) so the next deploy proves the diagnosis rather than assuming it, and its `hint` names the fix for each outcome: `wsViaProxy DELIVERING` = fixed; `OPEN-BUT-SILENT` on both = the tunnel is fine but Switzerland is geoblocked, rotate `SERVER_COUNTRIES`; `REJECTED-AT-UPGRADE` = gluetun refuses CONNECT for wss, fall back to the compose change. Verified locally that `ws`'s `addEventListener` surface matches what the collector uses (`.data`, `.code`, `.message`). 557/557 green.

**Note:** `truenas-compose.yml` holds live credentials and is correctly gitignored (`marketscope-worker/.gitignore:5`) — never committed, not on GitHub. Checked, because the file's own header warns against exactly that.

### 2026-08-22h — Liquidation probe verdict: the box egresses from the US and undici's WebSocket ignores the proxy

`GET /health?probe=liquidations` settled it in one run. **The fix is infrastructure, not code.**

| path | egress | REST | WebSocket |
|---|---|---|---|
| direct | **US / Virginia** | 200 | opens, 0 messages |
| via proxy | **CH / Zurich** | 200 | opens, 0 messages |

Two conclusions. (1) `fetch` honors the `ProxyAgent` dispatcher — the CH egress proves it, and it is why REST derivatives capture has always worked. (2) **`WebSocket` does NOT**: both paths behave identically, which cannot happen if one were really dialing from Zurich and the other from Virginia. So every websocket attempt has been leaving from the box's US IP, and **Binance accepts a websocket from a US address and then serves no data** — reproduced independently from a US dev machine, where a `btcusdt@aggTrade` control stream (many events/sec) also opened and delivered nothing.

**The fix: put the container on gluetun's network** (`network_mode: service:gluetun`) and drop `BINANCE_PROXY_URL`. That makes the container's own IP the Swiss one, so the websocket needs no proxy support at all — removing the dependency on undici's WS-dispatcher behaviour entirely, and simplifying the REST path as a side effect. No code change can substitute: undici cannot be made to proxy a websocket it does not proxy.

**Two more bugs the probe exposed:**
- **The collector was WEDGED, not merely failing.** Live status showed `state: 'starting'`, `attempts: 0`, `lastError: "non-101 status code"` — the boot-time `error` fired, **no `close` followed**, so `scheduleReconnect` never ran and nothing retried, ever. The handler's comment asserting "close always follows error" is false for this failure. Worse, yesterday's watchdog only acted on `state === 'open'`, so it could not rescue this either. The watchdog now covers NON-open states: stuck >2 min with no connection forces a fresh `connect()`.
- **A measurement bug in my own probe:** `openedAfterMs` was computed at resolution rather than at the `open` event, so every path reported ~the 10s timeout — hiding exactly the latency difference that reveals whether the proxy is in the path. Now captured at the event.

557/557 green. Worker-only — needs a redeploy, but **the redeploy alone will not fix capture**; the compose change is what matters.

### 2026-08-22g — The analyses ignored the headlines: an input with no output contract

User ran an analysis and got nothing about the news. Diagnosed immediately and it is my error, of the SAME CLASS as the mandate's JSON-contract gap: I added POLICY / MACRO HEADLINES to the USER prompt (`prompt.ts`) and never touched the SYSTEM prompt, which is what defines the output sections and how to use each input. So the model received the block, had no section to put it in, no instruction to use it, and correctly said nothing. The five output sections (Bottom Line / The Tape / Risk Map / If You Take a Position / What to Watch) have no news slot, and SHORT mode emits only two of them.

**Lesson worth generalising: adding an input is half a change.** An input the output contract doesn't mention is a silent no-op — and this is now twice in one week (the mandate could be satisfied in prose while the JSON block emitted `[]`; the headlines arrived with nowhere to go). Any future prompt input needs a matching output instruction in `prompt-system.json`, plus a test asserting it.

Both market prompts now carry: (a) name a headline in ONE clause inside `## The Tape` when it plausibly explains the current tape — deliberately NOT a sixth section, which would undo the 2026-06-29 skeleton collapse; (b) lead the Bottom Line with a fresh, material PRIMARY-source item; (c) **say NOTHING about news when nothing in the block explains this tape** — never reach for a headline, never write "X rose because Y" when the causal link is the model's own inference. The guidance cites the measured null (`news-catalyst-test.md`, 986 Fed releases) so the model is told explicitly that a headline is never grounds to raise conviction, take a side, or override a pre-computed flag: **explanation, not evidence**. A fresh primary headline also now counts as a material change for the FULL-vs-SHORT mode switch — a live catalyst is not a quiet day. 557/557 green. Worker-only — **needs a box redeploy**.

### 2026-08-22f — Liquidation collector had captured NOTHING for six weeks: the socket opens, Binance serves no data, nothing detects it

Status check on derivatives capture turned up the worst kind of failure. **REST capture is healthy** — BTC's live derivatives features are all populated (funding 0.01, oiChangePct +0.11, takerRatio 1.025, longPct 49.8, basisPct 0.033), confirming the v14 coverage fix holds. **The websocket liquidation collector has zero rows across BTC/ETH/SOL over 90 days** — nothing since it shipped 2026-07-10.

**Root cause, found by experiment rather than by reading logs.** The code is correct: `startLiquidationCollector` is wired at `server.ts:53`, the table is created before connecting, undici 6.26 genuinely honors `options.dispatcher` (verified in `node_modules`). So I ran the real path against Binance: `!forceOrder@arr` reported **open=true, 0 messages in 20s** — and so did a `btcusdt@aggTrade` CONTROL stream, which alone should deliver many events per second. **Binance accepts the websocket from a geoblocked IP and then serves nothing.**

That is invisible to this collector by construction: no `error` fires and no `close` fires, and the reconnect path only triggers on those two events. So it logs `[liq] connected` exactly once and sits mute forever — **the container logs look healthy the entire time**, which is why `grep '[liq]'` would not have found it either.

- **Liveness is now judged on DATA, not connection state.** A watchdog (`SILENT_TIMEOUT_MS` 5 min, checked every 30s) force-closes and reconnects any socket that is "open" but has delivered nothing — the clock deliberately runs from CONNECT, not from last message, since the whole failure is a socket that never delivers a first event. Across all USDⓈ-M symbols, five minutes of total silence cannot be a quiet market.
- **`/health` now reports collector state** (`state`, `messages`, `quietSec`, `silentResets`, `lastError`, and a `healthy` flag computed from data flow). Exposed via a `globalThis` hook set by `server/liquidations.ts` so the portable `src/` worker code keeps no Node-only import. Rationale: for a NON-BACKFILLABLE series, a dead collector must be visible without shell access — `/liquidations` returning `[]` is indistinguishable from a quiet market, and that ambiguity is precisely what cost six weeks.

**What was lost is unrecoverable** (Binance removed the REST endpoint years ago; the stream is the only source) — ~6 weeks including the 62k→80k run, when cascade data is most informative. Bounded, though: this series never fed the model or gated a trade. It was accumulating toward the homemade liquidation heatmap (`oi_snapshots` = where positions opened, `liquidations` = where they died, `depth_snapshots` = the resting walls) and a future cascade-asymmetry WF test — both of which need many months regardless, so the clock restarts rather than ends.

**Still open:** whether the box's gluetun exit is itself in a Binance-geoblocked region. The watchdog converts a permanent silent failure into a visible retrying one, but if the exit region is the problem, retrying will not fix it — `/health.liquidations.silentResets` climbing with `messages: 0` after the redeploy is the tell, and the fix would be a gluetun exit-country change. Also unverified: `oi_snapshots` and `depth_snapshots` have no endpoint. They are cron-driven over the working REST path so are probably fine — but "probably" is exactly what was assumed about liquidations, and they deserve the same health surface. 556/556 green. Worker-only — **needs a box redeploy**.

### 2026-08-22e — Crypto-outlet gate tuned against the live feeds (~50% → ~90% precision)

With the regulator noise gone, outlets fill most of the 6 slots most days (Fed `monetary` is only ~15 releases/year), so outlet quality IS the feature's quality. Measured the gate against the live CoinDesk + Cointelegraph feeds and tuned it — every rule below is a response to a real headline, not a guess.

**The confirmation that mattered:** the actual catalyst behind the missed rally is in the feed and passes — *"How a Treasury buyback tweak helped bitcoin surge 25% to nearly $80,000 in days"* and *"Treasury's latest measure isn't QE or YCC. Still, bitcoin is skyrocketing."*

Four fixes, kept set went 13/25 → 10/25 (CoinDesk) and 13/30 → 10/30 (Cointelegraph) while RECOVERING real stories:
- **`treasury` is ambiguous in crypto media** — it usually means a company holding BTC, not the department. It was admitting *"crypto stocks soaring as miners, treasury companies jump"* and *"Strategy Bitcoin treasury hits breakeven"* on a word that exists to catch bond policy. New `VOID_CONTEXT` voids that sense on narrow phrasings (`treasury compan`, `bitcoin treasury`, `treasury holding`…) while both genuine Treasury-policy articles still match.
- **Recap veto, judged on the TITLE alone.** `RECAP_PATTERNS` (live updates / moving average / analysts split / bears get…) drop an item unless its title also names a POLICY action. Title-scoping was essential: *"Bitcoin breaks above 200-day moving average"* and *"Here's what happened in crypto today"* escaped the veto on a stray "treasury" in their **summaries**. Summaries are teasers and digests; the title is what a story is about. (That headline is also something the app computes itself, from candles, more accurately.)
- **Missing legal/legislative vocabulary added** — the gate had been DROPPING real news: *"South Korean lawmakers seek expanded FIU powers"*, *"Pass the Clarity Act"*, *"Capital.com … after affiliate wins licence"*. Added lawmaker/parliament/congress/senate/court/sued/tax/licence/clarity act/executive order, plus `approval` — voided against the Fed's bank-merger boilerplate (`approval of application`) so it recovers *"Japan's first crypto approval in four years"* without re-admitting National Westminster.
- **Word-boundary matching** replaces substring matching, retiring the `'sec '` / `'ban '` trailing-space hacks (which failed at end-of-title) and the `bill`/`billion` collision.

Regression tests pin every one of these against the real headlines. 556/556 green. Worker-only — **needs a box redeploy**.

### 2026-08-22d — First live output killed the "primaries pass on provenance" rule

Box redeployed; `GET /news?force=1` confirmed **egress works — all feeds reachable through gluetun** (the one risk that could have made the whole feature a non-starter). But the first real prompt view was bad, and in an instructive way. Top three slots, ranked ABOVE everything else because primaries sort first:

> `[Federal Reserve, official] approval of application by National Westminster Bank Plc`
> `[CFTC, official] ICYMI: Members of the Innovation Advisory Committee Join Chairman Selig...`
> `[CFTC, official] Seeks Public Comments on Proposed Elimination of SEF Order Book Requirement`

Bank M&A, a photo-op, and rulemaking minutiae — on every BTC analysis. **My "a Fed release is a catalyst by definition" assumption was wrong, and the backfill had already said so**: 2020-2026 the Fed published 301 bcreg + 214 enforcement + 180 other + 114 orders against just 177 monetary. Provenance means AUTHORITATIVE, not market-moving.

- **Fed items now gate on the URL category slug** (`.../pressreleases/monetary20241203a.htm`) — authoritative, free, and better than any keyword guess. `monetary` auto-passes (FOMC copy is deliberately understated, so a keyword gate would drop the most important releases); `orders`/`bcreg`/`enforcement` must earn their slot.
- **Two vocabularies, because the source classes need different questions.** For a regulator: "is this about markets at all?" → asset words answer it. For a crypto outlet: every headline says "bitcoin", so asset words answer nothing → only EVENT words do. A single shared vocabulary made the outlet gate WEAKER (it re-admitted "Bitcoin surges past $80K") — caught by tests before deploy, not after. Agency names count as subject matter for an outlet but are suppressed inside that agency's own feed (`SELF_TERMS`).
- **Two live bugs found by the deploy:** SEC kept **0 of 25** items — it publishes every few days and the 3-day storage cap discarded every release; storage is now 14d with a split prompt window (primaries 7d, outlets 48h), since a major ruling still explains a tape three days later while outlet copy goes stale fast. And **US Treasury was dropped**: no public RSS responds at any documented path (all 302 to an empty body or fail). A permanently-red feed is worse than an absent one.
- Regression tests pin the exact noise headlines that shipped, so the rule cannot quietly revert.
- **The tightened rule alone did nothing** — verified on the next deploy: ingestion immediately fell to 1-of-20 (Fed) and 0-of-10 (CFTC), yet the prompt still served the same bank-merger and ICYMI headlines. The gate ran at INGESTION ONLY, so rows an older, looser rule had admitted sat in D1 for their full 14-day retention. A write-time-only filter silently makes every future rule change take two weeks to land. New `pruneIrrelevant()` re-applies the current gate to everything stored on each poll and deletes what no longer qualifies (the Fed category slug is recoverable from the stored URL, so the full gate is reconstructible from what we keep). Self-healing: any later vocabulary edit takes effect on the next poll. Prune count is reported by `GET /news` and the cron log. 550/550 green. Worker-only — **needs another box redeploy**.

### 2026-08-22c — Tested it: policy catalysts do NOT predict volatility (and the scary negative was my own artifact)

User asked whether similar news historically predated moves — the right question to ask about a feature that shipped explicitly unvalidated. Design pre-declared in `docs/research/news-catalyst-test.md` BEFORE any number was computed; result filed in `rejected-hypotheses.md`.

**Backfill is feasible and cheap:** the Fed publishes yearly press-release archives with the date encoded in every URL (`monetary20241203a.htm`), so `ml-training/news_backfill.py` reconstructs the event list from ~20 listing-page requests — no article bodies, no HTML date parsing. Got **986 Fed releases 2020-2026, 177 of them `monetary`**. Labels came from `csv_exports_v14` (leak-audited, so the test inherits audited definitions rather than recomputing them).

**Result: clean null.** Pre-declared bar was +3.0pp goodR lift at 0-24h on FED_MONETARY with ≥5/7 positive years; actual **−0.8pp, 4/7 → NOT SUPPORTED**. Catalyst proximity is NOT a v15 feature candidate. Forward up/down excursions were symmetric (+2.71% vs +2.50%), consistent with direction being a coin flip everywhere else.

**The part worth remembering is the trap.** The naive comparison said Fed releases SUPPRESS volatility — FED_ALL 0-24h **−10.8pp at z=−10.4**, which is exactly the kind of number that gets written up as a discovery. It is entirely a day-of-week artifact: BTC goodR runs Mon 57.9 / Fri 34.8 / Sat 24.6 / Sun 59.1 (a 34pp swing, consistent with `dayOfWeek` being crypto's top permutation feature). Releases are dated on weekdays; the conservative end-of-day timestamp pushes the measurement window onto the FOLLOWING day, which for most releases is Friday or Saturday — the two worst days; meanwhile a ">72h from any event" baseline systematically excludes weekends (83% weekday vs a calendar-neutral 71%). Day-of-week-stratified, the effect vanishes: **−0.57pp** (FED_MONETARY), **−1.68pp** (FED_ALL), **+1.20pp** (0-48h). **Methodology rule now recorded: any event study on crypto must stratify by day-of-week before believing an effect** — every economic, regulatory and corporate calendar clusters on weekdays, so this artifact is available in all of them.

**What it changes:** nothing about the shipped news feature, which was labelled context/narrative and never an edge — this confirms that label rather than contradicting it. The catalyst framing on chase-FLAT bars remains a message-quality change with no predictive evidence behind it, which is how it is worded and gated (it does not open the FLAT). H3 (do chase-FLATs age badly on catalyst days) was NOT run: pre-declared underpowered at ~50 FOMC events, and with H2 null its prior is lower still — running it would only have produced a number the design already committed to calling anecdote.

### 2026-08-22b — Policy/macro catalyst headlines (own RSS ingestion, no paid feed)

User: *"the problem is that we don't have any news, like the stuff about government crypto legalization or bond policy"* — after asking whether SEC EDGAR would help (it wouldn't: corporate filings can't carry Treasury or legislative catalysts, and quarterly fundamentals are horizon-mismatched against a 24h ATR target).

**The gap, verified:** crypto analyses already receive FRED macro (rates/yields) and the full economic calendar — `fetchMacroEnrichment` and `fetchEconomicEvents` run for both markets — but `newsHeadlines` hangs off `stockInfo` (`prompt.ts:452`, gated at 1083/1597) and `fetchStockEnrichment` only runs when `!isCrypto`. So crypto had **zero narrative input**: it could see that yields moved and that FOMC was Wednesday, never that a regulator ruled or a bill passed. Regulatory/legislative catalysts appear on no economic calendar at all.

**New `src/news.ts` — RSS ingestion, not scraping.** Feeds exist to be machine-read; titles + summaries only, article bodies never fetched or stored (no ToS/copyright question, and the model only needs the headline). Six feeds, weighted to PRIMARY sources because the catalysts that matter originate there: Federal Reserve, US Treasury, SEC, CFTC (verified live: Fed 200/20 items, SEC 200/25, Cointelegraph 200/30), plus CoinDesk + Cointelegraph. Free, no key — Finnhub's paywall was moot since the primaries are what you actually want.

- **The real risk is noise, not plumbing.** Crypto media is mostly price recaps and price-target op-eds, and an LLM over-weights dramatic phrasing placed beside validated pre-computed flags. Gate: primaries pass on provenance alone; outlets must match a curated catalyst vocabulary (Fed/Treasury/FOMC/rate/SEC/CFTC/ETF/legislation/ban/approval…) that **deliberately excludes price-move language** ("surges", "rally", "all-time high") — the tape already says that, far more precisely. 48h lookback, 6-headline cap, primaries ordered first. **No sentiment scoring, ever** — a homemade bullish/bearish number is the exact shape this project's graveyard is full of.
- **Prompt section is explicitly labelled context, not signal**, and instructs: never raise conviction on a headline, never contradict a pre-computed flag on one, headlines are priced in seconds by machines long before the analysis runs.
- **The one interaction with teeth — and it does NOT open a gate.** When the chase guard auto-FLATs an extended aligned trend AND a primary-source release landed within ~12h, the prompt emits a catalyst FRAMING line: a policy repricing is not the buyer-exhaustion the guard is built to catch, so the FLAT is about ENTRY TIMING, not a claim the move is over — and explicitly not an exit signal for an existing position. The FLAT still stands: `trend_direction_test.py` evidence backs the guard, "a catalyst exists" has no walk-forward evidence, and loosening a validated guard on narrative would be the classic mistake. This fixes the MESSAGE (a chase FLAT suppresses the framing hatch and emits a bare NO SETUP on the day the tape reprices hardest).
- Scope: crypto sees macro + crypto feeds; stocks see macro primaries only (they already carry Finnhub company news). Cron polls every 15 min (KV-gated, fault-isolated, per-feed try/catch); analyses read D1, so the poll costs no per-analysis request. `GET /news` reports per-feed health + the exact prompt view; **`GET /news?force=1` polls inline** — that is how to verify egress *from the box* (gluetun), since some publishers block VPN/datacenter IPs and my feed tests ran from a dev machine.
- Two parser bugs the tests caught before deploy: feeds routinely **double-escape** entities (`&amp;quot;`), needing two decode passes; and CDATA must be unwrapped BEFORE tag-stripping or `<[^>]*>` eats the opener and orphans `]]>` into the headline.

**Honesty, recorded deliberately:** this cannot be backtested — no ship bar, no walk-forward fold, no way to measure "did the narrative help". It is a context/risk-framing change and must not be cited as an edge. `news_items` does feed one future experiment: with catalyst days now recorded, we can eventually measure whether chase-guard FLATs on catalyst days were wrong — but that needs forward data. 545/545 green. Worker-only — **needs a box redeploy**.

### 2026-08-22 — Second review round: the mandate's ML tier was SELF-REFERENTIAL (my fix was narrower than the bug), + 7 more

A second max-effort review of `c96ff13` returned 8 further findings, and **corrected the previous entry's headline fix**. All fixed; 533/533 green. **The mandate gate must never be derived from the calibration ceiling — that is the trap.**

- **`mandateFloor = max(65, min(70, ceilPct))` was circular.** `applyCalibration` CLAMPS at `calibrationCeiling`, so `calibrated <= ceiling` holds by construction — flooring the gate AT the ceiling admitted only bars sitting on the curve's top point, and `max(65, …)` was dead code (when `ceilPct < 65`, nothing can pass at all). Measured with the real fitted curves: the mandate demanded **raw ≥ 0.760** on the coarse Aug curve and **raw ≥ 0.792** on the box's actual curve — BOTH stricter than the plain `raw ≥ 0.70` the whole change set out to widen. The floor also swung 68↔70 purely on which sparse buckets cleared `n >= 40`. **Now: the tier is read off the RAW scale at 70** — a fixed, documented, drift-independent quantity (v14: raw 70-85 realizes 75.9% crypto / 73.8% stocks, 76.6% top-decile precision) that also agrees with the `ML Bucket` line's own "TOP" label instead of quietly using a second scale. The live curve keeps its two real jobs: correcting the auto-FLAT/quality gate, and acting as a **veto** — if a self-declared TOP bar no longer clears the FAVORABLE band (calibrated < 60) on graded forward data, the tier has decayed and nothing is mandated. Veto deliberately set at 60, not the notify threshold: raw-70 bars calibrate to ~65.6 on the live curve, so a 65 veto would trip on ordinary drift. `calibrationCeiling` is out of the prompt path entirely; it now drives one **unreachable-gate guard log** (`[calibration] WARNING <market> curve tops out at X% — below the notify threshold`), which is the one silent total-failure mode this design can produce.
- **One prompt was printing ML_WIN on two scales with no annotation** — the window quoting calibrated ("68%") ~25 lines from `ML Bucket: TOP (ML_WIN 80%)` (raw), reading as a malfunction. Mandate lines now render `ML_WIN raw 80% (live-calibrated 66%)`.
- **The withheld MIXED mandate is now a TOKEN, not a parenthetical.** Both system-prompt rules carve out "(not SUSPENDED)" but match on the window token, so a prose "(Setup NOT mandated here…)" left them firing — telling the model a NO SETUP was acceptable AND that the JSON must carry a setup, in the chase state the 2026-07-02 symmetry fix blocks. Emits `MIXED_HIGH_ML_WINDOW_SUSPENDED:` now (the `:` also keeps the `[mandate-violation]` detector from matching the suspended form).
- **`entryReached`'s 0.1% "market entry" shortcut leaked into the PENDING path** when I extracted it. `classifySetupType` routes "on a 4H close above Y" to conditional by KEYWORD regardless of distance, so a trigger 0.03% above price took the shortcut and flipped active on the first replayed bar — the exact phantom-loss class the extraction was written to kill, for the form the mandate makes common. The shortcut is now opt-in (`allowMarketShortcut`), passed only by the active path.
- **Pending wall-clock rules ran BEFORE the candle replay.** The 12h expiry and the ≥1h re-eval key on `nowMs` and `return` early, while the touch test walks historical `points` — and `resolveTrackedSetups` deliberately backfills ~10 days of downtime. So after a deploy/outage, a setup that provably triggered inside its window (and may have run to TP1) was recorded `expired`/never-triggered. Candle evidence is now evaluated first, bounded to `pendingExpiresAt` so a post-window touch still isn't a trigger. Same class as the 2026-07-24 `stepFlat` horizon fix, which had corrected it for FLATs only.
- **The precheck memo cached FAILURES.** `envelopePrecheck` returns `null` on a throw, `null` is fail-OPEN for all three proactive pushes, and the memo key only moves on a new bar — so one transient KV hiccup froze "envelope clear" for up to ~4h, paging the user and burning Sonnet-5 auto-analyses on genuinely auto-FLAT bars. Only non-null verdicts are cached now (keeps the 1,440→~24 saving; failures self-heal next tick as before).
- **`notificationBiasAlignment`'s silent `catch { return 'neutral' }`** made a compute failure indistinguishable from a genuine Neutral read in the very field `/notify-debug` reports — the endpoint built because "silence looks identical whichever gate is closed". Now logs `[score] <SYM> bias alignment failed, degrading to neutral`.
- **A test that tested nothing:** `drops buckets below CAL_MIN_BUCKET_N` asserted `> 0.6` and passed identically with the filter deleted (0.6859 vs 0.6304). That value is the curve ceiling, so it is load-bearing — now pinned by equality against the unpolluted fit plus `curve[last].n === 382`.

### 2026-08-21c — Review hardening of the mandate: the JSON contract, the calibration ceiling, and the breakout entry-touch

Max-effort review of `30d7303` returned 15 findings; all fixed (528/528 green). The load-bearing ones, because each would have let the original failure recur:

- **The mandate never reached the machine-readable contract.** `prompt-system.json` still said "Emit a setup ONLY if a Viable risk-defined level exists … Otherwise empty array", so the model could satisfy the prose mandate with a conditional Entry/Stop/TP table AND legitimately emit `[]` — and `parseSetups` reads only the fenced JSON, so downstream saw NO SETUP: the same silence, now wearing a compliant-looking analysis. Both markets' JSON rule, the `## If You Take a Position` gate, and the stand-aside fallback now carry the window exception.
- **The 70 gate could go universe-wide unreachable** — first fix was itself wrong, see the 2026-08-22 entry below. (Original reasoning: `applyCalibration` clamps at the live curve's top bucket, which sat at ~69, so a hard 70 would silently kill both windows.)
- **Breakout conditionals false-fired the entry-touch** (`outcome-tracking.ts`). The PENDING path's test was direction-only (`isLong ? low <= entry : high >= entry`), so a mandated "on a 4H close above Y" LONG — entry ABOVE price — was marked entered by the first bar and then usually stopped out on drift, inserting a phantom LOSS into `trade_outcomes`. The ACTIVE path had it right all along; both now share one exported `entryReached()` helper so they cannot drift again. Pre-existing bug, promoted to load-bearing by a mandate that produces conditionals routinely.
- **Where forcing a setup would be wrong, the mandate now SUSPENDS rather than fires:** stocks 0-2d from earnings (the system prompt's earnings stand-aside was a direct contradiction), and `staleCount >= 2` (the missing feeds are exactly the ones that would close the window — losing enrichment made a forced entry MORE likely, on the blindest read). The MIXED window withholds its mandate tail under chase-HIGH or an unguarded stock-SHORT, since those protections are scoped to full alignment; and `treatment_long_confirm_FAIL` (a LONG-only check keyed off the daily bias) no longer auto-FLATs a MIXED bar. A `PRECEDENCE:` clause states how to resolve co-emitted counter-orders (BB_EXTREME, news conflict, regime caps): satisfy the mandate with the other side, a tighter trigger, or smaller size — never by ignoring the flag.
- **Scale hygiene + observability:** `SymbolPrediction.notifyProb` carries the calibrated value so nothing compares raw against a calibrated threshold again — this fixed the entry-zone push (was `raw < 0.55`, which permanently killed the push for setups born at calibrated 65-69, i.e. exactly the ones the lowered threshold creates; now `ENTRY_ZONE_ML_FLOOR = ML_THRESHOLD - 0.10`), the rising-edge log, `/notify-debug`'s self-contradictory `blockedBy`, and the push copy. `runFullAnalysisCore` now logs `[mandate-violation]` / `[mandate-ok]` when a window was active, distinguishing "model declined" from "prose table, empty JSON" — recurrence is greppable instead of needing another replay script.
- **Cost/noise, honestly:** the threshold comment's "the setup gate bounds pushes" claim was stale (2026-08-08c made a DECLINED analysis push). Now a decline BELOW the mandate band defers silently instead of pushing, so the widened 65-69 band buys analysis coverage without "nothing to do" notifications. The envelope precheck is memoized module-scope on `(symbol, 4H bar, ML)` and takes the pass-level calibration curve, ending ~1,440 redundant full prompt builds + synchronous 90-day D1 aggregates per in-band symbol per day.

### 2026-08-21b — Must-offer-entry rule: at high conviction, declining to construct a setup is no longer an allowed output (+ notify threshold 70→65)

Follow-up to the same incident after the user sharpened it: *"the ML was showing 80 but the app was saying stay put"* / *"that is not really protecting me"*. Replayed the REAL prompt builder over the rally with ML pinned at 80 (same method as 2026-07-24; enrichment-free, so a lower bound): **34/34 4H bars Aug 16→21 were envelope-CLEAN** — no chase guard, no mixed-bias FLAT, nothing mechanical said stay put. So at ML 80 the blocker was the LAST layer: the LLM's own discretionary read ("extended, wait for the retest" → NO SETUP), exactly the pattern the 2026-08-08c box-data investigation found (trigger fires → analysis declines → silence). The defensive philosophy held at every layer; when all gates opened, nothing REQUIRED the system to hand the user a trade.

- **`HIGH_CONVICTION_WINDOW` (prompt.ts, envelope else-branch):** when biases are ALIGNED, calibrated ML_WIN ≥ 70, and NO auto-FLAT reason is active, the prompt now emits a directive making a concrete setup MANDATORY — immediate entry at a valid level, otherwise a CONDITIONAL entry at a named pullback level/breakout trigger. "Extended" is required to become the entry CONDITION, not a reason to decline. The **`MIXED_HIGH_ML_WINDOW`** line (2026-07-06) gains the same mandate tail (structure-led, still capped MODERATE). `prompt-system.json` (both markets) reinforces: NO SETUP is not an acceptable output inside either window.
- **Notify threshold `ML_THRESHOLD` 0.70 → 0.65** — on the CALIBRATED scale the honest PAV map only exceeds 70 at raw ≥ ~79 (a few bars a month), while the live 60-70 band realizes ~66%. 65 looks at the band the forward data says is worth looking at; push volume + LLM cost stay bounded by the setup gate, the 3.5h `notif_claims` claim and the `autorun` guard. Note the auto-analyses triggered in the 65-69 band can still legitimately decline (the mandate starts at 70) — those send the "conditions favorable · no setup" push with the model's reason (2026-08-08c), which is the designed outcome.
- Fixture extended with the 1H leg; `test/high-conviction-window.test.ts` pins on the REAL tape: envelope CLEAN + `HIGH_CONVICTION_WINDOW` + "LONG setup is MANDATORY" at ML 80, absent at 55. 517/517 green. Worker-only — **needs a box redeploy**.

### 2026-08-21 — Missed 62k→80k rally diagnosed: TWO gates were closed — live calibration refit (PAV) + direction gate moved off the simplified scorer

User: *"crypto went up almost to 80K from 62-64 range and the app did not do anything… going up for 3 days straight."* Box verified current (`c05f3a8`) and cron healthy first — this was NOT a stale deploy. Measured the window (Kraken-independent this time: the box's own `/candles/crypto`, ATR(14) Wilder on 4H): **27 of 37 bars from Aug 14-20 were goodR bars**, with forward-24h favorable excursions of 5-20 ATR on Aug 18-19 — while BTC's raw ML read **39%** even at peak momentum. Two independent gates were closed the whole way; both fixed:

1. **Live calibration refit (executes step 2 of the 2026-08-14 ladder).** `/ml-calibration` (9,090 graded): predicted 25→77 realizing **41→69** — compressed but monotonic (one 1pp wiggle) → per the pre-declared rule this is **recalibrate**, not retrain. The 35/65 blend kept 35% of the stale raw scale, so raw 39% gated as ~52.9% when the live realized rate was ~60%. New `src/calibration.ts`: fine (5pp) prediction buckets from `ml_calibration` D1 (90d, **per market** — the old notify curve applied the crypto curve to stock symbols too) → weighted PAV monotone fit → piecewise-linear apply, clamped to the observed ends. Replaces the blend in ALL THREE consumers via the shared helpers (`fetchLiveCalBuckets` + `fetchMlCalibration` in index.ts): the envelope gate, the precheck, and the symbol pass's notify threshold. Self-updating — refit from D1 each use, so regime shifts are absorbed without retraining. Prompt's audited-bucket display line unchanged in shape.
2. **Direction gate moved onto the faithful scorer.** The cron gated direction on the simplified `computeScore` (scoring.ts), whose RSI>70 penalty (−3) outweighs crypto's price-position weight (+1) — so the harder a rally runs the more bearish it leans. Replayed on the real tape: it scored the +7% Aug 19 breakout day **BEARISH** (RSI 74) and the follow-through Neutral (RSI 84, score +3 vs threshold 4), while `/indicators` (scoring-ios) showed the user Bullish / Strong Bullish — alignment "conflict"/"neutral", `notificationDirection` = 0, gate closed for the entire move. New exported `notificationBiasAlignment` computes bias via `computeFullIndicators` (the scorer the app displays — agreement by construction; scoring-ios's RSI rule is regime-aware and reads high-RSI-in-uptrend as momentum, not fade). `computeScore` now has zero callers in index.ts (kept for its Candle type + any script use). Regression test pins the REAL captured Aug-2026 BTC tape (`test/fixtures/btc-rally-2026-08.json`): faithful → `aligned_bullish`, simplified → documented NOT-bullish on the same candles. `metaDirection` (meta-head conditioning) inherits the fix — and training's bias came from the Swift scorer, so this also removes a train/serve skew.

**Honest caveat, deliberately NOT changed here:** with the live top bucket realizing ~69%, an honest map cannot produce a calibrated value ≥ 70 — so the three 70-keyed gates (notify threshold, the `biases_MIXED` ML≥70 hatch, the counter-trend playbook) may be unreachable until the live curve's top improves or the thresholds are revisited. That is the honest read (the blend's 70+ passes were partly stale-scale artifacts). Threshold choice is a product decision — flagged as the open follow-up, not smuggled into a recalibration. NB the mixed-market curve above understates the per-market picture; the new `?market=` param on `/ml-calibration` shows the actual per-market fits post-deploy.

514/514 tests green (14 new: PAV fit/apply + the fixture regression). Worker-only — **needs a box redeploy**.

### 2026-08-14 — "Should we retrain?" — No: the notify gate was on RAW ML while the envelope used CALIBRATED (+ a July measurement error corrected)

User: *"we are routinely missing moves of a few thousand dollars for BTC — should we retrain?"* Measured before answering (120 days of BTC 4H, Kraken; ATR(14) Wilder on 4H, matching how the label's `atrFor4H` is derived):

| | |
|---|---|
| mean ATR(4H) | $757 |
| goodR24 base rate (≥1.5 ATR/24h) | **59.0%** |
| mean 24h excursion | $1,486 (2.02 ATR) |
| ≥$3,000 within 72h | 27.2% of bars — **77% of them had a goodR24 event** |
| ≥$2,000 within 72h | 62.8% of bars — 66% had one |
| h72t25 target (≥2.5 ATR/72h) | captures **97%** of ≥$3k/72h moves |

**So the target is NOT blind to these moves** — the "wrong horizon" hypothesis is dead. The moves are visible; the *gate* wasn't opening.

**⚠️ Correction to the 2026-07-24 entry.** That entry claimed realized goodR over the BTC window was **0/67, mean 0.66 ATR**, and concluded "the envelope was factually right — a low ML_WIN was accurate." That measurement used the **DAILY** ATR, while the label's `fwdMaxFavR` divides by `atrFor4H` (derived from `atrPercent`, which is the 4H ATR). Daily ATR runs ~3x the 4H ATR, so the threshold was ~3x too strict and the goodR count collapsed to zero. On the correct 4H basis the base rate is 59%, not 0%. **The part of that entry about the FRAMING hatch being unreachable stands** (that was a code-reachability finding, independent of this); the "ML was correct to read low" conclusion does not.

**Root cause found, and it is not the model.** `runFullAnalysisCore` and the envelope precheck have keyed on `calibratedMlWin` since 2026-07-02 — but the NOTIFY threshold was left on the raw `mlProb`. One quantity, two decisions, two different values. With the live curve compressed (the 30-50 bucket realising ~65%), raw systematically under-reads, so the envelope would judge a bar tradeable while the notification never fired. That is precisely "routinely missing moves". Fixed: the notify gate now applies the same 35/65 blend. The curve is fetched ONCE per cron (5 buckets, universe-wide) rather than per symbol, and `/notify-debug` now reports `ml` and `mlCalibrated` side by side so the correction is visible.

**Retrain verdict: not yet, and in this order.** (1) Ship this — it is a consistency bug, free, and directly targets the symptom. (2) Read the live curve via `/ml-calibration`; if it is compressed but still MONOTONIC the model ranks correctly and only its scale has drifted → **recalibrate** (isotonic refit on `ml_calibration`, hours not days, no feature work). (3) Only if the curve is non-monotonic — higher predictions realising *lower* rates — has the model genuinely decayed and earned a full retrain. Note the current 59% base rate versus v14's 50.5% training base rate is itself evidence of a regime shift that a recalibration absorbs cheaply.

500/500 green. Worker-only, needs a box redeploy.

### 2026-08-08c — Diagnosed from the box's own data: notify on FAVOURABLE CONDITIONS + fix a self-inflicted double trigger

Ended the guessing with SQL against `/mnt/WDRED/marketscope/marketscope.db`. What it showed:
- **Push token present, watchlist 11 symbols** on the active device — both prime suspects dead.
- **`notifications` has rows** (ADA/XRP/SOL `ml_crossing`, ~9 over 3 days, all to the ACTIVE device + live token). So the whole conjunction — ML≥70, decisive direction, clean envelope precheck, claim won — **was firing correctly all along**.
- **`tracked_setups` explains the silence:** eleven `flat / NO_SETUP` rows against four `setup` rows, and the BTC setups have no matching trigger row in the same window — so they came from MANUAL analyses, which had no push path at all before 88dad17. The cron's own enriched analyses produced essentially zero setups. Trigger fires → LLM declines → setup gate suppresses → silence. Working as designed; the design was the problem.

**Fix 1 — a self-inflicted double trigger (mine).** `deferAutoAnalysisCross` DELETED the `notif_claims` claim. The analysis takes 30-90s, the defer dropped the claim, and the next cron tick re-claimed and logged a SECOND trigger ~1 min after the first — visible as paired rows (ADA 18:00:42 + 18:02:08, SOL 18:00:16 + 18:01:09, ADA 21:32:34 + 21:33:24). It always stopped at two because the second attempt hit the 3.5h `autorun:<sym>` guard and returned without deferring. Harmless while no-setup analyses sent nothing — but it would have double-paged the moment fix 2 shipped. The claim is now HELD: it and the autorun guard are both 3.5h, so they lapse together and the next tick does a real retry, with the resuppress key keeping `wasSuppressed` true meanwhile so no fresh ML cross is needed. (Verified separately that the claim SQL itself is sound — `changes` correctly returns 0 on a held claim under better-sqlite3.)

**Fix 2 — notify on favourable conditions, carrying the reason.** When every precondition passes but the enriched analysis declines, the user is now told: `"BTC conditions favorable · no setup"` + the model's own Bottom Line. This DELIBERATELY reverses the 2026-07-14 "no setup → suppress silently" decision, with the thing that made those pushes useless fixed: the old ones said "ML 73%" and led nowhere, so they trained the user to ignore them; this one carries the REASON ("chase into extended trend", "waiting for a retest"), which is actionable. Two things also differ from July: the gate is far stricter now (ML≥70 AND unambiguous direction AND clean envelope, vs a bare ML crossing), and volume is bounded by the same 3.5h claim + guard — at most one per symbol per 3.5h. Without this the proactive path essentially never fires, since the cron produced ~0 setups in 3 days.

500/500 green. Worker-only — **needs a box redeploy** (still on `dcc3fab`, now 5 commits behind).

### 2026-08-08b — Notify trigger confirmed as ML≥70 AND unambiguous AND envelope-clean; added /notify-debug to end the guessing

User requirement, refined: *"notification when there are favorable conditions, but not only 70% — also no ambiguity, like the conditions the AI would use to create a setup"*, then clarified: *"we need ML 70 plus other factors."* So a CONJUNCTION, with ML≥70 necessary but not sufficient.

**That is already what the trigger does**, verified in code: `crossCandidate = mlProb >= ML_THRESHOLD && (crossed || wasSuppressed) && metaDirection !== 0`, then the envelope precheck gates it. And `metaDirection` is literally `notificationDirection(biasAlignment, dStochCross)` — the same union primitive the device pass uses, so the two direction gates agree (checked; they could have drifted). "No ambiguity" is covered twice over: the direction primitive returns 0 when bias and Stoch conflict, and the envelope's `auto_FLAT_active` list carries the rest (`biases_MIXED_and_ML_<70`, `ANY_KILLED`, `chase_into_extended_aligned_trend`, `macro_IMMINENT`, `ML_WIN_<50`) — the AI's own preconditions, by construction, since the precheck builds the REAL prompt.

**So the requirement was not the gap.** Something in the conjunction fails at runtime, and silence looks identical whichever of the five conditions is false — which is exactly why this took several rounds of hypothesis (deferral bug, edge-vs-level, notification location, live-price entry detection) without converging.

**Fix the observability, not another guess.** The symbol pass now records what each gate ACTUALLY decided per symbol per tick (`notify_debug:all` KV, 15-min TTL, one batched write per cron — same discipline as the other per-cron blobs), and new `GET /notify-debug?symbol=…` serves it joined with the per-device gates the symbol pass cannot see: push-token presence, the synced watchlist (the trigger loop iterates exactly this — an empty row means zero notifications regardless of signal quality), the `notif_claims` claim, and the `autorun:<sym>` guard. Each symbol gets **`blockedBy`** — the FIRST closed gate in evaluation order — or null when every gate is open. Recorded decisions, not a re-derivation, so it cannot disagree with what the cron did.

500/500 green. Worker-only, needs a box redeploy.

### 2026-08-08 — Entry-zone detection moved to LIVE price (a setup doesn't become actionable on a candle boundary)

User framing, which named the design flaw exactly: *"the app used to give notifications all the time, then we decided to do it every 4 hours if there is a valid setup — but a valid setup does not necessarily happen only at 4h close."*

**The flaw was real and measurable in the code.** The whole pipeline is closed-bar on purpose (ML features must match how the model was trained), and the entry-touch test inherited that: `fourHCandles` has the in-progress bar dropped, so `last4HHigh`/`last4HLow` describe the last CLOSED 4H bar. The symbol pass fetched no live price at all (zero `fetchLivePrice` calls in `computeSymbolPredictions`). Consequence: price entering your entry zone at 10:15 was invisible until the 12:00 close — up to ~4h late — and **entirely missed** if price left the zone before that close. "Is my entry reachable?" is a live-price question that was being answered with 4-hour-old data.

**Fix.** The symbol pass now fetches a live tick, but ONLY for symbols in `pendingSetupSymbols` (typically 0-3), so it costs a handful of ticks per cron rather than one per archive symbol. The touch test becomes a union: live price in the zone RIGHT NOW (detected within one cron tick, ~1 min) **OR** the last closed bar's extreme reached it (retained, so a touch that happened and reversed inside that bar is still caught). The push now quotes live price against the entry — `"LONG entry $64230.00 — price is $64251.10 now"` — since "is in range" is much more actionable when you can see where price actually sits.

`livePrice` is the ONE deliberately-current value on `SymbolPrediction`; everything else stays closed-bar for parity, and the comment at the field says so.

500/500 green. Worker-only, needs a box redeploy.

**Note on the two notification classes, which answer different questions:** *setup created* (2026-08-07) fires when an analysis produces a setup — necessarily on the analysis cadence, since a setup can't exist before one runs. *Entry zone reached* is the timely one, and is now live-driven. The analysis cadence itself is still bounded by the 3.5h autorun guard; tightening it is a pure cost dial.

### 2026-08-07 — Setup notifications now fire on SETUP CREATION, not on the ML-cross chain

User, after the box was confirmed running `dcc3fab` with the cron healthy and still receiving nothing: **"I want notification sent whenever the app creates a setup."** Taken literally, and it is the right design.

**The problem was the trigger's location.** The only setup push came from `runAutoAnalysis`, at the far end of a ten-link chain: push token → symbol in the synced watchlist → ML ≥ 70 → decisive direction primitive → envelope not flat → `notif_claims` won → `autorun:<sym>` guard free → analysis succeeds → setup produced → APNs delivers. Any single link breaking meant silence, and most of those links have nothing to do with whether a setup exists — ML ≥ 70 alone is ~6.3% of bars. A setup from a MANUAL analysis never notified at all, because that path isn't the cron's.

**Fix: notify from the choke point.** `runFullAnalysisCore` is what `/full-analysis`, `/full-analysis/async` and `runAutoAnalysis` all call, and `parseSetups` has already applied the geometry gate by then. New `notifySetupCreated` fires there whenever `setups.length > 0`, detached (`void`) so a slow APNs round-trip can't delay the analysis response. "A setup exists" is now the entire trigger; everything upstream only controls HOW OFTEN the server looks. The old `runAutoAnalysis` push was removed so cron-triggered setups don't double-page — that function keeps only its deferral bookkeeping.

**Dedupe is on setup IDENTITY, not time:** `symbol:direction:entry:stopLoss` (6 significant digits), 6h TTL. Re-running an analysis that yields the same setup stays silent; a genuinely different setup always pages. Title leads with direction and entry (`BTC LONG setup · entry 64230.00`), body is the Bottom Line.

Push inventory after this change — five sites, all distinct: async-job ready/failed (suppressed when the app claims the result), price alerts, **setup created (new)**, risk-state transition, entry-zone reached. 500/500 green. Worker-only, needs a box redeploy.

**Still unexplained:** which of the ten links was actually breaking before. The new trigger bypasses seven of them, so the answer is now mostly moot — but if pushes still don't arrive, the remaining suspects are narrow and checkable: no `push_token` on the device row, or APNs delivery itself. `[setup-notify]` log lines on the box name which one.

### 2026-08-06 — Setup notifications: trigger widened from a rising EDGE to a LEVEL (+ the deferral fix below)

Follow-up to the same report, after the user clarified: **the app does generate setups — the notification is late, or never arrives.** That rules out the gates being wrong and points at the trigger's *shape*.

`crossed` was a pure rising edge: `prevMl < 0.70 && mlProb >= 0.70`. Since `mlProb` only moves on a 4H close, an excursion above the threshold produced exactly **one** eligible tick. If ML crossed 70 and then sat there for a day, a setup that materialised six hours later — envelope clearing, a level coming into play — got no analysis and no push at all. Meanwhile the user could produce that same setup by hand any time, which is exactly the reported asymmetry. The trigger answered *"did volatility just jump?"*; the user needs *"does a setup exist now?"*.

Now `crossed = mlProb >= ML_THRESHOLD` — a level. Every tick at or above threshold is eligible; the rising edge is kept only for logging. **No new spam risk and no new cost ceiling**, because the two existing guards are untouched and already do the bounding: the 3.5h `notif_claims` claim per (push_token, symbol) and the 3.5h `autorun:<symbol>` KV guard inside `runAutoAnalysis`. Worst case remains ~one LLM run per symbol per 3.5h (~6.8/day/symbol). Crucially, since the 2026-07-14 setup gate the push only fires when the analysis actually yields a SETUP — so the setup gate, not the ML threshold, is what keeps notifications quiet. Widening the trigger buys coverage, not noise.

**Residual latency, stated honestly:** a setup appearing just after a run waits up to 3.5h for the next one. Tightening that is a pure cost dial (`NOTIFY_COOLDOWN_SEC` / the autorun guard). Separately, the analysis threshold could be decoupled from the notify threshold — analyse from ML ≥ 60 while still only pushing on a setup — which would widen coverage into the 60-70 band the v14 calibration says realises 64%. Both deferred as explicit cost decisions for the user.

### 2026-08-06 — "Not getting setup notifications": the auto-analysis deferral was destroyed one tick after it was armed

The 2026-07-24 defer-not-drop fix did not work. Traced tick by tick:
1. **Tick N** — ML cross, `notif_claims` claim taken, `runAutoAnalysis` runs, analysis yields no setup → `deferAutoAnalysisCross` releases the claim and sets `notif_resuppress:<sym>`.
2. **Tick N+1** — `wasSuppressed` true, envelope clear → `nextSuppressionState` returns `effectiveCross: true`, and the `else if (wasSuppressed)` branch called `clearSuppression()`, wiping **both** stores. The claim is re-taken, `runAutoAnalysis` is invoked — and hits its own 3.5h `autorun:<sym>` guard, set back at tick N. Silent early return: no push, and (by design) no re-defer.
3. **Tick N+2** — deferral gone, `crossed` false → nothing.

So the deferral lived exactly one tick, and that tick was *guaranteed* to be swallowed by the autorun guard. Net effect identical to before the fix — the cross dropped, one tick later — which is why setup notifications still went missing.

**Root cause: two different deferrals were sharing one clear condition.** The blob (`suppressedMap`) holds an ENVELOPE-precheck deferral, which the envelope clearing genuinely resolves because the push fires on that same tick. The key (`notif_resuppress:<sym>`) holds an AUTO-ANALYSIS deferral — "the enriched analysis produced no setup" — which only a *later* analysis producing one can resolve. The envelope clearing says nothing about it.

**Fix:** split the clear conditions. `clearBlobDeferral()` on envelope-clear (unchanged precheck semantics); `clearAllDeferrals()` only when ML fades below threshold; and `runAutoAnalysis` deletes the key after a push actually sends. The key otherwise persists on its 24h TTL. Now when the claim and the autorun guard both lapse at ~3.5h, the analysis genuinely re-runs and can page — the retry-every-3.5h-for-24h behaviour the original fix intended. Regression test added (12 in notify-precheck); 499/499 green.

**Caveat:** this is a verified logic defect, not a confirmed diagnosis of the user's silence — setup pushes are gated on ML≥70 crossing (~6.3% of bars) AND a decisive direction AND the envelope AND the analysis yielding a setup, so genuine quiet is also possible. `GET /notifications` and `GET /scores?symbol=` distinguish them.

### 2026-07-31 — Analysis pinned until replaced (the 1h cache guard was discarding it) + Now-tab visual pass

**"The latest analysis disappears; keep the latest one showing until a new one is run."** The Caches→Application Support move (earlier today) fixed eviction, but a second path was still wiping analyses: `loadCache` honors the disk cache only when `result.timestamp` — the DATA timestamp — is **under 1 hour old**. Return to a symbol after >1h and the cache read returns nil, `quickFetch` stores a placeholder with `claudeAnalysis: ""`, and `refreshIndicators` then faithfully carries that emptiness forward on every cycle. The analysis was safe on disk; the freshness guard just refused to read it. That guard is RIGHT for indicator data (hour-old candles must not render as current) and WRONG for the analysis, which stays valid-to-display until a newer one replaces it. Fix: new `loadCacheAnyAge` salvages `claudeAnalysis`/`tradeSetups`/`analysisTimestamp` regardless of data age; `quickFetch` merges them into its placeholder, and `refreshIndicators` falls back to the disk copy whenever memory holds an analysis-less placeholder. The staleness banner still tells the truth — the analysis keeps its own timestamp.

**Visual pass (verified by simulator screenshot):** `PriceHeaderView` now uses the shared `themedCard()` chrome (it was the last card on Now drawing its own ad-hoc 12pt background) and renders the 24h change as a `themedPill` so it reads as a sibling of the regime badge; `FavoritePillsView`'s ML numbers route through Theme (the raw `.green` was one of the last off-palette colours on the landing screen); and the **`LevelsChartView` now renders on the Now tab** under the indicators — filling the documented dead-space rough edge from the 2026-07-25 entry with the most useful thing available pre-analysis: where price sits vs S/R/VWAP/POC (no analysis needed; setup levels join automatically once one exists). Known cosmetic artifact, pre-existing: immediately after a cold start the Indicators chips can read "Daily Daily Daily" — that's the quickFetch placeholder (tf1 copied into all three slots) until the full refresh lands seconds later.

iOS-only — needs a rebuild+install.

### 2026-07-31 — Sub-dollar coins had no chart levels: 2dp rounding zeroed their ATR

User: "on ADA I still don't see any support or resistance levels — do I need to run analysis first?" No, and running one wouldn't have helped.

**Root cause.** `r2()` rounds every price-shaped value to 2 decimal places. Invisible on BTC, fatal below $1. Measured on real ADA candles (721 bars, price $0.1675): **ATR rounded to 0** (true value ~$0.0033), S/R snapped onto a 1-cent grid (~6% wide at that price), and EMA20 and EMA200 both landed on 0.17 — collapsing the trend structure entirely. A controlled test (real BTC candles rescaled, identical shape) shows the cliff: 5 supports / 3 resistances at $64k and at $64, down to 2/2 at $0.64, and at PEPE scale a single "support" at literally **$0**.

The zero ATR is what empties the chart: `WatchLevels.build` opens with `guard price > 0, atr > 0 else { return [] }`, which returns before setup levels are added — so an analysed sub-dollar coin showed no entry/stop/target lines either. Roughly a third of ARCHIVE_CRYPTO trades under $1 (ADA, DOGE, XLM, VET, HBAR, ZIL, RSR, IOST, SKL, GALA, SAND, GMT, JUP, PEPE…).

**Fix (the safe half).** New `rPrice()` in scoring-full.ts: at/above $1 it is byte-identical to `r2` (BTC/ETH/stock output and the prompt fixtures unchanged — verified), below $1 the grid follows the magnitude, holding ~6 significant digits. Applied in **indicators-full.ts only** — the display/prompt path, which is NOT covered by the 1e-7 ML parity suite (that tests `computeAllFeatures` in scoring-full.ts) — to S/R, Fibonacci, Bollinger, EMA20/50/200, MACD histogram and ATR. Explicitly NOT applied to scale-free values (RSI, ADX, Stoch, volumeRatio, atrPercent) where 2dp is already correct. ADA after: ATR 0 → 0.003258, 5 real supports, EMA20 ≠ EMA200. iOS `WatchLevels.build` also hardened — `??` only catches a nil ATR, never a zero one, so a zero now degrades to 1%-of-price instead of emptying the chart.

**Known limitation, deliberately not fixed here.** `scoring-full.ts` still rounds ATR/EMA/VWAP with `r2` on the **ML feature** path, so `dEmaCross`, `dStackBull/Bear`, `dAboveVwap` and VP bucket sizing remain degenerate for sub-dollar symbols. Training and serving round identically (that is what the parity suite guarantees), so there is no train/serve skew — those features simply carry no information for cheap coins. Changing it would shift the distribution v14 was trained on and needs a coordinated Swift change + fixture refresh + retrain: a v15 conversation. **Labels are safe** — `fwdMaxFavR` divides by `atrFor4H = (atrPercent / 100) * price`, and `atrPercent` is computed from the RAW ATR at 4dp and is scale-invariant.

499/499 worker tests green; iOS build green. Needs a box redeploy + iOS rebuild.

### 2026-07-31 — Analyses stopped vanishing (Caches → Application Support) + history reachable without an analysis

Two user reports, one cause each.

**"The latest analysis doesn't show after some time."** Both the per-symbol analysis cache (`AnalysisService.cacheDir`) and the analysis archive (`AnalysisHistoryStore.historyDir`) lived in `.cachesDirectory` — which iOS purges under storage pressure, silently and with no opt-out. That is the correct home for re-downloadable data and the wrong one for these: an LLM analysis cost real money, describes a bar that has already passed, and can never be reproduced. Both now use **Application Support** via a new `PersistentStore` helper, which also MOVES anything still present in the old Caches location on first access (one-shot, flagged per directory in UserDefaults) so nothing that survived the last purge is lost. `OutcomeTracker`'s server snapshot stays in Caches deliberately — it genuinely is regenerable from `GET /tracked-setups`.

**"To read historical analysis I have to rerun analysis to even enter the screen."** The "Analysis History" button sat inside `aiContent(result)` — i.e. inside the analysis screen — and the 2026-07-25 restructure made that screen reachable only through the verdict card's "Full read" link, which is gated on an analysis already existing. So with no analysis for the current bar there was no route to past analyses at all, and the only way in was to spend another LLM call. The archive is now a first-class action on `VerdictCard` itself, shown in every state including NOT ANALYSED — which is precisely when you want yesterday's read. The sheet is presented by the tab (via the existing `showHistory` binding) rather than by the card, because a sheet attached to a row inside a List can be dismissed by row recycling underneath it. Verified on the simulator in the no-analysis state.

iOS-only — needs a rebuild+install.

### 2026-07-25 — Stock 429s fixed: the /finnhub/* fan-out collapsed into the existing /market call

User: "on stocks I am often getting 429." Traced to the worker's own per-device gate, and stocks were hitting it ~2.5× faster than crypto **by construction**.

**The arithmetic.** Each stock enrichment cycle fired **five concurrent `/finnhub/*` requests** (recommendation/metric/earnings/news/insider) from `AnalysisService`, so a stock refresh cost ~7 worker requests (+ `/indicators`, `/ml-predict`) against crypto's 3 — crypto having been consolidated onto one `/market` call by the 2026-06-13 Phase E work. Worse, there were **TWO** such fan-outs: one in `refreshIndicators` and a second in `runFullAnalysis`, so "tap a stock, analyse it" cost ~12 requests. Against `checkRateLimit(global:<deviceId>, 60, 60)` that meant ~8 stocks touched in a minute produced a 429 storm on the stock path only.

**The aggravating detail:** the gate sits at `index.ts:787`, BEFORE endpoint routing. The worker caches those Finnhub responses for 1-24h, but a cache hit costs exactly the same budget as a miss — so the caching gave zero protection against the limit it was causing.

**Fix.** `fetchStockEnrichment` (enrichment.ts) already assembled all of this server-side; stocks were left on the on-device path back in June only because `/market`'s `stockInfo` was then a strict subset (no analyst/insider/news). 2026-07-02 added insider + news; this closes the last gap by fetching `/stock/recommendation` server-side (one extra CACHED call, parallel with the others) and taking `marketCap` from the Yahoo `price` module already fetched — no extra call for it. `StockInfo` gained `finnhubStrongBuy` + `marketCap`; `WorkerMarketService` gained a `stockFinnhub` field decoding that subset; both iOS fan-outs were replaced with reads from the single bundle, merged conservatively (nil keeps whatever Yahoo or the previous cycle provided, so a partial response can never blank good data). `marketBundle` is now fetched for BOTH markets rather than crypto-only. **Stock refresh: 7 worker requests → 3.** Yahoo fundamentals deliberately stay on the on-device path — Yahoo isn't geoblocked or worker-gated, so routing it through the box would ADD a request, not remove one.

**Also raised the global cap 60 → 300/min.** 60 was a Cloudflare-era number from when every request cost quota against the free Workers tier. The backend is a Node process on the user's own hardware, no per-request cost, no upstream cap, one user — the gate's only real job is stopping a runaway client loop, which 300 does equally well.

499/499 worker tests green; iOS build green. **Needs a box redeploy AND an iOS rebuild** — shipping only one leaves the app calling `/finnhub/*` endpoints (fine, just unfixed) or reading `stockFinnhub` fields the old worker doesn't send (fine, they decode as nil and the previous value carries forward). Neither half breaks the other.

### 2026-07-25 — UI pass: verdict-first landing screen, native TabView, semantic theme, Dynamic Type

The app's conclusion used to be three taps away. The screens were organised by DATA SOURCE (Overview / Chart / Market / Analysis / Alerts), so the landing screen opened with a symbol switcher and a data timestamp and never stated the answer — which is exactly how the "auto-FLAT for a week and it told me nothing" experience felt from the UI side. Reorganised around the question being asked, verified on a booted simulator (not just a green compile).

- **`VerdictCard` (new, `Views/VerdictCard.swift`) leads the Now tab.** Three states — `LONG/SHORT SETUP` (with Entry/Stop/TP1/TP2 in mono columns), `NO ENTRY EDGE`, `NOT ANALYSED` — plus the ML number labelled **"move %"** rather than a bare percentage, so a direction-agnostic gauge can't be misread as directional confidence. Under it, the model's own `## Bottom Line` (parsed out of the markdown; already ≤35 words by prompt construction, so no truncation), a staleness note when price has moved since the read, and two actions. Reports only what the app knows — parsed setup, ML, the written Bottom Line — nothing inferred.
- **Navigation: hand-rolled tab bar → native `TabView`.** The old `bottomTabBar` was an `HStack` of plain `Button`s, which silently gave up tab accessibility traits for VoiceOver, tap-active-tab-to-scroll-to-top, selection haptics, and correct safe-area/blur — and drove content through a `switch` that rebuilt each screen on every switch. Five destinations, each answering one question: **Now** (verdict, then price/indicators) · **Chart** · **Market** · **Record** · **Alerts**.
- **The full AI read is now PUSHED from the verdict card, not a peer tab** (`AnalysisDetailScreen` wraps the unchanged `AITabContent`). Right hierarchy — you land on the answer and drill into the reasoning — and it freed the fifth slot for Record without spilling into iOS's "More" tab.
- **`OutcomeDashboardView` promoted out of Settings into the Record tab.** 453 lines of win/loss, ML-calibration drift, per-trade debriefs and the overtrading nudge were reachable only via `SettingsView:159`. That's the app's honesty layer and its answer to "does this work?" — burying it sent the wrong signal.
- **`Utils/Theme.swift` (new) is the single source of truth for colour + type.** Replaced ~34 ad-hoc `Color.red/.green/.orange/.purple` uses (no shared definition, so the same idea was drawn differently in every card, and dark-mode contrast had to be fixed 34 times). Roles: `bullish` / `bearish` / `caution` / `danger` / `info` / `neutral`, each an ADAPTIVE light-dark pair — SwiftUI's stock `.green`/`.red` are tuned for light backgrounds and go muddy-to-glaring on dark, which matters since the app is used mostly dark. `forChange()` reads a genuine zero as neutral instead of green. `forBias()` keeps the Strong/plain tier visible via opacity. Existing `biasColor`/`biasColorSimple` in ViewHelpers now delegate, so every old call site inherited the palette untouched. Also `themedCard(accent:)` — one radius/padding/background plus an optional 3pt leading stripe that carries a card's verdict pre-attentively — and `themedPill(_:)`. **Regime deliberately does NOT borrow bullish/bearish** (it's a state, not a direction): trending→info, ranging→caution, transitioning→neutral, retiring an off-palette purple.
- **Dynamic Type fixed: 26 hardcoded `.font(.system(size:))` → text styles.** 11 sites were 8pt and 9 were 9pt — below the legible floor AND frozen for every user regardless of their accessibility setting, because a fixed `size:` never scales. `Theme.micro` is `.caption2.weight(.semibold)` (11pt base, scales). The four chart-internal labels stay fixed ON PURPOSE (they sit against fixed chart geometry and would overflow the plot at the larger accessibility sizes) but their floor was raised from 7-8pt to 9-10pt; the exemption is commented at each site.
- **Hierarchy:** `IndicatorTableView` now defaults **collapsed** (`indicators_expanded = false`) — with the verdict leading, the full indicator grid is evidence you open on purpose. `FavoritePillsView` went from 4 instances to 3: the pushed analysis screen inherits its symbol, and offering a symbol switcher on a detail screen invited you to change the very thing the screen is about. Record and Alerts opt out of the symbol-scoped chrome entirely (neither is symbol-scoped).

Verified by installing on a booted iPhone 16 Pro simulator and screenshotting — which is what caught the leftover purple regime badge and the harsh pure-red/green momentum pills that the build could not. **iOS-only; needs a rebuild+install.** Known rough edge left: on an un-analysed symbol the Now tab is sparse (the mini chart moved to the Chart tab in 2026-07-04 and the indicator grid now starts collapsed), so there's dead space below the fold until an analysis exists.

### 2026-07-24 — Known-Issues sweep: 5 of 8 closed (pending_setups retired, archive gate, APNs route, App Group/widget, schema drift); 3 assessed

Worked the "Known Remaining Issues" list. Five fixed, three left with an explicit verdict (the list above now records the reasoning, including one deliberate WON'T-DO). 499/499 worker tests green (5 new), iOS build green with the new entitlement.

- **`pending_setups` RETIRED.** It held a duplicate of `tracked_setups` rows, written by `registerTrackedSetups` for no reason but to keep the cron's entry-zone-touch push working after the 2026-07-09 cutover. That push now reads `tracked_setups` directly (`kind='setup' AND state='pending' AND terminal=0 AND is_crypto=1 AND atr>0` — the filters mirror the old glue write EXACTLY, so the notification's scope is unchanged and stock conditionals stay excluded; widening it would be a product decision, not a cleanup). Removed: the glue write, the two lazy `CREATE TABLE`s, the `DELETE`-glue-on-terminal pass in `resolveTrackedSetups`, and the three `/pending-setups` POST/GET/DELETE handlers (grep-verified that no iOS or web client calls them — `WorkerPendingSetupService` was deleted 2026-07-09). Expiry needs no handling now: `stepSetup` terminalizes a pending row at the 12h window, so the query can't return a stale one. The "already notified" flag moved from the table column to KV (`entryzone:<rowId>`, 24h TTL) so no live schema change was needed — and the 2026-07-11 envelope-defer semantics are preserved (an envelope-flat touch still doesn't set the marker, so it re-fires when the envelope clears in-zone). The deployed table and its rows are left in place, unread; `DROP TABLE pending_setups;` when you're satisfied. **Known one-time edge:** a setup already notified *and* still in-zone at deploy time can page once more, since its old `notified=1` doesn't carry into KV — 12h window, one duplicate push, judged not worth transitional code for a table being deleted.
- **Derivatives archive over-writing FIXED.** The 3.5h gate lived solely in the `deriv_archive:all` KV blob, so an eviction (or an overlapping cron reading a blob the other pass hadn't flushed) reset every symbol to "never archived" — ~9 writes/day/symbol against an intended 6.85. New exported `mergeDerivArchiveGate()` seeds the gate from D1 (`SELECT symbol, MAX(timestamp) … GROUP BY symbol`), i.e. from the thing being gated, which can't disagree with itself; KV stays a fast path and we take the LATER of the two, so an evicted blob degrades to "ask D1" rather than "re-archive everything". Verified the query is a COVERING INDEX scan on `idx_deriv_lookup` (~10ms over 122k rows). NB the unit trap it guards: D1 stores `timestamp` in SECONDS, the KV blob in ms — 5 unit tests pin the conversion, since a raw seconds value compared against ms reads as 1970 and silently never gates.
- **APNs double round-trip FIXED.** `sendAPNs` always tried sandbox then production, so every push to a prod token paid a guaranteed wasted hop before the real one (in series, on the notification path). Now the winning endpoint is cached per token (`apns_env:<token>`, 90d) and tried first. Safe because a token belongs to exactly one environment and can't migrate — the APNs token is derived per `aps-environment`, so a debug→release rebuild yields a different token and therefore a different cache key, making a stale-wrong entry unreachable. The full fallback loop is retained, so a cache miss/eviction just costs the old behaviour; the write only happens on change, not per push. Uncached tokens keep the original sandbox-first order.
- **App Group / blank widget FIXED — and it was worse than the one-line issue implied.** The widget has always declared `group.com.ludikure.CryptoLens` and read `widget_data` from it (`MarketScopeWidget.swift:42`), but the main app neither declared the group **nor ever wrote that key** — grep-confirmed zero writers, so the widget was permanently blank and the entitlement alone would have fixed nothing. Added the group to the main target in `project.yml` **plus** the missing writer: `Utils/WidgetDataWriter.swift` publishes the favorites snapshot (symbol/ticker/price/bias/change24h/timestamp, mirroring the widget's private `SharedAsset` decoder), called at the end of `prefetchFavorites` after both passes so it ships real prices. Skips symbols with no cached result rather than writing zeroes, caps at 6, and no-ops on a byte-identical payload (WidgetKit rations timeline reloads). Signing risk checked BEFORE editing: the group is already registered in the portal and present in both the dev and store profiles for `com.ludikure.CryptoLens`, so the entitlement is a no-op for provisioning — confirmed by a green build.
- **Schema drift CLOSED** — `migrations/007_schema_drift.sql` adds the four `derivatives_history.large_*` columns; the `trade_outcomes.prompt_version` ALTER went into **006** rather than 007 because migrations apply in filename order and 006 indexes that column — replaying the directory into an empty DB proved a fresh bootstrap failed at 006 with `no such column`. Verified end-to-end: all 7 files now apply cleanly to an empty database and every INSERT the worker performs (derivatives_history 16-col, trade_outcomes with prompt_version, pending_setups) succeeds. `pending_setups` is deliberately NOT created by 007 — it was retired in this same change. **There is no migration runner** (nothing in `server/` applies these; they're run by hand), so on an already-deployed DB the ALTERs fail with `duplicate column name`, which is expected and documented in both files' headers.

**Assessed, not fixed** (full reasoning in the Known Remaining Issues list): **cert pinning** is now a documented WON'T-DO — the box serves a 90-day Google Trust Services cert via the cloudflared tunnel, so leaf pinning would brick installs at each silent auto-renewal and CA pinning still breaks when Cloudflare switches issuer; the protected asset is a device token to a single-user backend already on public-CA TLS. **Parity fixtures** need the DEBUG capture button on a simulator (not automatable) and a stale capture date doesn't weaken the 1e-7 assertion anyway, since parity is computed from each fixture's own slices. **Backtester regen speed** is genuinely open but wants a dedicated session — its only honest validation is a full multi-hour regen.

### 2026-07-24 — Code-review pass: a dropped ML cross (defer-not-drop, part 2), FLAT graded at the wrong horizon, and the auto-analysis cache wired up

Targeted review of the newest worker paths (notification gating, auto-analysis, outcome resolution). Three real bugs found and fixed; two hypotheses investigated and killed. 493/493 tests green (5 new), iOS build green.

**1. HIGH — a real ML cross was silently DROPPED when the enriched analysis produced no setup.** `processDeviceNotifications` takes the atomic `notif_claims` claim (3.5h) as a *precondition* of queueing a push, and `crossed` is a strict single-tick rising edge (`prevMl < 0.70 && mlProb >= 0.70`). `runAutoAnalysis` then returned silently in three cases — no setup, analysis failed, exception — with the claim already burned and the rising edge gone. The 2026-07-11 defer machinery couldn't help: `suppressedMap` is written only from the *precheck's* `envelopeFlat` verdict, and nothing rolls back a claim (verified: `notif_claims` is only deleted on device deletion / stale-token cleanup). Net effect: the precheck defers correctly, and the later enrichment-aware gate — the one that sees the auto-FLAT contributors the precheck structurally cannot, which is *why* the precheck "can only UNDER-suppress" — dropped the signal instead. Exactly the 2026-05-30 notify-window failure, reintroduced one stage later. **Fix:** new exported `deferAutoAnalysisCross(env, pushToken, symbol, why)` releases the claim and re-arms suppression via a PER-SYMBOL key (`notif_resuppress:<sym>`, `SUPPRESS_EXPIRY_SEC`) — per-symbol because this runs DETACHED and read-modify-write on the shared `notif_suppressed:all` blob would race the symbol pass that owns it. The symbol pass adopts the key into `suppressedMap` (guarded by the ML/direction preconditions so it costs one extra KV read only for symbols that could page), and both clear paths now drop BOTH stores or a leftover key would resurrect the cross forever. The `autorun:<sym>` guard still bounds LLM cost to one real run per symbol per 3.5h; the guard's own early return deliberately does NOT defer (a concurrent invocation owns that window). Two stale comments promising a "bare move-likelihood push on failure" — removed 2026-07-14 — corrected. New `SUPPRESS_EXPIRY_SEC` constant replaces the hardcoded 24h in three places.

**2. MEDIUM — FLAT outcomes were graded at resolution time, not at the +24h horizon.** `stepFlat` took `points[points.length - 1]`, and `resolveTrackedSetups` always appends the live tick last (`time: now`). The horizon check is a lower bound only and the open-row query has no age filter, so any late resolution — a Stop/Start deploy, box downtime — regraded every FLAT whose window elapsed during it against the CURRENT price. A FLAT that was +0.8% at +24h (`flat_true`) but +4% two days later got recorded `flat_false`, biasing the false-flat rate the dashboard and the prompt's outcome history read. **Fix:** grade at the first point at/after `registeredAt + FLAT_HORIZON_MS`, falling back to the newest. The right bar is normally present — the candle window spans `oldestChecked - 30min` → now, so it brackets the horizon after downtime.

**3. LOW — `autoanalysis:<symbol>` was written but unreadable.** Cached since 2026-07-14 with no endpoint and no reader (grep-confirmed: the write was the only reference), so tapping the push re-ran the whole LLM analysis — the exact double-spend the cache exists to prevent. **Fix:** new `GET /auto-analysis?symbol=` (auth-gated, same shape as `/full-analysis` plus `at`, 404 when empty) + iOS `WorkerFullAnalysisService.cachedAutoAnalysis` consulted in `runJob` before starting a new job (never when resuming a pending one). Accepted only if fresh (≤20 min, inside one 4H bar) and not already shown; consumption tracked LOCALLY (`autoanalysis_seen_<SYM>`) rather than by deleting server-side, so a decode failure can't destroy the result and a manual re-run still gets a genuinely fresh analysis. Fully best-effort — any failure falls through to the previous behavior. Closes follow-up (a) from the 2026-07-14 auto-analysis entry.

**Investigated and cleared** (recorded so they aren't re-investigated): (a) *seconds/ms mixing in `derivatives_history`* — the cron writes seconds and the `/debug/backfill-derivatives` endpoint looked like it wrote Binance's raw ms, but `get()` normalizes to seconds (`// sec`); confirmed against the archive, 122,287 rows all seconds-scale, zero ms. (b) *immortal pending rows* — a `pending` row with a null `pending_expires_at` would never terminate; impossible, state and expiry come from the same ternary. Also re-verified both `tracked_setups` INSERT bind lists (24 placeholders + literal `0` against 25 columns) and that the `server/kv-adapter.ts` contract (text-only `get`, no `list`, no absolute `expiration`) still holds across `src/`. Two `stepSetup` behaviors judged inherent rather than buggy: same-bar BE activation followed by the BE stop on that bar's low, and skipping excursion/TP checks on the entry bar — both intra-bar ordering ambiguities 15m klines can't resolve.

**Scope caveat:** targeted pass over the newest worker code, NOT the Swift app or `scoring-full.ts`.

### 2026-07-24 — "Auto-FLAT all week" diagnosed: the FRAMING hatch was unreachable; 72h model was being discounted on stale grounds

User report: BTC ran 62.3k → 67k → 64.1k over ~10 days at one point showing ML > 70, and the app was auto-FLAT throughout. **Investigated by replaying the real `buildUserPrompt` over all 73 4H bars of the move** (scratchpad script; Kraken XBTUSDT because Binance is 451 off-box — closes matched the box's Binance feed to within 0.03% on all 90 overlapping bars; ML_WIN stubbed per run to isolate the envelope from the model; no enrichment, so like `envelopePrecheck` it can only under-report FLAT reasons). Findings:
- **A cliff at ML 70, not a gradient.** ML<70 → **70/73 bars auto-FLAT (96%)**, 63 of them on `biases_MIXED_and_ML_<70`. ML≥70 → **7/73 (10%)**, chase guard only. Daily bias never turned Bullish through the whole +7.5% advance (Bearish → Neutral while 4H read Strong Bullish), so alignment read MIXED nearly the entire way up. Environment Risk was ELEVATED on all 73 bars.
- **The envelope was not miscalibrated.** Realized goodR over the window was **0/67 bars** — mean 24h max excursion **0.66 ATR**, not a single ≥1.5-ATR 24h move. The 7.5% advance was a slow grind, so a low ML_WIN was *accurate*. What the user experienced is a horizon mismatch (ML_WIN gauges a 24h burst; they trade multi-day), not a broken gate.
- **The chase guard is working — do not touch it.** All 7 of its FLATs fired 07-13/14 blocking a SHORT into the 62.3k low; 5/7 correct (price rallied 3.2-4.3% in 24h). n=7.

**Shipped (worker-only, 488/488 tests green, needs a box redeploy):**
1. **The `FRAMING:` escape hatch is now reachable.** `prompt.ts` gated it on `autoFlat.length === 1 && autoFlat[0].startsWith('ML_WIN_')` — so it could never fire on `biases_MIXED_and_ML_<70`, by far the most common FLAT reason. Result: a bare "NO SETUP" every bar for a week with none of the honest context the line exists to give. Now fires when **every** reason is a quality-gate reason (`ML_WIN_*` or `biases_MIXED_and_ML_*`); hazard reasons (ANY_KILLED, macro_IMMINENT, divergence_escalated, chase_into_extended_aligned_trend) still suppress it, since "the trend is intact, riding it is your call" is dangerous there. `biases_MIXED_(ML_unavailable)` deliberately excluded — with no ML value we can't characterise move likelihood. A **separate mixed-bias message** avoids the original's "unlikely here" claim (ML 50-70 realizes 56-64% per the live calibration — calling that unlikely would be false) and names the mechanic: *a daily bias lagging a running 4H move is the ordinary EARLY-trend state, not a stalled tape*. Verified on the real bars: **64 of the 71 previously-silent FLATs now carry the framing; the 7 chase bars stay bare** — exactly the intended split. Still a hard FLAT — the hatch reframes, never authorizes.
2. **Stopped discounting the retrained 72h model.** Both `prompt-system.json` market prompts described `ML Persistence` as *"(Not retrained on fresh data — treat as soft.)"* — **stale**: h72t25 was retrained on clean data 2026-06-05 and again for v14 2026-07-06 (monotone reliability, crypto top bucket 75.5% / stock 78.1%). So the prompt was discounting the one model whose 72h horizon matches a multi-day hold — the exact blind spot behind this complaint. Replaced with an accurate note that flags it as the horizon ML_WIN's 24h window cannot see.

**NOT shipped — pre-declared test instead:** the `biases_MIXED` gate at 70 sits ~9pp **above** the 61% base rate of the non-aligned cell it was introduced (2026-07-06) to unlock, and ML≥70 covers only **6.3%** of crypto bars (v14 table: 9,136/145,045), so the cell is unlocked in principle and locked in practice. Since `ML_WIN<50` is already its own FLAT, the rule's only marginal effect is blocking the **50-70 band** — which realizes 55.9%/64.1%, at or above the cell's own average. Four variants (gate→60, gate→55, demote-to-MODERATE-cap, control) with a declared ship bar are written up in `docs/research/strategy-mixed-gate.md`. **Honest caveat recorded there:** with goodR 0/67 last week, loosening the gate would NOT have produced a profitable trade — this is a correctness argument, not a measured edge.

**Open question:** the replay says at ML≥70 the envelope was NOT FLAT for 90% of bars (capped MODERATE at the 66.7k top), so if ML really was >70 at the peak, something my enrichment-free replay can't see (a kill condition) must have flatted it. `GET /scores?symbol=BTCUSDT` (authed) settles which reason actually fired on the live runs.

### 2026-07-14 — Void phantom-loss from the invalid-geometry setup + Finnhub misconfig made diagnosable

Two user-reported items. **(1) The invalid-SL SHORT was counted as a loss.** The setup with stop $62,958 BELOW its $63,732 entry (reported earlier, now blocked at registration by `isValidSetupGeometry`) had already been registered before that guard shipped — and because the wrong-side stop is breached at registration, the state machine recorded an INSTANT phantom "loss" even though the entry condition never fired, polluting the win/loss stats. New `voidInvalidGeometrySetups(env)` in `outcome-tracking.ts` (called once from the cron before `resolveTrackedSetups`, KV-gated `geometry_void_v1_done`, idempotent, fault-isolated): scans `tracked_setups`, and for any row failing `isValidSetupGeometry` marks it `state='invalidated' outcome='invalid_geometry'` (a NON-counted state → drops out of the track record) and DELETEs its linked `trade_outcomes` row (the phantom loss). Valid real losses untouched. 1 new test (in-memory D1: voids the bad SHORT + deletes its trade_outcomes row, leaves a valid SHORT loss alone, sets the flag, idempotent). **(2) Finnhub badge red.** `/finnhub/*` returns 503 "Finnhub not configured" when `FINNHUB_API_KEY` is unset on the box (a likely casualty of the Cloudflare→box secret migration), and iOS renders any non-2xx as the red `.error` state. `/health` now also returns `providers: { finnhub: bool }` (presence only, never the value) so a missing-secret misconfig is diagnosable remotely without auth — and `/health?probe=finnhub` pings EVERY endpoint FinnhubProvider calls (recommendation/metric/earnings/news/insider + market-status) for a sample stock and returns each upstream status, so a *sticky-red badge while market-status is 200* pinpoints the culprit (premium 403 on `insider`/`earnings`, or 429). **iOS badge fix (2026-07-14b):** `FinnhubProvider.fetchEndpoint` no longer flips the whole provider badge to `.error` on a 4xx (403 premium / 404 / 429) — only a 5xx or connectivity failure is a real outage; a 4xx leaves the badge as-is so a sibling call's `.ok` stands (the badge was stuck red because `insider`/`earnings` 403 on the free key while recommendation/news/market-status returned 200) — red badge + `finnhub:false` = set the key in the box env and restart. Finnhub only powers stock market-status/analyst/earnings/news, so it's cosmetic for crypto and Yahoo-covered for stocks. 486/486 green; worker-only — needs a box redeploy.

### 2026-07-14 — Rejection-at-a-level → short-horizon direction: tested, REJECTED (graveyard)

User asked whether a confirmed rejection at a major S/R level predicts tradeable 3-4 bar direction (never measured — `level_validation.py` only measured the hold-vs-break RATE, not execution EV). Built `ml-training/level_rejection_direction.py` on the same validated swing-level detection: at each bar, a major level poked by the wick and closed back away by ≥REJECT_ATR = a confirmed rejection → enter the continuation (resistance→SHORT / support→LONG), stop beyond the wick, measure forward 3-4 bars + a full fee cost-curve + walk-forward folds incl. 2022. **Result: coin flip.** Continuation hit-rate 50.1-50.4% both markets/horizons (loose 740k/207k events AND strict-wick 300k/80k); crypto support→LONG +1.8pp is just the known upward drift while resistance→SHORT is −1 to −1.7pp (worse than base); gross EV +0.005..+0.059% crypto / ~0 stock → break-even round-trip ≤0.06%, below Binance ~0.10%; WF 0-2/6 positive folds, negative every year. Fully consistent with the S/R subsystem finding (`strategy-levels.md`): a level is a real REACTION location (+4.3pp hold) but carries **no tradeable directional EV** — a location, not a direction signal. Filed in `docs/research/rejected-hypotheses.md`; the "observed event not a prediction" framing did not rescue it (unlike trend-continuation, this one genuinely wasn't in the graveyard — now it is). No code/product change.

### 2026-07-14 — Notifications gated on an actual SETUP (fix "notification → no setup")

User still got paged into no-setup analyses (e.g. "BTC 65 ML +4"). Two independent sources, both fixed:
- **Server auto-analysis push** (`runAutoAnalysis`, `src/index.ts`): it ran the enriched analysis but pushed even when it produced ZERO setups (just retitled to "big move likely"). Now the real analysis result is the ground-truth gate — **no setup → suppress the push silently** (result still cached; envelope auto-FLAT under enrichment / no clean level / a geometry-dropped setup all correctly suppress). Errors suppress too; the bare "big move likely" fallback push is gone. The push title now leads with the setup direction.
- **iOS-local ML-threshold notification** (the "BTC 65 ML +4" one): `AnalysisService` fired `BiasNotificationManager.sendScoreAlert` when `mlWinProbability` crossed **0.60** with a "Daily score: +N. Tap to analyze setup" alert — analyzing at ML 60-69 is below the 70 conviction gate and usually auto-FLATs, so it trained the user to chase notifications that led nowhere. REMOVED: the ML-threshold block in `AnalysisService`, `sendScoreAlert` in `BiasNotificationManager`, and the "Score Threshold Alerts" Settings toggle (`notify_score_threshold`). The setup-gated server push supersedes it. Bias-flip notification (`notify_bias_flips`) kept — it's opt-in and informational, not a "go analyze" nudge. 486/486 worker tests green; iOS build green. Server needs a box redeploy; iOS needs a rebuild.

### 2026-07-14 — Automated analysis runs on favorable ML crosses (worker v1)

User-requested: auto-run the full analysis when the indicator+ML picture is favorable, instead of pinging the user to open the app and spend a call. Reuses the existing notification gate as the trigger (ML rising-edge ≥70 + decisive direction primitive + envelope not auto-FLAT + 3.5h cooldown) — which already fires at the 4H close (optimal timing) and is sparse (~a few/day). New `runAutoAnalysis` (`src/index.ts`): on a survived cross, runs `runFullAnalysisCore` (the same pipeline `/full-analysis` uses) DETACHED (`void`, no await — the box is a persistent Node process so the 30-90s LLM call outlives the cron pass; awaiting would stall the minute cron), then pushes the parsed **Bottom Line** (replacing the bare "ML 73%" push, per the user's "replace" choice), auto-registers setups into `tracked_setups`, and caches the result to `autoanalysis:<symbol>` KV (1h) for an iOS pickup fast-follow. Fixed to **Sonnet 5 + extended thinking** (the user's standing pick; auto-runs don't receive the app's per-request model — option (a): if the user switches models we add `/watchlist` model-pref sync). Scope = synced watchlist/favorites (`for (symbol of watchlist)`). Cost guard: 3.5h `notif_claims` cooldown + per-symbol `autorun:<sym>` KV guard (cooldown TTL) → ~1 LLM run/symbol/3.5h; fully fault-isolated with a bare-push fallback so a cross is never silently lost. The old grouped multi-symbol push is replaced by one richer push per symbol. 485/485 tests green; worker-only — needs a box redeploy. **Follow-ups:** (a) iOS reads `autoanalysis:<symbol>` on open so the analysis appears instantly instead of re-running; (b) model-pref sync if the user ever changes models.

### 2026-07-14 — Forming-bar wick reconstructed from the finer timeframe (iOS chart)

User: "4H last bar makes no sense — 1H clearly went down but 4H only shows going up." Two things: (a) directionally there's no contradiction — the 4H forming bar is net-up over its whole 4-hour window while the 1H's *last hour* pulled back off a spike; (b) the real defect — the synthesized forming bar's WICK was fake. The worker serves CLOSED bars only (indicator parity), so `WorkerIndicatorsService` fabricates the in-progress bar as `open=lastClose, high=max(open,live), low=min(open,live), close=live` — which MISSES any intrabar spike/dip: a 4H bar that ran to 64.2k then fell back drew as a clean wickless green body even though the 1H plainly showed the spike. Fix: `get()` already has all three timeframes, so each coarse TF's forming bar now reconstructs its true high/low (and volume) from the finer TF's CLOSED bars in the same bucket — Daily from 4H, 4H from 1H (1H is finest fetched → keeps the open/live approximation, a 1h window is minor). `toIndicatorResult(priceOverride:subCandles:)` gained the sub-bar param; the bucket window keys off the forming bar's actual open time `t` (not a UTC floor) so it aligns for crypto (UTC) and stocks (worker 4H is ET-session-aggregated). Display-only — indicator/ML math untouched (still closed-bar server-side); self-corrects at bar close regardless. iOS build green; iOS-only, needs a rebuild+install.

### 2026-07-14 — Setup geometry gate: reject directionally-invalid stops (worker)

User caught a SHORT setup whose stop ($62,958) was BELOW its entry ($63,732) — on the same side as the targets, i.e. the stop sat in profit territory (unsizable: risk-per-unit points the wrong way; would mis-register in the outcome tracker). Root cause: `decodeSetups` (`src/prompt.ts`) validated field TYPES but never GEOMETRY. Two-part fix: (1) **defense** — new exported `isValidSetupGeometry` + a filter in `decodeSetups` drops any setup where the stop isn't on the losing side of entry and every target on the winning side (LONG: stop < entry < tp1/tp2; SHORT: stop > entry > tp1/tp2), logging `[setup] dropped invalid ...` so we can see the LLM's error rate. Better to show no setup than a broken one. Since parseSetups is the single choke point for the sync + async analysis AND tracked-setup registration, this protects the card, the PositionSizer, alerts, and outcome tracking at once. (2) **prevention** — added an explicit STOP GEOMETRY invariant to the "Present an Entry / Stop / TP1 / TP2 table" instruction in both crypto + stock `prompt-system.json` ("a SHORT stop must be a HIGHER price than entry … never place the stop on the same side as the targets") so the LLM stops emitting them (also fixes the residual bad table in the prose). 7 new tests incl. the exact reported case; 485/485 green. Worker-only — needs a box redeploy.

### 2026-07-13 — Outcome dashboard: drop the retired direction-model + A/B prompt-version sections (iOS)

User-requested ("I don't need a reference to directional model" / "Nor A/B prompt version"). `OutcomeDashboardView` no longer renders the "Direction Model — RETIRED (historical)" section, its "By Instrument — Live (crypto)" companion, or the "A/B: Prompt Version (30d)" section. Removed the `directionReport`/`versionComparison` @State, their `.task`/`.refreshable` fetches (`DirectionAccuracyService.fetch()`, `OutcomeTracker.versionStats()`), and the now-exclusive helpers (`directionSection`/`sideRow`/`directionBySymbolSection`/`pctStr` + the entire A/B helper block `hasABData`/`abSection`/`abMetricRow`×2/`pairText`/`percentText`/`rrText`/`rateColor`/`ABVerdict`/`significanceVerdict`). `statRow`/`reasonLabel` kept (still used by the setup-performance + calibration sections). **`CryptoLens/Services/DirectionAccuracyService.swift` DELETED** (orphaned on iOS after removal — only self-referenced; it hit the retracted `/direction-accuracy` endpoint) + xcodegen regenerated. The worker `/direction-accuracy` + `/ml-calibration` endpoints and `direction_signals` D1 are untouched (server-side, still logging for the record). `OutcomeTracker.versionStats()`/`VersionStats` are now unused internally but left in place — the `baseline/treatmentPromptVersion` constants there remain the stamping registry. The live ML-calibration section (ML quality drift) stays — it's not the direction model. iOS build green; iOS-only, needs a rebuild+install.

### 2026-07-13 — Position sizing in Coinbase nano contracts + real account defaults (iOS)

User trades Coinbase Derivatives **nano BTC/ETH perps** (screenshot: 80 nano BTC contracts, $49,844 notional @ $62,305 → 0.01 BTC/contract confirmed). `PositionSizer` now rounds the risk-based ideal quantity to WHOLE contracts for symbols with a `ContractSpec` (nano BTC = 0.01 BTC, nano ETH = 0.1 ETH; keyed on base asset, other symbols keep raw-unit sizing) and recomputes REALIZED risk/notional/leverage from the rounded count — `PositionSizing` gained `contractSpec`/`contracts`. `PositionSizeCard` leads with "N contracts (nano BTC · 0.01 BTC/contract = X BTC)"; the calculator adds a Contracts row; Settings explains the contract mapping. This is NOT the old manual `contractSize` field (removed 2026-07-09, zero readers) — it's automatic per-symbol contract math. Risk-setting defaults updated to the user's real account: **accountSize 25000→28000, max_leverage 3.0→3.5×** (registration in CryptoLensApp + every @AppStorage/initialValue fallback in Settings/Card/Calculator); riskPercent stays 2%. Verified: $28k @ 2% with a ~$700 BTC stop → 81 nano contracts (≈ the 80 traded). NOTE the app's leverage metric is notional÷**account-equity** (~1.8–2.1× here), deliberately more conservative than the broker's notional÷**posted-margin** (3.3× in the screenshot) — same position, different denominator. iOS build green; iOS-only (no worker change) — needs a rebuild+install.

### 2026-07-11 — Notification envelope precheck: don't page the user into an auto-FLAT analysis

User-requested: "if the condition is going to auto-FLAT there is no reason to notify me." The ML≥70 rising-edge often paged into an analysis the Conviction Envelope immediately auto-FLATted (chase into an extended trend being the most common). Fix (`src/index.ts`): on a would-notify cross (ML ≥ threshold, direction primitive ≠ 0), the symbol pass builds the REAL prompt from its own candles (`envelopePrecheck` — computeFullIndicators ×3 + `buildUserPrompt`, read-only: newState discarded) and parses `auto_FLAT_active:` (`parseAutoFlatReasons`). Flat → cross suppressed; per the 2026-05-30 lesson (the old notify-window silently DROPPED off-window crosses and lost most signals) suppression DEFERS: the pending cross re-checks every tick and fires when the envelope clears with ML still elevated (`nextSuppressionState`, KV `notif_suppressed:all`, 24h expiry), cancels silently when ML fades. Fail-open on precheck errors; enrichment-free build means it can only under-suppress. `fetchMlCalibration` extracted from `runFullAnalysisCore` so the precheck's calibrated-ML gate is byte-identical to the analysis's. 8 new tests (parse against real buildUserPrompt output + the suppression truth table); 478/478 green. Requires a box redeploy. **Follow-up (same date, user still paged into auto-FLATs):** the precheck only gated the ML-cross push — TWO more proactive push types were ungated: the risk-state transition push (COMPRESSION fires in exactly the coiled/extended tape the envelope FLATs) and the entry-zone-reached push. One `pred.envelopeFlat` verdict per symbol/tick now gates all three (risk-state: dropped outright, FYI push; entry-zone: deferred — `notified` stays 0 so it re-fires when the envelope clears in-zone). Also: `/health` now reports the running commit (`build`, GIT_SHA build-arg) — deploys were previously unverifiable remotely, and a stale box silently runs old gating. Residual honesty: a push validated at cross-time can still open into an auto-FLAT analysis HOURS later if conditions changed in between — inherent to push latency, not fixable by gating.

### 2026-07-10 — Liquidation-event collector (websocket) + order-book depth snapshots — the non-backfillable series

New `server/liquidations.ts`: a persistent websocket on Binance USDⓈ-M `!forceOrder@arr` (ALL symbols, one connection) archiving every FILLED forced liquidation (USDT-quoted) into a new `liquidations` D1 table (symbol, ts, liquidated side, price, qty, notional). **Why now:** this is the one derivatives series that CANNOT be backfilled (REST endpoint removed years ago; websocket-only) — every uncollected day is gone forever. Uses: (a) ground truth for the homemade liquidation heatmap whose inputs `oi_snapshots` has accumulated since 2026-06-03 (predicted clusters vs observed cascades), (b) future cascade-exhaustion/asymmetry WF tests (prior tempered by the whale-feature rejection — see graveyard), (c) an OBSERVED forced-flow line in the crypto prompt (upgrades the inferred whale-trap/squeeze reads). **Known feed cap:** Binance pushes ≤1 liquidation/s/symbol since 2021 — a sample; all sums are lower bounds (Coinglass shares this cap). **Egress:** rides gluetun's HTTP proxy via undici `WebSocket` + `ProxyAgent` dispatcher (`BINANCE_PROXY_URL`; the fetch-proxy monkey-patch does NOT cover websockets); reconnect w/ exponential backoff covers errors + Binance's 24h connection recycle; 5s batched D1 flushes; `LIQ_WS_URL` env override. Read path: `fetchLiquidationSummary` (1h/24h by side) → `buildUserPrompt.liquidations` → `LIQUIDATIONS (observed…)` prompt line with a one-sided-flow interpretation (≥$500k/1h gate); `GET /liquidations?symbol=&hours=` serves aggregates + recent events. 7 new tests (parse/flush/summary/prompt); 467/467 green. Requires a box redeploy; watch `[liq] connected` in the logs — persistent `[liq] reconnect` warnings mean the gluetun route needs attention. **Same session: `depth_snapshots`** — the third heatmap leg (oi_snapshots = where positions opened, liquidations = where they died, depth = the resting walls between). The cron's symbol pass snapshots the fapi order book (`/fapi/v1/depth?limit=500`, weight 10) every ~20 min per crypto symbol (KV gate `depth_snap:all`, same pattern as `oi_snap:all`): USD-notional bid/ask depth within ±0.5/1/2% of mid + per-side actual span (a 500-level book may not reach ±2% — the span makes truncated sums self-describing lower bounds). Pure summarizer `summarizeDepth` exported + unit-tested. 470/470 tests green.

### 2026-07-09 — Outcome tracking moved SERVER-SIDE (thin-client cutover; plan: jaunty-whistling-lark)

**Setup outcomes no longer need the app open** (user-requested: "the resolution should not need me opening the app"). New `marketscope-worker/src/outcome-tracking.ts` owns the full lifecycle: `/full-analysis` registers every parsed setup (+ FLAT decisions) into a new `tracked_setups` D1 table at analysis time (archetype via prompt.ts `classifyArchetype`, model/prompt versions stamped from `TRACKED_MODEL_VERSION`/`TRACKED_PROMPT_VERSION` — now the registry of record; stocks skip off-hours; conditional crypto setups also write a `pending_setups` glue row so the entry-zone APNs survive). The cron's `resolveTrackedSetups` (every ~5 min, fault-isolated, after the dirsignal block) advances open rows against **15m crypto klines** (limit sized to backfill ~10d of downtime from `last_checked_at`; 30-min overlap safe because the state machine is all max-latches) / 1h stock KV candles + a live tick — a faithful port of the iOS `trackSetupOutcomes` state machine (entry-touch direction-aware vs price_at_setup, +1R break-even, same-bar stop/TP1 open-proximity heuristic, 6h stop-tighten now candle-time-based, 12h pending expiry + simplified re-eval [ML drift/persistence/killDur from KV; the cached-analysis direction checks are dropped — cron has no LLM text], 7d untriggered prune to `not_triggered` kept as history). **Counted terminals only** (tp2_win/tp1_win/partial_be/loss) insert into `trade_outcomes` (fixes the iOS quirk of stamping tp1_win at TP1-touch and never upgrading to tp2_win). FLATs grade at a fixed **+24h horizon** (replaces the app-usage-dependent "3 refreshes"). `/full-analysis` reads Active Trade State from `tracked_setups` (body fallback for legacy builds); new `GET /tracked-setups` serves the full per-device rows; POST /outcomes gained a near-duplicate dedupe guard for the rollout overlap. **iOS `OutcomeTracker` is now a read-only display store**: `refresh()` → `WorkerTrackedSetupsService` → snapshot cache (`server_*.json`) merged with the legacy local archive (terminal rows only); `trackSetupOutcomes`/`reEvaluate`/`scanAllPendingSetups`/`registerSetup`/`syncResolvedOutcomes`/`registerFlatOutcome`/`trackFlatOutcomes`/`restoreFromServer` (which was silently broken — read camelCase keys from a snake_case response, never restored anything) and `WorkerPendingSetupService` are DELETED. 33 new worker tests (pure state machine + D1 glue on in-memory adapter); 460/460 green; iOS build green. Requires box redeploy + iOS rebuild.

### 2026-07-09 — Settings audit: dead controls removed (A/B, conformal gate, contract size)

Every Settings control traced to its consumer (user request: "features I never use"). **Removed as dead:** "Enable A/B experiments" (post-collapse baseline == treatment prompt version, so ON/OFF were byte-identical; `OutcomeTracker.assignedPromptVersion` kept for a future multi-user restart), "Conformal gate (crypto)" (`conformal_gate_enabled` had zero readers and iOS never sent `conformalGateEnabled` to the worker — leak-era leftover), and "Contract Size" (`contractSize` had zero readers since the legacy inline sizing block was deleted 2026-07-02; also dropped 3 dead `@AppStorage` declarations in ContentView from the same era). **Renamed:** the "Binance" status badge → "Crypto" (in thin mode crypto data comes from the box, not Binance). **Verified live (kept):** AI provider/model picker, auto-alerts, bias-flip + ML-threshold local notifications (in-app only; server push at ML≥70 covers background), theme, account/risk/max-leverage/cadence, outcome tracking. **Side-finding:** `thin_client_mode` has zero readers and its Settings toggle is gone — thin-client is unconditional now (the iOS-thin-client section's "master switch" text is superseded; stale flag-era comment in `WorkerFullAnalysisService` also fixed).

### 2026-07-08/09 — Chart rewritten on LWC v5 native panes + in-page gestures (SUPERSEDES the 2026-07-05 "native chart gestures / final architecture" bullet and the 2026-07-03 v4.2 entry)

Multi-session iteration with the user until "best it has been": **LWC v4.2 → v5.2.0** (`chart.html` rewritten around v5's native multi-pane — one chart, `addSeries(type, opts, paneIndex)`, native draggable separators; the v4 stacked-charts + logical-range-sync layer was the multi-pane jank and is deleted) and **the entire UIKit gesture bridge deleted** (`ChartGestureRecognizer`, `PinchAxisTracker`, `chartGeom` geometry routing, CADisplayLink coalescer — every per-touch Swift→JS hop). Gestures now live in the page: native LWC free 2D pan (with a manual-mode-on-touchstart + tap-restore dance, since LWC vertical touch-pan needs `autoScale:false`), a custom DOM pinch for time zoom (`PINCH_AMP`, Euclidean spread → simulator-testable), and a `#priceGrip` DOM strip driving price zoom through v5's `IPriceScaleApi.get/setVisibleRange` (added v5.0.7 — the API whose absence in v4 forced the drift-prone `autoscaleInfoProvider`/`coordinateToPrice` hack; anchor = last close, after range-center ran crypto-daily to the bottom and finger-focal flung 4h/1h). Key WKWebView lesson: **the scroll view's pan recognizer must stay ENABLED** — WebKit routes single-finger touchmove to the DOM through it (disabling it = dead one-finger pan on device, invisible in the simulator); only the scrollView *pinch* recognizer is disabled. A post-review hardening pass (10 verified findings) added staleness failsafes for every eaten-touchend wedge (deferred-payload flush timer, grip pid takeover, tap-vs-drag autoscale restore, third-finger handling, grip-exempt pinch, post-gesture label re-layout) and re-anchored the worker's TAGGED LEVELS + CANDIDATE SETUPS to ONE live-price geometry (`refPx`) with nearest-to-live truncation. `ChartGesturesUITests` asserts every gesture (incl. both pinch directions) via pixel-diff on real synthesized touches. Also this arc: TAGGED LEVELS ABOVE/BELOW-live tagging + anti-"squeeze" directive (user-caught geometry error, worker deploy), and glitch fixes for tab-switch + quick-scroll.

### 2026-07-06 — biases_MIXED auto-FLAT ML-gated: the envelope was suppressing the best vol cell

User-spotted circularity: the envelope auto-FLATted MIXED timeframes ("wait for alignment") while the 2026-07-02 symmetry fix auto-FLATs the mature aligned chase — and by the time TFs align the move is statistically spent, so the AI cited auto-FLAT nearly every run. Measured on the clean v14 regen (`ml-training/mixed_flat_test.py`, 870K crypto + 503K stock bars, pre-declared decision rule): **non-aligned bars (conflict + neutral = ~60-66% of all bars, exactly the envelope's MIXED) carry ~2× the goodR rate of aligned bars** (crypto 61/59% vs 33/30%; stocks 70/71% vs 39/35%), flat across trend age; direction remains a coin flip in every state (P(up24) 48-53%; EV of following the daily bias ±0.1 ATR). Mechanism: goodR is ATR-normalized, and non-aligned states are compression/transition tape where a ≥1.5-ATR move is more likely — the same mechanism as "goodR falls in strong trends". The unconditional MIXED auto-FLAT therefore suppressed the system's single best volatility cell AND made the Counter-Trend Reversal playbook (ML≥70 → MODERATE cap, tighter bands) unreachable — an internal contradiction. Fix (`prompt.ts`): `biases_MIXED` auto-FLATs only when calibrated ML_WIN < 70; at ML ≥ 70 the envelope emits `MIXED_HIGH_ML_WINDOW` guidance (structure-led setup only — 4H reversal or range-edge level, tight invalidation, counter-trend bands, cap MODERATE via the existing alignment highBlock; explicitly forbids "wait for alignment" framing). Regression test added; 426/426 green. This also re-validates the counter-trend edge on clean data (old 73-86% numbers were leak-era).

### 2026-07-06 — v14 retrain shipped (all three models) on the full-coverage derivatives regen

All three models retrained on the v14 regen (77 crypto + 159 stock symbols, 2020-01→2026-06-30, via `runBacktest.ts` — basis emitted, funding/OI/taker/long% backfilled per the 2026-07-05 audit; derivatives coverage verified 95.6%/79%/72.6% funding/OI/basis on crypto vs 1-2.5% in v11_fixed). Scripted by `calibrate_v14.py` under the audit's pre-declared ship bar (ΔAUC > +0.005 in ALL folds):
- **24h main (ML_WIN):** incumbents HOLD on both markets. Crypto LGB d4 t150 × FULL-110 (WF AUC 0.674, top-decile 76.6%; pruned-71 Δ+0.0032 not all-folds-positive; challengers ≤ +0.0008). Stocks XGB d5 t100 × FULL-110 (AUC 0.686, top-decile 78.3%); **d6-class again beat prod 3/3 folds at Δ+0.0042-43, under the bar for the second consecutive retrain** — if a third retrain repeats this, revise the bar or ship d6. `volScalarML` dropped (110 features; serving-safe — trees evaluate by name). Calibration floors: crypto 0.2498, stock 0.3193.
- **72h persistence (h72t25):** both markets retrained via `calibrate_horizon.py` — monotone reliability (crypto 70-85 bucket realizes 75.5%, stocks 78.1%), written directly to worker src.
- **Tail head (crypto):** `train_tail_head.py` — OOF AUC 0.641, thresholds ELEVATED ≥0.0832 / HIGH ≥0.1024, all-zero parity ref 0.1840390879 (heads-parity test updated).
- **Registries synced to 14:** worker outcome query `IN(10,11,12,14)` crypto / `IN(12,13,14)` stock; iOS `currentModelVersion` → 14; JSON `version: 14`. Parity fixtures refreshed via `update-fixture-ml.ts` (BTC ml 0.386→0.250, ETH 0.502→0.391, TSLA 0.524→0.511). **425/425 worker tests green; iOS + server builds green.**
- **Deploy pending:** box redeploy (TrueNAS Stop/Start pulls `:latest` after push→GHCR build) + iOS rebuild/install for the bundled JSONs (low priority — live serving is the worker).

### 2026-07-05 — Live-price anchor (AI + charts) + chart gesture fixes + 429 poll fix

Three user-reported bugs, all stemming from the closed-bar-only data contract:
- **AI told the user "if price holds over 62,900" when live was 63,700.** `/full-analysis` never fetched the live price — the whole prompt is closed-bar (training parity), so the LLM believed price = the last closed 4H bar. Fix: `runFullAnalysisCore` fetches `fetchLivePrice`, and `buildUserPrompt` (new `livePrice` input) opens with `=== LIVE PRICE (authoritative current price) ===` instructing the model to anchor all current-price/trigger/proximity statements to live and to call out already-passed triggers. Asserted in prompt-parity tests.
- **Charts ended at different stale prices per TF.** Worker serves closed bars only, so the 4H chart's newest bar was up to 4h old. Fix (iOS `WorkerIndicatorsService`): synthesize the **forming bar** from livePrice (open = last close, close = live; wick approximate, self-corrects at close) and append to `tf.candles` + set `inProgressCandle`. Indicator math untouched (computed server-side on closed bars).
- **Chart gestures janky (body pan + pinch) while price-axis drag was fine.** The tell: only time-scale-changing gestures were bad. Pane sync used time-based `setVisibleRange` per gesture frame (expensive + bar-snapping). Fix (`chart.html`): logical-range sync (`subscribeVisibleLogicalRangeChange`) with sub-series whitespace-padded to the candle range (`padToTimes`) so bar indices align across panes; `touch-action:none` on panes; WKWebView scrollView pan/pinch recognizers disabled + `delaysContentTouches=false` (`WebChartView`).
- **429 killed analyses.** The global 60/min device budget was drained by the 3s result-poll (20/min) + refresh traffic, and a rate-limited POLL failed the UI while the box job kept running. Fix: `/full-analysis/result` exempt from the global budget (worker) + iOS treats poll-429 as transient and keeps polling.
- **Chart TradingView feature batch:** drawing tools (trend line with extend-right ray toggle, **fib retracement**, **rectangle zone**, horizontal price line — all tap-to-select with draggable endpoint handles + body move, persisted per SYMBOL via `chartDrawings` message → UserDefaults → `payload.drawings`, time+price anchors render on every TF); **OHLC+change%+volume readout** (top-left, crosshair bar or last bar); **sub-pane value readouts** (RSI/MACD values in each pane label at the crosshair); **cross-pane crosshair sync** (`setCrosshairPosition`, LWC 4.1+ API); **Log-scale chip** (`chart_log` AppStorage → `payload.logScale` → priceScale mode).
- **Native chart gestures (TradingView-grade, final architecture).** After the DOM-side fixes (logical sync, `touch-action`, recognizer/text-interaction disabling, rAF-coalesced pane sync) still trailed TradingView feel, the two hot gestures moved NATIVE: `ChartPanRecognizer` (custom, begins on first horizontal movement — no 10pt UIPan lag; yields to crosshair long-press >0.25s hold, vertical price-pan, and hands off to pinch on a second finger) and a `UIPinchGestureRecognizer`, both driving the chart via `nativePanBy/nativePanEnd(velocity→JS momentum glide)/nativePinch(focalX, scale)` in chart.html; LWC's own `horzTouchDrag`/`pinch` are OFF. Axis drags, vertical price pan, crosshair, dividers stay DOM, gated by a geometry map (`reportGeom` → `chartGeom` message handler: price-axis width, time-axis height, pane/divider rects). `cancelsTouchesInView` gives the DOM a clean touchcancel on native begin.
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
- ~~**`thin_client_mode` UserDefault is the master switch**~~ — **SUPERSEDED (verified 2026-07-09): thin-client is UNCONDITIONAL.** Nothing reads `thin_client_mode` anymore and the Settings kill-switch toggle no longer exists; `AnalysisService` always routes through the worker. (Historical note: the fresh key was originally chosen because the legacy `use_server_analysis` key carried a stale persisted `false` on devices that used the old "Server analysis (beta)" toggle.)
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
