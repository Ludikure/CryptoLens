import SwiftUI

struct ContentView: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var alertsStore: AlertsStore
    @EnvironmentObject var coordinator: NavigationCoordinator
    @AppStorage("colorSchemeOverride") private var colorSchemeOverride = "system"
    @State private var showPicker = false
    @State private var showWatchlist = false
    @State private var showHistory = false

    var body: some View {
        VStack(spacing: 0) {
            // Content area
            Group {
                if coordinator.selectedTab == 3 {
                    NavigationStack {
                        AlertsView()
                    }
                } else {
                    NavigationStack {
                        assetContent
                            .modifier(AssetToolbarModifier(showPicker: $showPicker, showWatchlist: $showWatchlist))
                            .sheet(isPresented: $showPicker) {
                                CoinPickerView(selectedSymbol: Binding(
                                    get: { service.currentSymbol ?? Constants.allCoins[0].id },
                                    set: { newSymbol in selectSymbol(newSymbol) }
                                ))
                            }
                            .sheet(isPresented: $showWatchlist) {
                                WatchlistView(selectedSymbol: Binding(
                                    get: { service.currentSymbol ?? Constants.allCoins[0].id },
                                    set: { newSymbol in selectSymbol(newSymbol) }
                                ))
                            }
                            .sheet(isPresented: $coordinator.showSettings) {
                                SettingsView()
                            }
                            .sheet(isPresented: $showHistory) {
                                AnalysisHistoryView(
                                    symbol: service.currentSymbol ?? Constants.allCoins[0].id,
                                    currentPrice: service.currentResult?.daily.price
                                )
                            }
                    }
                }
            }

            // Bottom tab bar
            bottomTabBar
        }
        .preferredColorScheme(colorSchemeOverride == "light" ? .light : colorSchemeOverride == "dark" ? .dark : nil)
    }

    @ViewBuilder
    private var assetContent: some View {
        switch coordinator.selectedTab {
        case 0:
            ChartTabContent()
        case 1:
            MarketTabContent()
        case 2:
            AITabContent(showHistory: $showHistory)
        default:
            EmptyView()
        }
    }

    private var bottomTabBar: some View {
        HStack(spacing: 0) {
            tabBarItem(icon: "chart.xyaxis.line", label: "Chart", tag: 0)
            tabBarItem(icon: "building.columns", label: "Market", tag: 1)
            tabBarItem(icon: "brain", label: "Analysis", tag: 2)
            tabBarItem(
                icon: alertsStore.activeAlerts.isEmpty ? "bell" : "bell.badge",
                label: "Alerts",
                tag: 3
            )
        }
        .padding(.top, 8)
        .padding(.bottom, 2)
        .background(.bar)
    }

    private func tabBarItem(icon: String, label: String, tag: Int) -> some View {
        Button {
            coordinator.selectedTab = tag
        } label: {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .frame(height: 22)
                Text(label)
                    .font(.system(size: 10))
            }
            .frame(maxWidth: .infinity)
            .foregroundStyle(coordinator.selectedTab == tag ? Color.accentColor : .secondary)
        }
        .buttonStyle(.plain)
    }

    @State private var selectSymbolTask: Task<Void, Never>?

    private func selectSymbol(_ symbol: String) {
        HapticManager.selection()
        service.currentSymbol = symbol
        service.currentMarket = service.marketFor(symbol)
        if let cached = service.resultsBySymbol[symbol] {
            service.lastResult = cached
        }
        selectSymbolTask?.cancel()
        selectSymbolTask = Task {
            await service.selectSymbol(symbol)
            guard !Task.isCancelled else { return }
            if service.marketFor(symbol) == .crypto {
                service.spotPressure = await SpotPressureAnalyzer.analyze(symbol: symbol)
            } else {
                service.spotPressure = nil
            }
            guard !Task.isCancelled else { return }
            service.macroSnapshot = await service.macroData.fetchMacroSnapshot()
        }
    }
}

// MARK: - Tab Content Views (no NavigationStack)

struct ChartTabContent: View {
    @EnvironmentObject var service: AnalysisService
    @State private var biasChanges: [String] = []

    private var selectedSymbol: String {
        service.currentSymbol ?? Constants.allCoins[0].id
    }

    private func recomputeBiasChanges() {
        guard let result = service.currentResult else { biasChanges = []; return }
        let history = AnalysisHistoryStore.load(symbol: result.symbol)
        guard history.count >= 2 else { biasChanges = []; return }
        let prev = history[1]
        var changes = [String]()
        if result.tf1.bias != prev.tf1.bias { changes.append("\(result.tf1.label) flipped to \(result.tf1.bias)") }
        if result.tf2.bias != prev.tf2.bias { changes.append("\(result.tf2.label) flipped to \(result.tf2.bias)") }
        if result.tf3.bias != prev.tf3.bias { changes.append("\(result.tf3.label) flipped to \(result.tf3.bias)") }
        biasChanges = changes
    }

