import Foundation

/// Spot buy/sell pressure display model. Populated server-side via the Worker `/market`
/// enrichment bundle (`WorkerMarketService`) — the phone can't reach Binance spot directly.
struct SpotPressure {
    let takerBuyRatio: Double       // 0-1, >0.55 = aggressive buying
    let takerBuyLabel: String       // "Aggressive Buying" / "Aggressive Selling" / "Neutral"
    let cvd24h: Double              // Cumulative Volume Delta in base asset (e.g., BTC)
    let cvdTrend: String            // "Rising" / "Falling" / "Flat"
    let bookRatio: Double?          // bid/(bid+ask), >0.6 = strong support
    let bookLabel: String?          // "Strong Bid Support" / "Heavy Ask Pressure" / "Balanced"
}
