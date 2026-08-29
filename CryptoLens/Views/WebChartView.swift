import SwiftUI
import WebKit
import UIKit

// MARK: - Chart hosting (native Lightweight Charts gestures)
//
// NATIVE LWC TOUCH (2026-07-07). chart.html enables Lightweight Charts' own touch handling
// (handleScroll/handleScale/kineticScroll) so the library owns pan / pinch-zoom / axis-scale
// entirely inside the web process — no per-touch Swift→JS round-trip, which is why it is smooth.
// This replaced a hand-rolled UIKit→JS gesture bridge (custom ChartGestureRecognizer +
// UIPinchGestureRecognizer + a CADisplayLink coalescer) that paid an async IPC hop per finger-move
// and stuttered with multiple panes. Swift's only jobs now: host the WKWebView, keep WebKit's OWN
// scroll/zoom/selection recognizers from fighting LWC (see didFinish), push data, and drive the
// ⟲ reset. Gesture mapping (all native LWC): one finger on bars → horizontal pan; two fingers →
// time zoom; one finger on the price axis → vertical price zoom; flick → momentum glide.


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
    struct Line: Codable { let label: String; let color: String; let points: [Point] }
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
    let symbol: String          // symbol + tf form the "data identity": when either changes, the JS
    let tf: String              // side re-enables autoscale (a manual price range from BTC ~60k
                                // would leave ETH ~3k entirely off-screen) and snaps to newest bar
    let precision: Int
    let candles: [Bar]
    let lines: [Line]           // EMA20/50/200
    let priceLines: [PriceLine] // curated watch levels (S/R, VWAP, POC/VA, Entry/SL/TP)
    let volume: [VolumeBar]     // empty when the Volume panel is toggled off
    let subpanels: [SubPanel]   // only the enabled indicator panels, in display order
    let logScale: Bool          // logarithmic price scale on the main pane

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
    static func build(tf: IndicatorResult, symbol: String, watchLevels: [WatchLevel], dark: Bool,
                      panels: [String] = ["rsi", "macd"], showVolume: Bool = true,
                      logScale: Bool = false) -> ChartPayload {
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
        // Always emit all 3 EMA lines in a fixed order (empty points if a series is absent) so the
        // JS side can map them to stable, persistent line series by index (no flash on data update).
        let lines: [Line] = [
            Line(label: "EMA 20", color: "#5b8def", points: align(tf.ema20Series)),
            Line(label: "EMA 50", color: "#f0a020", points: align(tf.ema50Series)),
            Line(label: "EMA 200", color: "#b06be8", points: align(tf.ema200Series)),
        ]

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

        return ChartPayload(dark: dark, symbol: symbol, tf: tf.label, precision: precision, candles: bars,
                            lines: lines, priceLines: priceLines, volume: volume, subpanels: subpanels,
                            logScale: logScale)
    }
}

// MARK: - Shared persistent WKWebView (created once, survives tab switches)

