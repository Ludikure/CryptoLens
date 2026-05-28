// Faithful port of iOS ScoringFunction.score → (score, bias) and the CSV-label fields
// BacktestEngine derives from it: dailyScore/fourHScore/oneHScore, dailyBias/fourHBias/
// oneHBias, biasAlignment, regime, emaRegime. Without this the Node CLI emits stubs
// for those 9+ columns and tfAlignment drifts vs Swift's training data.
//
// Source references:
//   - CryptoLens/Services/ScoringFunction.swift (the algorithm)
//   - CryptoLens/Models/ScoringParams.swift (cryptoDefault / stockDefault)
//   - CryptoLens/Services/BacktestEngine.swift:440-460 (alignment + regime derivation)
//   - CryptoLens/Indicators/ComputeAll.swift:118-162 (emaRegime + volScalar)

import { type Candle, extractFeatures, computeATR, type TimeframeFeatures } from '../src/scoring-full.js';

/// Mirror of Swift `ScoringParams`. Field names match 1:1 for ease of cross-check.
export interface ScoringParams {
    pricePositionWeight: number; emaSlopeWeight: number;
    structureWeight: number; stackConfirmWeight: number;
    adxStrongBreak: number; adxModBreak: number; adxWeakBreak: number;
    adxStrongWeight: number; adxModWeight: number; adxWeakWeight: number;
    rsiWeight: number; macdMaxWeight: number;
    vwapWeight: number; stochWeight: number; divergenceWeight: number;
    crossAssetWeight: number; derivativesWeight: number;
    dailyStrongThreshold: number; dailyDirectionalThreshold: number;
    fourHStrongThreshold: number; fourHDirectionalThreshold: number;
    useAdaptive: boolean;
}

export const CRYPTO_DEFAULT: ScoringParams = {
    pricePositionWeight: 1, emaSlopeWeight: 0, structureWeight: 1, stackConfirmWeight: 1,
    adxStrongBreak: 40, adxModBreak: 30, adxWeakBreak: 20,
    adxStrongWeight: 3, adxModWeight: 2, adxWeakWeight: 1,
    rsiWeight: 3, macdMaxWeight: 3,
    vwapWeight: 0, stochWeight: 0, divergenceWeight: 0,
    crossAssetWeight: 1, derivativesWeight: 1,
    dailyStrongThreshold: 8, dailyDirectionalThreshold: 4,
    fourHStrongThreshold: 4, fourHDirectionalThreshold: 2,
    useAdaptive: true,
};

export const STOCK_DEFAULT: ScoringParams = {
    pricePositionWeight: 3, emaSlopeWeight: 1, structureWeight: 1, stackConfirmWeight: 0,
    adxStrongBreak: 40, adxModBreak: 30, adxWeakBreak: 20,
    adxStrongWeight: 3, adxModWeight: 2, adxWeakWeight: 1,
    rsiWeight: 3, macdMaxWeight: 3,
    vwapWeight: 1, stochWeight: 0, divergenceWeight: 0,
    crossAssetWeight: 1, derivativesWeight: 0,
    dailyStrongThreshold: 7, dailyDirectionalThreshold: 3,
    fourHStrongThreshold: 4, fourHDirectionalThreshold: 2,
    useAdaptive: true,
};

export interface BiasResult {
    score: number;
    bias: string;
    /// Fields cached for the caller — saves recomputing in regime/biasAlignment helpers.
    emaRegime: 'bullish' | 'bearish' | 'mixed';
    stackBullish: boolean;
    stackBearish: boolean;
    adx: number;
    rsi: number;
}

/// External crypto-only signals not in TimeframeFeatures. Used at the daily-crypto
/// branches of ScoringFunction (lines 117-125).
export interface ExternalSignals {
    crossAssetSignal: number;       // -2..+2, from ETH/BTC + F&G combined
    derivativesCombined: number;    // already clamped in resolveDerivativesAt
}

