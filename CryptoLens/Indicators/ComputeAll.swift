import Foundation

enum IndicatorEngine {
    static func computeAll(candles: [Candle], timeframe: String, label: String, market: Market = .crypto) -> IndicatorResult {
        let closes = candles.map(\.close)
        let highs = candles.map(\.high)
        let lows = candles.map(\.low)
        let opens = candles.map(\.open)
        let volumes = candles.map(\.volume)
        let current = closes.last ?? 0

        // Common indicators
        let rsi = RSI.compute(closes: closes)
        let rsiSeries = RSI.computeSeries(closes: closes)
        let validRSI = rsiSeries.compactMap { $0 }
        let divergence: String? = validRSI.count >= 50
            ? RSIDivergence.detect(closes: Array(closes.suffix(50)), rsiValues: Array(validRSI.suffix(50)))
            : nil
        let macd = MACD.compute(closes: closes)
        let bb = BollingerBands.compute(closes: closes)
        let atr = ATR.compute(highs: highs, lows: lows, closes: closes)
        let stochRSI = StochasticRSI.compute(closes: closes)
        let adx = ADX.compute(highs: highs, lows: lows, closes: closes)
        let vwap = VWAP.compute(highs: highs, lows: lows, closes: closes, volumes: volumes)
        let fib = Fibonacci.compute(highs: highs, lows: lows, closes: closes)
        let sr = SupportResistance.find(highs: highs, lows: lows, closes: closes)
        let patterns = CandlePatterns.detect(opens: opens, highs: highs, lows: lows, closes: closes)

        // Moving averages
        let ema20List = MovingAverages.computeEMA(values: closes, period: 20)
        let ema50List = MovingAverages.computeEMA(values: closes, period: 50)
        let ema200List = MovingAverages.computeEMA(values: closes, period: 200)
        let ema20 = ema20List.last.map { $0.rounded(toPlaces: 2) }
        let ema50 = ema50List.last.map { $0.rounded(toPlaces: 2) }
        let ema200 = ema200List.last.map { $0.rounded(toPlaces: 2) }
        let sma50 = MovingAverages.computeSMA(values: closes, period: 50).map { $0.rounded(toPlaces: 2) }
        let sma200 = MovingAverages.computeSMA(values: closes, period: 200).map { $0.rounded(toPlaces: 2) }

        // Volume ratio
        let avgVol: Double? = volumes.count >= 20 ? volumes.suffix(20).reduce(0, +) / 20.0 : nil
        let volRatio: Double? = avgVol.map { (volumes.last! / $0).rounded(toPlaces: 2) }

        // Stock-only indicators
        var obv: OBVResult? = nil
        var adLine: ADLineResult? = nil
        var smaCross: SMACrossResult? = nil
        var gap: GapResult? = nil
        var addv: ADDVResult? = nil

        if market == .stock {
            obv = OBV.compute(closes: closes, volumes: volumes)
            adLine = AccumulationDistribution.compute(highs: highs, lows: lows, closes: closes, volumes: volumes)
            smaCross = SMACross.detect(closes: closes)
            gap = GapAnalysis.detect(opens: opens, closes: closes)
            addv = ADDV.compute(closes: closes, volumes: volumes)
        }

        // Composite bias score
        var bullish = 0
        var bearish = 0
        if let e20 = ema20, let e50 = ema50, let e200 = ema200 {
            if e20 > e50 && e50 > e200 { bullish += 2 }
            else if e20 < e50 && e50 < e200 { bearish += 2 }
            if current > e200 { bullish += 1 } else { bearish += 1 }
        }
        if let r = rsi {
            if r > 50 { bullish += 1 } else { bearish += 1 }
        }
        if let m = macd {
            if m.histogram > 0 { bullish += 1 } else { bearish += 1 }
        }
        if let a = adx {
            if a.direction == "Bullish" { bullish += 1 } else { bearish += 1 }
        }
        // Stock-only bias signals
        if market == .stock {
            if let o = obv, o.trend == "Rising" { bullish += 1 } else if obv?.trend == "Falling" { bearish += 1 }
            if let ad = adLine, ad.trend == "Accumulation" { bullish += 1 } else if adLine?.trend == "Distribution" { bearish += 1 }
        }

        let total = bullish + bearish
        let bullPct = total > 0 ? (Double(bullish) / Double(total)) * 100.0 : 50.0
        let bias: String
        if bullPct >= 75 { bias = "Strong Bullish" }
        else if bullPct >= 60 { bias = "Bullish" }
        else if bullPct <= 25 { bias = "Strong Bearish" }
        else if bullPct <= 40 { bias = "Bearish" }
        else { bias = "Neutral" }

        return IndicatorResult(
            timeframe: timeframe,
            label: label,
            price: current,
            rsi: rsi,
            stochRSI: stochRSI,
            macd: macd,
            adx: adx,
            bollingerBands: bb,
            atr: atr,
            ema20: ema20,
            ema50: ema50,
            ema200: ema200,
            sma50: sma50,
            sma200: sma200,
            vwap: vwap,
            fibonacci: fib,
            supportResistance: sr,
            candlePatterns: patterns,
            volumeRatio: volRatio,
            divergence: divergence,
            bias: bias,
            bullPercent: bullPct.rounded(toPlaces: 1),
            obv: obv,
            adLine: adLine,
            smaCross: smaCross,
            gap: gap,
            addv: addv
        )
    }
}
