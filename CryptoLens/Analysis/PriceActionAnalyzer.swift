import Foundation

// MARK: - Data Structures

struct PriceStructure {
    let regime: String          // "consolidating", "trending_up", "trending_down", "choppy"
    let rangePercent: Double
    let rangeHigh: Double
    let rangeLow: Double
    let candleCount: Int
}

enum ConsolidationShape: String {
    case ascendingLows   = "ascending_lows"
    case descendingHighs = "descending_highs"
    case symmetrical     = "symmetrical"
    case flat            = "flat_range"
}

struct MomentumContext {
    let rsiValue: Double
    let rsiDirection: String
    let rsiSlope: Double

    let stochK: Double
    let stochD: Double
    let stochCrossSignal: String
    let stochCrossAge: Int
    let stochCrossFreshness: String

    let macdHistValue: Double
    let macdHistDirection: String

    let volumeTrend: String
    let volumeRatio: Double
}

struct PatternWithContext {
    let pattern: String
    let position: String
    let level: Double?
    let significance: String
}

struct PriceActionSummary {
    let timeframe: String
    let regime: PriceStructure
    let shape: ConsolidationShape?
    let momentum: MomentumContext
    let patternsWithContext: [PatternWithContext]
    let summaryText: String
}

// MARK: - Analyzer

enum PriceActionAnalyzer {

    static func analyze(indicator: IndicatorResult) -> PriceActionSummary {
        let candles = indicator.candles
        let timeframe = indicator.timeframe

        let period: Int
        switch timeframe {
        case "1h", "15m": period = 8
        case "4h":        period = 6
        case "1d":        period = 5
        default:          period = 8
        }

        let regime = detectRegime(candles: candles, period: period, timeframe: timeframe)
        let shape = regime.regime == "consolidating" ? detectShape(candles: candles) : nil
        let momentum = analyzeMomentum(
            candles: candles,
            rsiValues: indicator.rsiSeries,
            stochK: indicator.stochKSeries,
            stochD: indicator.stochDSeries,
            macdHist: indicator.macdHistSeries
        )
        let patterns = contextualizePatterns(
            indicator: indicator
        )
        let summaryText = buildSummaryText(
            tf: indicator.label,
            structure: regime,
            shape: shape,
            momentum: momentum,
            patterns: patterns
        )

        return PriceActionSummary(
            timeframe: timeframe,
            regime: regime,
            shape: shape,
            momentum: momentum,
            patternsWithContext: patterns,
            summaryText: summaryText
        )
    }

    // MARK: - Regime Detection

    private static func detectRegime(candles: [Candle], period: Int, timeframe: String) -> PriceStructure {
        let recent = Array(candles.suffix(period))
        guard recent.count >= 3 else {
            return PriceStructure(regime: "insufficient_data", rangePercent: 0, rangeHigh: 0, rangeLow: 0, candleCount: recent.count)
        }

        let highs = recent.map(\.high)
        let lows = recent.map(\.low)
        guard let rangeHigh = highs.max(), let rangeLow = lows.min() else {
            return PriceStructure(regime: "insufficient_data", rangePercent: 0, rangeHigh: 0, rangeLow: 0, candleCount: recent.count)
        }
        let range = rangeHigh - rangeLow
        let avgClose = recent.map(\.close).reduce(0, +) / Double(recent.count)
        let rangePercent = avgClose > 0 ? (range / avgClose) * 100 : 0

        let consolidationThreshold: Double
        switch timeframe {
        case "1h", "15m": consolidationThreshold = 2.0
        case "4h":        consolidationThreshold = 3.5
        case "1d":        consolidationThreshold = 5.0
        default:          consolidationThreshold = 2.0
        }

        if rangePercent < consolidationThreshold {
            return PriceStructure(regime: "consolidating", rangePercent: rangePercent.rounded(toPlaces: 1),
                                  rangeHigh: rangeHigh, rangeLow: rangeLow, candleCount: recent.count)
        }

        let closes = recent.map(\.close)
        let hlCount = countHigherLows(recent)
        let lhCount = countLowerHighs(recent)
        guard let lastClose = closes.last, let firstClose = closes.first else {
            return PriceStructure(regime: "choppy", rangePercent: rangePercent.rounded(toPlaces: 1),
                                  rangeHigh: rangeHigh, rangeLow: rangeLow, candleCount: recent.count)
        }
        let isUptrend = lastClose > firstClose && hlCount >= period / 2
        let isDowntrend = lastClose < firstClose && lhCount >= period / 2

        let regime: String
        if isUptrend { regime = "trending_up" }
        else if isDowntrend { regime = "trending_down" }
        else { regime = "choppy" }

        return PriceStructure(regime: regime, rangePercent: rangePercent.rounded(toPlaces: 1),
                              rangeHigh: rangeHigh, rangeLow: rangeLow, candleCount: recent.count)
    }

