import Foundation

enum YahooError: LocalizedError {
    case invalidSymbol
    case networkError(String)
    case decodingError(String)
    case noData

    var errorDescription: String? {
        switch self {
        case .invalidSymbol: return "Symbol not found on Yahoo Finance."
        case .networkError(let msg): return "Network error: \(msg)"
        case .decodingError(let msg): return "Data error: \(msg)"
        case .noData: return "No market data available."
        }
    }
}

class YahooFinanceService {
    private let session: URLSession
    private var lastRequestTime: Date?

    private func throttle(minInterval: TimeInterval = 1.0) async {
        if let last = lastRequestTime {
            let elapsed = Date().timeIntervalSince(last)
            if elapsed < minInterval {
                try? await Task.sleep(nanoseconds: UInt64((minInterval - elapsed) * 1_000_000_000))
            }
        }
        lastRequestTime = Date()
    }

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.httpTimeout
        self.session = URLSession(configuration: config)
    }

    /// Fetch OHLCV candles from Yahoo Finance.
    func fetchCandles(symbol: String, interval: String, range: String? = nil) async throws -> [Candle] {
        await throttle()
        guard var components = URLComponents(string: "\(Constants.yahooBaseURL)/v8/finance/chart/\(symbol)") else {
            throw YahooError.networkError("Invalid URL for \(symbol)")
        }

        // Default ranges per interval
        let effectiveRange = range ?? defaultRange(for: interval)
        components.queryItems = [
            URLQueryItem(name: "interval", value: interval),
            URLQueryItem(name: "range", value: effectiveRange),
        ]
        guard let url = components.url else {
            throw YahooError.networkError("Invalid URL for \(symbol)")
        }

        let (data, response) = try await session.data(from: url)

        if let httpResponse = response as? HTTPURLResponse {
            if httpResponse.statusCode == 404 { throw YahooError.invalidSymbol }
            guard (200...299).contains(httpResponse.statusCode) else {
                throw YahooError.networkError("HTTP \(httpResponse.statusCode)")
            }
        }

        return try parseChartResponse(data)
    }

    /// Fetch stock quote with fundamentals.
    func fetchQuote(symbol: String) async throws -> StockInfo {
        await throttle()
        guard var components = URLComponents(string: "\(Constants.yahooBaseURL)/v8/finance/chart/\(symbol)") else {
            throw YahooError.networkError("Invalid URL for \(symbol)")
        }
        components.queryItems = [
            URLQueryItem(name: "interval", value: "1d"),
            URLQueryItem(name: "range", value: "5d"),
        ]
        guard let url = components.url else {
            throw YahooError.networkError("Invalid URL for \(symbol)")
        }

        let (data, response) = try await session.data(from: url)
        if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
            throw YahooError.networkError("HTTP \(httpResponse.statusCode)")
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let chart = json["chart"] as? [String: Any],
              let results = chart["result"] as? [[String: Any]],
              let result = results.first,
              let meta = result["meta"] as? [String: Any]
        else { throw YahooError.decodingError("Invalid chart response") }

        let regularPrice = (meta["regularMarketPrice"] as? NSNumber)?.doubleValue ?? 0
        let previousClose = (meta["chartPreviousClose"] as? NSNumber)?.doubleValue ?? regularPrice
        let changePercent = previousClose != 0 ? ((regularPrice - previousClose) / previousClose) * 100 : 0

        return StockInfo(
            marketCap: nil,
            peRatio: nil,
            eps: nil,
            dividendYield: nil,
            fiftyTwoWeekHigh: (meta["fiftyTwoWeekHigh"] as? NSNumber)?.doubleValue ?? 0,
            fiftyTwoWeekLow: (meta["fiftyTwoWeekLow"] as? NSNumber)?.doubleValue ?? 0,
            earningsDate: nil,
            sector: nil,
            industry: nil,
            marketState: (meta["marketState"] as? String) ?? "CLOSED",
            priceChangePercent1d: changePercent
        )
    }

    /// Validate whether a ticker symbol exists on Yahoo Finance.
    func validateTicker(_ symbol: String) async -> (name: String, valid: Bool) {
        do {
            let candles = try await fetchCandles(symbol: symbol.uppercased(), interval: "1d", range: "5d")
            return (symbol.uppercased(), !candles.isEmpty)
        } catch {
            return (symbol.uppercased(), false)
        }
    }

    /// Fetch the next earnings date for a stock symbol.
    func fetchEarningsDate(symbol: String) async -> Date? {
        await throttle()
        guard let url = URL(string: "\(Constants.yahooBaseURL)/v10/finance/quoteSummary/\(symbol)?modules=calendarEvents") else { return nil }
        do {
            let (data, _) = try await session.data(from: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let summary = json["quoteSummary"] as? [String: Any],
                  let results = summary["result"] as? [[String: Any]],
                  let first = results.first,
                  let calendar = first["calendarEvents"] as? [String: Any],
                  let earnings = calendar["earnings"] as? [String: Any],
                  let dates = earnings["earningsDate"] as? [[String: Any]],
                  let raw = dates.first?["raw"] as? Int
            else { return nil }
            return Date(timeIntervalSince1970: Double(raw))
        } catch { return nil }
    }

    /// Fetch stock sentiment data (short interest, VIX, 52-week position).
    func fetchStockSentiment(symbol: String) async -> StockSentimentData? {
        await throttle()
        // Fetch quote summary for short interest, VIX, and put/call
        async let summaryData = fetchQuoteSummary(symbol: symbol)
        async let vixCandles = fetchVIX()
        async let pcRatio = fetchPutCallRatio(symbol: symbol)

        let summary = await summaryData
        let vix = await vixCandles
        let putCall = await pcRatio

        let shortPctOfFloat = summary?["shortPercentOfFloat"] as? Double
        let shortRatio = summary?["shortRatio"] as? Double
        let high52 = summary?["fiftyTwoWeekHigh"] as? Double ?? 0
        let low52 = summary?["fiftyTwoWeekLow"] as? Double ?? 0
        let price = summary?["regularMarketPrice"] as? Double ?? 0

        let position52w: Double = (high52 > low52 && high52 > 0) ? ((price - low52) / (high52 - low52)) * 100 : 50

        let vixValue = vix?.close
        let vixPrev = vix?.open
        let vixChange = (vixValue != nil && vixPrev != nil && vixPrev! > 0) ? ((vixValue! - vixPrev!) / vixPrev!) * 100 : nil

        return StockSentimentData(
            shortPercentOfFloat: shortPctOfFloat.map { $0 * 100 }, // Convert to percentage
            shortRatio: shortRatio,
            vix: vixValue,
            vixChange: vixChange,
            vixLevel: StockSentimentData.vixClassification(vixValue ?? 20),
            fiftyTwoWeekPosition: position52w,
            putCallRatio: putCall
        )
    }

    private func fetchQuoteSummary(symbol: String) async -> [String: Any]? {
        let modules = "defaultKeyStatistics,price"
        guard let url = URL(string: "\(Constants.yahooBaseURL)/v10/finance/quoteSummary/\(symbol)?modules=\(modules)") else { return nil }
        do {
            let (data, _) = try await session.data(from: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let qs = json["quoteSummary"] as? [String: Any],
                  let results = qs["result"] as? [[String: Any]],
                  let first = results.first else { return nil }

            var out = [String: Any]()

            // defaultKeyStatistics: shortPercentOfFloat, shortRatio
            if let stats = first["defaultKeyStatistics"] as? [String: Any] {
                if let spf = stats["shortPercentOfFloat"] as? [String: Any] { out["shortPercentOfFloat"] = spf["raw"] as? Double }
                if let sr = stats["shortRatio"] as? [String: Any] { out["shortRatio"] = sr["raw"] as? Double }
            }

            // price: regularMarketPrice, fiftyTwoWeekHigh/Low
            if let price = first["price"] as? [String: Any] {
                if let rmp = price["regularMarketPrice"] as? [String: Any] { out["regularMarketPrice"] = rmp["raw"] as? Double }
                if let h = price["fiftyTwoWeekHigh"] as? [String: Any] { out["fiftyTwoWeekHigh"] = h["raw"] as? Double }
                if let l = price["fiftyTwoWeekLow"] as? [String: Any] { out["fiftyTwoWeekLow"] = l["raw"] as? Double }
            }

            return out
        } catch { return nil }
    }

    /// Compute put/call ratio from nearest-expiry options chain open interest.
    private func fetchPutCallRatio(symbol: String) async -> Double? {
        await throttle()
        guard let url = URL(string: "\(Constants.yahooBaseURL)/v7/finance/options/\(symbol)") else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) { return nil }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let chain = json["optionChain"] as? [String: Any],
                  let results = chain["result"] as? [[String: Any]],
                  let first = results.first,
                  let options = first["options"] as? [[String: Any]],
                  let nearest = options.first,
                  let puts = nearest["puts"] as? [[String: Any]],
                  let calls = nearest["calls"] as? [[String: Any]]
            else { return nil }

            let putOI = puts.reduce(0) { $0 + (($1["openInterest"] as? Int) ?? 0) }
            let callOI = calls.reduce(0) { $0 + (($1["openInterest"] as? Int) ?? 0) }
            guard callOI > 0 else { return nil }
            let ratio = Double(putOI) / Double(callOI)
            #if DEBUG
            print("[MarketScope] [\(symbol)] Put/Call: putOI=\(putOI), callOI=\(callOI), ratio=\(String(format: "%.2f", ratio))")
            #endif
            return ratio.rounded(toPlaces: 2)
        } catch { return nil }
    }

    private func fetchVIX() async -> Candle? {
        do {
            let candles = try await fetchCandles(symbol: "%5EVIX", interval: "1d", range: "5d")
            return candles.last
        } catch { return nil }
    }

    // MARK: - Enhanced Fundamentals

    private static let sectorETFs: [String: String] = [
        "Technology": "XLK", "Healthcare": "XLV", "Financial Services": "XLF",
        "Consumer Cyclical": "XLY", "Consumer Defensive": "XLP", "Energy": "XLE",
        "Industrials": "XLI", "Basic Materials": "XLB", "Utilities": "XLU",
        "Real Estate": "XLRE", "Communication Services": "XLC",
    ]

    /// Fetch enhanced fundamentals from quoteSummary (analyst targets, earnings history, insider transactions, growth).
    func fetchEnhancedFundamentals(symbol: String) async -> [String: Any]? {
        await throttle()
        let modules = "financialData,earningsHistory,insiderTransactions,defaultKeyStatistics,price,earningsTrend,calendarEvents,summaryDetail,summaryProfile"
        guard let url = URL(string: "\(Constants.yahooBaseURL)/v10/finance/quoteSummary/\(symbol)?modules=\(modules)") else { return nil }
        do {
            let (data, _) = try await session.data(from: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let qs = json["quoteSummary"] as? [String: Any],
                  let results = qs["result"] as? [[String: Any]],
                  let first = results.first else { return nil }

            var out = [String: Any]()

            // price module: marketCap, sector
            if let price = first["price"] as? [String: Any] {
                if let mc = price["marketCap"] as? [String: Any] { out["marketCap"] = mc["raw"] as? Double }
            }

            // defaultKeyStatistics: P/E, EPS, dividendYield, sector
            if let dks = first["defaultKeyStatistics"] as? [String: Any] {
                if let pe = dks["forwardPE"] as? [String: Any] { out["peRatio"] = pe["raw"] as? Double }
                if let pe = dks["trailingEps"] as? [String: Any] { out["eps"] = pe["raw"] as? Double }
            }

            // summaryProfile: sector, industry (if available in modules)
            if let sp = first["summaryProfile"] as? [String: Any] {
                out["sector"] = sp["sector"] as? String
                out["industry"] = sp["industry"] as? String
            }
            // summaryDetail: dividendYield
            if let sd = first["summaryDetail"] as? [String: Any] {
                if let dy = sd["dividendYield"] as? [String: Any] { out["dividendYield"] = (dy["raw"] as? Double).map { $0 * 100 } }
            }

            // financialData: analyst targets, recommendation, growth
            if let fd = first["financialData"] as? [String: Any] {
                if let v = fd["targetMeanPrice"] as? [String: Any] { out["targetMeanPrice"] = v["raw"] as? Double }
                if let v = fd["targetHighPrice"] as? [String: Any] { out["targetHighPrice"] = v["raw"] as? Double }
                if let v = fd["targetLowPrice"] as? [String: Any] { out["targetLowPrice"] = v["raw"] as? Double }
                if let v = fd["numberOfAnalystOpinions"] as? [String: Any] { out["numberOfAnalystOpinions"] = v["raw"] as? Int }
                if let v = fd["recommendationMean"] as? [String: Any] { out["recommendationMean"] = v["raw"] as? Double }
                out["recommendationKey"] = fd["recommendationKey"] as? String
                if let v = fd["revenueGrowth"] as? [String: Any] { out["revenueGrowth"] = v["raw"] as? Double }
                if let v = fd["earningsGrowth"] as? [String: Any] { out["earningsGrowth"] = v["raw"] as? Double }
            }

            // earningsHistory: consecutive beats, avg surprise
            if let eh = first["earningsHistory"] as? [String: Any],
               let history = eh["history"] as? [[String: Any]] {
                var beats = 0
                var totalSurprise = 0.0
                var count = 0
                var lastSurprise: Double?
                // History is ordered oldest→newest
                var consecutiveFromRecent = 0
                var stillCounting = true
                for quarter in history.reversed() {
                    let estimate = (quarter["epsEstimate"] as? [String: Any])?["raw"] as? Double
                    let actual = (quarter["epsActual"] as? [String: Any])?["raw"] as? Double
                    let surprise = (quarter["surprisePercent"] as? [String: Any])?["raw"] as? Double
                    if count == 0 { lastSurprise = surprise }
                    if let s = surprise {
                        totalSurprise += s
                        count += 1
                    }
                    if let est = estimate, let act = actual, act > est {
                        beats += 1
                        if stillCounting { consecutiveFromRecent += 1 }
                    } else {
                        stillCounting = false
                    }
                }
                out["consecutiveBeats"] = consecutiveFromRecent
                out["avgSurprise"] = count > 0 ? (totalSurprise / Double(count)) * 100 : nil
                out["lastSurprise"] = lastSurprise.map { $0 * 100 }
            }

            // insiderTransactions: count buys vs sells in last 6 months
            if let it = first["insiderTransactions"] as? [String: Any],
               let transactions = it["transactions"] as? [[String: Any]] {
                let sixMonthsAgo = Date().addingTimeInterval(-180 * 24 * 3600)
                var buys = 0
                var sells = 0
                for tx in transactions {
                    if let dateDict = tx["startDate"] as? [String: Any],
                       let raw = dateDict["raw"] as? Int {
                        let txDate = Date(timeIntervalSince1970: Double(raw))
                        guard txDate >= sixMonthsAgo else { continue }
                    }
                    if let shares = tx["shares"] as? [String: Any],
                       let shareCount = shares["raw"] as? Int {
                        if shareCount > 0 { buys += 1 }
                        else if shareCount < 0 { sells += 1 }
                    }
                }
                out["insiderBuys"] = buys
                out["insiderSells"] = sells
                out["insiderNetBuying"] = buys > sells
            }

            // earningsTrend: EPS estimates and revision counts
            if let et = first["earningsTrend"] as? [String: Any],
               let trend = et["trend"] as? [[String: Any]] {
                // Find current quarter (first entry usually)
                if let currentQ = trend.first {
                    if let est = currentQ["earningsEstimate"] as? [String: Any] {
                        if let current = (est["avg"] as? [String: Any])?["raw"] as? Double {
                            out["epsEstimateCurrent"] = current
                        }
                    }
                    // Revision counts
                    if let revisions = currentQ["epsTrend"] as? [String: Any] {
                        if let d90 = (revisions["90daysAgo"] as? [String: Any])?["raw"] as? Double {
                            out["epsEstimate90dAgo"] = d90
                        }
                    }
                }
                // Try to get revision counts from epsTrend
                if let currentQ = trend.first,
                   let epsRevisions = currentQ["epsRevisions"] as? [String: Any] {
                    out["upRevisions30d"] = (epsRevisions["upLast30days"] as? [String: Any])?["raw"] as? Int
                    out["downRevisions30d"] = (epsRevisions["downLast30days"] as? [String: Any])?["raw"] as? Int
                }
            }

            // Compute revision direction
            if let current = out["epsEstimateCurrent"] as? Double,
               let ago90 = out["epsEstimate90dAgo"] as? Double, ago90 != 0 {
                let changePct = ((current - ago90) / abs(ago90)) * 100
                if changePct > 5 { out["revisionDirection"] = "strongUp" }
                else if changePct > 1 { out["revisionDirection"] = "up" }
                else if changePct < -5 { out["revisionDirection"] = "strongDown" }
                else if changePct < -1 { out["revisionDirection"] = "down" }
                else { out["revisionDirection"] = "flat" }
            }

            // summaryDetail: ex-dividend date and dividend rate
            if let sd = first["summaryDetail"] as? [String: Any] {
                if let exDiv = sd["exDividendDate"] as? [String: Any],
                   let raw = exDiv["raw"] as? Int {
                    out["exDividendDate"] = raw  // Unix timestamp
                }
                if let divRate = sd["dividendRate"] as? [String: Any] {
                    out["dividendRate"] = divRate["raw"] as? Double
                }
            }

            return out.isEmpty ? nil : out
        } catch { return nil }
    }

    /// Compare stock 1-day performance vs sector ETF.
    func fetchSectorComparison(symbol: String, sector: String?) async -> (etf: String, relStrength: Double, outperforming: Bool)? {
        await throttle()
        guard let sector = sector, let etf = Self.sectorETFs[sector] else { return nil }
        do {
            async let stockCandles = fetchCandles(symbol: symbol, interval: "1d", range: "5d")
            async let etfCandles = fetchCandles(symbol: etf, interval: "1d", range: "5d")
            let sc = try await stockCandles
            let ec = try await etfCandles
            guard sc.count >= 2, ec.count >= 2 else { return nil }
            let stockChange = ((sc.last!.close - sc[sc.count - 2].close) / sc[sc.count - 2].close) * 100
            let etfChange = ((ec.last!.close - ec[ec.count - 2].close) / ec[ec.count - 2].close) * 100
            let relStrength = stockChange - etfChange
            return (etf: etf, relStrength: relStrength, outperforming: relStrength > 0)
        } catch { return nil }
    }

    // MARK: - Private

    private func defaultRange(for interval: String) -> String {
        switch interval {
        case "1m": return "5d"
        case "5m", "15m": return "60d"
        case "30m", "60m", "1h": return "60d"
        case "1d": return "1y"
        case "1wk", "1mo": return "5y"
        default: return "60d"
        }
    }

    private func parseChartResponse(_ data: Data) throws -> [Candle] {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let chart = json["chart"] as? [String: Any],
              let results = chart["result"] as? [[String: Any]],
              let result = results.first,
              let timestamps = result["timestamp"] as? [Int],
              let indicators = result["indicators"] as? [String: Any],
              let quotes = indicators["quote"] as? [[String: Any]],
              let quote = quotes.first
        else { throw YahooError.decodingError("Invalid chart format") }

        let opens = quote["open"] as? [NSNumber?] ?? []
        let highs = quote["high"] as? [NSNumber?] ?? []
        let lows = quote["low"] as? [NSNumber?] ?? []
        let closes = quote["close"] as? [NSNumber?] ?? []
        let volumes = quote["volume"] as? [NSNumber?] ?? []

        var candles = [Candle]()
        for i in 0..<timestamps.count {
            guard let o = opens[safe: i]??.doubleValue,
                  let h = highs[safe: i]??.doubleValue,
                  let l = lows[safe: i]??.doubleValue,
                  let c = closes[safe: i]??.doubleValue
            else { continue } // Skip nulls (weekends/holidays)
            let vol = volumes[safe: i]??.doubleValue ?? 0
            let time = Date(timeIntervalSince1970: Double(timestamps[i]))
            candles.append(Candle(time: time, open: o, high: h, low: l, close: c, volume: vol))
        }

        guard !candles.isEmpty else { throw YahooError.noData }
        return candles
    }
}

// Safe array subscript
private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
