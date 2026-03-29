import Foundation

@MainActor
class AnalysisService: ObservableObject {
    let binance = BinanceService()
    let yahoo = YahooFinanceService()
    let derivativesService = DerivativesService()
    let coinGecko = CoinGeckoService()
    let economicCalendar = EconomicCalendarService()
    let macroData = MacroDataService()
    var aiProvider: AIProvider?
    @Published var providerType: AIProviderType = .claude
    var alertsStore: AlertsStore?

    @Published var isLoading = false
    @Published var loadingStatus = ""
    @Published var lastResult: AnalysisResult?
    @Published var error: String?
    @Published var currentMarket: Market = .crypto
    @Published var currentSymbol: String?
    @Published var aiLoadingPhase: AILoadingPhase = .idle
    @Published var isAIStale = false

    enum AILoadingPhase: Equatable {
        case idle, preparingPrompt, waitingForResponse, parsingResponse
    }

    private var refreshTimer: Task<Void, Never>?

    @Published private(set) var resultsBySymbol: [String: AnalysisResult] = [:]
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
        currentMarket = market

        if let cached = resultsBySymbol[symbol] {
            lastResult = cached; error = nil
        } else if let diskCached = loadCache(symbol: symbol) {
            resultsBySymbol[symbol] = diskCached
            lastResult = diskCached; error = nil
        } else {
            lastResult = nil; error = nil
        }

