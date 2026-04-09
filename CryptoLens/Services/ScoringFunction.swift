import Foundation

/// Pure scoring function: takes a snapshot + params, returns (score, bias).
/// Mirrors the logic in IndicatorEngine.computeAll but is parameterized for optimization.
/// IMPORTANT: Keep in sync with ComputeAll scoring layers. Any edit here must be reflected there and vice versa.
enum ScoringFunction {

    static func score(snapshot s: ScoringSnapshot, params p: ScoringParams) -> (score: Int, bias: String) {
        var score = 0

        let isDaily = s.timeframe == "1d" || s.timeframe == "D"
        let is4H = s.timeframe == "4h"

        // ── Regime classification from EMA stack order (NOT price position) ──
        enum EMARegime { case bullish, bearish, mixed }
        let emaRegime: EMARegime
        if s.ema20 != nil && s.ema50 != nil && s.ema200 != nil {
            if s.stackBullish { emaRegime = .bullish }
            else if s.stackBearish { emaRegime = .bearish }
            else { emaRegime = .mixed }
        } else {
            emaRegime = .mixed
        }

        // ── Layer 1: Trend ──

        // 1a: Price position relative to EMAs
        // Full cross (all 3 above/below) gets full weight; partial cross gets weight-1 (min 1)
        if s.ema20 != nil && s.ema50 != nil && s.ema200 != nil {
            switch s.emaCrossCount {
            case 3: score += p.pricePositionWeight
            case 2: score += max(1, p.pricePositionWeight - 1)
            case 1: score -= max(1, p.pricePositionWeight - 1)
            case 0: score -= p.pricePositionWeight
            default: break
            }
        }

        // 1b: EMA20 slope
        if s.ema20Rising { score += p.emaSlopeWeight }
        else { score -= p.emaSlopeWeight }

        // 1c: Market structure
        if s.structureBullish { score += p.structureWeight }
        else if s.structureBearish { score -= p.structureWeight }

        // 1d: EMA stack confirmation
        if s.stackBullish { score += p.stackConfirmWeight }
        else if s.stackBearish { score -= p.stackConfirmWeight }

        // ── Layer 2: ADX-weighted trend strength ──
        if s.adxValue >= p.adxStrongBreak {
            score += s.adxBullish ? p.adxStrongWeight : -p.adxStrongWeight
        } else if s.adxValue >= p.adxModBreak {
            score += s.adxBullish ? p.adxModWeight : -p.adxModWeight
        } else if s.adxValue >= p.adxWeakBreak {
            score += s.adxBullish ? p.adxWeakWeight : -p.adxWeakWeight
        }

        // ── Layer 3: Momentum (RSI regime-aware) ──
        if let r = s.rsi {
            switch emaRegime {
            case .bullish:
                if r < 40 { score += p.rsiWeight }
                else if r < 50 { score += max(1, p.rsiWeight - 1) }
            case .bearish:
                if r > 60 { score -= p.rsiWeight }
                else if r > 50 { score -= max(1, p.rsiWeight - 1) }
            case .mixed:
                let rsiOB = min(75.0, 70.0 + (s.volScalar - 1.0) * 15)
                let rsiBull = min(60.0, 55.0 + (s.volScalar - 1.0) * 15)
                let rsiOS = max(25.0, 30.0 - (s.volScalar - 1.0) * 15)
                let rsiBear = max(40.0, 45.0 - (s.volScalar - 1.0) * 15)
                if r > rsiOB { score += p.rsiWeight }
                else if r > rsiBull { score += max(1, p.rsiWeight - 1) }
                else if r < rsiOS { score -= p.rsiWeight }
                else if r < rsiBear { score -= max(1, p.rsiWeight - 1) }
            }
        }

        // MACD (ADX-weighted, dead zone gated)
        if s.adxValue >= p.adxWeakBreak && s.macdHistAboveDeadZone {
            let macdWeight = s.adxValue >= 25 ? p.macdMaxWeight : max(1, p.macdMaxWeight - 1)
            if s.macdHistogram > 0 {
                score += s.macdCrossover == "bullish" ? macdWeight : max(macdWeight - 1, 0)
            } else {
                score -= s.macdCrossover == "bearish" ? macdWeight : max(macdWeight - 1, 0)
            }
        }

        // ── Layer 4: Confirmation ──
        if s.aboveVwap { score += p.vwapWeight } else { score -= p.vwapWeight }

        if let k = s.stochK, !isDaily {
            let stochLow = max(5.0, 15.0 - (s.volScalar - 1.0) * 20)
            let stochHigh = min(95.0, 85.0 + (s.volScalar - 1.0) * 20)
            if k < stochLow && s.stochCrossover == "bullish" { score += p.stochWeight }
            else if k > stochHigh && s.stochCrossover == "bearish" { score -= p.stochWeight }
        }

        if let div = s.divergence {
            if div == "bullish" && score < 0 { score += p.divergenceWeight }
            if div == "bearish" && score > 0 { score -= p.divergenceWeight }
        }

        // Stock-only volume confirmation
        if !s.isCrypto {
            if s.obvRising { score += 1 } else { score -= 1 }
            if s.adLineAccumulation { score += 1 } else { score -= 1 }
        }

        // ── Layer 5: Cross-asset (daily crypto only) ──
        if isDaily && s.isCrypto {
            score += s.crossAssetSignal * p.crossAssetWeight
        }

        // ── Layer 6: Derivatives (daily crypto only, non-price-derived) ──
        if isDaily && s.isCrypto && p.derivativesWeight > 0 {
            score += s.derivativesCombinedSignal * p.derivativesWeight
        }

        // ── Momentum override (non-daily only) ──
        if !isDaily {
            let oversoldThreshold: Double = is4H ? 30 : 35
            let overboughtThreshold: Double = is4H ? 70 : 65
            let overrideWeight = is4H ? 2 : 3

            if let curRSI = s.currentRSI, let r = s.rsi {
                if r < oversoldThreshold && curRSI > 60 && s.last3Green && s.last3VolIncreasing {
                    score += overrideWeight
                }
                if r > overboughtThreshold && curRSI < 40 && s.last3Red && s.last3VolIncreasing {
                    score -= overrideWeight
                }
                if !(r < oversoldThreshold && curRSI > 60) && !(r > overboughtThreshold && curRSI < 40) {
                    if s.last3Green && s.last3VolIncreasing && curRSI > 55 {
                        score += is4H ? 1 : 2
                    }
                    if s.last3Red && s.last3VolIncreasing && curRSI < 45 {
                        score -= is4H ? 1 : 2
                    }
                }
            }
        }

        // ── Adaptive thresholds ──
        let strongThreshold: Int
        let directionalThreshold: Int

        if isDaily {
            if p.useAdaptive {
                strongThreshold = max(3, Int(round(Double(p.dailyStrongThreshold) * s.volScalar)))
                directionalThreshold = max(2, Int(round(Double(p.dailyDirectionalThreshold) * s.volScalar)))
            } else {
                strongThreshold = p.dailyStrongThreshold
                directionalThreshold = p.dailyDirectionalThreshold
            }
        } else if is4H {
            if p.useAdaptive {
                strongThreshold = max(4, Int(round(Double(p.fourHStrongThreshold) * s.volScalar)))
                directionalThreshold = max(2, Int(round(Double(p.fourHDirectionalThreshold) * s.volScalar)))
            } else {
                strongThreshold = p.fourHStrongThreshold
                directionalThreshold = p.fourHDirectionalThreshold
            }
        } else {
            strongThreshold = max(3, Int(round(5.0 * s.volScalar)))
            directionalThreshold = max(1, Int(round(2.0 * s.volScalar)))
        }

        // ── Label assignment ──
        var bias: String
        if score >= strongThreshold { bias = "Strong Bullish" }
        else if score >= directionalThreshold { bias = "Bullish" }
        else if score <= -strongThreshold { bias = "Strong Bearish" }
        else if score <= -directionalThreshold { bias = "Bearish" }
        else { bias = "Neutral" }

        // ── Post-processing gates (skipped in diagnostic isolation mode) ──
        if !p.skipGates {
            // EMA Structure Gate
            let priceBelowAll = s.emaCrossCount == 0
            let priceAboveAll = s.emaCrossCount == 3
            if s.ema20 != nil && s.ema50 != nil && s.ema200 != nil {
                switch emaRegime {
                case .bearish:
                    if priceBelowAll && !s.structureBullish {
                        if bias == "Strong Bullish" || bias == "Bullish" || bias == "Neutral" { bias = "Bearish" }
                    } else {
                        if bias == "Strong Bullish" || bias == "Bullish" { bias = "Neutral" }
                    }
                case .bullish:
                    if priceAboveAll && !s.structureBearish {
                        if bias == "Strong Bearish" || bias == "Bearish" || bias == "Neutral" { bias = "Bullish" }
                    } else {
                        if bias == "Strong Bearish" || bias == "Bearish" { bias = "Neutral" }
                    }
                case .mixed:
                    break
                }
            }

            // Exhaustion cap
            if abs(score) > 8 && (bias == "Strong Bullish" || bias == "Strong Bearish") {
                bias = bias.contains("Bullish") ? "Bullish" : "Bearish"
            }

            // Ranging override (daily only)
            if isDaily && s.adxValue < 20 && abs(score) < strongThreshold {
                bias = "Neutral"
            }
        }

        return (score: score, bias: bias)
    }
}
