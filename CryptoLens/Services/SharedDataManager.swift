import Foundation

enum SharedDataManager {
    private static let suiteName = "group.com.ludikure.CryptoLens"
    private static let key = "widget_data"

    struct WidgetAsset: Codable {
        let symbol: String
        let ticker: String
        let price: Double
        let bias: String
        let change24h: Double?
        let timestamp: Date
    }

    static func writeLatest(results: [String: AnalysisResult], favorites: [String]) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return }

        let assets: [WidgetAsset] = favorites.compactMap { symbol in
            guard let result = results[symbol] else { return nil }
            let ticker = Constants.asset(for: symbol)?.ticker ?? symbol
            return WidgetAsset(
                symbol: symbol,
                ticker: ticker,
                price: result.daily.price,
                bias: result.daily.bias,
                change24h: result.sentiment?.priceChangePercentage24h,
                timestamp: result.timestamp
            )
        }

        if let data = try? JSONEncoder().encode(assets) {
            defaults.set(data, forKey: key)
        }
    }

    static func readLatest() -> [WidgetAsset] {
        guard let defaults = UserDefaults(suiteName: suiteName),
              let data = defaults.data(forKey: key),
              let assets = try? JSONDecoder().decode([WidgetAsset].self, from: data)
        else { return [] }
        return assets
    }
}
