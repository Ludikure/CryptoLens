import SwiftUI

/// Mini candlestick chart with trade setup levels (Entry, SL, TP1-3) overlaid.
struct TradeSetupChartView: View {
    let candles: [Candle]
    let setup: TradeSetup
    let currentPrice: Double

    private let chartHeight: CGFloat = 160

    // Collect all setup levels for price range calculation
    private var allLevels: [Double] {
        var levels = [setup.entry, setup.stopLoss, setup.tp1]
        if let tp2 = setup.tp2 { levels.append(tp2) }
        if let tp3 = setup.tp3 { levels.append(tp3) }
        return levels
    }

    private var priceMin: Double {
        let candleLow = candles.map(\.low).min() ?? 0
        let levelLow = allLevels.min() ?? 0
        return min(candleLow, levelLow) * 0.998
    }

    private var priceMax: Double {
        let candleHigh = candles.map(\.high).max() ?? 0
        let levelHigh = allLevels.max() ?? 0
        return max(candleHigh, levelHigh) * 1.002
    }

    private var priceRange: Double { max(priceMax - priceMin, 0.0001) }
    private var isLong: Bool { setup.direction == "LONG" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: isLong ? "arrow.up.right" : "arrow.down.right")
                    .font(.caption).fontWeight(.bold)
                Text("\(setup.direction) Setup")
                    .font(.caption).fontWeight(.bold)
                Spacer()
                Text("R:R 1:\(String(format: "%.1f", setup.rrTP1))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .foregroundStyle(isLong ? .green : .red)

            // Chart
            GeometryReader { geo in
                let width = geo.size.width
                let candleCount = candles.count
                let step = candleCount > 0 ? width / CGFloat(candleCount) : width
                let candleWidth = max(2, step - 1.5)

                ZStack(alignment: .topLeading) {
                    // Setup zones (colored backgrounds)
                    setupZones(height: chartHeight, width: width)

                    // Setup level lines
                    setupLine(label: "Entry", price: setup.entry, color: .accentColor, height: chartHeight, width: width)
                    setupLine(label: "SL", price: setup.stopLoss, color: .red, height: chartHeight, width: width)
                    setupLine(label: "TP1", price: setup.tp1, color: .green, height: chartHeight, width: width)
                    if let tp2 = setup.tp2 {
                        setupLine(label: "TP2", price: tp2, color: .green.opacity(0.7), height: chartHeight, width: width)
                    }
                    if let tp3 = setup.tp3 {
                        setupLine(label: "TP3", price: tp3, color: .green.opacity(0.5), height: chartHeight, width: width)
                    }

                    // Current price line
                    currentPriceLine(height: chartHeight, width: width)

                    // Candlesticks
                    ForEach(Array(candles.enumerated()), id: \.offset) { idx, candle in
                        let x = step * CGFloat(idx) + step / 2
                        let isUp = candle.close >= candle.open

                        // Wick
                        Path { path in
                            path.move(to: CGPoint(x: x, y: priceY(candle.high)))
                            path.addLine(to: CGPoint(x: x, y: priceY(candle.low)))
                        }
                        .stroke(isUp ? Color.green.opacity(0.6) : Color.red.opacity(0.6), lineWidth: 0.8)

                        // Body
                        let bodyTop = priceY(max(candle.open, candle.close))
                        let bodyBot = priceY(min(candle.open, candle.close))
                        let bodyH = max(1, bodyBot - bodyTop)

                        Rectangle()
                            .fill(isUp ? Color.green.opacity(0.6) : Color.red.opacity(0.6))
                            .frame(width: candleWidth, height: bodyH)
                            .position(x: x, y: bodyTop + bodyH / 2)
                    }
                }
            }
            .frame(height: chartHeight)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Setup Zones

    private func setupZones(height: CGFloat, width: CGFloat) -> some View {
        let entryY = priceY(setup.entry)
        let slY = priceY(setup.stopLoss)
        let tp1Y = priceY(setup.tp1)

        return ZStack {
            // Risk zone (entry to SL) — red
            let riskTop = min(entryY, slY)
            let riskBot = max(entryY, slY)
            Rectangle()
                .fill(Color.red.opacity(0.06))
                .frame(width: width, height: max(0, riskBot - riskTop))
                .position(x: width / 2, y: (riskTop + riskBot) / 2)

            // Reward zone (entry to TP1) — green
            let rewardTop = min(entryY, tp1Y)
            let rewardBot = max(entryY, tp1Y)
            Rectangle()
                .fill(Color.green.opacity(0.06))
                .frame(width: width, height: max(0, rewardBot - rewardTop))
                .position(x: width / 2, y: (rewardTop + rewardBot) / 2)
        }
    }

    // MARK: - Level Lines

    private func setupLine(label: String, price: Double, color: Color, height: CGFloat, width: CGFloat) -> some View {
        let y = priceY(price)
        return ZStack(alignment: .topLeading) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: width, y: y))
            }
            .stroke(color, style: StrokeStyle(lineWidth: 1, dash: label == "Entry" ? [] : [4, 3]))

            // Label + price on right
            HStack(spacing: 3) {
                Text(label)
                    .font(.system(size: 8, weight: .bold))
                Text(Formatters.formatPrice(price))
                    .font(.system(size: 8))
            }
            .foregroundStyle(color)
            .padding(.horizontal, 3)
            .padding(.vertical, 1)
            .background(Color(.systemBackground).opacity(0.85), in: RoundedRectangle(cornerRadius: 2))
            .position(x: width - 40, y: y - 8)
        }
    }

    // MARK: - Current Price

    private func currentPriceLine(height: CGFloat, width: CGFloat) -> some View {
        let y = priceY(currentPrice)
        return ZStack {
            Path { path in
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: width, y: y))
            }
            .stroke(Color.primary.opacity(0.4), style: StrokeStyle(lineWidth: 0.8, dash: [2, 2]))

            Text(Formatters.formatPrice(currentPrice))
                .font(.system(size: 7, weight: .semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .background(Color(.systemBackground).opacity(0.85), in: RoundedRectangle(cornerRadius: 2))
                .position(x: 35, y: y - 8)
        }
    }

    // MARK: - Helpers

    private func priceY(_ price: Double) -> CGFloat {
        let fraction = (priceMax - price) / priceRange
        return chartHeight * CGFloat(fraction)
    }
}
