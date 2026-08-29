# Implementation Plan — TradingView Lightweight Charts on iOS

**Goal:** Replace the hand-rolled SwiftUI Canvas chart with TradingView **Lightweight Charts** (free, Apache-2.0), hosted in a `WKWebView`, to get professional candlesticks / crosshair / zoom-pan. **Match the current feature set — do not build a charting terminal.**

**Decision (do not revisit):** Use **Lightweight Charts**, not TradingView's Advanced Charting Library. The Advanced library needs a license application + a datafeed adapter and is a full terminal — overkill for a risk/analysis app. Lightweight Charts gives the "superior feel" with far less work, and **a working reference already exists** in `web/`.

---

## Reference implementation (port this — don't reinvent)
- `web/src/components/ChartPanel.tsx` — main chart: `createChart`, `addCandlestickSeries`, `addLineSeries` for `ema20/50/200Series`, and `createPriceLine` for S/R (`supportResistance.supports/resistances`) + Entry/SL/TP. Uses `lightweight-charts@^4.2.0`.
- `web/src/components/SubPanels.tsx` — RSI / MACD sub-panels.
- These already solve series setup, colors, price-line code, and time formatting. The iOS work is mostly: bundle the JS, host it in a `WKWebView`, and bridge the same data from Swift.

## What exists on iOS (being replaced)
- `CryptoLens/App/ContentView.swift:355` → `CandlestickChartView(results: [result.tf1, result.tf2, result.tf3], activeSetup: result.tradeSetups.first)` (Chart tab, tab 0). Canvas-based; sub-panels also Canvas; complex custom pan/scrub/zoom gestures.
- Keep for now: `LevelsChartView` (compact levels chart under the analysis) and `TradeSetupChartView` — small SwiftUI, optional to migrate later.

## Data already available (no new fetching needed)
- `IndicatorResult` (per timeframe): `candles: [Candle]`; `ema20Series/ema50Series/ema200Series`; `rsiSeries`, `stochKSeries`, `stochDSeries`, `macdHistSeries`, `macdLineSeries`, `macdSignalSeries`, `adxSeries`, `plusDISeries`, `minusDISeries`, `volumeRatioSeries`; `supportResistance.supports/resistances`; `vwap: VWAPResult?`; `volumeProfile?` (poc/valueAreaHigh/valueAreaLow); `marketStructure?`; `fibonacci?`.
- `Candle`: `{ time: Date, open, high, low, close, volume }`.
- `AnalysisResult`: `tf1` (daily), `tf2` (4H crypto / 1H stock), `tf3` (1H), `tradeSetups: [TradeSetup]`.
- `TradeSetup`: `{ direction: String, entry, stopLoss, tp1, tp2: Double? }`.
- `WatchLevels.build(result:) -> [WatchLevel]` (the near-price levels), `WatchLevel { price, role, label, proximity }`.

---

## Architecture
- **Bundle Lightweight Charts locally** (`lightweight-charts.standalone.production.js`, ~45 kb) under `CryptoLens/Resources/chart/` — **no CDN** (offline + reliability).
- `chart.html` (bundled): loads the JS + an inline `chart.js` (ported from `ChartPanel.tsx`) exposing `window.setChart(payloadJSON)`.
- `WebChartView: UIViewRepresentable` wrapping `WKWebView`, loads `chart.html` from the bundle, pushes payloads via `evaluateJavaScript("window.setChart(\(json))")`.
- **Swift → JS**: one-way data push. **JS → Swift** (optional, Phase 3): `WKScriptMessageHandler` for crosshair readout + tap-to-add-alert.

## Data contract (Swift `ChartPayload: Codable` → JSON → `window.setChart`)
```
{
  timeframeLabel: String,
  precision: Int,                      // price decimals (crypto sub-cent vs stocks) — reuse Formatters logic
  theme: { background, text, grid, up, down },   // from SwiftUI colorScheme
  candles:  [{ time: Int, open, high, low, close }],   // time = UNIX SECONDS, ascending, unique
  volume:   [{ time: Int, value, color }],
  lines:    [{ id: String, color: String, points: [{ time: Int, value: Double }] }],   // EMA20/50/200, VWAP
  priceLines: [{ price: Double, color: String, title: String, dashed: Bool }],         // S/R, watch levels, Entry/SL/TP/TP2
  markers:  [{ time: Int, position: String, color: String, shape: String, text: String }],
  subpanels: [{ id: String, lines: [{ color, points:[{time,value}] }], histogram: [{time,value,color}]?, guides: [{ value, color }] }]
}
```

## Series ↔ candle alignment (critical gotcha)
`ema*Series`/`rsiSeries`/etc. are often **shorter than `candles`** (indicator warmup). Align each series to the **tail** of candles:
```swift
let pts = zip(candles.suffix(series.count), series).map { ["time": Int($0.time.timeIntervalSince1970), "value": $1] }
```
`macd`/`rsi` etc. feed the sub-panels the same way.

