import SwiftUI

/// Full analysis snapshot for PDF/image export.
struct AnalysisSnapshotView: View {
    let result: AnalysisResult

    private let bgColor = Color(red: 0.102, green: 0.122, blue: 0.212)
    private let cardBg = Color.white.opacity(0.06)

    var body: some View {
        VStack(spacing: 14) {
            // Header
            Text("MarketScope")
                .font(.caption)
                .fontWeight(.bold)
                .tracking(2)
                .foregroundStyle(.white.opacity(0.5))

            // Symbol + Price
            VStack(spacing: 4) {
                Text(Constants.asset(for: result.symbol)?.ticker ?? result.symbol)
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundStyle(.white)

                HStack(spacing: 8) {
                    Text(Formatters.formatPrice(result.daily.price))
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)

                    if let change = result.sentiment?.priceChangePercentage24h {
                        changePill(change)
                    } else if let si = result.stockInfo {
                        changePill(si.priceChangePercent1d)
                    }
                }
            }

            // Bias pills
            HStack(spacing: 10) {
                snapshotBiasPill(label: result.tf1.label, bias: result.tf1.bias)
                snapshotBiasPill(label: result.tf2.label, bias: result.tf2.bias)
                snapshotBiasPill(label: result.tf3.label, bias: result.tf3.bias)
            }

            // Indicator table
            VStack(spacing: 0) {
                indicatorHeader
                Divider().background(.white.opacity(0.2))
                indicatorRow("RSI", values: [result.tf1, result.tf2, result.tf3].map { r in
                    r.rsi.map { String(format: "%.1f", $0) } ?? "-"
                })
                indicatorRow("Stoch RSI", values: [result.tf1, result.tf2, result.tf3].map { r in
                    r.stochRSI.map { "\(Int($0.k))/\(Int($0.d))" } ?? "-"
                })
                indicatorRow("MACD Hist", values: [result.tf1, result.tf2, result.tf3].map { r in
                    r.macd.map { String(format: "%.2f", $0.histogram) } ?? "-"
                })
                indicatorRow("ADX", values: [result.tf1, result.tf2, result.tf3].map { r in
                    r.adx.map { "\(Int($0.adx)) \($0.direction == "Bullish" ? "↑" : "↓")" } ?? "-"
                })
                indicatorRow("BB %B", values: [result.tf1, result.tf2, result.tf3].map { r in
                    r.bollingerBands.map { String(format: "%.2f", $0.percentB) } ?? "-"
                })
                indicatorRow("Volume", values: [result.tf1, result.tf2, result.tf3].map { r in
                    r.volumeRatio.map { String(format: "%.1fx", $0) } ?? "-"
                })
            }
            .padding(10)
            .background(cardBg, in: RoundedRectangle(cornerRadius: 8))

            // Key levels
            if !result.tf1.supportResistance.supports.isEmpty || !result.tf1.supportResistance.resistances.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("KEY LEVELS")
                        .font(.caption2).fontWeight(.bold)
                        .foregroundStyle(.white.opacity(0.5))
                    if !result.tf1.supportResistance.resistances.isEmpty {
                        levelRow("Resistance", levels: result.tf1.supportResistance.resistances, color: .red)
                    }
                    if !result.tf1.supportResistance.supports.isEmpty {
                        levelRow("Support", levels: result.tf1.supportResistance.supports, color: .green)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(cardBg, in: RoundedRectangle(cornerRadius: 8))
            }

            // Market data
            if result.fearGreed != nil || result.derivatives != nil || result.stockInfo != nil {
                VStack(alignment: .leading, spacing: 4) {
                    Text("MARKET DATA")
                        .font(.caption2).fontWeight(.bold)
                        .foregroundStyle(.white.opacity(0.5))
                    if let fg = result.fearGreed {
                        dataRow("Fear & Greed", value: "\(fg.value) — \(fg.classification)")
                    }
                    if let d = result.derivatives {
                        dataRow("Funding Rate", value: String(format: "%.4f%%", d.fundingRatePercent))
                        dataRow("Open Interest", value: Formatters.formatVolume(d.openInterestUSD))
                    }
                    if let si = result.stockInfo {
                        if let pe = si.peRatio { dataRow("P/E Ratio", value: String(format: "%.1f", pe)) }
                        if let mc = si.marketCap { dataRow("Market Cap", value: Formatters.formatVolume(mc)) }
                        if let sector = si.sector { dataRow("Sector", value: sector) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(cardBg, in: RoundedRectangle(cornerRadius: 8))
            }

            // AI Analysis (truncated for PDF)
            if !result.claudeAnalysis.isEmpty && !result.claudeAnalysis.contains("not configured") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("AI ANALYSIS")
                        .font(.caption2).fontWeight(.bold)
                        .foregroundStyle(.white.opacity(0.5))

                    let cleaned = cleanJSON(result.claudeAnalysis)
                    Text(cleaned.prefix(1500) + (cleaned.count > 1500 ? "..." : ""))
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.85))
                        .lineSpacing(3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(cardBg, in: RoundedRectangle(cornerRadius: 8))
            }

            // Timestamp
            Text(result.timestamp.formatted(date: .abbreviated, time: .shortened))
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.4))
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .background(bgColor)
    }

    // MARK: - Components

    private func changePill(_ change: Double) -> some View {
        Text(Formatters.formatPercent(change))
            .font(.subheadline)
            .fontWeight(.semibold)
            .foregroundStyle(change >= 0 ? .green : .red)
    }

    private func snapshotBiasPill(label: String, bias: String) -> some View {
        VStack(spacing: 3) {
            Text(label.replacingOccurrences(of: " (Trend)", with: "").replacingOccurrences(of: " (Bias)", with: "").replacingOccurrences(of: " (Entry)", with: ""))
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.5))
            Text(shortBias(bias))
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(biasTextColor(bias))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(biasColorSimple(bias).opacity(0.2), in: Capsule())
        }
    }

    private var indicatorHeader: some View {
        HStack {
            Text("Indicator")
                .frame(width: 80, alignment: .leading)
            ForEach([result.tf1, result.tf2, result.tf3], id: \.id) { tf in
                Text(tf.label.replacingOccurrences(of: " (Trend)", with: "").replacingOccurrences(of: " (Bias)", with: "").replacingOccurrences(of: " (Entry)", with: ""))
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
                .frame(width: 80, alignment: .leading)
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                Text(value)
                    .frame(maxWidth: .infinity)
            }
        }
        .font(.caption)
        .foregroundStyle(.white.opacity(0.85))
        .padding(.vertical, 3)
    }

    private func levelRow(_ label: String, levels: [Double], color: Color) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(.caption2).fontWeight(.semibold)
                .foregroundStyle(color)
                .frame(width: 65, alignment: .leading)
            Text(levels.prefix(3).map { Formatters.formatPrice($0) }.joined(separator: "  "))
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.85))
        }
    }

    private func dataRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.5))
            Spacer()
            Text(value)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.85))
        }
    }

    private func cleanJSON(_ text: String) -> String {
        guard let jsonStart = text.range(of: "```json") else { return text }
        let before = String(text[..<jsonStart.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        if let jsonEnd = text.range(of: "```", range: jsonStart.upperBound..<text.endIndex) {
            let after = String(text[jsonEnd.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            return after.isEmpty ? before : before + "\n" + after
        }
        return before
    }

    private func biasTextColor(_ bias: String) -> Color {
        bias.contains("Bullish") ? .green : (bias.contains("Bearish") ? .red : .white.opacity(0.6))
    }
}
