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
                BiasPill(label: "Daily", bias: result.daily.bias, percent: result.daily.bullPercent)
                BiasPill(label: "4H", bias: result.h4.bias, percent: result.h4.bullPercent)
                BiasPill(label: "1H", bias: result.h1.bias, percent: result.h1.bullPercent)
            }
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct BiasPill: View {
    let label: String
    let bias: String
    let percent: Double

    private var color: Color {
        switch bias {
        case "Strong Bullish", "Bullish": return Color(.systemGreen).opacity(0.15)
        case "Strong Bearish", "Bearish": return Color(.systemRed).opacity(0.15)
        default: return Color(.systemGray5)
        }
    }

    private var textColor: Color {
        switch bias {
        case "Strong Bullish", "Bullish": return Color(.systemGreen)
        case "Strong Bearish", "Bearish": return Color(.systemRed)
        default: return .secondary
        }
    }

    private var pillShortBias: String {
        shortBias(bias)
    }

    var body: some View {
        VStack(spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Text(pillShortBias)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(textColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(color, in: Capsule())
        }
        .accessibilityLabel("\(label) bias: \(pillShortBias)")
    }
}
