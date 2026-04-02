import SwiftUI

struct ChartTabView: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var favorites: FavoritesStore
    @EnvironmentObject var coordinator: NavigationCoordinator
    @State private var showPicker = false
    @State private var showWatchlist = false

    private var selectedSymbol: String {
        service.currentSymbol ?? Constants.allCoins[0].id
    }

    private var biasChanges: [String] {
        guard let result = service.currentResult else { return [] }
        let history = AnalysisHistoryStore.load(symbol: result.symbol)
        guard history.count >= 2 else { return [] }
        let prev = history[1]
        var changes = [String]()
        if result.tf1.bias != prev.tf1.bias { changes.append("\(result.tf1.label) flipped to \(result.tf1.bias)") }
        if result.tf2.bias != prev.tf2.bias { changes.append("\(result.tf2.label) flipped to \(result.tf2.bias)") }
        if result.tf3.bias != prev.tf3.bias { changes.append("\(result.tf3.label) flipped to \(result.tf3.bias)") }
        return changes
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    FavoritePillsView()
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))

                    // Offline banner
                    if NetworkMonitor.shared.isOffline {
                        offlineBanner
                    }

                    // Freshness timers
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
            .onAppear {
                if service.currentSymbol == nil {
                    Task { await service.selectSymbol(Constants.allCoins[0].id) }
                }
            }
            .onChange(of: coordinator.pendingSymbol) {
                if let symbol = coordinator.pendingSymbol {
                    selectSymbol(symbol)
                    coordinator.pendingSymbol = nil
                }
            }
        }
    }

    @ViewBuilder
    private func chartContent(_ result: AnalysisResult) -> some View {
        // Stale data banner
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

        // Bias changes
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

        Spacer().frame(height: 20)
            .listRowInsets(EdgeInsets())
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
