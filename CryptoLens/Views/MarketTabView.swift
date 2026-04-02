import SwiftUI

struct MarketTabView: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var favorites: FavoritesStore
    @EnvironmentObject var coordinator: NavigationCoordinator
    @State private var showPicker = false
    @State private var showWatchlist = false

    private var selectedSymbol: String {
        service.currentSymbol ?? Constants.allCoins[0].id
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    FavoritePillsView()
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))

                    if let result = service.currentResult {
                        marketContent(result)
                    } else if service.isLoading {
                        ShimmerPlaceholder(result: false)
                            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    } else {
                        ContentUnavailableView(
                            "No Market Data",
                            systemImage: "globe",
                            description: Text("Select an asset to see market context.")
                        )
                        .listRowInsets(EdgeInsets(top: 40, leading: 16, bottom: 40, trailing: 16))
                    }
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .background(Color(.systemGroupedBackground))
            .scrollContentBackground(.hidden)
            .refreshable {
                await service.refreshIndicators(symbol: selectedSymbol)
                service.macroSnapshot = await service.macroData.fetchMacroSnapshot()
                if service.marketFor(selectedSymbol) == .crypto {
                    service.spotPressure = await SpotPressureAnalyzer.analyze(symbol: selectedSymbol)
                }
                HapticManager.notification(.success)
            }
            .modifier(AssetToolbarModifier(showPicker: $showPicker, showWatchlist: $showWatchlist))
            .sheet(isPresented: $showPicker) {
                CoinPickerView(selectedSymbol: Binding(
                    get: { selectedSymbol },
                    set: { newSymbol in selectSymbol(newSymbol) }
                ))
            }
            .sheet(isPresented: $showWatchlist) {
                WatchlistView(selectedSymbol: Binding(
                    get: { selectedSymbol },
                    set: { newSymbol in selectSymbol(newSymbol) }
                ))
            }
        }
    }

    @ViewBuilder
    private func marketContent(_ result: AnalysisResult) -> some View {
        // Fear & Greed (crypto)
        if let fg = result.fearGreed {
            FearGreedView(index: fg)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Stock info
        if let si = result.stockInfo {
            StockInfoView(stockInfo: si, symbol: result.symbol)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Stock sentiment
        if let ss = result.stockSentiment {
            StockSentimentView(sentiment: ss)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Derivatives positioning (crypto)
        if let d = result.derivatives, let p = result.positioning {
            DerivativesCardView(data: d, snapshot: p)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Macro context
        if let macro = service.macroSnapshot {
            MacroContextView(macro: macro)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Economic calendar
        if !result.economicEvents.isEmpty {
            EconomicCalendarView(events: result.economicEvents)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Crypto sentiment
        if let sentiment = result.sentiment {
            SentimentView(info: sentiment, symbol: result.symbol)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        Spacer().frame(height: 20)
            .listRowInsets(EdgeInsets())
    }

    private func selectSymbol(_ symbol: String) {
        HapticManager.selection()
        Task {
            await service.selectSymbol(symbol)
            if service.marketFor(symbol) == .crypto {
                service.spotPressure = await SpotPressureAnalyzer.analyze(symbol: symbol)
            } else {
                service.spotPressure = nil
            }
            service.macroSnapshot = await service.macroData.fetchMacroSnapshot()
        }
    }
}
