import SwiftUI

/// A compact candlestick chart that draws the analysis's *watch levels* as labeled horizontal lines,
/// shown directly beneath the AI analysis. It answers "where is price relative to the levels the
/// text is talking about?" — resistance/support, VWAP, POC/value area, and your setup's entry/stop/
/// targets — colored by role, bold when in play, dashed for your own setup lines.
struct LevelsChartView: View {
    let candles: [Candle]
    let currentPrice: Double
    let levels: [WatchLevel]
    let timeframeLabel: String

    private let chartHeight: CGFloat = 300
    private let labelGutter: CGFloat = 92

    private var pMin: Double {
        ((candles.map(\.low) + levels.map(\.price) + [currentPrice]).min() ?? currentPrice) * 0.999
    }
    private var pMax: Double {
        ((candles.map(\.high) + levels.map(\.price) + [currentPrice]).max() ?? currentPrice) * 1.001
    }
    private var range: Double { max(pMax - pMin, 1e-9) }
    private func y(_ p: Double, _ h: CGFloat) -> CGFloat { CGFloat((pMax - p) / range) * h }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Levels to watch", systemImage: "chart.line.uptrend.xyaxis")
                    .font(.subheadline).fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(timeframeLabel).font(.caption2).foregroundStyle(.secondary)
            }

            GeometryReader { geo in
                let h = geo.size.height
                let plotW = max(10, geo.size.width - labelGutter)
                ZStack(alignment: .topLeading) {
                    // Candles
                    Canvas { ctx, _ in
                        guard !candles.isEmpty else { return }
                        let step = plotW / CGFloat(candles.count)
                        let bw = max(1.5, step * 0.6)
                        for (i, c) in candles.enumerated() {
                            let x = CGFloat(i) * step + step / 2
                            let col = (c.close >= c.open) ? Color.green : Color.red
                            var wick = Path()
                            wick.move(to: CGPoint(x: x, y: y(c.high, h)))
                            wick.addLine(to: CGPoint(x: x, y: y(c.low, h)))
                            ctx.stroke(wick, with: .color(col.opacity(0.8)), lineWidth: 1)
                            let yO = y(c.open, h), yC = y(c.close, h)
                            ctx.fill(Path(CGRect(x: x - bw / 2, y: min(yO, yC), width: bw, height: max(1, abs(yO - yC)))),
                                     with: .color(col))
                        }
                    }
                    .frame(width: plotW, height: h)

                    // Current price (dashed neutral)
                    Path { p in
                        let cy = y(currentPrice, h)
                        p.move(to: CGPoint(x: 0, y: cy)); p.addLine(to: CGPoint(x: plotW, y: cy))
                    }
                    .stroke(Color.primary.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [2, 2]))

                    // Watch levels
                    ForEach(levels) { lvl in
                        let ly = y(lvl.price, h)
                        Path { p in p.move(to: CGPoint(x: 0, y: ly)); p.addLine(to: CGPoint(x: plotW, y: ly)) }
                            .stroke(lvl.role.color.opacity(lvl.proximity == .inPlay ? 0.95 : 0.55),
                                    style: StrokeStyle(lineWidth: lvl.proximity == .inPlay ? 1.6 : 1,
                                                       dash: lvl.role.isSetupLevel ? [4, 3] : []))
                        Text(labelText(lvl))
                            .font(.system(size: 9, weight: lvl.proximity == .inPlay ? .bold : .regular))
                            .foregroundStyle(lvl.role.color)
                            .lineLimit(1)
                            .frame(width: labelGutter - 4, alignment: .leading)
                            .position(x: plotW + labelGutter / 2, y: min(h - 6, max(6, ly)))
                    }
                }
            }
            .frame(height: chartHeight)

            Text("Solid = structure · dashed = your setup · bold = in play now")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func labelText(_ lvl: WatchLevel) -> String {
        let tag: String
        switch lvl.role {
        case .resistance: tag = "R"
        case .support:    tag = "S"
        default:          tag = lvl.label   // VWAP / POC / VAH / VAL / Entry / Stop / TP1 / TP2
        }
        return "\(tag) \(Formatters.formatPrice(lvl.price))"
    }
}
