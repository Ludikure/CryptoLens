import Foundation

struct StockSentimentData: Codable {
    let shortPercentOfFloat: Double?   // % of float sold short
    let shortRatio: Double?            // Days to cover
    let vix: Double?                   // Current VIX level
    let vixChange: Double?             // VIX 24h change
    let vixLevel: String               // "Extreme Fear", "Elevated", "Normal", "Complacent"
    let fiftyTwoWeekPosition: Double   // 0-100, where price sits in 52w range
    let putCallRatio: Double?          // Equity put/call ratio (nil if unavailable)
}

extension StockSentimentData {
    static func vixClassification(_ vix: Double) -> String {
        if vix > 35 { return "Extreme Fear" }
        if vix > 25 { return "Elevated" }
        if vix > 15 { return "Normal" }
        return "Complacent"
    }
}