/// Compute the iOS bias label + score for a timeframe.
///
/// `tfCandles` is the per-timeframe candle slice that produced the FullFeatures values
/// (so daily ⇒ dailyCandles, etc.). External signals only apply to daily-crypto;
/// pass zeros for the other timeframes / stocks.
export function computeTimeframeBias(
    tfCandles: Candle[],
    isCrypto: boolean,
    timeframe: '1d' | '4h' | '1h',
    params: ScoringParams,
    external: ExternalSignals,
): BiasResult {
    const tfMapped = timeframe === '1d' ? 'daily' : timeframe === '4h' ? '4h' : '1h';
    const tf = extractFeatures(tfCandles, isCrypto, tfMapped);
    const isDaily = timeframe === '1d';
    const is4H = timeframe === '4h';

    const stackBullish = tf.stackBull === 1;
    const stackBearish = tf.stackBear === 1;
    const emaRegime: 'bullish' | 'bearish' | 'mixed' =
        stackBullish ? 'bullish' : stackBearish ? 'bearish' : 'mixed';

    // emaCross in extractFeatures is the signed sum (-3..+3); recover the count
    // 0..3 of "price above EMA" by adding to 3 and halving.
    const emaCrossCount = Math.round((3 + tf.emaCross) / 2);

    // volScalar: the LINEAR formula matching ComputeAll.swift:162, computed from raw
    // (unrounded) atrPercentile. extractFeatures internally uses a stepped version for
    // RSI threshold computation — we need the linear one for ScoringFunction's adaptive
    // thresholds + RSI/Stoch band scaling to match Swift.
    const rawAtrPctile = rawAtrPercentile(tfCandles);
    const volScalar = Math.max(0.75, Math.min(1.35, 0.75 + (rawAtrPctile / 100.0) * 0.6));

    // last3 + currentRSI need raw candle access (not in TimeframeFeatures).
    const n = tfCandles.length;
    const last3Green = n >= 3 && tfCandles.slice(n - 3).every(c => c.close >= c.open);
    const last3Red = n >= 3 && tfCandles.slice(n - 3).every(c => c.close < c.open);
    const last3VolIncreasing = (() => {
        if (n < 3) return false;
        const a = tfCandles[n - 3], b = tfCandles[n - 2], c = tfCandles[n - 1];
        return c.volume >= b.volume && b.volume >= a.volume;
    })();

    // MACD dead zone gating — matches snapshot.macdHistAboveDeadZone construction in
    // ComputeAll.swift:188-191: |hist| > atr * 0.001 * volScalar.
    const atrValue = computeATR(tfCandles);
    const macdHistAboveDeadZone = Math.abs(tf.macdHist) > Math.max(atrValue, 1) * 0.001 * volScalar;

    // Crossover string conversions — TimeframeFeatures stores 1/-1/0 numbers, Swift's
    // snapshot expects "bullish" / "bearish" / nil.
    const macdCrossover = tf.macdCross === 1 ? 'bullish' : tf.macdCross === -1 ? 'bearish' : null;
    const stochCrossover = tf.stochCross === 1 ? 'bullish' : tf.stochCross === -1 ? 'bearish' : null;
    const divergence = tf.divergence === 1 ? 'bullish' : tf.divergence === -1 ? 'bearish' : null;

    let score = 0;

    // Layer 1a — price position
    switch (emaCrossCount) {
        case 3: score += params.pricePositionWeight; break;
        case 2: score += Math.max(1, params.pricePositionWeight - 1); break;
        case 1: score -= Math.max(1, params.pricePositionWeight - 1); break;
        case 0: score -= params.pricePositionWeight; break;
    }
    // Layer 1b — EMA20 slope (stocks; emaSlopeWeight=0 for crypto)
    if (params.emaSlopeWeight > 0) {
        score += tf.ema20Rising === 1 ? params.emaSlopeWeight : -params.emaSlopeWeight;
    }
    // Layer 1c — structure
    if (tf.structBull === 1) score += params.structureWeight;
    else if (tf.structBear === 1) score -= params.structureWeight;
    // Layer 1d — stack confirm
    if (stackBullish) score += params.stackConfirmWeight;
    else if (stackBearish) score -= params.stackConfirmWeight;

    // Layer 2 — ADX tiered
    const adxBullish = tf.adxBullish === 1;
    if (tf.adx >= params.adxStrongBreak) {
        score += adxBullish ? params.adxStrongWeight : -params.adxStrongWeight;
    } else if (tf.adx >= params.adxModBreak) {
        score += adxBullish ? params.adxModWeight : -params.adxModWeight;
    } else if (tf.adx >= params.adxWeakBreak) {
        score += adxBullish ? params.adxWeakWeight : -params.adxWeakWeight;
    }

    // Layer 3 — RSI regime-aware
    if (emaRegime === 'bullish') {
        if (tf.rsi < 40) score += params.rsiWeight;
        else if (tf.rsi < 50) score += Math.max(1, params.rsiWeight - 1);
    } else if (emaRegime === 'bearish') {
        if (tf.rsi > 60) score -= params.rsiWeight;
        else if (tf.rsi > 50) score -= Math.max(1, params.rsiWeight - 1);
    } else {
        const rsiOB = Math.min(75, 70 + (volScalar - 1) * 15);
        const rsiBull = Math.min(60, 55 + (volScalar - 1) * 15);
        const rsiOS = Math.max(25, 30 - (volScalar - 1) * 15);
        const rsiBear = Math.max(40, 45 - (volScalar - 1) * 15);
        if (tf.rsi > rsiOB) score += params.rsiWeight;
        else if (tf.rsi > rsiBull) score += Math.max(1, params.rsiWeight - 1);
        else if (tf.rsi < rsiOS) score -= params.rsiWeight;
        else if (tf.rsi < rsiBear) score -= Math.max(1, params.rsiWeight - 1);
    }

    // MACD — ADX-weighted, dead zone gated
    if (tf.adx >= params.adxWeakBreak && macdHistAboveDeadZone) {
        const macdWeight = tf.adx >= params.adxModBreak
            ? params.macdMaxWeight
            : Math.max(1, params.macdMaxWeight - 1);
        if (tf.macdHist > 0) {
            score += macdCrossover === 'bullish' ? macdWeight : Math.max(macdWeight - 1, 0);
        } else {
            score -= macdCrossover === 'bearish' ? macdWeight : Math.max(macdWeight - 1, 0);
        }
    }

    // Layer 4 — VWAP
    if (params.vwapWeight > 0) {
        score += tf.aboveVwap === 1 ? params.vwapWeight : -params.vwapWeight;
    }
    // Stoch (non-daily only)
    if (!isDaily) {
        const stochLow = Math.max(5, 15 - (volScalar - 1) * 20);
        const stochHigh = Math.min(95, 85 + (volScalar - 1) * 20);
        if (tf.stochK < stochLow && stochCrossover === 'bullish') score += params.stochWeight;
        else if (tf.stochK > stochHigh && stochCrossover === 'bearish') score -= params.stochWeight;
    }
    // Divergence
    if (divergence === 'bullish' && score < 0) score += params.divergenceWeight;
    if (divergence === 'bearish' && score > 0) score -= params.divergenceWeight;

    // Stock-only volume confirm: handled with obv/adLine signals if exposed in TimeframeFeatures.
    // TimeframeFeatures doesn't carry obvRising/adLineAccumulation; for stocks this means
    // the OBV/AD layer of ScoringFunction is omitted. Future fix when scoring-full.ts
    // exposes those flags on TimeframeFeatures. (Daily-stock divergence vs Swift will
    // surface as +/-2 on a small fraction of bars.)

    // Layer 5 — Cross-asset (daily crypto only)
    if (isDaily && isCrypto) {
        score += external.crossAssetSignal * params.crossAssetWeight;
    }
    // Layer 6 — Derivatives (daily crypto only)
    if (isDaily && isCrypto && params.derivativesWeight > 0) {
        score += external.derivativesCombined * params.derivativesWeight;
    }

    // Momentum override (non-daily, mixed regime)
    if (!isDaily && emaRegime === 'mixed') {
        const oversoldThreshold = is4H ? 30 : 35;
        const overboughtThreshold = is4H ? 70 : 65;
        const overrideWeight = is4H ? 2 : 3;
        if (tf.rsi < oversoldThreshold && tf.rsi > 60 /* "currentRSI > 60" — Swift uses currentRSI = rsi */
            && last3Green && last3VolIncreasing) {
            score += overrideWeight;
        }
        if (tf.rsi > overboughtThreshold && tf.rsi < 40
            && last3Red && last3VolIncreasing) {
            score -= overrideWeight;
        }
        if (!(tf.rsi < oversoldThreshold && tf.rsi > 60) && !(tf.rsi > overboughtThreshold && tf.rsi < 40)) {
            if (last3Green && last3VolIncreasing && tf.rsi > 55) {
                score += is4H ? 1 : 2;
            }
            if (last3Red && last3VolIncreasing && tf.rsi < 45) {
                score -= is4H ? 1 : 2;
            }
        }
    }

    // Adaptive thresholds — ADX-aware scaling. Trending: 1/volScalar. Ranging: volScalar.
    let adaptiveScalar = 1.0;
    if (params.useAdaptive) {
        if (tf.adx >= params.adxModBreak) adaptiveScalar = 1.0 / volScalar;
        else if (tf.adx < params.adxWeakBreak) adaptiveScalar = volScalar;
    }

    let strongThreshold: number, directionalThreshold: number;
    if (isDaily) {
        strongThreshold = Math.max(3, Math.round(params.dailyStrongThreshold * adaptiveScalar));
        directionalThreshold = Math.max(2, Math.round(params.dailyDirectionalThreshold * adaptiveScalar));
    } else if (is4H) {
        strongThreshold = Math.max(3, Math.round(params.fourHStrongThreshold * adaptiveScalar));
        directionalThreshold = Math.max(2, Math.round(params.fourHDirectionalThreshold * adaptiveScalar));
    } else {
        strongThreshold = Math.max(3, Math.round(5.0 * adaptiveScalar));
        directionalThreshold = Math.max(1, Math.round(2.0 * adaptiveScalar));
    }

    let bias: string;
    if (score >= strongThreshold) bias = 'Strong Bullish';
    else if (score >= directionalThreshold) bias = 'Bullish';
    else if (score <= -strongThreshold) bias = 'Strong Bearish';
    else if (score <= -directionalThreshold) bias = 'Bearish';
    else bias = 'Neutral';

    // Post-processing gates
    // EMA structure gate
    const priceBelowAll = emaCrossCount === 0;
    const priceAboveAll = emaCrossCount === 3;
    if (emaRegime === 'bearish') {
        if (priceBelowAll && tf.structBull === 0) {
            if (bias === 'Strong Bullish' || bias === 'Bullish' || bias === 'Neutral') bias = 'Bearish';
        } else {
            if (bias === 'Strong Bullish' || bias === 'Bullish') bias = 'Neutral';
        }
    } else if (emaRegime === 'bullish') {
        if (priceAboveAll && tf.structBear === 0) {
            if (bias === 'Strong Bearish' || bias === 'Bearish' || bias === 'Neutral') bias = 'Bullish';
        } else {
            if (bias === 'Strong Bearish' || bias === 'Bearish') bias = 'Neutral';
        }
    }
    // Exhaustion cap
    if (Math.abs(score) > 8 && (bias === 'Strong Bullish' || bias === 'Strong Bearish')) {
        bias = bias.includes('Bullish') ? 'Bullish' : 'Bearish';
    }
    // Ranging override (daily only)
    if (isDaily && tf.adx < params.adxWeakBreak && Math.abs(score) < strongThreshold) {
        bias = 'Neutral';
    }

    return { score, bias, emaRegime, stackBullish, stackBearish, adx: tf.adx, rsi: tf.rsi };
}

