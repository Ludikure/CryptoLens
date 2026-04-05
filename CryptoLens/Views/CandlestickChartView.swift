import SwiftUI

struct CandlestickChartView: View {
    let results: [IndicatorResult]  // [tf1, tf2, tf3]
    @State private var selectedTab = 0
    @AppStorage("chart_show_ema") private var showEMA = true
    @AppStorage("chart_show_sr") private var showSR = true
    @AppStorage("chart_show_bb") private var showBB = false
    @AppStorage("chart_show_rsi") private var showRSI = false
    @AppStorage("chart_show_macd") private var showMACD = false
    @AppStorage("chart_show_stochrsi") private var showStochRSI = false
    @AppStorage("chart_show_adx") private var showADX = false
    @AppStorage("chart_show_vol") private var showVolOsc = false
    @State private var showOverlayMenu = false

    private var currentResult: IndicatorResult { results[selectedTab] }
    private var candles: [Candle] { currentResult.candles }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Timeframe picker + overlay toggle
            HStack(spacing: 0) {
                // Chart settings button
                Button { showOverlayMenu.toggle() } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(6)
                        .background(Color(.systemGray5), in: Circle())
                }
                .buttonStyle(.borderless)
                .popover(isPresented: $showOverlayMenu, arrowEdge: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Overlays").font(.caption2).foregroundStyle(.tertiary)
                        Toggle("EMA 20/50/200", isOn: $showEMA)
                        Toggle("Support / Resistance", isOn: $showSR)
                        Toggle("Bollinger Bands", isOn: $showBB)
                        Divider()
                        Text("Sub-Charts").font(.caption2).foregroundStyle(.tertiary)
                        Toggle("Volume", isOn: $showVolOsc)
                        Toggle("RSI", isOn: $showRSI)
                        Toggle("MACD", isOn: $showMACD)
                        Toggle("Stoch RSI", isOn: $showStochRSI)
                        Toggle("ADX / DI", isOn: $showADX)
                    }
                    .font(.caption)
                    .padding(12)
                    .presentationCompactAdaptation(.popover)
                }

                Spacer()

                HStack(spacing: 4) {
                    ForEach(Array(results.enumerated()), id: \.offset) { idx, r in
                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) { selectedTab = idx }
                        } label: {
                            Text(r.label)
                                .font(.caption2)
                                .fontWeight(selectedTab == idx ? .bold : .medium)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .foregroundStyle(selectedTab == idx ? .white : .secondary)
                                .background(
                                    selectedTab == idx ? Color.accentColor : Color(.systemGray5),
                                    in: Capsule()
                                )
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 8)

            if candles.count >= 2 {
                CandlestickCanvas(
                    candles: candles,
                    ema20Series: showEMA ? currentResult.ema20Series : [],
                    ema50Series: showEMA ? currentResult.ema50Series : [],
                    ema200Series: showEMA ? currentResult.ema200Series : [],
                    supports: showSR ? currentResult.supportResistance.supports : [],
                    resistances: showSR ? currentResult.supportResistance.resistances : [],
                    bollingerUpper: showBB ? currentResult.bollingerBands?.upper : nil,
                    bollingerLower: showBB ? currentResult.bollingerBands?.lower : nil,
                    candlePatterns: currentResult.candlePatterns,
                    rsiSeries: showRSI ? currentResult.rsiSeries : [],
                    macdHistSeries: showMACD ? currentResult.macdHistSeries : [],
                    macdLineSeries: showMACD ? currentResult.macdLineSeries : [],
                    macdSignalSeries: showMACD ? currentResult.macdSignalSeries : [],
                    stochKSeries: showStochRSI ? currentResult.stochKSeries : [],
                    stochDSeries: showStochRSI ? currentResult.stochDSeries : [],
                    adxSeries: showADX ? currentResult.adxSeries : [],
                    plusDISeries: showADX ? currentResult.plusDISeries : [],
                    minusDISeries: showADX ? currentResult.minusDISeries : [],
                    volumeRatioSeries: showVolOsc ? currentResult.volumeRatioSeries : []
                )
            } else {
                Text("No candle data")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 200)
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Canvas-based Candlestick Renderer

