// Full 80-feature computation for server-side ML predictions.
// Mirrors Swift IndicatorEngine.computeAll() + BacktestEngine MLFeatures extraction.

export interface Candle {
    time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface FullFeatures {
    // Daily core (9)
    dRsi: number; dMacdHist: number; dAdx: number; dAdxBullish: number;
    dEmaCross: number; dStackBull: number; dStackBear: number;
    dStructBull: number; dStructBear: number;
    // Daily momentum (5)
    dStochK: number; dStochCross: number; dMacdCross: number;
    dDivergence: number; dEma20Rising: number;
    // Daily vol/volume (5)
    dBBPercentB: number; dBBSqueeze: number; dBBBandwidth: number;
    dVolumeRatio: number; dAboveVwap: number;
    // 4H core (9)
    hRsi: number; hMacdHist: number; hAdx: number; hAdxBullish: number;
    hEmaCross: number; hStackBull: number; hStackBear: number;
    hStructBull: number; hStructBear: number;
    // 4H momentum (5)
    hStochK: number; hStochCross: number; hMacdCross: number;
    hDivergence: number; hEma20Rising: number;
    // 4H vol/volume (5)
    hBBPercentB: number; hBBSqueeze: number; hBBBandwidth: number;
    hVolumeRatio: number; hAboveVwap: number;
    // 1H entry (4)
    eRsi: number; eEmaCross: number; eStochK: number; eMacdHist: number;
    // Derivatives (5)
    fundingSignal: number; oiSignal: number; takerSignal: number;
    crowdingSignal: number; derivativesCombined: number;
    // Macro (3)
    vix: number; dxyAboveEma20: number; volScalarML: number;
    // Candle patterns (3)
    last3Green: number; last3Red: number; last3VolIncreasing: number;
    // Stock-only (2)
    obvRising: number; adLineAccumulation: number;
    // Derivatives raw (4)
    fundingRateRaw: number; oiChangePct: number;
    takerRatioRaw: number; longPctRaw: number;
    // Context (4)
    atrPercent: number; atrPercentile: number;
    // Cross-timeframe interactions (5)
    tfAlignment: number; momentumAlignment: number; structureAlignment: number;
    // Temporal (3)
    dayOfWeek: number; barsSinceRegimeChange: number; regimeCode: number;
    // Rate-of-change (5)
    dRsiDelta: number; dAdxDelta: number; hRsiDelta: number;
    hAdxDelta: number; hMacdHistDelta: number;
    // Sentiment (2)
    fearGreedIndex: number; fearGreedZone: number;
    // Cross-asset crypto (2)
    ethBtcRatio: number; ethBtcDelta6: number;
    // Volume profile (6)
    vpDistToPocATR: number; vpAbovePoc: number; vpVAWidth: number;
    vpInValueArea: number; vpDistToVAH_ATR: number; vpDistToVAL_ATR: number;
    // 1-bar deltas + acceleration (6)
    hRsiDelta1: number; hMacdHistDelta1: number; dRsiDelta1: number;
    hRsiAccel: number; hMacdAccel: number; dAdxAccel: number;
    // Time-of-day (2)
    hourBucket: number; isWeekend: number;
    // Basis (2)
    basisPct: number; basisExtreme: number;
    // Stock features (9)
    fiftyTwoWeekPct: number; distToFiftyTwoHigh: number;
    gapPercent: number; gapFilled: number; gapDirectionAligned: number;
    relStrengthVsSpy: number; beta: number; vixLevelCode: number; isMarketHours: number;
    // Computed features (4)
    volWeightedRsi: number; hVolWeightedRsi: number;
    atrExpansionRate: number; fundingSlope: number;
}

// ============================================================
// Indicator Functions
// ============================================================

function emaArray(values: number[], period: number): number[] {
    if (values.length === 0) return [];
    const k = 2 / (period + 1);
    const result = [values[0]];
    for (let i = 1; i < values.length; i++) {
        result.push(values[i] * k + result[i - 1] * (1 - k));
    }
    return result;
}

function smaArray(values: number[], period: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < values.length; i++) {
        if (i < period - 1) { result.push(values[i]); continue; }
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += values[j];
        result.push(sum / period);
    }
    return result;
}

