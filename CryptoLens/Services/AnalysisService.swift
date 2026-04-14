import Foundation

@MainActor
class AnalysisService: ObservableObject {
    let binance = BinanceService()
    let yahoo = YahooFinanceService()
    let twelveData = TwelveDataProvider()
    let tiingo = TiingoProvider()
    let finnhub = FinnhubProvider()
    let derivativesService = DerivativesService()
    let coinGecko = CoinGeckoService()
    let economicCalendar = EconomicCalendarService()
    let macroData = MacroDataService()
    private(set) var aiProvider: AIProvider?
    @Published var providerType: AIProviderType = .claude
    private(set) var alertsStore: AlertsStore?

    func configure(alertsStore: AlertsStore) {
        self.alertsStore = alertsStore
    }

    @Published var isLoading = false
    @Published var loadingStatus = ""
    @Published var lastResult: AnalysisResult?
    @Published var error: String?
    @Published var currentMarket: Market = .crypto
    @Published var currentSymbol: String?
    var watchlistSymbols: [String] = []
    @Published var aiLoadingPhase: AILoadingPhase = .idle
    @Published var isAIStale = false
    @Published var spotPressure: SpotPressure?
    @Published var macroSnapshot: MacroSnapshot?

    /// Tracks when slow-changing data was last fetched per symbol (fundamentals, Finnhub, etc.)
    private var lastEnrichmentFetch: [String: Date] = [:]
    private let enrichmentInterval: TimeInterval = 300  // 5 min between enrichment refreshes

    /// Returns the best available result for the selected symbol.
    /// Checks lastResult first, then falls back to resultsBySymbol cache.
    var currentResult: AnalysisResult? {
        if let result = lastResult, result.symbol == currentSymbol { return result }
        if let symbol = currentSymbol, let cached = resultsBySymbol[symbol] { return cached }
        return nil
    }

    enum AILoadingPhase: Equatable {
        case idle, preparingPrompt, waitingForResponse, parsingResponse
    }

    private var refreshTimer: Task<Void, Never>?

    @Published private(set) var resultsBySymbol: [String: AnalysisResult] = [:]
    var cachedResults: [String: AnalysisResult] { resultsBySymbol }

    /// Previous indicator snapshots for rate-of-change delta computation
    private var prevMLSnapshots: [String: (dRsi: Double, dAdx: Double, hRsi: Double, hAdx: Double, hMacdHist: Double,
                                           hRsiD1: Double, hMacdD1: Double, dRsiD1: Double,
                                           dAdxD1: Double)] = [:]
    /// Cached ETH/BTC price for cross-asset feature
    private var ethBtcPrice: Double = 0
    private var ethBtcPrevPrice: Double = 0
    /// Regime tracking for barsSinceRegimeChange
    private var lastRegime: [String: (code: Int, since: Date)] = [:]

    private nonisolated static var cacheDir: URL {
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

    /// Switch to a symbol — show cached or quick data instantly, then full refresh in background.
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
            // No cache at all — do a quick single-timeframe fetch for instant chart data
            await quickFetch(symbol: symbol)
            if let quick = resultsBySymbol[symbol], symbol == currentSymbol {
                lastResult = quick
            }
        }

