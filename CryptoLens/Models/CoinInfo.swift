import Foundation

struct CoinInfo: Codable {
    let currentPrice: Double
    let ath: Double
    let athChangePercentage: Double
    let athDate: String
    let marketCap: Double
    let totalVolume: Double
    let priceChange24h: Double
    let priceChangePercentage24h: Double
    let priceChangePercentage7d: Double
    let priceChangePercentage14d: Double
    let priceChangePercentage30d: Double
    let high24h: Double
    let low24h: Double
}

struct FearGreedIndex: Codable {
    let value: Int              // 0-100
    let classification: String  // "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"
}