function computeRSI(closes: number[], period: number = 14): number[] {
    const rsiValues: number[] = new Array(closes.length).fill(50);
    if (closes.length < period + 1) return rsiValues;

    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) avgGain += diff; else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;

    rsiValues[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
        rsiValues[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return rsiValues;
}

function computeMACD(closes: number[]): { macdLine: number[]; signalLine: number[]; histogram: number[]; crossover: number } {
    const ema12 = emaArray(closes, 12);
    const ema26 = emaArray(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = emaArray(macdLine, 9);
    const histogram = macdLine.map((v, i) => v - signalLine[i]);

    // Crossover: check last 2 bars
    const n = macdLine.length;
    let crossover = 0;
    if (n >= 2) {
        const prevAbove = macdLine[n - 2] > signalLine[n - 2];
        const currAbove = macdLine[n - 1] > signalLine[n - 1];
        if (!prevAbove && currAbove) crossover = 1;  // bullish
        else if (prevAbove && !currAbove) crossover = -1;  // bearish
    }

    return { macdLine, signalLine, histogram, crossover };
}

// Mirrors Swift ADX.computeFull() — Wilder smoothing on +DM/-DM/TR, then ADX is
// Wilder-smoothed DX across all history. Previous version returned raw DX over last 28 bars.
function computeADX(candles: Candle[], period: number = 14): { adx: number; plusDI: number; minusDI: number } | null {
    if (candles.length < period * 2 + 1) return null;
    const plusDMs: number[] = [];
    const minusDMs: number[] = [];
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const upMove = candles[i].high - candles[i - 1].high;
        const downMove = candles[i - 1].low - candles[i].low;
        plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
        const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }

    let smoothedPlus = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let smoothedMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let smoothedTR = trs.slice(0, period).reduce((a, b) => a + b, 0);

    const dxValues: { dx: number; plusDI: number; minusDI: number }[] = [];
    for (let i = period; i < plusDMs.length; i++) {
        smoothedPlus = smoothedPlus - smoothedPlus / period + plusDMs[i];
        smoothedMinus = smoothedMinus - smoothedMinus / period + minusDMs[i];
        smoothedTR = smoothedTR - smoothedTR / period + trs[i];
        if (smoothedTR === 0) continue;
        const plusDI = (smoothedPlus / smoothedTR) * 100;
        const minusDI = (smoothedMinus / smoothedTR) * 100;
        const diSum = plusDI + minusDI;
        const dx = diSum !== 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
        dxValues.push({ dx, plusDI, minusDI });
    }

    if (dxValues.length < period) return null;
    let adx = dxValues.slice(0, period).reduce((s, v) => s + v.dx, 0) / period;
    for (let i = period; i < dxValues.length; i++) {
        adx = (adx * (period - 1) + dxValues[i].dx) / period;
    }
    const last = dxValues[dxValues.length - 1];
    return { adx, plusDI: last.plusDI, minusDI: last.minusDI };
}

// Mirrors Swift ATR.compute() — Wilder smoothing over full TR series.
// Previous version was simple mean of last 14 TRs, which ran 2-3× higher during recent volatility.
function computeATR(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) return candles[candles.length - 1]?.close * 0.01 || 1;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

function computeStochRSI(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14, kSmooth: number = 3, dSmooth: number = 3): { k: number; d: number; crossover: number } {
    const rsiValues = computeRSI(closes, rsiPeriod);
    if (rsiValues.length < stochPeriod) return { k: 50, d: 50, crossover: 0 };

    const stochK: number[] = [];
    for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
        const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
        const min = Math.min(...window);
        const max = Math.max(...window);
        stochK.push(max === min ? 50 : ((rsiValues[i] - min) / (max - min)) * 100);
    }

    const smoothK = smaArray(stochK, kSmooth);
    const smoothD = smaArray(smoothK, dSmooth);

    const k = smoothK[smoothK.length - 1] ?? 50;
    const d = smoothD[smoothD.length - 1] ?? 50;

    let crossover = 0;
    if (smoothK.length >= 2 && smoothD.length >= 2) {
        const prevK = smoothK[smoothK.length - 2];
        const prevD = smoothD[smoothD.length - 2];
        if (prevK <= prevD && k > d) crossover = 1;
        else if (prevK >= prevD && k < d) crossover = -1;
    }

    return { k, d, crossover };
}

