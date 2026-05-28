// Full 80-feature computation for server-side ML predictions.
// Mirrors Swift IndicatorEngine.computeAll() + BacktestEngine MLFeatures extraction.

import earningsData from './earnings_history.json';

export interface Candle {
    time: number; open: number; high: number; low: number; close: number; volume: number;
}

// Earnings calendar — bundled JSON, parsed once into Date->ms-epoch sorted arrays per symbol.
// Mirrors iOS EarningsCalendar.swift.
const EARNINGS_TS: Record<string, number[]> = (() => {
    const out: Record<string, number[]> = {};
    for (const [sym, dates] of Object.entries(earningsData as Record<string, string[]>)) {
        out[sym] = dates.map(d => Date.parse(d + 'T00:00:00Z')).sort((a, b) => a - b);
    }
    return out;
})();

/** Returns earningsProximity = exp(-min(daysTo, daysSince) / 7), 0 if >=60 days from any earnings.
 *  Matches iOS BacktestEngine logic (lines 752-756). */
function earningsProximityFor(symbol: string, atMs: number): number {
    const ts = EARNINGS_TS[symbol];
    if (!ts || ts.length === 0) return 0;
    let next = -1, prev = -1;
    for (const t of ts) {
        if (t >= atMs) { next = t; break; }
        prev = t;
    }
    const daysTo = next < 0 ? 60 : Math.min(60, Math.max(0, Math.floor((next - atMs) / 86400000)));
    const daysSince = prev < 0 ? 60 : Math.min(60, Math.max(0, Math.floor((atMs - prev) / 86400000)));
    const nearest = Math.min(daysTo, daysSince);
    return nearest >= 60 ? 0 : Math.exp(-nearest / 7);
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
    // Earnings (1)
    earningsProximity: number;
    // Dark pool (2)
    shortVolumeRatio: number; shortVolumeZScore: number;
    // Derivatives interactions (2)
    oiPriceInteraction: number; fundingSlope: number;
    // Candle structure (1)
    bodyWickRatio: number;
    // Cross-market breadth & macro momentum (4)
    relStrengthVsSector: number; vixTermStructure: number;
    dxyMomentum: number; iwmSpyRatio: number;
    // Computed features (3)
    volWeightedRsi: number; hVolWeightedRsi: number;
    atrExpansionRate: number;
}

// ============================================================
// Indicator Functions
// ============================================================

