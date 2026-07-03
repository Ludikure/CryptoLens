import SwiftUI
import WebKit
import UIKit

/// TradingView Lightweight Charts hosted in a WKWebView (POC / Phase 0 of
/// docs/tradingview-chart-plan.md). Renders candles + EMA overlays + S/R and setup price lines
/// via a bundled local HTML page (Resources/chart/chart.html) — no CDN, works offline. The pan/
/// zoom/crosshair interaction comes from Lightweight Charts, which is the whole point of moving
/// off the hand-rolled SwiftUI Canvas chart. Gated behind the `use_webview_chart` UserDefault so
/// it can be compared side-by-side with the Canvas chart before cutover.

// MARK: - Data contract (Swift → JS, mirrors chart.html's render())

struct ChartPayload: Codable {
    struct Bar: Codable { let time: Int; let open, high, low, close: Double }
    struct Point: Codable { let time: Int; let value: Double }
    struct Line: Codable { let color: String; let points: [Point] }
    struct PriceLine: Codable { let price: Double; let color: String; let title: String; let dashed: Bool }
    struct VolumeBar: Codable { let time: Int; let value: Double; let color: String }

    struct HistBar: Codable { let time: Int; let value: Double; let color: String }
    struct SubLine: Codable { let color: String; let width: Int; let points: [Point] }
    struct SubPanel: Codable {
        let id: String              // display label: "RSI" | "MACD" | "Stoch" | "ADX"
        let precision: Int
        let lines: [SubLine]
        let histogram: [HistBar]?   // MACD only
        let guides: [Double]        // horizontal reference lines (70/30, 80/20, 25…)
    }

    let dark: Bool
    let precision: Int
    let candles: [Bar]
    let lines: [Line]           // EMA20/50/200
    let priceLines: [PriceLine] // curated watch levels (S/R, VWAP, POC/VA, Entry/SL/TP)
    let volume: [VolumeBar]     // empty when the Volume panel is toggled off
    let subpanels: [SubPanel]   // only the enabled indicator panels, in display order

    /// Chart color + style for a watch-level role. Kept here (not on the model) so WatchLevel stays
    /// chart-agnostic. Mirrors the SwiftUI LevelsChartView palette.
    private static func style(_ role: WatchLevelRole) -> (hex: String, dashed: Bool) {
        switch role {
        case .resistance: return ("#ef5350", true)
        case .support:    return ("#26a69a", true)
        case .vwap:       return ("#a78bfa", true)
        case .poc:        return ("#f0a020", true)
        case .valueArea:  return ("#c0872a", true)
        case .entry:      return ("#22d3ee", false)
        case .stop:       return ("#ef5350", false)
        case .target:     return ("#26a69a", false)
        }
    }
    private static func tag(_ lvl: WatchLevel) -> String {
        switch lvl.role {
        case .resistance: return "R"
        case .support:    return "S"
        default:          return lvl.label   // VWAP / POC / VAH / VAL / Entry / Stop / TP1 / TP2
        }
    }

