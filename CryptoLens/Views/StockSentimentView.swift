import SwiftUI

/// Stock sentiment card — VIX, short interest, 52-week position.
struct StockSentimentView: View {
    let sentiment: StockSentimentData

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Market Sentiment", systemImage: "chart.bar.doc.horizontal")
                .font(.subheadline).fontWeight(.semibold).foregroundStyle(.secondary)

            // VIX
            if let vix = sentiment.vix {
                HStack {
                    HStack(spacing: 3) {
                        Text("VIX").font(.caption).foregroundStyle(.secondary)
                        InfoTooltip(title: "VIX", explanation: Tooltips.vix)
                    }
                    Spacer()
                    Text(String(format: "%.1f", vix))
                        .font(.callout).fontWeight(.semibold)
                        .foregroundStyle(vixColor(vix))
                    Text(sentiment.vixLevel)
                        .font(.caption2).foregroundStyle(vixColor(vix))
                    if let change = sentiment.vixChange {
                        Text(Formatters.formatPercent(change))
                            .font(.caption2).foregroundStyle(change >= 0 ? .red : .green)
                    }
                }
            }

            // Short Interest
            if let shortPct = sentiment.shortPercentOfFloat {
                HStack {
                    HStack(spacing: 3) {
                        Text("Short Interest").font(.caption).foregroundStyle(.secondary)
                        InfoTooltip(title: "Short Interest", explanation: Tooltips.shortInterest)
                    }
                    Spacer()
                    Text(String(format: "%.1f%% of float", shortPct))
                        .font(.caption).fontWeight(.semibold)
                        .foregroundStyle(shortPct > 20 ? .red : (shortPct > 10 ? .orange : .primary))
                    if let daysToCovert = sentiment.shortRatio {
                        Text(String(format: "%.1fd to cover", daysToCovert))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if shortPct > 20 {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill").font(.caption2)
                        Text("Heavily shorted — squeeze candidate")
                            .font(.caption2)
                    }
                    .foregroundStyle(.orange)
                }
            }

            // 52-Week Position
            VStack(spacing: 4) {
                HStack {
                    HStack(spacing: 3) {
                        Text("52-Week Position").font(.caption).foregroundStyle(.secondary)
                        InfoTooltip(title: "52-Week Range", explanation: Tooltips.fiftyTwoWeekRange)
                    }
                    Spacer()
                    Text(String(format: "%.0f%%", sentiment.fiftyTwoWeekPosition))
                        .font(.caption).fontWeight(.semibold)
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color(.systemGray5)).frame(height: 4)
                        Capsule()
                            .fill(positionColor(sentiment.fiftyTwoWeekPosition))
                            .frame(width: geo.size.width * CGFloat(sentiment.fiftyTwoWeekPosition / 100), height: 4)
                    }
                }
                .frame(height: 4)
                HStack {
                    Text("52w Low").font(.system(size: 8)).foregroundStyle(.tertiary)
                    Spacer()
                    Text("52w High").font(.system(size: 8)).foregroundStyle(.tertiary)
                }
            }

            // Put/Call Ratio
            if let pcr = sentiment.putCallRatio {
                HStack {
                    HStack(spacing: 3) {
                        Text("Put/Call Ratio").font(.caption).foregroundStyle(.secondary)
                        InfoTooltip(title: "Put/Call Ratio", explanation: Tooltips.putCallRatio)
                    }
                    Spacer()
                    Text(String(format: "%.2f", pcr))
                        .font(.caption).fontWeight(.semibold)
                        .foregroundStyle(pcr > 1.0 ? .orange : (pcr < 0.7 ? .green : .primary))
                    Text(pcr > 1.0 ? "Bearish sentiment" : (pcr < 0.7 ? "Complacent" : "Neutral"))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func vixColor(_ vix: Double) -> Color {
        if vix > 35 { return .red }
        if vix > 25 { return .orange }
        if vix < 15 { return .green }
        return .primary
    }

    private func positionColor(_ pct: Double) -> Color {
        if pct > 80 { return .green }
        if pct < 20 { return .red }
        return .accentColor
    }
}
