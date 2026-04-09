import Foundation

/// Fetches stock candles from Twelve Data via the worker proxy.
/// Supports native 4H candles — no client-side aggregation needed.
class TwelveDataProvider {
    private let session = URLSession.shared
    private let workerURL = PushService.workerURL

    /// Twelve Data interval strings
    private func resolveInterval(_ interval: String) -> String {
        switch interval {
        case "1d": return "1day"
        case "4h": return "4h"
        case "1h": return "1h"
        case "15m", "15": return "15min"
        default: return interval
        }
    }

    /// Fetch historical candles with date range. Twelve Data supports up to 5000 per request.
    /// For 1H data: 5000 candles ≈ 2.8 years of trading days.
    func fetchHistoricalCandles(symbol: String, interval: String,
                                 startDate: Date, endDate: Date) async throws -> [Candle] {
        let tdInterval = resolveInterval(interval)
        guard var components = URLComponents(string: "\(workerURL)/twelvedata/candles") else {
            throw TwelveDataError.networkError("Invalid URL")
        }
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        components.queryItems = [
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: tdInterval),
            URLQueryItem(name: "start_date", value: df.string(from: startDate)),
            URLQueryItem(name: "end_date", value: df.string(from: endDate)),
        ]
        guard let url = components.url else {
            throw TwelveDataError.networkError("Invalid URL")
        }

        var request = URLRequest(url: url)
        PushService.addAuthHeaders(&request)

        let (data, response) = try await session.data(for: request)

        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 { throw TwelveDataError.unauthorized }
            if http.statusCode == 429 { throw TwelveDataError.rateLimited }
            guard (200...299).contains(http.statusCode) else {
                throw TwelveDataError.networkError("HTTP \(http.statusCode)")
            }
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TwelveDataError.decodingError("Invalid JSON")
        }

        if let code = json["code"] as? Int, code != 200 {
            let message = json["message"] as? String ?? "Unknown error"
            throw TwelveDataError.apiError(code, message)
        }

        guard let values = json["values"] as? [[String: Any]] else {
            throw TwelveDataError.decodingError("Missing values array")
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "America/New_York")

        var candles = [Candle]()
        for item in values {
            guard let dateStr = item["datetime"] as? String,
                  let open = Double(item["open"] as? String ?? ""),
                  let high = Double(item["high"] as? String ?? ""),
                  let low = Double(item["low"] as? String ?? ""),
                  let close = Double(item["close"] as? String ?? "")
            else { continue }

            let volume = Double(item["volume"] as? String ?? "") ?? 0
            formatter.dateFormat = dateStr.count > 10 ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd"
            guard let time = formatter.date(from: dateStr) else { continue }
            candles.append(Candle(time: time, open: open, high: high, low: low, close: close, volume: volume))
        }

        candles.reverse()

        #if DEBUG
        print("[MarketScope] [\(symbol)] TwelveData historical \(tdInterval): \(candles.count) candles")
        #endif

        return candles
    }

    /// Fetch OHLCV candles via worker proxy (cached 60s server-side).
    func fetchCandles(symbol: String, interval: String, limit: Int = 300) async throws -> [Candle] {
        let tdInterval = resolveInterval(interval)
        guard var components = URLComponents(string: "\(workerURL)/twelvedata/candles") else {
            throw TwelveDataError.networkError("Invalid URL")
        }
        components.queryItems = [
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: tdInterval),
            URLQueryItem(name: "outputsize", value: String(limit)),
        ]
        guard let url = components.url else {
            throw TwelveDataError.networkError("Invalid URL")
        }

        var request = URLRequest(url: url)
        PushService.addAuthHeaders(&request)

        let (data, response) = try await session.data(for: request)

        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 { throw TwelveDataError.unauthorized }
            if http.statusCode == 429 { throw TwelveDataError.rateLimited }
            guard (200...299).contains(http.statusCode) else {
                throw TwelveDataError.networkError("HTTP \(http.statusCode)")
            }
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TwelveDataError.decodingError("Invalid JSON")
        }

        // Check for API errors
        if let code = json["code"] as? Int, code != 200 {
            let message = json["message"] as? String ?? "Unknown error"
            throw TwelveDataError.apiError(code, message)
        }

        // Parse Twelve Data response: { "values": [ { "datetime", "open", "high", "low", "close", "volume" }, ... ] }
        guard let values = json["values"] as? [[String: Any]] else {
            throw TwelveDataError.decodingError("Missing values array")
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "America/New_York")

        var candles = [Candle]()
        for item in values {
            guard let dateStr = item["datetime"] as? String,
                  let open = Double(item["open"] as? String ?? ""),
                  let high = Double(item["high"] as? String ?? ""),
                  let low = Double(item["low"] as? String ?? ""),
                  let close = Double(item["close"] as? String ?? "")
            else { continue }

            let volume = Double(item["volume"] as? String ?? "") ?? 0

            // Parse datetime — Twelve Data uses "2026-03-28" for daily, "2026-03-28 10:00:00" for intraday
            formatter.dateFormat = dateStr.count > 10 ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd"
            guard let time = formatter.date(from: dateStr) else { continue }

            candles.append(Candle(time: time, open: open, high: high, low: low, close: close, volume: volume))
        }

        // Twelve Data returns newest first — reverse to oldest first (matching Binance/Yahoo convention)
        candles.reverse()

        #if DEBUG
        print("[MarketScope] [\(symbol)] TwelveData \(tdInterval): \(candles.count) candles")
        #endif

        return candles
    }
}

enum TwelveDataError: LocalizedError {
    case networkError(String)
    case decodingError(String)
    case apiError(Int, String)
    case unauthorized
    case rateLimited

    var errorDescription: String? {
        switch self {
        case .networkError(let msg): return "Network error: \(msg)"
        case .decodingError(let msg): return "Data error: \(msg)"
        case .apiError(_, let msg): return "API error: \(msg)"
        case .unauthorized: return "Not authenticated"
        case .rateLimited: return "Rate limited — try again shortly"
        }
    }
}
