import Foundation

enum BinanceError: LocalizedError {
    case rateLimited
    case invalidSymbol
    case networkError(String)
    case decodingError(String)

    var errorDescription: String? {
        switch self {
        case .rateLimited: return "Rate limited by Binance. Try again in 30s."
        case .invalidSymbol: return "Symbol not found on Binance."
        case .networkError(let msg): return "Network error: \(msg)"
        case .decodingError(let msg): return "Data error: \(msg)"
        }
    }
}

class BinanceService {
    private let session: URLSession
    private static let bybitBaseURL = "https://api.bybit.com/v5/market"

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.httpTimeout
        self.session = URLSession(configuration: config)
    }

    func fetchCandles(symbol: String, interval: String, limit: Int = 300) async throws -> [Candle] {
        do {
            return try await fetchBinanceCandles(symbol: symbol, interval: interval, limit: limit)
        } catch {
            // Fallback to Bybit on Binance network failure (VPN, geo-block, etc.)
            #if DEBUG
            print("[BinanceService] Binance failed (\(error.localizedDescription)), trying Bybit fallback")
            #endif
            return try await fetchBybitCandles(symbol: symbol, interval: interval, limit: limit)
        }
    }

    private func fetchBinanceCandles(symbol: String, interval: String, limit: Int) async throws -> [Candle] {
        guard var components = URLComponents(string: "\(Constants.binanceBaseURL)/klines") else {
            throw BinanceError.networkError("Invalid URL")
        }
        components.queryItems = [
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: interval),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components.url else {
            throw BinanceError.networkError("Invalid URL")
        }

        let (data, response) = try await RetryHelper.withRetry {
            try await self.session.data(from: url)
        }

        if let httpResponse = response as? HTTPURLResponse {
            if httpResponse.statusCode == 429 { throw BinanceError.rateLimited }
            if httpResponse.statusCode == 400 { throw BinanceError.invalidSymbol }
            guard (200...299).contains(httpResponse.statusCode) else {
                throw BinanceError.networkError("HTTP \(httpResponse.statusCode)")
            }
        }

        guard let rawArray = try JSONSerialization.jsonObject(with: data) as? [[Any]] else {
            throw BinanceError.decodingError("Unexpected response format")
        }

        return rawArray.compactMap { k -> Candle? in
            guard k.count >= 6,
                  let timeMs = k[0] as? Double,
                  let openStr = k[1] as? String, let open = Double(openStr),
                  let highStr = k[2] as? String, let high = Double(highStr),
                  let lowStr = k[3] as? String, let low = Double(lowStr),
                  let closeStr = k[4] as? String, let close = Double(closeStr),
                  let volStr = k[5] as? String, let volume = Double(volStr)
            else { return nil }
            let time = Date(timeIntervalSince1970: timeMs / 1000.0)
            return Candle(time: time, open: open, high: high, low: low, close: close, volume: volume)
        }
    }

    /// Fetch historical candles with date range. Paginates automatically (1000 per request).
    func fetchHistoricalCandles(symbol: String, interval: String,
                                 startDate: Date, endDate: Date) async throws -> [Candle] {
        var allCandles = [Candle]()
        var currentStart = Int(startDate.timeIntervalSince1970 * 1000)
        let endMs = Int(endDate.timeIntervalSince1970 * 1000)

        while currentStart < endMs {
            guard var components = URLComponents(string: "\(Constants.binanceBaseURL)/klines") else { break }
            components.queryItems = [
                URLQueryItem(name: "symbol", value: symbol),
                URLQueryItem(name: "interval", value: interval),
                URLQueryItem(name: "startTime", value: String(currentStart)),
                URLQueryItem(name: "endTime", value: String(endMs)),
                URLQueryItem(name: "limit", value: "1000"),
            ]
            guard let url = components.url else { break }

            let (data, response) = try await RetryHelper.withRetry {
                try await self.session.data(from: url)
            }
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 429 {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                    continue
                }
                guard (200...299).contains(http.statusCode) else { break }
            }

            guard let rawArray = try JSONSerialization.jsonObject(with: data) as? [[Any]] else { break }
            if rawArray.isEmpty { break }

            let batch = rawArray.compactMap { k -> Candle? in
                guard k.count >= 6,
                      let timeMs = k[0] as? Double,
                      let openStr = k[1] as? String, let open = Double(openStr),
                      let highStr = k[2] as? String, let high = Double(highStr),
                      let lowStr = k[3] as? String, let low = Double(lowStr),
                      let closeStr = k[4] as? String, let close = Double(closeStr),
                      let volStr = k[5] as? String, let volume = Double(volStr)
                else { return nil }
                return Candle(time: Date(timeIntervalSince1970: timeMs / 1000.0),
                              open: open, high: high, low: low, close: close, volume: volume)
            }
            allCandles.append(contentsOf: batch)
            if let lastTime = batch.last?.time {
                currentStart = Int(lastTime.timeIntervalSince1970 * 1000) + 1
            } else { break }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        return allCandles
    }

    // MARK: - Bybit Fallback

    /// Bybit interval mapping: Binance "1d" → Bybit "D", "4h" → "240", "1h" → "60"
    private func bybitInterval(_ binanceInterval: String) -> String {
        switch binanceInterval {
        case "1d": return "D"
        case "4h": return "240"
        case "1h": return "60"
        case "15m": return "15"
        case "5m": return "5"
        case "1m": return "1"
        default: return "60"
        }
    }

    private func fetchBybitCandles(symbol: String, interval: String, limit: Int) async throws -> [Candle] {
        guard var components = URLComponents(string: "\(Self.bybitBaseURL)/kline") else {
            throw BinanceError.networkError("Invalid Bybit URL")
        }
        components.queryItems = [
            URLQueryItem(name: "category", value: "linear"),
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: bybitInterval(interval)),
            URLQueryItem(name: "limit", value: String(min(limit, 200))),
        ]
        guard let url = components.url else {
            throw BinanceError.networkError("Invalid Bybit URL")
        }

        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse {
            guard (200...299).contains(http.statusCode) else {
                throw BinanceError.networkError("Bybit HTTP \(http.statusCode)")
            }
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let result = json["result"] as? [String: Any],
              let list = result["list"] as? [[Any]] else {
            throw BinanceError.decodingError("Unexpected Bybit response")
        }

        // Bybit returns [startTime, open, high, low, close, volume, turnover] newest first
        let candles: [Candle] = list.compactMap { k in
            guard k.count >= 6,
                  let timeStr = k[0] as? String, let timeMs = Double(timeStr),
                  let openStr = k[1] as? String, let open = Double(openStr),
                  let highStr = k[2] as? String, let high = Double(highStr),
                  let lowStr = k[3] as? String, let low = Double(lowStr),
                  let closeStr = k[4] as? String, let close = Double(closeStr),
                  let volStr = k[5] as? String, let volume = Double(volStr)
            else { return nil }
            return Candle(time: Date(timeIntervalSince1970: timeMs / 1000.0),
                          open: open, high: high, low: low, close: close, volume: volume)
        }

        // Bybit returns newest first — reverse to oldest first (Binance convention)
        return candles.reversed()
    }
}