// EMA with SMA seed, matching iOS MovingAverages.computeEMA exactly.
// iOS returns an array of length `values.length - period + 1`: index 0 is the SMA of the
// first `period` values, then exponential smoothing for each subsequent point. Seeding from
// values[0] (the previous implementation) drifted noticeably for long lookbacks like the
// 200-EMA where the warmup transient never fully decayed across 300 daily bars.
function emaArray(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    let initial = 0;
    for (let i = 0; i < period; i++) initial += values[i];
    initial /= period;
    const result = [initial];
    for (let i = period; i < values.length; i++) {
        const prev = result[result.length - 1];
        result.push((values[i] - prev) * k + prev);
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

/**
 * Round to N decimal places, matching iOS `Double.rounded(toPlaces:)` semantics
 * (banker's rounding via Foundation, but we use round-half-away-from-zero to match
 * Swift's default `.toNearestOrEven` only matters at exact half — empirically, all
 * iOS indicator rounding sites use the default rounded() which is half-away-from-zero).
 *
 * iOS rounds indicator outputs at fixed precisions to match the values the model was
 * TRAINED on (BacktestEngine produces these features for CSV training data, then the
 * model is fit). Worker MUST round to the same precision or live ML inputs differ
 * from training canonical → diverging predictions.
 *
 * iOS rounding map (mirrors CryptoLens/Indicators/*):
 *   - RSI:               2dp  (RSI.swift)
 *   - MACD line/sig/hist: 2dp  (MACD.swift)
 *   - ADX / +DI / -DI:   2dp  (ADX.swift)
 *   - BB upper/mid/low:  2dp  (BollingerBands.swift)
 *   - BB %B / bandwidth: 4dp  (BollingerBands.swift)
 *   - StochRSI K/D:      2dp  (StochasticRSI.swift)
 *   - VWAP:              2dp  (VWAP.swift)
 *   - EMA 20/50/200:     2dp  (ComputeAll.swift)
 *   - volumeRatio:       2dp  (ComputeAll.swift)
 */
function r2(x: number): number {
    return Math.round(x * 100) / 100;
}
function r4(x: number): number {
    return Math.round(x * 10000) / 10000;
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

    rsiValues[period] = r2(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
        rsiValues[i] = r2(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return rsiValues;
}

function computeMACD(closes: number[]): { macdLine: number[]; signalLine: number[]; histogram: number[]; crossover: number } {
    const ema12 = emaArray(closes, 12);
    const ema26 = emaArray(closes, 26);
    // RAW macd/signal kept full precision so histogram = r2(rawMacd - rawSignal).
    // iOS MACD.swift comment: "from raw values to avoid compounding rounding".
    // Align trailing: emaArray now returns length closes.length - period + 1, so the two
    // EMAs have different lengths. Take the trailing minLen from each so equal indices
    // refer to the same bar (matches MACD.swift lines 10-14).
    const minLen = Math.min(ema12.length, ema26.length);
    const ema12Aligned = ema12.slice(ema12.length - minLen);
    const ema26Aligned = ema26.slice(ema26.length - minLen);
    const rawMacd = ema12Aligned.map((v, i) => v - ema26Aligned[i]);
    const rawSignal = emaArray(rawMacd, 9);
    // After signal EMA, signalLine has fewer points than rawMacd; trail-align them too so
    // histogram[i] = rawMacd[macdEnd] - rawSignal[sigEnd] for the same bar.
    const sigLen = rawSignal.length;
    const macdTrailed = rawMacd.slice(rawMacd.length - sigLen);
    const macdLine = macdTrailed.map(r2);
    const signalLine = rawSignal.map(r2);
    const histogram = macdTrailed.map((v, i) => r2(v - rawSignal[i]));

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
    // Round to 2dp to match iOS ADX.swift lines 55-58.
    return { adx: r2(adx), plusDI: r2(last.plusDI), minusDI: r2(last.minusDI) };
}

// Mirrors Swift ATR.compute() — Wilder smoothing over full TR series.
// Previous version was simple mean of last 14 TRs, which ran 2-3× higher during recent volatility.
export function computeATR(candles: Candle[], period: number = 14): number {
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
    // Returns RAW. iOS ATR.swift exposes both rounded `atr` field (2dp) and uses RAW for
    // atrPercent (4dp). Callers round at the use site to mirror iOS field-level rounding.
    return atr;
}

/** Helper: caller rounds ATR for VP/feature output. */
function atrRounded2dp(candles: Candle[], period: number = 14): number {
    return r2(computeATR(candles, period));
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

    // Round to 2dp to match iOS StochasticRSI.swift line 57.
    return { k: r2(k), d: r2(d), crossover };
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

    // iOS BollingerBands.swift uses bandwidth in PERCENT units (× 100); both bandwidth and
    // avgBW must be percent so the squeeze threshold compares like-with-like.
    const bandwidth = mean > 0 ? ((upper - lower) / mean) * 100 : 0;
    const percentB = upper === lower ? 0.5 : (price - lower) / (upper - lower);

    // Squeeze: bandwidth below average bandwidth of the last 120 bars × 0.5. Matches iOS
    // BollingerBands.swift lines 17-34. Returns false if fewer than 120 bars are available.
    let squeeze = false;
    if (closes.length >= 120) {
        const bandwidths: number[] = [];
        for (let i = 0; i < 120; i++) {
            const idx = closes.length - 120 + i;
            if (idx >= period) {
                const w = closes.slice(idx - period + 1, idx + 1);
                const m = w.reduce((a, b) => a + b, 0) / period;
                const v = w.reduce((a, b) => a + (b - m) ** 2, 0) / period;
                const s = Math.sqrt(v);
                bandwidths.push(m > 0 ? ((2 * stdDev * s) / m) * 100 : 0);
            }
        }
        if (bandwidths.length > 0) {
            const avgBW = bandwidths.reduce((a, b) => a + b, 0) / bandwidths.length;
            squeeze = bandwidth < avgBW * 0.5;
        }
    }

    // Bandwidth is already percent (× 100 above); just round to 4dp to match iOS
    // BollingerBands.swift lines 41-42.
    return { percentB: r4(percentB), squeeze, bandwidth: r4(bandwidth) };
}

function computeVolumeRatio(volumes: number[], period: number = 20): number {
    if (volumes.length < period) return 1.0;
    const avg = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
    // Round to 2dp to match iOS ComputeAll.swift line 98.
    return avg > 0 ? r2(volumes[volumes.length - 1] / avg) : 1.0;
}

/** Port of iOS MarketStructure.analyze (Indicators/MarketStructure.swift).
 *  Returns "bullish" / "bearish" / "range" / "expanding" / "contracting" based on last 2 swing highs/lows.
 *  Used to derive structBull/structBear features (the model trained on iOS-computed values, not EMA stack).
 *  N-bar pivot lookback=3, requires >= 11 candles. */
function marketStructureLabel(candles: Candle[], lookback: number = 3): 'bullish' | 'bearish' | 'expanding' | 'contracting' | 'range' | 'insufficient' {
    if (candles.length < lookback * 2 + 5) return 'insufficient';
    const swingHighs: number[] = [];
    const swingLows: number[] = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
        const cur = candles[i];
        let isHi = true, isLo = true;
        for (let j = i - lookback; j < i; j++) {
            if (candles[j].high >= cur.high) isHi = false;
            if (candles[j].low <= cur.low) isLo = false;
        }
        if (isHi) for (let j = i + 1; j <= i + lookback; j++) if (candles[j].high >= cur.high) { isHi = false; break; }
        if (isLo) for (let j = i + 1; j <= i + lookback; j++) if (candles[j].low <= cur.low) { isLo = false; break; }
        if (isHi) swingHighs.push(cur.high);
        if (isLo) swingLows.push(cur.low);
    }
    if (swingHighs.length < 2 || swingLows.length < 2) return 'insufficient';
    const h1 = swingHighs[swingHighs.length - 2], h2 = swingHighs[swingHighs.length - 1];
    const l1 = swingLows[swingLows.length - 2], l2 = swingLows[swingLows.length - 1];
    const hh = h2 > h1, hl = l2 > l1, lh = h2 < h1, ll = l2 < l1;
    if (hh && hl) return 'bullish';
    if (ll && lh) return 'bearish';
    if (hh && ll) return 'expanding';
    if (lh && hl) return 'contracting';
    return 'range';
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
    // Round to 2dp to match iOS VWAP.swift line 25.
    return cumVol > 0 ? r2(cumPV / cumVol) : null;
}

// Port of iOS RSIDivergence.detect (Indicators/RSIDivergence.swift). Looks for swing
// peaks/troughs in the last `lookback` bars (a point lower than 2 bars on each side
// for a low, higher for a high) and compares the last two:
//   bullish = price made a lower low while RSI made a higher low
//   bearish = price made a higher high while RSI made a lower high
// Worker previously used a simple slope comparison which produced different signals.
function detectDivergence(closes: number[], rsiValues: number[], lookback: number = 20): number {
    if (closes.length < lookback || rsiValues.length < lookback) return 0;
    const rc = closes.slice(-lookback);
    const rr = rsiValues.slice(-lookback);

    const priceLows: number[] = [];
    const rsiAtLows: number[] = [];
    const priceHighs: number[] = [];
    const rsiAtHighs: number[] = [];

    for (let i = 2; i < rc.length - 2; i++) {
        if (rc[i] < rc[i - 1] && rc[i] < rc[i - 2] && rc[i] < rc[i + 1] && rc[i] < rc[i + 2]) {
            priceLows.push(rc[i]);
            rsiAtLows.push(rr[i]);
        }
        if (rc[i] > rc[i - 1] && rc[i] > rc[i - 2] && rc[i] > rc[i + 1] && rc[i] > rc[i + 2]) {
            priceHighs.push(rc[i]);
            rsiAtHighs.push(rr[i]);
        }
    }

    if (priceLows.length >= 2 && rsiAtLows.length >= 2
        && priceLows[priceLows.length - 1] < priceLows[priceLows.length - 2]
        && rsiAtLows[rsiAtLows.length - 1] > rsiAtLows[rsiAtLows.length - 2]) {
        return 1;
    }
    if (priceHighs.length >= 2 && rsiAtHighs.length >= 2
        && priceHighs[priceHighs.length - 1] > priceHighs[priceHighs.length - 2]
        && rsiAtHighs[rsiAtHighs.length - 1] < rsiAtHighs[rsiAtHighs.length - 2]) {
        return -1;
    }
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
    /// Last EMA values (2dp-rounded) and VWAP value. Used by computeAllFeatures to recompute
    /// d/h/eEmaCross and *AboveVwap against the 4H reference price (matches BacktestEngine
    /// which uses fourHCandles[i].close for all three timeframes' price-position comparisons).
    e20: number; e50: number; e200: number;
    vwapValue: number | null;
}

export type { TimeframeFeatures };
export function extractFeatures(candles: Candle[], isCrypto: boolean, timeframe: 'daily' | '4h' | '1h' = 'daily'): TimeframeFeatures {
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const price = closes[closes.length - 1];

    // EMA — scalars rounded to 2dp to match iOS ComputeAll.swift lines 93-95.
    // Internal arrays stay full precision (used for trend slope checks below).
    const ema20 = emaArray(closes, 20);
    const ema50 = emaArray(closes, 50);
    const ema200 = emaArray(closes, 200);
    const e20 = r2(ema20[ema20.length - 1]);
    const e50 = r2(ema50[ema50.length - 1]);
    const e200 = r2(ema200[ema200.length - 1]);

    // BacktestEngine MLFeatures produces a signed -3..+3 sum for d/h/eEmaCross
    // (lines 576-582, 607-613, 646-650): +1 above, -1 below, summed across e20/e50/e200.
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
    // Session-anchored VWAP — matches iOS ComputeAll.swift:56-67.
    // 1H: 24 candles (1 day), 4H: 6 candles (1 day), Daily: 20 candles (~1 month).
    const vwapSession = timeframe === '1h' ? 24 : timeframe === '4h' ? 6 : 20;
    const vwap = computeVWAP(candles, vwapSession);
    const aboveVwap = vwap ? (price > vwap ? 1 : 0) : 0;

    // EMA20 rising (6-bar slope)
    const ema20Rising = ema20.length >= 6 && ema20[ema20.length - 1] > ema20[ema20.length - 6] ? 1 : 0;

    // Divergence
    const divergence = detectDivergence(closes, rsiValues);

    // Score
    const score = computeScore(candles, isCrypto);

    // Real swing-based market structure (matches iOS MarketStructure.analyze).
    const structLabel = marketStructureLabel(candles);
    const structBull = structLabel === 'bullish' ? 1 : 0;
    const structBear = structLabel === 'bearish' ? 1 : 0;

    return {
        rsi, macdHist, adx, adxBullish,
        emaCross, stackBull: stackBull ? 1 : 0, stackBear: stackBear ? 1 : 0,
        structBull, structBear,
        stochK: stochRSI.k, stochCross: stochRSI.crossover, macdCross: macdResult.crossover,
        divergence, ema20Rising,
        bbPercentB: bb.percentB, bbSqueeze: bb.squeeze ? 1 : 0, bbBandwidth: bb.bandwidth,
        volumeRatio: volRatio, aboveVwap,
        score,
        e20, e50, e200,
        vwapValue: vwap ?? null,
    };
}

// ============================================================
// Master: compute all 51 features from 3 timeframes
// ============================================================

const SECTOR_ETF_MAP: Record<string, string[]> = {
    XLK: ['AAPL', 'MSFT', 'NVDA', 'AMD', 'ORCL', 'ADBE', 'INTC', 'CSCO', 'AVGO', 'QCOM', 'MU', 'AMAT', 'LRCX', 'MRVL', 'CRM', 'NFLX',
          'NOW', 'INTU', 'CRWD', 'PANW', 'FTNT', 'SNOW', 'DDOG', 'NET', 'ZS', 'WDAY', 'TEAM', 'MDB',
          'TXN', 'KLAC', 'ON', 'MCHP'],
    XLF: ['JPM', 'GS', 'MS', 'BAC', 'WFC', 'BLK', 'SCHW', 'MA', 'V', 'SQ',
          'AXP', 'C', 'COF', 'USB', 'PNC', 'CME', 'ICE', 'AIG', 'PYPL'],
    XLE: ['XOM', 'OXY', 'FANG', 'CVX', 'SLB', 'COP', 'EOG', 'PSX', 'VLO'],
    XLV: ['UNH', 'LLY', 'ABBV', 'JNJ', 'PFE', 'MRK', 'TMO', 'REGN', 'VRTX', 'GILD', 'BIIB',
          'AMGN', 'BMY', 'ABT', 'MDT', 'DHR', 'ISRG', 'BSX', 'SYK', 'CVS', 'ELV'],
    XLY: ['TSLA', 'HD', 'DIS', 'NKE', 'SBUX', 'MCD', 'WMT', 'COST', 'AMZN', 'ROKU', 'SHOP', 'PLTR', 'SNAP', 'COIN', 'RBLX', 'BYND', 'GME',
          'UBER', 'ABNB', 'BKNG', 'DASH', 'F', 'GM',
          'LOW', 'TGT', 'TJX', 'CMG', 'MAR', 'HLT', 'MGM'],
    XLI: ['CAT', 'DE', 'X', 'BA', 'LMT', 'RTX', 'GD', 'UNP', 'FDX', 'DAL',
          'HON', 'MMM', 'GE', 'EMR', 'ETN', 'ITW', 'PH', 'NOC'],
    XLC: ['T', 'VZ', 'CMCSA', 'GOOGL', 'META', 'TMUS', 'CHTR', 'SPOT'],
    XLRE: ['SPG', 'O', 'AMT', 'EQIX', 'PLD', 'CCI', 'PSA'],
};
const ETF_SET = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'XLE', 'XLF', 'XLK', 'XLV', 'XLY', 'XLI', 'XLC', 'XLRE', 'XLP', 'XLU', 'GLD', 'TLT', 'HYG', 'VXX']);

export function sectorETFForSymbol(symbol: string): string | null {
    if (ETF_SET.has(symbol)) return null;
    for (const [etf, symbols] of Object.entries(SECTOR_ETF_MAP)) {
        if (symbols.includes(symbol)) return etf;
    }
    return null;
}

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
    fundingHist?: number[];
    /// 7-bar lookback windows (oldest-first, length 7 when full). Worker computes
    /// `*Delta = current - hist[0]` to match BacktestEngine's `current - history[count-7]`.
    /// Empty / undefined when fewer than 7 historical bars have been observed — worker
    /// returns 0 in that case to match iOS canonical.
    dRsiHist7?: number[];
    dAdxHist7?: number[];
    hRsiHist7?: number[];
    hAdxHist7?: number[];
    hMacdHistHist7?: number[];
    /// Previous bar's regimeCode and barsSinceRegimeChange counter. Worker increments by 1
    /// when current regime equals previous (capped at 100), resets to 0 when it differs.
    /// Mirrors BacktestEngine.swift lines 437-443 where these counters are tracked across
    /// iterations.
    prevRegimeCode?: number;
    prevBarsSinceRegimeChange?: number;
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
    prevSnapshot?: PreviousSnapshot,
    spyCandles: Candle[] = [],
    darkPool?: { ratio: number; zscore: number },
    iwmCandles: Candle[] = [],
    sectorETFCandles: Candle[] = [],
    dxyCandles: Candle[] = [],
    vix3mPrice: number = 0,
    symbol: string = '',
    /// Evaluation time in epoch ms. Used for time-of-day buckets and earnings proximity
    /// lookups so the worker matches iOS BacktestEngine's `evalTime` semantics. Defaults
    /// to Date.now() (the live cron behaviour).
    evalTimeMs: number = Date.now(),
): FullFeatures {
    const daily = extractFeatures(dailyCandles, isCrypto, 'daily');
    const fourH = fourHCandles.length >= 210 ? extractFeatures(fourHCandles, isCrypto, '4h') : null;
    const oneH = oneHCandles.length >= 30 ? extractFeatures(oneHCandles, isCrypto, '1h') : null;

    // atrPercent is from 4H ATR (matches iOS BacktestEngine line 498 which trained the model).
    // atrPercentile stays on daily (iOS BacktestEngine line 499).
    const price = dailyCandles[dailyCandles.length - 1]?.close;
    if (!price || price <= 0) return {} as FullFeatures;
    // Raw ATRs for atrPercent computation (iOS uses local raw atr at line 18).
    const atrValRaw = computeATR(dailyCandles);
    const fourHAtrRaw = fourHCandles.length >= 15 ? computeATR(fourHCandles) : atrValRaw;
    // 2dp-rounded ATRs for downstream feature-output usage (matches iOS atrVal.atr field
    // which is rounded — this value cascades into VP bucket sizing).
    const atrVal = r2(atrValRaw);
    const fourHAtr = r2(fourHAtrRaw);
    const fourHPrice = fourHCandles[fourHCandles.length - 1]?.close || price;
    // atrPercent: 4dp-rounded, but computed from RAW ATR matching iOS line 18.
    const atrPercent = r4((fourHAtrRaw / fourHPrice) * 100);
    // Compute raw atrPercentile (full precision) for volScalar formula, then round for the
    // feature output (iOS VolatilityRegime line 161 rounds to integer for the feature, but
    // ComputeAll.swift line 156-159 uses the RAW unrounded percentile for volScalar).
    const rawAtrPercentile = computeATRPercentile(dailyCandles);
    const atrPercentile = Math.round(rawAtrPercentile);

    // Vol scalar — linear interpolation from 0.75 (at 0%) to 1.35 (at 100%), clamped.
    // Matches iOS ComputeAll.swift line 159: max(0.75, min(1.35, 0.75 + (rawPct/100)*0.6)).
    // Was a bucketed lookup which produced step-function values that didn't match training.
    const volScalar = Math.max(0.75, Math.min(1.35, 0.75 + (rawAtrPercentile / 100.0) * 0.6));

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

    // Recompute d/h/eEmaCross using 4H close as the comparison price (matches BacktestEngine
    // lines 576-582, 607-613, 646-650). The TimeframeFeatures.emaCross from extractFeatures
    // uses each timeframe's own last close, which diverges from BacktestEngine when 1H/daily
    // last-close ≠ 4H last-close (different drop semantics across timeframes).
    const emaCrossSigned = (e20: number, e50: number, e200: number, p: number): number => {
        let c = 0;
        c += p > e20 ? 1 : -1;
        c += p > e50 ? 1 : -1;
        c += p > e200 ? 1 : -1;
        return c;
    };
    const dEmaCrossX = emaCrossSigned(daily.e20, daily.e50, daily.e200, fourHPrice);
    const hEmaCrossX = fourH ? emaCrossSigned(fourH.e20, fourH.e50, fourH.e200, fourHPrice) : 0;
    const eEmaCrossX = oneH ? emaCrossSigned(oneH.e20, oneH.e50, oneH.e200, fourHPrice) : 0;
    // Same fix for *AboveVwap: BacktestEngine uses fourHCandles[i].close as the comparison
    // price (line 603, 643, oneH not exposed). Worker previously used each timeframe's own
    // last-close which diverged from canonical when timeframes had different drop semantics.
    const vwapAbove = (vw: number | null, p: number): number => vw !== null ? (p > vw ? 1 : 0) : 0;
    const dAboveVwapX = vwapAbove(daily.vwapValue, fourHPrice);
    const hAboveVwapX = fourH ? vwapAbove(fourH.vwapValue, fourHPrice) : 0;

    return {
        // Daily
        dRsi: daily.rsi, dMacdHist: daily.macdHist, dAdx: daily.adx, dAdxBullish: daily.adxBullish,
        dEmaCross: dEmaCrossX, dStackBull: daily.stackBull, dStackBear: daily.stackBear,
        dStructBull: daily.structBull, dStructBear: daily.structBear,
        dStochK: daily.stochK, dStochCross: daily.stochCross, dMacdCross: daily.macdCross,
        dDivergence: daily.divergence, dEma20Rising: daily.ema20Rising,
        dBBPercentB: daily.bbPercentB, dBBSqueeze: daily.bbSqueeze, dBBBandwidth: daily.bbBandwidth,
        dVolumeRatio: daily.volumeRatio, dAboveVwap: dAboveVwapX,
        // 4H
        hRsi: fourH?.rsi ?? 50, hMacdHist: fourH?.macdHist ?? 0, hAdx: fourH?.adx ?? 0, hAdxBullish: fourH?.adxBullish ?? 0,
        hEmaCross: hEmaCrossX, hStackBull: fourH?.stackBull ?? 0, hStackBear: fourH?.stackBear ?? 0,
        hStructBull: fourH?.structBull ?? 0, hStructBear: fourH?.structBear ?? 0,
        hStochK: fourH?.stochK ?? 50, hStochCross: fourH?.stochCross ?? 0, hMacdCross: fourH?.macdCross ?? 0,
        hDivergence: fourH?.divergence ?? 0, hEma20Rising: fourH?.ema20Rising ?? 0,
        hBBPercentB: fourH?.bbPercentB ?? 0.5, hBBSqueeze: fourH?.bbSqueeze ?? 0, hBBBandwidth: fourH?.bbBandwidth ?? 0,
        hVolumeRatio: fourH?.volumeRatio ?? 1.0, hAboveVwap: hAboveVwapX,
        // 1H
        eRsi: oneH?.rsi ?? 50, eEmaCross: eEmaCrossX,
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
        // ET-anchored day-of-week to match iOS Calendar.current and BacktestEngine.
        // new Date().getDay() returns server-local (UTC in CF Workers) which produces
        // wrong values around UTC midnight transitions when ET is still on the previous day.
        dayOfWeek: (() => {
            const wdName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(evalTimeMs));
            const map: Record<string, number> = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
            return map[wdName] ?? 0;
        })(),
        regimeCode: (daily.adx > 25 && (daily.stackBull || daily.stackBear)) ? 2 : daily.adx < 20 ? 0 : 1,
        barsSinceRegimeChange: (() => {
            const cur = (daily.adx > 25 && (daily.stackBull || daily.stackBear)) ? 2 : daily.adx < 20 ? 0 : 1;
            const prevCode = prevSnapshot?.prevRegimeCode;
            const prevBars = prevSnapshot?.prevBarsSinceRegimeChange ?? 0;
            if (prevCode === undefined) return 0;
            return cur === prevCode ? Math.min(prevBars + 1, 100) : 0;
        })(),
        // Rate-of-change — 7-bar lookback to match BacktestEngine `current - history[count-7]`.
        // hist[0] is the oldest of the 7-element window (= "7 bars ago"). length < 7 → 0.
        dRsiDelta: prevSnapshot?.dRsiHist7?.length === 7 ? daily.rsi - prevSnapshot.dRsiHist7[0] : 0,
        dAdxDelta: prevSnapshot?.dAdxHist7?.length === 7 ? daily.adx - prevSnapshot.dAdxHist7[0] : 0,
        hRsiDelta: prevSnapshot?.hRsiHist7?.length === 7 ? (fourH?.rsi ?? 50) - prevSnapshot.hRsiHist7[0] : 0,
        hAdxDelta: prevSnapshot?.hAdxHist7?.length === 7 ? (fourH?.adx ?? 0) - prevSnapshot.hAdxHist7[0] : 0,
        hMacdHistDelta: prevSnapshot?.hMacdHistHist7?.length === 7 ? (fourH?.macdHist ?? 0) - prevSnapshot.hMacdHistHist7[0] : 0,
        // Sentiment
        fearGreedIndex: sentiment?.fearGreedIndex ?? 50,
        fearGreedZone: sentiment?.fearGreedZone ?? 0,
        // Cross-asset crypto
        ethBtcRatio: sentiment?.ethBtcRatio ?? 0,
        ethBtcDelta6: sentiment?.ethBtcDelta6 ?? 0,
        // Volume profile — POC/VA computed on daily candles, ATR-normalized distances use
        // 4H ATR. Reference price is the 4H close (matches iOS BacktestEngine which evaluates
        // each bar at the 4H close timestamp; using the daily close here gave the wrong sign
        // and magnitude for vpAbovePoc / vpDistToPocATR when the 4H bar diverged from daily).
        ...(() => {
            const vpCandles = dailyCandles.slice(-30); // Match iOS: last 30 daily candles
            const vp = computeVolumeProfile(vpCandles, atrVal);
            const normAtr = fourHAtr;
            const vpPrice = fourHPrice;
            if (!vp || normAtr <= 0) return { vpDistToPocATR: 0, vpAbovePoc: 1, vpVAWidth: 0, vpInValueArea: 1, vpDistToVAH_ATR: 0, vpDistToVAL_ATR: 0 };
            return {
                vpDistToPocATR: (vpPrice - vp.poc) / normAtr,
                vpAbovePoc: vpPrice > vp.poc ? 1 : 0,
                vpVAWidth: (vp.vah - vp.val) / vpPrice * 100,
                vpInValueArea: (vpPrice >= vp.val && vpPrice <= vp.vah) ? 1 : 0,
                vpDistToVAH_ATR: (vp.vah - vpPrice) / normAtr,
                vpDistToVAL_ATR: (vpPrice - vp.val) / normAtr,
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
        // ET (America/New_York) to match iOS Calendar.current and BacktestEngine training canonical.
        // Was UTC, which produced different bucket values than the training pipeline.
        hourBucket: (() => {
            const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
            const h = parseInt(fmt.format(new Date(evalTimeMs)).replace(/[^\d]/g, '')) || 0;
            return h < 8 ? 0 : h < 14 ? 1 : h < 21 ? 2 : 3;
        })(),
        isWeekend: (() => {
            const wdName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(evalTimeMs));
            return (wdName === 'Sat' || wdName === 'Sun') ? 1 : 0;
        })(),
        // Basis
        basisPct: sentiment?.basisPct ?? 0,
        basisExtreme: (sentiment?.basisPct ?? 0) > 0.5 ? 1 : (sentiment?.basisPct ?? 0) < -0.5 ? -1 : 0,
        // Stock features — match BacktestEngine line 778 / 785 which require dailyIdx >= 252
        // (i.e. at least 252 daily bars in the lookback) before computing real 52-week.
        // Below threshold both default (50 / 0).
        fiftyTwoWeekPct: (() => {
            if (isCrypto || dailyCandles.length < 252) return 50;
            const lookback = dailyCandles.slice(-252);
            const hi = Math.max(...lookback.map(c => c.high));
            const lo = Math.min(...lookback.map(c => c.low));
            return hi !== lo ? (price - lo) / (hi - lo) * 100 : 50;
        })(),
        distToFiftyTwoHigh: (() => {
            if (isCrypto || dailyCandles.length < 252) return 0;
            const lookback = dailyCandles.slice(-252);
            const hi = Math.max(...lookback.map(c => c.high));
            return hi > 0 ? (hi - price) / price * 100 : 0;
        })(),
        gapPercent: (() => {
            if (isCrypto || dailyCandles.length < 2) return 0;
            const prev = dailyCandles[dailyCandles.length - 2].close;
            const todayOpen = dailyCandles[dailyCandles.length - 1].open;
            return prev > 0 ? (todayOpen - prev) / prev * 100 : 0;
        })(),
        gapFilled: (() => {
            if (isCrypto || dailyCandles.length < 2) return 0;
            const prev = dailyCandles[dailyCandles.length - 2].close;
            const todayOpen = dailyCandles[dailyCandles.length - 1].open;
            const gapUp = todayOpen > prev;
            return (gapUp ? price <= prev : price >= prev) ? 1 : 0;
        })(),
        gapDirectionAligned: (() => {
            if (isCrypto || dailyCandles.length < 2) return 0;
            const prev = dailyCandles[dailyCandles.length - 2].close;
            const todayOpen = dailyCandles[dailyCandles.length - 1].open;
            const gapPct = (todayOpen - prev) / prev * 100;
            if (Math.abs(gapPct) < 0.3) return 0;
            const score = computeScore(dailyCandles, isCrypto);
            return (gapPct > 0) === (score > 0) ? 1 : -1;
        })(),
        relStrengthVsSpy: (() => {
            if (isCrypto || spyCandles.length < 6 || dailyCandles.length < 6) return 0;
            const stockRet = (dailyCandles[dailyCandles.length - 1].close - dailyCandles[dailyCandles.length - 6].close) / dailyCandles[dailyCandles.length - 6].close * 100;
            const spyRet = (spyCandles[spyCandles.length - 1].close - spyCandles[spyCandles.length - 6].close) / spyCandles[spyCandles.length - 6].close * 100;
            return stockRet - spyRet;
        })(),
        beta: (() => {
            if (isCrypto || spyCandles.length < 60 || dailyCandles.length < 60) return 1.0;
            const n = 60;
            const stockSlice = dailyCandles.slice(-n);
            const spySlice = spyCandles.slice(-n);
            if (stockSlice.length < 2 || spySlice.length < 2) return 1.0;
            const stockReturns: number[] = [];
            for (let i = 1; i < stockSlice.length; i++) stockReturns.push((stockSlice[i].close - stockSlice[i-1].close) / stockSlice[i-1].close);
            const spyReturns: number[] = [];
            for (let i = 1; i < spySlice.length; i++) spyReturns.push((spySlice[i].close - spySlice[i-1].close) / spySlice[i-1].close);
            const pairs = Math.min(stockReturns.length, spyReturns.length);
            if (pairs < 10) return 1.0;
            const sr = stockReturns.slice(0, pairs), mr = spyReturns.slice(0, pairs);
            const meanS = sr.reduce((a, b) => a + b, 0) / pairs;
            const meanM = mr.reduce((a, b) => a + b, 0) / pairs;
            let cov = 0, varM = 0;
            for (let j = 0; j < pairs; j++) { cov += (sr[j] - meanS) * (mr[j] - meanM); varM += (mr[j] - meanM) * (mr[j] - meanM); }
            return varM > 0 ? cov / varM : 1.0;
        })(),
        vixLevelCode: macro.vix < 15 ? 0 : macro.vix < 25 ? 1 : macro.vix < 35 ? 2 : 3,
        isMarketHours: 1,
        // Earnings — computed from bundled earnings_history.json (matches iOS BacktestEngine).
        earningsProximity: isCrypto ? 0 : earningsProximityFor(symbol, evalTimeMs),
        // Dark pool — passed via darkPool param
        shortVolumeRatio: darkPool?.ratio ?? 0.5,
        shortVolumeZScore: darkPool?.zscore ?? 0,
        // Derivatives interactions
        oiPriceInteraction: (() => {
            if (!isCrypto || !derivatives.oiChangePct) return 0;
            const candles4H = fourHCandles;
            if (candles4H.length < 2) return 0;
            const pricePct = (candles4H[candles4H.length - 1].close - candles4H[candles4H.length - 2].close) / candles4H[candles4H.length - 2].close * 100;
            return (derivatives.oiChangePct || 0) * pricePct;
        })(),
        fundingSlope: (() => {
            if (!isCrypto) return 0;
            // Match BacktestEngine: append current fr to prev history, cap at 4. iOS appends
            // even with no prev history (single-bar window then), so we always include fr.
            const fr = derivatives?.fundingRateRaw ?? 0;
            const prev = prevSnapshot?.fundingHist ?? [];
            const hist = [...prev, fr].slice(-4);
            if (hist.length < 3) return 0;
            const n = hist.length;
            const xMean = (n - 1) / 2;
            const yMean = hist.reduce((a: number, b: number) => a + b, 0) / n;
            let num = 0, den = 0;
            for (let j = 0; j < n; j++) { const x = j - xMean; num += x * (hist[j] - yMean); den += x * x; }
            return den > 0 ? num / den : 0;
        })(),
        // Candle structure
        bodyWickRatio: (() => {
            const candles4H = fourHCandles;
            const n = Math.min(5, candles4H.length);
            if (n === 0) return 0.5;
            let sum = 0, count = 0;
            for (let j = candles4H.length - n; j < candles4H.length; j++) {
                const c = candles4H[j];
                const range = c.high - c.low;
                if (range > 0) { sum += Math.abs(c.close - c.open) / range; count++; }
            }
            return count > 0 ? sum / count : 0.5;
        })(),
        // Cross-market breadth & macro momentum
        relStrengthVsSector: (() => {
            if (isCrypto || sectorETFCandles.length < 6 || dailyCandles.length < 6) return 0;
            const stockRet = (dailyCandles[dailyCandles.length - 1].close - dailyCandles[dailyCandles.length - 6].close) / dailyCandles[dailyCandles.length - 6].close * 100;
            const sectorRet = (sectorETFCandles[sectorETFCandles.length - 1].close - sectorETFCandles[sectorETFCandles.length - 6].close) / sectorETFCandles[sectorETFCandles.length - 6].close * 100;
            return stockRet - sectorRet;
        })(),
        vixTermStructure: (() => {
            const vixVal = macro.vix;
            if (!vix3mPrice || vix3mPrice <= 0) return 1.0;
            return vixVal / vix3mPrice;
        })(),
        dxyMomentum: (() => {
            if (dxyCandles.length < 6) return 0;
            const current = dxyCandles[dxyCandles.length - 1].close;
            const fiveDaysAgo = dxyCandles[dxyCandles.length - 6].close;
            if (fiveDaysAgo <= 0) return 0;
            return (current - fiveDaysAgo) / fiveDaysAgo * 100;
        })(),
        iwmSpyRatio: (() => {
            if (iwmCandles.length < 6 || spyCandles.length < 6) return 0;
            const iwmRet = (iwmCandles[iwmCandles.length - 1].close - iwmCandles[iwmCandles.length - 6].close) / iwmCandles[iwmCandles.length - 6].close * 100;
            const spyRet = (spyCandles[spyCandles.length - 1].close - spyCandles[spyCandles.length - 6].close) / spyCandles[spyCandles.length - 6].close * 100;
            return iwmRet - spyRet;
        })(),
        // Computed features
        volWeightedRsi: daily.rsi * daily.volumeRatio,
        hVolWeightedRsi: (fourH?.rsi ?? 50) * (fourH?.volumeRatio ?? 1.0),
        atrExpansionRate: 0,
    };
}
