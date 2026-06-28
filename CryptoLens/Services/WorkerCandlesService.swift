import Foundation

/// Thin-client crypto candle source. Calls the Worker `GET /candles/crypto?symbol=&interval=&limit=`
/// (public, box fetches Binance behind the NordVPN proxy) so the phone never hits `fapi.binance.com`
/// directly — that residential-IP call returns HTTP 451 and used to fall back to Coinbase.
///
/// Used for the OutcomeTracker 15m wick-detection feed.
enum WorkerCandlesService {

    /// Returns `[Candle]` (oldest→newest) or nil on any failure — callers fall back to the
    /// already-fetched 1H candles from `/indicators`, so this is best-effort.
    static func fetchCrypto(symbol: String, interval: String, limit: Int = 96) async -> [Candle]? {
        guard var comps = URLComponents(string: "\(PushService.workerURL)/candles/crypto") else { return nil }
        comps.queryItems = [
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: interval),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = comps.url else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        PushService.addAuthHeaders(&request)

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let rows = try? JSONDecoder().decode([Row].self, from: data) else { return nil }
        return rows.map { $0.toCandle() }
    }

    private struct Row: Decodable {
        let time: Double; let open: Double; let high: Double; let low: Double; let close: Double; let volume: Double
        func toCandle() -> Candle {
            Candle(time: Date(timeIntervalSince1970: time / 1000), open: open, high: high, low: low, close: close, volume: volume)
        }
    }
}
