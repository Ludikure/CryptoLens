import Foundation

/// Fetches stock candles from Tiingo via the worker proxy.
/// 1H and Daily are native. 4H is aggregated from 1H candles.
class TiingoProvider {
    private let session = URLSession.shared
    private let workerURL = PushService.workerURL

    func fetchCandles(symbol: String, interval: String, limit: Int = 300) async throws -> [Candle] {
        switch interval {
        case "4h":
            // Fetch 1H candles and aggregate to 4H
            let hourly = try await fetchRaw(symbol: symbol, interval: "1hour", days: 90)
            let aggregated = aggregate1HTo4H(hourly)
            return Array(aggregated.suffix(limit))
        case "1h":
            return try await fetchRaw(symbol: symbol, interval: "1hour", days: 60)
        case "1d":
            return try await fetchRaw(symbol: symbol, interval: "1day", days: 400)
        default:
            return try await fetchRaw(symbol: symbol, interval: "1hour", days: 60)
        }
    }

    // MARK: - Raw Fetch via Worker

    private func fetchRaw(symbol: String, interval: String, days: Int) async throws -> [Candle] {
        guard var components = URLComponents(string: "\(workerURL)/tiingo/candles") else {
            throw TiingoError.networkError("Invalid URL")
        }
        components.queryItems = [
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: interval),
            URLQueryItem(name: "days", value: String(days)),
        ]
        guard let url = components.url else { throw TiingoError.networkError("Invalid URL") }

        var request = URLRequest(url: url)
        PushService.addAuthHeaders(&request)

        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 { throw TiingoError.unauthorized }
            if http.statusCode == 429 { throw TiingoError.rateLimited }
            guard (200...299).contains(http.statusCode) else {
                throw TiingoError.networkError("HTTP \(http.statusCode)")
            }
        }

        guard let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw TiingoError.decodingError("Invalid response")
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var candles = [Candle]()
        for item in arr {
            guard let dateStr = item["date"] as? String else { continue }

            // Tiingo daily uses different field names
            let open: Double
            let high: Double
            let low: Double
            let close: Double
            let volume: Double

            if let o = item["open"] as? Double {
                open = o
                high = item["high"] as? Double ?? o
                low = item["low"] as? Double ?? o
                close = item["close"] as? Double ?? o
                volume = item["volume"] as? Double ?? 0
            } else if let o = item["adjOpen"] as? Double {
                // Daily endpoint uses adj* fields
                open = o
                high = item["adjHigh"] as? Double ?? o
                low = item["adjLow"] as? Double ?? o
                close = item["adjClose"] as? Double ?? o
                volume = item["adjVolume"] as? Double ?? 0
            } else { continue }

            guard open > 0 else { continue }

            let time = formatter.date(from: dateStr) ?? Date()
            candles.append(Candle(time: time, open: open, high: high, low: low, close: close, volume: volume))
        }

        #if DEBUG
        print("[MarketScope] [\(symbol)] Tiingo \(interval): \(candles.count) candles")
        #endif

        return candles
    }

    // MARK: - 4H Aggregation

    /// Aggregate 1H candles into 4H candles.
    /// US market: 9:30-16:00 ET = 6.5 hours → chunk into 4H + 2.5H per day.
    private func aggregate1HTo4H(_ hourly: [Candle]) -> [Candle] {
        // Group by trading day
        let cal = Calendar(identifier: .gregorian)
        let et = TimeZone(identifier: "America/New_York")!
        var dayGroups: [[Candle]] = []
        var currentDay: Int? = nil
        var currentGroup: [Candle] = []

        for candle in hourly {
            let comps = cal.dateComponents(in: et, from: candle.time)
            let day = comps.day
            if day != currentDay {
                if !currentGroup.isEmpty { dayGroups.append(currentGroup) }
                currentGroup = [candle]
                currentDay = day
            } else {
                currentGroup.append(candle)
            }
        }
        if !currentGroup.isEmpty { dayGroups.append(currentGroup) }

        // For each day, chunk into 4H blocks
        var result: [Candle] = []
        for session in dayGroups {
            var i = 0
            while i < session.count {
                let chunk = Array(session[i..<min(i + 4, session.count)])
                if !chunk.isEmpty {
                    result.append(mergeCandles(chunk))
                }
                i += 4
            }
        }
        return result
    }

    private func mergeCandles(_ candles: [Candle]) -> Candle {
        Candle(
            time: candles.first!.time,
            open: candles.first!.open,
            high: candles.map(\.high).max()!,
            low: candles.map(\.low).min()!,
            close: candles.last!.close,
            volume: candles.map(\.volume).reduce(0, +)
        )
    }
}

enum TiingoError: LocalizedError {
    case networkError(String)
    case decodingError(String)
    case unauthorized
    case rateLimited

    var errorDescription: String? {
        switch self {
        case .networkError(let msg): return "Network error: \(msg)"
        case .decodingError(let msg): return "Data error: \(msg)"
        case .unauthorized: return "Not authenticated"
        case .rateLimited: return "Rate limited"
        }
    }
}
