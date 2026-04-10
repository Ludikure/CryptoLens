import Foundation

enum IndicatorEngine {
    static func computeAll(candles: [Candle], timeframe: String, label: String, market: Market = .crypto, crossAsset: CrossAssetContext? = nil, derivatives: DerivativesContext? = nil) -> IndicatorResult {
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
        // Two separate concepts:
        // 1. emaRegime (stack order) → RSI interpretation + EMA gate. Structural, changes slowly.
        // 2. emaCrossCount (price position) → Layer 1a scoring. Leading, changes fast.
        // These must NOT be conflated. RSI 70 in a bearish stack is a short signal, not strength.
        enum EMARegime { case bullish, bearish, mixed }
        let emaRegime: EMARegime
        var emaCrossCount = 0
        if let e20 = ema20, let e50 = ema50, let e200 = ema200 {
            // Stack order → regime
            if e20 > e50 && e50 > e200 { emaRegime = .bullish }
            else if e20 < e50 && e50 < e200 { emaRegime = .bearish }
            else { emaRegime = .mixed }
            // Price position → scoring
            if current > e20 { emaCrossCount += 1 }
            if current > e50 { emaCrossCount += 1 }
            if current > e200 { emaCrossCount += 1 }
        } else {
            emaRegime = .mixed
        }

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

        // ── Signed Bias Score (optimizer-tunable weights) ──
        let params = ScoringParams.loadSaved(for: market) ?? (market == .crypto ? .cryptoDefault : .stockDefault)
        var score = 0
        let isDaily = label.contains("Daily") || label.contains("1D")
        let is4H = label.contains("4H")

        // ── Layer 1: Trend (leading + confirming signals) ──

        // 1a: Price position (LEADING)
        if let _ = ema20, let _ = ema50, let _ = ema200 {
            switch emaCrossCount {
            case 3: score += params.pricePositionWeight
            case 2: score += max(1, params.pricePositionWeight - 1)
            case 1: score -= max(1, params.pricePositionWeight - 1)
            case 0: score -= params.pricePositionWeight
            default: break
            }
        }

        // 1b: EMA20 slope (LEADING)
        if params.emaSlopeWeight > 0 && ema20List.count >= 6 {
            let ema20Now = ema20List[ema20List.count - 1]
            let ema20Prior = ema20List[ema20List.count - 6]
            if ema20Now > ema20Prior { score += params.emaSlopeWeight }
            else if ema20Now < ema20Prior { score -= params.emaSlopeWeight }
        }

        // 1c: Market structure (LEADING)
        if let ms = marketStructure {
            if ms.label.contains("bullish") { score += params.structureWeight }
            else if ms.label.contains("bearish") { score -= params.structureWeight }
        }

        // 1d: EMA stack confirmation (LAGGING)
        if let e20 = ema20, let e50 = ema50, let e200 = ema200 {
            if e20 > e50 && e50 > e200 { score += params.stackConfirmWeight }
            else if e20 < e50 && e50 < e200 { score -= params.stackConfirmWeight }
        }

        // ── Layer 2: Trend Strength (ADX) ──
        if let a = adx {
            if a.adx >= params.adxStrongBreak {
                score += a.direction == "Bullish" ? params.adxStrongWeight : -params.adxStrongWeight
            } else if a.adx >= params.adxModBreak {
                score += a.direction == "Bullish" ? params.adxModWeight : -params.adxModWeight
            } else if a.adx >= params.adxWeakBreak {
                score += a.direction == "Bullish" ? params.adxWeakWeight : -params.adxWeakWeight
            }
        }

        // ── Layer 3: Momentum (RSI + MACD, regime-aware) ──
        if let r = rsi {
            switch emaRegime {
            case .bullish:
                if r < 40 { score += params.rsiWeight }
                else if r < 50 { score += max(1, params.rsiWeight - 1) }
            case .bearish:
                if r > 60 { score -= params.rsiWeight }
                else if r > 50 { score -= max(1, params.rsiWeight - 1) }
            case .mixed:
                let rsiOB = min(75.0, 70.0 + (volScalar - 1.0) * 15)
                let rsiBull = min(60.0, 55.0 + (volScalar - 1.0) * 15)
                let rsiOS = max(25.0, 30.0 - (volScalar - 1.0) * 15)
                let rsiBear = max(40.0, 45.0 - (volScalar - 1.0) * 15)
                if r > rsiOB { score += params.rsiWeight }
                else if r > rsiBull { score += max(1, params.rsiWeight - 1) }
                else if r < rsiOS { score -= params.rsiWeight }
                else if r < rsiBear { score -= max(1, params.rsiWeight - 1) }
            }
        }

        if let m = macd {
            let adxValue = adx?.adx ?? 0
            let atrValue = atr?.atr ?? (current * 0.01)
            let histDeadZone = atrValue * 0.001 * volScalar

            if adxValue >= params.adxWeakBreak && abs(m.histogram) > histDeadZone {
                let macdWeight = adxValue >= params.adxModBreak ? params.macdMaxWeight : max(1, params.macdMaxWeight - 1)
                if m.histogram > 0 {
                    score += m.crossover == "bullish" ? macdWeight : max(macdWeight - 1, 0)
                } else {
                    score -= m.crossover == "bearish" ? macdWeight : max(macdWeight - 1, 0)
                }
            }
        }

        // ── Layer 4: Confirmation (VWAP, Stoch RSI, Divergence) ──
        if let v = vwap?.vwap, v > 0 {
            if current > v { score += params.vwapWeight } else { score -= params.vwapWeight }
        }

        if params.stochWeight > 0, let stoch = stochRSIFull.result, !isDaily {
            let stochLow = max(5.0, 15.0 - (volScalar - 1.0) * 20)
            let stochHigh = min(95.0, 85.0 + (volScalar - 1.0) * 20)
            if stoch.k < stochLow && stoch.crossover == "bullish" { score += params.stochWeight }
            else if stoch.k > stochHigh && stoch.crossover == "bearish" { score -= params.stochWeight }
        }

        if params.divergenceWeight > 0, let div = divergence {
            if div == "bullish" && score < 0 { score += params.divergenceWeight }
            if div == "bearish" && score > 0 { score -= params.divergenceWeight }
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
            score += ca.combinedSignal * params.crossAssetWeight
        }

        // ── Layer 6: Derivatives (crypto only, non-price-derived) ──
        if isDaily && market == .crypto, let dctx = derivatives {
            score += dctx.combinedSignal * params.derivativesWeight
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

        // ── Label Assignment (optimizer-tuned thresholds, optionally adaptive) ──
        let adaptiveScalar = params.useAdaptive ? volScalar : 1.0
        let strongThreshold: Int
        let directionalThreshold: Int
        if isDaily {
            strongThreshold = max(3, Int(round(Double(params.dailyStrongThreshold) * adaptiveScalar)))
            directionalThreshold = max(2, Int(round(Double(params.dailyDirectionalThreshold) * adaptiveScalar)))
        } else if is4H {
            strongThreshold = max(3, Int(round(Double(params.fourHStrongThreshold) * adaptiveScalar)))
            directionalThreshold = max(2, Int(round(Double(params.fourHDirectionalThreshold) * adaptiveScalar)))
        } else {
            strongThreshold = max(3, Int(round(5.0 * adaptiveScalar)))
            directionalThreshold = max(1, Int(round(2.0 * adaptiveScalar)))
        }

        var bias: String
        if score >= strongThreshold { bias = "Strong Bullish" }
        else if score >= directionalThreshold { bias = "Bullish" }
        else if score <= -strongThreshold { bias = "Strong Bearish" }
        else if score <= -directionalThreshold { bias = "Bearish" }
        else { bias = "Neutral" }

        // ── EMA Structure Gate (structure-aware) ──
        // Trend structure caps/floors the label. Momentum can soften but not flip.
        let structureLabel = marketStructure?.label ?? ""
        let priceBelowAll = emaCrossCount == 0
        let priceAboveAll = emaCrossCount == 3
        if let _ = ema20, let _ = ema50, let _ = ema200 {
            switch emaRegime {
            case .bearish:
                if priceBelowAll && !structureLabel.contains("bullish") {
                    if bias == "Strong Bullish" || bias == "Bullish" || bias == "Neutral" { bias = "Bearish" }
                } else {
                    if bias == "Strong Bullish" || bias == "Bullish" { bias = "Neutral" }
                }
            case .bullish:
                if priceAboveAll && !structureLabel.contains("bearish") {
                    if bias == "Strong Bearish" || bias == "Bearish" || bias == "Neutral" { bias = "Bullish" }
                } else {
                    if bias == "Strong Bearish" || bias == "Bearish" { bias = "Neutral" }
                }
            case .mixed:
                break
            }
        }

        // Momentum override: only in mixed regime (gate handles bullish/bearish)
        if emaRegime == .mixed {
            if momentumOverride == "bullish_reversal" && bias.contains("Bearish") { bias = "Neutral" }
            if momentumOverride == "bearish_reversal" && bias.contains("Bullish") { bias = "Neutral" }
        }

        #if DEBUG
        print("[MarketScope] [\(label)] score: \(score) → \(bias) | params: \(params.label) | vol: \(String(format: "%.2f", volScalar))")
        #endif

        // Crypto daily: base 18 + derivatives ±3 = 21. Stock: no derivatives, max ~18.
        let maxScore: Double = (market == .crypto && isDaily) ? 21.0 : 18.0
        let clampedScore = min(max(Double(score), -maxScore), maxScore)
        let bullPct = ((clampedScore / maxScore) + 1.0) / 2.0 * 100.0

        // ── Exhaustion Cap ──
        // Extreme scores (±8+) indicate indicator saturation, not higher conviction.
        // When every indicator agrees, the move is typically extended.
        // Cap at directional (not Strong) to avoid false confidence on exhausted moves.
        if abs(score) > 8 && (bias == "Strong Bullish" || bias == "Strong Bearish") {
            bias = bias.contains("Bullish") ? "Bullish" : "Bearish"
        }

        // ── Ranging Regime Override (Daily only) ──
        // ADX < 20 = no trend. Force Neutral unless score exceeds strong threshold.
        if isDaily {
            let adxValue = adx?.adx ?? 0
            if adxValue < params.adxWeakBreak && abs(score) < strongThreshold {
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
            sma50: nil,
            sma200: nil,
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
