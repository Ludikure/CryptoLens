# MarketScope — Architecture, Explained

A from-scratch walkthrough of how the whole system works: the iOS app, the Cloudflare
Worker, the ML pipeline, and the web app. Written to be *learnable* — it explains the mental
model, the data flow, and the *why* behind decisions, not just a file list. Pair it with
`CLAUDE.md` (the operational reference) — this doc is the "how it works"; that one is the
"current state + changelog."

---

## 0. What MarketScope actually is

MarketScope is a **multi-timeframe technical-analysis app for crypto + stocks**. A user picks
a symbol; the system fetches market data, computes ~40 technical indicators across three
timeframes (Daily / 4H / 1H), enriches it (derivatives, sentiment, macro, fundamentals),
scores it with a machine-learning model, and sends the whole picture to an LLM (Claude) which
writes an analysis + trade setup. It then *tracks the outcome* of every setup to measure
whether it was any good.

There are **three clients and one brain**:

```
   ┌─────────────┐     ┌─────────────┐         the "brain" lives here
   │  iOS app    │     │  Web app    │         ┌──────────────────────────────┐
   │ (SwiftUI)   │     │ (React)     │────────▶│   Cloudflare Worker           │
   └──────┬──────┘     └──────┬──────┘         │   (marketscope-proxy)         │
          │                   │                │                               │
          └───────────────────┴───────────────▶│  • API proxy + auth           │
                  HTTPS, 3 auth headers          │  • indicator + ML compute    │
                                                 │  • prompt build + LLM call   │
   ┌─────────────────────────────────┐          │  • cron (every minute)       │
   │ External data + AI providers     │◀────────│  • D1 (SQL) + KV (cache)      │
   │ Binance, Yahoo, Claude, FRED, …  │         └──────────────────────────────┘
   └─────────────────────────────────┘
```

The single most important architectural idea, arrived at over time: **the Worker is the
"shared brain."** Both the iOS app and the web app are *thin clients* that ask the Worker for a
complete analysis. The heavy logic (indicators, ML, prompt-building, the LLM call) runs *once*,
server-side, so the two clients stay simple and can't drift apart. (Historically iOS built the
prompt locally; as of the Phase-4 migration it calls the Worker like the web app does.)

---

## 1. The iOS app (`CryptoLens/`)

A SwiftUI app, iOS 17+, organized into the classic layers. Folder map (with the heavy files):

```
App/        CryptoLensApp.swift (entry), ContentView.swift (4-tab shell, 681 lines)
Services/   the engine room — networking, the central coordinator, ML, outcome tracking
Views/      SwiftUI screens (charts, tables, dashboards, settings)
Models/     plain data structs (Candle, IndicatorResult, TradeSetup, AnalysisResult…)
Indicators/ pure indicator math (RSI, MACD, ADX, Bollinger, VWAP, VolumeProfile…)
Analysis/   higher-level analyzers (price action, positioning, divergence)
ML/         MLScoring.swift — the native tree evaluator (used only by the backtester now)
Utils/      Constants, Formatters, MarketHours, helpers
```

### 1a. The central coordinator: `AnalysisService` (1,559 lines)
This is the heart of the app. It's an **`@MainActor ObservableObject`** — meaning all its
mutable state lives on the main thread (no data races), and SwiftUI views observe it and
re-render when its `@Published` properties change. It *owns* every network service and
orchestrates the entire pipeline. Key responsibilities:

- **`switchToSymbol()` / `selectSymbol()`** — the single unified entry point for picking a
  symbol. Both the chart tab and the favorite-pills use it. It cancels any in-flight request
  for the previous symbol (so a slow analysis for BTC doesn't overwrite the screen after you've
  swiped to ETH).
- **`refreshIndicators()`** — fetches candles, computes indicators (locally, via `IndicatorEngine`),
  assembles the `AnalysisResult`. This is the *fast* refresh (no LLM).