/// ONE WKWebView for the chart, created once and kept for the app's lifetime.
///
/// WHY: the Chart tab is built via `switch selectedTab`, so a per-view WKWebView was torn down and
/// recreated on EVERY tab visit — full web-process launch + HTML load + JS parse + chart build each
/// time ("chart loads late"). The shared instance pays that cost once at app launch (prewarm), and
/// `warmPush` renders data into it BEFORE the tab is opened, so the tab shows a ready chart.
///
/// All pan/zoom is native Lightweight Charts inside the page (see file-top comment); Swift just
/// hosts the WKWebView and drives the ⟲ reset (a native SwiftUI chip in ChartScreenView).
@MainActor
final class ChartWebViewStore: NSObject, WKNavigationDelegate {
    static let shared = ChartWebViewStore()
    let webView: WKWebView
    private var loaded = false
    private var pendingJSON: String?
    private var lastJSON: String?   // dedup: only push real changes (preserves pan/zoom, no re-render)
    private override init() {
        let config = WKWebViewConfiguration()
        // No text on the chart is selectable; the selection/loupe machinery (long-press
        // recognizers) otherwise monitors EVERY touch, delaying second-finger registration
        // (slow pinch start) and taxing drag frames.
        config.preferences.isTextInteractionEnabled = false
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        // Keep the scroll view ENABLED. On-device, WKWebView delivers SINGLE-finger touchmove to
        // the DOM through the scroll view's pan pipeline — disabling it (or its pan recognizer)
        // silently kills LWC's one-finger pan and one-finger price-axis drag, while two-finger
        // pinch survives via a separate path (the exact "one finger does nothing, two fingers zoom"
        // symptom seen on device). Nothing actually scrolls: #container is viewport-sized with
        // touch-action:none, so WebKit never treats a drag as a page scroll — LWC eats it as a pan.
        webView.scrollView.isScrollEnabled = true
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        // Opaque + solid background: a transparent WKWebView disables compositing fast paths and
        // costs canvas frame rate. The chart fills its pane, so nothing shows through anyway.
        webView.isOpaque = true
        webView.backgroundColor = UIColor(red: 0.043, green: 0.055, blue: 0.078, alpha: 1) // #0b0e14

        loadChartPage()
    }

    private func loadChartPage() {
        if let url = Bundle.main.url(forResource: "chart", withExtension: "html", subdirectory: "chart")
            ?? Bundle.main.url(forResource: "chart", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }

    // MARK: Reset (the only residual JS entry point — all pan/zoom is native LWC)

    /// ⟲ — autoscale, default bar spacing, newest bar (called from the native SwiftUI chip).
    func reset() {
        guard loaded else { return }
        webView.evaluateJavaScript("window.nativeReset && nativeReset()", completionHandler: nil)
    }

    /// Kick off web-process + HTML + JS load at app launch so the first tab-open is instant.
    static func prewarm() { _ = shared }

    /// iOS kills backgrounded WKWebView content processes under memory pressure. Without this
    /// hook the persistent chart webview comes back as a blank WHITE view after reopening the
    /// app — and the next payload push for the CURRENT timeframe was deduped against `lastJSON`
    /// (identical data → no re-render), so the chart stayed white until the user switched
    /// timeframes (a different payload forced a real push). Recover: reload the page and replay
    /// the last payload once it finishes; never dedupe across a process relaunch.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        pendingJSON = lastJSON   // replay the last known data after the reload
        lastJSON = nil           // the fresh page has no chart — a dedup here would leave it white
        loadChartPage()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        assertGestureConfig()
        if let json = pendingJSON { pendingJSON = nil; evaluate(json) }
    }

    /// (Re-)asserts the exact recognizer state chart gestures depend on. IDEMPOTENT, and called
    /// from TWO places: page load (didFinish) and every window ATTACH (ChartHostView).
    ///
    /// Why both: this used to run only at page load, but WebKit re-installs / re-arms its internal
    /// recognizers when the WKContentView moves to a new window — which under the native TabView
    /// (2026-07-25) happens on EVERY tab switch, since UITabBarController detaches non-selected
    /// tabs from the window. The resulting failure is the documented device-only fingerprint from
    /// the 2026-07-08 gesture arc: one-finger pan dead, two-finger pinch fine, and the simulator
    /// (where the whole ChartGesturesUITests suite still passes) shows nothing wrong.
    func assertGestureConfig() {
        // WKWebView keeps built-in double-tap recognizers (zoom heuristics) even with zooming
        // disabled; they sit in the touch pipeline and delay/misclassify fast drags. Disable
        // them so Lightweight Charts' own touch handlers get clean, immediate events.
        disableInterferingRecognizers(in: webView)
        // Keep the PAN recognizer ENABLED — WebKit delivers single-finger touchmove to the DOM
        // through it, so disabling it kills LWC's one-finger pan on device (see the
        // scrollView.isScrollEnabled comment in init). Asserted POSITIVELY here because a
        // re-parent can leave it disabled or detached. But DISABLE the PINCH recognizer: LWC does
        // its own two-finger zoom, and leaving the scroll view's pinch armed makes it compete on
        // every pinch → sluggish two-finger zoom on device. Disabling it does NOT block two-finger
        // touch delivery to LWC (confirmed on device). touch-action:none + a viewport-sized
        // #container keep the page from ever scrolling; delaysContentTouches=false = no hold latency.
        webView.scrollView.isScrollEnabled = true
        webView.scrollView.panGestureRecognizer.isEnabled = true
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.scrollView.delaysContentTouches = false
    }

