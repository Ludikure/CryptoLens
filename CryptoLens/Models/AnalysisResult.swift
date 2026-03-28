import Foundation

struct AnalysisResult: Identifiable, Codable {
    let id: UUID
    let symbol: String
    let market: Market
    let timestamp: Date
    let analysisTimestamp: Date?
    let tf1: IndicatorResult       // Daily for both
    let tf2: IndicatorResult       // 4H (crypto) or 1H (stocks)
    let tf3: IndicatorResult       // 1H (crypto) or 15m (stocks)
    let sentiment: CoinInfo?       // Crypto only
    let fearGreed: FearGreedIndex? // Global
    let stockInfo: StockInfo?      // Stocks only
    let claudeAnalysis: String
    let tradeSetups: [TradeSetup]

    // Convenience accessors
    var daily: IndicatorResult { tf1 }
    var h4: IndicatorResult { tf2 }
    var h1: IndicatorResult { tf3 }

    init(symbol: String, market: Market = .crypto, timestamp: Date, analysisTimestamp: Date? = nil,
         tf1: IndicatorResult, tf2: IndicatorResult, tf3: IndicatorResult,
         sentiment: CoinInfo? = nil, fearGreed: FearGreedIndex? = nil, stockInfo: StockInfo? = nil,
         claudeAnalysis: String, tradeSetups: [TradeSetup] = []) {
        self.id = UUID()
        self.symbol = symbol
        self.market = market
        self.timestamp = timestamp
        self.analysisTimestamp = analysisTimestamp
        self.tf1 = tf1
        self.tf2 = tf2
        self.tf3 = tf3
        self.sentiment = sentiment
        self.fearGreed = fearGreed
        self.stockInfo = stockInfo
        self.claudeAnalysis = claudeAnalysis
        self.tradeSetups = tradeSetups
    }
}