private struct CandlestickCanvas: View {
    let candles: [Candle]
    let ema20Series: [Double]
    let ema50Series: [Double]
    let ema200Series: [Double]
    let supports: [Double]
    let resistances: [Double]
    let bollingerUpper: Double?
    let bollingerLower: Double?
    let candlePatterns: [PatternResult]
    let rsiSeries: [Double]
    let macdHistSeries: [Double]
    let macdLineSeries: [Double]
    let macdSignalSeries: [Double]
    let stochKSeries: [Double]
    let stochDSeries: [Double]
    let adxSeries: [Double]
    let plusDISeries: [Double]
    let minusDISeries: [Double]
    let volumeRatioSeries: [Double]

    @State private var selectedIndex: Int?
    @State private var scrubMode = false

    // Viewport: which candles are visible
    @State private var visibleCount: Int = 80
    @State private var scrollOffset: Int = 0  // 0 = latest candles visible
    @GestureState private var livePinchScale: CGFloat = 1.0
    @GestureState private var livePanOffset: CGFloat = 0
    @State private var chartWidth: CGFloat = 350

    // Layout
    private let chartHeight: CGFloat = 240
    private let subChartHeight: CGFloat = 160
    private let spacing: CGFloat = 6
    private let minVisibleCandles = 15
    private let maxVisibleCandles = 200

    private var subChartCount: Int {
        (rsiSeries.isEmpty ? 0 : 1) + (macdHistSeries.isEmpty ? 0 : 1) + (stochKSeries.isEmpty ? 0 : 1) + (adxSeries.isEmpty ? 0 : 1) + (volumeRatioSeries.isEmpty ? 0 : 1)
    }
    private var totalHeight: CGFloat {
        chartHeight + CGFloat(subChartCount) * (spacing + subChartHeight)
    }

    /// Effective visible count accounting for live pinch gesture
    private var effectiveVisibleCount: Int {
        let scaled = livePinchScale != 1.0 ? Int(Double(visibleCount) / livePinchScale) : visibleCount
        return min(maxVisibleCandles, max(minVisibleCandles, scaled))
    }

    /// Candle offset from live pan gesture (positive = scrolling back in time)
    private var panOffsetCandles: Int {
        guard livePanOffset != 0, chartWidth > 0 else { return 0 }
        let candlesPerPoint = Double(effectiveVisibleCount) / Double(chartWidth)
        return Int(livePanOffset * candlesPerPoint)
    }

    private var visibleRange: Range<Int> {
        let total = candles.count
        let count = min(effectiveVisibleCount, total)
        let offset = max(0, min(total - count, scrollOffset + panOffsetCandles))
        let end = max(count, total - offset)
        let start = max(0, end - count)
        return start..<min(end, total)
    }

    private var visibleCandles: ArraySlice<Candle> {
        candles[visibleRange]
    }

