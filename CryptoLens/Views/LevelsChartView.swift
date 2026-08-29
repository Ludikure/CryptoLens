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

    // Y-scale is driven by the CANDLES (+ current price), not the levels — a far setup level
    // (e.g. a 3-ATR TP2) used to compress 50 candles into a stripe. Levels beyond the candle
    // range are pinned to the top/bottom edge instead of stretching the axis. Hoisted into
    // stored bounds (was 3 computed properties re-scanning the arrays on every y() call).
    private let pMin: Double
    private let pMax: Double

    init(candles: [Candle], currentPrice: Double, levels: [WatchLevel], timeframeLabel: String) {
        self.candles = candles; self.currentPrice = currentPrice
        self.levels = levels; self.timeframeLabel = timeframeLabel
        let lo = (candles.map(\.low) + [currentPrice]).min() ?? currentPrice
        let hi = (candles.map(\.high) + [currentPrice]).max() ?? currentPrice
        let pad = max((hi - lo) * 0.04, hi * 0.0005)
        self.pMin = lo - pad
        self.pMax = hi + pad
    }

    private var range: Double { max(pMax - pMin, 1e-9) }
    private func y(_ p: Double, _ h: CGFloat) -> CGFloat {
        CGFloat((pMax - min(pMax, max(pMin, p))) / range) * h   // clamp off-range levels to the edge
    }

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
                            let col = (c.close >= c.open) ? Theme.bullish : Theme.bearish
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

                    // Watch levels — lines at true y; labels de-conflicted so clustered levels
                    // (VAH/POC/swing highs) don't render on top of each other in the gutter.
                    let labelYs = labelPositions(h)
                    ForEach(levels) { lvl in
                        let ly = y(lvl.price, h)
                        Path { p in p.move(to: CGPoint(x: 0, y: ly)); p.addLine(to: CGPoint(x: plotW, y: ly)) }
                            .stroke(lvl.role.color.opacity(lvl.proximity == .inPlay ? 0.95 : 0.55),
                                    style: StrokeStyle(lineWidth: lvl.proximity == .inPlay ? 1.6 : 1,
                                                       dash: lvl.role.isSetupLevel ? [4, 3] : []))
                        Text(labelText(lvl))
                            // Fixed point size on purpose (floor raised from 7-8pt for legibility, 2026-07-25):
                            // these labels are placed against fixed chart geometry, so Dynamic Type scaling
                            // would push them outside the plot area at the larger accessibility sizes.
                            .font(.system(size: 10, weight: lvl.proximity == .inPlay ? .bold : .regular))
                            .foregroundStyle(lvl.role.color)
                            .lineLimit(1)
                            .frame(width: labelGutter - 4, alignment: .leading)
                            .position(x: plotW + labelGutter / 2, y: labelYs[lvl.id] ?? min(h - 6, max(6, ly)))
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

    /// De-conflicted label Y positions keyed by level id: sort by natural y, then push each label
    /// down so no two are closer than `minGap`, and finally shift the whole stack up if it
    /// overflows the bottom — so clustered levels get readable, non-overlapping labels.
    private func labelPositions(_ h: CGFloat) -> [String: CGFloat] {
        let minGap: CGFloat = 12
        let ordered = levels
            .map { (id: $0.id, y: min(h - 6, max(6, y($0.price, h)))) }
            .sorted { $0.y < $1.y }
        var out: [String: CGFloat] = [:]
        var lastY: CGFloat = -.infinity
        for item in ordered {
            let placed = max(item.y, lastY + minGap)
            out[item.id] = placed
            lastY = placed
        }
        // If the stack ran past the bottom, slide it all up to fit.
        if let overflow = out.values.max(), overflow > h - 6 {
            let shift = overflow - (h - 6)
            for k in out.keys { out[k]! -= shift }
        }
        return out
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
