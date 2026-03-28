import SwiftUI

/// Stock fundamentals card + market hours badge.
struct StockInfoView: View {
    let stockInfo: StockInfo
    let symbol: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Market status badge
            MarketStatusBadge(state: stockInfo.marketState)

            // Earnings countdown
            if let earningsDate = stockInfo.earningsDate, earningsDate > Date() {
                let days = Calendar.current.dateComponents([.day], from: Date(), to: earningsDate).day ?? 0
                HStack(spacing: 6) {
                    Image(systemName: "calendar").font(.caption)
                    Text("Earnings in \(days) day\(days == 1 ? "" : "s")")
                        .font(.caption).fontWeight(.semibold)
                }
                .foregroundStyle(.orange)
            }

            // Fundamentals grid
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                if let pe = stockInfo.peRatio {
                    fundamentalItem("P/E", value: String(format: "%.1f", pe))
                }
                if let eps = stockInfo.eps {
                    fundamentalItem("EPS", value: String(format: "$%.2f", eps))
                }
                if let div = stockInfo.dividendYield, div > 0 {
                    fundamentalItem("Div Yield", value: String(format: "%.2f%%", div))
                }
            }

            // 52-week range
            if stockInfo.fiftyTwoWeekLow > 0 && stockInfo.fiftyTwoWeekHigh > 0 {
                VStack(spacing: 4) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color(.systemGray5)).frame(height: 4)
                            // No current price marker without live price; just show the range
                        }
                    }
                    .frame(height: 4)
                    HStack {
                        Text(Formatters.formatPrice(stockInfo.fiftyTwoWeekLow))
                            .font(.caption2).foregroundStyle(.secondary)
                        Spacer()
                        Text("52-Week Range").font(.caption2).foregroundStyle(.tertiary)
                        Spacer()
                        Text(Formatters.formatPrice(stockInfo.fiftyTwoWeekHigh))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func fundamentalItem(_ label: String, value: String) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.tertiary)
            Text(value).font(.callout).fontWeight(.semibold)
        }
    }
}

/// Market open/closed badge.
struct MarketStatusBadge: View {
    let state: String

    private var session: MarketSession {
        switch state.uppercased() {
        case "REGULAR": return .regular
        case "PRE": return .preMarket
        case "POST", "POSTPOST": return .postMarket
        default: return .closed
        }
    }

    private var color: Color {
        switch session {
        case .regular: return .green
        case .preMarket, .postMarket: return .orange
        case .closed: return .red
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(session.rawValue)
                .font(.caption).fontWeight(.semibold).foregroundStyle(color)

            if session != .regular, let time = MarketHours.timeToNextOpen() {
                Text("· opens in \(time)")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if session == .regular, let time = MarketHours.timeToClose() {
                Text("· closes in \(time)")
                    .font(.caption2).foregroundStyle(.secondary)
            }

            Spacer()
            Text("15m delay").font(.caption2).foregroundStyle(.tertiary)
        }
    }
}
