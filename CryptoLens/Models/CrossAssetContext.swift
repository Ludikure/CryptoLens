import Foundation

/// Cross-asset directional signals for BTC scoring.
/// Only used for Daily timeframe scoring. 4H and 1H ignore this.
struct CrossAssetContext {
    let dxySignal: Int      // -1, 0, or +1 (from BTC's perspective)
    let dxyTrend: String    // "up", "down", "flat"
    let dxyPrice: Double
    let dxyEma20: Double

    let spySignal: Int      // -1, 0, or +1
    let spyTrend: String
    let spyPrice: Double
    let spyEma20: Double

    /// Combined cross-asset score for BTC (capped at ±2)
    var combinedSignal: Int {
        max(-2, min(2, dxySignal + spySignal))
    }

    /// Human-readable summary for prompt
    var summary: String {
        var parts = [String]()
        if dxySignal != 0 {
            parts.append("DXY \(dxyTrend) (\(dxySignal > 0 ? "tailwind" : "headwind"))")
        }
        if spySignal != 0 {
            parts.append("SPY \(spyTrend) (\(spySignal > 0 ? "risk-on" : "risk-off"))")
        }
        if parts.isEmpty { return "Cross-asset: neutral" }
        return "Cross-asset: \(parts.joined(separator: ", ")) → \(combinedSignal > 0 ? "+" : "")\(combinedSignal) for BTC"
    }
}
