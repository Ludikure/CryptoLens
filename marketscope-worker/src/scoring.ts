// Simplified scoring for server-side score notifications.
// ~80% accurate vs full Swift ComputeAll — captures core signal (EMA + RSI + MACD + ADX).
// Missing: divergence, volume profile, cross-asset, derivatives, VWAP (crypto), regime-aware RSI.

export interface Candle {
    time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface ScoreResult {
    score: number;
    bias: string;  // "Bullish" | "Bearish" | "Neutral"
}

function ema(closes: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const result = [closes[0]];
    for (let i = 1; i < closes.length; i++) {
        result.push(closes[i] * k + result[i - 1] * (1 - k));
    }
    return result;
}

function rsi(closes: number[], period: number = 14): number | null {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - (100 / (1 + rs));
}

function macd(closes: number[]): { histogram: number; signal: number; macd: number } | null {
    if (closes.length < 35) return null;
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine: number[] = [];
    for (let i = 0; i < closes.length; i++) {
        macdLine.push(ema12[i] - ema26[i]);
    }
    const signalLine = ema(macdLine, 9);
    const m = macdLine[macdLine.length - 1];
    const s = signalLine[signalLine.length - 1];
    return { macd: m, signal: s, histogram: m - s };
}

function adx(candles: Candle[]): { adx: number; plusDI: number; minusDI: number } | null {
    if (candles.length < 28) return null;
    const period = 14;
    let atrSum = 0, plusDMSum = 0, minusDMSum = 0;

    for (let i = candles.length - period * 2; i < candles.length; i++) {
        const h = candles[i].high, l = candles[i].low;
        const ph = candles[i - 1].high, pl = candles[i - 1].low, pc = candles[i - 1].close;
        const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        const plusDM = h - ph > pl - l ? Math.max(h - ph, 0) : 0;
        const minusDM = pl - l > h - ph ? Math.max(pl - l, 0) : 0;
        atrSum += tr; plusDMSum += plusDM; minusDMSum += minusDM;
    }

    if (atrSum === 0) return null;
    const plusDI = (plusDMSum / atrSum) * 100;
    const minusDI = (minusDMSum / atrSum) * 100;
    if (plusDI + minusDI === 0) return null;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    return { adx: dx, plusDI, minusDI };
}

function atr(candles: Candle[], period: number = 14): number | null {
    if (candles.length < period + 1) return null;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
        const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
        sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    return sum / period;
}

export function computeScore(candles: Candle[], isCrypto: boolean): ScoreResult {
    const closes = candles.map(c => c.close);
    const price = closes[closes.length - 1];

    // Params (match Swift ScoringParams defaults)
    const pp = isCrypto ? 1 : 3;
    const sc = isCrypto ? 1 : 0;
    const st = 1;
    const rsiW = 3;
    const macdW = 3;

    let score = 0;

    // EMA Stack
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const ema200 = ema(closes, 200);
    const e20 = ema20[ema20.length - 1];
    const e50 = ema50[ema50.length - 1];
    const e200 = ema200[ema200.length - 1];

    const stackBull = e20 > e50 && e50 > e200;
    const stackBear = e20 < e50 && e50 < e200;

    // EMA Stack Confirm (SC)
    if (stackBull) score += sc;
    else if (stackBear) score -= sc;

    // Price Position (PP)
    let aboveCount = 0;
    if (price > e20) aboveCount++; if (price <= e20) aboveCount--;
    if (price > e50) aboveCount++; if (price <= e50) aboveCount--;
    if (price > e200) aboveCount++; if (price <= e200) aboveCount--;
    if (aboveCount === 3) score += pp;
    else if (aboveCount === -3) score -= pp;
    else if (aboveCount >= 1) score += Math.max(1, pp - 1);
    else if (aboveCount <= -1) score -= Math.max(1, pp - 1);

    // Market Structure (ST) — simplified: use EMA stack as proxy
    if (stackBull) score += st;
    else if (stackBear) score -= st;

    // RSI
    const rsiVal = rsi(closes);
    if (rsiVal !== null) {
        const rsiOB = stackBear ? 60 : 70;
        if (rsiVal > rsiOB) score -= rsiW;
        else if (rsiVal < 30) score += rsiW;
        else if (rsiVal > 60 && stackBull) score += Math.max(1, rsiW - 1);
        else if (rsiVal < 40 && stackBear) score -= Math.max(1, rsiW - 1);
    }

    // MACD
    const macdResult = macd(closes);
    if (macdResult) {
        const atrVal = atr(candles) || price * 0.01;
        const deadZone = atrVal * 0.05;
        if (Math.abs(macdResult.histogram) > deadZone) {
            const adxResult = adx(candles);
            const adxGated = !adxResult || adxResult.adx >= 20;
            if (adxGated) {
                score += macdResult.histogram > 0 ? macdW : -macdW;
            }
        }
    }

    // ADX Direction
    const adxResult = adx(candles);
    if (adxResult) {
        const dir = adxResult.plusDI > adxResult.minusDI ? 1 : -1;
        if (adxResult.adx >= 40) score += dir * 3;
        else if (adxResult.adx >= 30) score += dir * 2;
        else if (adxResult.adx >= 20) score += dir * 1;
    }

    // Determine bias
    const dirThreshold = isCrypto ? 4 : 3;
    let bias = 'Neutral';
    if (score >= dirThreshold) bias = 'Bullish';
    else if (score <= -dirThreshold) bias = 'Bearish';

    return { score, bias };
}
