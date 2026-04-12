import Foundation

/// Trade simulation result for one bar.
struct TradeSimOutcome: Codable {
    let entryPrice: Double
    let stopPrice: Double
    let tp1Price: Double
    let tp2Price: Double
    let riskAmount: Double
    let outcome: String        // "TP1", "TP2", "STOPPED", "EXPIRED"
    let barsToOutcome: Int
    let maxFavorable: Double
    let maxAdverse: Double
    let pnlPercent: Double
}

/// Stored per-bar so the sweep can re-simulate without refetching.
struct TradeEntryContext: Codable {
    let price: Double
    let isBullish: Bool
    let atr: Double
    let oneHStartIdx: Int
}

/// Sweep result for one stop/target configuration.
struct SweepResult: Codable, Identifiable {
    var id: String { label }
    let label: String
    let stopDesc: String
    let tp1Desc: String
    let tp2Desc: String
    let totalTrades: Int
    let tp1Wins: Int
    let tp2Wins: Int
    let stopped: Int
    let expired: Int
    let winRate: Double
    let resolvedWinRate: Double   // wins / (wins + stopped) — excludes expired
    let expectancy: Double
    let avgBarsToOutcome: Double
}

/// A single evaluation point in the backtest.
/// ML feature snapshot extracted at each backtest bar.
struct MLFeatures: Codable {
    // Daily core
    let dRsi: Double; let dMacdHist: Double; let dAdx: Double; let dAdxBullish: Bool
    let dEmaCross: Int; let dStackBull: Bool; let dStackBear: Bool
    let dStructBull: Bool; let dStructBear: Bool
    // Daily momentum
    let dStochK: Double; let dStochCross: Int; let dMacdCross: Int
    let dDivergence: Int; let dEma20Rising: Bool
    // Daily volatility/volume
    let dBBPercentB: Double; let dBBSqueeze: Bool; let dBBBandwidth: Double
    let dVolumeRatio: Double; let dAboveVwap: Bool
    // 4H core
    let hRsi: Double; let hMacdHist: Double; let hAdx: Double; let hAdxBullish: Bool
    let hEmaCross: Int; let hStackBull: Bool; let hStackBear: Bool
    let hStructBull: Bool; let hStructBear: Bool
    // 4H momentum
    let hStochK: Double; let hStochCross: Int; let hMacdCross: Int
    let hDivergence: Int; let hEma20Rising: Bool
    // 4H volatility/volume
    let hBBPercentB: Double; let hBBSqueeze: Bool; let hBBBandwidth: Double
    let hVolumeRatio: Double; let hAboveVwap: Bool
    // 1H entry
    let eRsi: Double; let eEmaCross: Int; let eStochK: Double; let eMacdHist: Double
    // Derivatives (crypto only, 0 for stocks)
    let fundingSignal: Int; let oiSignal: Int; let takerSignal: Int
    let crowdingSignal: Int; let derivativesCombined: Int
    // Derivatives raw continuous values (crypto only, 0 for stocks)
    let fundingRateRaw: Double    // actual funding rate %
    let oiChangePct: Double       // OI change % vs previous 4H bar
    let takerRatioRaw: Double     // raw taker buy/sell ratio
    let longPctRaw: Double        // raw long account %
    // Macro/cross-asset
    let vix: Double; let dxyAboveEma20: Bool; let volScalar: Double
    // Candle patterns
    let last3Green: Bool; let last3Red: Bool; let last3VolIncreasing: Bool
    // Stock-only (false for crypto)
    let obvRising: Bool; let adLineAccumulation: Bool
    // Context
    let atrPercent: Double; let atrPercentile: Double
    let isCrypto: Bool
    // Cross-timeframe interactions
    let tfAlignment: Int          // +2 all bull, -2 all bear, 0 mixed
    let momentumAlignment: Int    // D+4H MACD same sign: +1 bull, -1 bear, 0 mixed
    let structureAlignment: Int   // D+4H struct same: +1 bull, -1 bear, 0 mixed
    let scoreSum: Int             // dailyScore + fourHScore + oneHScore
    let scoreDivergence: Int      // abs(dailyScore - fourHScore)
    // Temporal features
    let dayOfWeek: Int            // 1=Mon ... 5=Fri (0=weekend for crypto)
    let barsSinceRegimeChange: Int // how many 4H bars in current regime
    let regimeCode: Int           // TRENDING=2, TRANSITIONING=1, RANGING=0
    // Rate-of-change (delta over 6 bars)
    let dRsiDelta: Double         // daily RSI change over ~6 4H bars (1 day)
    let dAdxDelta: Double         // daily ADX change
    let hRsiDelta: Double         // 4H RSI change over 6 bars
    let hAdxDelta: Double         // 4H ADX change
    let hMacdHistDelta: Double    // 4H MACD histogram change
    // Sentiment (crypto only, 50/0 for stocks)
    let fearGreedIndex: Double    // 0-100, daily
    let fearGreedZone: Int        // -2=extreme fear .. +2=extreme greed
    // Cross-asset crypto
    let ethBtcRatio: Double       // ETH/BTC price ratio
    let ethBtcDelta6: Double      // ETH/BTC change over 6 bars
}

