import Foundation

enum IndicatorEngine {
    static func computeAll(candles: [Candle], timeframe: String, label: String, market: Market = .crypto, crossAsset: CrossAssetContext? = nil) -> IndicatorResult {
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
        let sr = SupportResistance.find(highs: highs, lows: lows, closes: closes, atr: atr?.atr ?? 0)

        // MarketStructure computed BEFORE Fibonacci (fibs use swing points)
        let marketStructure = MarketStructure.analyze(candles: candles, atr: atr?.atr ?? 0)

        // Fibonacci: prefer swing-based, fall back to absolute high/low
        let fib: FibResult?
        if let ms = marketStructure, !ms.swingHighs.isEmpty, !ms.swingLows.isEmpty {
            fib = Fibonacci.computeFromSwings(swingHighs: ms.swingHighs, swingLows: ms.swingLows, closes: closes, structureLabel: ms.label)
        } else {
            fib = Fibonacci.compute(highs: highs, lows: lows, closes: closes)
        }
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

        // ── EMA Regime Classification ──
        // Determines trend structure BEFORE scoring. Used by RSI, MACD, momentum override, and final gate.
        enum EMARegime { case bullish, bearish, mixed }
        let emaRegime: EMARegime
        if let e20 = ema20, let e50 = ema50, let e200 = ema200 {
            if e20 > e50 && e50 > e200 { emaRegime = .bullish }
            else if e20 < e50 && e50 < e200 { emaRegime = .bearish }
            else { emaRegime = .mixed }
        } else {
            emaRegime = .mixed
        }
        let priceAboveAll = ema20 != nil && ema50 != nil && ema200 != nil
            && current > ema20! && current > ema50! && current > ema200!
        let priceBelowAll = ema20 != nil && ema50 != nil && ema200 != nil
            && current < ema20! && current < ema50! && current < ema200!

        // ── Volatility Scalar ──
        // Scales label thresholds: low vol → easier triggers, high vol → more conviction needed.
        // Linear from 0.75 (ATR pct 0%) to 1.35 (ATR pct 100%).
        let rawAtrPercentile: Double
        if candles.count >= 44 {
            var atrs = [Double]()
            for i in 14..<candles.count {
                let window = Array(candles[(i - 14)...i])
                var sum = 0.0
                for j in 1..<window.count {
                    let tr = max(window[j].high - window[j].low,
                                 abs(window[j].high - window[j - 1].close),
                                 abs(window[j].low - window[j - 1].close))
                    sum += tr
                }
                atrs.append(sum / 14.0)
            }
            if let currentATR = atrs.last {
                let sorted = atrs.sorted()
                let rank = sorted.firstIndex(where: { $0 >= currentATR }) ?? sorted.count
                rawAtrPercentile = (Double(rank) / Double(sorted.count)) * 100
            } else { rawAtrPercentile = 50 }
        } else { rawAtrPercentile = 50 }
        let volScalar = max(0.75, min(1.35, 0.75 + (rawAtrPercentile / 100.0) * 0.6))

        // ── Signed Bias Score ──
        var score = 0
        let isDaily = label.contains("Daily") || label.contains("1D")
        let is4H = label.contains("4H")
        // ── Layer 1: Structure (EMA stack + price position) ──
        if let e20 = ema20, let e50 = ema50, let e200 = ema200 {
            if e20 > e50 && e50 > e200 { score += 2 }
            else if e20 < e50 && e50 < e200 { score -= 2 }
            else if e20 > e50 { score += 1 }
            else if e20 < e50 { score -= 1 }
            if current > e200 { score += 1 } else { score -= 1 }
        }

        // ── Layer 1b: Market Structure (HH/HL vs LL/LH) ──
        if let ms = marketStructure {
            if ms.label.contains("bullish") { score += 2 }
            else if ms.label.contains("bearish") { score -= 2 }
        }

        // ── Layer 2: Trend Strength (ADX magnitude + direction) ──
        if let a = adx {
            if a.adx >= 40 {
                score += a.direction == "Bullish" ? 3 : -3
            } else if a.adx >= 30 {
                score += a.direction == "Bullish" ? 2 : -2
            } else if a.adx >= 20 {
                score += a.direction == "Bullish" ? 1 : -1
            }
        }

        // ── Layer 3: Momentum (RSI + MACD, regime-aware) ──
        if let r = rsi {
            switch emaRegime {
            case .bullish:
                if r < 40 { score += 2 }
                else if r < 50 { score += 1 }
            case .bearish:
                if r > 60 { score -= 2 }
                else if r > 50 { score -= 1 }
            case .mixed:
                // Dead zone widens in high vol, narrows in low vol
                let rsiOB = min(75.0, 70.0 + (volScalar - 1.0) * 15)
                let rsiBull = min(60.0, 55.0 + (volScalar - 1.0) * 15)
                let rsiOS = max(25.0, 30.0 - (volScalar - 1.0) * 15)
                let rsiBear = max(40.0, 45.0 - (volScalar - 1.0) * 15)
                if r > rsiOB { score += 2 }
                else if r > rsiBull { score += 1 }
                else if r < rsiOS { score -= 2 }
                else if r < rsiBear { score -= 1 }
            }
        }

        if let m = macd {
            let adxValue = adx?.adx ?? 0
            let atrValue = atr?.atr ?? (current * 0.01)
            let histDeadZone = atrValue * 0.001 * volScalar

            if adxValue >= 20 && abs(m.histogram) > histDeadZone {
                let macdWeight = adxValue >= 25 ? 2 : 1
                if m.histogram > 0 {
                    score += m.crossover == "bullish" ? macdWeight : max(macdWeight - 1, 0)
                } else {
                    score -= m.crossover == "bearish" ? macdWeight : max(macdWeight - 1, 0)
                }
            }
        }

        // ── Layer 4: Confirmation (VWAP, Stoch RSI, Divergence) ──
        if let v = vwap?.vwap, v > 0 {
            if current > v { score += 1 } else { score -= 1 }
        }

        if let stoch = stochRSIFull.result, !isDaily {
            let stochLow = max(5.0, 15.0 - (volScalar - 1.0) * 20)
            let stochHigh = min(95.0, 85.0 + (volScalar - 1.0) * 20)
            if stoch.k < stochLow && stoch.crossover == "bullish" { score += 1 }
            else if stoch.k > stochHigh && stoch.crossover == "bearish" { score -= 1 }
        }

        if let div = divergence {
            if div == "bullish" && score < 0 { score += 1 }
            if div == "bearish" && score > 0 { score -= 1 }
        }

        // Stock-only bias signals
        if market == .stock {
            if let o = obv, o.trend == "Rising" { score += 1 }
            else if obv?.trend == "Falling" { score -= 1 }
            if let ad = adLine, ad.trend == "Accumulation" { score += 1 }
            else if adLine?.trend == "Distribution" { score -= 1 }
        }

        // ── Layer 5: Cross-Asset Confirmation (Daily only, crypto only) ──
        if isDaily && market == .crypto, let ca = crossAsset {
            score += ca.combinedSignal
        }

        // ── Momentum Override (volume-gated, reduced weight on 4H) ──
        var momentumOverride: String? = nil
        if !isDaily && validRSI.count >= 5 && candles.count >= 3 {
            let recentRSI = Array(validRSI.suffix(5))
            let rsiMin = recentRSI.min() ?? 50
            let rsiMax = recentRSI.max() ?? 50
            let currentRSI = validRSI.last ?? 50
            let last3 = Array(candles.suffix(3))
            let last3AllGreen = last3.allSatisfy { $0.close >= $0.open }
            let last3AllRed = last3.allSatisfy { $0.close < $0.open }
            let last3VolIncreasing = last3.count == 3 && last3[2].volume >= last3[1].volume && last3[1].volume >= last3[0].volume

            let oversoldThreshold: Double = is4H ? 30 : 35
            let overboughtThreshold: Double = is4H ? 70 : 65
            let overrideWeight = is4H ? 2 : 3

            if rsiMin < oversoldThreshold && currentRSI > 60 && last3AllGreen && last3VolIncreasing {
                momentumOverride = "bullish_reversal"
                score += overrideWeight
            }
            if rsiMax > overboughtThreshold && currentRSI < 40 && last3AllRed && last3VolIncreasing {
                momentumOverride = "bearish_reversal"
                score -= overrideWeight
            }
            if momentumOverride == nil && last3AllGreen && last3VolIncreasing && currentRSI > 55 {
                score += is4H ? 1 : 2
            }
            if momentumOverride == nil && last3AllRed && last3VolIncreasing && currentRSI < 45 {
                score -= is4H ? 1 : 2
            }
        }

        // ── Label Assignment (timeframe-specific thresholds) ──
        // Adaptive thresholds: scaled by volatility (harder in high vol, easier in low vol)
        let strongThreshold: Int
        let directionalThreshold: Int
        if isDaily {
            strongThreshold = max(7, Int(round(9.0 * volScalar)))
            directionalThreshold = max(5, Int(round(6.0 * volScalar)))
        } else if is4H {
            strongThreshold = max(5, Int(round(7.0 * volScalar)))
            directionalThreshold = max(3, Int(round(4.0 * volScalar)))
        } else {
            strongThreshold = max(3, Int(round(5.0 * volScalar)))
            directionalThreshold = max(1, Int(round(2.0 * volScalar)))
        }

        var bias: String
        if score >= strongThreshold { bias = "Strong Bullish" }
        else if score >= directionalThreshold { bias = "Bullish" }
        else if score <= -strongThreshold { bias = "Strong Bearish" }
        else if score <= -directionalThreshold { bias = "Bearish" }
        else { bias = "Neutral" }

        // Derive bullPercent for backward compatibility (UI + prompt)
        #if DEBUG
        print("[MarketScope] [\(label)] Bias score: \(score) → \(bias) (EMA: \(emaRegime), structure: \(marketStructure?.label ?? "none"), override: \(momentumOverride ?? "none"))")
        #endif

        let maxScore = 18.0  // EMA stack ±2, structure ±2, cross-asset ±2
        let clampedScore = min(max(Double(score), -maxScore), maxScore)
        let bullPct = ((clampedScore / maxScore) + 1.0) / 2.0 * 100.0

        // ── Ranging Regime Override (Daily only) ──
        // ADX < 20 = no trend. Directional labels in ranges are 34-43% accurate (worse than
        // coin flip). Force Neutral unless score is overwhelmingly strong.
        if isDaily {
            let adxValue = adx?.adx ?? 0
            if adxValue < 20 && abs(score) < strongThreshold {
                bias = "Neutral"
            }
        }

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
            let vpLookback = timeframe == "4h" ? 60 : 30  // 4H: 10 days, Daily: 6 weeks
            volProfile = VolumeProfile.compute(candles: Array(candles.suffix(vpLookback)), atr: atrVal.atr)
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
            atrPercentileLabel: atrPercentileResult?.label,
            momentumOverride: momentumOverride,
            biasScore: score,
            marketStructure: marketStructure,
            volScalar: volScalar
        )
        result.volumeProfile = volProfile
        return result
    }
}
