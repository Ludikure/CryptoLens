import Foundation

class AnalysisService: ObservableObject {
    let binance = BinanceService()
    let coinGecko = CoinGeckoService()
    var claude: ClaudeService?
    var alertsStore: AlertsStore?

    @Published var isLoading = false
    @Published var loadingStatus = ""
    @Published var lastResult: AnalysisResult?
    @Published var error: String?

    /// In-memory cache keyed by symbol
    private(set) var resultsBySymbol: [String: AnalysisResult] = [:]

    /// Public accessor for views
    var cachedResults: [String: AnalysisResult] { resultsBySymbol }

    private static var cacheDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("analyses", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    init() {
        autoConfigureKey()
    }

    func configure(apiKey: String, model: String) {
        claude = ClaudeService(apiKey: apiKey, model: model)
    }

    /// Switch to a symbol — show cached result instantly, then refresh indicators in background.
    func selectSymbol(_ symbol: String) async {
        // Show cached result immediately (memory first, then disk)
        if let cached = resultsBySymbol[symbol] {
            await MainActor.run { lastResult = cached; error = nil }
        } else if let diskCached = loadCache(symbol: symbol) {
            resultsBySymbol[symbol] = diskCached
            await MainActor.run { lastResult = diskCached; error = nil }
        } else {
            await MainActor.run { lastResult = nil; error = nil }
        }

        // Then refresh indicators in background
        await refreshIndicators(symbol: symbol)
    }

    // MARK: - Quick refresh: indicators only

    func refreshIndicators(symbol: String) async {
        await MainActor.run {
            isLoading = true
            loadingStatus = "Fetching market data..."
            error = nil
        }

        do {
            async let dailyCandles = binance.fetchCandles(symbol: symbol, interval: "1d", limit: 300)
            async let h4Candles = binance.fetchCandles(symbol: symbol, interval: "4h", limit: 300)
            async let h1Candles = binance.fetchCandles(symbol: symbol, interval: "1h", limit: 300)
            async let sentimentData = coinGecko.fetchSentiment(symbol: symbol)

            let daily = try await dailyCandles
            let h4 = try await h4Candles
            let h1 = try await h1Candles
            let sentiment = try? await sentimentData

            let dailyResult = IndicatorEngine.computeAll(candles: daily, timeframe: "1d", label: "Daily (Trend)")
            let h4Result = IndicatorEngine.computeAll(candles: h4, timeframe: "4h", label: "4H (Directional Bias)")
            let h1Result = IndicatorEngine.computeAll(candles: h1, timeframe: "1h", label: "1H (Entry)")

            // Preserve existing Claude analysis for this symbol
            let previous = resultsBySymbol[symbol]

            let result = AnalysisResult(
                symbol: symbol,
                timestamp: Date(),
                analysisTimestamp: previous?.analysisTimestamp,
                daily: dailyResult,
                h4: h4Result,
                h1: h1Result,
                sentiment: sentiment,
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

    // MARK: - Full analysis: indicators + Claude (manual pull-to-refresh)

    func runFullAnalysis(symbol: String) async {
        await MainActor.run {
            isLoading = true
            loadingStatus = "Fetching market data..."
            error = nil
        }

        do {
            async let dailyCandles = binance.fetchCandles(symbol: symbol, interval: "1d", limit: 300)
            async let h4Candles = binance.fetchCandles(symbol: symbol, interval: "4h", limit: 300)
            async let h1Candles = binance.fetchCandles(symbol: symbol, interval: "1h", limit: 300)
            async let sentimentData = coinGecko.fetchSentiment(symbol: symbol)

            let daily = try await dailyCandles
            let h4 = try await h4Candles
            let h1 = try await h1Candles
            let sentiment = try? await sentimentData

            await MainActor.run { loadingStatus = "Computing indicators..." }
            let dailyResult = IndicatorEngine.computeAll(candles: daily, timeframe: "1d", label: "Daily (Trend)")
            let h4Result = IndicatorEngine.computeAll(candles: h4, timeframe: "4h", label: "4H (Directional Bias)")
            let h1Result = IndicatorEngine.computeAll(candles: h1, timeframe: "1h", label: "1H (Entry)")

            let claudeAnalysis: String
            let tradeSetups: [TradeSetup]
            if let claude = claude {
                await MainActor.run { loadingStatus = "Analyzing with Claude..." }
                let response = try await claude.analyze(
                    indicators: [dailyResult, h4Result, h1Result],
                    sentiment: sentiment,
                    symbol: symbol
                )
                claudeAnalysis = response.markdown
                tradeSetups = response.setups
            } else {
                claudeAnalysis = "Claude API key not configured. Set it in Settings to get AI analysis."
                tradeSetups = []
            }

            let now = Date()
            let result = AnalysisResult(
                symbol: symbol,
                timestamp: now,
                analysisTimestamp: claudeAnalysis.isEmpty || claudeAnalysis.contains("not configured") ? nil : now,
                daily: dailyResult,
                h4: h4Result,
                h1: h1Result,
                sentiment: sentiment,
                claudeAnalysis: claudeAnalysis,
                tradeSetups: tradeSetups
            )

            resultsBySymbol[symbol] = result

            await MainActor.run {
                lastResult = result
                isLoading = false
                loadingStatus = ""

                // Auto-create alerts from trade setups
                if !tradeSetups.isEmpty, let store = alertsStore {
                    let price = result.daily.price
                    let newAlerts = tradeSetups.flatMap { $0.toAlerts(symbol: symbol, currentPrice: price) }
                    for alert in newAlerts {
                        // Don't duplicate — check if similar alert exists
                        let isDuplicate = store.alerts.contains { existing in
                            existing.symbol == alert.symbol
                            && abs(existing.targetPrice - alert.targetPrice) < 0.01
                            && existing.condition == alert.condition
                            && !existing.triggered
                        }
                        if !isDuplicate {
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

    // MARK: - Per-symbol cache

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
                print("[CryptoLens] Cache save failed: \(error)")
            }
        }
    }

    private func loadCache(symbol: String) -> AnalysisResult? {
        let url = cacheURL(for: symbol)
        do {
            let data = try Data(contentsOf: url)
            let result = try JSONDecoder().decode(AnalysisResult.self, from: data)
            // Only use cache if less than 1 hour old
            if Date().timeIntervalSince(result.timestamp) < 3600 {
                return result
            }
        } catch {
            // No cache — fine
        }
        return nil
    }

    private func autoConfigureKey() {
        if let buildKey = Bundle.main.infoDictionary?["ClaudeAPIKey"] as? String,
           !buildKey.isEmpty, buildKey != "your-key-here", !buildKey.contains("CLAUDE_API_KEY") {
            KeychainHelper.save(key: "claude_api_key", value: buildKey)
            claude = ClaudeService(apiKey: buildKey)
            return
        }
        if let saved = KeychainHelper.load(key: "claude_api_key"), !saved.isEmpty {
            claude = ClaudeService(apiKey: saved)
            return
        }
    }
}
