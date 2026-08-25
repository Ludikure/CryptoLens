import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// America/New_York calendar for time features (dayOfWeek, hourBucket, isWeekend).
/// Was Calendar.current which produced device-local values — devices outside ET
/// would emit feature values that didn't match the worker's ET-pinned cron, the
/// training pipeline's canonical, or each other. Pinning to ET removes the drift.
private let etCalendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "America/New_York")!
    return c
}()

@MainActor
class AnalysisService: ObservableObject {
    let yahoo = YahooFinanceService()
    let finnhub = FinnhubProvider()
    let economicCalendar = EconomicCalendarService()
    let macroData = MacroDataService()

    // Default provider for fresh installs. Existing users keep their UserDefaults("ai_provider")
    // selection (autoConfigureKey reads it on init). DeepSeek R1's reasoning is well-suited to
    // our rule-based prompt at ~5x lower cost than Sonnet 4.6 + extended thinking.
    @Published var providerType: AIProviderType = .deepseek


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

    /// Application Support, not Caches — see `PersistentStore`. iOS evicts Caches under storage
    /// pressure, which silently deleted analyses the user had already paid an LLM call for.
    private nonisolated static var cacheDir: URL {
        PersistentStore.directory(named: "analyses")
    }

    /// Weak hook so the AppDelegate (which doesn't hold the @StateObject) can reach the live
    /// instance for push-tap analysis recovery. Set on init; the single app-lifetime instance.
    static weak var shared: AnalysisService?
    init() { autoConfigureKey(); AnalysisService.shared = self }

    /// The selected model id (may carry an `@thinking-N` suffix for Claude). Read by
    /// `WorkerFullAnalysisService` so the server-side analysis uses the user's chosen provider+model.
    private(set) var currentModelID: String = ""

