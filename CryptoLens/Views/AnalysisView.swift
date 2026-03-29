import SwiftUI

struct AnalysisView: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var favorites: FavoritesStore
    @EnvironmentObject var coordinator: NavigationCoordinator
    @State private var selectedSymbol = Constants.allCoins[0].id
    @State private var showPicker = false
    @State private var showWatchlist = false
    @State private var viewId = UUID()
    @State private var activeSection = "overview"

    private var selectedAssetName: String {
        Constants.asset(for: selectedSymbol)?.name ?? selectedSymbol
    }

    private var favoriteAssets: [(id: String, ticker: String)] {
        favorites.orderedFavorites.compactMap { sym in
            if let c = Constants.coin(for: sym) { return (c.id, c.ticker) }
            if let s = Constants.stock(for: sym) { return (s.id, s.ticker) }
            return nil
        }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { scrollProxy in
            List {
                // Section bar (pinned)
                if service.lastResult != nil {
                    AnalysisSectionBar(activeSection: $activeSection) { section in
                        withAnimation { scrollProxy.scrollTo(section, anchor: .top) }
                    }
                    .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color(.systemGroupedBackground))
                }

                Section {
                    // Favorite pills
                    if !favoriteAssets.isEmpty {
                        favoritePills
                            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 0, trailing: 16))
                    }

                    // Freshness timers
                    if let result = service.lastResult {
                        TimestampBar(dataTimestamp: result.timestamp, analysisTimestamp: result.analysisTimestamp)
                            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 4, trailing: 16))
                    }

                    if service.isLoading && service.lastResult == nil {
                        ShimmerPlaceholder(result: false)
                            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                            .id(viewId)
                    }

                    if let error = service.error {
                        errorView(error)
                            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    }

                    if let result = service.lastResult {
                        resultViews(result)
                    }

                    if !service.isLoading && service.lastResult == nil && service.error == nil {
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
                await service.runFullAnalysis(symbol: selectedSymbol)
                HapticManager.notification(.success)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Leading: favorite star
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        withAnimation { favorites.toggleFavorite(selectedSymbol) }
                        // Prefetch if newly added and not cached
                        if favorites.isFavorite(selectedSymbol) && service.resultsBySymbol[selectedSymbol] == nil {
                            Task { await service.refreshIndicators(symbol: selectedSymbol) }
                        }
                    } label: {
                        Image(systemName: favorites.isFavorite(selectedSymbol) ? "star.fill" : "star")
                            .foregroundStyle(favorites.isFavorite(selectedSymbol) ? .yellow : Color(.label))
                    }
                }

                // Watchlist grid
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { showWatchlist = true } label: {
                        Image(systemName: "square.grid.2x2")
                    }
                }

                // Center: coin name + chevron (opens picker)
                ToolbarItem(placement: .principal) {
                    Button { showPicker = true } label: {
                        HStack(spacing: 4) {
                            Text(selectedAssetName)
                                .font(.headline)
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.caption2)
                        }
                        .foregroundStyle(Color(.label))
                    }
                }

                // Trailing: share
                ToolbarItem(placement: .navigationBarTrailing) {
                    if service.lastResult != nil {
                        Menu {
                            ShareLink(item: shareText) {
                                Label("Share as Text", systemImage: "doc.text")
                            }
                            Button {
                                if let result = service.lastResult,
                                   let pdfData = renderAnalysisPDF(result: result) {
                                    let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("MarketScope_Analysis.pdf")
                                    try? pdfData.write(to: tempURL)
                                    if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                                       let root = scene.windows.first?.rootViewController {
                                        var top = root
                                        while let p = top.presentedViewController { top = p }
                                        let vc = UIActivityViewController(activityItems: [tempURL], applicationActivities: nil)
                                        top.present(vc, animated: true)
                                    }
                                }
                            } label: {
                                Label("Share as PDF", systemImage: "doc.richtext")
                            }
                        } label: {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                }
            }
            .sheet(isPresented: $showPicker) {
                CoinPickerView(selectedSymbol: $selectedSymbol)
            }
            .sheet(isPresented: $showWatchlist) {
                WatchlistView(selectedSymbol: $selectedSymbol)
            }
            .onAppear {
                // Force recreate loading animation when returning to tab
                viewId = UUID()
                // Only select on first appear or if symbol changed while away
                if service.currentSymbol != selectedSymbol {
                    Task { await service.selectSymbol(selectedSymbol) }
                }
            }
            .onChange(of: selectedSymbol) {
                HapticManager.selection()
                Task { await service.selectSymbol(selectedSymbol) }
            }
            .onChange(of: coordinator.pendingSymbol) {
                if let symbol = coordinator.pendingSymbol {
                    selectedSymbol = symbol
                    coordinator.pendingSymbol = nil
                }
            }
            } // ScrollViewReader
        }
    }

    // MARK: - Favorite Pills

    private var favoritePills: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(favoriteAssets, id: \.id) { asset in
                        let isSelected = asset.id == selectedSymbol
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                selectedSymbol = asset.id
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
                        .accessibilityLabel("\(asset.ticker), \(isSelected ? "selected" : "not selected")")
                        .id(asset.id)
                    }
                }
            }
            .onChange(of: selectedSymbol) {
                proxy.scrollTo(selectedSymbol, anchor: .center)
            }
        }
    }

    // MARK: - Subviews

    private func errorView(_ error: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title2)
                .foregroundStyle(.orange)
            Text(error)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") { Task { await service.refreshIndicators(symbol: selectedSymbol) } }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding()
    }

    private var biasChanges: [String] {
        guard let result = service.lastResult else { return [] }
        let history = AnalysisHistoryStore.load(symbol: result.symbol)
        guard history.count >= 2 else { return [] }
        let prev = history[1] // index 0 is current, 1 is previous
        var changes = [String]()
        if result.tf1.bias != prev.tf1.bias { changes.append("\(result.tf1.label) flipped to \(result.tf1.bias)") }
        if result.tf2.bias != prev.tf2.bias { changes.append("\(result.tf2.label) flipped to \(result.tf2.bias)") }
        if result.tf3.bias != prev.tf3.bias { changes.append("\(result.tf3.label) flipped to \(result.tf3.bias)") }
        return changes
    }

    @ViewBuilder
    private func resultViews(_ result: AnalysisResult) -> some View {
        // Stale data banner
        if Date().timeIntervalSince(result.timestamp) > 300 {
            let mins = Int(Date().timeIntervalSince(result.timestamp) / 60)
            HStack(spacing: 6) {
                Image(systemName: "clock.badge.exclamationmark")
                    .font(.caption)
                Text("Data from \(mins)m ago \u{00B7} Pull to refresh")
                    .font(.caption)
            }
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
        }

        // Bias changes from previous analysis
        if !biasChanges.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(biasChanges, id: \.self) { change in
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.caption2)
                        Text(change)
                            .font(.caption)
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
            .id("overview")
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        ConfidenceSummaryView(result: result)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        // Run Analysis button (prominent, near top)
        if result.claudeAnalysis.isEmpty || service.isAIStale {
            Button {
                Task { await service.runFullAnalysis(symbol: selectedSymbol) }
            } label: {
                HStack(spacing: 8) {
                    if service.aiLoadingPhase != .idle {
                        ProgressView().controlSize(.small)
                        Text(service.aiLoadingPhase == .waitingForResponse ? "Analyzing..." : "Preparing...")
                            .font(.subheadline).fontWeight(.semibold)
                    } else {
                        Image(systemName: "sparkles")
                        Text(service.isAIStale ? "Refresh AI Analysis" : "Run AI Analysis")
                            .font(.subheadline).fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .disabled(service.aiLoadingPhase != .idle)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Candlestick chart
        if !result.tf1.candles.isEmpty {
            CandlestickChartView(results: [result.tf1, result.tf2, result.tf3])
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Market section anchor
        Color.clear.frame(height: 0)
            .id("market")
            .listRowInsets(EdgeInsets())

        // Market-specific: Fear & Greed for crypto, Stock info for stocks
        if let fg = result.fearGreed {
            FearGreedView(index: fg)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
        if let si = result.stockInfo {
            StockInfoView(stockInfo: si, symbol: result.symbol)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Stock sentiment (stocks only)
        if let ss = result.stockSentiment {
            StockSentimentView(sentiment: ss)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Derivatives positioning (crypto only)
        if let d = result.derivatives, let p = result.positioning {
            DerivativesCardView(data: d, snapshot: p)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Economic calendar
        if !result.economicEvents.isEmpty {
            EconomicCalendarView(events: result.economicEvents)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // AI Analysis (visible early so users see pull-to-refresh hint)
        ClaudeAnalysisView(markdown: result.claudeAnalysis, aiLoadingPhase: service.aiLoadingPhase, isStale: service.isAIStale, onRunAnalysis: {
            Task { await service.runFullAnalysis(symbol: selectedSymbol) }
        })
            .id("ai")
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        IndicatorTableView(results: [result.tf1, result.tf2, result.tf3])
            .id("indicators")
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

        if let sentiment = result.sentiment {
            SentimentView(info: sentiment, symbol: result.symbol)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        Spacer().frame(height: 40)
            .listRowInsets(EdgeInsets())
    }

    private var emptyView: some View {
        VStack(spacing: 12) {
            Image(systemName: "chart.bar.xaxis")
                .font(.system(size: 44))
                .foregroundStyle(.tertiary)
            Text("Tap \(Image(systemName: "arrow.clockwise")) to analyze \(selectedAssetName)")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 60)
    }

    private var shareText: String {
        guard let r = service.lastResult else { return "" }
        var text = """
        \(r.symbol) Analysis — \(r.timestamp.formatted(date: .abbreviated, time: .shortened))

        Price: \(Formatters.formatPrice(r.daily.price))
        Bias: \(r.daily.bias) (D) | \(r.h4.bias) (4H) | \(r.h1.bias) (1H)

        Indicators (D / 4H / 1H):
        """
        if let rsi = r.daily.rsi, let rsi4 = r.h4.rsi, let rsi1 = r.h1.rsi {
            text += "\nRSI: \(String(format: "%.1f", rsi)) / \(String(format: "%.1f", rsi4)) / \(String(format: "%.1f", rsi1))"
        }
        if let m = r.daily.macd, let m4 = r.h4.macd, let m1 = r.h1.macd {
            text += "\nMACD Hist: \(String(format: "%.1f", m.histogram)) / \(String(format: "%.1f", m4.histogram)) / \(String(format: "%.1f", m1.histogram))"
        }
        if let a = r.daily.adx, let a4 = r.h4.adx, let a1 = r.h1.adx {
            text += "\nADX: \(Int(a.adx)) \(a.direction) / \(Int(a4.adx)) \(a4.direction) / \(Int(a1.adx)) \(a1.direction)"
        }
        text += "\n\n--- Claude Analysis ---\n\n\(r.claudeAnalysis)"
        text += "\n\nGenerated by MarketScope"
        return text
    }
}

// MARK: - Price Header

struct PriceHeaderView: View {
    let result: AnalysisResult

    private var change24h: Double? {
        result.sentiment?.priceChangePercentage24h
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Formatters.formatPrice(result.daily.price))
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                if let change = change24h {
                    Text(Formatters.formatPercent(change))
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(change >= 0 ? .green : .red)
                }
            }

            HStack(spacing: 10) {
                BiasPill(label: "Daily", bias: result.daily.bias, percent: result.daily.bullPercent)
                BiasPill(label: "4H", bias: result.h4.bias, percent: result.h4.bullPercent)
                BiasPill(label: "1H", bias: result.h1.bias, percent: result.h1.bullPercent)
            }
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct BiasPill: View {
    let label: String
    let bias: String
    let percent: Double

    private var color: Color {
        switch bias {
        case "Strong Bullish", "Bullish": return Color(.systemGreen).opacity(0.15)
        case "Strong Bearish", "Bearish": return Color(.systemRed).opacity(0.15)
        default: return Color(.systemGray5)
        }
    }

    private var textColor: Color {
        switch bias {
        case "Strong Bullish", "Bullish": return Color(.systemGreen)
        case "Strong Bearish", "Bearish": return Color(.systemRed)
        default: return .secondary
        }
    }

    private var shortBias: String {
        switch bias {
        case "Strong Bullish": return "Strong Bull"
        case "Bullish": return "Bullish"
        case "Strong Bearish": return "Strong Bear"
        case "Bearish": return "Bearish"
        default: return "Neutral"
        }
    }

    var body: some View {
        VStack(spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Text(shortBias)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(textColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(color, in: Capsule())
        }
        .accessibilityLabel("\(label) bias: \(shortBias)")
    }
}

// MARK: - Confidence Summary

private struct ConfidenceSummaryView: View {
    let result: AnalysisResult

    private var biases: [String] { [result.daily.bias, result.h4.bias, result.h1.bias] }
    private var bullishCount: Int { biases.filter { $0.contains("Bullish") }.count }
    private var bearishCount: Int { biases.filter { $0.contains("Bearish") }.count }
    private var total: Int { biases.count }

    private var avgBullPercent: Double {
        (result.daily.bullPercent + result.h4.bullPercent + result.h1.bullPercent) / 3.0
    }

    private var summaryText: String {
        if bullishCount > bearishCount {
            return "\(bullishCount)/\(total) Bullish"
        } else if bearishCount > bullishCount {
            return "\(bearishCount)/\(total) Bearish"
        } else {
            return "Mixed"
        }
    }

    private var summaryColor: Color {
        if bullishCount > bearishCount { return .green }
        if bearishCount > bullishCount { return .red }
        return .gray
    }

    private var summaryIcon: String {
        if bullishCount > bearishCount { return "arrow.up.circle.fill" }
        if bearishCount > bullishCount { return "arrow.down.circle.fill" }
        return "equal.circle.fill"
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: summaryIcon)
                .font(.title3)
                .foregroundStyle(summaryColor)

            Text(summaryText)
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundStyle(summaryColor)

            Spacer()

            // Capsule gauge
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color(.systemGray5))
                    .frame(width: 80, height: 8)
                Capsule()
                    .fill(gaugeGradient)
                    .frame(width: max(4, 80 * avgBullPercent / 100.0), height: 8)
            }

            Text("\(Int(avgBullPercent))%")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel(summaryText)
    }

    private var gaugeGradient: LinearGradient {
        LinearGradient(
            colors: [.red, .orange, .green],
            startPoint: .leading,
            endPoint: .trailing
        )
    }
}