struct BacktestDataPoint: Codable {
    let timestamp: Date
    let price: Double
    let dailyScore: Int
    let dailyBias: String
    let fourHScore: Int
    let fourHBias: String
    let oneHScore: Int
    let oneHBias: String
    let biasAlignment: String
    let regime: String
    let emaRegime: String
    let volScalar: Double
    let atrPercentile: Double
    var priceAfter4H: Double?
    var priceAfter3x4H: Double?
    var priceAfter6x4H: Double?
    var maxFavorable24H: Double?
    var maxAdverse24H: Double?
    var tradeResult: TradeSimOutcome?
    var entryContext: TradeEntryContext?
    var mlFeatures: MLFeatures?
    // Continuous forward returns (direction-independent, for every bar)
    var fwdReturn4H: Double?      // % return after 1x4H bar
    var fwdReturn12H: Double?     // % return after 3x4H bars
    var fwdReturn24H: Double?     // % return after 6x4H bars
    var fwdMaxUp24H: Double?      // max upward move in 24H as % of price
    var fwdMaxDown24H: Double?    // max downward move in 24H as % of price
    var fwdMaxFavR: Double?       // max favorable excursion in ATR multiples

    var directionCorrect4H: Bool? {
        guard let future = priceAfter4H else { return nil }
        if biasAlignment.contains("bearish") { return future < price }
        if biasAlignment.contains("bullish") { return future > price }
        return nil
    }

    var directionCorrect24H: Bool? {
        guard let future = priceAfter6x4H else { return nil }
        if biasAlignment.contains("bearish") { return future < price }
        if biasAlignment.contains("bullish") { return future > price }
        return nil
    }

    /// Did price move > 1% in the labeled direction at ANY point in 48H?
    /// Measures "did a tradeable setup exist?" not "did the candle close confirm?"
    var opportunityHit: Bool? {
        guard let maxFav = maxFavorable24H, price > 0 else { return nil }
        guard biasAlignment.contains("bearish") || biasAlignment.contains("bullish") else { return nil }
        return (maxFav / price) * 100 > 1.0
    }
}

/// Aggregate results from a backtest run.
struct BacktestSummary: Codable {
    let symbol: String
    let startDate: Date
    let endDate: Date
    let totalBars: Int
    let evaluatedBars: Int
    let accuracy4H: Double
    let accuracy24H: Double
    let bearishAccuracy: Double
    let bullishAccuracy: Double
    let strongAccuracy: Double
    let moderateAccuracy: Double
    let weakAccuracy: Double
    let trendingAccuracy: Double
    let rangingAccuracy: Double
    let transitioningAccuracy: Double
    let adaptiveAccuracy: Double
    let staticAccuracy: Double
    let totalFlats: Int
    let correctFlats: Int
    let falseFlats: Int
    let flatAccuracy: Double
    let opportunityRate: Double       // % of directional labels where price moved >1% in direction
    let bullishOpportunity: Double
    let bearishOpportunity: Double
    // Trade simulation
    let totalTrades: Int
    let tp1Wins: Int
    let tp2Wins: Int
    let stopped: Int
    let expired: Int
    let tradeWinRate: Double
    let avgPnlPercent: Double
    let expectancy: Double
    let avgBarsToOutcome: Double
    let trendingWinRate: Double
    let rangingWinRate: Double
    let transitioningWinRate: Double
    let strongWinRate: Double
    let moderateWinRate: Double
    let weakWinRate: Double

    var sweepResults: [SweepResult]
    let thresholdSweep: [ThresholdResult]
    let scoreDistribution: [ScoreBucket]
}

/// Accuracy at each Daily score level.
struct ScoreBucket: Codable, Identifiable {
    var id: Int { score }
    let score: Int             // e.g. -8, -7, ... 0, ... +7, +8
    let count: Int             // how many bars had this score
    let correct24H: Int        // how many were directionally correct at 24H
    let accuracy: Double       // correct / count * 100
    let opportunity: Double    // % where price moved >1% in direction within 48H
    let avgMove: Double        // average % price move in 24H for this score
}

struct ThresholdResult: Codable, Identifiable {
    var id: String { "\(directionalThreshold)-\(strongThreshold)" }
    let directionalThreshold: Int
    let strongThreshold: Int
    let accuracy4H: Double
    let accuracy24H: Double
    let totalDirectional: Int
    let tradeFrequency: Double
}
