import SwiftUI

struct WatchlistView: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var favorites: FavoritesStore
    @Binding var selectedSymbol: String
    @Environment(\.dismiss) private var dismiss

    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    private func fetchMissing() async {
        let missing = favorites.orderedFavorites.filter { service.resultsBySymbol[$0] == nil }
        for symbol in missing {
            await service.refreshIndicators(symbol: symbol)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if favorites.orderedFavorites.isEmpty {
                    ContentUnavailableView("No Favorites", systemImage: "star", description: Text("Star assets in the picker to see them here"))
                        .padding(.top, 40)
                } else {
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(favorites.orderedFavorites, id: \.self) { symbol in
                            WatchlistCard(
                                symbol: symbol,
                                result: service.resultsBySymbol[symbol],
                                isSelected: symbol == selectedSymbol
                            )
                            .onTapGesture {
                                selectedSymbol = symbol
                                dismiss()
                            }
                        }
                    }
                    .padding()
                }
            }
            .background(Color(.systemGroupedBackground))
            .task { await fetchMissing() }
            .navigationTitle("Watchlist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Card

private struct WatchlistCard: View {
    let symbol: String
    let result: AnalysisResult?
    let isSelected: Bool

    private var ticker: String {
        Constants.asset(for: symbol)?.ticker ?? symbol
    }

    private var name: String {
        Constants.asset(for: symbol)?.name ?? symbol
    }

    private var biasColor: Color {
        guard let bias = result?.daily.bias else { return .gray }
        if bias.contains("Bullish") { return .green }
        if bias.contains("Bearish") { return .red }
        return .gray
    }

    private var shortBias: String {
        guard let bias = result?.daily.bias else { return "..." }
        switch bias {
        case "Strong Bullish": return "Strong Bull"
        case "Bullish": return "Bullish"
        case "Strong Bearish": return "Strong Bear"
        case "Bearish": return "Bearish"
        default: return "Neutral"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Ticker + bias pill
            HStack {
                Text(ticker)
                    .font(.subheadline)
                    .fontWeight(.bold)
                Spacer()
                Text(shortBias)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(biasColor)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(biasColor.opacity(0.12), in: Capsule())
            }

            if let result {
                // Price
                Text(Formatters.formatPrice(result.daily.price))
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .monospacedDigit()

                // Sparkline
                let candles = result.tf1.candles
                if candles.count >= 2 {
                    SparklineChart(candles: candles)
                        .frame(height: 32)
                }

                // 24h change
                if let change = result.sentiment?.priceChangePercentage24h {
                    Text(Formatters.formatPercent(change))
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundStyle(change >= 0 ? .green : .red)
                }
            } else {
                // Skeleton
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(.systemGray5))
                    .frame(width: 80, height: 18)
                    .shimmer()
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(.systemGray5))
                    .frame(height: 32)
                    .shimmer()
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(.secondarySystemGroupedBackground))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(isSelected ? Color.accentColor : biasColor.opacity(0.2), lineWidth: isSelected ? 2 : 1)
                )
        )
    }
}