function computeBollingerBands(closes: number[], period: number = 20, stdDev: number = 2): { percentB: number; squeeze: boolean; bandwidth: number } {
    if (closes.length < period) return { percentB: 0.5, squeeze: false, bandwidth: 0 };

    const window = closes.slice(-period);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);

    const upper = mean + stdDev * std;
    const lower = mean - stdDev * std;
    const price = closes[closes.length - 1];

    const bandwidth = mean > 0 ? (upper - lower) / mean : 0;
    const percentB = upper === lower ? 0.5 : (price - lower) / (upper - lower);

    // Squeeze: bandwidth below 20-period average bandwidth
    const bbWidths: number[] = [];
    for (let i = period; i <= closes.length; i++) {
        const w = closes.slice(i - period, i);
        const m = w.reduce((a, b) => a + b, 0) / period;
        const v = w.reduce((a, b) => a + (b - m) ** 2, 0) / period;
        const s = Math.sqrt(v);
        bbWidths.push(m > 0 ? (2 * stdDev * s) / m : 0);
    }
    const avgBW = bbWidths.length >= 20
        ? bbWidths.slice(-20).reduce((a, b) => a + b, 0) / 20
        : bandwidth;
    const squeeze = bandwidth < avgBW * 0.75;

    // Return bandwidth as percentage (× 100) to match iOS BollingerBands.compute(),
    // which is what the training data used.
    return { percentB, squeeze, bandwidth: bandwidth * 100 };
}

function computeVolumeRatio(volumes: number[], period: number = 20): number {
    if (volumes.length < period) return 1.0;
    const avg = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
    return avg > 0 ? volumes[volumes.length - 1] / avg : 1.0;
}

function computeVWAP(candles: Candle[], period: number = 20): number | null {
    if (candles.length < period) return null;
    const recent = candles.slice(-period);
    let cumPV = 0, cumVol = 0;
    for (const c of recent) {
        const tp = (c.high + c.low + c.close) / 3;
        cumPV += tp * c.volume;
        cumVol += c.volume;
    }
    return cumVol > 0 ? cumPV / cumVol : null;
}

function detectDivergence(closes: number[], rsiValues: number[], lookback: number = 14): number {
    if (closes.length < lookback + 2 || rsiValues.length < lookback + 2) return 0;
    const n = closes.length;
    const priceTrend = closes[n - 1] - closes[n - lookback];
    const rsiTrend = rsiValues[n - 1] - rsiValues[n - lookback];
    // Bullish divergence: price lower, RSI higher
    if (priceTrend < 0 && rsiTrend > 5) return 1;
    // Bearish divergence: price higher, RSI lower
    if (priceTrend > 0 && rsiTrend < -5) return -1;
    return 0;
}

function computeOBVTrend(candles: Candle[], lookback: number = 10): boolean {
    if (candles.length < lookback + 1) return false;
    let obv = 0;
    const obvValues: number[] = [0];
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].close > candles[i - 1].close) obv += candles[i].volume;
        else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume;
        obvValues.push(obv);
    }
    const n = obvValues.length;
    return obvValues[n - 1] > obvValues[n - lookback];
}

function computeADLineTrend(candles: Candle[], lookback: number = 10): boolean {
    if (candles.length < lookback + 1) return false;
    let adLine = 0;
    const values: number[] = [0];
    for (let i = 1; i < candles.length; i++) {
        const hl = candles[i].high - candles[i].low;
        const mfm = hl > 0 ? ((candles[i].close - candles[i].low) - (candles[i].high - candles[i].close)) / hl : 0;
        adLine += mfm * candles[i].volume;
        values.push(adLine);
    }
    const n = values.length;
    return values[n - 1] > values[n - lookback];
}

function computeATRPercentile(candles: Candle[], atrPeriod: number = 14): number {
    if (candles.length < atrPeriod + 50) return 50;
    const atrValues: number[] = [];
    for (let i = atrPeriod; i < candles.length; i++) {
        let sum = 0;
        for (let j = i - atrPeriod + 1; j <= i; j++) {
            const h = candles[j].high, l = candles[j].low, pc = candles[j - 1].close;
            sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
        atrValues.push(sum / atrPeriod);
    }
    const current = atrValues[atrValues.length - 1];
    const sorted = [...atrValues].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= current);
    return (rank / sorted.length) * 100;
}

