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
                                Text(asset.ticker)
                                    .font(.caption)
                                    .fontWeight(isSelected ? .semibold : .regular)
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
}
