import Foundation

// MARK: - Stock-only indicators

/// On-Balance Volume — cumulative volume flow.
enum OBV {
    static func compute(closes: [Double], volumes: [Double]) -> OBVResult? {
        guard closes.count >= 2, closes.count == volumes.count else { return nil }
        var obv = 0.0
        var series = [obv]
        for i in 1..<closes.count {
            if closes[i] > closes[i - 1] {
                obv += volumes[i]
            } else if closes[i] < closes[i - 1] {
                obv -= volumes[i]
            }
            series.append(obv)
        }
        // Trend: compare OBV now vs 20 periods ago
        let trend: String
        if series.count >= 20 {
            let change = series.last! - series[series.count - 20]
            trend = change > 0 ? "Rising" : (change < 0 ? "Falling" : "Flat")
        } else {
            trend = "N/A"
        }
        // Divergence: price up but OBV down = bearish, price down but OBV up = bullish
        var divergence: String? = nil
        if series.count >= 10 {
            let priceUp = closes.last! > closes[closes.count - 10]
            let obvUp = series.last! > series[series.count - 10]
            if priceUp && !obvUp { divergence = "bearish (price up, OBV down)" }
            if !priceUp && obvUp { divergence = "bullish (price down, OBV up)" }
        }
        return OBVResult(current: obv, trend: trend, divergence: divergence)
    }
}

/// Accumulation/Distribution Line — measures buying vs selling pressure.
enum AccumulationDistribution {
    static func compute(highs: [Double], lows: [Double], closes: [Double], volumes: [Double]) -> ADLineResult? {
        guard closes.count >= 2 else { return nil }
        var adLine = 0.0
        for i in 0..<closes.count {
            let range = highs[i] - lows[i]
            if range > 0 {
                let mfMultiplier = ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range
                adLine += mfMultiplier * volumes[i]
            }
        }
        // Trend over last 20 bars
        var prev20 = 0.0
        let start = max(0, closes.count - 20)
        for i in 0..<start {
            let range = highs[i] - lows[i]
            if range > 0 {
                let mfm = ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range
                prev20 += mfm * volumes[i]
            }
        }
        let trend = adLine > prev20 ? "Accumulation" : "Distribution"
        return ADLineResult(current: adLine.rounded(toPlaces: 0), trend: trend)
    }
}

/// Golden/Death Cross detection on 50/200 SMA.
enum SMACross {
    static func detect(closes: [Double]) -> SMACrossResult? {
        guard closes.count >= 201 else { return nil }
        let sma50Now = closes.suffix(50).reduce(0, +) / 50.0
        let sma200Now = closes.suffix(200).reduce(0, +) / 200.0
        let sma50Prev = closes.dropLast().suffix(50).reduce(0, +) / 50.0
        let sma200Prev = closes.dropLast().suffix(200).reduce(0, +) / 200.0

        var cross: String? = nil
        if sma50Prev <= sma200Prev && sma50Now > sma200Now {
            cross = "Golden Cross (bullish)"
        } else if sma50Prev >= sma200Prev && sma50Now < sma200Now {
            cross = "Death Cross (bearish)"
        }

        let status = sma50Now > sma200Now ? "50 > 200 (bullish)" : "50 < 200 (bearish)"
        return SMACrossResult(sma50: sma50Now.rounded(toPlaces: 2), sma200: sma200Now.rounded(toPlaces: 2), status: status, recentCross: cross)
    }
}

/// Gap analysis — detects opening gaps from previous close.
enum GapAnalysis {
    static func detect(opens: [Double], closes: [Double]) -> GapResult? {
        guard opens.count >= 2, closes.count >= 2 else { return nil }
        let prevClose = closes[closes.count - 2]
        guard prevClose > 0 else { return nil }
        let todayOpen = opens[opens.count - 1]
        guard let current = closes.last else { return nil }
        let gapPercent = ((todayOpen - prevClose) / prevClose) * 100.0

        guard abs(gapPercent) > 0.3 else { return nil } // Ignore tiny gaps

        let direction = gapPercent > 0 ? "Gap Up" : "Gap Down"
        // Gap filled if price crossed back through previous close
        let filled: Bool
        if gapPercent > 0 {
            filled = current <= prevClose
        } else {
            filled = current >= prevClose
        }
        return GapResult(
            direction: direction,
            gapPercent: gapPercent.rounded(toPlaces: 2),
            previousClose: prevClose.rounded(toPlaces: 2),
            openPrice: todayOpen.rounded(toPlaces: 2),
            filled: filled
        )
    }
}

/// Average Daily Dollar Volume — liquidity measure.
enum ADDV {
    static func compute(closes: [Double], volumes: [Double], period: Int = 20) -> ADDVResult? {
        guard closes.count >= period, volumes.count >= period else { return nil }
        var dollarVols = [Double]()
        for i in (closes.count - period)..<closes.count {
            dollarVols.append(closes[i] * volumes[i])
        }
        let avg = dollarVols.reduce(0, +) / Double(period)
        let liquidity: String
        if avg >= 500_000_000 { liquidity = "Very High" }
        else if avg >= 100_000_000 { liquidity = "High" }
        else if avg >= 20_000_000 { liquidity = "Moderate" }
        else if avg >= 2_000_000 { liquidity = "Low" }
        else { liquidity = "Very Low" }
        return ADDVResult(averageDollarVolume: avg, liquidity: liquidity)
    }
}
