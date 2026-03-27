import SwiftUI

struct CoinPickerView: View {
    @EnvironmentObject var favorites: FavoritesStore
    @Binding var selectedSymbol: String
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var favoritesCollapsed = false

    private var favoriteCoins: [CoinDefinition] {
        favorites.orderedFavorites.compactMap { Constants.coin(for: $0) }
    }

    private var allCoins: [CoinDefinition] {
        let base = Constants.allCoins.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        if searchText.isEmpty { return base }
        let query = searchText.lowercased()
        return base.filter {
            $0.name.lowercased().contains(query) || $0.ticker.lowercased().contains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                // Favorites section
                if !favoriteCoins.isEmpty && searchText.isEmpty {
                    Section {
                        if !favoritesCollapsed {
                            ForEach(favoriteCoins) { coin in
                                CoinRow(coin: coin, isSelected: coin.id == selectedSymbol, isFavorite: true) {
                                    selectedSymbol = coin.id
                                    dismiss()
                                } onToggleFavorite: {
                                    favorites.toggleFavorite(coin.id)
                                }
                            }
                            .onMove { from, to in
                                favorites.moveFavorites(from: from, to: to)
                            }
                        }
                    } header: {
                        HStack {
                            Label("Favorites", systemImage: "star.fill")
                                .foregroundStyle(.yellow)
                                .font(.caption)
                                .textCase(nil)
                            Spacer()
                            Button {
                                withAnimation(.easeInOut(duration: 0.25)) {
                                    favoritesCollapsed.toggle()
                                }
                            } label: {
                                Image(systemName: favoritesCollapsed ? "chevron.right" : "chevron.down")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                // All coins
                Section {
                    ForEach(allCoins) { coin in
                        CoinRow(
                            coin: coin,
                            isSelected: coin.id == selectedSymbol,
                            isFavorite: favorites.isFavorite(coin.id)
                        ) {
                            selectedSymbol = coin.id
                            dismiss()
                        } onToggleFavorite: {
                            favorites.toggleFavorite(coin.id)
                        }
                    }
                } header: {
                    Text(searchText.isEmpty ? "All Coins" : "Results")
                        .font(.caption)
                        .textCase(nil)
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search coins")
            .navigationTitle("Select Coin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Coin Row

private struct CoinRow: View {
    let coin: CoinDefinition
    let isSelected: Bool
    let isFavorite: Bool
    let onSelect: () -> Void
    let onToggleFavorite: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                // Color accent bar
                RoundedRectangle(cornerRadius: 2)
                    .fill(coin.color)
                    .frame(width: 4, height: 36)

                // Coin info
                VStack(alignment: .leading, spacing: 2) {
                    Text(coin.name)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(.primary)
                    Text(coin.ticker)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                // Checkmark if selected
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.accentColor)
                }

                // Star toggle
                Button {
                    onToggleFavorite()
                } label: {
                    Image(systemName: isFavorite ? "star.fill" : "star")
                        .foregroundStyle(isFavorite ? .yellow : .secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)
                .frame(width: 44, height: 44)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(
            isSelected ? Color.accentColor.opacity(0.08) : Color(.secondarySystemGroupedBackground)
        )
    }
}
