import Foundation

/// Fetches historical intraday stock candles from Alpha Vantage.
/// Used as fallback when Tiingo 1H is unavailable. Direct API (not proxied).
/// Free tier: 25 req/day — sufficient with disk caching.
class AlphaVantageProvider {
    private let session = URLSession.shared
    private let workerURL = PushService.workerURL

    /// Fetch historical 1H candles by paginating month-by-month.
    /// Alpha Vantage requires `month=YYYY-MM` param for historical intraday data.
    func fetchHistoricalCandles(symbol: String, interval: String = "60min",
                                 startDate: Date? = nil, endDate: Date? = nil) async throws -> [Candle] {
        let avInterval: String
        switch interval {
        case "1h", "60min": avInterval = "60min"
        case "30m", "30min": avInterval = "30min"
        case "15m", "15min": avInterval = "15min"
        default: avInterval = "60min"
        }

        let cal = Calendar.current
        let start = startDate ?? cal.date(byAdding: .year, value: -1, to: Date())!
        let end = endDate ?? Date()

        // Generate list of months to fetch
        var months = [String]()
        let monthFormatter = DateFormatter()
        monthFormatter.dateFormat = "yyyy-MM"
        var cursor = start
        while cursor <= end {
            months.append(monthFormatter.string(from: cursor))
            cursor = cal.date(byAdding: .month, value: 1, to: cursor) ?? end
        }

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        dateFormatter.timeZone = TimeZone(identifier: "America/New_York")

        var allCandles = [Candle]()

        for month in months {
            guard var components = URLComponents(string: "\(workerURL)/alphavantage/intraday") else { continue }
            components.queryItems = [
                URLQueryItem(name: "symbol", value: symbol),
                URLQueryItem(name: "interval", value: avInterval),
                URLQueryItem(name: "month", value: month),
            ]
            guard let url = components.url else { continue }

            var request = URLRequest(url: url)
            PushService.addAuthHeaders(&request)

            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 429 || http.statusCode == 503 {
                    #if DEBUG
                    print("[AlphaVantage] Rate limited at month \(month), stopping")
                    #endif
                    break
                }
                guard (200...299).contains(http.statusCode) else { continue }
            }

            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }

            if json["Note"] != nil || json["Information"] != nil {
                #if DEBUG
                print("[AlphaVantage] Rate limit note at month \(month), stopping")
                #endif
                break
            }

            let seriesKey = "Time Series (\(avInterval))"
            guard let timeSeries = json[seriesKey] as? [String: [String: String]] else { continue }

            for (dateStr, values) in timeSeries {
                guard let time = dateFormatter.date(from: dateStr),
                      let open = Double(values["1. open"] ?? ""),
                      let high = Double(values["2. high"] ?? ""),
                      let low = Double(values["3. low"] ?? ""),
                      let close = Double(values["4. close"] ?? ""),
                      let volume = Double(values["5. volume"] ?? "")
                else { continue }

                if time < start || time > end { continue }
                allCandles.append(Candle(time: time, open: open, high: high, low: low, close: close, volume: volume))
            }

            // Rate limit: Alpha Vantage free = 25 req/day, 5 req/min
            try? await Task.sleep(nanoseconds: 13_000_000_000)
        }

        allCandles.sort { $0.time < $1.time }

        #if DEBUG
        print("[AlphaVantage] \(symbol) \(avInterval): \(allCandles.count) candles across \(months.count) months")
        #endif

        return allCandles
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