    private var priceMin: Double {
        let low = visibleCandles.map(\.low).min() ?? 0
        let range = priceRange
        return low - range * 0.02
    }
    private var priceMax: Double {
        let high = visibleCandles.map(\.high).max() ?? 0
        let range = priceRange
        return high + range * 0.02
    }
    private var priceRange: Double {
        let high = visibleCandles.map(\.high).max() ?? 1
        let low = visibleCandles.map(\.low).min() ?? 0
        return max(high - low, 0.0001)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Selected candle info
            if let idx = selectedIndex, visibleRange.contains(idx) {
                selectedCandleInfo(candles[idx])
            } else if let last = visibleCandles.last {
                selectedCandleInfo(last)
            }

            // Price chart — single Canvas draw call for all candles, overlays, grid
            GeometryReader { geo in
                let totalWidth = geo.size.width
                let _ = updateChartWidth(totalWidth)
                let vCount = visibleRange.count
                let candleWidth = max(2, (totalWidth / CGFloat(vCount)) - 1.5)
                let step = totalWidth / CGFloat(vCount)

                Canvas { context, size in
                    let chartH = chartHeight

                    // Price grid
                    let gridLines = 3
                    for i in 0...gridLines {
                        let fraction = CGFloat(i) / CGFloat(gridLines)
                        let price = priceMax - Double(fraction) * (priceMax - priceMin)
                        let y = chartH * fraction

                        var gp = Path()
                        gp.move(to: CGPoint(x: 0, y: y))
                        gp.addLine(to: CGPoint(x: totalWidth, y: y))
                        context.stroke(gp, with: .color(Color(.systemGray3)), style: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))

                        context.draw(
                            Text(Formatters.formatPrice(price)).font(.system(size: 8)).foregroundColor(.secondary),
                            at: CGPoint(x: 4, y: y - 10), anchor: .topLeading
                        )
                    }

                    // Bollinger band fill
                    if let bbUpper = bollingerUpper, let bbLower = bollingerLower {
                        let yU = priceY(bbUpper, height: chartH)
                        let yL = priceY(bbLower, height: chartH)
                        context.fill(Path(CGRect(x: 0, y: yU, width: totalWidth, height: max(0, yL - yU))), with: .color(.purple.opacity(0.04)))
                    }

                    // S/R levels
                    let visSup = supports.filter { $0 >= priceMin && $0 <= priceMax }
                    let visRes = resistances.filter { $0 >= priceMin && $0 <= priceMax }
                    for level in visSup {
                        drawSRLine(context: &context, value: level, height: chartH, width: totalWidth, color: .green)
                    }
                    for level in visRes {
                        drawSRLine(context: &context, value: level, height: chartH, width: totalWidth, color: .red)
                    }

                    // EMA polylines
                    drawPriceLine(context: &context, series: ema200Series, step: step, height: chartH, color: .purple.opacity(0.7))
                    drawPriceLine(context: &context, series: ema50Series, step: step, height: chartH, color: .blue.opacity(0.75))
                    drawPriceLine(context: &context, series: ema20Series, step: step, height: chartH, color: .orange.opacity(0.85))

                    // Candlesticks
                    for (localIdx, candle) in visibleCandles.enumerated() {
                        let x = step * CGFloat(localIdx) + step / 2
                        let isUp = candle.close >= candle.open
                        let color: Color = isUp ? .green : .red

                        // Wick
                        var wick = Path()
                        wick.move(to: CGPoint(x: x, y: priceY(candle.high, height: chartH)))
                        wick.addLine(to: CGPoint(x: x, y: priceY(candle.low, height: chartH)))
                        context.stroke(wick, with: .color(color), lineWidth: 1)

                        // Body
                        let bodyTop = priceY(max(candle.open, candle.close), height: chartH)
                        let bodyBot = priceY(min(candle.open, candle.close), height: chartH)
                        let bodyH = max(1, bodyBot - bodyTop)
                        context.fill(Path(CGRect(x: x - candleWidth / 2, y: bodyTop, width: candleWidth, height: bodyH)), with: .color(color))
                    }

                    // Pattern annotation on last visible candle
                    if let firstPattern = candlePatterns.first,
                       visibleRange.contains(candles.count - 1),
                       let lastCandle = candles.last {
                        let localIdx = candles.count - 1 - visibleRange.lowerBound
                        let lastX = step * CGFloat(localIdx) + step / 2
                        let lastHigh = priceY(lastCandle.high, height: chartH)
                        let isBullish = candlePatterns.contains { $0.signal.lowercased().contains("bullish") }
                        let dotColor: Color = isBullish ? .green : .red

                        context.fill(Path(ellipseIn: CGRect(x: lastX - 3, y: lastHigh - 11, width: 6, height: 6)), with: .color(dotColor))
                        context.draw(
                            Text(firstPattern.pattern).font(.system(size: 7, weight: .semibold)).foregroundColor(dotColor),
                            at: CGPoint(x: lastX, y: lastHigh - 18), anchor: .center
                        )
                    }

                    // Selection highlight
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        context.fill(Path(CGRect(x: x - step / 2, y: 0, width: step, height: chartH)), with: .color(Color.primary.opacity(0.08)))
                    }
                }
                // Go-to-latest button (interactive overlay outside Canvas)
                .overlay(alignment: .bottomTrailing) {
                    if scrollOffset > 0 {
                        Button {
                            withAnimation(.easeOut(duration: 0.2)) { scrollOffset = 0 }
                        } label: {
                            Image(systemName: "chevron.right.2")
                                .font(.caption2)
                                .foregroundStyle(.white)
                                .padding(6)
                                .background(Color.accentColor.opacity(0.8), in: Circle())
                        }
                        .buttonStyle(.borderless)
                        .padding(4)
                    }
                }
                .contentShape(Rectangle())
                // Pinch to zoom
                .simultaneousGesture(
                    MagnificationGesture(minimumScaleDelta: 0.01)
                        .updating($livePinchScale) { value, state, _ in
                            state = value
                        }
                        .onEnded { value in
                            let newCount = Int(Double(visibleCount) / value)
                            visibleCount = min(maxVisibleCandles, max(minVisibleCandles, newCount))
                        }
                )
                // Horizontal pan: requires 10pt intentional movement — vertical swipes pass to ScrollView
                .simultaneousGesture(
                    DragGesture(minimumDistance: 10)
                        .updating($livePanOffset) { value, state, _ in
                            if !scrubMode && abs(value.translation.width) > abs(value.translation.height) {
                                state = value.translation.width
                            }
                        }
                        .onEnded { value in
                            if !scrubMode && abs(value.translation.width) > abs(value.translation.height) {
                                let cPerPt = Double(effectiveVisibleCount) / max(1, Double(chartWidth))
                                let dragged = Int(value.translation.width * cPerPt)
                                scrollOffset = max(0, min(candles.count - visibleCount, scrollOffset + dragged))
                            }
                        }
                )
                // Long press + drag to scrub: only activates after deliberate 0.3s hold
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.3)
                        .sequenced(before: DragGesture(minimumDistance: 0))
                        .onChanged { value in
                            switch value {
                            case .first(true):
                                scrubMode = true
                            case .second(true, let drag):
                                if let drag {
                                    updateSelectedCandle(at: drag.location, step: step)
                                }
                            default: break
                            }
                        }
                        .onEnded { _ in
                            scrubMode = false
                            selectedIndex = nil
                        }
                )
            }
            .frame(height: chartHeight)
            .clipped()

            // Sub-charts
            subCharts
        }
        .onChange(of: candles.count) { _, newCount in
            visibleCount = min(80, newCount)
            scrollOffset = 0
            selectedIndex = nil
            scrubMode = false
        }
    }

    // MARK: - Selected Candle Info Bar

    private func selectedCandleInfo(_ candle: Candle) -> some View {
        HStack(spacing: 8) {
            Text(candle.time, format: .dateTime.month(.abbreviated).day().hour().minute())
                .foregroundStyle(.secondary)
            Spacer()
            Group {
                label("O", value: candle.open)
                label("H", value: candle.high)
                label("L", value: candle.low)
                label("C", value: candle.close, color: candle.close >= candle.open ? .green : .red)
            }
        }
        .font(.system(size: 10, weight: .medium, design: .monospaced))
        .padding(.bottom, 4)
    }

    private func label(_ key: String, value: Double, color: Color = .secondary) -> some View {
        HStack(spacing: 2) {
            Text(key).foregroundStyle(.secondary)
            Text(Formatters.formatPrice(value)).foregroundStyle(color)
        }
    }

    // MARK: - Canvas Drawing Helpers

    private func drawSRLine(context: inout GraphicsContext, value: Double, height: CGFloat, width: CGFloat, color: Color) {
        let y = priceY(value, height: height)
        var path = Path()
        path.move(to: CGPoint(x: 0, y: y))
        path.addLine(to: CGPoint(x: width, y: y))
        context.stroke(path, with: .color(color.opacity(0.6)), style: StrokeStyle(lineWidth: 0.7, dash: [3, 3]))
        context.draw(
            Text(Formatters.formatPrice(value)).font(.system(size: 7)).foregroundColor(color.opacity(0.85)),
            at: CGPoint(x: width - 4, y: y - 8), anchor: .trailing
        )
    }

    private func drawPriceLine(context: inout GraphicsContext, series: [Double], step: CGFloat, height: CGFloat, color: Color) {
        guard series.count >= 2 else { return }
        let fullOffset = candles.count - series.count
        var path = Path()
        var started = false
        for globalIdx in visibleRange {
            let seriesIdx = globalIdx - fullOffset
            guard seriesIdx >= 0 && seriesIdx < series.count else { continue }
            let localIdx = globalIdx - visibleRange.lowerBound
            let x = step * CGFloat(localIdx) + step / 2
            let y = priceY(series[seriesIdx], height: height)
            if !started { path.move(to: CGPoint(x: x, y: y)); started = true }
            else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        context.stroke(path, with: .color(color), lineWidth: 1.2)
    }

    private func drawSubChartLine(context: inout GraphicsContext, data: [Double], step: CGFloat, height: CGFloat, lo: Double, hi: Double, color: Color) {
        guard data.count >= 2, hi > lo else { return }
        let fullOffset = candles.count - data.count
        var path = Path()
        var started = false
        for globalIdx in visibleRange {
            let seriesIdx = globalIdx - fullOffset
            guard seriesIdx >= 0 && seriesIdx < data.count else { continue }
            let localIdx = globalIdx - visibleRange.lowerBound
            let x = step * CGFloat(localIdx) + step / 2
            let y = height * CGFloat(1.0 - (data[seriesIdx] - lo) / (hi - lo))
            if !started { path.move(to: CGPoint(x: x, y: y)); started = true }
            else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        context.stroke(path, with: .color(color), lineWidth: 1.0)
    }

    // MARK: - Scrub Helpers

    private func updateSelectedCandle(at location: CGPoint, step: CGFloat) {
        let localIdx = Int(location.x / step)
        let globalIdx = localIdx + visibleRange.lowerBound
        if globalIdx >= visibleRange.lowerBound && globalIdx < visibleRange.upperBound {
            selectedIndex = globalIdx
        }
    }

    // MARK: - Sub-Charts

    @ViewBuilder
    private var subCharts: some View {
        if !volumeRatioSeries.isEmpty {
            volumeOscPanel
        }
        if !rsiSeries.isEmpty {
            oscillatorPanel(title: "RSI", series: [(rsiSeries, Color.purple)], range: 0...100, levels: [30, 70], highlightBand: true)
        }
        if !macdHistSeries.isEmpty {
            macdPanel
        }
        if !stochKSeries.isEmpty {
            oscillatorPanel(title: "Stoch RSI", series: [(stochKSeries, Color.blue), (stochDSeries, Color.orange)], range: 0...100, levels: [20, 80])
        }
        if !adxSeries.isEmpty {
            adxPanel
        }
    }

    private func oscillatorPanel(title: String, series: [([Double], Color)], range: ClosedRange<Double>, levels: [Double], highlightBand: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                if let mainSeries = series.first?.0 {
                    let offset = candles.count - mainSeries.count
                    let displayIdx = (selectedIndex ?? (visibleRange.upperBound - 1)) - offset
                    if displayIdx >= 0 && displayIdx < mainSeries.count {
                        Text(String(format: "%.1f", mainSeries[displayIdx]))
                            .font(.system(size: 9, weight: .medium, design: .monospaced))
                            .foregroundStyle(selectedIndex != nil ? .primary : .secondary)
                    }
                }
            }
            .padding(.horizontal, 2)

            GeometryReader { geo in
                let width = geo.size.width
                let height = subChartHeight - 14
                let step = width / CGFloat(visibleRange.count)

                // Auto-scale to visible data with padding, ensuring level lines remain visible
                let visibleVals: [Double] = series.flatMap { (data, _) in
                    let off = candles.count - data.count
                    return visibleRange.compactMap { idx in
                        let si = idx - off; return (si >= 0 && si < data.count) ? data[si] : nil
                    }
                }
                let dataMin = visibleVals.min() ?? range.lowerBound
                let dataMax = visibleVals.max() ?? range.upperBound
                let levelMin = levels.min() ?? range.lowerBound
                let levelMax = levels.max() ?? range.upperBound
                let rawLo = min(dataMin, levelMin)
                let rawHi = max(dataMax, levelMax)
                let padding = (rawHi - rawLo) * 0.1
                let lo = max(range.lowerBound, rawLo - padding)
                let hi = min(range.upperBound, rawHi + padding)

                Canvas { context, size in
                    // Band fills
                    if levels.count == 2 {
                        let yTop = height * CGFloat(1.0 - (levels[1] - lo) / (hi - lo))
                        let yBot = height * CGFloat(1.0 - (levels[0] - lo) / (hi - lo))
                        if highlightBand {
                            context.fill(Path(CGRect(x: 0, y: yTop, width: width, height: yBot - yTop)), with: .color(.purple.opacity(0.06)))
                        } else {
                            context.fill(Path(CGRect(x: 0, y: 0, width: width, height: yTop)), with: .color(.red.opacity(0.04)))
                            context.fill(Path(CGRect(x: 0, y: yBot, width: width, height: height - yBot)), with: .color(.green.opacity(0.04)))
                        }
                    }

                    // Level lines
                    for level in levels {
                        let y = height * CGFloat(1.0 - (level - lo) / (hi - lo))
                        var lp = Path()
                        lp.move(to: CGPoint(x: 0, y: y))
                        lp.addLine(to: CGPoint(x: width, y: y))
                        context.stroke(lp, with: .color(Color(.systemGray3)), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                        context.draw(
                            Text(String(format: "%.0f", level)).font(.system(size: 7)).foregroundColor(.secondary),
                            at: CGPoint(x: 12, y: y), anchor: .center
                        )
                    }

                    // Series lines
                    for (data, color) in series {
                        drawSubChartLine(context: &context, data: data, step: step, height: height, lo: lo, hi: hi, color: color)
                    }

                    // Selection crosshair
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        context.fill(Path(CGRect(x: x - step / 2, y: 0, width: step, height: height)), with: .color(Color.primary.opacity(0.08)))

                        // Value dot
                        if let mainSeries = series.first?.0 {
                            let seriesIdx = idx - (candles.count - mainSeries.count)
                            if seriesIdx >= 0 && seriesIdx < mainSeries.count {
                                let y = height * CGFloat(1.0 - (mainSeries[seriesIdx] - lo) / (hi - lo))
                                context.fill(Path(ellipseIn: CGRect(x: x - 2.5, y: y - 2.5, width: 5, height: 5)), with: .color(series.first!.1))
                            }
                        }
                    }
                }
                .contentShape(Rectangle())
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.3)
                        .sequenced(before: DragGesture(minimumDistance: 0))
                        .onChanged { value in
                            switch value {
                            case .first(true): scrubMode = true
                            case .second(true, let drag):
                                if let drag { updateSelectedCandle(at: drag.location, step: step) }
                            default: break
                            }
                        }
                        .onEnded { _ in scrubMode = false; selectedIndex = nil }
                )
            }
            .frame(height: subChartHeight - 14)
        }
        .frame(height: subChartHeight)
        .padding(.top, spacing)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(.systemGray3), lineWidth: 0.5)
        )
    }

    private var macdPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Text("MACD").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                let fullOffset = candles.count - macdHistSeries.count
                let displayIdx = (selectedIndex ?? (visibleRange.upperBound - 1)) - fullOffset
                if displayIdx >= 0 && displayIdx < macdHistSeries.count {
                    HStack(spacing: 6) {
                        let lineOffset = candles.count - macdLineSeries.count
                        let lineIdx = (selectedIndex ?? (visibleRange.upperBound - 1)) - lineOffset
                        if lineIdx >= 0 && lineIdx < macdLineSeries.count {
                            Text(String(format: "%.2f", macdLineSeries[lineIdx]))
                                .foregroundStyle(.blue)
                            Text(String(format: "%.2f", macdSignalSeries[lineIdx]))
                                .foregroundStyle(.orange)
                        }
                        let hist = macdHistSeries[displayIdx]
                        Text(String(format: "%.2f", hist))
                            .foregroundStyle(hist >= 0 ? .green : .red)
                    }
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                }
            }
            .padding(.horizontal, 2)

            GeometryReader { geo in
                let width = geo.size.width
                let height = subChartHeight - 14
                let step = width / CGFloat(visibleRange.count)
                let fullOffset = candles.count - macdHistSeries.count

                // Scale all MACD components together
                let allSeries = [macdHistSeries, macdLineSeries, macdSignalSeries]
                let allVisibleVals: [Double] = allSeries.flatMap { series in
                    let off = candles.count - series.count
                    return visibleRange.compactMap { idx in
                        let si = idx - off; return (si >= 0 && si < series.count) ? series[si] : nil
                    }
                }
                let maxAbs = allVisibleVals.map { abs($0) }.max() ?? 1
                let lo = -maxAbs
                let hi = maxAbs

                Canvas { context, size in
                    let midY = height / 2

                    // Zero line
                    var zp = Path()
                    zp.move(to: CGPoint(x: 0, y: midY))
                    zp.addLine(to: CGPoint(x: width, y: midY))
                    context.stroke(zp, with: .color(Color(.systemGray3)), style: StrokeStyle(lineWidth: 0.5))

                    // Histogram bars
                    let cw = max(1.5, step - 1.5)
                    for (localIdx, globalIdx) in visibleRange.enumerated() {
                        let si = globalIdx - fullOffset
                        guard si >= 0 && si < macdHistSeries.count else { continue }
                        let val = macdHistSeries[si]
                        let x = step * CGFloat(localIdx) + step / 2
                        let barH = CGFloat(abs(val) / maxAbs) * (height / 2 - 2)
                        let y = val >= 0 ? midY - barH : midY
                        context.fill(
                            Path(CGRect(x: x - cw / 2, y: y, width: cw, height: max(0.5, barH))),
                            with: .color(val >= 0 ? Color.green.opacity(0.4) : Color.red.opacity(0.4))
                        )
                    }

                    // MACD line + signal line
                    drawSubChartLine(context: &context, data: macdLineSeries, step: step, height: height, lo: lo, hi: hi, color: .blue.opacity(0.9))
                    drawSubChartLine(context: &context, data: macdSignalSeries, step: step, height: height, lo: lo, hi: hi, color: .orange.opacity(0.9))

                    // Selection crosshair
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        context.fill(Path(CGRect(x: x - step / 2, y: 0, width: step, height: height)), with: .color(Color.primary.opacity(0.08)))
                    }
                }
                .contentShape(Rectangle())
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.3)
                        .sequenced(before: DragGesture(minimumDistance: 0))
                        .onChanged { value in
                            switch value {
                            case .first(true): scrubMode = true
                            case .second(true, let drag):
                                if let drag { updateSelectedCandle(at: drag.location, step: step) }
                            default: break
                            }
                        }
                        .onEnded { _ in scrubMode = false; selectedIndex = nil }
                )
            }
            .frame(height: subChartHeight - 14)
        }
        .frame(height: subChartHeight)
        .padding(.top, spacing)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(.systemGray3), lineWidth: 0.5)
        )
    }

    // MARK: - ADX Panel

    private var adxPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Text("ADX").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                let offset = candles.count - adxSeries.count
                let displayIdx = (selectedIndex ?? (visibleRange.upperBound - 1)) - offset
                if displayIdx >= 0 && displayIdx < adxSeries.count {
                    HStack(spacing: 6) {
                        Text("ADX \(String(format: "%.0f", adxSeries[displayIdx]))")
                            .foregroundStyle(.secondary)
                        let diOffset = candles.count - plusDISeries.count
                        let diIdx = (selectedIndex ?? (visibleRange.upperBound - 1)) - diOffset
                        if diIdx >= 0 && diIdx < plusDISeries.count {
                            Text("+DI \(String(format: "%.0f", plusDISeries[diIdx]))")
                                .foregroundStyle(.green)
                            Text("-DI \(String(format: "%.0f", minusDISeries[diIdx]))")
                                .foregroundStyle(.red)
                        }
                    }
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                }
            }
            .padding(.horizontal, 2)

            GeometryReader { geo in
                let width = geo.size.width
                let height = subChartHeight - 14
                let step = width / CGFloat(visibleRange.count)

                // Auto-scale to visible data range
                let allVisible = [adxSeries, plusDISeries, minusDISeries].flatMap { series -> [Double] in
                    let off = candles.count - series.count
                    return visibleRange.compactMap { idx in
                        let si = idx - off; return (si >= 0 && si < series.count) ? series[si] : nil
                    }
                }
                let hi = max(50, (allVisible.max() ?? 50) * 1.1)
                let lo = 0.0

                Canvas { context, size in
                    // 20 and 40 reference lines
                    for level in [20.0, 40.0] {
                        let y = height * CGFloat(1.0 - (level - lo) / (hi - lo))
                        var lp = Path()
                        lp.move(to: CGPoint(x: 0, y: y))
                        lp.addLine(to: CGPoint(x: width, y: y))
                        context.stroke(lp, with: .color(Color(.systemGray3)), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                        context.draw(
                            Text(String(format: "%.0f", level)).font(.system(size: 7)).foregroundColor(.secondary),
                            at: CGPoint(x: 12, y: y), anchor: .center
                        )
                    }

                    // Weak trend zone (below 20)
                    let y20 = height * CGFloat(1.0 - (20.0 - lo) / (hi - lo))
                    context.fill(Path(CGRect(x: 0, y: y20, width: width, height: height - y20)), with: .color(.gray.opacity(0.06)))

                    // ADX line (yellow), +DI (green), -DI (red)
                    drawSubChartLine(context: &context, data: adxSeries, step: step, height: height, lo: lo, hi: hi, color: .yellow.opacity(0.9))
                    drawSubChartLine(context: &context, data: plusDISeries, step: step, height: height, lo: lo, hi: hi, color: .green.opacity(0.8))
                    drawSubChartLine(context: &context, data: minusDISeries, step: step, height: height, lo: lo, hi: hi, color: .red.opacity(0.8))

                    // Selection crosshair
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        context.fill(Path(CGRect(x: x - step / 2, y: 0, width: step, height: height)), with: .color(Color.primary.opacity(0.08)))
                    }
                }
                .contentShape(Rectangle())
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.3)
                        .sequenced(before: DragGesture(minimumDistance: 0))
                        .onChanged { value in
                            switch value {
                            case .first(true): scrubMode = true
                            case .second(true, let drag):
                                if let drag { updateSelectedCandle(at: drag.location, step: step) }
                            default: break
                            }
                        }
                        .onEnded { _ in scrubMode = false; selectedIndex = nil }
                )
            }
            .frame(height: subChartHeight - 14)
        }
        .frame(height: subChartHeight)
        .padding(.top, spacing)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(.systemGray3), lineWidth: 0.5)
        )
    }

    // MARK: - Volume Oscillator Panel

    private var volumeOscPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Volume").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                let offset = candles.count - volumeRatioSeries.count
                let displayIdx = (selectedIndex ?? (visibleRange.upperBound - 1)) - offset
                if displayIdx >= 0 && displayIdx < volumeRatioSeries.count {
                    let val = volumeRatioSeries[displayIdx]
                    Text(String(format: "%.1fx", val))
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(val >= 2.0 ? .orange : val >= 1.0 ? .primary : .secondary)
                }
            }
            .padding(.horizontal, 2)

            GeometryReader { geo in
                let width = geo.size.width
                let height = subChartHeight - 14
                let step = width / CGFloat(visibleRange.count)
                let fullOffset = candles.count - volumeRatioSeries.count

                // Scale: 0 to max visible ratio (at least 2.0)
                let visibleVals: [Double] = visibleRange.compactMap { idx in
                    let si = idx - fullOffset
                    guard si >= 0 && si < volumeRatioSeries.count else { return nil }
                    return volumeRatioSeries[si]
                }
                let maxVal = max(2.0, visibleVals.max() ?? 2.0)

                Canvas { context, size in
                    // 1x reference line
                    let avgY = height * CGFloat(1.0 - 1.0 / maxVal)
                    var ap = Path()
                    ap.move(to: CGPoint(x: 0, y: avgY))
                    ap.addLine(to: CGPoint(x: width, y: avgY))
                    context.stroke(ap, with: .color(Color(.systemGray3)), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                    context.draw(Text("1x").font(.system(size: 7)).foregroundColor(.secondary), at: CGPoint(x: 10, y: avgY), anchor: .center)

                    // 2x line
                    if maxVal >= 2.0 {
                        let y2x = height * CGFloat(1.0 - 2.0 / maxVal)
                        var tp = Path()
                        tp.move(to: CGPoint(x: 0, y: y2x))
                        tp.addLine(to: CGPoint(x: width, y: y2x))
                        context.stroke(tp, with: .color(.orange.opacity(0.3)), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                        context.draw(Text("2x").font(.system(size: 7)).foregroundColor(.orange.opacity(0.6)), at: CGPoint(x: 10, y: y2x), anchor: .center)
                    }

                    // Volume ratio bars — colored by candle direction (green = bullish, red = bearish)
                    let cw = max(1.5, step - 1.5)
                    for (localIdx, globalIdx) in visibleRange.enumerated() {
                        let si = globalIdx - fullOffset
                        guard si >= 0 && si < volumeRatioSeries.count else { continue }
                        let val = volumeRatioSeries[si]
                        let x = step * CGFloat(localIdx) + step / 2
                        let barH = CGFloat(val / maxVal) * height
                        let isUp = globalIdx < candles.count && candles[globalIdx].close >= candles[globalIdx].open
                        let color: Color = isUp ? .green.opacity(val >= 2.0 ? 0.7 : 0.4) : .red.opacity(val >= 2.0 ? 0.7 : 0.4)
                        context.fill(
                            Path(CGRect(x: x - cw / 2, y: height - barH, width: cw, height: max(0.5, barH))),
                            with: .color(color)
                        )
                    }

                    // Selection crosshair
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        context.fill(Path(CGRect(x: x - step / 2, y: 0, width: step, height: height)), with: .color(Color.primary.opacity(0.08)))
                    }
                }
                .contentShape(Rectangle())
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.3)
                        .sequenced(before: DragGesture(minimumDistance: 0))
                        .onChanged { value in
                            switch value {
                            case .first(true): scrubMode = true
                            case .second(true, let drag):
                                if let drag { updateSelectedCandle(at: drag.location, step: step) }
                            default: break
                            }
                        }
                        .onEnded { _ in scrubMode = false; selectedIndex = nil }
                )
            }
            .frame(height: subChartHeight - 14)
        }
        .frame(height: subChartHeight)
        .padding(.top, spacing)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(.systemGray3), lineWidth: 0.5)
        )
    }

    // MARK: - Helpers

    private func updateChartWidth(_ width: CGFloat) {
        if abs(chartWidth - width) > 1 {
            DispatchQueue.main.async { chartWidth = width }
        }
    }

    private func priceY(_ price: Double, height: CGFloat) -> CGFloat {
        let fraction = (priceMax - price) / (priceMax - priceMin)
        return height * CGFloat(fraction)
    }
}

