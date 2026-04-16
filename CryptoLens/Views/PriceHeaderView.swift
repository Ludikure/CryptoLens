import SwiftUI

struct PriceHeaderView: View {
    let result: AnalysisResult

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
            }

            HStack(spacing: 10) {
                CandleMomentumPill(label: "Daily", candles: result.daily.candles)
                CandleMomentumPill(label: "4H",    candles: result.h4.candles)
                CandleMomentumPill(label: "1H",    candles: result.h1.candles)
            }
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
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