        await refreshIndicators(symbol: symbol)
        startAutoRefresh(symbol: symbol)
    }

    /// Prefetch indicators for all favorites that aren't cached yet.
    func prefetchFavorites(_ symbols: [String]) {
        Task {
            for symbol in symbols where resultsBySymbol[symbol] == nil {
                // Load from disk first
                if let diskCached = loadCache(symbol: symbol) {
                    resultsBySymbol[symbol] = diskCached
                } else {
                    await refreshIndicators(symbol: symbol)
                }
            }
        }
    }

    // MARK: - Auto-Refresh

    func startAutoRefresh(symbol: String) {
        refreshTimer?.cancel()
        currentSymbol = symbol
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
        isLoading = true
        loadingStatus = "Fetching market data..."
        error = nil

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

            // Enhanced stock fundamentals
            if var si = stockInfo, market == .stock {
                if let enhanced = await yahoo.fetchEnhancedFundamentals(symbol: symbol) {
                    si.analystTargetMean = enhanced["targetMeanPrice"] as? Double
                    si.analystTargetHigh = enhanced["targetHighPrice"] as? Double
                    si.analystTargetLow = enhanced["targetLowPrice"] as? Double
                    si.analystCount = enhanced["numberOfAnalystOpinions"] as? Int
                    si.analystRating = enhanced["recommendationKey"] as? String
                    si.analystRatingScore = enhanced["recommendationMean"] as? Double
                    si.revenueGrowthYoY = (enhanced["revenueGrowth"] as? Double).map { $0 * 100 }
                    si.earningsGrowthYoY = (enhanced["earningsGrowth"] as? Double).map { $0 * 100 }
                    si.consecutiveBeats = enhanced["consecutiveBeats"] as? Int
                    si.avgEarningsSurprise = enhanced["avgSurprise"] as? Double
                    si.lastEarningsSurprise = enhanced["lastSurprise"] as? Double
                    si.insiderBuyCount6m = enhanced["insiderBuys"] as? Int
                    si.insiderSellCount6m = enhanced["insiderSells"] as? Int
                    si.insiderNetBuying = enhanced["insiderNetBuying"] as? Bool
                    si.epsEstimateCurrent = enhanced["epsEstimateCurrent"] as? Double
                    si.epsEstimate90dAgo = enhanced["epsEstimate90dAgo"] as? Double
                    si.revisionDirection = enhanced["revisionDirection"] as? String
                    si.upRevisions30d = enhanced["upRevisions30d"] as? Int
                    si.downRevisions30d = enhanced["downRevisions30d"] as? Int
                    if let exDivRaw = enhanced["exDividendDate"] as? Int {
                        let exDate = Date(timeIntervalSince1970: Double(exDivRaw))
                        si.exDividendDate = exDate
                        let days = Calendar.current.dateComponents([.day], from: Date(), to: exDate).day ?? 999
                        si.exDividendWarning = days >= 0 && days <= 5
                    }
                    si.dividendRate = enhanced["dividendRate"] as? Double
                    // Core fundamentals
                    if let mc = enhanced["marketCap"] as? Double { si.marketCap = mc }
                    if let pe = enhanced["peRatio"] as? Double { si.peRatio = pe }
                    if let eps = enhanced["eps"] as? Double { si.eps = eps }
                    if let dy = enhanced["dividendYield"] as? Double { si.dividendYield = dy }
                    if let s = enhanced["sector"] as? String { si.sector = s }
                    if let ind = enhanced["industry"] as? String { si.industry = ind }
                }
                if let comp = await yahoo.fetchSectorComparison(symbol: symbol, sector: si.sector) {
                    si.sectorETF = comp.etf
                    si.relativeStrength1d = comp.relStrength
                    si.outperformingSector = comp.outperforming
                }
                stockInfo = si
            }

            // Crypto derivatives (fails gracefully if geo-blocked)
            var derivData: DerivativesData? = nil
            var positioning: PositioningSnapshot? = nil
            if market == .crypto {
                derivData = await derivativesService.fetchDerivativesData(symbol: symbol)
                #if DEBUG
                print("[MarketScope] Derivatives for \(symbol): \(derivData != nil ? "OK" : "nil")")
                #endif
                if let d = derivData {
                    positioning = PositioningAnalyzer.analyze(data: d)
                    #if DEBUG
                    print("[MarketScope] Positioning: \(positioning?.crowding.rawValue ?? "nil"), squeeze: \(positioning?.squeezeRisk.level ?? "nil")")
                    #endif
                }
            }

            let events = await economicCalendar.highImpactUpcoming()

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
                economicEvents: events,
                claudeAnalysis: previous?.claudeAnalysis ?? "",
                tradeSetups: previous?.tradeSetups ?? []
            )

            resultsBySymbol[symbol] = result
            // Only update displayed result if this is the active symbol
            if symbol == currentSymbol {
                lastResult = result
                isLoading = false
                loadingStatus = ""
                isAIStale = !result.claudeAnalysis.isEmpty && !result.claudeAnalysis.contains("not configured") && (result.analysisTimestamp == nil || result.timestamp.timeIntervalSince(result.analysisTimestamp!) > 600)
            }
            alertsStore?.checkAlerts(prices: [symbol: result.daily.price])
            saveCache(result)

            // Update widget shared data
            let favs = (try? JSONDecoder().decode([String].self, from: UserDefaults.standard.data(forKey: "favorite_coins") ?? Data())) ?? []
            SharedDataManager.writeLatest(results: resultsBySymbol, favorites: favs)

            // Bias flip notification
            if let prev = previous,
               prev.daily.bias != result.daily.bias,
               UserDefaults.standard.bool(forKey: "notify_bias_flips") {
                let ticker = Constants.asset(for: symbol)?.ticker ?? symbol
                BiasNotificationManager.send(ticker: ticker, oldBias: prev.daily.bias, newBias: result.daily.bias)
            }

        } catch {
            if symbol == currentSymbol {
                self.error = error.localizedDescription
                self.isLoading = false
                self.loadingStatus = ""
                self.aiLoadingPhase = .idle
            }
        }
    }

    // MARK: - Full analysis: indicators + AI

    func runFullAnalysis(symbol: String) async {
        let market = marketFor(symbol)
        isLoading = true
        loadingStatus = "Fetching market data..."
        error = nil

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

            // Enhanced stock fundamentals
            if var si = stockInfo, market == .stock {
                if let enhanced = await yahoo.fetchEnhancedFundamentals(symbol: symbol) {
                    si.analystTargetMean = enhanced["targetMeanPrice"] as? Double
                    si.analystTargetHigh = enhanced["targetHighPrice"] as? Double
                    si.analystTargetLow = enhanced["targetLowPrice"] as? Double
                    si.analystCount = enhanced["numberOfAnalystOpinions"] as? Int
                    si.analystRating = enhanced["recommendationKey"] as? String
                    si.analystRatingScore = enhanced["recommendationMean"] as? Double
                    si.revenueGrowthYoY = (enhanced["revenueGrowth"] as? Double).map { $0 * 100 }
                    si.earningsGrowthYoY = (enhanced["earningsGrowth"] as? Double).map { $0 * 100 }
                    si.consecutiveBeats = enhanced["consecutiveBeats"] as? Int
                    si.avgEarningsSurprise = enhanced["avgSurprise"] as? Double
                    si.lastEarningsSurprise = enhanced["lastSurprise"] as? Double
                    si.insiderBuyCount6m = enhanced["insiderBuys"] as? Int
                    si.insiderSellCount6m = enhanced["insiderSells"] as? Int
                    si.insiderNetBuying = enhanced["insiderNetBuying"] as? Bool
                    si.epsEstimateCurrent = enhanced["epsEstimateCurrent"] as? Double
                    si.epsEstimate90dAgo = enhanced["epsEstimate90dAgo"] as? Double
                    si.revisionDirection = enhanced["revisionDirection"] as? String
                    si.upRevisions30d = enhanced["upRevisions30d"] as? Int
                    si.downRevisions30d = enhanced["downRevisions30d"] as? Int
                    if let exDivRaw = enhanced["exDividendDate"] as? Int {
                        let exDate = Date(timeIntervalSince1970: Double(exDivRaw))
                        si.exDividendDate = exDate
                        let days = Calendar.current.dateComponents([.day], from: Date(), to: exDate).day ?? 999
                        si.exDividendWarning = days >= 0 && days <= 5
                    }
                    si.dividendRate = enhanced["dividendRate"] as? Double
                    // Core fundamentals
                    if let mc = enhanced["marketCap"] as? Double { si.marketCap = mc }
                    if let pe = enhanced["peRatio"] as? Double { si.peRatio = pe }
                    if let eps = enhanced["eps"] as? Double { si.eps = eps }
                    if let dy = enhanced["dividendYield"] as? Double { si.dividendYield = dy }
                    if let s = enhanced["sector"] as? String { si.sector = s }
                    if let ind = enhanced["industry"] as? String { si.industry = ind }
                }
                if let comp = await yahoo.fetchSectorComparison(symbol: symbol, sector: si.sector) {
                    si.sectorETF = comp.etf
                    si.relativeStrength1d = comp.relStrength
                    si.outperformingSector = comp.outperforming
                }
                stockInfo = si
            }

            // Crypto derivatives (fall back to cached if fresh fetch fails)
            var derivData: DerivativesData? = nil
            var positioning: PositioningSnapshot? = nil
            if market == .crypto {
                derivData = await derivativesService.fetchDerivativesData(symbol: symbol)
                if derivData == nil, let cached = resultsBySymbol[symbol] {
                    derivData = cached.derivatives
                    #if DEBUG
                    print("[MarketScope] Derivatives fresh fetch nil, using cached")
                    #endif
                }
                #if DEBUG
                print("[MarketScope] Derivatives for \(symbol): \(derivData != nil ? "OK" : "nil")")
                #endif
                if let d = derivData {
                    positioning = PositioningAnalyzer.analyze(data: d)
                    #if DEBUG
                    print("[MarketScope] Positioning: \(positioning?.crowding.rawValue ?? "nil"), squeeze: \(positioning?.squeezeRisk.level ?? "nil")")
                    #endif
                }
            }

            let events = await economicCalendar.highImpactUpcoming()
            let macroSnapshot = await macroData.fetchMacroSnapshot()

            let claudeAnalysis: String
            let tradeSetups: [TradeSetup]
            if let provider = aiProvider {
                aiLoadingPhase = .preparingPrompt
                loadingStatus = "Preparing analysis..."
                aiLoadingPhase = .waitingForResponse
                loadingStatus = "Analyzing with \(provider.displayName)..."
                let response = try await provider.analyze(
                    indicators: [tf1, tf2, tf3],
                    sentiment: sentiment,
                    symbol: symbol,
                    market: market,
                    stockInfo: stockInfo,
                    derivatives: derivData,
                    positioning: positioning,
                    stockSentiment: stockSentiment,
                    economicEvents: events,
                    macro: macroSnapshot
                )
                aiLoadingPhase = .parsingResponse
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
                economicEvents: events,
                claudeAnalysis: claudeAnalysis,
                tradeSetups: tradeSetups
            )

            resultsBySymbol[symbol] = result
            lastResult = result
            isLoading = false
            loadingStatus = ""
            aiLoadingPhase = .idle
            isAIStale = false
            if let store = alertsStore, UserDefaults.standard.bool(forKey: "auto_alerts_enabled") {
                store.removeAlerts(forSymbol: symbol)
                if !tradeSetups.isEmpty {
                    let price = result.daily.price
                    for alert in tradeSetups.flatMap({ $0.toAlerts(symbol: symbol, currentPrice: price) }) {
                        store.addAlert(alert)
                    }
                }
            }
            saveCache(result)

        } catch {
            self.error = error.localizedDescription
            self.isLoading = false
            self.loadingStatus = ""
            self.aiLoadingPhase = .idle
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
                #if DEBUG
                print("[MarketLens] Cache save failed: \(error)")
                #endif
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