---

## Phases

### Phase 0 — POC (behind a flag, side-by-side)
- Add `lightweight-charts.standalone.production.js` + `chart.html` to `Resources/chart/` (run `xcodegen generate`).
- `WebChartView` (WKWebView) rendering candles + EMA20/50/200 + Entry/SL/TP price lines for the current `IndicatorResult`.
- Gate behind `@AppStorage("use_webview_chart")` (default OFF); render it next to `CandlestickChartView` on the Chart tab for direct comparison.
- **Verify on device:** candles render, crosshair works, pan/zoom smooth, setup lines show. This is the go/no-go on the WebView feel.

### Phase 1 — Main-chart parity
- Timeframe selector (Daily / 4H / 1H) → push the matching `IndicatorResult`.
- EMA20/50/200 + VWAP line; S/R price lines; watch-levels (from `WatchLevels.build`); Entry/SL/TP/TP2 lines with labels; volume histogram (scaled sub-pane); entry marker.
- **Attribution:** add a visible "TradingView" link near the chart (Apache-2.0 license requirement — non-negotiable).

### Phase 2 — Sub-panels (RSI / MACD / StochRSI / ADX)
- **Note:** `lightweight-charts@4.2` has **no multi-pane API** (that's v5). Follow `SubPanels.tsx`: separate **stacked chart instances** below the main chart, with **synced time scales** (`subscribeVisibleTimeRangeChange` → apply to the others). Alternatively upgrade the bundled lib to **v5** and use native panes — implementer's call, but v4 + stacked matches the web reference.

### Phase 3 — Interactions
- Crosshair readout: JS `subscribeCrosshairMove` → `postMessage` → Swift → a SwiftUI overlay showing OHLC at the cursor (matches the current Apple-Stocks-style scrub).
- Optional: tap a price line/level → JS→Swift → prefill a `PriceAlert` (`alertsStore.addAlert`) — ties into the previously-discussed "tappable levels → alert" idea.
- Keep main + sub-panel time ranges synced.

### Phase 4 — Cutover
- After side-by-side comparison passes, flip `use_webview_chart` default ON.
- Retire `CandlestickChartView` + its custom gesture code + Canvas sub-panels. (Decide separately whether to also migrate `LevelsChartView`/`TradeSetupChartView` to a compact `WebChartView` or leave them as SwiftUI — **not required for v1**.)

---

## Gotchas checklist
1. **Time = UNIX seconds (Int), ascending, unique.** `Int(candle.time.timeIntervalSince1970)`. In-progress bar is already dropped upstream — don't re-add it.
2. **Series/candle length mismatch** → align to the tail (see above).
3. **WKWebView ↔ SwiftUI ScrollView gesture conflict:** give the chart a fixed-height container; set `webView.scrollView.isScrollEnabled = false` and let Lightweight Charts own horizontal pan; verify the page still scrolls vertically past the chart.
4. **Price precision:** pass `precision`/`minMove` to `priceFormat` (crypto sub-cent like `PEPEUSDT` vs stocks). Reuse `Formatters` decimal logic.
5. **Load timing:** don't `evaluateJavaScript` before `webView(_:didFinish:)`. Queue the latest `ChartPayload`; flush on load; coalesce rapid updates.
6. **Dark/light mode:** pass theme colors from `colorScheme`; re-push on change (`.onChange(of: colorScheme)`).
7. **Bundle the JS locally**; add `Resources/chart/**` to the target via `project.yml` + `xcodegen generate`. New Swift files also need `xcodegen generate`.
8. **Symbol switch / stale data:** re-push the full payload on symbol or timeframe change; clear old price lines before adding new ones (see `ChartPanel.tsx` — it removes prior `IPriceLine`s on update, a known pitfall where the Y-axis stays pinned to the old scale).

## Verification
- `xcodebuild -project MarketScope.xcodeproj -scheme MarketScope -destination 'generic/platform=iOS' build` green.
- On device: BTCUSDT + a stock (e.g. AAPL) render candles/EMAs/levels/setup lines; crosshair + pan/zoom smooth; timeframe switch works; sub-panels time-synced; dark/light OK; page scrolls past the chart; `PEPEUSDT` sub-cent precision correct; airplane mode still renders the chart shell (local JS).
- Side-by-side vs the Canvas chart (flag) before cutover.

## Scope discipline (product owner)
- **Match the current feature set in a nicer renderer.** No drawing tools, no 100 indicators, no saved layouts. The app's value is the analysis/risk framing, not charting.
- Effort estimate: POC ~½ day; full parity + sub-panels + interactions ~2–4 days.

## License
Lightweight Charts (Apache-2.0) requires a **visible TradingView attribution link** on/near the chart. Include it.
