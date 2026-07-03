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

    let dark: Bool
    let precision: Int
    let candles: [Bar]
    let lines: [Line]          // EMA20/50/200
    let priceLines: [PriceLine] // S/R + VWAP + Entry/SL/TP/TP2 + watch levels

    /// Build the payload from a single timeframe's IndicatorResult + the active setup + watch levels.
    static func build(tf: IndicatorResult, setup: TradeSetup?, watchLevels: [WatchLevel], dark: Bool) -> ChartPayload {
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

        var priceLines: [PriceLine] = []
        for s in tf.supportResistance.supports.prefix(3) { priceLines.append(PriceLine(price: s, color: "#3f6f5f", title: "S", dashed: true)) }
        for r in tf.supportResistance.resistances.prefix(3) { priceLines.append(PriceLine(price: r, color: "#6f3f4a", title: "R", dashed: true)) }
        if let v = tf.vwap?.vwap { priceLines.append(PriceLine(price: v, color: "#8a7fbf", title: "VWAP", dashed: true)) }
        if let s = setup {
            let up = s.direction.uppercased() != "SHORT"
            priceLines.append(PriceLine(price: s.entry, color: "#22d3ee", title: "Entry", dashed: false))
            priceLines.append(PriceLine(price: s.stopLoss, color: "#ef5350", title: "SL", dashed: false))
            priceLines.append(PriceLine(price: s.tp1, color: "#26a69a", title: up ? "TP1" : "TP1", dashed: false))
            if let tp2 = s.tp2 { priceLines.append(PriceLine(price: tp2, color: "#26a69a", title: "TP2", dashed: false)) }
        }
        return ChartPayload(dark: dark, precision: precision, candles: bars, lines: lines, priceLines: priceLines)
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
