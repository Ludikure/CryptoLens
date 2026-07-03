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

    let dark: Bool
    let precision: Int
    let candles: [Bar]
    let lines: [Line]           // EMA20/50/200
    let priceLines: [PriceLine] // curated watch levels (S/R, VWAP, POC/VA, Entry/SL/TP)
    let volume: [VolumeBar]

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
    static func build(tf: IndicatorResult, watchLevels: [WatchLevel], dark: Bool) -> ChartPayload {
        let bars = tf.candles.map { Bar(time: Int($0.time.timeIntervalSince1970), open: $0.open, high: $0.high, low: $0.low, close: $0.close) }
        let last = tf.candles.last?.close ?? 1
        // Precision by magnitude (sub-cent alts need more decimals than stocks/BTC).
        let precision = last >= 100 ? 2 : last >= 1 ? 3 : last >= 0.01 ? 5 : 8

        // EMA overlays aligned to the RIGHT edge of the candle window (series are shorter due to
        // indicator warmup) — same tail-alignment as ChartPanel.tsx.
        func ema(_ series: [Double], _ color: String) -> Line? {
            guard !series.isEmpty, !bars.isEmpty else { return nil }
            let slice = Array(series.suffix(bars.count))
            let start = bars.count - slice.count
            let pts: [Point] = slice.enumerated().compactMap { i, v in
                v.isFinite ? Point(time: bars[start + i].time, value: v) : nil
            }
            return pts.isEmpty ? nil : Line(color: color, points: pts)
        }
        var lines: [Line] = []
        if let l = ema(tf.ema20Series, "#5b8def") { lines.append(l) }
        if let l = ema(tf.ema50Series, "#f0a020") { lines.append(l) }
        if let l = ema(tf.ema200Series, "#b06be8") { lines.append(l) }

        // Curated watch levels (already deduped/capped/labeled by WatchLevels.build) → price lines.
        let priceLines: [PriceLine] = watchLevels.map {
            let s = style($0.role)
            return PriceLine(price: $0.price, color: s.hex, title: tag($0), dashed: s.dashed)
        }

        let volume: [VolumeBar] = tf.candles.map {
            VolumeBar(time: Int($0.time.timeIntervalSince1970), value: $0.volume,
                      color: $0.close >= $0.open ? "rgba(38,166,154,0.45)" : "rgba(239,83,80,0.45)")
        }

        return ChartPayload(dark: dark, precision: precision, candles: bars, lines: lines, priceLines: priceLines, volume: volume)
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
            webView?.evaluateJavaScript("window.setChart(\(json))", completionHandler: nil)
        }
    }
}