// Faithful port of iOS ScoringFunction.score() — matches ScoringParams.cryptoDefault / stockDefault.
// The raw integer score feeds tfAlignment (75 tree splits in v9).
function computeScore(candles: Candle[], isCrypto: boolean): number {
    const closes = candles.map(c => c.close);
    const price = closes[closes.length - 1];
    const pp = isCrypto ? 1 : 3;   // pricePositionWeight
    const es = isCrypto ? 0 : 1;   // emaSlopeWeight
    const st = 1;                   // structureWeight
    const sc = isCrypto ? 1 : 0;   // stackConfirmWeight
    const rsiW = 3, macdW = 3;

    let score = 0;
    const ema20 = emaArray(closes, 20);
    const ema50 = emaArray(closes, 50);
    const ema200 = emaArray(closes, 200);
    const e20 = ema20[ema20.length - 1];
    const e50 = ema50[ema50.length - 1];
    const e200 = ema200[ema200.length - 1];
    const stackBull = e20 > e50 && e50 > e200;
    const stackBear = e20 < e50 && e50 < e200;
    const regime = stackBull ? 'bullish' : stackBear ? 'bearish' : 'mixed';

    // 1a: Price position (unsigned count 0-3)
    let emaCross = 0;
    if (price > e20) emaCross++;
    if (price > e50) emaCross++;
    if (price > e200) emaCross++;
    switch (emaCross) {
        case 3: score += pp; break;
        case 2: score += Math.max(1, pp - 1); break;
        case 1: score -= Math.max(1, pp - 1); break;
        case 0: score -= pp; break;
    }

    // 1b: EMA20 slope (stocks only)
    if (es > 0 && ema20.length >= 6) {
        score += e20 > ema20[ema20.length - 6] ? es : -es;
    }

    // 1c: Structure (approximated from stack — matches extractFeatures)
    if (stackBull) score += st; else if (stackBear) score -= st;

    // 1d: Stack confirm
    if (stackBull) score += sc; else if (stackBear) score -= sc;

    // Layer 2: ADX (tiered weights)
    const adxResult = computeADX(candles);
    const adxVal = adxResult?.adx ?? 0;
    const adxBull = adxResult ? adxResult.plusDI > adxResult.minusDI : false;
    if (adxVal >= 40)      score += adxBull ? 3 : -3;
    else if (adxVal >= 30) score += adxBull ? 2 : -2;
    else if (adxVal >= 20) score += adxBull ? 1 : -1;

    // Layer 3: RSI (regime-aware with adaptive thresholds)
    const rsiValues = computeRSI(closes);
    const r = rsiValues[rsiValues.length - 1];
    const atrPtile = computeATRPercentile(candles);
    let volScalar = 1.0;
    if (atrPtile > 80) volScalar = 0.75;
    else if (atrPtile > 60) volScalar = 0.90;
    else if (atrPtile < 20) volScalar = 1.35;
    else if (atrPtile < 40) volScalar = 1.15;

    if (regime === 'bullish') {
        if (r < 40) score += rsiW;
        else if (r < 50) score += Math.max(1, rsiW - 1);
    } else if (regime === 'bearish') {
        if (r > 60) score -= rsiW;
        else if (r > 50) score -= Math.max(1, rsiW - 1);
    } else {
        const rsiOB = Math.min(75, 70 + (volScalar - 1) * 15);
        const rsiBull = Math.min(60, 55 + (volScalar - 1) * 15);
        const rsiOS = Math.max(25, 30 - (volScalar - 1) * 15);
        const rsiBear = Math.max(40, 45 - (volScalar - 1) * 15);
        if (r > rsiOB) score += rsiW;
        else if (r > rsiBull) score += Math.max(1, rsiW - 1);
        else if (r < rsiOS) score -= rsiW;
        else if (r < rsiBear) score -= Math.max(1, rsiW - 1);
    }

    // Layer 4: MACD (ADX-gated, dead zone, crossover-aware)
    const macdResult = computeMACD(closes);
    const hist = macdResult.histogram[macdResult.histogram.length - 1];
    const atrVal = computeATR(candles);
    const deadZone = atrVal * 0.05;
    if (adxVal >= 20 && Math.abs(hist) > deadZone) {
        const mw = adxVal >= 30 ? macdW : Math.max(1, macdW - 1);
        if (hist > 0) score += macdResult.crossover === 1 ? mw : Math.max(mw - 1, 0);
        else          score -= macdResult.crossover === -1 ? mw : Math.max(mw - 1, 0);
    }

    return score;
}

// ============================================================
// Extract features for one timeframe
// ============================================================

interface TimeframeFeatures {
    rsi: number; macdHist: number; adx: number; adxBullish: number;
    emaCross: number; stackBull: number; stackBear: number;
    structBull: number; structBear: number;
    stochK: number; stochCross: number; macdCross: number;
    divergence: number; ema20Rising: number;
    bbPercentB: number; bbSqueeze: number; bbBandwidth: number;
    volumeRatio: number; aboveVwap: number;
    score: number;
}

