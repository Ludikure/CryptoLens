import Foundation

/// Pre-computed derivatives signals for bias scoring.
/// Built from either live DerivativesData or historical bars.
struct DerivativesContext {
    let fundingSignal: Int      // -1, 0, +1
    let fundingExtreme: Bool
    let oiSignal: Int           // -1, 0, +1
    let takerSignal: Int        // -1, 0, +1
    let crowdingSignal: Int     // -1, 0, +1

    var combinedSignal: Int {
        fundingSignal + oiSignal + takerSignal + crowdingSignal
    }

    // MARK: - Factory: Live Data

    static func from(data: DerivativesData, priceRising: Bool) -> DerivativesContext {
        // Funding rate (already in percent)
        let fr = data.fundingRatePercent
        let fundingSignal: Int
        let fundingExtreme: Bool
        if fr > 0.05 { fundingSignal = -1; fundingExtreme = true }
        else if fr > 0.03 { fundingSignal = -1; fundingExtreme = false }
        else if fr < -0.05 { fundingSignal = 1; fundingExtreme = true }
        else if fr < -0.03 { fundingSignal = 1; fundingExtreme = false }
        else { fundingSignal = 0; fundingExtreme = false }

        // OI change (24h percent)
        let oiSignal: Int
        if let oiChange = data.oiChange24h {
            let oiUp = oiChange > 1.0
            let oiDown = oiChange < -1.0
            if oiUp && priceRising { oiSignal = 1 }
            else if oiUp && !priceRising { oiSignal = -1 }
            else if oiDown && priceRising { oiSignal = -1 }
            else if oiDown && !priceRising { oiSignal = 1 }
            else { oiSignal = 0 }
        } else {
            oiSignal = 0
        }

        // Taker buy/sell ratio
        let takerSignal: Int
        let taker = data.takerBuySellRatio
        if taker > 1.1 { takerSignal = 1 }
        else if taker < 0.9 { takerSignal = -1 }
        else { takerSignal = 0 }

        // L/S ratio (contrarian)
        let crowdingSignal: Int
        let longPct = data.globalLongPercent
        if longPct > 60 { crowdingSignal = -1 }
        else if longPct < 40 { crowdingSignal = 1 }
        else { crowdingSignal = 0 }

        return DerivativesContext(
            fundingSignal: fundingSignal, fundingExtreme: fundingExtreme,
            oiSignal: oiSignal, takerSignal: takerSignal, crowdingSignal: crowdingSignal
        )
    }

    // MARK: - Factory: Historical Bar

    static func fromHistorical(bar: HistoricalDerivativesService.DerivativesBar,
                                previousOI: Double?, priceRising: Bool) -> DerivativesContext {
        // Funding (bar.fundingRate is already in percent)
        let fr = bar.fundingRate ?? 0
        let fundingSignal: Int
        let fundingExtreme: Bool
        if fr > 0.05 { fundingSignal = -1; fundingExtreme = true }
        else if fr > 0.03 { fundingSignal = -1; fundingExtreme = false }
        else if fr < -0.05 { fundingSignal = 1; fundingExtreme = true }
        else if fr < -0.03 { fundingSignal = 1; fundingExtreme = false }
        else { fundingSignal = 0; fundingExtreme = false }

        // OI change
        let oiSignal: Int
        if let prevOI = previousOI, let currentOI = bar.openInterest, prevOI > 0 {
            let oiChangePct = (currentOI - prevOI) / prevOI * 100
            let oiUp = oiChangePct > 1.0
            let oiDown = oiChangePct < -1.0
            if oiUp && priceRising { oiSignal = 1 }
            else if oiUp && !priceRising { oiSignal = -1 }
            else if oiDown && priceRising { oiSignal = -1 }
            else if oiDown && !priceRising { oiSignal = 1 }
            else { oiSignal = 0 }
        } else {
            oiSignal = 0
        }

        // Taker
        let takerSignal: Int
        let taker = bar.takerBuySellRatio ?? 1.0
        if taker > 1.1 { takerSignal = 1 }
        else if taker < 0.9 { takerSignal = -1 }
        else { takerSignal = 0 }

        // L/S ratio (contrarian)
        let crowdingSignal: Int
        let longPct = bar.longPercent ?? 50
        if longPct > 60 { crowdingSignal = -1 }
        else if longPct < 40 { crowdingSignal = 1 }
        else { crowdingSignal = 0 }

        return DerivativesContext(
            fundingSignal: fundingSignal, fundingExtreme: fundingExtreme,
            oiSignal: oiSignal, takerSignal: takerSignal, crowdingSignal: crowdingSignal
        )
    }
}
