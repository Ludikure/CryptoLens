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

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.httpTimeout
        self.session = URLSession(configuration: config)
    }

    /// Fetch OHLCV candles from Yahoo Finance.
    func fetchCandles(symbol: String, interval: String, range: String? = nil) async throws -> [Candle] {
        var components = URLComponents(string: "\(Constants.yahooBaseURL)/v8/finance/chart/\(symbol)")!

        // Default ranges per interval
        let effectiveRange = range ?? defaultRange(for: interval)
        components.queryItems = [
            URLQueryItem(name: "interval", value: interval),
            URLQueryItem(name: "range", value: effectiveRange),
        ]

        let (data, response) = try await session.data(from: components.url!)

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
        var components = URLComponents(string: "\(Constants.yahooBaseURL)/v8/finance/chart/\(symbol)")!
        components.queryItems = [
            URLQueryItem(name: "interval", value: "1d"),
            URLQueryItem(name: "range", value: "5d"),
        ]

        let (data, response) = try await session.data(from: components.url!)
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
        // Fetch quote summary for short interest
        async let summaryData = fetchQuoteSummary(symbol: symbol)
        async let vixCandles = fetchVIX()

        let summary = await summaryData
        let vix = await vixCandles

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
            putCallRatio: nil // CBOE integration TODO
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

    private func fetchVIX() async -> Candle? {
        do {
            let candles = try await fetchCandles(symbol: "%5EVIX", interval: "1d", range: "5d")
            return candles.last
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