    var body: some View {
        List {
            Section {
                FavoritePillsView()
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))

                if NetworkMonitor.shared.isOffline {
                    offlineBanner
                }

                if let result = service.currentResult {
                    TimestampBar(dataTimestamp: result.timestamp, analysisTimestamp: result.analysisTimestamp)
                        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 4, trailing: 16))
                }

                if service.isLoading && service.currentResult == nil {
                    ShimmerPlaceholder(result: false)
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                }

                if let error = service.error {
                    errorView(error)
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                }

                if let result = service.currentResult {
                    chartContent(result)
                }

                if !service.isLoading && service.currentResult == nil && service.error == nil {
                    emptyView
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
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
        .onAppear {
            if service.currentSymbol == nil {
                Task { await service.selectSymbol(Constants.allCoins[0].id) }
            }
            recomputeBiasChanges()
        }
        .onChange(of: service.currentResult?.symbol) { _ in
            recomputeBiasChanges()
        }
    }

    @ViewBuilder
    private func chartContent(_ result: AnalysisResult) -> some View {
        if Date().timeIntervalSince(result.timestamp) > 300 {
            let mins = Int(Date().timeIntervalSince(result.timestamp) / 60)
            HStack(spacing: 6) {
                Image(systemName: "clock.badge.exclamationmark").font(.caption)
                Text("Data from \(mins)m ago \u{00B7} Pull to refresh").font(.caption)
            }
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
        }

        if !biasChanges.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(biasChanges, id: \.self) { change in
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.2.circlepath").font(.caption2)
                        Text(change).font(.caption)
                    }
                    .foregroundStyle(.orange)
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
        }

        PriceHeaderView(result: result)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        if !result.tf1.candles.isEmpty {
            CandlestickChartView(results: [result.tf1, result.tf2, result.tf3])
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        IndicatorTableView(
            results: [result.tf1, result.tf2, result.tf3],
            putCallRatio: result.stockSentiment?.putCallRatio,
            spotPressure: service.spotPressure
        )
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        Spacer().frame(height: 20).listRowInsets(EdgeInsets())
    }

    private var offlineBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "wifi.slash").font(.caption)
            Text("No internet connection").font(.caption)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color.red.opacity(0.8), in: RoundedRectangle(cornerRadius: 8))
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
    }

    private func errorView(_ error: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.title2).foregroundStyle(.orange)
            Text(error).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Retry") { Task { await service.refreshIndicators(symbol: selectedSymbol) } }
                .buttonStyle(.borderedProminent).controlSize(.small)
        }
        .padding()
    }

    private var emptyView: some View {
        VStack(spacing: 12) {
            Image(systemName: "chart.bar.xaxis").font(.system(size: 44)).foregroundStyle(.tertiary)
            Text("Pull down to load data").font(.subheadline).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 60)
    }
}

struct MarketTabContent: View {
    @EnvironmentObject var service: AnalysisService

    var body: some View {
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
                        systemImage: "building.columns",
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
            let symbol = service.currentSymbol ?? Constants.allCoins[0].id
            await service.refreshIndicators(symbol: symbol)
            service.macroSnapshot = await service.macroData.fetchMacroSnapshot()
            if service.marketFor(symbol) == .crypto {
                service.spotPressure = await SpotPressureAnalyzer.analyze(symbol: symbol)
            }
            HapticManager.notification(.success)
        }
    }

    @ViewBuilder
    private func marketContent(_ result: AnalysisResult) -> some View {
        if let fg = result.fearGreed {
            FearGreedView(index: fg)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
        if let si = result.stockInfo {
            StockInfoView(stockInfo: si, symbol: result.symbol)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
        if let ss = result.stockSentiment {
            StockSentimentView(sentiment: ss)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
        if let d = result.derivatives, let p = result.positioning {
            DerivativesCardView(data: d, snapshot: p)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
        if let macro = service.macroSnapshot {
            MacroContextView(macro: macro)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
        if !result.economicEvents.isEmpty {
            EconomicCalendarView(events: result.economicEvents)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
        if let sentiment = result.sentiment {
            SentimentView(info: sentiment, symbol: result.symbol)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
        Spacer().frame(height: 20).listRowInsets(EdgeInsets())
    }
}

struct AITabContent: View {
    @EnvironmentObject var service: AnalysisService
    @Binding var showHistory: Bool
    @State private var historyCount: Int = 0

    private var selectedSymbol: String {
        service.currentSymbol ?? Constants.allCoins[0].id
    }

    var body: some View {
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
        .onAppear {
            historyCount = AnalysisHistoryStore.load(symbol: selectedSymbol).count
        }
        .onChange(of: service.currentSymbol) { _ in
            historyCount = AnalysisHistoryStore.load(symbol: selectedSymbol).count
        }
        .onChange(of: service.currentResult?.analysisTimestamp) { _ in
            historyCount = AnalysisHistoryStore.load(symbol: selectedSymbol).count
        }
    }

    @ViewBuilder
    private func aiContent(_ result: AnalysisResult) -> some View {
        ClaudeAnalysisView(markdown: result.claudeAnalysis, aiLoadingPhase: service.aiLoadingPhase, isStale: service.isAIStale, analysisTimestamp: result.analysisTimestamp, onRunAnalysis: {
            Task { await service.runFullAnalysis(symbol: selectedSymbol) }
        })
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        Button {
            showHistory = true
        } label: {
            HStack {
                Image(systemName: "clock.arrow.circlepath")
                Text("Analysis History")
                Spacer()
                if historyCount > 0 {
                    Text("\(historyCount)")
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

        ForEach(result.tradeSetups) { setup in
            TradeSetupChartView(
                candles: result.tf3.candles,
                setup: setup,
                currentPrice: result.daily.price
            )
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

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

        Spacer().frame(height: 20).listRowInsets(EdgeInsets())
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
}
