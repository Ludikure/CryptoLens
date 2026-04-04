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
                        Toggle("RSI", isOn: $showRSI)
                        Toggle("MACD", isOn: $showMACD)
                        Toggle("Stoch RSI", isOn: $showStochRSI)
                        Toggle("ADX / DI", isOn: $showADX)
                        Toggle("Volume", isOn: $showVolOsc)
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
    @GestureState private var liveDragOffset: CGFloat = 0
    @State private var chartWidth: CGFloat = 350

    // Layout
    private let chartHeight: CGFloat = 240
    private let volumeHeight: CGFloat = 40
    private let subChartHeight: CGFloat = 120
    private let spacing: CGFloat = 6
    private let minVisibleCandles = 15
    private let maxVisibleCandles = 200

    private var subChartCount: Int {
        (rsiSeries.isEmpty ? 0 : 1) + (macdHistSeries.isEmpty ? 0 : 1) + (stochKSeries.isEmpty ? 0 : 1) + (adxSeries.isEmpty ? 0 : 1) + (volumeRatioSeries.isEmpty ? 0 : 1)
    }
    private var totalHeight: CGFloat {
        chartHeight + spacing + volumeHeight + CGFloat(subChartCount) * (spacing + subChartHeight)
    }

    /// Effective visible count accounting for live pinch gesture
    private var effectiveVisibleCount: Int {
        let scaled = livePinchScale != 1.0 ? Int(Double(visibleCount) / livePinchScale) : visibleCount
        return min(maxVisibleCandles, max(minVisibleCandles, scaled))
    }

    /// Effective scroll offset accounting for live drag gesture
    private var effectiveScrollOffset: Int {
        if liveDragOffset == 0 { return scrollOffset }
        let candlesPerPoint = Double(effectiveVisibleCount) / max(1, Double(chartWidth))
        let draggedCandles = Int(Double(liveDragOffset) * candlesPerPoint)
        return max(0, min(candles.count - effectiveVisibleCount, scrollOffset + draggedCandles))
    }

    private var visibleRange: Range<Int> {
        let total = candles.count
        let count = min(effectiveVisibleCount, total)
        let end = max(count, total - effectiveScrollOffset)
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
    private var volumeMax: Double {
        visibleCandles.map(\.volume).max() ?? 1
    }

    var body: some View {
        VStack(spacing: 0) {
            // Selected candle info
            if let idx = selectedIndex, visibleRange.contains(idx) {
                selectedCandleInfo(candles[idx])
            } else if let last = visibleCandles.last {
                selectedCandleInfo(last)
            }

            // Price chart + volume
            GeometryReader { geo in
                let totalWidth = geo.size.width
                let _ = updateChartWidth(totalWidth)
                let vCount = visibleRange.count
                let candleWidth = max(2, (totalWidth / CGFloat(vCount)) - 1.5)
                let step = totalWidth / CGFloat(vCount)

                ZStack(alignment: .topLeading) {
                    // Price grid lines
                    priceGrid(height: chartHeight, width: totalWidth)

                    // Bollinger bands fill
                    if let bbUpper = bollingerUpper, let bbLower = bollingerLower {
                        bollingerBandOverlay(upper: bbUpper, lower: bbLower, height: chartHeight, width: totalWidth)
                    }

                    // S/R levels
                    ForEach(Array(visibleSupports.enumerated()), id: \.offset) { _, level in
                        srLine(value: level, height: chartHeight, width: totalWidth, color: .green)
                    }
                    ForEach(Array(visibleResistances.enumerated()), id: \.offset) { _, level in
                        srLine(value: level, height: chartHeight, width: totalWidth, color: .red)
                    }

                    // EMA polylines (sliced to visible range)
                    emaPolyline(series: ema200Series, step: step, height: chartHeight, color: .purple.opacity(0.7))
                    emaPolyline(series: ema50Series, step: step, height: chartHeight, color: .blue.opacity(0.75))
                    emaPolyline(series: ema20Series, step: step, height: chartHeight, color: .orange.opacity(0.85))

                    // Candlesticks
                    ForEach(Array(visibleCandles.enumerated()), id: \.offset) { localIdx, candle in
                        let x = step * CGFloat(localIdx) + step / 2
                        let isUp = candle.close >= candle.open

                        // Wick
                        Path { path in
                            let yHigh = priceY(candle.high, height: chartHeight)
                            let yLow = priceY(candle.low, height: chartHeight)
                            path.move(to: CGPoint(x: x, y: yHigh))
                            path.addLine(to: CGPoint(x: x, y: yLow))
                        }
                        .stroke(isUp ? Color.green : Color.red, lineWidth: 1)

                        // Body
                        let bodyTop = priceY(max(candle.open, candle.close), height: chartHeight)
                        let bodyBot = priceY(min(candle.open, candle.close), height: chartHeight)
                        let bodyHeight = max(1, bodyBot - bodyTop)

                        Rectangle()
                            .fill(isUp ? Color.green : Color.red)
                            .frame(width: candleWidth, height: bodyHeight)
                            .position(x: x, y: bodyTop + bodyHeight / 2)
                    }

                    // Pattern annotation on last visible candle
                    if let firstPattern = candlePatterns.first,
                       visibleRange.contains(candles.count - 1),
                       let lastCandle = candles.last {
                        let localIdx = candles.count - 1 - visibleRange.lowerBound
                        let lastX = step * CGFloat(localIdx) + step / 2
                        let lastHigh = priceY(lastCandle.high, height: chartHeight)
                        let isBullish = candlePatterns.contains { $0.signal.lowercased().contains("bullish") }

                        Circle()
                            .fill(isBullish ? Color.green : Color.red)
                            .frame(width: 6, height: 6)
                            .position(x: lastX, y: lastHigh - 8)

                        Text(firstPattern.pattern)
                            .font(.system(size: 7, weight: .semibold))
                            .foregroundStyle(isBullish ? .green : .red)
                            .position(x: lastX, y: lastHigh - 18)
                    }

                    // Volume bars (below price)
                    ForEach(Array(visibleCandles.enumerated()), id: \.offset) { localIdx, candle in
                        let x = step * CGFloat(localIdx) + step / 2
                        let isUp = candle.close >= candle.open
                        let volH = CGFloat(candle.volume / volumeMax) * volumeHeight
                        let yOrigin = chartHeight + spacing + volumeHeight

                        Rectangle()
                            .fill((isUp ? Color.green : Color.red).opacity(0.3))
                            .frame(width: candleWidth, height: max(0.5, volH))
                            .position(x: x, y: yOrigin - volH / 2)
                    }

                    // Selection highlight
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        Rectangle()
                            .fill(Color.primary.opacity(0.08))
                            .frame(width: step, height: chartHeight + spacing + volumeHeight)
                            .position(x: x, y: (chartHeight + spacing + volumeHeight) / 2)
                    }

                    // "Go to latest" button when scrolled back
                    if scrollOffset > 0 {
                        VStack {
                            Spacer()
                            HStack {
                                Spacer()
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
                    }
                }
                .contentShape(Rectangle())
                // Pinch to zoom — runs simultaneously, no delay
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
                // Pan to scroll — runs simultaneously, low minimum distance
                .simultaneousGesture(
                    DragGesture(minimumDistance: 8)
                        .updating($liveDragOffset) { value, state, _ in
                            state = value.translation.width
                        }
                        .onEnded { value in
                            let candlesPerPoint = Double(effectiveVisibleCount) / max(1, Double(chartWidth))
                            let candlesDragged = Int(Double(value.translation.width) * candlesPerPoint)
                            scrollOffset = max(0, min(candles.count - visibleCount, scrollOffset + candlesDragged))
                        }
                )
                // Long press + drag to scrub candles
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.25)
                        .sequenced(before: DragGesture(minimumDistance: 0))
                        .onChanged { value in
                            switch value {
                            case .first(true):
                                scrubMode = true
                            case .second(true, let drag):
                                if let drag {
                                    let localIdx = Int(drag.location.x / step)
                                    let globalIdx = localIdx + visibleRange.lowerBound
                                    if globalIdx >= visibleRange.lowerBound && globalIdx < visibleRange.upperBound {
                                        selectedIndex = globalIdx
                                    }
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
            .frame(height: chartHeight + spacing + volumeHeight)
            .drawingGroup()
            .clipped()

            // Sub-charts
            subCharts
        }
        .onChange(of: candles.count) { _, newCount in
            // Reset viewport when switching timeframes
            visibleCount = min(80, newCount)
            scrollOffset = 0
            selectedIndex = nil
            scrubMode = false
        }
    }

    // MARK: - S/R levels within visible range

    private var visibleSupports: [Double] {
        supports.filter { $0 >= priceMin && $0 <= priceMax }
    }
    private var visibleResistances: [Double] {
        resistances.filter { $0 >= priceMin && $0 <= priceMax }
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

    // MARK: - Price Grid

    private func priceGrid(height: CGFloat, width: CGFloat) -> some View {
        let lines = 3
        return ForEach(0...lines, id: \.self) { i in
            let fraction = Double(i) / Double(lines)
            let price = priceMax - fraction * (priceMax - priceMin)
            let y = height * CGFloat(fraction)

            ZStack(alignment: .topLeading) {
                Path { path in
                    path.move(to: CGPoint(x: 0, y: y))
                    path.addLine(to: CGPoint(x: width, y: y))
                }
                .stroke(Color(.systemGray3), style: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))

                Text(Formatters.formatPrice(price))
                    .font(.system(size: 8))
                    .foregroundStyle(.secondary)
                    .offset(y: y - 10)
            }
        }
    }

    // MARK: - S/R Line

    private func srLine(value: Double, height: CGFloat, width: CGFloat, color: Color) -> some View {
        let y = priceY(value, height: height)
        return ZStack(alignment: .trailing) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: width, y: y))
            }
            .stroke(color.opacity(0.6), style: StrokeStyle(lineWidth: 0.7, dash: [3, 3]))

            Text(Formatters.formatPrice(value))
                .font(.system(size: 7))
                .foregroundStyle(color.opacity(0.85))
                .offset(x: width - 4, y: y - 8)
        }
    }

    // MARK: - Bollinger Bands

    private func bollingerBandOverlay(upper: Double, lower: Double, height: CGFloat, width: CGFloat) -> some View {
        let yUpper = priceY(upper, height: height)
        let yLower = priceY(lower, height: height)
        return Rectangle()
            .fill(Color.purple.opacity(0.04))
            .frame(width: width, height: max(0, yLower - yUpper))
            .position(x: width / 2, y: (yUpper + yLower) / 2)
    }

    // MARK: - EMA Polyline

    @ViewBuilder
    private func emaPolyline(series: [Double], step: CGFloat, height: CGFloat, color: Color) -> some View {
        if series.count >= 2 {
            // Align series to candles: series may be shorter than candles (warmup period)
            let fullOffset = candles.count - series.count
            Path { path in
                var started = false
                for globalIdx in visibleRange {
                    let seriesIdx = globalIdx - fullOffset
                    guard seriesIdx >= 0 && seriesIdx < series.count else { continue }
                    let localIdx = globalIdx - visibleRange.lowerBound
                    let x = step * CGFloat(localIdx) + step / 2
                    let y = priceY(series[seriesIdx], height: height)
                    if !started {
                        path.move(to: CGPoint(x: x, y: y))
                        started = true
                    } else {
                        path.addLine(to: CGPoint(x: x, y: y))
                    }
                }
            }
            .stroke(color, lineWidth: 1.2)
        }
    }

    // MARK: - Sub-Charts

    @ViewBuilder
    private var subCharts: some View {
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
        if !volumeRatioSeries.isEmpty {
            volumeOscPanel
        }
    }

    private func oscillatorPanel(title: String, series: [([Double], Color)], range: ClosedRange<Double>, levels: [Double], highlightBand: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                if let mainSeries = series.first?.0 {
                    let offset = candles.count - mainSeries.count
                    // Show value at selected candle, or fall back to last visible
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
                let lo = range.lowerBound
                let hi = range.upperBound

                ZStack(alignment: .topLeading) {
                    // Band fill between levels (TradingView style)
                    if levels.count == 2 {
                        let yTop = height * CGFloat(1.0 - (levels[1] - lo) / (hi - lo))
                        let yBot = height * CGFloat(1.0 - (levels[0] - lo) / (hi - lo))
                        if highlightBand {
                            // RSI style: highlight the neutral band between levels
                            Rectangle()
                                .fill(Color.purple.opacity(0.06))
                                .frame(width: width, height: yBot - yTop)
                                .position(x: width / 2, y: yTop + (yBot - yTop) / 2)
                        } else {
                            // StochRSI style: highlight overbought/oversold zones
                            Rectangle()
                                .fill(Color.red.opacity(0.04))
                                .frame(width: width, height: yTop)
                                .position(x: width / 2, y: yTop / 2)
                            Rectangle()
                                .fill(Color.green.opacity(0.04))
                                .frame(width: width, height: height - yBot)
                                .position(x: width / 2, y: yBot + (height - yBot) / 2)
                        }
                    }

                    ForEach(levels, id: \.self) { level in
                        let y = height * CGFloat(1.0 - (level - lo) / (hi - lo))
                        Path { p in
                            p.move(to: CGPoint(x: 0, y: y))
                            p.addLine(to: CGPoint(x: width, y: y))
                        }
                        .stroke(Color(.systemGray3), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))

                        Text(String(format: "%.0f", level))
                            .font(.system(size: 7))
                            .foregroundStyle(.secondary)
                            .position(x: 12, y: y)
                    }

                    ForEach(Array(series.enumerated()), id: \.offset) { _, seriesData in
                        let (data, color) = seriesData
                        seriesLine(data: data, step: step, height: height, lo: lo, hi: hi, color: color)
                    }

                    // Selection crosshair — extends from main chart
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        Rectangle()
                            .fill(Color.primary.opacity(0.08))
                            .frame(width: step, height: height)
                            .position(x: x, y: height / 2)

                        // Value dot on the main series line
                        if let mainSeries = series.first?.0 {
                            let seriesIdx = idx - (candles.count - mainSeries.count)
                            if seriesIdx >= 0 && seriesIdx < mainSeries.count {
                                let y = height * CGFloat(1.0 - (mainSeries[seriesIdx] - lo) / (hi - lo))
                                Circle()
                                    .fill(series.first!.1)
                                    .frame(width: 5, height: 5)
                                    .position(x: x, y: y)
                            }
                        }
                    }
                }
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

    /// Draw a series line aligned to candle positions in the visible range
    @ViewBuilder
    private func seriesLine(data: [Double], step: CGFloat, height: CGFloat, lo: Double, hi: Double, color: Color) -> some View {
        if data.count >= 2 {
            let fullOffset = candles.count - data.count
            Path { path in
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
            }
            .stroke(color, lineWidth: 1.0)
        }
    }

    private var macdPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Text("MACD").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                // Show MACD line, signal, and histogram values
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

                ZStack(alignment: .topLeading) {
                    let midY = height / 2
                    Path { p in
                        p.move(to: CGPoint(x: 0, y: midY))
                        p.addLine(to: CGPoint(x: width, y: midY))
                    }
                    .stroke(Color(.systemGray3), style: StrokeStyle(lineWidth: 0.5))

                    // Histogram bars
                    let candleWidth = max(1.5, step - 1.5)
                    ForEach(Array(visibleRange.enumerated()), id: \.offset) { localIdx, globalIdx in
                        let si = globalIdx - fullOffset
                        if si >= 0 && si < macdHistSeries.count {
                            let val = macdHistSeries[si]
                            let x = step * CGFloat(localIdx) + step / 2
                            let barH = CGFloat(abs(val) / maxAbs) * (height / 2 - 2)
                            let y = val >= 0 ? midY - barH : midY

                            Rectangle()
                                .fill(val >= 0 ? Color.green.opacity(0.4) : Color.red.opacity(0.4))
                                .frame(width: candleWidth, height: max(0.5, barH))
                                .position(x: x, y: y + max(0.5, barH) / 2)
                        }
                    }

                    // MACD line (blue)
                    seriesLine(data: macdLineSeries, step: step, height: height, lo: lo, hi: hi, color: .blue.opacity(0.9))
                    // Signal line (orange)
                    seriesLine(data: macdSignalSeries, step: step, height: height, lo: lo, hi: hi, color: .orange.opacity(0.9))

                    // Selection crosshair
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        Rectangle()
                            .fill(Color.primary.opacity(0.08))
                            .frame(width: step, height: height)
                            .position(x: x, y: height / 2)
                    }
                }
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

                ZStack(alignment: .topLeading) {
                    // 20 and 40 reference lines
                    ForEach([20.0, 40.0], id: \.self) { level in
                        let y = height * CGFloat(1.0 - (level - lo) / (hi - lo))
                        Path { p in p.move(to: CGPoint(x: 0, y: y)); p.addLine(to: CGPoint(x: width, y: y)) }
                            .stroke(Color(.systemGray3), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                        Text(String(format: "%.0f", level))
                            .font(.system(size: 7)).foregroundStyle(.secondary)
                            .position(x: 12, y: y)
                    }

                    // Trend strength zone (below 20 = weak)
                    let y20 = height * CGFloat(1.0 - (20.0 - lo) / (hi - lo))
                    Rectangle()
                        .fill(Color.gray.opacity(0.06))
                        .frame(width: width, height: height - y20)
                        .position(x: width / 2, y: y20 + (height - y20) / 2)

                    // ADX line (white/yellow — trend strength)
                    seriesLine(data: adxSeries, step: step, height: height, lo: lo, hi: hi, color: .yellow.opacity(0.9))
                    // +DI line (green)
                    seriesLine(data: plusDISeries, step: step, height: height, lo: lo, hi: hi, color: .green.opacity(0.8))
                    // -DI line (red)
                    seriesLine(data: minusDISeries, step: step, height: height, lo: lo, hi: hi, color: .red.opacity(0.8))

                    // Selection crosshair
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        Rectangle()
                            .fill(Color.primary.opacity(0.08))
                            .frame(width: step, height: height)
                            .position(x: x, y: height / 2)
                    }
                }
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
                Text("Vol Ratio").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
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

                ZStack(alignment: .topLeading) {
                    // 1.0x reference line (average)
                    let avgY = height * CGFloat(1.0 - 1.0 / maxVal)
                    Path { p in p.move(to: CGPoint(x: 0, y: avgY)); p.addLine(to: CGPoint(x: width, y: avgY)) }
                        .stroke(Color(.systemGray3), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                    Text("1x").font(.system(size: 7)).foregroundStyle(.secondary)
                        .position(x: 10, y: avgY)

                    // 2x line
                    if maxVal >= 2.0 {
                        let y2x = height * CGFloat(1.0 - 2.0 / maxVal)
                        Path { p in p.move(to: CGPoint(x: 0, y: y2x)); p.addLine(to: CGPoint(x: width, y: y2x)) }
                            .stroke(Color.orange.opacity(0.3), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
                        Text("2x").font(.system(size: 7)).foregroundStyle(.orange.opacity(0.6))
                            .position(x: 10, y: y2x)
                    }

                    // Volume ratio bars
                    let candleWidth = max(1.5, step - 1.5)
                    ForEach(Array(visibleRange.enumerated()), id: \.offset) { localIdx, globalIdx in
                        let si = globalIdx - fullOffset
                        if si >= 0 && si < volumeRatioSeries.count {
                            let val = volumeRatioSeries[si]
                            let x = step * CGFloat(localIdx) + step / 2
                            let barH = CGFloat(val / maxVal) * height
                            let color: Color = val >= 2.0 ? .orange.opacity(0.7) : val >= 1.0 ? .blue.opacity(0.5) : .blue.opacity(0.3)

                            Rectangle()
                                .fill(color)
                                .frame(width: candleWidth, height: max(0.5, barH))
                                .position(x: x, y: height - barH / 2)
                        }
                    }

                    // Selection crosshair
                    if let idx = selectedIndex, visibleRange.contains(idx) {
                        let localIdx = idx - visibleRange.lowerBound
                        let x = step * CGFloat(localIdx) + step / 2
                        Rectangle()
                            .fill(Color.primary.opacity(0.08))
                            .frame(width: step, height: height)
                            .position(x: x, y: height / 2)
                    }
                }
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
