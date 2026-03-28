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
}