- **`runFullAnalysis()`** — the *slow* path: it now calls the Worker's `/full-analysis`
  (`WorkerFullAnalysisService`), which builds the prompt + runs Claude server-side, and returns
  markdown + parsed setups. (Pre-migration, it built the prompt on-device via `AnalysisPrompt`.)
- **Caching** — results are cached per-symbol in memory (`resultsBySymbol`) and on disk
  (`~/Library/Caches/analyses/`). `loadCache` is `nonisolated` so it doesn't block the main thread.
- **Hooks** — after each refresh it pings `OutcomeTracker` to check whether tracked trade setups
  hit their targets/stops.

### 1b. The concurrency model (important — Swift's safety story)
Swift concurrency is *type-enforced*; the app declares where each object is allowed to run:
- `@MainActor`: `AnalysisService`, `AlertsStore`, `FavoritesStore`, `MacroDataService`,
  `ConnectionStatus`, `NavigationCoordinator`, `PushService`. All their mutations happen on main.
- `actor`: `YahooFinanceService` — every call requires `await` (it serializes access internally).
- plain classes (`BinanceService`, `CoinGeckoService`, the providers): no mutable shared state,
  so they're safe to call from the `@MainActor` coordinator.
- `OutcomeTracker` and `AnalysisHistoryStore` use dedicated `DispatchQueue`s to serialize all
  disk I/O off the main thread.

The rule of thumb the codebase follows: *state that the UI reads lives on `@MainActor`; slow I/O
is pushed to actors or dispatch queues; views use `.task {}` (auto-cancels on disappear).*

### 1c. Market-data services (`Services/`)
Each external source is one service. They're thin HTTP clients with caching + retry:

| Service | Source | Used for |
|---|---|---|
| `BinanceService` | Binance | crypto candles, spot pressure |
| `DerivativesService` | Binance fapi | funding, OI, taker, long/short |
| `YahooFinanceService` (actor) | Yahoo | stock candles, fundamentals, options, DXY |
| `TwelveDataProvider` / `TiingoProvider` / `AlphaVantageProvider` | — | stock candle fallbacks |
| `CoinGeckoService` / `FearGreedService` | CoinGecko / Alternative.me | crypto sentiment |
| `FinnhubProvider` | Finnhub | market status, analyst recs, earnings |
| `MacroDataService` | FRED (via Worker) | rates, yields, VIX, DXY |
| `EconomicCalendarService` | FairEconomy | economic calendar |

The fallback chain matters for stocks: Yahoo → TwelveData → Tiingo → AlphaVantage, because any
single provider rate-limits or drops connections. `CandleCache` / `DerivativesCache` avoid
re-fetching within a short window.

### 1d. Indicator computation (`Indicators/` + `Analysis/`)
`IndicatorEngine.computeAll()` (in `ComputeAll.swift`) is the core: **pure functions, no side
effects.** It takes raw candles and returns an `IndicatorResult` per timeframe — RSI, MACD
series, ADX series, Bollinger, Stochastic RSI, VWAP, EMAs, plus support/resistance
(`SupportResistance` + `MarketStructure`), Fibonacci, candle patterns, and volume profile
(`VolumeProfile`: POC / VAH / VAL). Two subtleties that caused real bugs and are now load-bearing:
- **The in-progress candle is dropped** at the top of `computeAll` (if `last.time + interval > now`)
  so a live price tick doesn't mutate indicators between refreshes. *This exact issue — failing
  to drop the in-progress bar — was the data leak that wrecked the ML direction model.* The
  Worker mirrors this via `dropInProgress()`.
- **Chart candles are trimmed to the last 50** in `computeAll`; ML features use the full series
  (`fullDailyCandles`), not the trimmed `tf1.candles`.

`PriceActionAnalyzer`, `PositioningAnalyzer`, and `DivergenceDetector` turn raw indicators into
higher-level reads (e.g., "bullish divergence," "crowded long").

