import Foundation

/// A single evaluation point in the backtest.
struct BacktestDataPoint: Codable {
    let timestamp: Date
    let price: Double
    let dailyScore: Int
    let dailyBias: String
    let fourHScore: Int
    let fourHBias: String
    let oneHScore: Int
    let oneHBias: String
    let biasAlignment: String
    let regime: String
    let emaRegime: String
    let volScalar: Double
    let atrPercentile: Double
    var priceAfter4H: Double?
    var priceAfter3x4H: Double?
    var priceAfter6x4H: Double?
    var maxFavorable24H: Double?
    var maxAdverse24H: Double?

    var directionCorrect4H: Bool? {
        guard let future = priceAfter4H else { return nil }
        if biasAlignment.contains("bearish") { return future < price }
        if biasAlignment.contains("bullish") { return future > price }
        return nil
    }

    var directionCorrect24H: Bool? {
        guard let future = priceAfter6x4H else { return nil }
        if biasAlignment.contains("bearish") { return future < price }
        if biasAlignment.contains("bullish") { return future > price }
        return nil
    }

    /// Did price move > 1% in the labeled direction at ANY point in 48H?
    /// Measures "did a tradeable setup exist?" not "did the candle close confirm?"
    var opportunityHit: Bool? {
        guard let maxFav = maxFavorable24H, price > 0 else { return nil }
        guard biasAlignment.contains("bearish") || biasAlignment.contains("bullish") else { return nil }
        return (maxFav / price) * 100 > 1.0
    }
}

/// Aggregate results from a backtest run.
struct BacktestSummary: Codable {
    let symbol: String
    let startDate: Date
    let endDate: Date
    let totalBars: Int
    let evaluatedBars: Int
    let accuracy4H: Double
    let accuracy24H: Double
    let bearishAccuracy: Double
    let bullishAccuracy: Double
    let strongAccuracy: Double
    let moderateAccuracy: Double
    let weakAccuracy: Double
    let trendingAccuracy: Double
    let rangingAccuracy: Double
    let transitioningAccuracy: Double
    let adaptiveAccuracy: Double
    let staticAccuracy: Double
    let totalFlats: Int
    let correctFlats: Int
    let falseFlats: Int
    let flatAccuracy: Double
    let opportunityRate: Double       // % of directional labels where price moved >1% in direction
    let bullishOpportunity: Double
    let bearishOpportunity: Double
    let thresholdSweep: [ThresholdResult]
    let scoreDistribution: [ScoreBucket]
}

/// Accuracy at each Daily score level.
struct ScoreBucket: Codable, Identifiable {
    var id: Int { score }
    let score: Int             // e.g. -8, -7, ... 0, ... +7, +8
    let count: Int             // how many bars had this score
    let correct24H: Int        // how many were directionally correct at 24H
    let accuracy: Double       // correct / count * 100
    let opportunity: Double    // % where price moved >1% in direction within 48H
    let avgMove: Double        // average % price move in 24H for this score
}

struct ThresholdResult: Codable, Identifiable {
    var id: String { "\(directionalThreshold)-\(strongThreshold)" }
    let directionalThreshold: Int
    let strongThreshold: Int
    let accuracy4H: Double
    let accuracy24H: Double
    let totalDirectional: Int
    let tradeFrequency: Double
}
