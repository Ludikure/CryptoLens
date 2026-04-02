import SwiftUI

struct AITabView: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var favorites: FavoritesStore
    @EnvironmentObject var coordinator: NavigationCoordinator
    @State private var showPicker = false
    @State private var showWatchlist = false
    @State private var showHistory = false

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
                        aiContent(result)
                    } else if service.aiLoadingPhase != .idle {
                        aiLoadingView
                    } else {
                        ContentUnavailableView(
                            "No Analysis Yet",
                            systemImage: "sparkles",
                            description: Text("Tap \(Image(systemName: "sparkles")) to run AI analysis.")
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
            .sheet(isPresented: $showHistory) {
                AnalysisHistoryView(symbol: selectedSymbol, currentPrice: service.currentResult?.daily.price)
            }
        }
    }

    @ViewBuilder
    private func aiContent(_ result: AnalysisResult) -> some View {
        // AI Analysis
        ClaudeAnalysisView(markdown: result.claudeAnalysis, aiLoadingPhase: service.aiLoadingPhase, isStale: service.isAIStale, analysisTimestamp: result.analysisTimestamp, onRunAnalysis: {
            Task { await service.runFullAnalysis(symbol: selectedSymbol) }
        })
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        // History button
        Button {
            showHistory = true
        } label: {
            HStack {
                Image(systemName: "clock.arrow.circlepath")
                Text("Analysis History")
                Spacer()
                let count = AnalysisHistoryStore.load(symbol: selectedSymbol).count
                if count > 0 {
                    Text("\(count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .font(.subheadline)
        }
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        // Trade setup charts
        ForEach(result.tradeSetups) { setup in
            TradeSetupChartView(
                candles: result.tf3.candles,
                setup: setup,
                currentPrice: result.daily.price
            )
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Share
        if !result.claudeAnalysis.isEmpty && !result.claudeAnalysis.contains("not configured") {
            ShareLink(item: shareText(result)) {
                HStack {
                    Image(systemName: "square.and.arrow.up")
                    Text("Share Analysis")
                    Spacer()
                }
                .font(.subheadline)
            }
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        Spacer().frame(height: 20)
            .listRowInsets(EdgeInsets())
    }

    private var aiLoadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(service.loadingStatus)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
    }

    private func shareText(_ r: AnalysisResult) -> String {
        var text = """
        \(r.symbol) Analysis — \(r.timestamp.formatted(date: .abbreviated, time: .shortened))

        Price: \(Formatters.formatPrice(r.daily.price))
        Bias: \(r.daily.bias) (D) | \(r.h4.bias) (4H) | \(r.h1.bias) (1H)
        """
        text += "\n\n--- AI Analysis ---\n\n\(r.claudeAnalysis)"
        text += "\n\nGenerated by MarketScope"
        return text
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
