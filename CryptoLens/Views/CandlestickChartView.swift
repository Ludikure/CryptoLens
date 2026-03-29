import SwiftUI

struct CandlestickChartView: View {
    let results: [IndicatorResult]  // [tf1, tf2, tf3]
    @State private var selectedTab = 0
    @AppStorage("chart_show_ema") private var showEMA = true
    @AppStorage("chart_show_sr") private var showSR = true
    @AppStorage("chart_show_bb") private var showBB = false
    @State private var showOverlayMenu = false

    private var currentResult: IndicatorResult { results[selectedTab] }
    private var candles: [Candle] { currentResult.candles }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Timeframe picker + overlay toggle
            HStack(spacing: 0) {
                Text("Chart")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 4)

                // Overlay toggle
                Button { showOverlayMenu.toggle() } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 6)
                }
                .buttonStyle(.borderless)
                .popover(isPresented: $showOverlayMenu, arrowEdge: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Toggle("EMA 20/50", isOn: $showEMA)
                        Toggle("Support / Resistance", isOn: $showSR)
                        Toggle("Bollinger Bands", isOn: $showBB)
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
                    supports: showSR ? currentResult.supportResistance.supports : [],
                    resistances: showSR ? currentResult.supportResistance.resistances : [],
                    bollingerUpper: showBB ? currentResult.bollingerBands?.upper : nil,
                    bollingerLower: showBB ? currentResult.bollingerBands?.lower : nil,
                    candlePatterns: currentResult.candlePatterns
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
    let supports: [Double]
    let resistances: [Double]
    let bollingerUpper: Double?
    let bollingerLower: Double?
    let candlePatterns: [PatternResult]

    @State private var selectedIndex: Int?

    // Layout
    private let chartHeight: CGFloat = 180
    private let volumeHeight: CGFloat = 40
    private let spacing: CGFloat = 6

    private var priceMin: Double {
        let low = candles.map(\.low).min() ?? 0
        let range = priceRange
        return low - range * 0.02
    }
    private var priceMax: Double {
        let high = candles.map(\.high).max() ?? 0
        let range = priceRange
        return high + range * 0.02
    }
    private var priceRange: Double {
        let high = candles.map(\.high).max() ?? 1
        let low = candles.map(\.low).min() ?? 0
        return max(high - low, 0.0001)
    }
    private var volumeMax: Double {
        candles.map(\.volume).max() ?? 1
    }

    var body: some View {
        VStack(spacing: 0) {
            // Selected candle info
            if let idx = selectedIndex, idx < candles.count {
                selectedCandleInfo(candles[idx])
            } else if let last = candles.last {
                selectedCandleInfo(last)
            }

            // Price chart + volume
            GeometryReader { geo in
                let totalWidth = geo.size.width
                let candleWidth = max(2, (totalWidth / CGFloat(candles.count)) - 1.5)
                let step = totalWidth / CGFloat(candles.count)

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

                    // EMA polylines
                    emaPolyline(series: ema20Series, step: step, height: chartHeight, color: .orange.opacity(0.7))
                    emaPolyline(series: ema50Series, step: step, height: chartHeight, color: .blue.opacity(0.6))

                    // Candlesticks
                    ForEach(Array(candles.enumerated()), id: \.offset) { idx, candle in
                        let x = step * CGFloat(idx) + step / 2
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

                    // Pattern annotation on last candle
                    if !candlePatterns.isEmpty {
                        let lastX = step * CGFloat(candles.count - 1) + step / 2
                        let lastHigh = priceY(candles.last!.high, height: chartHeight)
                        let isBullish = candlePatterns.contains { $0.signal.lowercased().contains("bullish") }

                        Circle()
                            .fill(isBullish ? Color.green : Color.red)
                            .frame(width: 6, height: 6)
                            .position(x: lastX, y: lastHigh - 8)

                        Text(candlePatterns.first!.pattern)
                            .font(.system(size: 7, weight: .semibold))
                            .foregroundStyle(isBullish ? .green : .red)
                            .position(x: lastX, y: lastHigh - 18)
                    }

                    // Volume bars (below price)
                    ForEach(Array(candles.enumerated()), id: \.offset) { idx, candle in
                        let x = step * CGFloat(idx) + step / 2
                        let isUp = candle.close >= candle.open
                        let volH = CGFloat(candle.volume / volumeMax) * volumeHeight
                        let yOrigin = chartHeight + spacing + volumeHeight

                        Rectangle()
                            .fill((isUp ? Color.green : Color.red).opacity(0.3))
                            .frame(width: candleWidth, height: max(0.5, volH))
                            .position(x: x, y: yOrigin - volH / 2)
                    }

                    // Selection highlight
                    if let idx = selectedIndex, idx < candles.count {
                        let x = step * CGFloat(idx) + step / 2
                        Rectangle()
                            .fill(Color.primary.opacity(0.08))
                            .frame(width: step, height: chartHeight + spacing + volumeHeight)
                            .position(x: x, y: (chartHeight + spacing + volumeHeight) / 2)
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            let idx = Int(value.location.x / step)
                            if idx >= 0 && idx < candles.count {
                                selectedIndex = idx
                            }
                        }
                        .onEnded { _ in
                            selectedIndex = nil
                        }
                )
            }
            .frame(height: chartHeight + spacing + volumeHeight)
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
            Text(key).foregroundStyle(.tertiary)
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
                .stroke(Color(.systemGray4), style: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))

                Text(Formatters.formatPrice(price))
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
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
            .stroke(color.opacity(0.4), style: StrokeStyle(lineWidth: 0.7, dash: [3, 3]))

            Text(Formatters.formatPrice(value))
                .font(.system(size: 7))
                .foregroundStyle(color.opacity(0.7))
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
            let offset = candles.count - series.count
            Path { path in
                var started = false
                for i in 0..<series.count {
                    let x = step * CGFloat(i + offset) + step / 2
                    let y = priceY(series[i], height: height)
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

    // MARK: - Helpers

    private func priceY(_ price: Double, height: CGFloat) -> CGFloat {
        let fraction = (priceMax - price) / (priceMax - priceMin)
        return height * CGFloat(fraction)
    }
}