        // Full 3-timeframe refresh in background
        guard symbol == currentSymbol else { return }
        await refreshIndicators(symbol: symbol)
        startAutoRefresh(symbol: symbol)
    }

    /// Unified symbol switch with cancellation — use from any view.
    /// Handles selectSymbol + spot pressure + macro fetch with a single cancellable task.
    private var switchTask: Task<Void, Never>?

    func switchToSymbol(_ symbol: String) {
        HapticManager.selection()
        currentSymbol = symbol
        currentMarket = marketFor(symbol)
        if let cached = resultsBySymbol[symbol] {
            lastResult = cached
        }
        switchTask?.cancel()
        switchTask = Task { [weak self] in
            guard let self else { return }
            await self.selectSymbol(symbol)
            guard !Task.isCancelled else { return }
            if self.marketFor(symbol) == .crypto {
                self.spotPressure = await SpotPressureAnalyzer.analyze(symbol: symbol)
            } else {
                self.spotPressure = nil
            }
            guard !Task.isCancelled else { return }
            self.macroSnapshot = await self.macroData.fetchMacroSnapshot()
        }
    }

    /// Prefetch data for all favorites that aren't cached yet.
    /// Pass 1: disk cache or quick fetch (daily only) for fast watchlist cards.
    /// Pass 2: full refresh for crypto only (stocks skip to avoid Twelve Data rate limit).
    func prefetchFavorites(_ symbols: [String]) {
        watchlistSymbols = symbols
        Task { [weak self] in
            guard let self else { return }
            // Pass 1: disk cache or quick fetch
            for symbol in symbols where resultsBySymbol[symbol] == nil {
                if let diskCached = loadCache(symbol: symbol) {
                    resultsBySymbol[symbol] = diskCached
                } else {
                    await quickFetch(symbol: symbol)
                }
            }
            // Pass 2: full refresh for crypto only (Binance has no rate issue).
            // Stocks stay on quick-fetched daily data until user taps them.
            // This avoids burning Twelve Data's 8/min limit on prefetch.
            for symbol in symbols where symbol != currentSymbol {
                if marketFor(symbol) == .crypto {
                    await refreshIndicators(symbol: symbol)
                }
            }
        }
    }

    /// Lightweight fetch — only daily candles + indicators for watchlist card.
    func quickFetch(symbol: String, force: Bool = false) async {
        guard force || resultsBySymbol[symbol] == nil else { return }
        guard !NetworkMonitor.shared.isOffline else { return }

        let market = marketFor(symbol)
        do {
            let tf = market.timeframes[0] // Daily only
            let candles: [Candle]
            switch market {
            case .crypto: candles = try await binance.fetchCandles(symbol: symbol, interval: tf.interval, limit: 300)
            case .stock:
                candles = try await yahoo.fetchCandles(symbol: symbol, interval: tf.interval)
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
        refreshTimer = Task { [weak self] in
            var cycleCount = 0
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 60_000_000_000) // 60s
                } catch { return }
                guard !Task.isCancelled, let self else { return }

                // Refresh current symbol first (UI updates)
                await self.refreshIndicators(symbol: symbol)

                // Then cycle through other watchlist symbols (score alerts)
                // Stocks refresh every 5th cycle (~5min) to avoid Yahoo rate pressure
                for fav in self.watchlistSymbols where fav != symbol {
                    guard !Task.isCancelled else { return }
                    if self.marketFor(fav) == .stock && cycleCount % 5 != 0 { continue }
                    await self.refreshIndicators(symbol: fav)
                }
                cycleCount += 1
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
            else { ConnectionStatus.shared.yahooFinance = .ok }
            // Determine if enrichment (slow-changing data) needs refresh
            let needsEnrichment: Bool
            if let lastFetch = lastEnrichmentFetch[symbol] {
                needsEnrichment = Date().timeIntervalSince(lastFetch) > enrichmentInterval
            } else {
                needsEnrichment = true
            }

            // Reuse previous enrichment data if still fresh
            let previous = resultsBySymbol[symbol]

            // Sentiment — only on enrichment cycles
            let sentiment: CoinInfo?
            let fearGreed: FearGreedIndex?
            if needsEnrichment && market == .crypto {
                sentiment = try? await coinGecko.fetchSentiment(symbol: symbol)
                fearGreed = await coinGecko.fetchFearGreed()
            } else {
                sentiment = previous?.sentiment
                fearGreed = previous?.fearGreed
            }

            // Stock quote (price updates every cycle), but fundamentals only on enrichment
            var stockInfo: StockInfo? = market == .stock ? (try? await yahoo.fetchQuote(symbol: symbol)) : nil
            var stockSentiment: StockSentimentData? = nil
            if stockInfo != nil && market == .stock {
                // VIX is intraday — always fetch stock sentiment (includes VIX, put/call, short interest)
                stockSentiment = await yahoo.fetchStockSentiment(symbol: symbol)
                if needsEnrichment {
                    stockInfo?.earningsDate = await yahoo.fetchEarningsDate(symbol: symbol)
                } else {
                    stockInfo?.earningsDate = previous?.stockInfo?.earningsDate
                }
            }

            // Enhanced fundamentals + Finnhub — only on enrichment cycles
            if var si = stockInfo, market == .stock, needsEnrichment {
                if let enhanced = await yahoo.fetchEnhancedFundamentals(symbol: symbol) {
                    applyEnhancedFundamentals(enhanced, to: &si)
                }
                if let comp = await yahoo.fetchSectorComparison(symbol: symbol, sector: si.sector) {
                    si.sectorETF = comp.etf
                    si.relativeStrength1d = comp.relStrength
                    si.outperformingSector = comp.outperforming
                }
                stockInfo = si
            } else if var si = stockInfo, market == .stock, let prev = previous?.stockInfo {
                // Carry forward enrichment from previous result
                si.earningsDate = si.earningsDate ?? prev.earningsDate
                si.analystTargetMean = si.analystTargetMean ?? prev.analystTargetMean
                si.analystTargetHigh = si.analystTargetHigh ?? prev.analystTargetHigh
                si.analystTargetLow = si.analystTargetLow ?? prev.analystTargetLow
                si.analystCount = si.analystCount ?? prev.analystCount
                si.analystRating = si.analystRating ?? prev.analystRating
                si.analystRatingScore = si.analystRatingScore ?? prev.analystRatingScore
                si.finnhubBuy = si.finnhubBuy ?? prev.finnhubBuy
                si.finnhubHold = si.finnhubHold ?? prev.finnhubHold
                si.finnhubSell = si.finnhubSell ?? prev.finnhubSell
                si.finnhubStrongBuy = si.finnhubStrongBuy ?? prev.finnhubStrongBuy
                si.beta = si.beta ?? prev.beta
                si.newsHeadlines = si.newsHeadlines ?? prev.newsHeadlines
                si.sector = si.sector ?? prev.sector
                si.industry = si.industry ?? prev.industry
                si.revenueGrowthYoY = si.revenueGrowthYoY ?? prev.revenueGrowthYoY
                si.earningsGrowthYoY = si.earningsGrowthYoY ?? prev.earningsGrowthYoY
                si.sectorETF = si.sectorETF ?? prev.sectorETF
                si.relativeStrength1d = si.relativeStrength1d ?? prev.relativeStrength1d
                si.outperformingSector = si.outperformingSector ?? prev.outperformingSector
                si.insiderTransactions = si.insiderTransactions ?? prev.insiderTransactions
                si.insiderBuyCount6m = si.insiderBuyCount6m ?? prev.insiderBuyCount6m
                si.insiderSellCount6m = si.insiderSellCount6m ?? prev.insiderSellCount6m
                si.insiderNetBuying = si.insiderNetBuying ?? prev.insiderNetBuying
                stockInfo = si
            }

            // Finnhub enrichment — only on enrichment cycles
            if var si = stockInfo, market == .stock, needsEnrichment {
                async let fhRec = finnhub.fetchRecommendations(symbol: symbol)
                async let fhMetrics = finnhub.fetchMetrics(symbol: symbol)
                async let fhEarnings = finnhub.fetchEarnings(symbol: symbol)
                async let fhNews = finnhub.fetchNews(symbol: symbol)
                async let fhInsider = finnhub.fetchInsiderTransactions(symbol: symbol)

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
                let insider = await fhInsider
                if !insider.isEmpty {
                    si.insiderTransactions = insider.prefix(10).map {
                        StockInfo.InsiderTx(name: $0.name, date: $0.date, shares: $0.shares, value: $0.value, isBuy: $0.isBuy)
                    }
                    let buys = insider.filter(\.isBuy).count
                    let sells = insider.filter { !$0.isBuy }.count
                    si.insiderBuyCount6m = buys
                    si.insiderSellCount6m = sells
                    si.insiderNetBuying = buys > sells
                }
                stockInfo = si
            }

            // Crypto derivatives — only on enrichment cycles
            var derivData: DerivativesData? = nil
            var positioning: PositioningSnapshot? = nil
            if market == .crypto {
                if needsEnrichment {
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
                } else {
                    derivData = previous?.derivatives
                    positioning = previous?.positioning
                }
            }

            let events = await economicCalendar.highImpactRelevant()
            _ = await macroData.fetchMacroSnapshot()

            if needsEnrichment { lastEnrichmentFetch[symbol] = Date() }

            // Compute rate-of-change deltas from previous refresh
            let prevSnap = prevMLSnapshots[symbol]
            let _dRsiDelta = prevSnap.map { (tf1.rsi ?? 50) - $0.dRsi } ?? 0
            let _dAdxDelta = prevSnap.map { (tf1.adx?.adx ?? 0) - $0.dAdx } ?? 0
            let _hRsiDelta = prevSnap.map { (tf2.rsi ?? 50) - $0.hRsi } ?? 0
            let _hAdxDelta = prevSnap.map { (tf2.adx?.adx ?? 0) - $0.hAdx } ?? 0
            let _hMacdHistDelta = prevSnap.map { (tf2.macd?.histogram ?? 0) - $0.hMacdHist } ?? 0
            // 1-bar deltas (same values as 6-bar but from single refresh interval)
            let _hRsiDelta1 = _hRsiDelta  // refresh-to-refresh = 1-bar equivalent
            let _hMacdHistDelta1 = _hMacdHistDelta
            let _dRsiDelta1 = _dRsiDelta
            let _dAdxDelta1 = _dAdxDelta
            // Acceleration: current delta - previous delta
            let _hRsiAccel = prevSnap.map { _hRsiDelta1 - $0.hRsiD1 } ?? 0
            let _hMacdAccel = prevSnap.map { _hMacdHistDelta1 - $0.hMacdD1 } ?? 0
            let _dAdxAccel = prevSnap.map { _dAdxDelta1 - $0.dAdxD1 } ?? 0
            prevMLSnapshots[symbol] = (dRsi: tf1.rsi ?? 50, dAdx: tf1.adx?.adx ?? 0,
                                        hRsi: tf2.rsi ?? 50, hAdx: tf2.adx?.adx ?? 0,
                                        hMacdHist: tf2.macd?.histogram ?? 0,
                                        hRsiD1: _hRsiDelta1, hMacdD1: _hMacdHistDelta1,
                                        dRsiD1: _dRsiDelta1, dAdxD1: _dAdxDelta1)

            // Fetch ETH/BTC for cross-asset (crypto only, lightweight)
            if market == .crypto {
                ethBtcPrevPrice = ethBtcPrice
                if let ethBtcCandles = try? await binance.fetchCandles(symbol: "ETHBTC", interval: "4h", limit: 2),
                   let last = ethBtcCandles.last {
                    ethBtcPrice = last.close
                }
            }
            let _ethBtcDelta = ethBtcPrevPrice > 0 ? (ethBtcPrice - ethBtcPrevPrice) / ethBtcPrevPrice * 100 : 0

            // Fetch basis (futures premium vs spot) for crypto
            var _basisPct = 0.0
            if market == .crypto {
                if let premiumData = try? await binance.fetchPremiumIndex(symbol: symbol) {
                    _basisPct = premiumData
                }
            }

            // Track regime for barsSinceRegimeChange
            let _adxLive = tf1.adx?.adx ?? 0
            let _stackBullLive = tf1.ema20.flatMap { e20 in tf1.ema50.flatMap { e50 in tf1.ema200.map { e200 in e20 > e50 && e50 > e200 } } } ?? false
            let _stackBearLive = tf1.ema20.flatMap { e20 in tf1.ema50.flatMap { e50 in tf1.ema200.map { e200 in e20 < e50 && e50 < e200 } } } ?? false
            let _regimeCodeLive = (_adxLive > 25 && (_stackBullLive || _stackBearLive)) ? 2 : _adxLive < 20 ? 0 : 1
            let _barsSinceRegime: Int
            if let prev = lastRegime[symbol], prev.code == _regimeCodeLive {
                _barsSinceRegime = min(Int(Date().timeIntervalSince(prev.since) / (4 * 3600)), 100)
            } else {
                lastRegime[symbol] = (code: _regimeCodeLive, since: Date())
                _barsSinceRegime = 0
            }

            // ML win probability — computed from Daily + 4H + 1H features
            var tf1ML = tf1
            let mlFeatures = Self.buildMLFeatures(tf1: tf1, tf2: tf2, tf3: tf3,
                                                   isCrypto: market == .crypto, derivCtx: derivData.map {
                DerivativesContext.from(data: $0, priceRising: tf2.price > (tf2.candles.dropLast().last?.close ?? tf2.price))
            }, vixValue: macroSnapshot?.vix,
               fearGreedValue: fearGreed?.value,
               ethBtcRatio: ethBtcPrice, ethBtcDelta: _ethBtcDelta,
               dRsiDelta: _dRsiDelta, dAdxDelta: _dAdxDelta,
               hRsiDelta: _hRsiDelta, hAdxDelta: _hAdxDelta,
               hMacdHistDelta: _hMacdHistDelta,
               barsSinceRegimeChange: _barsSinceRegime,
               hRsiDelta1: _hRsiDelta1, hMacdHistDelta1: _hMacdHistDelta1,
               dRsiDelta1: _dRsiDelta1,
               hRsiAccel: _hRsiAccel, hMacdAccel: _hMacdAccel, dAdxAccel: _dAdxAccel,
               basisPct: _basisPct)
            tf1ML.mlWinProbability = MLScoring.predict(features: mlFeatures)

            let prevResult = resultsBySymbol[symbol]
            let result = AnalysisResult(
                symbol: symbol,
                market: market,
                timestamp: Date(),
                analysisTimestamp: prevResult?.analysisTimestamp,
                tf1: tf1ML, tf2: tf2, tf3: tf3,
                sentiment: sentiment,
                fearGreed: fearGreed,
                stockInfo: stockInfo,
                derivatives: derivData,
                positioning: positioning,
                stockSentiment: stockSentiment,
                economicEvents: events,
                claudeAnalysis: prevResult?.claudeAnalysis ?? "",
                tradeSetups: prevResult?.tradeSetups ?? []
            )

            resultsBySymbol[symbol] = result
            // Only update displayed result if this is still the active symbol
            if symbol == currentSymbol {
                lastResult = result
                isLoading = false
                loadingStatus = ""
                isAIStale = !result.claudeAnalysis.isEmpty && !result.claudeAnalysis.contains("not configured") && (result.analysisTimestamp == nil || result.timestamp.timeIntervalSince(result.analysisTimestamp!) > 600)
            }
            alertsStore?.checkAlerts(prices: [symbol: result.daily.price])
            // Track setup/flat outcomes using 15m candles for precise wick detection
            let outcomeCandles: [Candle]
            if marketFor(symbol) == .crypto {
                outcomeCandles = (try? await binance.fetchCandles(symbol: symbol, interval: "15m", limit: 96)) ?? result.h1.candles
            } else {
                outcomeCandles = (try? await yahoo.fetchCandles(symbol: symbol, interval: "15m")) ?? result.h1.candles
            }
            OutcomeTracker.trackSetupOutcomes(symbol: symbol, currentPrice: result.daily.price, recentCandles: outcomeCandles)
            OutcomeTracker.trackFlatOutcomes(symbol: symbol, currentPrice: result.daily.price)
            OutcomeTracker.syncResolvedOutcomes(symbol: symbol)
            saveCache(result)

            // Widget shared data disabled until App Group is provisioned

            // Bias flip notification
            if let prev = prevResult,
               prev.daily.bias != result.daily.bias,
               UserDefaults.standard.bool(forKey: "notify_bias_flips") {
                let ticker = Constants.asset(for: symbol)?.ticker ?? symbol
                BiasNotificationManager.send(ticker: ticker, oldBias: prev.daily.bias, newBias: result.daily.bias)
            }

            // Note: bias flip and ML threshold notifications are independent —
            // both can fire for the same refresh if a flip coincides with a threshold crossing.
            // ML probability notification — fires when win probability crosses 0.60
            if let prev = prevResult,
               UserDefaults.standard.bool(forKey: "notify_score_threshold") {
                let prevML = prev.daily.mlWinProbability ?? 0
                let newML = result.daily.mlWinProbability ?? 0
                let mlThreshold = 0.60

                // Only notify when ML probability CROSSES above threshold (not every refresh)
                if prevML < mlThreshold && newML >= mlThreshold {
                    let ticker = Constants.asset(for: symbol)?.ticker ?? symbol
                    let dailyScore = result.daily.biasScore
                    let fourHScore = result.h4.biasScore
                    let strongerScore = abs(dailyScore) >= abs(fourHScore) ? dailyScore : fourHScore
                    let direction = strongerScore > 0 ? "Bullish" : "Bearish"
                    BiasNotificationManager.sendScoreAlert(
                        ticker: ticker,
                        score: strongerScore,
                        direction: "\(direction) (ML: \(Int(newML * 100))%)")
                }
            }

        } catch is CancellationError {
            // Expected when switching symbols — silently ignore
        } catch let error as NSError where error.code == NSURLErrorCancelled {
            // Expected when switching symbols — silently ignore
        } catch {
            #if DEBUG
            print("[MarketScope] [\(symbol)] refreshIndicators error: \(error)")
            #endif
            // Only update UI state if this is still the active symbol
            guard symbol == currentSymbol else { return }
            let market = marketFor(symbol)
            if market == .crypto { ConnectionStatus.shared.binance = .error }
            else { ConnectionStatus.shared.yahooFinance = .error }

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
            var dataQuality = DataQuality()

            // Cross-asset context + derivatives for crypto (fetched concurrently)
            let crossAsset: CrossAssetContext?
            var earlyDerivData: DerivativesData? = nil
            if market == .crypto {
                async let ca = buildCrossAssetContext()
                async let dd = derivativesService.fetchDerivativesData(symbol: symbol)
                crossAsset = await ca
                earlyDerivData = await dd
            } else {
                crossAsset = nil
            }

            var (tf1, tf2, tf3) = try await fetchAndCompute(symbol: symbol, market: market, crossAsset: crossAsset, derivatives: earlyDerivData)

            // ML win probability for the AI prompt — use same snapshot as refresh path
            let prevFG = resultsBySymbol[symbol]?.fearGreed?.value
            let snap2 = prevMLSnapshots[symbol]
            let _basisPct2 = market == .crypto ? (try? await binance.fetchPremiumIndex(symbol: symbol)) ?? 0 : 0.0
            let mlFeatures2 = Self.buildMLFeatures(tf1: tf1, tf2: tf2, tf3: tf3,
                                                    isCrypto: market == .crypto, derivCtx: earlyDerivData.map {
                DerivativesContext.from(data: $0, priceRising: tf2.price > (tf2.candles.dropLast().last?.close ?? tf2.price))
            }, vixValue: macroSnapshot?.vix, crossAsset: crossAsset,
               fearGreedValue: prevFG,
               ethBtcRatio: ethBtcPrice, ethBtcDelta: ethBtcPrevPrice > 0 ? (ethBtcPrice - ethBtcPrevPrice) / ethBtcPrevPrice * 100 : 0,
               dRsiDelta: snap2.map { (tf1.rsi ?? 50) - $0.dRsi } ?? 0,
               dAdxDelta: snap2.map { (tf1.adx?.adx ?? 0) - $0.dAdx } ?? 0,
               hRsiDelta: snap2.map { (tf2.rsi ?? 50) - $0.hRsi } ?? 0,
               hAdxDelta: snap2.map { (tf2.adx?.adx ?? 0) - $0.hAdx } ?? 0,
               hMacdHistDelta: snap2.map { (tf2.macd?.histogram ?? 0) - $0.hMacdHist } ?? 0,
               hRsiDelta1: snap2.map { (tf2.rsi ?? 50) - $0.hRsi } ?? 0,
               hMacdHistDelta1: snap2.map { (tf2.macd?.histogram ?? 0) - $0.hMacdHist } ?? 0,
               dRsiDelta1: snap2.map { (tf1.rsi ?? 50) - $0.dRsi } ?? 0,
               hRsiAccel: snap2.map { ((tf2.rsi ?? 50) - $0.hRsi) - $0.hRsiD1 } ?? 0,
               hMacdAccel: snap2.map { ((tf2.macd?.histogram ?? 0) - $0.hMacdHist) - $0.hMacdD1 } ?? 0,
               dAdxAccel: snap2.map { ((tf1.adx?.adx ?? 0) - $0.dAdx) - $0.dAdxD1 } ?? 0,
               basisPct: _basisPct2)
            tf1.mlWinProbability = MLScoring.predict(features: mlFeatures2)

            // Candle staleness check: how old is the latest candle?
            if let latestCandle = tf3.candles.last {
                dataQuality.candleStaleness = Date().timeIntervalSince(latestCandle.time)
            }

            let sentiment: CoinInfo?
            if market == .crypto {
                sentiment = try? await coinGecko.fetchSentiment(symbol: symbol)
                if sentiment == nil { dataQuality.sentimentOK = false }
            } else { sentiment = nil }

            let fearGreed = market == .crypto ? await coinGecko.fetchFearGreed() : nil

            var stockInfo: StockInfo?
            if market == .stock {
                stockInfo = try? await yahoo.fetchQuote(symbol: symbol)
                if stockInfo == nil { dataQuality.stockInfoOK = false }
            } else { stockInfo = nil }
            var stockSentiment: StockSentimentData? = nil
            if stockInfo != nil && market == .stock {
                stockInfo?.earningsDate = await yahoo.fetchEarningsDate(symbol: symbol)
                stockSentiment = await yahoo.fetchStockSentiment(symbol: symbol)
            }

            // Enhanced stock fundamentals
            if var si = stockInfo, market == .stock {
                if let enhanced = await yahoo.fetchEnhancedFundamentals(symbol: symbol) {
                    applyEnhancedFundamentals(enhanced, to: &si)
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
                async let fhInsider = finnhub.fetchInsiderTransactions(symbol: symbol)

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
                let insider = await fhInsider
                if !insider.isEmpty {
                    si.insiderTransactions = insider.prefix(10).map {
                        StockInfo.InsiderTx(name: $0.name, date: $0.date, shares: $0.shares, value: $0.value, isBuy: $0.isBuy)
                    }
                    let buys = insider.filter(\.isBuy).count
                    let sells = insider.filter { !$0.isBuy }.count
                    si.insiderBuyCount6m = buys
                    si.insiderSellCount6m = sells
                    si.insiderNetBuying = buys > sells
                }
                stockInfo = si
            }

            // Crypto derivatives (reuse early fetch, fall back to cached)
            var derivData: DerivativesData? = earlyDerivData
            var positioning: PositioningSnapshot? = nil
            if market == .crypto {
                if derivData == nil, let cached = resultsBySymbol[symbol] {
                    derivData = cached.derivatives
                    #if DEBUG
                    print("[MarketScope] Derivatives fresh fetch nil, using cached")
                    #endif
                }
                if derivData == nil { dataQuality.derivativesOK = false }
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

            let events = await economicCalendar.highImpactRelevant()
            if events.isEmpty { dataQuality.economicCalendarOK = false }
            let macroSnapshot = await macroData.fetchMacroSnapshot()
            if macroSnapshot == nil { dataQuality.macroOK = false }

            // Spot pressure for crypto (free Binance data)
            var spotPressure: SpotPressure? = nil
            if market == .crypto {
                spotPressure = await SpotPressureAnalyzer.analyze(symbol: symbol)
                if spotPressure == nil { dataQuality.spotPressureOK = false }
            }

            // Weekly context + SPY for stocks
            var weeklyContext: String? = nil
            var spyContext: String? = nil
            if market == .stock {
                weeklyContext = await buildWeeklyContext(symbol: symbol)
                spyContext = await buildSPYContext()
                if weeklyContext == nil { dataQuality.weeklyContextOK = false }
            }

            // Log data quality
            #if DEBUG
            if let summary = dataQuality.uiSummary {
                print("[MarketScope] [\(symbol)] Data quality: \(summary)")
            }
            #endif

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
                    spotPressure: spotPressure,
                    dataQuality: dataQuality,
                    crossAsset: crossAsset
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
            HapticManager.notification(.success)
            AnalysisHistoryStore.save(result)

            // Outcome tracking: register new setups (skip stocks outside market hours)
            let shouldTrack = market == .crypto || MarketHours.isMarketOpen()
            if shouldTrack {
                for setup in tradeSetups {
                    OutcomeTracker.registerSetup(setup, symbol: symbol, analysisId: result.id)
                }
            }
            // Track FLAT/kill outcomes
            if tradeSetups.isEmpty && !result.claudeAnalysis.isEmpty {
                let reason = result.claudeAnalysis.contains("BLOCKED") ? "KILL" :
                             result.claudeAnalysis.contains("Rule 2") ? "FLAT_Rule2" :
                             result.claudeAnalysis.contains("NO SETUP") ? "FLAT" : "NO_SETUP"
                OutcomeTracker.registerFlatOutcome(symbol: symbol, price: result.daily.price, reason: reason)
            }

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
            HapticManager.notification(.error)
        }
    }

    // MARK: - Weekly + SPY Context

    private func buildWeeklyContext(symbol: String) async -> String? {
        guard let candles = try? await yahoo.fetchCandles(symbol: symbol, interval: "1wk"),
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
        guard let candles = try? await yahoo.fetchCandles(symbol: "SPY", interval: "1d"),
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

    // MARK: - ML Features

    static func buildMLFeatures(tf1: IndicatorResult, tf2: IndicatorResult, tf3: IndicatorResult,
                                 isCrypto: Bool, derivCtx: DerivativesContext?,
                                 vixValue: Double? = nil, crossAsset: CrossAssetContext? = nil,
                                 fearGreedValue: Int? = nil,
                                 ethBtcRatio: Double = 0, ethBtcDelta: Double = 0,
                                 dRsiDelta: Double = 0, dAdxDelta: Double = 0,
                                 hRsiDelta: Double = 0, hAdxDelta: Double = 0,
                                 hMacdHistDelta: Double = 0,
                                 barsSinceRegimeChange: Int = 0,
                                 hRsiDelta1: Double = 0, hMacdHistDelta1: Double = 0,
                                 dRsiDelta1: Double = 0,
                                 hRsiAccel: Double = 0, hMacdAccel: Double = 0,
                                 dAdxAccel: Double = 0,
                                 basisPct: Double = 0) -> MLFeatures {
        func emaCross(_ r: IndicatorResult) -> Int {
            var c = 0
            if let e = r.ema20 { c += r.price > e ? 1 : -1 }
            if let e = r.ema50 { c += r.price > e ? 1 : -1 }
            if let e = r.ema200 { c += r.price > e ? 1 : -1 }
            return c
        }
        func stackBull(_ r: IndicatorResult) -> Bool {
            guard let e20 = r.ema20, let e50 = r.ema50, let e200 = r.ema200 else { return false }
            return e20 > e50 && e50 > e200
        }
        func stackBear(_ r: IndicatorResult) -> Bool {
            guard let e20 = r.ema20, let e50 = r.ema50, let e200 = r.ema200 else { return false }
            return e20 < e50 && e50 < e200
        }
        func ema20Rising(_ r: IndicatorResult) -> Bool {
            let s = r.ema20Series
            return s.count >= 6 && s[s.count - 1] > s[s.count - 6]
        }
        let price = tf1.price
        let candles = tf2.candles
        let n = candles.count

        // Pre-compute to help Swift type-checker
        let _dStochCross: Int = tf1.stochRSI?.crossover == "bullish" ? 1 : tf1.stochRSI?.crossover == "bearish" ? -1 : 0
        let _dMacdCross: Int = tf1.macd?.crossover == "bullish" ? 1 : tf1.macd?.crossover == "bearish" ? -1 : 0
        let _dDivergence: Int = tf1.divergence?.contains("bullish") == true ? 1 : tf1.divergence?.contains("bearish") == true ? -1 : 0
        let _hStochCross: Int = tf2.stochRSI?.crossover == "bullish" ? 1 : tf2.stochRSI?.crossover == "bearish" ? -1 : 0
        let _hMacdCross: Int = tf2.macd?.crossover == "bullish" ? 1 : tf2.macd?.crossover == "bearish" ? -1 : 0
        let _hDivergence: Int = tf2.divergence?.contains("bullish") == true ? 1 : tf2.divergence?.contains("bearish") == true ? -1 : 0
        let _dAboveVwap: Bool = tf1.vwap.map { price > $0.vwap } ?? false
        let _hAboveVwap: Bool = tf2.vwap.map { price > $0.vwap } ?? false
        let _dxyAbove: Bool = crossAsset.map { $0.dxyPrice > $0.dxyEma20 } ?? false
        let _l3Green: Bool = n >= 3 && candles[(n-3)...].allSatisfy { $0.close > $0.open }
        let _l3Red: Bool = n >= 3 && candles[(n-3)...].allSatisfy { $0.close < $0.open }
        let _l3Vol: Bool = n >= 3 && candles[n-2].volume > candles[n-3].volume && candles[n-1].volume > candles[n-2].volume
        let _dStructBull = tf1.marketStructure?.label.contains("bullish") ?? false
        let _dStructBear = tf1.marketStructure?.label.contains("bearish") ?? false
        let _hStructBull = tf2.marketStructure?.label.contains("bullish") ?? false
        let _hStructBear = tf2.marketStructure?.label.contains("bearish") ?? false
        let _dBull = tf1.biasScore > 3
        let _dBear = tf1.biasScore < -3
        let _hBull = tf2.biasScore > 3
        let _hBear = tf2.biasScore < -3
        let _dMacdHist = tf1.macd?.histogram ?? 0.0
        let _hMacdHist = tf2.macd?.histogram ?? 0.0

        // Cross-timeframe interactions
        var _tfAlign = 0
        if _dBull { _tfAlign += 1 } else if _dBear { _tfAlign -= 1 }
        if _hBull { _tfAlign += 1 } else if _hBear { _tfAlign -= 1 }
        let _momAlign: Int = (_dMacdHist > 0 && _hMacdHist > 0) ? 1 : (_dMacdHist < 0 && _hMacdHist < 0) ? -1 : 0
        let _structAlign: Int = (_dStructBull && _hStructBull) ? 1 : (_dStructBear && _hStructBear) ? -1 : 0

        // Regime code
        let _adx = tf1.adx?.adx ?? 0.0
        let _regimeCode: Int = (_adx > 25 && (stackBull(tf1) || stackBear(tf1))) ? 2 : _adx < 20 ? 0 : 1

        return MLFeatures(
            dRsi: tf1.rsi ?? 50, dMacdHist: _dMacdHist,
            dAdx: _adx, dAdxBullish: tf1.adx?.direction == "Bullish",
            dEmaCross: emaCross(tf1), dStackBull: stackBull(tf1), dStackBear: stackBear(tf1),
            dStructBull: _dStructBull, dStructBear: _dStructBear,
            dStochK: tf1.stochRSI?.k ?? 50, dStochCross: _dStochCross,
            dMacdCross: _dMacdCross, dDivergence: _dDivergence, dEma20Rising: ema20Rising(tf1),
            dBBPercentB: tf1.bollingerBands?.percentB ?? 0.5, dBBSqueeze: tf1.bollingerBands?.squeeze ?? false,
            dBBBandwidth: tf1.bollingerBands?.bandwidth ?? 0, dVolumeRatio: tf1.volumeRatio ?? 1.0,
            dAboveVwap: _dAboveVwap,
            hRsi: tf2.rsi ?? 50, hMacdHist: _hMacdHist,
            hAdx: tf2.adx?.adx ?? 0, hAdxBullish: tf2.adx?.direction == "Bullish",
            hEmaCross: emaCross(tf2), hStackBull: stackBull(tf2), hStackBear: stackBear(tf2),
            hStructBull: _hStructBull, hStructBear: _hStructBear,
            hStochK: tf2.stochRSI?.k ?? 50, hStochCross: _hStochCross,
            hMacdCross: _hMacdCross, hDivergence: _hDivergence, hEma20Rising: ema20Rising(tf2),
            hBBPercentB: tf2.bollingerBands?.percentB ?? 0.5, hBBSqueeze: tf2.bollingerBands?.squeeze ?? false,
            hBBBandwidth: tf2.bollingerBands?.bandwidth ?? 0, hVolumeRatio: tf2.volumeRatio ?? 1.0,
            hAboveVwap: _hAboveVwap,
            eRsi: tf3.rsi ?? 50, eEmaCross: emaCross(tf3),
            eStochK: tf3.stochRSI?.k ?? 50, eMacdHist: tf3.macd?.histogram ?? 0,
            fundingSignal: derivCtx?.fundingSignal ?? 0, oiSignal: derivCtx?.oiSignal ?? 0,
            takerSignal: derivCtx?.takerSignal ?? 0, crowdingSignal: derivCtx?.crowdingSignal ?? 0,
            derivativesCombined: derivCtx?.combinedSignal ?? 0,
            fundingRateRaw: derivCtx?.fundingRateRaw ?? 0,
            oiChangePct: derivCtx?.oiChangePct ?? 0,
            takerRatioRaw: derivCtx?.takerRatioRaw ?? 1.0,
            longPctRaw: derivCtx?.longPctRaw ?? 50,
            vix: vixValue ?? 20, dxyAboveEma20: _dxyAbove, volScalar: tf1.volScalar ?? 1.0,
            last3Green: _l3Green, last3Red: _l3Red, last3VolIncreasing: _l3Vol,
            obvRising: tf1.obv?.trend == "Rising",
            adLineAccumulation: tf1.adLine?.trend == "Accumulation",
            atrPercent: tf2.atr?.atrPercent ?? 0, atrPercentile: tf1.atrPercentile ?? 50,
            isCrypto: isCrypto,
            tfAlignment: _tfAlign, momentumAlignment: _momAlign, structureAlignment: _structAlign,
            scoreSum: tf1.biasScore + tf2.biasScore + tf3.biasScore,
            scoreDivergence: abs(tf1.biasScore - tf2.biasScore),
            dayOfWeek: Calendar.current.component(.weekday, from: Date()) - 1,
            barsSinceRegimeChange: barsSinceRegimeChange,
            regimeCode: _regimeCode,
            // Rate-of-change (from previous refresh)
            dRsiDelta: dRsiDelta, dAdxDelta: dAdxDelta,
            hRsiDelta: hRsiDelta, hAdxDelta: hAdxDelta, hMacdHistDelta: hMacdHistDelta,
            // Sentiment
            fearGreedIndex: Double(fearGreedValue ?? 50),
            fearGreedZone: FearGreedService.zone(for: fearGreedValue ?? 50),
            // Cross-asset crypto
            ethBtcRatio: ethBtcRatio, ethBtcDelta6: ethBtcDelta,
            // Volume profile (from daily indicators)
            vpDistToPocATR: {
                guard let vp = tf1.volumeProfile, let atr = tf2.atr?.atr, atr > 0 else { return 0.0 }
                return (tf1.price - vp.poc) / atr
            }(),
            vpAbovePoc: tf1.volumeProfile.map { tf1.price > $0.poc } ?? true,
            vpVAWidth: {
                guard let vp = tf1.volumeProfile, tf1.price > 0 else { return 0.0 }
                return (vp.valueAreaHigh - vp.valueAreaLow) / tf1.price * 100
            }(),
            vpInValueArea: tf1.volumeProfile.map { tf1.price >= $0.valueAreaLow && tf1.price <= $0.valueAreaHigh } ?? true,
            vpDistToVAH_ATR: {
                guard let vp = tf1.volumeProfile, let atr = tf2.atr?.atr, atr > 0 else { return 0.0 }
                return (vp.valueAreaHigh - tf1.price) / atr
            }(),
            vpDistToVAL_ATR: {
                guard let vp = tf1.volumeProfile, let atr = tf2.atr?.atr, atr > 0 else { return 0.0 }
                return (tf1.price - vp.valueAreaLow) / atr
            }(),
            // 1-bar deltas + acceleration
            hRsiDelta1: hRsiDelta1, hMacdHistDelta1: hMacdHistDelta1, dRsiDelta1: dRsiDelta1,
            hRsiAccel: hRsiAccel, hMacdAccel: hMacdAccel, dAdxAccel: dAdxAccel,
            // Time-of-day
            hourBucket: {
                let h = Calendar.current.component(.hour, from: Date())
                return h < 8 ? 0 : h < 14 ? 1 : h < 21 ? 2 : 3
            }(),
            isWeekend: {
                let wd = Calendar.current.component(.weekday, from: Date())
                return wd == 1 || wd == 7
            }(),
            // Basis
            basisPct: basisPct,
            basisExtreme: basisPct > 0.5 ? 1 : basisPct < -0.5 ? -1 : 0,
            // Stock features — computed from live data when available
            fiftyTwoWeekPct: {
                guard !isCrypto, let hi = tf1.candles.map(\.high).max(), let lo = tf1.candles.map(\.low).min(), hi != lo else { return 50.0 }
                return (tf1.price - lo) / (hi - lo) * 100
            }(),
            distToFiftyTwoHigh: {
                guard !isCrypto, let hi = tf1.candles.map(\.high).max(), hi > 0 else { return 0.0 }
                return (hi - tf1.price) / tf1.price * 100
            }(),
            gapPercent: {
                guard !isCrypto, tf1.candles.count >= 2 else { return 0.0 }
                let prev = tf1.candles[tf1.candles.count - 2].close
                guard let todayOpen = tf1.candles.last?.open else { return 0.0 }
                return prev > 0 ? (todayOpen - prev) / prev * 100 : 0
            }(),
            gapFilled: false, // would need intraday tracking
            gapDirectionAligned: 0, // would need gap + score comparison at open
            relStrengthVsSpy: 0, // would need SPY candles in live
            beta: 1.0,
            vixLevelCode: {
                let v = vixValue ?? 20
                return v < 15 ? 0 : v < 25 ? 1 : v < 35 ? 2 : 3
            }(),
            isMarketHours: !isCrypto ? MarketHours.isMarketOpen() : true
        )
    }

    // MARK: - Fetch + compute for any market

    private func fetchAndCompute(symbol: String, market: Market, crossAsset: CrossAssetContext? = nil, derivatives: DerivativesData? = nil) async throws -> (IndicatorResult, IndicatorResult, IndicatorResult) {
        let tfs = market.timeframes

        switch market {
        case .crypto:
            async let c1 = binance.fetchCandles(symbol: symbol, interval: tfs[0].interval, limit: 300)
            async let c2 = binance.fetchCandles(symbol: symbol, interval: tfs[1].interval, limit: 300)
            async let c3 = binance.fetchCandles(symbol: symbol, interval: tfs[2].interval, limit: 300)
            // Build derivatives context from live data (uses 4H candle direction)
            var derivCtx: DerivativesContext? = nil
            if let d = derivatives {
                let candles4H = try await c2
                let priceRising = candles4H.count >= 2 && (candles4H.last?.close ?? 0) > candles4H[candles4H.count - 2].close
                derivCtx = DerivativesContext.from(data: d, priceRising: priceRising)
                let r1 = IndicatorEngine.computeAll(candles: try await c1, timeframe: tfs[0].interval, label: tfs[0].label, market: market, crossAsset: crossAsset, derivatives: derivCtx)
                let r2 = IndicatorEngine.computeAll(candles: candles4H, timeframe: tfs[1].interval, label: tfs[1].label, market: market)
                let r3 = IndicatorEngine.computeAll(candles: try await c3, timeframe: tfs[2].interval, label: tfs[2].label, market: market)
                return (r1, r2, r3)
            }
            let r1 = IndicatorEngine.computeAll(candles: try await c1, timeframe: tfs[0].interval, label: tfs[0].label, market: market, crossAsset: crossAsset)
            let r2 = IndicatorEngine.computeAll(candles: try await c2, timeframe: tfs[1].interval, label: tfs[1].label, market: market)
            let r3 = IndicatorEngine.computeAll(candles: try await c3, timeframe: tfs[2].interval, label: tfs[2].label, market: market)
            return (r1, r2, r3)

        case .stock:
            // Yahoo primary (unlimited). 4H aggregated from 1H candles.
            async let c1 = yahoo.fetchCandles(symbol: symbol, interval: tfs[0].interval)
            async let c1h = yahoo.fetchCandles(symbol: symbol, interval: "1h")  // For 4H aggregation
            async let c3 = yahoo.fetchCandles(symbol: symbol, interval: tfs[2].interval)
            let daily = try await c1
            let hourly = try await c1h
            let entry = try await c3
            let fourH = CandleAggregator.aggregate1HTo4H(hourly)
            #if DEBUG
            print("[MarketScope] [\(symbol)] Yahoo candles: D=\(daily.count), 4H=\(fourH.count) (from \(hourly.count) 1H), 1H=\(entry.count)")
            #endif
            let r1 = IndicatorEngine.computeAll(candles: daily, timeframe: tfs[0].interval, label: tfs[0].label, market: market)
            let r2 = IndicatorEngine.computeAll(candles: fourH, timeframe: "4h", label: "4H (Bias)", market: market)
            let r3 = IndicatorEngine.computeAll(candles: entry, timeframe: tfs[2].interval, label: tfs[2].label, market: market)
            return (r1, r2, r3)
        }
    }

    // MARK: - Cross-Asset Context

    /// Compute cross-asset directional signals for BTC scoring (DXY + SPY).
    private func buildCrossAssetContext() async -> CrossAssetContext? {
        async let dxyCandles = yahoo.fetchCandles(symbol: "DX-Y.NYB", interval: "1d")
        async let spyCandles = yahoo.fetchCandles(symbol: "SPY", interval: "1d")

        guard let dxy = try? await dxyCandles, dxy.count >= 25,
              let spy = try? await spyCandles, spy.count >= 25 else { return nil }

        let dxyCtx = computeDirectionalSignal(candles: dxy)
        let spyCtx = computeDirectionalSignal(candles: spy)

        return CrossAssetContext(
            dxySignal: -dxyCtx.signal,  // INVERTED: DXY up = bearish for BTC
            dxyTrend: dxyCtx.trend, dxyPrice: dxyCtx.price, dxyEma20: dxyCtx.ema20,
            spySignal: spyCtx.signal,
            spyTrend: spyCtx.trend, spyPrice: spyCtx.price, spyEma20: spyCtx.ema20
        )
    }

    /// Determine if an asset is clearly trending up, down, or flat.
    private func computeDirectionalSignal(candles: [Candle]) -> (signal: Int, trend: String, price: Double, ema20: Double) {
        let closes = candles.map(\.close)
        let ema20List = MovingAverages.computeEMA(values: closes, period: 20)
        guard let price = closes.last, let ema20 = ema20List.last, price > 0 else {
            return (0, "unknown", 0, 0)
        }
        let distPct = ((price - ema20) / ema20) * 100
        let recentEMA = ema20List.suffix(5)

        if distPct > 0.5 {
            let rising = recentEMA.count >= 2 && (recentEMA.last ?? 0) > (recentEMA.first ?? 0)
            return rising ? (1, "up", price, ema20) : (0, "flat", price, ema20)
        } else if distPct < -0.5 {
            let falling = recentEMA.count >= 2 && (recentEMA.last ?? 0) < (recentEMA.first ?? 0)
            return falling ? (-1, "down", price, ema20) : (0, "flat", price, ema20)
        }
        return (0, "flat", price, ema20)
    }

    // MARK: - Shared Helpers

    /// Apply enhanced fundamentals data from Yahoo quoteSummary to a StockInfo.
    private func applyEnhancedFundamentals(_ enhanced: [String: Any], to si: inout StockInfo) {
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
        if let mc = enhanced["marketCap"] as? Double { si.marketCap = mc }
        if let pe = enhanced["peRatio"] as? Double { si.peRatio = pe }
        if let eps = enhanced["eps"] as? Double { si.eps = eps }
        if let dy = enhanced["dividendYield"] as? Double { si.dividendYield = dy }
        if let s = enhanced["sector"] as? String { si.sector = s }
        if let ind = enhanced["industry"] as? String { si.industry = ind }
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

    private nonisolated func loadCache(symbol: String) -> AnalysisResult? {
        let url = Self.cacheDir.appendingPathComponent("\(symbol).json")
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
