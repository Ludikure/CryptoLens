import Foundation

@MainActor
class AnalysisService: ObservableObject {
    let binance = BinanceService()
    let yahoo = YahooFinanceService()
    let twelveData = TwelveDataProvider()
    let finnhub = FinnhubProvider()
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
        currentSymbol = symbol

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

    /// Prefetch data for all favorites that aren't cached yet.
    /// First pass: quick fetch (daily only) for fast watchlist population.
    /// Second pass: full refresh in background.
    func prefetchFavorites(_ symbols: [String]) {
        Task {
            // Pass 1: disk cache or quick fetch
            for symbol in symbols where resultsBySymbol[symbol] == nil {
                if let diskCached = loadCache(symbol: symbol) {
                    resultsBySymbol[symbol] = diskCached
                } else {
                    await quickFetch(symbol: symbol)
                }
            }
            // Pass 2: full refresh for stale/quick-fetched data (lower priority)
            for symbol in symbols where symbol != currentSymbol {
                await refreshIndicators(symbol: symbol)
            }
        }
    }

    /// Lightweight fetch — only daily candles + indicators for watchlist card.
    func quickFetch(symbol: String) async {
        guard resultsBySymbol[symbol] == nil else { return }
        guard !NetworkMonitor.shared.isOffline else { return }

        let market = marketFor(symbol)
        do {
            let tf = market.timeframes[0] // Daily only
            let candles: [Candle]
            switch market {
            case .crypto: candles = try await binance.fetchCandles(symbol: symbol, interval: tf.interval, limit: 300)
            case .stock:
                if let td = try? await twelveData.fetchCandles(symbol: symbol, interval: tf.interval, limit: 300), !td.isEmpty {
                    candles = td
                } else {
                    candles = try await yahoo.fetchCandles(symbol: symbol, interval: tf.interval)
                }
            }
            let tf1 = IndicatorEngine.computeAll(candles: candles, timeframe: tf.interval, label: tf.label, market: market)

            let result = AnalysisResult(
                symbol: symbol, market: market, timestamp: Date(),
                tf1: tf1, tf2: tf1, tf3: tf1,  // Same data for all 3 — placeholder until full refresh
                claudeAnalysis: "", tradeSetups: []
            )
            resultsBySymbol[symbol] = result
        } catch {
            #if DEBUG
            print("[MarketScope] [\(symbol)] quickFetch failed: \(error)")
            #endif
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
        // Skip if offline and we have cached data
        if NetworkMonitor.shared.isOffline {
            if resultsBySymbol[symbol] != nil {
                #if DEBUG
                print("[MarketScope] [\(symbol)] Offline — using cached data")
                #endif
                return
            }
            if symbol == currentSymbol {
                error = "No internet connection"
                isLoading = false
            }
            return
        }

        let market = marketFor(symbol)
        // Only show loading indicator if no cached data exists
        if resultsBySymbol[symbol] == nil {
            isLoading = true
            loadingStatus = "Fetching market data..."
        }
        error = nil

        do {
            let (tf1, tf2, tf3) = try await fetchAndCompute(symbol: symbol, market: market)
            if market == .crypto { ConnectionStatus.shared.binance = .ok }
            else { ConnectionStatus.shared.twelveData = .ok }
            let sentiment: CoinInfo? = market == .crypto ? (try? await coinGecko.fetchSentiment(symbol: symbol)) : nil
            let fearGreed = market == .crypto ? await coinGecko.fetchFearGreed() : nil
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

            // Finnhub enrichment (analyst recs, metrics, earnings, news)
            if var si = stockInfo, market == .stock {
                async let fhRec = finnhub.fetchRecommendations(symbol: symbol)
                async let fhMetrics = finnhub.fetchMetrics(symbol: symbol)
                async let fhEarnings = finnhub.fetchEarnings(symbol: symbol)
                async let fhNews = finnhub.fetchNews(symbol: symbol)

                if let rec = await fhRec {
                    si.finnhubBuy = rec.buy + rec.strongBuy
                    si.finnhubHold = rec.hold
                    si.finnhubSell = rec.sell + rec.strongSell
                    si.finnhubStrongBuy = rec.strongBuy
                    // Override Yahoo analyst count if Finnhub has data
                    let total = rec.buy + rec.hold + rec.sell + rec.strongBuy + rec.strongSell
                    if total > 0 { si.analystCount = total }
                }
                if let met = await fhMetrics {
                    // Fill gaps from Yahoo with Finnhub data
                    if si.peRatio == nil { si.peRatio = met.peRatio }
                    if si.eps == nil { si.eps = met.eps }
                    if si.marketCap == nil, let mc = met.marketCap { si.marketCap = mc * 1_000_000 } // Finnhub returns in millions
                    if si.dividendYield == nil { si.dividendYield = met.dividendYield.map { $0 * 100 } }
                    si.beta = met.beta
                }
                if let earn = await fhEarnings {
                    if si.earningsDate == nil { si.earningsDate = earn.date }
                }
                let news = await fhNews
                if !news.isEmpty { si.newsHeadlines = news }
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
            #if DEBUG
            print("[MarketScope] [\(symbol)] refreshIndicators error: \(error)")
            #endif
            let market = marketFor(symbol)
            if market == .crypto { ConnectionStatus.shared.binance = .error }
            else { ConnectionStatus.shared.twelveData = .error }

            if symbol == currentSymbol {
                if resultsBySymbol[symbol] != nil {
                    isLoading = false
                    loadingStatus = ""
                } else {
                    self.error = error.localizedDescription
                    self.isLoading = false
                    self.loadingStatus = ""
                }
                self.aiLoadingPhase = .idle
            }
        }
    }

    // MARK: - Full analysis: indicators + AI

    func runFullAnalysis(symbol: String) async {
        if NetworkMonitor.shared.isOffline {
            error = "No internet connection. Connect to a network and try again."
            aiLoadingPhase = .idle
            return
        }

        let market = marketFor(symbol)
        isLoading = true
        loadingStatus = "Fetching market data..."
        aiLoadingPhase = .preparingPrompt
        error = nil

        do {
            let (tf1, tf2, tf3) = try await fetchAndCompute(symbol: symbol, market: market)
            let sentiment: CoinInfo? = market == .crypto ? (try? await coinGecko.fetchSentiment(symbol: symbol)) : nil
            let fearGreed = market == .crypto ? await coinGecko.fetchFearGreed() : nil
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

            // Finnhub enrichment for full analysis
            if var si = stockInfo, market == .stock {
                async let fhRec = finnhub.fetchRecommendations(symbol: symbol)
                async let fhMetrics = finnhub.fetchMetrics(symbol: symbol)
                async let fhEarnings = finnhub.fetchEarnings(symbol: symbol)
                async let fhNews = finnhub.fetchNews(symbol: symbol)

                if let rec = await fhRec {
                    si.finnhubBuy = rec.buy + rec.strongBuy
                    si.finnhubHold = rec.hold
                    si.finnhubSell = rec.sell + rec.strongSell
                    si.finnhubStrongBuy = rec.strongBuy
                    let total = rec.buy + rec.hold + rec.sell + rec.strongBuy + rec.strongSell
                    if total > 0 { si.analystCount = total }
                }
                if let met = await fhMetrics {
                    if si.peRatio == nil { si.peRatio = met.peRatio }
                    if si.eps == nil { si.eps = met.eps }
                    if si.marketCap == nil, let mc = met.marketCap { si.marketCap = mc * 1_000_000 }
                    if si.dividendYield == nil { si.dividendYield = met.dividendYield.map { $0 * 100 } }
                    si.beta = met.beta
                }
                if let earn = await fhEarnings {
                    if si.earningsDate == nil { si.earningsDate = earn.date }
                }
                let news = await fhNews
                if !news.isEmpty { si.newsHeadlines = news }
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

            // Spot pressure for crypto (free Binance data)
            var spotPressure: SpotPressure? = nil
            if market == .crypto {
                spotPressure = await SpotPressureAnalyzer.analyze(symbol: symbol)
            }

            // Weekly context + SPY for stocks (Twelve Data, cached 24h on worker)
            var weeklyContext: String? = nil
            var spyContext: String? = nil
            if market == .stock {
                weeklyContext = await buildWeeklyContext(symbol: symbol)
                spyContext = await buildSPYContext()
            }

            let claudeAnalysis: String
            let tradeSetups: [TradeSetup]
            if let provider = aiProvider {
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
                    macro: macroSnapshot,
                    weeklyContext: weeklyContext,
                    spyContext: spyContext,
                    spotPressure: spotPressure
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

    // MARK: - Weekly + SPY Context

    private func buildWeeklyContext(symbol: String) async -> String? {
        guard let candles = try? await twelveData.fetchCandles(symbol: symbol, interval: "1week", limit: 20),
              candles.count >= 5 else { return nil }

        let result = IndicatorEngine.computeAll(candles: candles, timeframe: "1week", label: "Weekly")
        var lines = [String]()

        // Trend
        let recent5 = Array(candles.suffix(5))
        let greenCount = recent5.filter { $0.close >= $0.open }.count
        let trend = greenCount >= 4 ? "Bullish (\(greenCount) green weeks)" :
                    (greenCount <= 1 ? "Bearish (\(5 - greenCount) red weeks)" : "Mixed")
        lines.append("Weekly Trend: \(trend)")

        // EMA structure
        if let e20 = result.ema20, let e50 = result.ema50 {
            if e20 > e50 { lines.append("Weekly EMA: Bullish (20W > 50W)") }
            else { lines.append("Weekly EMA: Bearish (20W < 50W)") }
        }

        // RSI
        if let rsi = result.rsi {
            lines.append("Weekly RSI: \(String(format: "%.1f", rsi))")
        }

        // ATR
        if let atr = result.atr {
            lines.append("Weekly ATR: \(Formatters.formatPrice(atr.atr)) (\(atr.atrPercent)% avg range)")
        }

        // S/R from weekly
        if !result.supportResistance.supports.isEmpty {
            lines.append("Weekly Support: \(result.supportResistance.supports.prefix(3).map { Formatters.formatPrice($0) }.joined(separator: ", "))")
        }
        if !result.supportResistance.resistances.isEmpty {
            lines.append("Weekly Resistance: \(result.supportResistance.resistances.prefix(3).map { Formatters.formatPrice($0) }.joined(separator: ", "))")
        }

        // Position in range
        if let nearSup = result.supportResistance.supports.first,
           let nearRes = result.supportResistance.resistances.first,
           nearRes > nearSup {
            let position = (result.price - nearSup) / (nearRes - nearSup) * 100
            lines.append("Position in Weekly Range: \(String(format: "%.0f%%", position)) (0%=support, 100%=resistance)")
        }

        return lines.joined(separator: "\n")
    }

    private func buildSPYContext() async -> String? {
        guard let candles = try? await twelveData.fetchCandles(symbol: "SPY", interval: "1day", limit: 30),
              let last = candles.last else { return nil }

        let result = IndicatorEngine.computeAll(candles: candles, timeframe: "1d", label: "SPY Daily")
        var parts = [String]()

        parts.append("\(Formatters.formatPrice(last.close))")
        if candles.count >= 2 {
            let prev = candles[candles.count - 2].close
            let change = prev > 0 ? ((last.close - prev) / prev) * 100 : 0
            parts.append("(\(String(format: "%+.2f%%", change)))")
        }

        if let e20 = result.ema20 {
            parts.append(last.close > e20 ? "above 20D EMA" : "below 20D EMA")
        }
        if let rsi = result.rsi {
            parts.append("RSI \(String(format: "%.0f", rsi))")
        }

        let trend: String
        if let e20 = result.ema20, let e50 = result.ema50 {
            if last.close > e20 && e20 > e50 { trend = "bullish" }
            else if last.close < e20 && e20 < e50 { trend = "bearish" }
            else { trend = "mixed" }
        } else { trend = "unknown" }
        parts.append("— broad market \(trend)")

        return parts.joined(separator: " ")
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
            // Twelve Data for candles (native 4H, cached via worker)
            // Falls back to Yahoo if Twelve Data fails (4H degrades to 1H)
            var c1: [Candle]
            var c2: [Candle]
            var c3: [Candle]
            var tf2Interval = tfs[1].interval
            var tf2Label = tfs[1].label
            do {
                async let td1 = twelveData.fetchCandles(symbol: symbol, interval: tfs[0].interval, limit: 300)
                async let td2 = twelveData.fetchCandles(symbol: symbol, interval: tfs[1].interval, limit: 300)
                async let td3 = twelveData.fetchCandles(symbol: symbol, interval: tfs[2].interval, limit: 300)
                c1 = try await td1
                c2 = try await td2
                c3 = try await td3
                #if DEBUG
                print("[MarketScope] [\(symbol)] Using Twelve Data candles")
                #endif
            } catch {
                #if DEBUG
                print("[MarketScope] [\(symbol)] Twelve Data failed (\(error)), falling back to Yahoo (4H→1H)")
                #endif
                // Yahoo doesn't support 4H — degrade to 1H with correct labeling
                let yahooTf2 = tfs[1].interval == "4h" ? "1h" : tfs[1].interval
                if tfs[1].interval == "4h" {
                    tf2Interval = "1h"
                    tf2Label = "1H (Bias — 4H unavailable)"
                }
                async let y1 = yahoo.fetchCandles(symbol: symbol, interval: tfs[0].interval)
                async let y2 = yahoo.fetchCandles(symbol: symbol, interval: yahooTf2)
                async let y3 = yahoo.fetchCandles(symbol: symbol, interval: tfs[2].interval)
                c1 = try await y1
                c2 = try await y2
                c3 = try await y3
            }
            let r1 = IndicatorEngine.computeAll(candles: c1, timeframe: tfs[0].interval, label: tfs[0].label, market: market)
            let r2 = IndicatorEngine.computeAll(candles: c2, timeframe: tf2Interval, label: tf2Label, market: market)
            let r3 = IndicatorEngine.computeAll(candles: c3, timeframe: tfs[2].interval, label: tfs[2].label, market: market)
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
        // All AI calls go through the worker proxy — no local API keys needed.
        // Configure with empty key; ClaudeService uses the worker, not direct API.
        if let savedProvider = UserDefaults.standard.string(forKey: "ai_provider"),
           let type = AIProviderType(rawValue: savedProvider) {
            providerType = type
        }
        let type = providerType
        let model = type.models[0].id
        configure(provider: type, apiKey: "", model: model)
    }
}