    /// Build the payload for one timeframe's candles + the analysis's watch levels.
    /// `panels` = enabled sub-panel ids in display order ("rsi","macd","stoch","adx");
    /// `showVolume` toggles the main-pane volume histogram.
    static func build(tf: IndicatorResult, watchLevels: [WatchLevel], dark: Bool,
                      panels: [String] = ["rsi", "macd"], showVolume: Bool = true) -> ChartPayload {
        let bars = tf.candles.map { Bar(time: Int($0.time.timeIntervalSince1970), open: $0.open, high: $0.high, low: $0.low, close: $0.close) }
        let last = tf.candles.last?.close ?? 1
        // Precision by magnitude (sub-cent alts need more decimals than stocks/BTC).
        let precision = last >= 100 ? 2 : last >= 1 ? 3 : last >= 0.01 ? 5 : 8

        // Tail-align a series to the RIGHT edge of the candle window (series are shorter due to
        // indicator warmup) — same tail-alignment as ChartPanel.tsx / SubPanels.tsx.
        func align(_ series: [Double]) -> [Point] {
            guard !series.isEmpty, !bars.isEmpty else { return [] }
            let slice = Array(series.suffix(bars.count))
            let start = bars.count - slice.count
            return slice.enumerated().compactMap { i, v in v.isFinite ? Point(time: bars[start + i].time, value: v) : nil }
        }
        var lines: [Line] = []
        let e20 = align(tf.ema20Series); if !e20.isEmpty { lines.append(Line(color: "#5b8def", points: e20)) }
        let e50 = align(tf.ema50Series); if !e50.isEmpty { lines.append(Line(color: "#f0a020", points: e50)) }
        let e200 = align(tf.ema200Series); if !e200.isEmpty { lines.append(Line(color: "#b06be8", points: e200)) }

        // Curated watch levels (already deduped/capped/labeled by WatchLevels.build) → price lines.
        let priceLines: [PriceLine] = watchLevels.map {
            let s = style($0.role)
            return PriceLine(price: $0.price, color: s.hex, title: tag($0), dashed: s.dashed)
        }

        let volume: [VolumeBar] = showVolume ? tf.candles.map {
            VolumeBar(time: Int($0.time.timeIntervalSince1970), value: $0.volume,
                      color: $0.close >= $0.open ? "rgba(38,166,154,0.45)" : "rgba(239,83,80,0.45)")
        } : []

        // Enabled sub-panels, in display order.
        var subpanels: [SubPanel] = []
        for id in ["rsi", "macd", "stoch", "adx"] where panels.contains(id) {
            switch id {
            case "rsi":
                subpanels.append(SubPanel(id: "RSI", precision: 1,
                    lines: [SubLine(color: "#e6c84f", width: 2, points: align(tf.rsiSeries))], histogram: nil, guides: [70, 30]))
            case "macd":
                let hist = align(tf.macdHistSeries).map {
                    HistBar(time: $0.time, value: $0.value, color: $0.value >= 0 ? "rgba(38,166,154,0.7)" : "rgba(239,83,80,0.7)")
                }
                let mMax = (tf.macdHistSeries + tf.macdLineSeries + tf.macdSignalSeries).map { Swift.abs($0) }.max() ?? 1
                let mp = mMax >= 1 ? 3 : mMax >= 0.01 ? 5 : 8
                subpanels.append(SubPanel(id: "MACD", precision: mp,
                    lines: [SubLine(color: "#5b8def", width: 1, points: align(tf.macdLineSeries)),
                            SubLine(color: "#f0a020", width: 1, points: align(tf.macdSignalSeries))],
                    histogram: hist, guides: []))
            case "stoch":
                subpanels.append(SubPanel(id: "Stoch", precision: 1,
                    lines: [SubLine(color: "#22d3ee", width: 2, points: align(tf.stochKSeries)),
                            SubLine(color: "#f0a020", width: 1, points: align(tf.stochDSeries))], histogram: nil, guides: [80, 20]))
            case "adx":
                subpanels.append(SubPanel(id: "ADX", precision: 1,
                    lines: [SubLine(color: "#b06be8", width: 2, points: align(tf.adxSeries)),
                            SubLine(color: "#26a69a", width: 1, points: align(tf.plusDISeries)),
                            SubLine(color: "#ef5350", width: 1, points: align(tf.minusDISeries))], histogram: nil, guides: [25]))
            default: break
            }
        }

        return ChartPayload(dark: dark, precision: precision, candles: bars, lines: lines, priceLines: priceLines,
                            volume: volume, subpanels: subpanels)
    }
}

// MARK: - WKWebView wrapper

struct WebChartView: UIViewRepresentable {
    let payload: ChartPayload

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.isScrollEnabled = false   // let Lightweight Charts own horizontal pan; page scrolls via the parent
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        context.coordinator.webView = webView

        if let url = Bundle.main.url(forResource: "chart", withExtension: "html", subdirectory: "chart")
            ?? Bundle.main.url(forResource: "chart", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.push(payload)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        private var loaded = false
        private var pending: ChartPayload?
        private var lastJSON: String?   // dedup: updateUIView fires on any parent re-render; only push real changes

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            if let p = pending { send(p); pending = nil }
        }

        func push(_ payload: ChartPayload) {
            if loaded { send(payload) } else { pending = payload }
        }

        private func send(_ payload: ChartPayload) {
            guard let data = try? JSONEncoder().encode(payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            // Skip redundant pushes — render() recreates the charts, so pushing an identical payload
            // on every SwiftUI re-render would flicker + drop the user's pan/zoom state.
            if json == lastJSON { return }
            lastJSON = json
            webView?.evaluateJavaScript("window.setChart(\(json))", completionHandler: nil)
        }
    }
}
