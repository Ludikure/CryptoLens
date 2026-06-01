// Full display-ready indicator computation — the TS port of CryptoLens IndicatorEngine.computeAll.
// Emits the complete IndicatorResult shape (scalars + chart SERIES + S/R + Fibonacci + market
// structure + candle patterns + volume profile) so the web app (and, after Phase 4, iOS) render
// from one shared implementation. Reuses the parity-tested scalar math in scoring-full.ts and the
// faithful bias scorer in scoring-ios.ts; ports the series + level logic here.
//
// Mirrors: CryptoLens/Indicators/{ComputeAll,ADX,StochasticRSI,SupportResistance,MarketStructure,
//          Fibonacci,CandlePatterns}.swift. Series are display-only (no 1e-7 parity needed);
//          scalars + bias come from the parity-tested paths.

import {
  Candle, computeRSI, computeMACD, computeBollingerBands, computeVWAP, detectDivergence,
  computeOBVTrend, computeADLineTrend, computeVolumeProfile, computeATR, emaArray, r2,
} from './scoring-full';
import { scoreSnapshot, CRYPTO_PARAMS, STOCK_PARAMS, type ScoringSnapshot } from './scoring-ios';

const last = <T>(a: T[]): T | undefined => a[a.length - 1];
const crossStr = (n: number): string | null => (n === 1 ? 'bullish' : n === -1 ? 'bearish' : null);

// ── ADX full (scalar + series) — port of ADX.computeFull ──
function adxFull(highs: number[], lows: number[], closes: number[], period = 14) {
  if (closes.length < period + 1) return null;
  const plusDM: number[] = [], minusDM: number[] = [], tr: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const sum = (a: number[]) => a.slice(0, period).reduce((x, y) => x + y, 0);
  let sP = sum(plusDM), sM = sum(minusDM), sTR = sum(tr);
  const dx: Array<{ dx: number; plusDI: number; minusDI: number }> = [];
  for (let i = period; i < plusDM.length; i++) {
    sP = sP - sP / period + plusDM[i];
    sM = sM - sM / period + minusDM[i];
    sTR = sTR - sTR / period + tr[i];
    if (sTR === 0) continue;
    const plusDI = (sP / sTR) * 100, minusDI = (sM / sTR) * 100;
    const diSum = plusDI + minusDI;
    dx.push({ dx: diSum !== 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0, plusDI, minusDI });
  }
  if (dx.length < period) return null;
  const adxSeries: number[] = [];
  let adx = dx.slice(0, period).reduce((x, d) => x + d.dx, 0) / period;
  adxSeries.push(adx);
  for (let i = period; i < dx.length; i++) { adx = (adx * (period - 1) + dx[i].dx) / period; adxSeries.push(adx); }
  const lastDX = dx[dx.length - 1];
  const adxFinal = r2(adx), plusDIFinal = r2(lastDX.plusDI), minusDIFinal = r2(lastDX.minusDI);
  const strength = adxFinal < 20 ? 'Weak/No Trend' : adxFinal < 40 ? 'Moderate Trend' : adxFinal < 60 ? 'Strong Trend' : 'Very Strong Trend';
  const diStart = dx.length - adxSeries.length;
  return {
    result: { adx: adxFinal, plusDI: plusDIFinal, minusDI: minusDIFinal, strength, direction: plusDIFinal > minusDIFinal ? 'Bullish' : 'Bearish' },
    adxSeries, plusDISeries: dx.slice(diStart).map(d => d.plusDI), minusDISeries: dx.slice(diStart).map(d => d.minusDI),
  };
}

