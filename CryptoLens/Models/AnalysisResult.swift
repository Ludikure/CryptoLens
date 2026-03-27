import Foundation

struct AnalysisResult: Identifiable, Codable {
    let id: UUID
    let symbol: String
    let timestamp: Date            // When indicators were last fetched
    let analysisTimestamp: Date?   // When Claude analysis was last run (nil = no analysis yet)
    let daily: IndicatorResult
    let h4: IndicatorResult
    let h1: IndicatorResult
    let sentiment: CoinInfo?
    let claudeAnalysis: String
    let tradeSetups: [TradeSetup]

    init(symbol: String, timestamp: Date, analysisTimestamp: Date? = nil, daily: IndicatorResult, h4: IndicatorResult, h1: IndicatorResult, sentiment: CoinInfo?, claudeAnalysis: String, tradeSetups: [TradeSetup] = []) {
        self.id = UUID()
        self.symbol = symbol
        self.timestamp = timestamp
        self.analysisTimestamp = analysisTimestamp
        self.daily = daily
        self.h4 = h4
        self.h1 = h1
        self.sentiment = sentiment
        self.claudeAnalysis = claudeAnalysis
        self.tradeSetups = tradeSetups
    }
}