    private static func countHigherLows(_ candles: [Candle]) -> Int {
        var count = 0
        for i in 1..<candles.count {
            if candles[i].low > candles[i - 1].low { count += 1 }
        }
        return count
    }

    private static func countLowerHighs(_ candles: [Candle]) -> Int {
        var count = 0
        for i in 1..<candles.count {
            if candles[i].high < candles[i - 1].high { count += 1 }
        }
        return count
    }

    // MARK: - Consolidation Shape

    private static func detectShape(candles: [Candle]) -> ConsolidationShape {
        let recent = Array(candles.suffix(5))
        guard recent.count >= 3 else { return .flat }

        let recentLows = recent.map(\.low)
        let recentHighs = recent.map(\.high)

        let lowsRising = zip(recentLows, recentLows.dropFirst()).filter { $0 < $1 }.count >= recentLows.count / 2
        let highsFalling = zip(recentHighs, recentHighs.dropFirst()).filter { $0 > $1 }.count >= recentHighs.count / 2

        if lowsRising && highsFalling { return .symmetrical }
        if lowsRising { return .ascendingLows }
        if highsFalling { return .descendingHighs }
        return .flat
    }

    // MARK: - Momentum Analysis

    private static func analyzeMomentum(candles: [Candle], rsiValues: [Double],
                                         stochK: [Double], stochD: [Double],
                                         macdHist: [Double]) -> MomentumContext {
        // RSI direction
        let recentRSI = Array(rsiValues.suffix(3))
        let rsiSlope: Double
        let rsiDirection: String
        if recentRSI.count >= 2, let rsiLast = recentRSI.last, let rsiFirst = recentRSI.first {
            rsiSlope = rsiLast - rsiFirst
            rsiDirection = abs(rsiSlope) < 2 ? "flat" : (rsiSlope > 0 ? "rising" : "falling")
        } else {
            rsiSlope = 0
            rsiDirection = "unknown"
        }

        // Stoch RSI cross recency
        let kValues = Array(stochK.suffix(10))
        let dValues = Array(stochD.suffix(10))
        var lastCrossAge = -1
        var lastCrossType = "none"
        let pairCount = min(kValues.count, dValues.count)
        if pairCount >= 2 {
            for i in stride(from: pairCount - 1, through: 1, by: -1) {
                let kAboveD = kValues[i] > dValues[i]
                let kBelowDPrev = kValues[i - 1] <= dValues[i - 1]
                let kBelowD = kValues[i] < dValues[i]
                let kAboveDPrev = kValues[i - 1] >= dValues[i - 1]
                if kAboveD && kBelowDPrev {
                    lastCrossAge = pairCount - 1 - i
                    lastCrossType = "bullish_cross"
                    break
                }
                if kBelowD && kAboveDPrev {
                    lastCrossAge = pairCount - 1 - i
                    lastCrossType = "bearish_cross"
                    break
                }
            }
        }
        let freshness: String
        if lastCrossAge < 0 { freshness = "none" }
        else if lastCrossAge <= 2 { freshness = "fresh" }
        else if lastCrossAge <= 5 { freshness = "developing" }
        else { freshness = "stale" }

        // MACD histogram direction
        let recentHist = Array(macdHist.suffix(3))
        let macdHistDirection: String
        if recentHist.count >= 2, let histLast = recentHist.last, let histFirst = recentHist.first {
            if abs(histLast) > abs(histFirst) && histLast > 0 { macdHistDirection = "expanding_bullish" }
            else if abs(histLast) > abs(histFirst) && histLast < 0 { macdHistDirection = "expanding_bearish" }
            else if abs(histLast) < abs(histFirst) { macdHistDirection = "contracting" }
            else { macdHistDirection = "flat" }
        } else {
            macdHistDirection = "unknown"
        }

        // Volume trend
        let volumeTrend: String
        let volRatio: Double
        if candles.count >= 6 {
            let recentVol = candles.suffix(3).map(\.volume).reduce(0, +) / 3
            let priorVol = candles.dropLast(3).suffix(3).map(\.volume).reduce(0, +) / 3
            volRatio = priorVol > 0 ? (recentVol / priorVol).rounded(toPlaces: 1) : 1.0
            volumeTrend = volRatio > 1.2 ? "increasing" : (volRatio < 0.8 ? "decreasing" : "stable")
        } else {
            volRatio = 1.0
            volumeTrend = "unknown"
        }

        return MomentumContext(
            rsiValue: recentRSI.last ?? 0,
            rsiDirection: rsiDirection,
            rsiSlope: rsiSlope.rounded(toPlaces: 1),
            stochK: kValues.last ?? 0,
            stochD: dValues.last ?? 0,
            stochCrossSignal: lastCrossType,
            stochCrossAge: max(lastCrossAge, 0),
            stochCrossFreshness: freshness,
            macdHistValue: recentHist.last ?? 0,
            macdHistDirection: macdHistDirection,
            volumeTrend: volumeTrend,
            volumeRatio: volRatio
        )
    }

