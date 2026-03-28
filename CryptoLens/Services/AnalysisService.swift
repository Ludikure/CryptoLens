import Foundation

class AnalysisService: ObservableObject {
    let binance = BinanceService()
    let yahoo = YahooFinanceService()
    let derivativesService = DerivativesService()
    let coinGecko = CoinGeckoService()
    var aiProvider: AIProvider?
    @Published var providerType: AIProviderType = .claude
    var alertsStore: AlertsStore?

    @Published var isLoading = false
    @Published var loadingStatus = ""
    @Published var lastResult: AnalysisResult?
    @Published var error: String?
    @Published var currentMarket: Market = .crypto
    @Published var currentSymbol: String?

    private var refreshTimer: Task<Void, Never>?

    private(set) var resultsBySymbol: [String: AnalysisResult] = [:]
    var cachedResults: [String: AnalysisResult] { resultsBySymbol }

    private static var cacheDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("analyses", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    init() { autoConfigureKey() }

    func configure(provider: AIProviderType, apiKey: String, model: String) {
        providerType = provider
        switch provider {
        case .claude: aiProvider = ClaudeService(apiKey: apiKey, model: model)
        case .gemini: aiProvider = GeminiService(apiKey: apiKey, model: model)
        }
    }

    /// Determine market type for a symbol.
    func marketFor(_ symbol: String) -> Market {
        if Constants.coin(for: symbol) != nil { return .crypto }
        if Constants.stock(for: symbol) != nil { return .stock }
        // Unknown symbol — default to stock (Yahoo Finance covers most tickers)
        return .stock
    }

    /// Switch to a symbol — show cached instantly, then refresh.
    func selectSymbol(_ symbol: String) async {
        let market = marketFor(symbol)
        await MainActor.run { currentMarket = market }

        if let cached = resultsBySymbol[symbol] {
            await MainActor.run { lastResult = cached; error = nil }
        } else if let diskCached = loadCache(symbol: symbol) {
            resultsBySymbol[symbol] = diskCached
            await MainActor.run { lastResult = diskCached; error = nil }
        } else {
            await MainActor.run { lastResult = nil; error = nil }
        }

        await refreshIndicators(symbol: symbol)
        startAutoRefresh(symbol: symbol)
    }

    // MARK: - Auto-Refresh

    func startAutoRefresh(symbol: String) {
        refreshTimer?.cancel()
        Task { @MainActor in currentSymbol = symbol }
        refreshTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000) // 60s
                guard !Task.isCancelled, let self else { return }
                await self.refreshIndicators(symbol: symbol)
            }
        }
    }

    func stopAutoRefresh() {
        refreshTimer?.cancel()
        refreshTimer = nil
    }

    // MARK: - Quick refresh: indicators only

    func refreshIndicators(symbol: String) async {
        let market = marketFor(symbol)
        await MainActor.run {
            isLoading = true
            loadingStatus = "Fetching market data..."
            error = nil
        }

        do {
            let (tf1, tf2, tf3) = try await fetchAndCompute(symbol: symbol, market: market)
            let sentiment: CoinInfo? = market == .crypto ? (try? await coinGecko.fetchSentiment(symbol: symbol)) : nil
            let fearGreed = await coinGecko.fetchFearGreed()
            var stockInfo: StockInfo? = market == .stock ? (try? await yahoo.fetchQuote(symbol: symbol)) : nil
            var stockSentiment: StockSentimentData? = nil
            if stockInfo != nil && market == .stock {
                stockInfo?.earningsDate = await yahoo.fetchEarningsDate(symbol: symbol)
                stockSentiment = await yahoo.fetchStockSentiment(symbol: symbol)
            }

            // Crypto derivatives (fails gracefully if geo-blocked)
            var derivData: DerivativesData? = nil
            var positioning: PositioningSnapshot? = nil
            if market == .crypto {
                derivData = await derivativesService.fetchDerivativesData(symbol: symbol)
                if let d = derivData { positioning = PositioningAnalyzer.analyze(data: d) }
            }

            let previous = resultsBySymbol[symbol]
            let result = AnalysisResult(
                symbol: symbol,
                market: market,
                timestamp: Date(),
                analysisTimestamp: previous?.analysisTimestamp,
                tf1: tf1, tf2: tf2, tf3: tf3,
                sentiment: sentiment,
                fearGreed: fearGreed,
                stockInfo: stockInfo,
                derivatives: derivData,
                positioning: positioning,
                stockSentiment: stockSentiment,
                claudeAnalysis: previous?.claudeAnalysis ?? "",
                tradeSetups: previous?.tradeSetups ?? []
            )

            resultsBySymbol[symbol] = result
            await MainActor.run {
                lastResult = result
                isLoading = false
                loadingStatus = ""
                alertsStore?.checkAlerts(prices: [symbol: result.daily.price])
            }
            saveCache(result)

        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                self.isLoading = false
                self.loadingStatus = ""
            }
        }
    }

    // MARK: - Full analysis: indicators + AI

    func runFullAnalysis(symbol: String) async {
        let market = marketFor(symbol)
        await MainActor.run {
            isLoading = true
            loadingStatus = "Fetching market data..."
            error = nil
        }

        do {
            let (tf1, tf2, tf3) = try await fetchAndCompute(symbol: symbol, market: market)
            let sentiment: CoinInfo? = market == .crypto ? (try? await coinGecko.fetchSentiment(symbol: symbol)) : nil
            let fearGreed = await coinGecko.fetchFearGreed()
            var stockInfo: StockInfo? = market == .stock ? (try? await yahoo.fetchQuote(symbol: symbol)) : nil
            var stockSentiment: StockSentimentData? = nil
            if stockInfo != nil && market == .stock {
                stockInfo?.earningsDate = await yahoo.fetchEarningsDate(symbol: symbol)
                stockSentiment = await yahoo.fetchStockSentiment(symbol: symbol)
            }

            // Crypto derivatives
            var derivData: DerivativesData? = nil
            var positioning: PositioningSnapshot? = nil
            if market == .crypto {
                derivData = await derivativesService.fetchDerivativesData(symbol: symbol)
                if let d = derivData { positioning = PositioningAnalyzer.analyze(data: d) }
            }

            let claudeAnalysis: String
            let tradeSetups: [TradeSetup]
            if let provider = aiProvider {
                await MainActor.run { loadingStatus = "Analyzing with \(provider.displayName)..." }
                let response = try await provider.analyze(
                    indicators: [tf1, tf2, tf3],
                    sentiment: sentiment,
                    symbol: symbol,
                    market: market,
                    stockInfo: stockInfo,
                    derivatives: derivData,
                    positioning: positioning,
                    stockSentiment: stockSentiment
                )
                claudeAnalysis = response.markdown
                tradeSetups = response.setups
            } else {
                claudeAnalysis = "API key not configured. Set it in Settings to get AI analysis."
                tradeSetups = []
            }

            let now = Date()
            let result = AnalysisResult(
                symbol: symbol,
                market: market,
                timestamp: now,
                analysisTimestamp: claudeAnalysis.isEmpty || claudeAnalysis.contains("not configured") ? nil : now,
                tf1: tf1, tf2: tf2, tf3: tf3,
                sentiment: sentiment,
                fearGreed: fearGreed,
                stockInfo: stockInfo,
                derivatives: derivData,
                positioning: positioning,
                stockSentiment: stockSentiment,
                claudeAnalysis: claudeAnalysis,
                tradeSetups: tradeSetups
            )

            resultsBySymbol[symbol] = result
            await MainActor.run {
                lastResult = result
                isLoading = false
                loadingStatus = ""
                if let store = alertsStore {
                    // Only clear alerts for THIS symbol, keep others
                    store.removeAlerts(forSymbol: symbol)
                    if !tradeSetups.isEmpty {
                        let price = result.daily.price
                        for alert in tradeSetups.flatMap({ $0.toAlerts(symbol: symbol, currentPrice: price) }) {
                            store.addAlert(alert)
                        }
                    }
                }
            }
            saveCache(result)

        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                self.isLoading = false
                self.loadingStatus = ""
            }
        }
    }

    // MARK: - Fetch + compute for any market

    private func fetchAndCompute(symbol: String, market: Market) async throws -> (IndicatorResult, IndicatorResult, IndicatorResult) {
        let tfs = market.timeframes

        switch market {
        case .crypto:
            async let c1 = binance.fetchCandles(symbol: symbol, interval: tfs[0].interval, limit: 300)
            async let c2 = binance.fetchCandles(symbol: symbol, interval: tfs[1].interval, limit: 300)
            async let c3 = binance.fetchCandles(symbol: symbol, interval: tfs[2].interval, limit: 300)
            let r1 = IndicatorEngine.computeAll(candles: try await c1, timeframe: tfs[0].interval, label: tfs[0].label, market: market)
            let r2 = IndicatorEngine.computeAll(candles: try await c2, timeframe: tfs[1].interval, label: tfs[1].label, market: market)
            let r3 = IndicatorEngine.computeAll(candles: try await c3, timeframe: tfs[2].interval, label: tfs[2].label, market: market)
            return (r1, r2, r3)

        case .stock:
            async let c1 = yahoo.fetchCandles(symbol: symbol, interval: tfs[0].interval)
            async let c2 = yahoo.fetchCandles(symbol: symbol, interval: tfs[1].interval)
            async let c3 = yahoo.fetchCandles(symbol: symbol, interval: tfs[2].interval)
            let r1 = IndicatorEngine.computeAll(candles: try await c1, timeframe: tfs[0].interval, label: tfs[0].label, market: market)
            let r2 = IndicatorEngine.computeAll(candles: try await c2, timeframe: tfs[1].interval, label: tfs[1].label, market: market)
            let r3 = IndicatorEngine.computeAll(candles: try await c3, timeframe: tfs[2].interval, label: tfs[2].label, market: market)
            return (r1, r2, r3)
        }
    }

    // MARK: - Cache

    private func cacheURL(for symbol: String) -> URL {
        Self.cacheDir.appendingPathComponent("\(symbol).json")
    }

    private func saveCache(_ result: AnalysisResult) {
        let url = cacheURL(for: result.symbol)
        Task.detached(priority: .utility) {
            do {
                let data = try JSONEncoder().encode(result)
                try data.write(to: url, options: .atomic)
            } catch {
                print("[MarketLens] Cache save failed: \(error)")
            }
        }
    }

    private func loadCache(symbol: String) -> AnalysisResult? {
        let url = cacheURL(for: symbol)
        do {
            let data = try Data(contentsOf: url)
            let result = try JSONDecoder().decode(AnalysisResult.self, from: data)
            if Date().timeIntervalSince(result.timestamp) < 3600 { return result }
        } catch {}
        return nil
    }

    private func autoConfigureKey() {
        if let savedProvider = UserDefaults.standard.string(forKey: "ai_provider"),
           let type = AIProviderType(rawValue: savedProvider) {
            providerType = type
        }
        for type in [providerType] + AIProviderType.allCases.filter({ $0 != providerType }) {
            if let buildKey = Bundle.main.infoDictionary?[type.infoPlistKey] as? String,
               !buildKey.isEmpty, !buildKey.contains("API_KEY"), buildKey != "your-key-here" {
                KeychainHelper.save(key: type.keychainKey, value: buildKey)
                configure(provider: type, apiKey: buildKey, model: type.models[0].id)
                return
            }
            if let saved = KeychainHelper.load(key: type.keychainKey), !saved.isEmpty {
                configure(provider: type, apiKey: saved, model: type.models[0].id)
                return
            }
        }
    }
}