### 1e. The ML layer on iOS (`ML/MLScoring.swift`, `Models/BacktestResult.swift`)
`MLScoring.swift` is a **native Swift tree evaluator** — it reads the same model JSON the Worker
uses and walks the decision trees to produce a probability. `BacktestResult.swift` defines the
`MLFeatures` struct (the 111 inputs). **Post Phase-5, iOS no longer scores ML live** — it reads
the displayed probability from the Worker's `/ml-predict` (`WorkerMLService`). `MLScoring` is now
used *only* by `BacktestEngine` (the local backtester, the canonical training-data generator).

### 1f. Outcome tracking (`Services/OutcomeTracker.swift`, 1,065 lines)
This is what makes the app honest. Every trade setup the LLM produces is registered as a
`TrackedSetup`. On each refresh, `trackSetupOutcomes()` checks the live price against the setup's
entry / stop / TP1 / TP2 and records what happened (win/loss, max favorable/adverse excursion).
It also tracks **FLAT outcomes** (when the system declined to trade — to detect false caution).
Resolved outcomes sync to the Worker's D1 (`/outcomes`) so they survive reinstalls and feed back
into future prompts ("here are your last 3 BTC outcomes"). It also holds the A/B `promptVersion`
plumbing (a `@TaskLocal` so concurrent analyses each see their own bucket).

### 1g. The UI (`Views/`) — 4-tab shell
`ContentView` is a 4-tab layout: **Chart (0), Market (1), Analysis (2), Alerts (3)**. Tabs 0–2
share one `NavigationStack`; Alerts gets its own. The heavy view is `CandlestickChartView`
(951 lines) — *all* rendering (candles, EMAs, S/R, Bollinger, setup overlay, crosshair) is done
with **SwiftUI Canvas** and a single unified `DragGesture` (quick swipe = pan, hold-then-drag =
crosshair, vertical = scroll, pinch = zoom). `OutcomeDashboardView` (683) shows win/loss stats +
the live direction/calibration scoreboards. `IndicatorTableView`, `DerivativesCardView`,
`StockInfoView`, etc. are the read-out panels.

### 1h. Push + auth (`Services/PushService.swift`)
First launch generates a `device_id` UUID. `POST /register` to the Worker returns an `authToken`
(stored in Keychain). Every subsequent request carries three headers via `addAuthHeaders`
(`nonisolated` for thread-safety): `X-App-ID`, `X-Device-ID`, `X-Auth-Token`. On a 401, the app
rotates `device_id` and re-registers. APNs push tokens drive notifications; cooldowns are keyed
by *push_token* (stable per physical device) not device_id (which rotates).

---

## 2. The Cloudflare Worker (`marketscope-worker/src/`)

A single TypeScript Worker deployed to `marketscope-proxy.ludikure.workers.dev`. It is
simultaneously: an **API proxy** (so no API keys live in the apps), an **auth gate**, the
**ML/indicator compute engine**, the **prompt builder + LLM caller** (the shared brain), and a
**cron job** that runs every minute. Files:

```
index.ts        3,364  the router + auth gate + cron orchestrator + every endpoint handler
prompt.ts       1,533  buildUserPrompt (the ~40-section pre-computed-flags core) + systemPrompt
scoring-full.ts 1,184  the 111-feature computation (the parity-critical math)
indicators-full.ts 336 full IndicatorResult (series, S/R, Fib, patterns, VP) — port of iOS
scoring-ios.ts    228  faithful port of ScoringFunction.swift (granular bias/score for display)
ml-predict.ts     224  the tree evaluator + calibration (mlPredict, mlPredictDirection[dropped])
enrichment.ts     424  derivatives/positioning/spot/macro/sentiment fetchers for /full-analysis
scoring.ts        192  simplified 3-way scorer (ML gate)
aggregation.ts     54  1H→4H candle aggregation (ET-aware, for stocks)
```

### 2a. Request lifecycle: the auth gate
Every request hits the router in `index.ts`. At `index.ts:158` there's the **auth gate**: all
endpoints except a public allowlist (`/`, `/health`, `/register`, `/spot`, `/candles/crypto`,
`/derivatives`, `/sentiment`, `/cron-health`, …) must present a valid `X-Auth-Token`, validated
against D1 (with a KV fallback for legacy tokens), using constant-time comparison
(`timingSafeEqual`). `/register` is IP-rate-limited; `/analyze` is 60/min per device.

