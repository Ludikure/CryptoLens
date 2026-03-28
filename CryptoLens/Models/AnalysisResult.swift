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
    let sentiment: CoinInfo?              // Crypto only
    let fearGreed: FearGreedIndex?        // Global
    let stockInfo: StockInfo?             // Stocks only
    let derivatives: DerivativesData?      // Crypto only
    let positioning: PositioningSnapshot?  // Crypto only
    let stockSentiment: StockSentimentData? // Stocks only
    let economicEvents: [EconomicEvent]
    let claudeAnalysis: String
    let tradeSetups: [TradeSetup]

    // Convenience accessors
    var daily: IndicatorResult { tf1 }
    var h4: IndicatorResult { tf2 }
    var h1: IndicatorResult { tf3 }

    init(symbol: String, market: Market = .crypto, timestamp: Date, analysisTimestamp: Date? = nil,
         tf1: IndicatorResult, tf2: IndicatorResult, tf3: IndicatorResult,
         sentiment: CoinInfo? = nil, fearGreed: FearGreedIndex? = nil, stockInfo: StockInfo? = nil,
         derivatives: DerivativesData? = nil, positioning: PositioningSnapshot? = nil, stockSentiment: StockSentimentData? = nil,
         economicEvents: [EconomicEvent] = [],
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
        self.derivatives = derivatives
        self.positioning = positioning
        self.stockSentiment = stockSentiment
        self.economicEvents = economicEvents
        self.claudeAnalysis = claudeAnalysis
        self.tradeSetups = tradeSetups
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        symbol = try container.decode(String.self, forKey: .symbol)
        market = try container.decode(Market.self, forKey: .market)
        timestamp = try container.decode(Date.self, forKey: .timestamp)
        analysisTimestamp = try container.decodeIfPresent(Date.self, forKey: .analysisTimestamp)
        tf1 = try container.decode(IndicatorResult.self, forKey: .tf1)
        tf2 = try container.decode(IndicatorResult.self, forKey: .tf2)
        tf3 = try container.decode(IndicatorResult.self, forKey: .tf3)
        sentiment = try container.decodeIfPresent(CoinInfo.self, forKey: .sentiment)
        fearGreed = try container.decodeIfPresent(FearGreedIndex.self, forKey: .fearGreed)
        stockInfo = try container.decodeIfPresent(StockInfo.self, forKey: .stockInfo)
        derivatives = try container.decodeIfPresent(DerivativesData.self, forKey: .derivatives)
        positioning = try container.decodeIfPresent(PositioningSnapshot.self, forKey: .positioning)
        stockSentiment = try container.decodeIfPresent(StockSentimentData.self, forKey: .stockSentiment)
        economicEvents = (try? container.decodeIfPresent([EconomicEvent].self, forKey: .economicEvents)) ?? []
        claudeAnalysis = try container.decode(String.self, forKey: .claudeAnalysis)
        tradeSetups = try container.decode([TradeSetup].self, forKey: .tradeSetups)
    }
}
