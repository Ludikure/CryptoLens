import SwiftUI
import Foundation

struct DerivativesCardView: View {
    let data: DerivativesData
    let snapshot: PositioningSnapshot

    // Hide rows with default/unavailable data
    private var hasRealLSData: Bool { data.globalLongPercent != 50.0 || data.globalShortPercent != 50.0 }
    private var hasRealTopTraderData: Bool { data.topTraderLongPercent != 50.0 || data.topTraderShortPercent != 50.0 }
    private var hasRealTakerData: Bool { data.takerBuySellRatio != 1.0 || data.takerBuyVolume > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "gauge.medium")
                    .foregroundStyle(.secondary)
                Text("Positioning")
                    .font(.headline)
            }

            // Squeeze risk banner
            if snapshot.squeezeRisk.level == "HIGH" || snapshot.squeezeRisk.level == "MODERATE" {
                squeezeBanner
            }

            VStack(spacing: 8) {
                fundingRow
                openInterestRow
                if hasRealLSData { longShortRow }
                if hasRealTopTraderData { topTraderRow }
                if hasRealTakerData { takerFlowRow }
            }

            // Signals
            if !snapshot.signals.isEmpty {
                Divider()
                ForEach(Array(snapshot.signals.enumerated()), id: \.offset) { _, signal in
                    HStack(alignment: .top, spacing: 6) {
                        Circle()
                            .fill(signal.strength == "Strong" ? Color.red : Color.orange)
                            .frame(width: 6, height: 6)
                            .padding(.top, 5)
                        Text(signal.message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Rows

    private var fundingRow: some View {
        HStack {
            HStack(spacing: 3) {
                Text("Funding Rate").font(.subheadline).foregroundStyle(.secondary)
                InfoTooltip(title: "Funding Rate", explanation: Tooltips.fundingRate)
            }
            Spacer()
            Text(formatPercent(data.fundingRatePercent))
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(fundingColor)
        }
    }

    private var openInterestRow: some View {
        HStack {
            HStack(spacing: 3) {
                Text("Open Interest").font(.subheadline).foregroundStyle(.secondary)
                InfoTooltip(title: "Open Interest", explanation: Tooltips.openInterest)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(formatLargeUSD(data.openInterestUSD))
                    .font(.subheadline.monospacedDigit())
                if let change4h = data.oiChange4h {
                    Text("\(change4h >= 0 ? "+" : "")\(String(format: "%.1f", change4h))% 4h")
                        .font(.caption2)
                        .foregroundStyle(change4h >= 0 ? .green : .red)
                }
            }
        }
    }

    private var longShortRow: some View {
        VStack(spacing: 4) {
            HStack {
                HStack(spacing: 3) {
                    Text("L/S Ratio").font(.subheadline).foregroundStyle(.secondary)
                    InfoTooltip(title: "Long/Short Ratio", explanation: Tooltips.longShortRatio)
                }
                Spacer()
                Text("\(String(format: "%.1f", data.globalLongPercent))% / \(String(format: "%.1f", data.globalShortPercent))%")
                    .font(.subheadline.monospacedDigit())
            }
            GeometryReader { geo in
                HStack(spacing: 1) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(.green.opacity(0.7))
                        .frame(width: geo.size.width * CGFloat(data.globalLongPercent / 100))
                    RoundedRectangle(cornerRadius: 2)
                        .fill(.red.opacity(0.7))
                }
            }
            .frame(height: 6)
        }
    }

    private var topTraderRow: some View {
        HStack {
            HStack(spacing: 3) {
                Text("Top Traders").font(.subheadline).foregroundStyle(.secondary)
                InfoTooltip(title: "Top Trader Ratio", explanation: Tooltips.topTraderRatio)
            }
            Spacer()
            Text("\(String(format: "%.1f", data.topTraderLongPercent))%L / \(String(format: "%.1f", data.topTraderShortPercent))%S")
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(data.topTraderLongPercent > 55 ? .green : data.topTraderShortPercent > 55 ? .red : .primary)
        }
    }

    private var takerFlowRow: some View {
        HStack {
            HStack(spacing: 3) {
                Text("Taker Flow").font(.subheadline).foregroundStyle(.secondary)
                InfoTooltip(title: "Taker Volume", explanation: Tooltips.takerVolume)
            }
            Spacer()
            Text(String(format: "%.2f", data.takerBuySellRatio))
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(data.takerBuySellRatio > 1.1 ? .green : data.takerBuySellRatio < 0.9 ? .red : .primary)
        }
    }

    private var squeezeBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
            VStack(alignment: .leading, spacing: 2) {
                Text(snapshot.squeezeRisk.direction)
                    .font(.caption.bold())
                Text(snapshot.squeezeRisk.description)
                    .font(.caption2)
            }
        }
        .foregroundStyle(.white)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(snapshot.squeezeRisk.level == "HIGH" ? Color.red.opacity(0.85) : Color.orange.opacity(0.85))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Helpers

    private var fundingColor: Color {
        let fr = abs(data.fundingRatePercent)
        if fr > 0.05 { return .red }
        if fr > 0.02 { return .orange }
        return .green
    }

    private func formatPercent(_ value: Double) -> String {
        String(format: "%+.4f%%", value)
    }

    private func formatLargeUSD(_ value: Double) -> String {
        if value >= 1_000_000_000 {
            return String(format: "$%.2fB", value / 1_000_000_000)
        } else if value >= 1_000_000 {
            return String(format: "$%.2fM", value / 1_000_000)
        } else if value >= 1_000 {
            return String(format: "$%.1fK", value / 1_000)
        } else {
            return String(format: "$%.0f", value)
        }
    }
}