    // MARK: - Pattern Context

    private static func contextualizePatterns(indicator: IndicatorResult) -> [PatternWithContext] {
        guard !indicator.candlePatterns.isEmpty else { return [] }
        let price = indicator.price
        let supports = indicator.supportResistance.supports
        let resistances = indicator.supportResistance.resistances
        let ema20 = indicator.ema20 ?? 0
        let atrValue = indicator.atr?.atr ?? (price * 0.01) // fallback: 1% of price

        let threshold = atrValue * 0.3

        return indicator.candlePatterns.map { pattern in
            for s in supports {
                if abs(price - s) < threshold {
                    return PatternWithContext(pattern: pattern.pattern, position: "at_support",
                                             level: s, significance: "high")
                }
            }
            for r in resistances {
                if abs(price - r) < threshold {
                    return PatternWithContext(pattern: pattern.pattern, position: "at_resistance",
                                             level: r, significance: "high")
                }
            }
            if ema20 > 0 && abs(price - ema20) < threshold {
                return PatternWithContext(pattern: pattern.pattern, position: "at_ema20",
                                         level: ema20, significance: "moderate")
            }
            return PatternWithContext(pattern: pattern.pattern, position: "in_space",
                                     level: nil, significance: "low")
        }
    }

    // MARK: - Summary Text Builder

    private static func buildSummaryText(tf: String, structure: PriceStructure,
                                          shape: ConsolidationShape?,
                                          momentum: MomentumContext,
                                          patterns: [PatternWithContext]) -> String {
        var lines = [String]()

        // Regime line
        var regimeLine = "\(tf): \(structure.regime), \(String(format: "%.1f", structure.rangePercent))% range"
        regimeLine += " (\(Formatters.formatPrice(structure.rangeLow))-\(Formatters.formatPrice(structure.rangeHigh)))"
        regimeLine += ", \(structure.candleCount) candles"
        if let shape = shape {
            regimeLine += ", shape: \(shape.rawValue)"
        }
        lines.append(regimeLine)

        // Momentum line
        var mom = "Momentum: RSI \(String(format: "%.1f", momentum.rsiValue)) \(momentum.rsiDirection)"
        mom += ", Stoch RSI \(String(format: "%.0f", momentum.stochK))/\(String(format: "%.0f", momentum.stochD))"
        if momentum.stochCrossSignal != "none" {
            mom += " (\(momentum.stochCrossSignal) \(momentum.stochCrossAge) candles ago — \(momentum.stochCrossFreshness))"
        }
        mom += ", MACD hist \(momentum.macdHistDirection)"
        mom += ", Volume \(momentum.volumeTrend) (\(String(format: "%.1f", momentum.volumeRatio))x)"
        lines.append(mom)

        // Patterns with context (only high/moderate significance)
        let meaningful = patterns.filter { $0.significance != "low" }
        if !meaningful.isEmpty {
            let patternStrings = meaningful.map { p in
                if let level = p.level {
                    return "\(p.pattern) \(p.position) (\(Formatters.formatPrice(level)))"
                }
                return "\(p.pattern) \(p.position)"
            }
            lines.append("Patterns: \(patternStrings.joined(separator: ", "))")
        }

        return lines.joined(separator: "\n")
    }
}