### 2b. The endpoints (what the clients call)
The full table is in `CLAUDE.md`. The ones that matter for the main flow:
- **`GET /indicators?symbol=`** — candles → full `IndicatorResult` JSON. The fast, no-LLM refresh
  that powers charts + the indicator table.
- **`POST /full-analysis?symbol=`** — **the shared brain.** Pipeline: fetch candles → compute
  indicators (`indicators-full.ts`) → ML overlay (from cron-cached `ml_preds:all`) → enrichment
  (`enrichment.ts`) → outcome history from D1 → build prompt (`prompt.ts`) → Claude (via AI
  Gateway) → parse setups → return `{analysis, setups, ml, bias}`.
- **`GET /ml-predict?symbol=`** — reads the cron-computed ML probability from KV (5-min TTL).
- **`POST /outcomes`, `GET /performance`, `GET /scores`** — outcome tracking + stats.
- **`GET /direction-accuracy`, `GET /ml-calibration`** — the live forward scoreboards.
- **`GET /cron-health`** — the dead-man's-switch (503 if the cron heartbeat is stale).
- Provider proxies (`/yahoo/*`, `/tiingo/*`, `/finnhub/*`, `/macro`, …) — pass-through with
  caching, so the clients never hold API keys.

### 2c. The cron (the autonomous engine)
Every minute, `scheduled()` runs `checkAllDeviceScores`. The critical architecture lesson here:
it's split into a **symbol pass** and a **device pass**:
```
checkAllDeviceScores                       (orchestrator)
  └─ computeSymbolPredictions(allSymbols)   (compute ONCE per symbol)
        fetch candles, compute 111 features, run ML, write ml_preds:all,
        archive derivatives, log direction/calibration signals
  └─ for each device: processDeviceNotifications(...)   (read from a Map, gate, send APNs)
```
Before this refactor, the cron looped *devices first* and re-ran the whole pipeline per device —
slow, and it produced duplicate push notifications. The per-symbol structure cuts the work ~13×.
The cron also archives derivatives to D1 every 4H, pulls FINRA dark-pool data daily, and (as of
this session) **snapshots dense OI/price every ~20 min into `oi_snapshots`** for the homemade
liquidation-heatmap experiment.

