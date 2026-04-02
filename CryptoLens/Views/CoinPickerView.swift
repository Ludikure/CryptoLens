import SwiftUI

struct CoinPickerView: View {
    @EnvironmentObject var favorites: FavoritesStore
    @EnvironmentObject var service: AnalysisService
    @Binding var selectedSymbol: String
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var favoritesCollapsed = false
    @State private var selectedMarket: Market = .crypto
    @State private var isValidatingTicker = false
    @State private var tickerValidationError: String?

    private static let yahoo = YahooFinanceService()

    // MARK: - Filtered data

    private var favoriteAssets: [(id: String, name: String, ticker: String)] {
        favorites.orderedFavorites.compactMap { sym in
            if let c = Constants.coin(for: sym) { return (c.id, c.name, c.ticker) }
            if let s = Constants.stock(for: sym) { return (s.id, s.name, s.ticker) }
            return nil
        }
    }

    private var allCrypto: [CoinDefinition] {
        let base = Constants.allCoins.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        if searchText.isEmpty { return base }
        let q = searchText.lowercased()
        return base.filter { $0.name.lowercased().contains(q) || $0.ticker.lowercased().contains(q) }
    }

    private var mergedStocks: [AssetDefinition] {
        var all = Constants.defaultStocks
        for custom in favorites.customStocks {
            if !all.contains(where: { $0.id == custom.id }) {
                all.append(custom)
            }
        }
        return all.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var allStocks: [AssetDefinition] {
        let base = mergedStocks
        if searchText.isEmpty { return base }
        let q = searchText.lowercased()
        return base.filter { $0.name.lowercased().contains(q) || $0.ticker.lowercased().contains(q) }
    }

    private var showYahooSearch: Bool {
        selectedMarket == .stock && !searchText.isEmpty && allStocks.isEmpty
    }

    var body: some View {
        NavigationStack {
            List {
                // Market toggle
                Section {
                    Picker("Market", selection: $selectedMarket) {
                        ForEach(Market.allCases) { m in
                            Text(m.displayName).tag(m)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                }

                // Favorites
                if !favoriteAssets.isEmpty && searchText.isEmpty {
                    Section {
                        if !favoritesCollapsed {
                            ForEach(favoriteAssets, id: \.id) { asset in
                                assetRow(id: asset.id, name: asset.name, ticker: asset.ticker)
                            }
                            .onMove { from, to in favorites.moveFavorites(from: from, to: to) }
                        }
                    } header: {
                        HStack {
                            Label("Favorites", systemImage: "star.fill")
                                .foregroundStyle(.yellow).font(.caption).textCase(nil)
                            Spacer()
                            Button {
                                withAnimation(.easeInOut(duration: 0.25)) { favoritesCollapsed.toggle() }
                            } label: {
                                Image(systemName: favoritesCollapsed ? "chevron.right" : "chevron.down")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                // Market-specific list
                Section {
                    switch selectedMarket {
                    case .crypto:
                        ForEach(allCrypto) { coin in
                            assetRow(id: coin.id, name: coin.name, ticker: coin.ticker)
                        }
                    case .stock:
                        ForEach(allStocks) { stock in
                            assetRow(id: stock.id, name: stock.name, ticker: stock.ticker)
                        }
                    }
                } header: {
                    Text(selectedMarket == .crypto ? "All Coins" : "All Stocks & ETFs")
                        .font(.caption).textCase(nil)
                }

                // Yahoo ticker search for stocks
                if showYahooSearch {
                    Section {
                        Button {
                            Task { await searchYahooTicker() }
                        } label: {
                            HStack(spacing: 10) {
                                if isValidatingTicker {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Image(systemName: "magnifyingglass")
                                        .foregroundStyle(Color.accentColor)
                                }
                                Text("Search Yahoo for \"\(searchText.uppercased())\"")
                                    .font(.subheadline)
                                    .foregroundStyle(Color.accentColor)
                                Spacer()
                            }
                        }
                        .disabled(isValidatingTicker)

                        if let error = tickerValidationError {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    } header: {
                        Text("Custom Ticker").font(.caption).textCase(nil)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
            .navigationTitle("Select Asset")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                // Start on the market of the currently selected symbol
                if Constants.stock(for: selectedSymbol) != nil {
                    selectedMarket = .stock
                }
            }
        }
    }

    // MARK: - Row

    private func searchYahooTicker() async {
        let ticker = searchText.uppercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ticker.isEmpty else { return }

        await MainActor.run {
            isValidatingTicker = true
            tickerValidationError = nil
        }

        let (name, valid) = await Self.yahoo.validateTicker(ticker)

        await MainActor.run {
            isValidatingTicker = false
            if valid {
                let asset = AssetDefinition(id: name, name: name, ticker: name, market: .stock, color: .gray)
                favorites.addCustomStock(asset)
                selectedSymbol = asset.id
                dismiss()
            } else {
                tickerValidationError = "\"\(ticker)\" not found on Yahoo Finance."
            }
        }
    }

    private func assetRow(id: String, name: String, ticker: String) -> some View {
        Button {
            selectedSymbol = id
            dismiss()
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.subheadline).fontWeight(.semibold).foregroundStyle(.primary)
                    Text(ticker).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if id == selectedSymbol {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                }
                Button {
                    favorites.toggleFavorite(id)
                    if favorites.isFavorite(id) && service.resultsBySymbol[id] == nil {
                        Task { await service.quickFetch(symbol: id) }
                    }
                } label: {
                    Image(systemName: favorites.isFavorite(id) ? "star.fill" : "star")
                        .foregroundStyle(favorites.isFavorite(id) ? .yellow : .secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)
                .frame(width: 44, height: 44)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(
            id == selectedSymbol ? Color.accentColor.opacity(0.08) : Color(.secondarySystemGroupedBackground)
        )
    }
}
