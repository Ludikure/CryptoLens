import SwiftUI

struct ContentView: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var alertsStore: AlertsStore
    @EnvironmentObject var coordinator: NavigationCoordinator
    @AppStorage("colorSchemeOverride") private var colorSchemeOverride = "system"
    @Environment(\.colorScheme) private var systemScheme
    @State private var showPicker = false
    @State private var showWatchlist = false
    @State private var showHistory = false

    /// Effective dark-mode for the chart web view (honors the in-app override).
    private var chartDark: Bool {
        colorSchemeOverride == "dark" || (colorSchemeOverride != "light" && systemScheme == .dark)
    }

    /// Render fresh data into the persistent chart web view even while another tab is showing —
    /// so opening the Chart tab presents an already-drawn chart instead of a late-loading one.
    private func warmChart() {
        if let r = service.currentResult { ChartWebViewStore.warmPush(result: r, dark: chartDark) }
    }

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
        .task {
            ChartWebViewStore.prewarm()   // web-process + JS startup at launch, not on first tab-open
            warmChart()
        }
        .onChange(of: service.currentResult?.timestamp) { warmChart() }
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
        case 4:
            ChartScreenView()
        default:
            EmptyView()
        }
    }

    private var bottomTabBar: some View {
        HStack(spacing: 0) {
            tabBarItem(icon: "chart.bar.doc.horizontal", label: "Overview", tag: 0)
            tabBarItem(icon: "chart.xyaxis.line", label: "Chart", tag: 4)
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

    private func selectSymbol(_ symbol: String) {
        service.switchToSymbol(symbol)
    }
}

// MARK: - Tab Content Views (no NavigationStack)

struct ChartTabContent: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var favorites: FavoritesStore
    @State private var biasChanges: [String] = []
    @State private var activeSetups: [TrackedSetup] = []
    @State private var tradesExpanded = false

    private var selectedSymbol: String {
        service.currentSymbol ?? Constants.allCoins[0].id
    }

    private func switchToAdjacentFavorite(offset: Int) {
        let list = favorites.orderedFavorites
        guard !list.isEmpty else { return }
        let current = selectedSymbol
        if let idx = list.firstIndex(of: current) {
            let newIdx = (idx + offset + list.count) % list.count
            service.switchToSymbol(list[newIdx])
        } else {
            service.switchToSymbol(list[0])
        }
    }

    private func recomputeBiasChanges() {
        guard let result = service.currentResult else { biasChanges = []; return }
        Task {
            let history = await AnalysisHistoryStore.loadAsync(symbol: result.symbol)
            guard history.count >= 2 else { biasChanges = []; return }
            let prev = history[1]
            var changes = [String]()
            if result.tf1.bias != prev.tf1.bias { changes.append("\(result.tf1.label) flipped to \(result.tf1.bias)") }
            if result.tf2.bias != prev.tf2.bias { changes.append("\(result.tf2.label) flipped to \(result.tf2.bias)") }
            if result.tf3.bias != prev.tf3.bias { changes.append("\(result.tf3.label) flipped to \(result.tf3.bias)") }
            biasChanges = changes
        }
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
            HapticManager.notification(.success)
        }
        .task {
            await MarketHours.fetchFromFinnhub()
            if service.currentSymbol == nil {
                await service.selectSymbol(Constants.allCoins[0].id)
            }
            recomputeBiasChanges()
            activeSetups = OutcomeTracker.activeSetups(symbol: selectedSymbol)
        }
        .onChange(of: service.currentResult?.timestamp) {
            recomputeBiasChanges()
            activeSetups = OutcomeTracker.activeSetups(symbol: selectedSymbol)
        }
        .onChange(of: service.currentSymbol) {
            activeSetups = OutcomeTracker.activeSetups(symbol: selectedSymbol)
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

        PriceHeaderView(result: result, onSwipeLeft: {
            switchToAdjacentFavorite(offset: 1)
        }, onSwipeRight: {
            switchToAdjacentFavorite(offset: -1)
        })
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        // Active trades (collapsible)
        if !activeSetups.isEmpty {
            VStack(spacing: 4) {
                Button {
                    withAnimation(.easeOut(duration: 0.2)) { tradesExpanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Text("Active Trades")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundStyle(.secondary)
                        Text("\(activeSetups.count)")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.blue.opacity(0.2))
                            .foregroundStyle(.blue)
                            .clipShape(Capsule())
                        Spacer()
                        // Summary PnL when collapsed
                        if !tradesExpanded {
                            let totalPnl = activeSetups.reduce(0.0) { sum, a in
                                let p = a.setup.direction == "LONG"
                                    ? (result.daily.price - a.setup.entry) / a.setup.entry * 100
                                    : (a.setup.entry - result.daily.price) / a.setup.entry * 100
                                return sum + p
                            }
                            Text(String(format: "%+.1f%%", totalPnl))
                                .font(.caption.bold())
                                .foregroundStyle(totalPnl >= 0 ? .green : .red)
                        }
                        Image(systemName: tradesExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)

                if tradesExpanded {
                    ForEach(activeSetups, id: \.id) { active in
                        let currentPrice = result.daily.price

                        if active.outcome.state == .pending {
                            // Pending conditional setup
                            let distToEntry = abs(active.setup.entry - currentPrice)
                            HStack(spacing: 6) {
                                Circle().fill(Color.blue).frame(width: 8)
                                Text("\(active.setup.direction) \(Formatters.formatPrice(active.setup.entry))")
                                    .font(.caption)
                                Text("PENDING")
                                    .font(.system(size: 8, weight: .bold))
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .foregroundStyle(.blue)
                                    .background(Color.blue.opacity(0.2), in: Capsule())
                                Spacer()
                                Text("\(Formatters.formatPrice(distToEntry)) away")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(6)
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                        } else {
                            // Active trade
                            let pnl = active.setup.direction == "LONG"
                                ? (currentPrice - active.setup.entry) / active.setup.entry * 100
                                : (active.setup.entry - currentPrice) / active.setup.entry * 100
                            let nextTarget = active.outcome.tp1Hit ? (active.setup.tp2 ?? active.setup.tp1) : active.setup.tp1
                            let distToTarget = abs(nextTarget - currentPrice)
                            let targetLabel = active.outcome.tp1Hit ? "TP2" : "TP1"
                            let held = Int(Date().timeIntervalSince(active.outcome.entryHitTime ?? active.timestamp) / 3600)

                            HStack(spacing: 6) {
                                Circle().fill(pnl >= 0 ? Color.green : Color.red).frame(width: 8)
                                Text("\(active.setup.direction) \(Formatters.formatPrice(active.setup.entry))")
                                    .font(.caption)
                                if active.outcome.breakevenActivated {
                                    Text("BE")
                                        .font(.system(size: 8, weight: .bold))
                                        .padding(.horizontal, 4)
                                        .padding(.vertical, 1)
                                        .foregroundStyle(.orange)
                                        .background(Color.orange.opacity(0.2), in: Capsule())
                                }
                                Spacer()
                                Text(String(format: "%+.1f%%", pnl))
                                    .font(.caption.bold())
                                    .foregroundStyle(pnl >= 0 ? .green : .red)
                                Text("\(targetLabel) \(Formatters.formatPrice(distToTarget)) away")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Text("\(held)h")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(6)
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
        }

        // The interactive price chart lives in its own full-screen, non-scrolling Chart tab
        // (ChartScreenView) so its pan/zoom/axis gestures never fight this page's scroll. This
        // Overview tab keeps the price header, indicators, and analysis stack.

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

// MARK: - Chart tab (dedicated full-screen, non-scrolling)

/// A TradingView-style dedicated chart screen. It does NOT scroll — the main chart + enabled
/// sub-panels flex to fill the exact screen height (see chart.html), so the WKWebView owns every
/// gesture (pan / pinch / axis-stretch) without fighting a page ScrollView. The Overview tab
/// (ChartTabContent) keeps the price/indicators/analysis stack; this tab is purely the chart.
struct ChartScreenView: View {
    @EnvironmentObject var service: AnalysisService
    @Environment(\.colorScheme) private var colorScheme
    // Persisted (not @State): survives tab switches, and warmPush reads the same key so the
    // pre-rendered chart matches what this tab builds.
    @AppStorage("chart_tf_index") private var chartTFIndex = 1  // 0=Daily, 1=4H(crypto)/1H(stock), 2=1H
    @State private var chartPayload: ChartPayload?   // memoized; rebuilt only when inputs change
    // Toggleable sub-panels (persisted; shared keys with the classic panel switches).
    @AppStorage("chart_rsi") private var chRsi = true
    @AppStorage("chart_macd") private var chMacd = true
    @AppStorage("chart_stoch") private var chStoch = false
    @AppStorage("chart_adx") private var chAdx = false
    @AppStorage("chart_vol") private var chVol = true
    @AppStorage("chart_log") private var chLog = false

    private var selectedSymbol: String { service.currentSymbol ?? Constants.allCoins[0].id }

    private var panelsList: [String] {
        [chRsi ? "rsi" : nil, chMacd ? "macd" : nil, chStoch ? "stoch" : nil, chAdx ? "adx" : nil].compactMap { $0 }
    }

    /// A cheap signature of everything the chart payload depends on — the heavy ChartPayload.build
    /// (candle mapping + series alignment + JSON) runs only when THIS changes, not on every SwiftUI
    /// pass, so a live-price publish doesn't re-encode the whole candle set on the main thread.
    private var chartSignature: String {
        let r = service.currentResult
        let ts = r.map { Int($0.timestamp.timeIntervalSince1970) } ?? 0
        return "\(r?.symbol ?? "")|\(ts)|\(chartTFIndex)|\(panelsList.joined(separator: ","))|\(chVol)|\(chLog)|\(colorScheme == .dark)"
    }

    private func rebuildChart() {
        guard let result = service.currentResult, !result.tf1.candles.isEmpty else { chartPayload = nil; return }
        let tfs = [result.tf1, result.tf2, result.tf3]
        let selected = tfs[min(max(chartTFIndex, 0), tfs.count - 1)]
        chartPayload = ChartPayload.build(
            tf: selected.candles.isEmpty ? result.tf1 : selected,
            symbol: result.symbol,
            watchLevels: WatchLevels.build(result: result),
            dark: colorScheme == .dark, panels: panelsList, showVolume: chVol, logScale: chLog)
    }

    /// A small toggle chip for a chart sub-panel (RSI/MACD/Stoch/ADX/Vol).
    @ViewBuilder private func panelChip(_ title: String, _ isOn: Binding<Bool>) -> some View {
        Button { isOn.wrappedValue.toggle() } label: {
            Text(title)
                .font(.caption2).fontWeight(.medium)
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(isOn.wrappedValue ? Color.accentColor.opacity(0.22) : Color(.systemGray5))
                .foregroundStyle(isOn.wrappedValue ? Color.accentColor : .secondary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    var body: some View {
        VStack(spacing: 6) {
            // Instrument picker — same favorites pill row as Overview (tap to switch symbols).
            FavoritePillsView()

            if let result = service.currentResult, !result.tf1.candles.isEmpty {
                // Timeframe selector + panel toggles (price lives on the Overview tab, not here).
                Picker("Timeframe", selection: $chartTFIndex) {
                    Text(result.tf1.label).tag(0)
                    Text(result.tf2.label).tag(1)
                    Text(result.tf3.label).tag(2)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 12)

                HStack(spacing: 6) {
                    panelChip("RSI", $chRsi); panelChip("MACD", $chMacd); panelChip("Stoch", $chStoch)
                    panelChip("ADX", $chAdx); panelChip("Vol", $chVol); panelChip("Log", $chLog)
                    // ⟲ reset (native — the chart page takes no touches): autoscale + newest bar.
                    Button { ChartWebViewStore.shared.reset() } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 26, height: 22)
                            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                    Spacer()
                    Link("TradingView", destination: URL(string: "https://www.tradingview.com")!)
                        .font(.system(size: 9)).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 12)

                // Fills all remaining height → the chart + panels divide it (chart.html flex; panes
                // are drag-resizable). Rendered from the memoized payload, not rebuilt inline.
                if let payload = chartPayload {
                    WebChartView(payload: payload)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    Color.clear.frame(maxHeight: .infinity)
                }
            } else {
                Spacer()
                if service.isLoading {
                    ProgressView("Loading chart…").tint(.secondary)
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "chart.xyaxis.line").font(.system(size: 44)).foregroundStyle(.tertiary)
                        Text("No chart data").font(.subheadline).foregroundStyle(.tertiary)
                        Button("Load") { Task { await service.refreshIndicators(symbol: selectedSymbol) } }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                Spacer()
            }
        }
        .padding(.top, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
        .task {
            if service.currentSymbol == nil {
                await service.selectSymbol(Constants.allCoins[0].id)
            }
            rebuildChart()
        }
        .onChange(of: chartSignature) { rebuildChart() }
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
    @AppStorage("accountSize") private var accountSize: Double = 25000
    @AppStorage("riskPercent") private var riskPercent: Double = 2.0
    @AppStorage("contractSize") private var contractSize: Double = 0.01

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
        .task {
            historyCount = await AnalysisHistoryStore.loadAsync(symbol: selectedSymbol).count
        }
        .onChange(of: service.currentSymbol) {
            Task { historyCount = await AnalysisHistoryStore.loadAsync(symbol: selectedSymbol).count }
        }
        .onChange(of: service.currentResult?.analysisTimestamp) {
            Task { historyCount = await AnalysisHistoryStore.loadAsync(symbol: selectedSymbol).count }
        }
        .onChange(of: showHistory) {
            if !showHistory {
                Task { historyCount = await AnalysisHistoryStore.loadAsync(symbol: selectedSymbol).count }
            }
        }
    }

    @ViewBuilder
    private func aiContent(_ result: AnalysisResult) -> some View {
        // Setup summary card (Entry/SL/TP). Position sizing lives in the dedicated
        // PositionSizeCard below — the legacy inline "contracts" block was removed 2026-07-02
        // (it showed a THIRD, conflicting size story alongside the card + the server prompt,
        // used a hardcoded $500 fallback the card doesn't, and split 50%@1R/25%@TP1 which
        // contradicts the documented execution model of 50% off at TP1 + BE + runner to TP2).
        if let setup = result.tradeSetups.first {

            HStack(spacing: 12) {
                Text(setup.direction)
                    .font(.caption.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(setup.direction == "LONG" ? Color.green.opacity(0.2) : Color.red.opacity(0.2))
                    .foregroundStyle(setup.direction == "LONG" ? .green : .red)
                    .clipShape(Capsule())

                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text("Entry \(Formatters.formatPrice(setup.entry))")
                            .font(.caption)
                        Spacer()
                        if let ml = result.daily.mlWinProbability {
                            Text("ML \(Int(ml * 100))%")
                                .font(.caption.bold())
                                .foregroundStyle(ml >= 0.7 ? .green : ml >= 0.5 ? .primary : .gray)
                        }
                    }
                    HStack {
                        Text("SL \(Formatters.formatPrice(setup.stopLoss))")
                            .font(.caption2)
                            .foregroundStyle(.red)
                        Text("TP1 \(Formatters.formatPrice(setup.tp1)) (\(String(format: "%.1f", setup.rrTP1))R)")
                            .font(.caption2)
                            .foregroundStyle(.green)
                        if let tp2 = setup.tp2, let rr2 = setup.rrTP2 {
                            Text("TP2 \(Formatters.formatPrice(tp2)) (\(String(format: "%.1f", rr2))R)")
                                .font(.caption2)
                                .foregroundStyle(.green)
                        }
                    }
                }
            }
            .padding(10)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
        }

        // F-3 — pre-trade gut check, shown above the analysis whenever there's a setup to weigh.
        if !result.tradeSetups.isEmpty {
            SanityCheckCard(result: result)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

            // #2 — exact risk-based position size for each setup (tap "Adjust" for a live calculator).
            ForEach(result.tradeSetups) { setup in
                PositionSizeCard(symbol: result.symbol, setup: setup)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
        }

        ClaudeAnalysisView(markdown: result.claudeAnalysis, aiLoadingPhase: service.aiLoadingPhase, isStale: service.isAIStale, analysisTimestamp: result.analysisTimestamp, onRunAnalysis: {
            Task { await service.runFullAnalysis(symbol: selectedSymbol) }
        })
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        // Chart of the levels the analysis is watching — S/R, VWAP, POC/value area, and the setup's
        // entry/stop/targets — so you can see where price sits relative to what the text discusses.
        let watchLevels = WatchLevels.build(result: result)
        let levelCandles: [Candle] = result.tf2.candles.isEmpty ? result.daily.candles : result.tf2.candles
        if !watchLevels.isEmpty, !levelCandles.isEmpty {
            LevelsChartView(candles: levelCandles, currentPrice: result.daily.price,
                            levels: watchLevels, timeframeLabel: result.tf2.candles.isEmpty ? result.daily.label : result.tf2.label)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

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

        // Guard against empty candles (thin-mode fetch hiccup) — TradeSetupChartView's price
        // range falls back to 0 with no candles, squashing every line to the top.
        ForEach(result.tradeSetups) { setup in
            let setupCandles = result.tf3.candles.isEmpty ? result.tf2.candles : result.tf3.candles
            if !setupCandles.isEmpty {
                TradeSetupChartView(
                    candles: setupCandles,
                    setup: setup,
                    currentPrice: result.daily.price
                )
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
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
