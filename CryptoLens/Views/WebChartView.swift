import SwiftUI
import WebKit
import UIKit
import UIKit.UIGestureRecognizerSubclass

// MARK: - Native chart gestures (TradingView-grade touch)
//
// FULLY NATIVE TOUCH (2026-07-06 redesign, plan: cached-snuggling-fern). The page is a pure
// renderer: chart.html handles NO touches at all, and ONE zone-routed recognizer below owns
// every chart touch, driving the page through a small JS API (nativePanBy / nativePanEnd /
// nativePinch / nativePriceStretch / nativeTimeStretch / nativeDividerDrag / nativeReset).
// The previous hybrid split (native pan/pinch + DOM for crosshair/axis/dividers) caused every
// gesture bug this chart ever had — UIKit arbitration killed the pinch, DOM vertTouchDrag
// silently disabled autoscale, the crosshair sync stuck a cursor on cancelled touches. The
// page pushes its layout geometry (axis widths, divider rects) so the recognizer can route
// touches by zone.

/// Chart zones, classified from the geometry the page reports (reportGeom).
private enum ChartZone { case body, priceAxis, timeAxis, divider(Int) }

/// Decomposes a two-finger pinch into independent TIME (horizontal) and PRICE (vertical) scale
/// factors by MOVEMENT, not finger posture: the time factor tracks the change in the fingers'
/// HORIZONTAL separation, the price factor the VERTICAL separation. Each axis engages only after
/// its separation has changed by `axisActivation` since pinch start (hysteresis — wobble on the
/// axis you are not deliberately moving never activates it), and separations below
/// `minSeparation` are ignored as noise. Extracted from the recognizer so it is unit-testable
/// without synthesizing UITouches (XCUIElement.pinch can only spread vertically).
struct PinchAxisTracker {
    private var startAdx: CGFloat, startAdy: CGFloat
    private var lastAdx: CGFloat, lastAdy: CGFloat
    private(set) var hActive = false
    private(set) var vActive = false
    let axisActivation: CGFloat
    let minSeparation: CGFloat

    init(_ p1: CGPoint, _ p2: CGPoint, axisActivation: CGFloat = 15, minSeparation: CGFloat = 12) {
        startAdx = max(1, abs(p2.x - p1.x)); lastAdx = startAdx
        startAdy = max(1, abs(p2.y - p1.y)); lastAdy = startAdy
        self.axisActivation = axisActivation
        self.minSeparation = minSeparation
    }

    /// Incremental (time, price) scale factors since the previous update (1 = no change).
    mutating func update(_ p1: CGPoint, _ p2: CGPoint) -> (t: CGFloat, p: CGFloat) {
        let adx = max(1, abs(p2.x - p1.x)), ady = max(1, abs(p2.y - p1.y))
        if !hActive && abs(adx - startAdx) >= axisActivation { hActive = true }
        if !vActive && abs(ady - startAdy) >= axisActivation { vActive = true }
        let sT = (hActive && lastAdx >= minSeparation && adx >= minSeparation) ? adx / lastAdx : 1
        let sP = (vActive && lastAdy >= minSeparation && ady >= minSeparation) ? ady / lastAdy : 1
        lastAdx = adx; lastAdy = ady
        return (sT, sP)
    }
}

/// THE single owner of every chart touch. Begins on first touch-down (the page needs none) and
/// routes by zone:
///   body:       horizontal drag → time pan (+ momentum glide); vertical drag → consumed, no-op
///   price axis: vertical drag → price-scale stretch around the pane center
///   time axis:  horizontal drag → bar-spacing stretch, right edge anchored
///   divider:    vertical drag → pane resize
///   2nd finger: pinch from ANY mode except divider, any timing/placement. Movement-decomposed:
///               horizontal-separation change zooms TIME, vertical zooms PRICE, with activation
///               hysteresis so the axis you are not deliberately moving never scales. Lifting
///               one finger continues as pan with the survivor.
/// One recognizer = no UIKit arbitration, no DOM handoff races — the two bug classes that
/// plagued the previous hybrid design are structurally impossible.
private final class ChartGestureRecognizer: UIGestureRecognizer {
    enum Mode { case bodyPending, hPan, deadVertical, priceAxis, timeAxis, dividerPending(Int), divider(Int), pinch }
    var classify: (CGPoint) -> ChartZone = { _ in .body }