    func configure(provider: AIProviderType, apiKey: String, model: String) {
        providerType = provider
        currentModelID = model
        // Persist so the choice survives relaunch (the worker /full-analysis path reads these).
        UserDefaults.standard.set(provider.rawValue, forKey: "ai_provider")
        UserDefaults.standard.set(model, forKey: "ai_model")
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

    /// Resume any outstanding fire-and-forget analysis jobs (called on app foreground / push tap).
    /// The box finished the analysis while the app was away, so runFullAnalysis → analyze() resumes
    /// the cached job with no second LLM spend. Switches to the recovered symbol so the result is
    /// actually shown when it differs from what the user is currently viewing.
    func recoverPendingAnalyses() {
        guard !isLoading, aiLoadingPhase == .idle else { return }
        let pending = WorkerFullAnalysisService.pendingJobSymbols()
        guard let symbol = pending.first(where: { $0 == currentSymbol }) ?? pending.first else { return }
        if symbol != currentSymbol { switchToSymbol(symbol) }
        Task { await runFullAnalysis(symbol: symbol) }
    }

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
            // Spot pressure is populated server-side via the worker /market bundle in
            // refreshIndicators; clear here so a stale value doesn't leak across symbols.
            self.spotPressure = nil
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
            // Publish the favorites snapshot for the home-screen widget. This is the only writer of
            // the App Group container the widget reads — before it existed the widget was
            // permanently blank. Placed after both passes so it ships real prices, and it no-ops
            // when the payload is unchanged (WidgetKit rations timeline reloads).
            WidgetDataWriter.write(favorites: symbols, results: resultsBySymbol)
        }
    }

    /// Lightweight fetch — only daily candles + indicators for watchlist card.
    func quickFetch(symbol: String, force: Bool = false) async {
        guard force || resultsBySymbol[symbol] == nil else { return }
        guard !NetworkMonitor.shared.isOffline else { return }

        let market = marketFor(symbol)
        do {
            let tf1 = try await WorkerIndicatorsService.fetch(symbol: symbol).daily

            // Salvage the last analysis from disk even when it's older than loadCache's 1h data
            // guard — otherwise this placeholder wipes it from memory and refreshIndicators then
            // carries the wipe forward forever. The analysis keeps its own timestamp, so the
            // staleness banner still tells the truth about its age.
            let salvage = loadCacheAnyAge(symbol: symbol)
            let result = AnalysisResult(
                symbol: symbol, market: market, timestamp: Date(),
                analysisTimestamp: salvage?.analysisTimestamp,
                tf1: tf1, tf2: tf1, tf3: tf1,  // Same data for all 3 — placeholder until full refresh
                claudeAnalysis: salvage?.claudeAnalysis ?? "", tradeSetups: salvage?.tradeSetups ?? []
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
        // Only clear a displayed error for the symbol the user is actually viewing — this runs
        // for every symbol in the background refresh cycle, so an unguarded reset would erase a
        // just-shown error banner while its underlying condition still holds.
        if symbol == currentSymbol { error = nil }

        do {
            let (tf1, tf2, tf3, _) = try await fetchAndCompute(symbol: symbol, market: market)
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

            // Route the geoblocked crypto enrichment (derivatives/positioning/spot/sentiment/
            // fear&greed) through ONE worker /market call. Binance fapi is HTTP 451 from the phone.
            // One /market call now serves BOTH markets on an enrichment cycle (2026-07-25). Crypto
            // takes derivatives/positioning/spot/sentiment from it; stocks take the Finnhub-derived
            // fields that used to cost five separate /finnhub/* requests. Yahoo fundamentals still
            // come from the on-device path — Yahoo isn't geoblocked and isn't worker-gated, so
            // routing it through the box would add a request rather than remove one.
            let marketBundle: WorkerMarketService.Bundle? =
                needsEnrichment ? await WorkerMarketService.fetch(symbol: symbol) : nil
            if let sp = marketBundle?.spotPressure { self.spotPressure = sp }

            // Sentiment — only on enrichment cycles
            let sentiment: CoinInfo?
            let fearGreed: FearGreedIndex?
            if market == .crypto {
                sentiment = marketBundle?.sentiment ?? previous?.sentiment
                fearGreed = marketBundle?.fearGreed ?? previous?.fearGreed
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

            // Stock enrichment — one worker call, not five (2026-07-25).
            //
            // This block used to fire FIVE concurrent /finnhub/* requests per refresh
            // (recommendation/metric/earnings/news/insider). Each counted against the worker's
            // per-device budget, so a stock refresh cost ~7 worker requests against crypto's 3 and
            // touching a handful of stocks in a minute produced 429s on the stock path only. Worse,
            // the gate runs before endpoint routing, so those calls burned budget even when the
            // worker answered them from its own 1-24h cache.
            //
            // The box already assembles all of it server-side in `fetchStockEnrichment`, so we take
            // it from the same /market bundle crypto uses. Every field is merged conservatively —
            // nil keeps whatever the Yahoo path or the previous cycle already provided, so a partial
            // response can never blank out good data.
            if var si = stockInfo, market == .stock, needsEnrichment {
                if let f = marketBundle?.stockFinnhub {
                    if let v = f.finnhubBuy { si.finnhubBuy = v }
                    if let v = f.finnhubHold { si.finnhubHold = v }
                    if let v = f.finnhubSell { si.finnhubSell = v }
                    if let v = f.finnhubStrongBuy { si.finnhubStrongBuy = v }
                    let total = (f.finnhubBuy ?? 0) + (f.finnhubHold ?? 0) + (f.finnhubSell ?? 0)
                    if total > 0 { si.analystCount = total }
                    if si.marketCap == nil, let v = f.marketCap { si.marketCap = v }
                    if let v = f.beta { si.beta = v }
                    if si.earningsDate == nil, let v = f.earningsDate { si.earningsDate = v }
                    if let v = f.newsHeadlines, !v.isEmpty { si.newsHeadlines = v }
                    if let tx = f.insiderTransactions, !tx.isEmpty {
                        si.insiderTransactions = Array(tx.prefix(10))
                        si.insiderBuyCount6m = f.insiderBuyCount6m
                        si.insiderSellCount6m = f.insiderSellCount6m
                        si.insiderNetBuying = f.insiderNetBuying
                    }
                }
                stockInfo = si
            }

            // Crypto derivatives — only on enrichment cycles. Geoblocked (Binance fapi → 451 from
            // the phone). In thin mode these come from the worker /market bundle above (one call,
            // box fetches Binance behind NordVPN); carry forward on non-enrichment cycles.
            var derivData: DerivativesData? = nil
            var positioning: PositioningSnapshot? = nil
            if market == .crypto {
                derivData = marketBundle?.derivatives ?? previous?.derivatives
                positioning = marketBundle?.positioning ?? previous?.positioning
            }

            let events = await economicCalendar.highImpactRelevant()
            _ = await macroData.fetchMacroSnapshot()

            if needsEnrichment { lastEnrichmentFetch[symbol] = Date() }

            // ML win probability — worker is the single source of truth (same prediction
            // drives notifications). nil on cache miss / network failure; UI handles.
            var tf1ML = tf1
            let workerML = await fetchWorkerML(symbol: symbol)
            tf1ML.mlWinProbability = workerML?.probability
            tf1ML.mlPersistenceProbability = workerML?.probabilityH72
            tf1ML.mlBigMoveBucket = workerML?.bigMove?.bucket
            tf1ML.mlBigMoveMultiple = workerML?.bigMove?.multiple
            tf1ML.mlMetaProbability = workerML?.probabilityMeta
            tf1ML.mlQ75 = workerML?.q75
            tf1ML.mlConfident = workerML?.confident
            tf1ML.mlMetaDirection = workerML?.metaDirection
            tf1ML.mlDirectionUp = workerML?.pUp

            var prevResult = resultsBySymbol[symbol]
            // Memory can hold an analysis-less placeholder (quickFetch after a cold start) while a
            // real analysis sits on disk past the 1h data guard. Prefer whichever source actually
            // HAS an analysis — the newest one wins by analysisTimestamp.
            if prevResult?.claudeAnalysis.isEmpty ?? true, let salvaged = loadCacheAnyAge(symbol: symbol),
               !salvaged.claudeAnalysis.isEmpty {
                prevResult = salvaged
            }
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
            // Outcome resolution is SERVER-SIDE since the 2026-07-09 thin-client cutover —
            // the box's cron advances every open setup per minute (15m crypto candles / 1h
            // stock candles), no phone involvement. Just pull the fresh snapshot for display.
            Task { await OutcomeTracker.refresh() }
            saveCache(result)

            // Widget shared data disabled until App Group is provisioned

            // Bias flip notification
            if let prev = prevResult,
               prev.daily.bias != result.daily.bias,
               UserDefaults.standard.bool(forKey: "notify_bias_flips") {
                let ticker = Constants.asset(for: symbol)?.ticker ?? symbol
                BiasNotificationManager.send(ticker: ticker, oldBias: prev.daily.bias, newBias: result.daily.bias)
            }

            // ML-threshold local notification REMOVED (2026-07-14): it fired at ML >= 0.60 with a
            // "Daily score: +N. Tap to analyze setup" alert that guaranteed no setup — analyzing at
            // ML 60-69 sits below the 70 conviction gate and usually auto-FLATs, so it trained the
            // user to chase notifications that led nowhere. The server-side auto-analysis push now
            // fires ONLY when the enriched analysis actually produces a setup, which supersedes this.

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

    // MARK: - Keep-alive during analysis
    //
    // The server LLM call (Claude + extended thinking) takes ~30-90s. If the screen auto-locks
    // mid-analysis the app is backgrounded and iOS suspends the in-flight URLSession task within
    // seconds, so the analysis fails ("Analysis failed…") long before the 120s timeout. Disabling
    // the idle timer keeps the screen on (and the app foregrounded) for the duration of a
    // user-initiated analysis; the background-task assertion buys ~30s of grace if the user
    // manually locks or switches apps. Ref-counted so concurrent runs don't clear it early.
    #if canImport(UIKit)
    private var keepAliveCount = 0
    private var analysisBGTask: UIBackgroundTaskIdentifier = .invalid

    private func beginAnalysisKeepAlive() {
        keepAliveCount += 1
        UIApplication.shared.isIdleTimerDisabled = true
        if analysisBGTask == .invalid {
            analysisBGTask = UIApplication.shared.beginBackgroundTask(withName: "MarketScopeAnalysis") { [weak self] in
                // Expiration handler — documented to run on the main thread. Must end the task
                // promptly or the OS terminates the app.
                MainActor.assumeIsolated { self?.endBackgroundTaskIfNeeded() }
            }
        }
    }

    private func endAnalysisKeepAlive() {
        keepAliveCount = max(0, keepAliveCount - 1)
        guard keepAliveCount == 0 else { return }
        UIApplication.shared.isIdleTimerDisabled = false
        endBackgroundTaskIfNeeded()
    }

    private func endBackgroundTaskIfNeeded() {
        guard analysisBGTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(analysisBGTask)
        analysisBGTask = .invalid
    }
    #else
    private func beginAnalysisKeepAlive() {}
    private func endAnalysisKeepAlive() {}
    #endif

    // MARK: - Full analysis: indicators + AI

    func runFullAnalysis(symbol: String) async {
        // Reentrancy guard: the scenePhase recovery Task and a user tap can both be enqueued on
        // the MainActor before either runs; without this, two runs start two LLM jobs (double
        // spend) and register duplicate setups (parseSetups mints fresh UUIDs per decode, so the
        // registerSetup id-dedupe can't catch it). aiLoadingPhase is set synchronously below,
        // before the first await, so the second enqueued task reliably sees it and bails.
        guard aiLoadingPhase == .idle else { return }

        if NetworkMonitor.shared.isOffline {
            error = "No internet connection. Connect to a network and try again."
            aiLoadingPhase = .idle
            return
        }

        // Keep the screen awake (no auto-lock) + hold a background-task assertion for the whole
        // run so a dimming screen can't suspend the server analysis mid-flight. See above.
        beginAnalysisKeepAlive()
        defer { endAnalysisKeepAlive() }

        let market = marketFor(symbol)
        isLoading = true
        loadingStatus = "Fetching market data..."
        aiLoadingPhase = .preparingPrompt
        error = nil

        do {
            var dataQuality = DataQuality()

            // Indicators come from the Worker (/indicators). Cross-asset + derivatives that used to
            // feed the on-device prompt are now supplied server-side inside /full-analysis.
            var (tf1, tf2, tf3, _) = try await fetchAndCompute(symbol: symbol, market: market)

            // ML win probability for the AI prompt — worker is the single source of truth.
            let workerML2 = await fetchWorkerML(symbol: symbol)
            tf1.mlWinProbability = workerML2?.probability
            tf1.mlPersistenceProbability = workerML2?.probabilityH72
            tf1.mlBigMoveBucket = workerML2?.bigMove?.bucket
            tf1.mlBigMoveMultiple = workerML2?.bigMove?.multiple
            tf1.mlMetaProbability = workerML2?.probabilityMeta
            tf1.mlQ75 = workerML2?.q75
            tf1.mlConfident = workerML2?.confident
            tf1.mlMetaDirection = workerML2?.metaDirection
            tf1.mlDirectionUp = workerML2?.pUp

            // Candle staleness check: how old is the latest candle?
            if let latestCandle = tf3.candles.last {
                dataQuality.candleStaleness = Date().timeIntervalSince(latestCandle.time)
            }

            // One worker /market call serves both markets: the geoblocked crypto enrichment bundle
            // (derivatives/positioning/spot/sentiment/fear&greed) and the stock Finnhub fields that
            // used to be five separate requests — see refreshIndicators.
            let marketBundle: WorkerMarketService.Bundle? = await WorkerMarketService.fetch(symbol: symbol)

            let sentiment: CoinInfo?
            if market == .crypto {
                sentiment = marketBundle?.sentiment
                if sentiment == nil { dataQuality.sentimentOK = false }
            } else { sentiment = nil }

            let fearGreed = market == .crypto ? marketBundle?.fearGreed : nil

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

            // Stock enrichment for full analysis — same single-call swap as refreshIndicators
            // (2026-07-25). This was the SECOND /finnhub/* fan-out: five more worker requests, fired
            // on the analysis path, on top of the five the refresh had just spent. Between them a
            // "tap a stock, analyse it" sequence cost ~12 worker requests against the per-device
            // budget where crypto cost 3.
            if var si = stockInfo, market == .stock {
                if let f = marketBundle?.stockFinnhub {
                    if let v = f.finnhubBuy { si.finnhubBuy = v }
                    if let v = f.finnhubHold { si.finnhubHold = v }
                    if let v = f.finnhubSell { si.finnhubSell = v }
                    if let v = f.finnhubStrongBuy { si.finnhubStrongBuy = v }
                    let total = (f.finnhubBuy ?? 0) + (f.finnhubHold ?? 0) + (f.finnhubSell ?? 0)
                    if total > 0 { si.analystCount = total }
                    if si.marketCap == nil, let v = f.marketCap { si.marketCap = v }
                    if let v = f.beta { si.beta = v }
                    if si.earningsDate == nil, let v = f.earningsDate { si.earningsDate = v }
                    if let v = f.newsHeadlines, !v.isEmpty { si.newsHeadlines = v }
                    if let tx = f.insiderTransactions, !tx.isEmpty {
                        si.insiderTransactions = Array(tx.prefix(10))
                        si.insiderBuyCount6m = f.insiderBuyCount6m
                        si.insiderSellCount6m = f.insiderSellCount6m
                        si.insiderNetBuying = f.insiderNetBuying
                    }
                }
                stockInfo = si
            }

            // Crypto derivatives from the worker /market bundle (Binance fapi is 451 from the
            // phone), falling back to cached.
            var derivData: DerivativesData? = marketBundle?.derivatives
            var positioning: PositioningSnapshot? = marketBundle?.positioning
            if market == .crypto {
                if derivData == nil, let cached = resultsBySymbol[symbol] {
                    derivData = cached.derivatives
                    positioning = positioning ?? cached.positioning
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

            // Spot pressure for crypto from the worker /market bundle (Binance spot is 451 from
            // the phone).
            var spotPressure: SpotPressure? = nil
            if market == .crypto {
                spotPressure = marketBundle?.spotPressure
                if spotPressure == nil { dataQuality.spotPressureOK = false }
            }

            // Log data quality
            #if DEBUG
            if let summary = dataQuality.uiSummary {
                print("[MarketScope] [\(symbol)] Data quality: \(summary)")
            }
            #endif

            // Fetch resolved outcome history for this symbol. The model_version filter
            // here used to be hardcoded to 10, which silently excluded stocks (v12) from
            // their own outcome feedback. Now we filter by current model version per
            // asset class so each market sees its own track record.
            var outcomeHistory: [(direction: String, entry: Double, outcome: String, mlProb: Double?, conviction: String?)] = []
            let mv = OutcomeTracker.currentModelVersion(for: symbol)
            if let outUrl = URL(string: "\(PushService.workerURL)/outcomes?symbol=\(symbol)&model_version=\(mv)&resolved=true") {
                var outReq = URLRequest(url: outUrl)
                outReq.timeoutInterval = 5
                PushService.addAuthHeaders(&outReq)
                if let (outData, outResp) = try? await URLSession.shared.data(for: outReq),
                   (outResp as? HTTPURLResponse)?.statusCode == 200,
                   let results = try? JSONSerialization.jsonObject(with: outData) as? [[String: Any]] {
                    outcomeHistory = results.compactMap { r in
                        guard let dir = r["direction"] as? String,
                              let entry = r["entry_price"] as? Double,
                              let outcome = r["outcome"] as? String else { return nil }
                        return (dir, entry, outcome, r["ml_probability"] as? Double, r["conviction"] as? String)
                    }
                    if outcomeHistory.count > 10 { outcomeHistory = Array(outcomeHistory.prefix(10)) }
                }
            }

            // (The A/B promptVersion stamp moved server-side with setup registration —
            // the worker stamps TRACKED_PROMPT_VERSION on every tracked setup.)
            let claudeAnalysis: String
            let tradeSetups: [TradeSetup]
            // iOS runs entirely on the shared-brain Worker (Phase 4 complete): the prompt is built
            // and the LLM (Sonnet + extended thinking) runs server-side via /full-analysis. The
            // indicators (tf1/tf2/tf3) are still computed locally above for the chart/table +
            // outcome tracking; only the prompt-building + LLM call live on the Worker now. No
            // on-device fallback — the cron dead-man's-switch (/cron-health) covers worker uptime.
            aiLoadingPhase = .waitingForResponse
            loadingStatus = "Analyzing (server · \(providerType.displayName))…"
            do {
                // Foreground URLSession. The screen stays awake for the whole run (idle timer
                // disabled in beginAnalysisKeepAlive) + a beginBackgroundTask assertion gives
                // grace time if the app briefly backgrounds — together these keep the request
                // alive without the unreliable background-URLSession path (which returned HTTP 0
                // because upload-task responses aren't delivered reliably on a background session).
                let r = try await WorkerFullAnalysisService.analyze(symbol: symbol, provider: providerType.rawValue, modelID: currentModelID)
                aiLoadingPhase = .parsingResponse
                claudeAnalysis = r.markdown
                tradeSetups = r.setups
            } catch {
                // A failed analysis is an ERROR, not an analysis. Pre-2026-07-01 the failure text
                // was stored as a real result — saved to history/disk cache, stamped with an
                // analysisTimestamp, registered as a FLAT outcome (polluting the false-conservatism
                // stats with network failures), and (with auto-alerts on) it wiped the previous
                // setup's alerts and re-added nothing. Now: surface the error and bail.
                if symbol == currentSymbol {
                    self.error = "Analysis failed: \(error.localizedDescription)"
                }
                isLoading = false
                loadingStatus = ""
                aiLoadingPhase = .idle
                HapticManager.notification(.error)
                return
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
            // Loading state resets UNCONDITIONALLY — pre-2026-07-01 these were gated on
            // symbol == currentSymbol, so switching favorites mid-analysis left aiLoadingPhase
            // stuck non-idle forever, disabling the AI run buttons + toolbar until relaunch.
            isLoading = false
            loadingStatus = ""
            aiLoadingPhase = .idle
            // Only mutate DISPLAYED result state if the user is still viewing this symbol —
            // otherwise lastResult flips to the wrong asset when a slow AI analysis
            // completes after the user has already swiped to another favorite.
            if symbol == currentSymbol {
                lastResult = result
                isAIStale = false
                HapticManager.notification(.success)
            }
            AnalysisHistoryStore.save(result)

            // Setup/FLAT registration is SERVER-SIDE since the 2026-07-09 cutover:
            // /full-analysis registers this run's setups (or its FLAT decision) in
            // tracked_setups at parse time, and the cron resolves them. Pull the snapshot
            // so the new rows show up in Active Trades / the dashboard immediately.
            Task { await OutcomeTracker.refresh() }

            saveCache(result)

        } catch {
            // Reset loading state unconditionally, but only DISPLAY the error if the user is
            // still on this symbol — a stale (switched-away) run's failure shouldn't banner
            // over whatever they're viewing now.
            if symbol == currentSymbol {
                self.error = error.localizedDescription
            }
            self.isLoading = false
            self.loadingStatus = ""
            self.aiLoadingPhase = .idle
            HapticManager.notification(.error)
        }
    }

    // MARK: - Fetch + compute for any market

    private func fetchAndCompute(symbol: String, market: Market) async throws -> (IndicatorResult, IndicatorResult, IndicatorResult, [Candle]) {
        // Pure thin client: all candle-fetch + indicator computation happens on the Worker. One
        // `/indicators` call returns daily/4H/1H already computed. The 4th tuple element is the
        // worker's daily candles (kept for the call-site signature). The worker is the single
        // source of truth; the cron dead-man's-switch (`/cron-health`) covers worker uptime.
        #if DEBUG
        print("[MarketScope] [\(symbol)] thin client → /indicators (worker compute)")
        #endif
        let b = try await WorkerIndicatorsService.fetch(symbol: symbol)
        let daily = b.daily
        return (daily, b.fourH ?? daily, b.oneH ?? daily, daily.candles)
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
            // ET-pinned (etCalendar) for consistency with the other time computations — a
            // device-local calendar could shift the day-count by one across a TZ boundary.
            let days = etCalendar.dateComponents([.day], from: Date(), to: exDate).day ?? 999
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

    /// The disk cache with NO freshness guard — for salvaging the ANALYSIS, not the indicators.
    ///
    /// The 1h guard in `loadCache` is right for market data (hour-old candles must not render as
    /// current) but it was discarding the LLM analysis along with them: return to a symbol after
    /// >1h and `loadCache` returned nil, `quickFetch` stored a placeholder with an empty
    /// `claudeAnalysis`, and every later refresh faithfully carried that emptiness forward. The
    /// user-visible symptom: "the latest analysis disappears after some time." An analysis is not
    /// market data — it stays valid-to-display (with its timestamp and the staleness flag) until a
    /// NEWER one replaces it.
    private nonisolated func loadCacheAnyAge(symbol: String) -> AnalysisResult? {
        let url = Self.cacheDir.appendingPathComponent("\(symbol).json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(AnalysisResult.self, from: data)
    }

    private func autoConfigureKey() {
        // All AI calls go through the worker proxy — no local API keys needed.
        // Configure with empty key; ClaudeService uses the worker, not direct API.
        if let savedProvider = UserDefaults.standard.string(forKey: "ai_provider"),
           let type = AIProviderType(rawValue: savedProvider) {
            providerType = type
        }
        let type = providerType
        // Restore the saved model if it's still a valid id for this provider; else default to the
        // provider's first (recommended) model.
        let saved = UserDefaults.standard.string(forKey: "ai_model")
        let model = (saved != nil && type.models.contains { $0.id == saved }) ? saved! : type.models[0].id
        configure(provider: type, apiKey: "", model: model)
    }

    /// Fetches the worker's cron-cached prediction. Returns nil on cache miss or network
    /// failure — the UI then shows "—" for ML, matching what would happen if the cron
    /// hadn't run yet anyway. There is no on-device fallback: the worker is the single
    /// source of truth for displayed ML, so it always matches notifications.
    private func fetchWorkerML(symbol: String) async -> WorkerMLService.Prediction? {
        do {
            return try await WorkerMLService.predict(symbol: symbol)
        } catch {
            return nil
        }
    }
}