    private func disableInterferingRecognizers(in view: UIView) {
        for gr in view.gestureRecognizers ?? [] {
            if let tap = gr as? UITapGestureRecognizer, tap.numberOfTapsRequired >= 2 {
                tap.isEnabled = false
            }
            // Long-press recognizers (context menu / text selection / drag-and-drop) watch every
            // touch and compete in arbitration — the chart has nothing to long-press natively
            // (Lightweight Charts does its own crosshair long-press in the DOM).
            if gr is UILongPressGestureRecognizer {
                gr.isEnabled = false
            }
        }
        for sub in view.subviews { disableInterferingRecognizers(in: sub) }
    }

    func push(_ payload: ChartPayload) {
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8) else { return }
        if json == lastJSON { return }
        lastJSON = json
        if loaded { evaluate(json) } else { pendingJSON = json }
    }

    private func evaluate(_ json: String) {
        webView.evaluateJavaScript("window.setChart(\(json))", completionHandler: nil)
    }

    /// Render the chart BEFORE the Chart tab is opened (called from ContentView whenever fresh
    /// analysis data lands). Reads the same persisted prefs the Chart tab uses, so the payload is
    /// byte-identical to what the tab would build → the tab's own push dedups to a no-op.
    static func warmPush(result: AnalysisResult, dark: Bool) {
        guard !result.tf1.candles.isEmpty else { return }
        let d = UserDefaults.standard
        func flag(_ key: String, _ def: Bool) -> Bool { d.object(forKey: key) as? Bool ?? def }
        let idx = d.object(forKey: "chart_tf_index") as? Int ?? 1
        let panels = [flag("chart_rsi", true) ? "rsi" : nil, flag("chart_macd", true) ? "macd" : nil,
                      flag("chart_stoch", false) ? "stoch" : nil, flag("chart_adx", false) ? "adx" : nil].compactMap { $0 }
        let tfs = [result.tf1, result.tf2, result.tf3]
        let selected = tfs[min(max(idx, 0), tfs.count - 1)]
        let payload = ChartPayload.build(tf: selected.candles.isEmpty ? result.tf1 : selected,
                                         symbol: result.symbol,
                                         watchLevels: WatchLevels.build(result: result),
                                         dark: dark, panels: panels, showVolume: flag("chart_vol", true),
                                         logScale: flag("chart_log", false))
        shared.push(payload)
    }
}

struct WebChartView: UIViewRepresentable {
    let payload: ChartPayload

    func makeUIView(context: Context) -> ChartHostView { ChartHostView() }

    func updateUIView(_ uiView: ChartHostView, context: Context) {
        uiView.attachSharedWebViewIfNeeded()
        ChartWebViewStore.shared.push(payload)
    }
}

/// Hosts the shared chart WKWebView and re-asserts its gesture configuration on every window
/// attach. The representable can't observe window membership itself — this container can.
final class ChartHostView: UIView {
    func attachSharedWebViewIfNeeded() {
        let web = ChartWebViewStore.shared.webView
        if web.superview !== self {
            web.frame = bounds
            web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            addSubview(web)   // re-parents from any previous host automatically
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else { return }
        attachSharedWebViewIfNeeded()
        // WebKit may have rebuilt its internal recognizer set during the re-parent; re-assert on
        // the next runloop turn so it runs AFTER WebKit finishes its own attach work.
        DispatchQueue.main.async { ChartWebViewStore.shared.assertGestureConfig() }
    }
}
