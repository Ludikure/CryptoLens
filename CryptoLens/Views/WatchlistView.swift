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

// MARK: - F-6 decision verdict

private struct DecisionVerdict {
    let label: String
    let reason: String
    let color: Color
    let icon: String
}

/// At-a-glance per-symbol verdict from the cached analysis. CONDITIONS PRESENT = a viable setup
/// exists; STAND ASIDE = AI analysis ran and found no edge; WATCH = indicators only, not yet
/// analyzed. Plain-language, no chart needed — respects that the busy user doesn't have time to
/// read nine paragraphs.
private func decisionVerdict(for result: AnalysisResult) -> DecisionVerdict {
    if let setup = result.tradeSetups.first {
        var reason = "\(setup.direction) setup"
        if let ml = result.daily.mlWinProbability { reason += " · ML \(Int((ml * 100).rounded()))%" }
        return DecisionVerdict(label: "CONDITIONS PRESENT", reason: reason, color: .blue, icon: "scope")
    }
    if result.analysisTimestamp != nil {
        return DecisionVerdict(label: "STAND ASIDE", reason: "Analysis found no setup — no edge to enter", color: .secondary, icon: "hand.raised")
    }
    let bias = shortBias(result.daily.bias)
    if let ml = result.daily.mlWinProbability {
        return DecisionVerdict(label: "WATCH", reason: "\(bias) · ML \(Int((ml * 100).rounded()))% — tap to analyze", color: .orange, icon: "eye")
    }
    return DecisionVerdict(label: "WATCH", reason: "\(bias) — tap to analyze", color: .orange, icon: "eye")
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

    private var cardBiasColor: Color {
        guard let bias = result?.daily.bias else { return .gray }
        return biasColorSimple(bias)
    }

    private var cardShortBias: String {
        guard let bias = result?.daily.bias else { return "..." }
        return shortBias(bias)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Ticker + bias pill
            HStack {
                Text(ticker)
                    .font(.subheadline)
                    .fontWeight(.bold)
                Spacer()
                Text(cardShortBias)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(cardBiasColor)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(cardBiasColor.opacity(0.12), in: Capsule())
            }

            if let result {
                // F-6 — 5-second decision verdict: the at-a-glance call so the busy user gets a
                // plain read without opening the chart.
                let v = decisionVerdict(for: result)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 3) {
                        Image(systemName: v.icon).font(.system(size: 8, weight: .bold))
                        Text(v.label).font(.system(size: 9, weight: .heavy))
                    }
                    .foregroundStyle(v.color)
                    Text(v.reason).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(2)
                }

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
                        .stroke(isSelected ? Color.accentColor : cardBiasColor.opacity(0.2), lineWidth: isSelected ? 2 : 1)
                )
        )
    }
}
