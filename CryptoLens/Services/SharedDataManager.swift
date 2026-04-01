import Foundation

/// Widget shared data — disabled until App Group is provisioned on developer portal.
/// To enable: add "group.com.ludikure.CryptoLens" App Group in Apple Developer portal,
/// re-add to MarketScope.entitlements, and uncomment the code below.
enum SharedDataManager {
    struct WidgetAsset: Codable {
        let symbol: String
        let ticker: String
        let price: Double
        let bias: String
        let change24h: Double?
        let timestamp: Date
    }

    static func writeLatest(results: [String: AnalysisResult], favorites: [String]) {
        // No-op until App Group provisioned
    }

    static func readLatest() -> [WidgetAsset] {
        []
    }
}