function extractFeatures(candles: Candle[], isCrypto: boolean): TimeframeFeatures {
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const price = closes[closes.length - 1];

    // EMA
    const ema20 = emaArray(closes, 20);
    const ema50 = emaArray(closes, 50);
    const ema200 = emaArray(closes, 200);
    const e20 = ema20[ema20.length - 1];
    const e50 = ema50[ema50.length - 1];
    const e200 = ema200[ema200.length - 1];

    let emaCross = 0;
    if (price > e20) emaCross++; else emaCross--;
    if (price > e50) emaCross++; else emaCross--;
    if (price > e200) emaCross++; else emaCross--;

    const stackBull = e20 > e50 && e50 > e200;
    const stackBear = e20 < e50 && e50 < e200;

    // RSI
    const rsiValues = computeRSI(closes);
    const rsi = rsiValues[rsiValues.length - 1];

    // MACD
    const macdResult = computeMACD(closes);
    const macdHist = macdResult.histogram[macdResult.histogram.length - 1];

    // ADX
    const adxResult = computeADX(candles);
    const adx = adxResult?.adx ?? 0;
    const adxBullish = adxResult ? (adxResult.plusDI > adxResult.minusDI ? 1 : 0) : 0;

    // StochRSI
    const stochRSI = computeStochRSI(closes);

    // Bollinger Bands
    const bb = computeBollingerBands(closes);

    // Volume ratio
    const volRatio = computeVolumeRatio(volumes);

    // VWAP
    const vwap = computeVWAP(candles);
    const aboveVwap = vwap ? (price > vwap ? 1 : 0) : 0;

    // EMA20 rising (6-bar slope)
    const ema20Rising = ema20.length >= 6 && ema20[ema20.length - 1] > ema20[ema20.length - 6] ? 1 : 0;

    // Divergence
    const divergence = detectDivergence(closes, rsiValues);

    // Score
    const score = computeScore(candles, isCrypto);

    return {
        rsi, macdHist, adx, adxBullish,
        emaCross, stackBull: stackBull ? 1 : 0, stackBear: stackBear ? 1 : 0,
        structBull: stackBull ? 1 : 0, structBear: stackBear ? 1 : 0,
        stochK: stochRSI.k, stochCross: stochRSI.crossover, macdCross: macdResult.crossover,
        divergence, ema20Rising,
        bbPercentB: bb.percentB, bbSqueeze: bb.squeeze ? 1 : 0, bbBandwidth: bb.bandwidth,
        volumeRatio: volRatio, aboveVwap,
        score,
    };
}

// ============================================================
// Master: compute all 51 features from 3 timeframes
// ============================================================

export interface DerivativesSignals {
    fundingSignal: number; oiSignal: number; takerSignal: number;
    crowdingSignal: number; derivativesCombined: number;
    fundingRateRaw?: number; oiChangePct?: number;
    takerRatioRaw?: number; longPctRaw?: number;
}

export interface SentimentSignals {
    fearGreedIndex: number; fearGreedZone: number;
    ethBtcRatio: number; ethBtcDelta6: number;
    basisPct?: number;
}

export interface PreviousSnapshot {
    dRsi: number; dAdx: number; hRsi: number; hAdx: number; hMacdHist: number;
    hRsiD1?: number; hMacdD1?: number; dRsiD1?: number; dAdxD1?: number;
}

export interface MacroSignals {
    vix: number; dxyAboveEma20: number;
}

