import Foundation

struct FundingEntry: Codable {
    let fundingRate: Double
    let fundingTime: Date
}

struct DerivativesData: Codable {
    let fundingRate: Double
    let fundingRatePercent: Double
    let fundingHistory: [FundingEntry]
    let avgFundingRate: Double
    let markPrice: Double
    let indexPrice: Double
    let markIndexPremium: Double
    let openInterest: Double
    let openInterestUSD: Double
    let oiChange4h: Double?
    let oiChange24h: Double?
    let globalLongPercent: Double
    let globalShortPercent: Double
    let topTraderLongPercent: Double
    let topTraderShortPercent: Double
    let takerBuySellRatio: Double
    let takerBuyVolume: Double
    let takerSellVolume: Double
}
