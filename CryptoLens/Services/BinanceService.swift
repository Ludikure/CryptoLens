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

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.httpTimeout
        self.session = URLSession(configuration: config)
    }

    func fetchCandles(symbol: String, interval: String, limit: Int = 300) async throws -> [Candle] {
        var components = URLComponents(string: "\(Constants.binanceBaseURL)/klines")!
        components.queryItems = [
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: interval),
            URLQueryItem(name: "limit", value: String(limit)),
        ]

        let (data, response) = try await session.data(from: components.url!)

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
}
