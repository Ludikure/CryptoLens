import SwiftUI

/// A non-interactive view designed for rendering as a shareable image.
/// Approximately 390x520 points with dark navy background.
struct AnalysisSnapshotView: View {
    let result: AnalysisResult

    private let bgColor = Color(red: 0.102, green: 0.122, blue: 0.212) // #1a1f36

    var body: some View {
        VStack(spacing: 16) {
            // Header
            Text("MarketScope")
                .font(.caption)
                .fontWeight(.bold)
                .tracking(2)
                .foregroundStyle(.white.opacity(0.5))

            // Symbol + Price
            VStack(spacing: 4) {
                Text(result.symbol)
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundStyle(.white)

                HStack(spacing: 8) {
                    Text(Formatters.formatPrice(result.daily.price))
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)

                    if let change = result.sentiment?.priceChangePercentage24h {
                        Text(Formatters.formatPercent(change))
                            .font(.subheadline)
                            .fontWeight(.semibold)
                            .foregroundStyle(change >= 0 ? .green : .red)
                    } else if let si = result.stockInfo {
                        Text(Formatters.formatPercent(si.priceChangePercent1d))
                            .font(.subheadline)
                            .fontWeight(.semibold)
                            .foregroundStyle(si.priceChangePercent1d >= 0 ? .green : .red)
                    }
                }
            }

            // Bias pills
            HStack(spacing: 10) {
                snapshotBiasPill(label: "Daily", bias: result.tf1.bias)
                snapshotBiasPill(label: "4H", bias: result.tf2.bias)
                snapshotBiasPill(label: "1H", bias: result.tf3.bias)
            }

            // Indicator grid
            VStack(spacing: 0) {
                indicatorHeader
                Divider().background(.white.opacity(0.2))
                indicatorRow("RSI", values: [result.tf1.rsi, result.tf2.rsi, result.tf3.rsi].map { v in
                    v.map { String(format: "%.1f", $0) } ?? "-"
                })
                indicatorRow("MACD Hist", values: [result.tf1.macd, result.tf2.macd, result.tf3.macd].map { v in
                    v.map { String(format: "%.2f", $0.histogram) } ?? "-"
                })
                indicatorRow("ADX", values: [result.tf1.adx, result.tf2.adx, result.tf3.adx].map { v in
                    v.map { "\(Int($0.adx)) \($0.direction)" } ?? "-"
                })
            }
            .padding(12)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))

            // Timestamp
            Text(result.timestamp.formatted(date: .abbreviated, time: .shortened))
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.4))
        }
        .padding(24)
        .frame(width: 390)
        .background(bgColor)
    }

    // MARK: - Components

    private func snapshotBiasPill(label: String, bias: String) -> some View {
        VStack(spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.5))
            Text(shortBias(bias))
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(biasTextColor(bias))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(biasColor(bias).opacity(0.2), in: Capsule())
        }
    }

    private var indicatorHeader: some View {
        HStack {
            Text("Indicator")
                .frame(width: 90, alignment: .leading)
            ForEach(["Daily", "4H", "1H"], id: \.self) { tf in
                Text(tf)
                    .frame(maxWidth: .infinity)
            }
        }
        .font(.caption2)
        .fontWeight(.semibold)
        .foregroundStyle(.white.opacity(0.5))
        .padding(.bottom, 4)
    }

    private func indicatorRow(_ name: String, values: [String]) -> some View {
        HStack {
            Text(name)
                .frame(width: 90, alignment: .leading)
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                Text(value)
                    .frame(maxWidth: .infinity)
            }
        }
        .font(.caption)
        .foregroundStyle(.white.opacity(0.85))
        .padding(.vertical, 4)
    }

    private func shortBias(_ bias: String) -> String {
        switch bias {
        case "Strong Bullish": return "Strong Bull"
        case "Bullish": return "Bullish"
        case "Strong Bearish": return "Strong Bear"
        case "Bearish": return "Bearish"
        default: return "Neutral"
        }
    }

    private func biasTextColor(_ bias: String) -> Color {
        switch bias {
        case "Strong Bullish", "Bullish": return .green
        case "Strong Bearish", "Bearish": return .red
        default: return .white.opacity(0.6)
        }
    }

    private func biasColor(_ bias: String) -> Color {
        switch bias {
        case "Strong Bullish", "Bullish": return .green
        case "Strong Bearish", "Bearish": return .red
        default: return .gray
        }
    }
}
