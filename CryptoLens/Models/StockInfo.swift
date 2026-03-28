import Foundation

struct StockInfo: Codable {
    let marketCap: Double?
    let peRatio: Double?
    let eps: Double?
    let dividendYield: Double?
    let fiftyTwoWeekHigh: Double
    let fiftyTwoWeekLow: Double
    var earningsDate: Date?
    let sector: String?
    let industry: String?
    let marketState: String      // "PRE", "REGULAR", "POST", "CLOSED"
    let priceChangePercent1d: Double

    // Analyst
    var analystTargetMean: Double?
    var analystTargetHigh: Double?
    var analystTargetLow: Double?
    var analystCount: Int?
    var analystRating: String?          // "strong_buy", "buy", "hold", "sell"
    var analystRatingScore: Double?     // 1.0-5.0

    // Earnings History
    var consecutiveBeats: Int?
    var avgEarningsSurprise: Double?
    var lastEarningsSurprise: Double?

    // Growth
    var revenueGrowthYoY: Double?
    var earningsGrowthYoY: Double?
    var growthTrend: String?            // "accelerating", "stable", "decelerating", "declining"

    // Insider
    var insiderBuyCount6m: Int?
    var insiderSellCount6m: Int?
    var insiderNetBuying: Bool?

    // Sector relative strength
    var sectorETF: String?
    var relativeStrength1d: Double?
    var outperformingSector: Bool?

    // Estimate Revisions
    var epsEstimateCurrent: Double?
    var epsEstimate90dAgo: Double?
    var revisionDirection: String?      // "strongUp", "up", "flat", "down", "strongDown"
    var upRevisions30d: Int?
    var downRevisions30d: Int?

    // Dividend
    var exDividendDate: Date?
    var dividendRate: Double?           // Annual $ per share
    var exDividendWarning: Bool?        // true if ex-date within 5 trading days
}
