import Foundation

class CoinGeckoService {
    private let session: URLSession
    private var cache: [String: (info: CoinInfo, fetched: Date)] = [:]

    private static var symbolToId: [String: String] {
        Dictionary(uniqueKeysWithValues: Constants.allCoins.map { ($0.id, $0.geckoId) })
    }

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.httpTimeout
        self.session = URLSession(configuration: config)
    }

    func fetchSentiment(symbol: String) async throws -> CoinInfo? {
        guard let geckoId = Self.symbolToId[symbol] else { return nil }

        // Check cache
        if let cached = cache[geckoId], Date().timeIntervalSince(cached.fetched) < Constants.sentimentCacheDuration {
            return cached.info
        }

        var components = URLComponents(string: "\(Constants.coingeckoBaseURL)/coins/\(geckoId)")!
        components.queryItems = [
            URLQueryItem(name: "localization", value: "false"),
            URLQueryItem(name: "tickers", value: "false"),
            URLQueryItem(name: "community_data", value: "false"),
            URLQueryItem(name: "developer_data", value: "false"),
            URLQueryItem(name: "sparkline", value: "false"),
        ]

        let (data, _) = try await session.data(from: components.url!)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        let marketData = json["market_data"] as? [String: Any] ?? [:]
        let currentPriceMap = marketData["current_price"] as? [String: Any] ?? [:]
        let currentPrice = (currentPriceMap["usd"] as? NSNumber)?.doubleValue ?? 0

        let info = CoinInfo(
            currentPrice: currentPrice,
            ath: doubleFromMarket(marketData, key: "ath"),
            athChangePercentage: doubleFromMarket(marketData, key: "ath_change_percentage"),
            athDate: stringFromMarket(marketData, key: "ath_date"),
            marketCap: doubleFromMarket(marketData, key: "market_cap"),
            totalVolume: doubleFromMarket(marketData, key: "total_volume"),
            priceChange24h: (marketData["price_change_24h"] as? NSNumber)?.doubleValue ?? 0,
            priceChangePercentage24h: (marketData["price_change_percentage_24h"] as? NSNumber)?.doubleValue ?? 0,
            priceChangePercentage7d: (marketData["price_change_percentage_7d"] as? NSNumber)?.doubleValue ?? 0,
            priceChangePercentage14d: (marketData["price_change_percentage_14d"] as? NSNumber)?.doubleValue ?? 0,
            priceChangePercentage30d: (marketData["price_change_percentage_30d"] as? NSNumber)?.doubleValue ?? 0,
            high24h: doubleFromMarket(marketData, key: "high_24h"),
            low24h: doubleFromMarket(marketData, key: "low_24h")
        )

        cache[geckoId] = (info, Date())
        return info
    }

    /// Fetch Fear & Greed Index from alternative.me
    func fetchFearGreed() async -> FearGreedIndex? {
        // Check cache
        if let cached = fearGreedCache, Date().timeIntervalSince(cached.1) < Constants.sentimentCacheDuration {
            return cached.0
        }
        do {
            let url = URL(string: "https://api.alternative.me/fng/?limit=1")!
            let (data, _) = try await session.data(from: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let dataArr = json["data"] as? [[String: Any]],
                  let first = dataArr.first,
                  let valueStr = first["value"] as? String,
                  let value = Int(valueStr),
                  let classification = first["value_classification"] as? String
            else { return nil }
            let result = FearGreedIndex(value: value, classification: classification)
            fearGreedCache = (result, Date())
            return result
        } catch {
            return nil
        }
    }

    private var fearGreedCache: (FearGreedIndex, Date)?

    private func doubleFromMarket(_ data: [String: Any], key: String) -> Double {
        if let nested = data[key] as? [String: Any] {
            return (nested["usd"] as? NSNumber)?.doubleValue ?? 0
        }
        return (data[key] as? NSNumber)?.doubleValue ?? 0
    }

    private func stringFromMarket(_ data: [String: Any], key: String) -> String {
        if let nested = data[key] as? [String: Any] {
            return nested["usd"] as? String ?? ""
        }
        return data[key] as? String ?? ""
    }
}