// Volume Profile: POC, Value Area High/Low from candle volume distribution
function computeVolumeProfile(candles: Candle[], atr: number): { poc: number; vah: number; val: number } | null {
    if (candles.length < 10 || atr <= 0) return null;
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (const c of candles) { rangeHigh = Math.max(rangeHigh, c.high); rangeLow = Math.min(rangeLow, c.low); }
    const totalRange = rangeHigh - rangeLow;
    if (totalRange <= 0) return null;

    const bucketSize = atr * 0.25;
    const bucketCount = Math.max(10, Math.min(100, Math.ceil(totalRange / bucketSize)));
    const actualBucket = totalRange / bucketCount;
    const buckets = new Array(bucketCount).fill(0);
    const n = candles.length;

    const bi = (p: number) => Math.max(0, Math.min(bucketCount - 1, Math.floor((p - rangeLow) / actualBucket)));

    for (let idx = 0; idx < n; idx++) {
        const c = candles[idx];
        const bodyTop = Math.max(c.open, c.close), bodyBot = Math.min(c.open, c.close);
        const bodyRange = bodyTop - bodyBot, candleRange = c.high - c.low;
        if (candleRange <= 0 || c.volume <= 0) continue;

        let vol = c.volume;
        if (idx === n - 1 && n > 1 && vol < candles[n - 2].volume * 0.7) vol *= 1.5;
        vol *= Math.pow(0.97, n - 1 - idx); // time decay

        const bodyShare = Math.max(0.5, bodyRange / candleRange);
        const bodyVol = vol * bodyShare, wickVol = vol * (1 - bodyShare);
        const typical = (c.high + c.low + c.close) / 3;

        // Body: Gaussian toward typical price
        const bStart = bi(bodyBot), bEnd = bi(bodyTop);
        const sigma = (bEnd - bStart + 1) * 0.4;
        let weights: number[] = [], tw = 0;
        for (let i = bStart; i <= bEnd; i++) {
            const bc = rangeLow + (i + 0.5) * actualBucket;
            const d = sigma > 0 ? (bc - typical) / (sigma * actualBucket) : 0;
            const w = Math.exp(-0.5 * d * d);
            weights.push(w); tw += w;
        }
        if (tw > 0) for (let j = 0; j <= bEnd - bStart; j++) buckets[bStart + j] += bodyVol * weights[j] / tw;

        // Wicks: uniform
        const wStart = bi(c.low), wEnd = bi(c.high);
        const perWick = wickVol / Math.max(1, wEnd - wStart + 1);
        for (let i = wStart; i <= wEnd; i++) buckets[i] += perWick;
    }

    // POC
    let maxIdx = 0;
    for (let i = 1; i < bucketCount; i++) if (buckets[i] > buckets[maxIdx]) maxIdx = i;
    const poc = rangeLow + (maxIdx + 0.5) * actualBucket;

    // Value area: expand from POC until 70%
    const totalVol = buckets.reduce((a, b) => a + b, 0);
    const target = totalVol * 0.7;
    let captured = buckets[maxIdx], lo = maxIdx, hi = maxIdx;
    while (captured < target && (lo > 0 || hi < bucketCount - 1)) {
        const belowVol = lo > 0 ? buckets[lo - 1] : 0;
        const aboveVol = hi < bucketCount - 1 ? buckets[hi + 1] : 0;
        if (belowVol >= aboveVol && lo > 0) { lo--; captured += buckets[lo]; }
        else if (hi < bucketCount - 1) { hi++; captured += buckets[hi]; }
        else if (lo > 0) { lo--; captured += buckets[lo]; }
        else break;
    }
    return { poc, vah: rangeLow + (hi + 1) * actualBucket, val: rangeLow + lo * actualBucket };
}