// ── StochRSI full (scalar + series) — port of StochasticRSI.computeFull ──
function stochFull(closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsi = computeRSI(closes, rsiPeriod).filter(v => !isNaN(v));
  if (rsi.length < stochPeriod) return { result: null as any, kValues: [] as number[], dValues: [] as number[] };
  const stoch: number[] = [];
  for (let i = stochPeriod - 1; i < rsi.length; i++) {
    const w = rsi.slice(i - stochPeriod + 1, i + 1);
    const mn = Math.min(...w), mx = Math.max(...w);
    stoch.push(mx - mn === 0 ? 50 : ((rsi[i] - mn) / (mx - mn)) * 100);
  }
  if (stoch.length < kSmooth) return { result: null as any, kValues: [], dValues: [] };
  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < stoch.length; i++) kValues.push(stoch.slice(i - kSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / kSmooth);
  if (kValues.length < dSmooth) return { result: null as any, kValues, dValues: [] };
  const dValues: number[] = [];
  for (let i = dSmooth - 1; i < kValues.length; i++) dValues.push(kValues.slice(i - dSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / dSmooth);
  const rawK = last(kValues)!, rawD = last(dValues)!;
  let crossover: string | null = null;
  if (kValues.length >= 2 && dValues.length >= 2) {
    const pK = kValues[kValues.length - 2], pD = dValues[dValues.length - 2];
    if (pK <= pD && rawK > rawD) crossover = 'bullish';
    else if (pK >= pD && rawK < rawD) crossover = 'bearish';
  }
  return { result: { k: r2(rawK), d: r2(rawD), crossover }, kValues, dValues };
}

// ── Support/Resistance — port of SupportResistance.find + clusterLevels ──
function clusterLevels(levels: number[], tol: number): number[] {
  const out: number[] = [];
  for (const l of [...levels].sort((a, b) => a - b)) {
    const lastV = out[out.length - 1];
    if (lastV !== undefined && Math.abs(l - lastV) < tol) out[out.length - 1] = (lastV + l) / 2;
    else out.push(l);
  }
  return out;
}
function supportResistance(highs: number[], lows: number[], closes: number[], atr: number, lookback = 50) {
  const supports: number[] = [], resistances: number[] = [];
  for (let i = 2; i < Math.min(lookback, highs.length - 2); i++) {
    const idx = highs.length - 1 - i;
    if (idx < 2 || idx >= highs.length - 2) continue;
    if (highs[idx] > highs[idx - 1] && highs[idx] > highs[idx - 2] && highs[idx] > highs[idx + 1] && highs[idx] >= highs[idx + 2]) resistances.push(r2(highs[idx]));
    if (lows[idx] < lows[idx - 1] && lows[idx] < lows[idx - 2] && lows[idx] < lows[idx + 1] && lows[idx] <= lows[idx + 2]) supports.push(r2(lows[idx]));
  }
  const current = last(closes) ?? 0;
  const tol = atr > 0 ? atr * 0.15 : (current || 1) * 0.003;
  const cs = clusterLevels(supports, tol).filter(v => v < current).sort((a, b) => b - a).slice(0, 5);
  const cr = clusterLevels(resistances, tol).filter(v => v > current).sort((a, b) => a - b).slice(0, 5);
  return { supports: cs, resistances: cr };
}

// ── Market structure — port of MarketStructure.analyze (neutral; no strength tags) ──
function marketStructure(candles: Candle[], lookback = 3, atr = 0) {
  if (candles.length < lookback * 2 + 5) return null;
  type SP = { price: number; isHigh: boolean; index: number };
  const sh: SP[] = [], sl: SP[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isH = true, isL = true;
    for (let j = i - lookback; j < i; j++) { if (candles[j].high >= candles[i].high) isH = false; if (candles[j].low <= candles[i].low) isL = false; }
    if (isH) for (let j = i + 1; j <= i + lookback; j++) if (candles[j].high >= candles[i].high) { isH = false; break; }
    if (isL) for (let j = i + 1; j <= i + lookback; j++) if (candles[j].low <= candles[i].low) { isL = false; break; }
    if (isH) sh.push({ price: candles[i].high, isHigh: true, index: i });
    if (isL) sl.push({ price: candles[i].low, isHigh: false, index: i });
  }
  if (sh.length < 2 || sl.length < 2) return { label: 'Insufficient swings', swingHighs: [] as number[], swingLows: [] as number[], levelTests: [] as Array<{ price: number; tests: number; candlesAgo: number }> };
  const h1 = sh[sh.length - 2].price, h2 = sh[sh.length - 1].price, l1 = sl[sl.length - 2].price, l2 = sl[sl.length - 1].price;
  const HH = h2 > h1, HL = l2 > l1, LH = h2 < h1, LL = l2 < l1;
  const label = HH && HL ? 'HH/HL (bullish)' : LL && LH ? 'LL/LH (bearish)' : HH && LL ? 'HH/LL (expanding)' : LH && HL ? 'LH/HL (contracting)' : 'Range';
  const all = [...sh, ...sl].sort((a, b) => b.price - a.price);
  const total = candles.length;
  const seen = new Set<number>();
  const levelTests: Array<{ price: number; tests: number; candlesAgo: number }> = [];
  for (const sw of all) {
    if (seen.has(sw.index)) continue;
    const thr = Math.max(sw.price * 0.003, atr > 0 ? atr * 0.1 : sw.price * 0.003);
    const nearby = all.filter(s => Math.abs(s.price - sw.price) < thr);
    const tests = nearby.length;
    const avg = nearby.reduce((a, s) => a + s.price, 0) / tests;
    const mostRecent = Math.max(...nearby.map(s => s.index));
    levelTests.push({ price: avg, tests, candlesAgo: total - 1 - mostRecent });
    for (const ns of nearby) seen.add(ns.index);
  }
  levelTests.sort((a, b) => b.tests - a.tests);
  return {
    label,
    swingHighs: sh.slice(-3).reverse().map(s => s.price),
    swingLows: sl.slice(-3).reverse().map(s => s.price),
    levelTests: levelTests.slice(0, 5),
  };
}

// ── Fibonacci — port of Fibonacci.computeFromSwings / compute ──
function fibLevels(hi: number, lo: number, up: boolean) {
  const d = hi - lo;
  const r = (x: number) => r2(x);
  return up
    ? [['0.0 (swing high)', hi], ['0.236', hi - 0.236 * d], ['0.382', hi - 0.382 * d], ['0.5', hi - 0.5 * d], ['0.618', hi - 0.618 * d], ['0.786', hi - 0.786 * d], ['1.0 (swing low)', lo]].map(([n, p]) => ({ name: n as string, price: r(p as number) }))
    : [['0.0 (swing low)', lo], ['0.236', lo + 0.236 * d], ['0.382', lo + 0.382 * d], ['0.5', lo + 0.5 * d], ['0.618', lo + 0.618 * d], ['0.786', lo + 0.786 * d], ['1.0 (swing high)', hi]].map(([n, p]) => ({ name: n as string, price: r(p as number) }));
}
function fibFromSwings(swingHighs: number[], swingLows: number[], closes: number[], structureLabel = '') {
  const hi = swingHighs[0], lo = swingLows[0], current = last(closes);
  if (hi === undefined || lo === undefined || current === undefined || hi - lo === 0) return null;
  const trend = structureLabel.includes('bullish') ? 'uptrend' : structureLabel.includes('bearish') ? 'downtrend' : (current > (hi + lo) / 2 ? 'uptrend' : 'downtrend');
  const levels = fibLevels(hi, lo, trend === 'uptrend');
  const nearest = levels.reduce((a, b) => (Math.abs(b.price - current) < Math.abs(a.price - current) ? b : a));
  return { trend, swingHigh: r2(hi), swingLow: r2(lo), levels, nearestLevel: nearest.name, nearestPrice: nearest.price };
}
function fibAbsolute(highs: number[], lows: number[], closes: number[], lookback = 50) {
  if (closes.length < lookback) return null;
  const rh = highs.slice(-lookback), rl = lows.slice(-lookback);
  const hi = Math.max(...rh), lo = Math.min(...rl), current = last(closes);
  if (current === undefined || hi - lo === 0) return null;
  const up = rl.indexOf(lo) < rh.indexOf(hi);
  const levels = fibLevels(hi, lo, up);
  const nearest = levels.reduce((a, b) => (Math.abs(b.price - current) < Math.abs(a.price - current) ? b : a));
  return { trend: up ? 'uptrend' : 'downtrend', swingHigh: r2(hi), swingLow: r2(lo), levels, nearestLevel: nearest.name, nearestPrice: nearest.price };
}

// ── Candle patterns — port of CandlePatterns.detect ──
function candlePatterns(o: number[], h: number[], l: number[], c: number[]) {
  const out: Array<{ pattern: string; signal: string }> = [];
  if (c.length < 3) return out;
  const n = c.length - 1;
  const body = Math.abs(c[n] - o[n]), range = h[n] - l[n];
  if (range <= 0) return out;
  const bodyPct = body / range, upper = h[n] - Math.max(o[n], c[n]), lower = Math.min(o[n], c[n]) - l[n];
  const po = o[n - 1], pc = c[n - 1], prevBody = Math.abs(pc - po);
  if (bodyPct < 0.1) out.push({ pattern: 'Doji', signal: 'Indecision — potential reversal' });
  if (lower > 2 * body && upper < body * 0.5 && c[n] >= o[n]) out.push({ pattern: 'Hammer', signal: 'Bullish reversal signal' });
  if (upper > 2 * body && lower < body * 0.5 && c[n] >= o[n]) out.push({ pattern: 'Inverted Hammer', signal: 'Potential bullish reversal' });
  if (upper > 2 * body && lower < body * 0.5 && c[n] < o[n]) out.push({ pattern: 'Shooting Star', signal: 'Bearish reversal signal' });
  if (lower > 2 * body && upper < body * 0.5 && c[n] < o[n]) out.push({ pattern: 'Hanging Man', signal: 'Bearish reversal signal' });
  if (pc < po && c[n] > o[n] && c[n] > po && o[n] < pc && body > prevBody) out.push({ pattern: 'Bullish Engulfing', signal: 'Strong bullish reversal' });
  if (pc > po && c[n] < o[n] && c[n] < po && o[n] > pc && body > prevBody) out.push({ pattern: 'Bearish Engulfing', signal: 'Strong bearish reversal' });
  const o3 = o[n - 2], c3 = c[n - 2];
  if (c3 < o3 && Math.abs(pc - po) < Math.abs(c3 - o3) * 0.3 && c[n] > o[n] && c[n] > (o3 + c3) / 2) out.push({ pattern: 'Morning Star', signal: 'Bullish reversal (3-bar)' });
  if (c3 > o3 && Math.abs(pc - po) < Math.abs(c3 - o3) * 0.3 && c[n] < o[n] && c[n] < (o3 + c3) / 2) out.push({ pattern: 'Evening Star', signal: 'Bearish reversal (3-bar)' });
  return out;
}

// Full-precision MACD series for DISPLAY only. computeMACD rounds to 2dp to match the iOS
// ML-feature path (parity) — which zeroes out sub-cent assets (DOGE MACD ~0.0001 → 0.00 → a
// flat chart line). The display series are visual-only (no 1e-7 parity), so keep full precision
// here. Same math as computeMACD minus the r2 rounding; crossover/scalar still come from computeMACD.
function macdSeriesFull(closes: number[]): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const ema12 = emaArray(closes, 12), ema26 = emaArray(closes, 26);
  const minLen = Math.min(ema12.length, ema26.length);
  if (minLen === 0) return { macdLine: [], signalLine: [], histogram: [] };
  const a12 = ema12.slice(ema12.length - minLen), a26 = ema26.slice(ema26.length - minLen);
  const rawMacd = a12.map((v, i) => v - a26[i]);
  const rawSignal = emaArray(rawMacd, 9);
  const sigLen = rawSignal.length;
  const macdT = rawMacd.slice(rawMacd.length - sigLen);
  return { macdLine: macdT, signalLine: rawSignal, histogram: macdT.map((v, i) => v - rawSignal[i]) };
}

