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

        // ── Composite Bias Score ──
        var bullish = 0
        var bearish = 0

        // Step 2: EMA stack scoring
        if let e20 = ema20, let e50 = ema50, let e200 = ema200 {
            if e20 > e50 && e50 > e200 { bullish += 2 }
            else if e20 < e50 && e50 < e200 { bearish += 2 }
            if current > e200 { bullish += 1 } else { bearish += 1 }
        }

        // Step 3: Regime-aware RSI scoring
        if let r = rsi {
            switch emaRegime {
            case .bullish:
                // Uptrend: pullbacks are buying opportunities, OB is strength
                if r < 40 { bullish += 2 }       // Oversold pullback in uptrend = buy signal
                else if r < 50 { bullish += 1 }   // Mild pullback
                // RSI > 70 in uptrend = NO score (strength, not exhaustion)
            case .bearish:
                // Downtrend: rallies are shorting opportunities, OS is weakness
                if r > 60 { bearish += 2 }        // Overbought rally in downtrend = short signal
                else if r > 50 { bearish += 1 }   // Mild rally
                // RSI < 30 in downtrend = NO score (weakness, not bounce)
            case .mixed:
                // Ranging: OB/OS are fade signals
                if r > 70 { bullish += 2 }
                else if r > 55 { bullish += 1 }
                else if r < 30 { bearish += 2 }
                else if r < 45 { bearish += 1 }
            }
        }

        // Step 4: ADX-weighted MACD scoring
        if let m = macd {
            let adxValue = adx?.adx ?? 0
            let macdWeight: Int
            if adxValue >= 25 { macdWeight = 2 }       // Trending: full weight
            else if adxValue >= 20 { macdWeight = 1 }   // Marginal: half weight
            else { macdWeight = 0 }                      // Ranging: ignore crossovers

            if macdWeight > 0 {
                if m.histogram > 0 {
                    bullish += m.crossover == "bullish" ? macdWeight : macdWeight - 1
                } else {
                    bearish += m.crossover == "bearish" ? macdWeight : macdWeight - 1
                }
            }
        }

        // Step 5: ADX magnitude scoring
        if let a = adx {
            if a.adx >= 40 {
                if a.direction == "Bullish" { bullish += 3 } else { bearish += 3 }
            } else if a.adx >= 30 {
                if a.direction == "Bullish" { bullish += 2 } else { bearish += 2 }
            } else if a.adx >= 20 {
                if a.direction == "Bullish" { bullish += 1 } else { bearish += 1 }
            }
        }

        // Stock-only bias signals
        if market == .stock {
            if let o = obv, o.trend == "Rising" { bullish += 1 } else if obv?.trend == "Falling" { bearish += 1 }
            if let ad = adLine, ad.trend == "Accumulation" { bullish += 1 } else if adLine?.trend == "Distribution" { bearish += 1 }
        }

        // Step 6: Volume-gated momentum override
        // Daily: NO override. 4H: tight thresholds + volume required. 1H: standard + volume required.
        let isDaily = label.contains("Daily") || label.contains("1D")
        let is4H = label.contains("4H")
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
            let overrideWeight = is4H ? 2 : 3  // 4H gets less override authority

            // Bullish reversal: RSI recovery + green candles + VOLUME CONFIRMATION
            if rsiMin < oversoldThreshold && currentRSI > 60 && last3AllGreen && last3VolIncreasing {
                momentumOverride = "bullish_reversal"
                bullish += overrideWeight
            }
            // Bearish reversal: RSI drop + red candles + VOLUME CONFIRMATION
            if rsiMax > overboughtThreshold && currentRSI < 40 && last3AllRed && last3VolIncreasing {
                momentumOverride = "bearish_reversal"
                bearish += overrideWeight
            }
            // Weaker: consecutive candles with volume (already volume-gated)
            if momentumOverride == nil && last3AllGreen && last3VolIncreasing && currentRSI > 55 {
                bullish += is4H ? 1 : 2
            }
            if momentumOverride == nil && last3AllRed && last3VolIncreasing && currentRSI < 45 {
                bearish += is4H ? 1 : 2
            }
        }

        let total = bullish + bearish
        let bullPct = total > 0 ? (Double(bullish) / Double(total)) * 100.0 : 50.0
        var bias: String
        if bullPct >= 75 { bias = "Strong Bullish" }
        else if bullPct >= 60 { bias = "Bullish" }
        else if bullPct <= 25 { bias = "Strong Bearish" }
        else if bullPct <= 40 { bias = "Bearish" }
        else { bias = "Neutral" }

        // Step 7: EMA Structure Gate — trend structure caps/floors the label
        if let _ = ema20, let _ = ema50, let _ = ema200 {
            switch emaRegime {
            case .bearish:
                if priceBelowAll {
                    // Full bearish alignment + price below all: cap at Bearish
                    if bias == "Strong Bullish" || bias == "Bullish" || bias == "Neutral" {
                        bias = "Bearish"
                    }
                } else {
                    // Bearish stack but price reclaiming some EMAs: cap at Neutral
                    if bias == "Strong Bullish" || bias == "Bullish" {
                        bias = "Neutral"
                    }
                }
            case .bullish:
                if priceAboveAll {
                    // Full bullish alignment + price above all: floor at Bullish
                    if bias == "Strong Bearish" || bias == "Bearish" || bias == "Neutral" {
                        bias = "Bullish"
                    }
                } else {
                    // Bullish stack but price pulling back: floor at Neutral
                    if bias == "Strong Bearish" || bias == "Bearish" {
                        bias = "Neutral"
                    }
                }
            case .mixed:
                break  // No gate — scoring decides
            }
        }

        // Momentum override: only in mixed regime (gate already handles bullish/bearish regimes)
        if emaRegime == .mixed {
            if momentumOverride == "bullish_reversal" && bias.contains("Bearish") {
                bias = "Neutral"
            }
            if momentumOverride == "bearish_reversal" && bias.contains("Bullish") {
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
            atrPercentileLabel: atrPercentileResult?.label,
            momentumOverride: momentumOverride
        )
        result.volumeProfile = volProfile
        return result
    }
}