export function computeAllFeatures(
    dailyCandles: Candle[],
    fourHCandles: Candle[],
    oneHCandles: Candle[],
    isCrypto: boolean,
    derivatives: DerivativesSignals,
    macro: MacroSignals,
    sentiment?: SentimentSignals,
    prevSnapshot?: PreviousSnapshot
): FullFeatures {
    const daily = extractFeatures(dailyCandles, isCrypto);
    const fourH = fourHCandles.length >= 210 ? extractFeatures(fourHCandles, isCrypto) : null;
    const oneH = oneHCandles.length >= 30 ? extractFeatures(oneHCandles, isCrypto) : null;

    // atrPercent is from 4H ATR (matches iOS BacktestEngine line 498 which trained the model).
    // atrPercentile stays on daily (iOS BacktestEngine line 499).
    const price = dailyCandles[dailyCandles.length - 1]?.close;
    if (!price || price <= 0) return {} as FullFeatures;
    const atrVal = computeATR(dailyCandles); // still used for daily-scale features (volume profile, etc.)
    const fourHAtr = fourHCandles.length >= 15 ? computeATR(fourHCandles) : atrVal;
    const fourHPrice = fourHCandles[fourHCandles.length - 1]?.close || price;
    const atrPercent = (fourHAtr / fourHPrice) * 100;
    const atrPercentile = computeATRPercentile(dailyCandles);

    // Vol scalar from daily ATR percentile
    let volScalar = 1.0;
    if (atrPercentile > 80) volScalar = 0.75;
    else if (atrPercentile > 60) volScalar = 0.90;
    else if (atrPercentile < 20) volScalar = 1.35;
    else if (atrPercentile < 40) volScalar = 1.15;

    // Candle patterns from 4H (or daily fallback)
    const patternCandles = fourHCandles.length >= 3 ? fourHCandles : dailyCandles;
    const n = patternCandles.length;
    const last3Green = n >= 3 && patternCandles[n - 1].close > patternCandles[n - 1].open
        && patternCandles[n - 2].close > patternCandles[n - 2].open
        && patternCandles[n - 3].close > patternCandles[n - 3].open ? 1 : 0;
    const last3Red = n >= 3 && patternCandles[n - 1].close < patternCandles[n - 1].open
        && patternCandles[n - 2].close < patternCandles[n - 2].open
        && patternCandles[n - 3].close < patternCandles[n - 3].open ? 1 : 0;
    const last3VolIncreasing = n >= 3 && patternCandles[n - 1].volume > patternCandles[n - 2].volume
        && patternCandles[n - 2].volume > patternCandles[n - 3].volume ? 1 : 0;

    // OBV + A/D (stock only)
    const obvRising = !isCrypto ? (computeOBVTrend(dailyCandles) ? 1 : 0) : 0;
    const adLineAccumulation = !isCrypto ? (computeADLineTrend(dailyCandles) ? 1 : 0) : 0;

    return {
        // Daily
        dRsi: daily.rsi, dMacdHist: daily.macdHist, dAdx: daily.adx, dAdxBullish: daily.adxBullish,
        dEmaCross: daily.emaCross, dStackBull: daily.stackBull, dStackBear: daily.stackBear,
        dStructBull: daily.structBull, dStructBear: daily.structBear,
        dStochK: daily.stochK, dStochCross: daily.stochCross, dMacdCross: daily.macdCross,
        dDivergence: daily.divergence, dEma20Rising: daily.ema20Rising,
        dBBPercentB: daily.bbPercentB, dBBSqueeze: daily.bbSqueeze, dBBBandwidth: daily.bbBandwidth,
        dVolumeRatio: daily.volumeRatio, dAboveVwap: daily.aboveVwap,
        // 4H
        hRsi: fourH?.rsi ?? 50, hMacdHist: fourH?.macdHist ?? 0, hAdx: fourH?.adx ?? 0, hAdxBullish: fourH?.adxBullish ?? 0,
        hEmaCross: fourH?.emaCross ?? 0, hStackBull: fourH?.stackBull ?? 0, hStackBear: fourH?.stackBear ?? 0,
        hStructBull: fourH?.structBull ?? 0, hStructBear: fourH?.structBear ?? 0,
        hStochK: fourH?.stochK ?? 50, hStochCross: fourH?.stochCross ?? 0, hMacdCross: fourH?.macdCross ?? 0,
        hDivergence: fourH?.divergence ?? 0, hEma20Rising: fourH?.ema20Rising ?? 0,
        hBBPercentB: fourH?.bbPercentB ?? 0.5, hBBSqueeze: fourH?.bbSqueeze ?? 0, hBBBandwidth: fourH?.bbBandwidth ?? 0,
        hVolumeRatio: fourH?.volumeRatio ?? 1.0, hAboveVwap: fourH?.aboveVwap ?? 0,
        // 1H
        eRsi: oneH?.rsi ?? 50, eEmaCross: oneH?.emaCross ?? 0,
        eStochK: oneH?.stochK ?? 50, eMacdHist: oneH?.macdHist ?? 0,
        // Derivatives
        fundingSignal: derivatives.fundingSignal, oiSignal: derivatives.oiSignal,
        takerSignal: derivatives.takerSignal, crowdingSignal: derivatives.crowdingSignal,
        derivativesCombined: derivatives.derivativesCombined,
        // Derivatives raw
        fundingRateRaw: derivatives.fundingRateRaw ?? 0,
        oiChangePct: derivatives.oiChangePct ?? 0,
        takerRatioRaw: derivatives.takerRatioRaw ?? 1.0,
        longPctRaw: derivatives.longPctRaw ?? 50,
        // Macro
        vix: macro.vix, dxyAboveEma20: macro.dxyAboveEma20, volScalarML: volScalar,
        // Candle patterns
        last3Green, last3Red, last3VolIncreasing,
        // Stock-only
        obvRising, adLineAccumulation,
        // Context
        atrPercent, atrPercentile,
        // Cross-timeframe interactions
        tfAlignment: (() => {
            const ds = daily.score, hs = fourH?.score ?? 0;
            let a = 0;
            if (ds > 3) a += 1; else if (ds < -3) a -= 1;
            if (hs > 3) a += 1; else if (hs < -3) a -= 1;
            return a;
        })(),
        momentumAlignment: (daily.macdHist > 0 && (fourH?.macdHist ?? 0) > 0) ? 1 :
                           (daily.macdHist < 0 && (fourH?.macdHist ?? 0) < 0) ? -1 : 0,
        structureAlignment: (daily.structBull && (fourH?.structBull ?? 0)) ? 1 :
                            (daily.structBear && (fourH?.structBear ?? 0)) ? -1 : 0,
        // Temporal
        dayOfWeek: new Date().getDay(),
        barsSinceRegimeChange: 0, // would need KV state tracking
        regimeCode: (daily.adx > 25 && (daily.stackBull || daily.stackBear)) ? 2 : daily.adx < 20 ? 0 : 1,
        // Rate-of-change
        dRsiDelta: prevSnapshot ? daily.rsi - prevSnapshot.dRsi : 0,
        dAdxDelta: prevSnapshot ? daily.adx - prevSnapshot.dAdx : 0,
        hRsiDelta: prevSnapshot ? (fourH?.rsi ?? 50) - prevSnapshot.hRsi : 0,
        hAdxDelta: prevSnapshot ? (fourH?.adx ?? 0) - prevSnapshot.hAdx : 0,
        hMacdHistDelta: prevSnapshot ? (fourH?.macdHist ?? 0) - prevSnapshot.hMacdHist : 0,
        // Sentiment
        fearGreedIndex: sentiment?.fearGreedIndex ?? 50,
        fearGreedZone: sentiment?.fearGreedZone ?? 0,
        // Cross-asset crypto
        ethBtcRatio: sentiment?.ethBtcRatio ?? 0,
        ethBtcDelta6: sentiment?.ethBtcDelta6 ?? 0,
        // Volume profile — POC/VA computed on daily candles, but ATR-normalized distances
        // use 4H ATR (matches iOS BacktestEngine lines 557-572 that produced the training CSVs).
        ...(() => {
            const vp = computeVolumeProfile(dailyCandles, atrVal);
            const normAtr = fourHAtr;
            if (!vp || normAtr <= 0) return { vpDistToPocATR: 0, vpAbovePoc: 1, vpVAWidth: 0, vpInValueArea: 1, vpDistToVAH_ATR: 0, vpDistToVAL_ATR: 0 };
            return {
                vpDistToPocATR: (price - vp.poc) / normAtr,
                vpAbovePoc: price > vp.poc ? 1 : 0,
                vpVAWidth: (vp.vah - vp.val) / price * 100,
                vpInValueArea: (price >= vp.val && price <= vp.vah) ? 1 : 0,
                vpDistToVAH_ATR: (vp.vah - price) / normAtr,
                vpDistToVAL_ATR: (price - vp.val) / normAtr,
            };
        })(),
        // 1-bar deltas + acceleration
        hRsiDelta1: prevSnapshot ? (fourH?.rsi ?? 50) - prevSnapshot.hRsi : 0,
        hMacdHistDelta1: prevSnapshot ? (fourH?.macdHist ?? 0) - prevSnapshot.hMacdHist : 0,
        dRsiDelta1: prevSnapshot ? daily.rsi - prevSnapshot.dRsi : 0,
        hRsiAccel: prevSnapshot?.hRsiD1 !== undefined ? ((fourH?.rsi ?? 50) - prevSnapshot.hRsi) - prevSnapshot.hRsiD1 : 0,
        hMacdAccel: prevSnapshot?.hMacdD1 !== undefined ? ((fourH?.macdHist ?? 0) - prevSnapshot.hMacdHist) - prevSnapshot.hMacdD1 : 0,
        dAdxAccel: prevSnapshot?.dAdxD1 !== undefined ? (daily.adx - prevSnapshot.dAdx) - prevSnapshot.dAdxD1 : 0,
        // Time-of-day
        hourBucket: (() => { const h = new Date().getUTCHours(); return h < 8 ? 0 : h < 14 ? 1 : h < 21 ? 2 : 3; })(),
        isWeekend: new Date().getDay() === 0 || new Date().getDay() === 6 ? 1 : 0,
        // Basis
        basisPct: sentiment?.basisPct ?? 0,
        basisExtreme: (sentiment?.basisPct ?? 0) > 0.5 ? 1 : (sentiment?.basisPct ?? 0) < -0.5 ? -1 : 0,
        // Stock features (defaults — not computed on worker)
        fiftyTwoWeekPct: 50, distToFiftyTwoHigh: 0,
        gapPercent: 0, gapFilled: 0, gapDirectionAligned: 0,
        relStrengthVsSpy: 0, beta: 1.0,
        vixLevelCode: macro.vix < 15 ? 0 : macro.vix < 25 ? 1 : macro.vix < 35 ? 2 : 3,
        isMarketHours: 1,
        // Computed features
        volWeightedRsi: daily.rsi * daily.volumeRatio,
        hVolWeightedRsi: (fourH?.rsi ?? 50) * (fourH?.volumeRatio ?? 1.0),
        atrExpansionRate: 0, // needs previous bar's atrPercent
        fundingSlope: 0,     // needs previous bar's fundingRate
    };
}
