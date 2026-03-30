import SwiftUI

struct SentimentView: View {
    let info: CoinInfo
    let symbol: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Market Sentiment", systemImage: "gauge.medium")
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)

            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 8) {
                sentimentItem("24h", value: info.priceChangePercentage24h ?? 0)
                sentimentItem("7d", value: info.priceChangePercentage7d ?? 0)
                sentimentItem("14d", value: info.priceChangePercentage14d ?? 0)
                sentimentItem("30d", value: info.priceChangePercentage30d ?? 0)
            }

            Divider()

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("ATH").font(.caption2).foregroundStyle(.tertiary)
                    Text(Formatters.formatPrice(info.ath))
                        .font(.caption).fontWeight(.medium)
                }
                Spacer()
                VStack(alignment: .center, spacing: 2) {
                    Text("ATH Dist").font(.caption2).foregroundStyle(.tertiary)
                    Text(Formatters.formatPercent(info.athChangePercentage))
                        .font(.caption).fontWeight(.medium).foregroundStyle(.red)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("24h Range").font(.caption2).foregroundStyle(.tertiary)
                    Text("\(Formatters.formatPrice(info.low24h)) – \(Formatters.formatPrice(info.high24h))")
                        .font(.caption).fontWeight(.medium)
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func sentimentItem(_ label: String, value: Double) -> some View {
        VStack(spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Text(Formatters.formatPercent(value))
                .font(.callout)
                .fontWeight(.semibold)
                .foregroundStyle(value >= 0 ? .green : .red)
        }
    }
}