function bollingerBandsFull(closes: number[], period = 20, k = 2) {
  const scalar = computeBollingerBands(closes, period, k);
  if (closes.length < period) return { ...scalar, upper: null as number | null, middle: null as number | null, lower: null as number | null };
  const w = closes.slice(-period);
  const mid = w.reduce((a, b) => a + b, 0) / period;
  const variance = w.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { ...scalar, upper: r2(mid + k * sd), middle: r2(mid), lower: r2(mid - k * sd) };
}

export interface FullIndicatorOpts {
  timeframe: string; label: string; isCrypto: boolean;
  crossAssetSignal?: number; derivativesCombinedSignal?: number; // default 0 (full-analysis supplies these)
}

// Compute the full display IndicatorResult for one timeframe's candles (already closed bars).
export function computeFullIndicators(candles: Candle[], opts: FullIndicatorOpts) {
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low),
    opens = candles.map(c => c.open), volumes = candles.map(c => c.volume);
  const current = last(closes) ?? 0;
  const isDaily = opts.label.includes('Daily') || opts.label.includes('1D');
  const is4H = opts.label.includes('4H');

  const rsiArr = computeRSI(closes).filter(v => !isNaN(v));
  const rsi = last(rsiArr) ?? null;
  const divNum = rsiArr.length >= 50 ? detectDivergence(closes.slice(-50), rsiArr.slice(-50)) : 0;
  const divergence = crossStr(divNum);
  const macd = computeMACD(closes);
  const macdF = macdSeriesFull(closes);   // full-precision series for the chart (sub-cent assets)
  const macdHist = last(macd.histogram) ?? 0;
  const bb = bollingerBandsFull(closes);
  const atrVal = candles.length >= 15 ? computeATR(candles) : current * 0.01;
  const stoch = stochFull(closes);
  const adx = adxFull(highs, lows, closes);
  const vwapSession = opts.label.includes('1H') || opts.label.includes('15m') ? 24 : is4H ? 6 : isDaily ? 20 : 20;
  const vwap = computeVWAP(candles, vwapSession);
  const sr = supportResistance(highs, lows, closes, adx ? atrVal : 0);
  const ms = marketStructure(candles, 3, atrVal);
  const fib = ms && ms.swingHighs.length && ms.swingLows.length
    ? fibFromSwings(ms.swingHighs, ms.swingLows, closes, ms.label)
    : fibAbsolute(highs, lows, closes);
  const patterns = candlePatterns(opens, highs, lows, closes);

  const ema20A = emaArray(closes, 20), ema50A = emaArray(closes, 50), ema200A = emaArray(closes, 200);
  const ema20 = ema20A.length ? r2(last(ema20A)!) : null, ema50 = ema50A.length ? r2(last(ema50A)!) : null, ema200 = ema200A.length ? r2(last(ema200A)!) : null;
  const volRatio = volumes.length >= 20 ? r2((last(volumes) ?? 0) / (volumes.slice(-20).reduce((a, b) => a + b, 0) / 20)) : null;

  // EMA regime + position
  let emaCrossCount = 0; let stackBull = false, stackBear = false;
  if (ema20 !== null && ema50 !== null && ema200 !== null) {
    stackBull = ema20 > ema50 && ema50 > ema200; stackBear = ema20 < ema50 && ema50 < ema200;
    if (current > ema20) emaCrossCount++; if (current > ema50) emaCrossCount++; if (current > ema200) emaCrossCount++;
  }
  const ema20Rising = ema20A.length >= 6 && ema20A[ema20A.length - 1] > ema20A[ema20A.length - 6];

  // volScalar from 14-period ATR percentile (inline, matches ComputeAll)
  let rawAtrPctile = 50;
  if (candles.length >= 44) {
    const atrs: number[] = [];
    for (let i = 14; i < candles.length; i++) {
      let s = 0;
      for (let j = i - 13; j <= i; j++) s += Math.max(candles[j].high - candles[j].low, Math.abs(candles[j].high - candles[j - 1].close), Math.abs(candles[j].low - candles[j - 1].close));
      atrs.push(s / 14);
    }
    const cur = last(atrs)!, sorted = [...atrs].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= cur);
    rawAtrPctile = ((rank < 0 ? sorted.length : rank) / sorted.length) * 100;
  }
  const volScalar = Math.max(0.75, Math.min(1.35, 0.75 + (rawAtrPctile / 100) * 0.6));
  // ATR percentile (daily Vol Regime flag) — mirrors VolatilityRegime.atrPercentile.
  // Returns null below period+30 bars (Swift returns nil). Label from the unrounded pct.
  const atrPercentile = candles.length >= 44 ? Math.round(rawAtrPctile) : null;
  const atrPercentileLabel = candles.length >= 44
    ? (rawAtrPctile < 20 ? 'contracting — breakout likely' : rawAtrPctile > 80 ? 'expanded — mean reversion likely' : 'normal')
    : null;

  const obvRising = opts.isCrypto ? false : computeOBVTrend(candles);
  const adAccum = opts.isCrypto ? false : computeADLineTrend(candles);

  const snap: ScoringSnapshot = {
    timeframe: opts.timeframe, isCrypto: opts.isCrypto,
    ema20, ema50, ema200, emaCrossCount, ema20Rising, stackBullish: stackBull, stackBearish: stackBear,
    structureBullish: ms?.label.includes('bullish') ?? false, structureBearish: ms?.label.includes('bearish') ?? false,
    adxValue: adx?.result.adx ?? 0, adxBullish: adx?.result.direction === 'Bullish',
    rsi, macdHistogram: macdHist, macdCrossover: crossStr(macd.crossover),
    macdHistAboveDeadZone: Math.abs(macdHist) > atrVal * 0.001 * volScalar,
    stochK: stoch.result?.k ?? null, stochCrossover: stoch.result?.crossover ?? null,
    aboveVwap: vwap !== null && current > vwap, divergence,
    last3Green: candles.length >= 3 && candles.slice(-3).every(c => c.close >= c.open),
    last3Red: candles.length >= 3 && candles.slice(-3).every(c => c.close < c.open),
    last3VolIncreasing: candles.length >= 3 && (() => { const t = candles.slice(-3); return t[2].volume >= t[1].volume && t[1].volume >= t[0].volume; })(),
    currentRSI: rsi, crossAssetSignal: opts.crossAssetSignal ?? 0, volScalar,
    obvRising, adLineAccumulation: adAccum, derivativesCombinedSignal: opts.derivativesCombinedSignal ?? 0,
  };
  const params = opts.isCrypto ? CRYPTO_PARAMS : STOCK_PARAMS;
  const { score, bias } = scoreSnapshot(snap, params);
  const maxScore = opts.isCrypto && isDaily ? 21 : 18;
  const clamped = Math.min(Math.max(score, -maxScore), maxScore);
  const bullPercent = r2(((clamped / maxScore) + 1) / 2 * 100);

  // Volume profile (Daily/4H only)
  const vpLookback = is4H ? 60 : 30;
  const vp = (isDaily || is4H) ? computeVolumeProfile(candles.slice(-vpLookback), atrVal) : null;

  const tail = <T>(a: T[], n = 50) => a.slice(-n);
  return {
    timeframe: opts.timeframe, label: opts.label, price: current,
    atrPercentile, atrPercentileLabel,
    rsi, stochRSI: stoch.result, macd: { histogram: r2(macdHist), crossover: crossStr(macd.crossover) },
    adx: adx?.result ?? null, bollingerBands: bb,
    atr: { atr: r2(atrVal), atrPercent: r2(atrVal / current * 100) },
    ema20, ema50, ema200, vwap, fibonacci: fib, supportResistance: sr, candlePatterns: patterns,
    volumeRatio: volRatio, divergence, bias, bullPercent, biasScore: score,
    marketStructure: ms, volScalar, volumeProfile: vp,
    obv: opts.isCrypto ? null : { trend: obvRising ? 'Rising' : 'Falling' },
    adLine: opts.isCrypto ? null : { trend: adAccum ? 'Accumulation' : 'Distribution' },
    candles: tail(candles),
    rsiSeries: tail(rsiArr), stochKSeries: tail(stoch.kValues), stochDSeries: tail(stoch.dValues),
    macdHistSeries: tail(macdF.histogram), macdLineSeries: tail(macdF.macdLine), macdSignalSeries: tail(macdF.signalLine),
    adxSeries: adx ? tail(adx.adxSeries) : [], plusDISeries: adx ? tail(adx.plusDISeries) : [], minusDISeries: adx ? tail(adx.minusDISeries) : [],
    ema20Series: tail(ema20A), ema50Series: tail(ema50A), ema200Series: tail(ema200A),
    volumeRatioSeries: (() => { const out: number[] = []; if (volumes.length >= 20) for (let i = 19; i < volumes.length; i++) { const avg = volumes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20; out.push(avg > 0 ? volumes[i] / avg : 1); } return tail(out); })(),
  };
}
