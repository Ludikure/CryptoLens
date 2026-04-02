# CLAUDE.md — MarketScope (CryptoLens)

## Project Overview

MarketScope is an iOS app for multi-timeframe technical analysis of crypto and stock markets. It computes indicators locally, fetches market data from multiple providers, and sends it to Claude/Gemini AI for analysis with trade setups.

- **Bundle ID:** `com.ludikure.CryptoLens`
- **App Store name:** MarketScope
- **Version:** 1.1 (build 17)
- **Deployment target:** iOS 17.0
- **Xcode:** 16.0
- **Project generator:** XcodeGen (`project.yml`)
- **Xcode project:** `MarketScope.xcodeproj` (not `CryptoLens.xcodeproj`)

## Build & Run

```bash
# Build (must specify project — two .xcodeproj exist)
xcodebuild -project MarketScope.xcodeproj -scheme MarketScope -destination 'generic/platform=iOS' build

# Generate project from project.yml (if changed)
xcodegen generate
```

No tests exist. No package manager dependencies (no SPM, CocoaPods, or Carthage).

## Architecture

### Swift App (`CryptoLens/`)

```
App/            → CryptoLensApp.swift (entry), ContentView.swift (4-tab layout)
Services/       → Network services, data stores, push notifications
Views/          → SwiftUI views (charts, indicators, alerts, settings)
Models/         → Data models (Candle, AnalysisResult, TradeSetup, etc.)
Indicators/     → Technical indicator computation (RSI, MACD, Bollinger, etc.)
Analysis/       → Price action & positioning analyzers
Utils/          → Constants, formatters, helpers
Resources/      → Assets.xcassets
```

### Cloudflare Worker (`marketscope-worker/`)

TypeScript worker that proxies API calls, handles auth, push notifications (APNs), and alert checking via cron. Deployed to `marketscope-proxy.ludikure.workers.dev`.

### Key Patterns

- **`AnalysisService`** (`@MainActor`, `ObservableObject`) is the central coordinator. Owns all network services, publishes results.
- **`YahooFinanceService`** is an **actor** (not a class) — all calls require `await`.
- **`AlertsStore`** and **`FavoritesStore`** are `@MainActor` — all mutations must happen on main thread.
- **`Constants.customStocks`** and its accessors (`stock(for:)`, `asset(for:)`) are `@MainActor`.
- **Symbol selection** is unified in `AnalysisService.switchToSymbol()` — both `ContentView` and `FavoritePillsView` delegate to it. It handles cancellation of in-flight requests.
- **Indicator computation** happens in `IndicatorEngine.computeAll()` — pure functions, no side effects.
- **`AnalysisHistoryStore`** serializes all disk I/O on a dedicated `DispatchQueue`.
- **Cache:** `AnalysisService` caches results per-symbol in memory (`resultsBySymbol`) and on disk (`~/Library/Caches/analyses/`). `loadCache` is `nonisolated` to avoid blocking main thread.

### Data Flow

1. User selects symbol → `switchToSymbol()` → `selectSymbol()` → `refreshIndicators()`
2. `refreshIndicators` fetches candles from Binance (crypto) or Yahoo/TwelveData/Tiingo (stocks)
3. Candles → `IndicatorEngine.computeAll()` → `IndicatorResult` per timeframe
4. Results assembled into `AnalysisResult` with enrichment (sentiment, fundamentals, derivatives)
5. AI analysis: `runFullAnalysis()` builds prompt from indicators → Claude/Gemini → markdown + trade setups

### Market Data Providers

| Provider | Used For | Actor/Class |
|----------|----------|-------------|
| Binance | Crypto candles, derivatives, spot pressure | `BinanceService` (class) |
| Yahoo Finance | Stock candles, quotes, fundamentals, options | `YahooFinanceService` (actor) |
| TwelveData | Stock 4H/1H candles (fallback) | `TwelveDataProvider` (class) |
| Tiingo | Stock candles (fallback) | `TiingoProvider` (class) |
| CoinGecko | Crypto sentiment, Fear & Greed | `CoinGeckoService` (class) |
| Finnhub | Market status, analyst recs, earnings | `FinnhubProvider` (class) |
| FRED (via worker) | Macro data (rates, yields, DXY) | `MacroDataService` (@MainActor) |

### Navigation

4-tab layout in `ContentView`: Chart (0), Market (1), Analysis (2), Alerts (3). Tabs 0-2 share a `NavigationStack`; tab 3 (`AlertsView`) gets its own `NavigationStack` from `ContentView`. **Do not add a NavigationStack inside AlertsView.**

## Secrets & API Keys

- **No API keys in the codebase.** All keys are proxied through the Cloudflare Worker.
- `Secrets.xcconfig` exists but contains empty values and is gitignored.
- Worker secrets are set via `wrangler secret put`.

## Concurrency Model

- `AnalysisService`, `AlertsStore`, `FavoritesStore`, `MacroDataService`, `ConnectionStatus`, `NetworkMonitor` are all `@MainActor`.
- `YahooFinanceService` is an `actor`.
- Other services (`BinanceService`, `CoinGeckoService`, etc.) are plain classes with no mutable shared state — safe because they're only accessed from `@MainActor` `AnalysisService`.
- `PushService` is an `@MainActor` `enum`. All state (`deviceId`, `authToken`, `isAuthenticating`) is serialized through MainActor. `addAuthHeaders` and `syncAlerts` are `nonisolated` but dispatch work to `@MainActor`.
- `NavigationCoordinator` is `@MainActor`.
- Use `.task { }` instead of `.onAppear { Task { } }` for async work in views (auto-cancels on disappear).
- Use iOS 17 `onChange` form: `.onChange(of: value) { }` (zero-parameter) or `.onChange(of: value) { old, new in }`.

## Known Remaining Issues (Low Severity)

- `SharedDataManager` is dead code (no-op methods)
- No certificate pinning on network calls
- Missing accessibility labels on charts and several interactive elements
- `biasColor`, `shortBias`, `timeAgo` helper functions duplicated across 5+ view files
- `ShimmerModifier` animates to fixed 300pt regardless of view width
- `AnalysisSnapshotView` has hardcoded `width: 390` (iPhone-only)
- `SettingsView` hardcodes version string "1.0" instead of reading from Bundle
- `CandlestickChartView` body creates O(n) individual Path/Rectangle views (should use Canvas)
- `WhatsNewView` `.interactiveDismissDisabled()` with no escape hatch for large accessibility text
- Market holidays not accounted for in `MarketHours.currentSession()`
- Worker: APNs tries sandbox first then production (doubles latency); JWT not cached per cron; cron processes devices sequentially
- `BackgroundRefreshManager` creates an orphan `AlertsStore` instance (reads from UserDefaults but main store won't see changes until re-read)
- Polygon ticker still `MATICUSDT` — rebranded to POL/POLUSDT
- Missing `ITSAppUsesNonExemptEncryption` in Info.plist
- Missing App Group entitlement on main app target (widget can't share data)
- `aps-environment` hardcoded to `development` in entitlements
