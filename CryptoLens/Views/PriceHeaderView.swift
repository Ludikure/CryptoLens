import SwiftUI

struct PriceHeaderView: View {
    let result: AnalysisResult
    var onSwipeLeft: (() -> Void)? = nil
    var onSwipeRight: (() -> Void)? = nil

    private var change24h: Double? {
        result.sentiment?.priceChangePercentage24h
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Formatters.formatPrice(result.daily.price))
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                if let change = change24h {
                    Text(Formatters.formatPercent(change))
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(change >= 0 ? .green : .red)
                }
                regimeBadge
            }

            HStack(spacing: 10) {
                CandleMomentumPill(label: "Daily", candles: result.daily.candles)
                CandleMomentumPill(label: "4H",    candles: result.h4.candles)
                CandleMomentumPill(label: "1H",    candles: result.h1.candles)
            }

            if let stats = outcomeStats, stats.resolvedSetups > 0 {
                HStack(spacing: 4) {
                    Text("\(stats.wins)W")
                        .foregroundStyle(.green)
                    Text("\(stats.losses)L")
                        .foregroundStyle(.red)
                }
                .font(.caption2)
            }
        }
        .frame(maxWidth: .infinity)
        .padding()
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 50, coordinateSpace: .local)
                .onEnded { value in
                    if value.translation.width < -50 {
                        onSwipeLeft?()
                    } else if value.translation.width > 50 {
                        onSwipeRight?()
                    }
                }
        )
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        .task {
            outcomeStats = OutcomeTracker.stats()
        }
    }

    @State private var outcomeStats: OutcomeStats?

    private enum RegimeType {
        case trending, ranging, transitioning

        var label: String {
            switch self {
            case .trending: return "TRENDING"
            case .ranging: return "RANGING"
            case .transitioning: return "TRANSITIONING"
            }
        }

        var color: Color {
            switch self {
            case .trending: return .blue
            case .ranging: return .orange
            case .transitioning: return .purple
            }
        }
    }

    private var regime: RegimeType {
        let adxVal = result.daily.adx?.adx ?? 0
        let e20 = result.daily.ema20 ?? 0
        let e50 = result.daily.ema50 ?? 0
        let e200 = result.daily.ema200 ?? 0
        let aligned = (e20 > e50 && e50 > e200) || (e20 < e50 && e50 < e200)
        if adxVal > 25 && aligned { return .trending }
        if adxVal < 20 { return .ranging }
        return .transitioning
    }

    @ViewBuilder
    private var regimeBadge: some View {
        Text(regime.label)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(regime.color)
            .background(regime.color.opacity(0.15), in: Capsule())
    }
}

/// Shows the color of the last 3 closed candles for a timeframe.
/// Green = close > open, red = close < open, grey = doji.
/// This is the raw momentum signal the LLM sees — no scoring formula.
struct CandleMomentumPill: View {
    let label: String
    let candles: [Candle]

    private var lastThree: [Candle] {
        Array(candles.suffix(3))
    }

    private func color(for candle: Candle) -> Color {
        if candle.close > candle.open { return .green }
        if candle.close < candle.open { return .red }
        return .secondary
    }

    private var summary: String {
        let greens = lastThree.filter { $0.close > $0.open }.count
        let reds   = lastThree.filter { $0.close < $0.open }.count
        if greens == lastThree.count && greens > 0 { return "↑" }
        if reds == lastThree.count && reds > 0    { return "↓" }
        return "~"
    }

    var body: some View {
        VStack(spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            HStack(spacing: 3) {
                ForEach(Array(lastThree.enumerated()), id: \.offset) { _, c in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(color(for: c))
                        .frame(width: 10, height: 14)
                }
                Text(summary)
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Color(.systemGray5), in: Capsule())
        }
        .accessibilityLabel("\(label) last 3 candles: \(summary)")
    }
}
