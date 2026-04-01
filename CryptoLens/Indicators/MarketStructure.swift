import Foundation

/// Pre-computed market structure labels and swing point analysis.
/// Gives the LLM explicit HH/HL/LL/LH labels instead of making it derive from candles.

struct SwingPoint {
    let price: Double
    let isHigh: Bool
    let index: Int
    let testCount: Int
    let lastTestIndex: Int
}

struct MarketStructureResult {
    let label: String           // "HH/HL (bullish)", "LL/LH (bearish)", "HH/LL (expanding)", "Range"
    let swingHighs: [Double]    // Last 2-3 swing highs (newest first)
    let swingLows: [Double]     // Last 2-3 swing lows (newest first)
    let levelTests: [(price: Double, tests: Int, candlesAgo: Int)]  // S/R with test count + recency
}

enum MarketStructure {

    /// Identify swing highs/lows using N-bar pivot.
    /// `atr` used for level clustering — adapts to asset volatility.
    static func analyze(candles: [Candle], lookback: Int = 3, atr: Double = 0) -> MarketStructureResult? {
        guard candles.count >= lookback * 2 + 5 else { return nil }

        var swingHighs = [SwingPoint]()
        var swingLows = [SwingPoint]()

        for i in lookback..<(candles.count - lookback) {
            let current = candles[i]

            // Swing high: higher than N bars on each side
            var isSwingHigh = true
            for j in (i - lookback)..<i {
                if candles[j].high >= current.high { isSwingHigh = false; break }
            }
            if isSwingHigh {
                for j in (i + 1)...(i + lookback) {
                    if candles[j].high >= current.high { isSwingHigh = false; break }
                }
            }

            // Swing low: lower than N bars on each side
            var isSwingLow = true
            for j in (i - lookback)..<i {
                if candles[j].low <= current.low { isSwingLow = false; break }
            }
            if isSwingLow {
                for j in (i + 1)...(i + lookback) {
                    if candles[j].low <= current.low { isSwingLow = false; break }
                }
            }

            if isSwingHigh {
                swingHighs.append(SwingPoint(price: current.high, isHigh: true, index: i, testCount: 1, lastTestIndex: i))
            }
            if isSwingLow {
                swingLows.append(SwingPoint(price: current.low, isHigh: false, index: i, testCount: 1, lastTestIndex: i))
            }
        }

        guard swingHighs.count >= 2, swingLows.count >= 2 else {
            return MarketStructureResult(label: "Insufficient swings", swingHighs: [], swingLows: [], levelTests: [])
        }

        // Compare last 2 swing highs and lows for structure label
        let lastHighs = swingHighs.suffix(2)
        let lastLows = swingLows.suffix(2)
        let h1 = lastHighs.first!.price  // Older
        let h2 = lastHighs.last!.price   // Newer
        let l1 = lastLows.first!.price
        let l2 = lastLows.last!.price

        let higherHigh = h2 > h1
        let higherLow = l2 > l1
        let lowerHigh = h2 < h1
        let lowerLow = l2 < l1

        let label: String
        if higherHigh && higherLow { label = "HH/HL (bullish)" }
        else if lowerLow && lowerHigh { label = "LL/LH (bearish)" }
        else if higherHigh && lowerLow { label = "HH/LL (expanding)" }
        else if lowerHigh && higherLow { label = "LH/HL (contracting)" }
        else { label = "Range" }

        // Count tests per level (within ATR proximity)
        let allSwings = swingHighs + swingLows
        let totalCandles = candles.count
        var levelTests = [(price: Double, tests: Int, candlesAgo: Int)]()

        // Group nearby swings into levels
        var processedPrices = Set<Int>()
        for swing in allSwings.sorted(by: { $0.price > $1.price }) {
            let bucket = Int(swing.price * 100)  // Group within $0.01
            if processedPrices.contains(bucket) { continue }

            let pctThreshold = swing.price * 0.003
            let atrThreshold = atr > 0 ? atr * 0.1 : pctThreshold
            let threshold = min(pctThreshold, atrThreshold)  // Adapts to volatility
            let nearbySwings = allSwings.filter { abs($0.price - swing.price) < threshold }
            let tests = nearbySwings.count
            let mostRecent = nearbySwings.map(\.index).max() ?? 0
            let candlesAgo = totalCandles - 1 - mostRecent

            if tests >= 1 {
                levelTests.append((swing.price, tests, candlesAgo))
                for ns in nearbySwings { processedPrices.insert(Int(ns.price * 100)) }
            }
        }

        // Sort by test count descending, keep top 5
        levelTests.sort { $0.tests > $1.tests }
        levelTests = Array(levelTests.prefix(5))

        return MarketStructureResult(
            label: label,
            swingHighs: swingHighs.suffix(3).reversed().map(\.price),
            swingLows: swingLows.suffix(3).reversed().map(\.price),
            levelTests: levelTests
        )
    }
}

/// Volatility regime: ATR percentile over last 30 periods.
enum VolatilityRegime {
    static func atrPercentile(candles: [Candle], period: Int = 14) -> (percentile: Double, label: String)? {
        guard candles.count >= period + 30 else { return nil }

        // Compute ATR for each of the last 30 periods
        var atrs = [Double]()
        for i in period..<candles.count {
            let window = Array(candles[(i - period)...i])
            var sum = 0.0
            for j in 1..<window.count {
                let tr = max(window[j].high - window[j].low,
                             abs(window[j].high - window[j - 1].close),
                             abs(window[j].low - window[j - 1].close))
                sum += tr
            }
            atrs.append(sum / Double(period))
        }

        guard let currentATR = atrs.last else { return nil }
        let sorted = atrs.sorted()
        let rank = sorted.firstIndex(where: { $0 >= currentATR }) ?? sorted.count
        let percentile = (Double(rank) / Double(sorted.count)) * 100

        let label: String
        if percentile < 20 { label = "contracting — breakout likely" }
        else if percentile > 80 { label = "expanded — mean reversion likely" }
        else { label = "normal" }

        return (percentile.rounded(), label)
    }
}

/// Multi-timeframe momentum alignment score (-9 to +9).
enum MomentumAlignment {
    static func compute(indicators: [IndicatorResult]) -> (score: Int, label: String) {
        var score = 0
        for ind in indicators {
            // RSI
            if let rsi = ind.rsi {
                if rsi > 55 { score += 1 } else if rsi < 45 { score -= 1 }
            }
            // MACD histogram
            if let macd = ind.macd {
                if macd.histogram > 0 { score += 1 } else if macd.histogram < 0 { score -= 1 }
            }
            // Stoch RSI direction
            if let sr = ind.stochRSI {
                if sr.k > sr.d { score += 1 } else if sr.k < sr.d { score -= 1 }
            }
        }

        let label: String
        if score >= 7 { label = "strong bullish alignment" }
        else if score >= 4 { label = "bullish lean" }
        else if score <= -7 { label = "strong bearish alignment" }
        else if score <= -4 { label = "bearish lean" }
        else { label = "mixed" }

        return (score, label)
    }
}
