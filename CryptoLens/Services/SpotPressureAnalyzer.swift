import Foundation

/// Spot buy/sell pressure signals from Binance free data.
/// Taker buy ratio + CVD from 1H klines, order book imbalance from depth.
struct SpotPressure {
    let takerBuyRatio: Double       // 0-1, >0.55 = aggressive buying
    let takerBuyLabel: String       // "Aggressive Buying" / "Aggressive Selling" / "Neutral"
    let cvd24h: Double              // Cumulative Volume Delta in base asset (e.g., BTC)
    let cvdTrend: String            // "Rising" / "Falling" / "Flat"
    let bookRatio: Double?          // bid/(bid+ask), >0.6 = strong support
    let bookLabel: String?          // "Strong Bid Support" / "Heavy Ask Pressure" / "Balanced"
}

enum SpotPressureAnalyzer {

    /// Compute spot pressure from Binance 1H klines (last 24) + order book.
    static func analyze(symbol: String) async -> SpotPressure? {
        let session = URLSession.shared
        let base = "https://data-api.binance.vision/api/v3"

        // Fetch 24 x 1H klines
        guard var components = URLComponents(string: "\(base)/klines") else { return nil }
        components.queryItems = [
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: "1h"),
            URLQueryItem(name: "limit", value: "24"),
        ]
        guard let url = components.url else { return nil }

        var totalVolume = 0.0
        var totalTakerBuy = 0.0
        var deltas = [Double]() // per-candle CVD

        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return nil }
            guard let klines = try JSONSerialization.jsonObject(with: data) as? [[Any]] else { return nil }

            for k in klines {
                guard k.count >= 10,
                      let volStr = k[5] as? String, let vol = Double(volStr),
                      let tbStr = k[9] as? String, let tb = Double(tbStr)
                else { continue }

                totalVolume += vol
                totalTakerBuy += tb
                let takerSell = vol - tb
                deltas.append(tb - takerSell)
            }
        } catch { return nil }

        guard totalVolume > 0, !deltas.isEmpty else { return nil }

        // Taker Buy Ratio
        let buyRatio = totalTakerBuy / totalVolume
        let buyLabel: String
        if buyRatio > 0.55 { buyLabel = "Aggressive Buying" }
        else if buyRatio < 0.45 { buyLabel = "Aggressive Selling" }
        else { buyLabel = "Neutral" }

        // CVD
        let cvd = deltas.reduce(0, +)
        let half = deltas.count / 2
        let firstHalf = deltas.prefix(half).reduce(0, +)
        let secondHalf = deltas.suffix(half).reduce(0, +)
        let cvdTrend: String
        if secondHalf > firstHalf * 1.2 { cvdTrend = "Rising" }
        else if secondHalf < firstHalf * 0.8 { cvdTrend = "Falling" }
        else { cvdTrend = "Flat" }

        // Order book depth
        var bookRatio: Double? = nil
        var bookLabel: String? = nil
        if let depthURL = URL(string: "\(base)/depth?symbol=\(symbol)&limit=20") {
            if let (depthData, depthResp) = try? await session.data(from: depthURL),
               let depthHttp = depthResp as? HTTPURLResponse, (200...299).contains(depthHttp.statusCode),
               let json = try? JSONSerialization.jsonObject(with: depthData) as? [String: Any],
               let bids = json["bids"] as? [[Any]],
               let asks = json["asks"] as? [[Any]] {
                let bidQty = bids.compactMap { Double($0[1] as? String ?? "") }.reduce(0, +)
                let askQty = asks.compactMap { Double($0[1] as? String ?? "") }.reduce(0, +)
                let total = bidQty + askQty
                if total > 0 {
                    let ratio = bidQty / total
                    bookRatio = ratio
                    if ratio > 0.6 { bookLabel = "Strong Bid Support" }
                    else if ratio < 0.4 { bookLabel = "Heavy Ask Pressure" }
                    else { bookLabel = "Balanced" }
                }
            }
        }

        #if DEBUG
        print("[MarketScope] SpotPressure: buyRatio=\(String(format: "%.2f", buyRatio)) (\(buyLabel)), CVD=\(String(format: "%.1f", cvd)) (\(cvdTrend)), book=\(bookRatio.map { String(format: "%.2f", $0) } ?? "N/A")")
        #endif

        return SpotPressure(
            takerBuyRatio: buyRatio,
            takerBuyLabel: buyLabel,
            cvd24h: cvd,
            cvdTrend: cvdTrend,
            bookRatio: bookRatio,
            bookLabel: bookLabel
        )
    }
}
