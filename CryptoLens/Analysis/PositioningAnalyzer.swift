import Foundation

enum PositioningAnalyzer {
    static func analyze(data: DerivativesData) -> PositioningSnapshot {
        // Crowding
        let crowding: CrowdingState
        if data.globalLongPercent > 60 { crowding = .crowdedLong }
        else if data.globalShortPercent > 60 { crowding = .crowdedShort }
        else { crowding = .balanced }

        // Funding sentiment
        let fundingSentiment: String
        let fr = data.fundingRatePercent
        if fr > 0.05 { fundingSentiment = "Elevated positive (longs paying)" }
        else if fr > 0.01 { fundingSentiment = "Positive (normal)" }
        else if fr < -0.05 { fundingSentiment = "Elevated negative (shorts paying)" }
        else if fr < -0.01 { fundingSentiment = "Negative (slight short bias)" }
        else { fundingSentiment = "Neutral" }

        // OI trend
        let oiTrend: OITrend
        if let change = data.oiChange4h {
            if change > 3 { oiTrend = .building }
            else if change < -3 { oiTrend = .unwinding }
            else { oiTrend = .stable }
        } else { oiTrend = .stable }

        // Smart money
        let smartMoneyBias: String
        if data.topTraderLongPercent > 55 { smartMoneyBias = "Leaning long" }
        else if data.topTraderShortPercent > 55 { smartMoneyBias = "Leaning short" }
        else { smartMoneyBias = "Neutral" }

        // Taker pressure
        let takerPressure: String
        if data.takerBuySellRatio > 1.3 { takerPressure = "Strong buy pressure" }
        else if data.takerBuySellRatio > 1.1 { takerPressure = "Slight buy pressure" }
        else if data.takerBuySellRatio < 0.7 { takerPressure = "Strong sell pressure" }
        else if data.takerBuySellRatio < 0.9 { takerPressure = "Slight sell pressure" }
        else { takerPressure = "Balanced" }

        // Squeeze risk
        var squeezeRisk = SqueezeRisk(level: "NONE", direction: "", description: "No squeeze conditions")
        if crowding == .crowdedLong && fr > 0.05 && oiTrend == .building {
            squeezeRisk = SqueezeRisk(level: "HIGH", direction: "LONG SQUEEZE", description: "Crowded longs with elevated funding and building OI — liquidation cascade risk")
        } else if crowding == .crowdedShort && fr < -0.05 && oiTrend == .building {
            squeezeRisk = SqueezeRisk(level: "HIGH", direction: "SHORT SQUEEZE", description: "Crowded shorts with negative funding and building OI — squeeze risk")
        } else if crowding == .crowdedLong && fr > 0.03 {
            squeezeRisk = SqueezeRisk(level: "MODERATE", direction: "LONG SQUEEZE", description: "Moderately crowded longs with positive funding")
        } else if crowding == .crowdedShort && fr < -0.03 {
            squeezeRisk = SqueezeRisk(level: "MODERATE", direction: "SHORT SQUEEZE", description: "Moderately crowded shorts with negative funding")
        }

        // Generate signals
        var signals = [PositioningSignal]()
        if squeezeRisk.level == "HIGH" {
            signals.append(PositioningSignal(strength: "Strong", message: "\(squeezeRisk.direction) risk — \(Int(max(data.globalLongPercent, data.globalShortPercent)))% on one side with \(fr > 0 ? "positive" : "negative") funding and \(oiTrend.rawValue.lowercased()) OI"))
        }
        // Smart money divergence
        let retailLong = data.globalLongPercent > 55
        let smartLong = data.topTraderLongPercent > 55
        if retailLong != smartLong {
            signals.append(PositioningSignal(strength: "Moderate", message: "Smart money divergence — top traders \(smartMoneyBias.lowercased()) while retail \(retailLong ? "long" : "short")"))
        }
        // Extreme taker flow
        if data.takerBuySellRatio > 1.3 || data.takerBuySellRatio < 0.7 {
            signals.append(PositioningSignal(strength: "Moderate", message: "Aggressive \(data.takerBuySellRatio > 1 ? "buying" : "selling") — taker ratio \(String(format: "%.2f", data.takerBuySellRatio))"))
        }

        return PositioningSnapshot(
            crowding: crowding,
            fundingSentiment: fundingSentiment,
            oiTrend: oiTrend,
            smartMoneyBias: smartMoneyBias,
            takerPressure: takerPressure,
            squeezeRisk: squeezeRisk,
            signals: signals
        )
    }
}
