import Foundation

/// Fetches historical intraday stock candles from Alpha Vantage.
/// Used as fallback when Tiingo 1H is unavailable. Direct API (not proxied).
/// Free tier: 25 req/day — sufficient with disk caching.
class AlphaVantageProvider {
    private let session = URLSession.shared
    private let apiKey = "0qRAaTvX7XrZoIya_1mPWIA3uARznaFw"
    private let baseURL = "https://www.alphavantage.co/query"

    /// Fetch historical 1H candles. Returns full history (2+ years) with outputsize=full.
    func fetchHistoricalCandles(symbol: String, interval: String = "60min",
                                 startDate: Date? = nil, endDate: Date? = nil) async throws -> [Candle] {
        let avInterval: String
        switch interval {
        case "1h", "60min": avInterval = "60min"
        case "30m", "30min": avInterval = "30min"
        case "15m", "15min": avInterval = "15min"
        default: avInterval = "60min"
        }

        // Alpha Vantage returns all data at once with outputsize=full
        // For month-specific queries, use the month parameter
        guard var components = URLComponents(string: baseURL) else {
            throw AlphaVantageError.networkError("Invalid URL")
        }
        components.queryItems = [
            URLQueryItem(name: "function", value: "TIME_SERIES_INTRADAY"),
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: avInterval),
            URLQueryItem(name: "outputsize", value: "full"),
            URLQueryItem(name: "apikey", value: apiKey),
        ]
        guard let url = components.url else {
            throw AlphaVantageError.networkError("Invalid URL")
        }

        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse {
            guard (200...299).contains(http.statusCode) else {
                throw AlphaVantageError.networkError("HTTP \(http.statusCode)")
            }
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AlphaVantageError.decodingError("Invalid JSON")
        }

        // Check for rate limit / error messages
        if let errorMessage = json["Note"] as? String {
            throw AlphaVantageError.rateLimited(errorMessage)
        }
        if let errorMessage = json["Error Message"] as? String {
            throw AlphaVantageError.networkError(errorMessage)
        }

        // Alpha Vantage key format: "Time Series (60min)"
        let seriesKey = "Time Series (\(avInterval))"
        guard let timeSeries = json[seriesKey] as? [String: [String: String]] else {
            throw AlphaVantageError.decodingError("Missing '\(seriesKey)' in response")
        }

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        dateFormatter.timeZone = TimeZone(identifier: "America/New_York")

        var candles = [Candle]()
        for (dateStr, values) in timeSeries {
            guard let time = dateFormatter.date(from: dateStr),
                  let open = Double(values["1. open"] ?? ""),
                  let high = Double(values["2. high"] ?? ""),
                  let low = Double(values["3. low"] ?? ""),
                  let close = Double(values["4. close"] ?? ""),
                  let volume = Double(values["5. volume"] ?? "")
            else { continue }

            // Filter by date range if specified
            if let start = startDate, time < start { continue }
            if let end = endDate, time > end { continue }

            candles.append(Candle(time: time, open: open, high: high, low: low, close: close, volume: volume))
        }

        candles.sort { $0.time < $1.time }

        #if DEBUG
        print("[AlphaVantage] \(symbol) \(avInterval): \(candles.count) candles")
        #endif

        return candles
    }
}

enum AlphaVantageError: LocalizedError {
    case networkError(String)
    case decodingError(String)
    case rateLimited(String)

    var errorDescription: String? {
        switch self {
        case .networkError(let msg): return "Network error: \(msg)"
        case .decodingError(let msg): return "Data error: \(msg)"
        case .rateLimited(let msg): return "Rate limited: \(msg)"
        }
    }
}