### 2d. Storage: D1 (SQL) + KV (cache)
- **D1** (`marketscope-db`) is the relational store: `devices`, `alerts`, `watchlist`,
  `score_history`, `trade_outcomes`, `notifications`, `candles`, `derivatives_history`,
  `direction_signals`, `ml_calibration`, `oi_snapshots`, etc. Migrations live in
  `migrations/*.sql` (note: some columns were added out-of-band — see CLAUDE.md's schema-drift note).
- **KV** (`env.ALERTS`) is the cache/coordination layer: `ml_preds:all` (5-min, the served ML),
  `ml_snapshots` (prev-bar values for deltas), candle caches, the cron heartbeat, rate-limit
  counters, auth-token mirror. The cron *batches* KV writes (5 blobs/minute total instead of
  ~5 per symbol) to avoid write amplification.

### 2e. Parity (`scoring-full.ts` ↔ iOS, and `prompt.ts` ↔ Swift)
The whole edge depends on the Worker computing *exactly* the same numbers as the iOS
`BacktestEngine` (which generated the training data). This is enforced by a test suite
(`test/parity-vs-backtest.test.ts`) asserting **345/345 features at 1e-7 tolerance** against
captured fixtures. A `predeploy` hook runs it, so a broken parity blocks deploy. This is why
`scoring-full.ts` is so finicky (EMA seeding, MACD trail-alignment, BB lookback windows — all had
to match Swift exactly). The same discipline applies to `prompt.ts` (it's a faithful port of the
Swift `AnalysisPrompt.buildUserPrompt`).

---

## 3. The ML pipeline

### 3a. What the model actually predicts
The target is **direction-agnostic**: `goodR = fwdMaxFavR >= 1.5` — "will price move at least
1.5 ATR in the favorable direction within 24h?" The LLM picks *direction*; the ML answers
*"is a big enough move likely at all?"* This is the single most important thing to understand,
and it was confirmed empirically this session: **the model predicts volatility/opportunity, not
which way price goes.** (See `docs/research/strategy-variance-harvest.md`.)

### 3b. Features (111)
Computed in `scoring-full.ts` (Worker) / `BacktestEngine` (iOS), grouped: Daily/4H/1H indicator
cores + momentum + vol/volume (~42), derivatives discrete + raw (9), macro (3), candle patterns
(3), cross-TF interactions (3), temporal (3), rate-of-change + acceleration (8), sentiment (2),
cross-asset (2), basis (2), volume profile (6), stock-only (OBV/A-D, gaps, relative strength,
beta, 52-week) (9+), dark pool (2), earnings proximity (1), and a handful of interaction terms.
Full table in `CLAUDE.md`.

### 3c. Training (`ml-training/calibrate_v*.py`)
- **Crypto:** LightGBM depth-4, 150 trees, 77 symbols. **Stocks:** XGBoost depth-5, 100 trees,
  159 symbols.
- **Walk-forward CV** (expanding window, purged 48-bar gap, daily-downsampled, time-decay sample
  weighting: last year 3×, last 2 years 2×).
- **Isotonic calibration** on out-of-fold predictions (capped at 0.85) so a "70%" output really
  means ~70% realized.
- Output: a model JSON (trees + embedded calibration) written to *both* `marketscope-worker/src/`
  and `CryptoLens/ML/` — the same file the Worker and iOS evaluator read.

### 3d. Serving
- **Worker** is the single source of truth for displayed ML (`ml-predict.ts` walks the trees,
  applies calibration). The cron writes `ml_preds:all`; `/ml-predict` serves it.
- **iOS** reads that via `WorkerMLService` (no local fallback — shows "—" on cache miss).
- **`BacktestEngine`** is the one place still scoring locally (it's the canonical training source).

### 3e. The leak — the cautionary tale at the center of this project
The backtest's daily slice (`runBacktest.ts`) included the *in-progress* daily candle, leaking
the forward price into daily features. It faked a 94.7% "direction" model. **Crypto-fatal**
(continuous price → leaked close ≈ forward price), **stock-spared** (overnight gaps). Fixed
(`sliceUpTo(dailyAll, evalTime - 86_400_000)`), the direction edge vanished; ML_WIN (volatility)
survived. The lesson, now baked into the code's culture: *always drop the in-progress higher-TF
bar, and never trust a number that's suspiciously stable across regimes.* Full story:
`docs/research/edge-leak-daily-candle.md`.

---

## 4. The web app (`web/`)

A **Vite + React 18 + TypeScript + lightweight-charts** thin client, deployed to Cloudflare Pages
(`marketscope-web.pages.dev`). It does **zero** indicator/prompt logic — everything comes from the
Worker. Files:
- `api.ts` — mirrors the iOS auth (localStorage `device_id` + token, the 3 headers, 401→re-register).
- `MarketView.tsx` — watchlist + price/bias header + the candlestick chart (`ChartPanel.tsx` via
  lightweight-charts) + sub-panels (`SubPanels.tsx`: RSI/MACD) + `IndicatorTable.tsx` + Run-Analysis.
- `Dashboard.tsx` — the direction-model + ML-calibration scoreboards.
- `SettingsView.tsx` — account size / risk → localStorage → sent to `/full-analysis` for sizing.
- `types.ts` — the data contract (mirrors what the Worker returns).

It exists to prove the dedup thesis: a *second* client built entirely on the shared brain, with
no duplicated logic. The CORS allowlist on the Worker is `*` so the browser can reach it.

---

## 5. End-to-end: the journey of one analysis

1. User taps a symbol in iOS → `AnalysisService.switchToSymbol()` cancels any in-flight request.
2. `refreshIndicators()` fetches candles (Binance/Yahoo) → `IndicatorEngine.computeAll()` →
   `IndicatorResult` per timeframe → assembled into `AnalysisResult` with enrichment. Chart +
   indicator table render immediately (fast path, no LLM).
3. User taps "Analyze" → `runFullAnalysis()` → `WorkerFullAnalysisService.analyze(symbol)` →
   `POST /full-analysis`.
4. The **Worker** fetches candles, recomputes the 111 features (`scoring-full.ts`), overlays the
   cron-cached ML probability, gathers enrichment (`enrichment.ts`) + outcome history from D1,
   builds the ~40-section prompt (`prompt.ts`), calls **Claude** through the AI Gateway, parses
   the setups, and returns `{analysis, setups, ml, bias}`.
5. iOS renders the markdown + setup card + ML badge. Setups are registered with `OutcomeTracker`.
6. On every later refresh, `OutcomeTracker` checks the live price against each setup's
   entry/stop/TP and records the outcome, syncing resolved ones to D1.
7. Meanwhile, independent of the app, the **cron** runs every minute: recomputing ML for all
   symbols, sending rising-edge push notifications, and accumulating the forward scoreboards.

---

## 6. Key design decisions & why

- **Worker as shared brain** — the only way to have two clients with *zero* duplicated logic.
  The price is transient duplication (Swift prompt still exists as dead code until the dedup pass).
- **Parity at 1e-7** — the model was trained on `BacktestEngine` output; if the Worker computes
  features even slightly differently, live ML ≠ training ML and the model is meaningless. Hence
  the obsessive fixture tests.
- **Direction-agnostic ML target** — because (as proven this session) direction isn't
  predictable; volatility is. The model answers the answerable question.
- **Per-symbol cron** — compute once, fan out to devices; killed duplicate notifications + 13×
  cost.
- **Outcome tracking as a first-class citizen** — the only defense against fooling yourself. Every
  setup is graded; the dashboards and `docs/research/` exist so claims are measured, not believed.
- **No API keys in clients** — everything proxies through the Worker; keys are `wrangler secret`s.

---

## 7. The honest ML reality (what this system can and can't do)

After a full adversarial investigation (documented in `docs/research/`):
- **Real:** ML_WIN predicts *volatility/opportunity* (~76% top-bucket vs 51% base). The indicator
  math, the parity, the outcome tracking, the infrastructure — all solid.
- **Not real:** *direction* prediction. Tested and null from every angle (barrier-ordering,
  capacity sweep, cross-sectional, the AI itself, funding, liquidation heatmap). The original
  "94.7% direction" was a data leak, now removed.
- **The honest framing:** this is a **volatility / regime / risk analysis tool**, not a direction
  oracle. Its value is decision support — "is a meaningful move likely here, and what's the
  structure / risk?" — not "which way will it go."

---

## 8. Where to look for what (navigation cheat-sheet)

| I want to understand… | Read… |
|---|---|
| the whole pipeline orchestration | `CryptoLens/Services/AnalysisService.swift` |
| indicator math | `CryptoLens/Indicators/ComputeAll.swift` + the individual files |
| the LLM prompt (what Claude sees) | `marketscope-worker/src/prompt.ts` (or `AnalysisPrompt.swift`) |
| the 111 ML features | `marketscope-worker/src/scoring-full.ts` + `Models/BacktestResult.swift` |
| ML tree evaluation | `marketscope-worker/src/ml-predict.ts` + `CryptoLens/ML/MLScoring.swift` |
| the cron / notifications | `marketscope-worker/src/index.ts` (`computeSymbolPredictions`) |
| outcome tracking | `CryptoLens/Services/OutcomeTracker.swift` |
| training the model | `ml-training/calibrate_v11_crypto.py` / `calibrate_v13_stocks.py` |
| the chart rendering | `CryptoLens/Views/CandlestickChartView.swift` |
| why a research decision was made | `docs/research/` (start at `README.md`) |
| current state / changelog | `CLAUDE.md` |
```
