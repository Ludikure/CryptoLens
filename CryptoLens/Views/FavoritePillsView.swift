import SwiftUI

struct FavoritePillsView: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var favorites: FavoritesStore

    private var selectedSymbol: String {
        service.currentSymbol ?? Constants.allCoins[0].id
    }

    private var favoriteAssets: [(id: String, ticker: String)] {
        favorites.orderedFavorites.compactMap { sym in
            if let c = Constants.coin(for: sym) { return (c.id, c.ticker) }
            if let s = Constants.stock(for: sym) { return (s.id, s.ticker) }
            return nil
        }
    }

    var body: some View {
        if !favoriteAssets.isEmpty {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(favoriteAssets, id: \.id) { asset in
                            let isSelected = asset.id == selectedSymbol
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    selectSymbol(asset.id)
                                }
                            } label: {
                                HStack(spacing: 3) {
                                    Text(asset.ticker)
                                        .font(.caption)
                                        .fontWeight(isSelected ? .semibold : .regular)
                                    // Show the number the app's own gates act on: the live-calibrated
                                    // value, falling back to raw only when no curve could be fitted.
                                    // The raw scale drifted well below the calibrated one (auto-FLAT
                                    // at calibrated 50 is raw < 30.3%), so a raw badge beside a
                                    // permitted setup read as a contradiction.
                                    if let tf = service.resultsBySymbol[asset.id]?.tf1,
                                       let mlProb = tf.mlWinCalibrated ?? tf.mlWinProbability {
                                        Text("\(Int(mlProb * 100))")
                                            .font(.caption2)
                                            .fontWeight(.medium)
                                            .foregroundStyle(mlProbColor(mlProb, isSelected: isSelected))
                                    }
                                }
                                .lineLimit(1)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .foregroundStyle(isSelected ? .white : .primary)
                                .background(isSelected ? Color.accentColor : Color(.systemGray5), in: Capsule())
                            }
                            .id(asset.id)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .onChange(of: service.currentSymbol) {
                    if let sym = service.currentSymbol {
                        proxy.scrollTo(sym, anchor: .center)
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func selectSymbol(_ symbol: String) {
        service.switchToSymbol(symbol)
    }

    private func mlProbColor(_ prob: Double, isSelected: Bool) -> Color {
        // Theme-routed (2026-07-31): the raw .green here was the stock light-mode green, one of the
        // last two off-palette colours on the landing screen.
        if prob >= 0.70 { return isSelected ? .white : Theme.bullish }
        // The selected pill's background is .accentColor (blue); gray text on blue is
        // unreadable, so swap to a softened white for the low-probability case there
        // and keep the muted tone only for the unselected case where it sits on systemGray5.
        if prob < 0.50 { return isSelected ? Color.white.opacity(0.75) : Theme.neutral }
        return isSelected ? .white : .primary
    }
}