/// Faithful clone of ComputeAll.swift:142-159 (raw atrPercentile from last 30+ ATRs over
/// the whole candle slice, period=14). The "raw" here means BEFORE the round-to-integer
/// that the feature output applies. We need the raw value for volScalar's linear formula.
function rawAtrPercentile(candles: Candle[]): number {
    if (candles.length < 44) return 50;
    const atrs: number[] = [];
    for (let i = 14; i < candles.length; i++) {
        let sum = 0;
        for (let j = i - 14 + 1; j <= i; j++) {
            const h = candles[j].high, l = candles[j].low, pc = candles[j - 1].close;
            sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
        atrs.push(sum / 14);
    }
    const current = atrs[atrs.length - 1];
    const sorted = [...atrs].sort((a, b) => a - b);
    let rank = sorted.findIndex(v => v >= current);
    if (rank < 0) rank = sorted.length;
    return (rank / sorted.length) * 100;
}

/// BacktestEngine.swift:445-449. Combines daily + 4H bias labels into the alignment.
export function alignFromBiases(dailyBias: string, fourHBias: string): string {
    const dB = dailyBias.includes('Bullish');
    const dBr = dailyBias.includes('Bearish');
    const hB = fourHBias.includes('Bullish');
    const hBr = fourHBias.includes('Bearish');
    if (dBr && hBr) return 'aligned_bearish';
    if (dB && hB) return 'aligned_bullish';
    if ((dBr && hB) || (dB && hBr)) return 'conflict';
    return 'neutral';
}

/// BacktestEngine.swift:451-460. Daily ADX + EMA stack → regime.
export function regimeFromDaily(adx: number, stackBullish: boolean, stackBearish: boolean): string {
    const tangled = !stackBullish && !stackBearish;
    if (adx > 25 && !tangled) return 'TRENDING';
    if (adx < 20) return 'RANGING';
    return 'TRANSITIONING';
}

/// ComputeAll.swift:124-130. Daily EMA stack → emaRegime label (matches the CSV string).
export function emaRegimeFromDaily(stackBullish: boolean, stackBearish: boolean): string {
    if (stackBullish) return 'bullish';
    if (stackBearish) return 'bearish';
    return 'mixed';
}