    private(set) var mode: Mode = .bodyPending
    /// Per-event payloads, consumed by the action handler.
    private(set) var deltaX: CGFloat = 0
    private(set) var deltaY: CGFloat = 0
    private(set) var pinchScaleT: CGFloat = 1
    private(set) var pinchScaleP: CGFloat = 1
    private(set) var focalX: CGFloat = 0
    private(set) var focalY: CGFloat = 0
    /// Smoothed horizontal velocity (pt/s) for the momentum glide on lift.
    private(set) var velocityX: CGFloat = 0

    private var t1: UITouch?
    private var t2: UITouch?
    private var start: CGPoint = .zero
    private var lastX: CGFloat = 0
    private var lastY: CGFloat = 0
    private var lastTime: TimeInterval = 0
    /// Pinch axis decomposition (see PinchAxisTracker). Non-nil only while pinching.
    private var pinch: PinchAxisTracker?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let view else { return }
        for t in touches {
            if t1 == nil {
                guard state == .possible else { ignore(t, for: event); continue }
                t1 = t
                let p = t.location(in: view)
                start = p; lastX = p.x; lastY = p.y; lastTime = t.timestamp
                deltaX = 0; deltaY = 0; pinchScaleT = 1; pinchScaleP = 1; velocityX = 0
                switch classify(p) {
                // Divider resolves by DIRECTION at slop (dividerPending): the strips cross the
                // middle of the chart, and an unconditional grab made any pan that happened to
                // START on one resize panes for the whole drag.
                case .divider(let i): mode = .dividerPending(i)
                case .priceAxis:      mode = .priceAxis
                case .timeAxis:       mode = .timeAxis
                case .body:           mode = .bodyPending
                }
                state = .began           // own the touch immediately; DOM gets touchcancel
            } else if t2 == nil, t !== t1 {
                if case .divider = mode { ignore(t, for: event); continue }  // divider stays 1-finger
                if case .dividerPending = mode { ignore(t, for: event); continue }
                t2 = t
                beginPinch()
            } else {
                ignore(t, for: event)
            }
        }
    }

    private func beginPinch() {
        guard let view, let a = t1, let b = t2 else { return }
        let p1 = a.location(in: view), p2 = b.location(in: view)
        mode = .pinch
        pinch = PinchAxisTracker(p1, p2)
        lastX = (p1.x + p2.x) / 2
        lastTime = max(a.timestamp, b.timestamp)
        deltaX = 0; deltaY = 0; pinchScaleT = 1; pinchScaleP = 1
        focalX = lastX; focalY = (p1.y + p2.y) / 2; velocityX = 0
        state = .changed
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let view else { return }
        switch mode {
        case .pinch:
            guard let a = t1, let b = t2 else { return }
            let p1 = a.location(in: view), p2 = b.location(in: view)
            let mid = (p1.x + p2.x) / 2
            let s = pinch?.update(p1, p2) ?? (t: 1, p: 1)
            pinchScaleT = s.t; pinchScaleP = s.p
            deltaX = mid - lastX
            focalX = mid; focalY = (p1.y + p2.y) / 2
            trackVelocity(at: max(a.timestamp, b.timestamp))
            lastX = mid
            state = .changed
        case .bodyPending:
            guard let t = t1, touches.contains(t) else { return }
            let p = t.location(in: view)
            let dx = p.x - start.x, dy = p.y - start.y
            guard dx * dx + dy * dy >= 36 else { return }   // 6pt slop before deciding
            if abs(dy) > abs(dx) {
                mode = .deadVertical                          // owned + consumed, no effect
            } else {
                mode = .hPan
                deltaX = dx                                   // include the slop distance
                lastX = p.x; lastTime = t.timestamp
                state = .changed
            }
        case .dividerPending(let i):
            guard let t = t1, touches.contains(t) else { return }
            let p = t.location(in: view)
            let dx = p.x - start.x, dy = p.y - start.y
            guard dx * dx + dy * dy >= 36 else { return }
            if abs(dy) > abs(dx) {
                mode = .divider(i)
                lastY = p.y
            } else {
                mode = .hPan                                  // horizontal from a divider = pan
                deltaX = dx
                lastX = p.x; lastTime = t.timestamp
                state = .changed
            }
        case .deadVertical:
            // Not a life sentence: a drag that STARTED vertical but is now clearly horizontal
            // (J-shaped pans, wobbly starts) becomes a pan — otherwise the whole touch is dead
            // with zero feedback, which reads as a broken chart.
            guard let t = t1, touches.contains(t) else { return }
            let p = t.location(in: view)
            if abs(p.x - start.x) > abs(p.y - start.y) + 8 {
                mode = .hPan
                lastX = p.x; lastTime = t.timestamp
            }
        case .hPan:
            guard let t = t1, touches.contains(t) else { return }
            let p = t.location(in: view)
            deltaX = p.x - lastX
            trackVelocity(at: t.timestamp)
            lastX = p.x
            state = .changed
        case .priceAxis, .divider:
            guard let t = t1, touches.contains(t) else { return }
            let p = t.location(in: view)
            deltaY = p.y - lastY
            lastY = p.y
            if deltaY != 0 { state = .changed }
        case .timeAxis:
            guard let t = t1, touches.contains(t) else { return }
            let p = t.location(in: view)
            deltaX = p.x - lastX
            lastX = p.x
            if deltaX != 0 { state = .changed }
        }
    }

    private func trackVelocity(at ts: TimeInterval) {
        let dt = ts - lastTime
        if dt > 0 {
            let v = deltaX / CGFloat(dt)
            velocityX = velocityX == 0 ? v : 0.7 * v + 0.3 * velocityX
        }
        lastTime = ts
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let view else { return }
        let endedT1 = t1.map(touches.contains) ?? false
        let endedT2 = t2.map(touches.contains) ?? false
        if endedT1 && (endedT2 || t2 == nil) {
            state = .ended
            return
        }
        if endedT1 { t1 = t2; t2 = nil }
        if endedT2 { t2 = nil }
        if case .pinch = mode, t2 == nil, let t = t1 {
            // Pinch → pan continuation with the surviving finger.
            mode = .hPan
            pinch = nil
            let p = t.location(in: view)
            lastX = p.x; lastTime = t.timestamp
            deltaX = 0; pinchScaleT = 1; pinchScaleP = 1; velocityX = 0
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        state = .cancelled
    }

    override func reset() {
        t1 = nil; t2 = nil
        mode = .bodyPending; pinch = nil
        deltaX = 0; deltaY = 0; pinchScaleT = 1; pinchScaleP = 1; velocityX = 0
    }
}

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
/// ALL chart touch handling is native (see file-top comment): one zone-routed recognizer owns
/// every touch, and the page renders. The ⟲ reset lives on a native SwiftUI chip (see
/// ChartScreenView) calling `reset()`.
@MainActor
final class ChartWebViewStore: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    static let shared = ChartWebViewStore()
    let webView: WKWebView
    private var loaded = false
    private var pendingJSON: String?
    private var lastJSON: String?   // dedup: only push real changes (preserves pan/zoom, no re-render)

    // Layout geometry pushed from chart.html (reportGeom) — the recognizer routes touches by
    // zone (price axis / time axis / divider / body). Defaults are permissive approximations
    // in case the first geometry message hasn't arrived yet.
    private var geomPriceAxisW: CGFloat = 70
    private var geomTimeAxisH: CGFloat = 28
    private var geomPanes: [CGRect] = []
    private var geomDividers: [CGRect] = []

    private override init() {
        let config = WKWebViewConfiguration()
        // No text on the chart is selectable; the selection/loupe machinery (long-press
        // recognizers) otherwise monitors EVERY touch, delaying second-finger registration
        // (slow pinch start) and taxing drag frames.
        config.preferences.isTextInteractionEnabled = false
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.configuration.userContentController.add(self, name: "chartGeom")
        webView.navigationDelegate = self
        webView.scrollView.isScrollEnabled = false   // the native recognizer owns all touch
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        // Opaque + solid background: a transparent WKWebView disables compositing fast paths and
        // costs canvas frame rate. The chart fills its pane, so nothing shows through anyway.
        webView.isOpaque = true
        webView.backgroundColor = UIColor(red: 0.043, green: 0.055, blue: 0.078, alpha: 1) // #0b0e14

        // THE chart gesture recognizer (see file-top comment). cancelsTouchesInView (the
        // default) starves the page of every owned touch — chart.html handles none by design.
        let gesture = ChartGestureRecognizer(target: self, action: #selector(onNativeGesture(_:)))
        gesture.classify = { [weak self] p in self?.classifyZone(p) ?? .body }
        webView.addGestureRecognizer(gesture)

        if let url = Bundle.main.url(forResource: "chart", withExtension: "html", subdirectory: "chart")
            ?? Bundle.main.url(forResource: "chart", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }

    // MARK: Native gesture plumbing

    /// Route a touch point to its chart zone (from the geometry the page reports). Divider
    /// bands win first (they are thin), then the price-axis strip, then the time-axis strip.
    private func classifyZone(_ p: CGPoint) -> ChartZone {
        for (i, d) in geomDividers.enumerated() where p.y >= d.minY - 6 && p.y <= d.maxY + 6 { return .divider(i) }
        if p.x > webView.bounds.width - geomPriceAxisW - 4 { return .priceAxis }
        if let last = geomPanes.last, p.y > last.maxY - geomTimeAxisH { return .timeAxis }
        return .body
    }

    @objc private func onNativeGesture(_ g: ChartGestureRecognizer) {
        #if DEBUG
        // On-screen gesture telemetry (chart.html #gdbg badge) — Debug builds only. Shows the
        // recognizer's state, routed mode, and payload so on-device touch issues are
        // diagnosable without a tethered console. Strip after the redesign is signed off.
        let st = ["possible", "began", "changed", "ended", "cancelled", "failed"][min(g.state.rawValue, 5)]
        evaluateGesture("window.gestureDebug && gestureDebug('\(st) \(debugLabel(g))')")
        #endif
        switch g.state {
        case .began:
            evaluateGesture("window.nativeGlideStop && nativeGlideStop()")
        case .changed:
            let js = gestureJS(g)
            if !js.isEmpty { evaluateGesture(js) }
        case .ended:
            switch g.mode {
            case .hPan, .pinch:
                // nativePanEnd self-gates on |velocity| — a stationary lift won't glide.
                evaluateGesture("window.nativePanEnd && nativePanEnd(\(g.velocityX))")
            case .divider:
                evaluateGesture("window.nativeDividerEnd && nativeDividerEnd()")
            default: break
            }
        default: break
        }
    }

    /// Per-mode payload → JS. Factors for the axis stretches are exponential in the drag delta
    /// so successive events compose smoothly and reverse exactly.
    private func gestureJS(_ g: ChartGestureRecognizer) -> String {
        switch g.mode {
        case .hPan:
            return g.deltaX != 0 ? "window.nativePanBy && nativePanBy(\(g.deltaX));" : ""
        case .pinch:
            var js = ""
            if g.pinchScaleT != 1 || g.pinchScaleP != 1 {
                js += "window.nativePinch && nativePinch(\(g.focalX), \(g.focalY), \(g.pinchScaleT), \(g.pinchScaleP));"
            }
            if g.deltaX != 0 { js += "window.nativePanBy && nativePanBy(\(g.deltaX));" }
            return js
        case .priceAxis:
            // Drag DOWN (dy>0) → zoom out (range grows), matching LWC/TradingView axis drags.
            return g.deltaY != 0 ? "window.nativePriceStretch && nativePriceStretch(\(exp(g.deltaY / 200)));" : ""
        case .timeAxis:
            // Drag RIGHT (dx>0) → bars wider (range shrinks), right edge anchored.
            return g.deltaX != 0 ? "window.nativeTimeStretch && nativeTimeStretch(\(exp(-g.deltaX / 150)));" : ""
        case .divider(let i):
            return g.deltaY != 0 ? "window.nativeDividerDrag && nativeDividerDrag(\(i), \(g.deltaY));" : ""
        case .bodyPending, .deadVertical, .dividerPending:
            return ""
        }
    }

    #if DEBUG
    private func debugLabel(_ g: ChartGestureRecognizer) -> String {
        switch g.mode {
        case .bodyPending:           return "pending"
        case .hPan:                  return String(format: "pan Δ%.1f v%.0f", g.deltaX, g.velocityX)
        case .deadVertical:          return "dead-vert"
        case .priceAxis:             return String(format: "priceAxis Δ%.1f", g.deltaY)
        case .timeAxis:              return String(format: "timeAxis Δ%.1f", g.deltaX)
        case .dividerPending(let i): return "divider\(i)?"
        case .divider(let i):        return String(format: "divider%d Δ%.1f", i, g.deltaY)
        case .pinch:                 return String(format: "pinch T×%.3f P×%.3f", g.pinchScaleT, g.pinchScaleP)
        }
    }
    #endif

    /// ⟲ — autoscale, default bar spacing, newest bar (called from the native SwiftUI chip).
    func reset() {
        evaluateGesture("window.nativeReset && nativeReset()")
    }

    private func evaluateGesture(_ js: String) {
        guard loaded else { return }
        #if DEBUG
        webView.evaluateJavaScript(js) { _, err in
            if let err { NSLog("CHART-GESTURE JSERR %@ in: %@", String(describing: err), js) }
        }
        #else
        webView.evaluateJavaScript(js, completionHandler: nil)
        #endif
    }

    // WKScriptMessageHandler. WebKit always delivers this on the main thread, and WKScriptMessage
    // (.name/.body) plus webView.bounds are all @MainActor-isolated — so assert main-actor
    // isolation rather than reading them from a nonisolated context (which warns) or bouncing
    // through a Task (which needlessly defers the geometry a frame).
    nonisolated func userContentController(_ userContentController: WKUserContentController,
                                           didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard message.name == "chartGeom", let d = message.body as? [String: Any] else { return }
            if let w = d["priceAxisW"] as? Double, w > 0 { geomPriceAxisW = CGFloat(w) }
            if let h = d["timeAxisH"] as? Double, h > 0 { geomTimeAxisH = CGFloat(h) }
            let width = webView.bounds.width
            func rects(_ key: String) -> [CGRect] {
                ((d[key] as? [[String: Any]]) ?? []).compactMap { r in
                    guard let top = r["top"] as? Double, let h = r["height"] as? Double else { return nil }
                    return CGRect(x: 0, y: top, width: width, height: h)
                }
            }
            if d["panes"] != nil { geomPanes = rects("panes") }
            if d["dividers"] != nil { geomDividers = rects("dividers") }
        }
    }

    /// Kick off web-process + HTML + JS load at app launch so the first tab-open is instant.
    static func prewarm() { _ = shared }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        // WKWebView keeps built-in double-tap recognizers (zoom heuristics) even with zooming
        // disabled; they sit in the touch pipeline and delay/misclassify fast drags. Disable
        // them — the chart recognizer is the only intended touch consumer.
        disableInterferingRecognizers(in: webView)
        // The scroll view's own pan + pinch recognizers stay armed even with isScrollEnabled =
        // false; they participate in gesture arbitration and delay/steal the start of chart-body
        // drags and two-finger spreads. The chart owns every touch — take them out entirely.
        webView.scrollView.panGestureRecognizer.isEnabled = false
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.scrollView.delaysContentTouches = false
        if let json = pendingJSON { pendingJSON = nil; evaluate(json) }
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

    func makeUIView(context: Context) -> WKWebView { ChartWebViewStore.shared.webView }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        ChartWebViewStore.shared.push(payload)
    }
}
