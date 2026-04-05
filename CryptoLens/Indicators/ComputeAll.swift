import Foundation

enum IndicatorEngine {
    static func computeAll(candles: [Candle], timeframe: String, label: String, market: Market = .crypto) -> IndicatorResult {
        let closes = candles.map(\.close)
        let highs = candles.map(\.high)
        let lows = candles.map(\.low)
        let opens = candles.map(\.open)
        let volumes = candles.map(\.volume)
        let current = closes.last ?? 0

        // Common indicators (compute series once, derive scalar from last value)
        let rsiSeries = RSI.computeSeries(closes: closes)
        let validRSI = rsiSeries.compactMap { $0 }
        let rsi = validRSI.last
        let divergence: String? = validRSI.count >= 50
            ? RSIDivergence.detect(closes: Array(closes.suffix(50)), rsiValues: Array(validRSI.suffix(50)))
            : nil
        let macd = MACD.compute(closes: closes)
        let bb = BollingerBands.compute(closes: closes)
        let atr = ATR.compute(highs: highs, lows: lows, closes: closes)
        // StochRSI: computed once via computeFull, scalar derived from last values
        let stochRSIFull = StochasticRSI.computeFull(closes: closes)
        let adxFull = ADX.computeFull(highs: highs, lows: lows, closes: closes)
        let adx = adxFull?.result
        // Session-anchored VWAP based on timeframe
        let vwapSessionCandles: Int?
        if label.contains("1H") || label.contains("15m") {
            vwapSessionCandles = 24
        } else if label.contains("4H") {
            vwapSessionCandles = 6
        } else if label.contains("Daily") || label.contains("1D") {
            vwapSessionCandles = 20
        } else {
            vwapSessionCandles = nil
        }
        let vwap = VWAP.compute(highs: highs, lows: lows, closes: closes, volumes: volumes, sessionCandles: vwapSessionCandles)
        let fib = Fibonacci.compute(highs: highs, lows: lows, closes: closes)
        let sr = SupportResistance.find(highs: highs, lows: lows, closes: closes, atr: atr?.atr ?? 0)
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
        let volRatio: Double? = avgVol.flatMap { avg in volumes.last.map { ($0 / avg).rounded(toPlaces: 2) } }

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

        // Composite bias score (magnitude-weighted)
        var bullish = 0
        var bearish = 0
        if let e20 = ema20, let e50 = ema50, let e200 = ema200 {
            if e20 > e50 && e50 > e200 { bullish += 2 }
            else if e20 < e50 && e50 < e200 { bearish += 2 }
            if current > e200 { bullish += 1 } else { bearish += 1 }
        }
        if let r = rsi {
            // Scale by distance from 50 — RSI 75 scores more than RSI 51
            if r > 70 { bullish += 2 }
            else if r > 55 { bullish += 1 }
            else if r < 30 { bearish += 2 }
            else if r < 45 { bearish += 1 }
            // 45-55 = neutral, no score
        }
        if let m = macd {
            // Fresh crossover scores higher
            if m.histogram > 0 {
                bullish += m.crossover == "bullish" ? 2 : 1
            } else {
                bearish += m.crossover == "bearish" ? 2 : 1
            }
        }
        if let a = adx {
            // Only score direction if trend is meaningful (ADX > 20)
            if a.adx >= 20 {
                if a.direction == "Bullish" { bullish += 1 } else { bearish += 1 }
            }
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

        // Compute ATR percentile BEFORE truncation (needs full candle history)
        let atrPercentileResult = VolatilityRegime.atrPercentile(candles: candles)

        // Retain last 50 candles for chart display
        let chartCandles = Array(candles.suffix(50))

        // Series data aligned with chart candles (last 50)
        let rsiSeriesData = Array(validRSI.suffix(50))
        let stochSeries = (k: Array(stochRSIFull.kValues.suffix(50)), d: Array(stochRSIFull.dValues.suffix(50)))
        let macdHistSeriesData = MACD.computeHistSeries(closes: closes, count: 50)

        // Full MACD line + signal series
        let macdFull = MACD.computeFullSeries(closes: closes, count: 50)

        // ADX + DI series
        let adxSeriesData = adxFull.map { Array($0.adxSeries.suffix(50)) } ?? []
        let plusDISeriesData = adxFull.map { Array($0.plusDISeries.suffix(50)) } ?? []
        let minusDISeriesData = adxFull.map { Array($0.minusDISeries.suffix(50)) } ?? []

        // Volume ratio series (each bar's volume / 20-period avg)
        var volRatioSeries = [Double]()
        if volumes.count >= 20 {
            for i in 19..<volumes.count {
                let avg = volumes[(i - 19)...i].reduce(0, +) / 20.0
                volRatioSeries.append(avg > 0 ? volumes[i] / avg : 1.0)
            }
            volRatioSeries = Array(volRatioSeries.suffix(50))
        }

        // EMA series aligned with chart candles (last 50)
        let ema20SeriesData = Array(ema20List.suffix(50))
        let ema50SeriesData = Array(ema50List.suffix(50))
        let ema200SeriesData = Array(ema200List.suffix(50))

        // Volume profile (POC, VAH, VAL) — only for Daily and 4H (1H sample too thin)
        let volProfile: VolumeProfileResult?
        if let atrVal = atr, (timeframe == "1d" || timeframe == "4h" || timeframe == "D") {
            volProfile = VolumeProfile.compute(candles: Array(candles.suffix(30)), atr: atrVal.atr)
        } else {
            volProfile = nil
        }

        var result = IndicatorResult(
            timeframe: timeframe,
            label: label,
            price: current,
            rsi: rsi,
            stochRSI: stochRSIFull.result,
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
            addv: addv,
            candles: chartCandles,
            rsiSeries: rsiSeriesData,
            stochKSeries: stochSeries.k,
            stochDSeries: stochSeries.d,
            macdHistSeries: macdHistSeriesData,
            macdLineSeries: macdFull.macdLine,
            macdSignalSeries: macdFull.signalLine,
            adxSeries: adxSeriesData,
            plusDISeries: plusDISeriesData,
            minusDISeries: minusDISeriesData,
            volumeRatioSeries: volRatioSeries,
            ema20Series: ema20SeriesData,
            ema50Series: ema50SeriesData,
            ema200Series: ema200SeriesData,
            atrPercentile: atrPercentileResult?.percentile,
            atrPercentileLabel: atrPercentileResult?.label
        )
        result.volumeProfile = volProfile
        return result
    }
}
