// Faithful port of the iOS scorer — the SINGLE SOURCE OF TRUTH for the displayed bias +
// signed score + bullPercent. Mirrors:
//   CryptoLens/Services/ScoringFunction.swift  (scoreSnapshot)
//   CryptoLens/Models/ScoringParams.swift       (defaults)
//   CryptoLens/Models/ScoringSnapshot.swift      (input shape)
//
// NOTE: the worker's existing scoring.ts `computeScore` is a *simplified* 3-way scorer used
// only for the ML direction gate (~80% agreement). This module is the exact port so the web
// app (and, after Phase 4, iOS itself) display an identical bias. Deterministic, no I/O.
// Worker always uses the market defaults (no per-user param tuning server-side, matching the
// `loadSaved(...) ?? default` common case).

export interface ScoringParams {
  pricePositionWeight: number; emaSlopeWeight: number; structureWeight: number; stackConfirmWeight: number;
  adxStrongBreak: number; adxModBreak: number; adxWeakBreak: number;
  adxStrongWeight: number; adxModWeight: number; adxWeakWeight: number;
  rsiWeight: number; macdMaxWeight: number;
  vwapWeight: number; stochWeight: number; divergenceWeight: number;
  crossAssetWeight: number; derivativesWeight: number;
  dailyStrongThreshold: number; dailyDirectionalThreshold: number;
  fourHStrongThreshold: number; fourHDirectionalThreshold: number;
  useAdaptive: boolean; skipGates: boolean;
}

const BASE: ScoringParams = {
  pricePositionWeight: 2, emaSlopeWeight: 1, structureWeight: 2, stackConfirmWeight: 1,
  adxStrongBreak: 40, adxModBreak: 30, adxWeakBreak: 20,
  adxStrongWeight: 3, adxModWeight: 2, adxWeakWeight: 1,
  rsiWeight: 2, macdMaxWeight: 2,
  vwapWeight: 1, stochWeight: 1, divergenceWeight: 1,
  crossAssetWeight: 1, derivativesWeight: 1,
  dailyStrongThreshold: 7, dailyDirectionalThreshold: 4,
  fourHStrongThreshold: 6, fourHDirectionalThreshold: 3,
  useAdaptive: true, skipGates: false,
};

export const CRYPTO_PARAMS: ScoringParams = {
  ...BASE,
  pricePositionWeight: 1, emaSlopeWeight: 0, structureWeight: 1, stackConfirmWeight: 1,
  adxWeakWeight: 1, adxModWeight: 2, adxStrongWeight: 3,
  rsiWeight: 3, macdMaxWeight: 3, vwapWeight: 0, stochWeight: 0, divergenceWeight: 0,
  crossAssetWeight: 1, derivativesWeight: 1,
  dailyDirectionalThreshold: 4, dailyStrongThreshold: 8,
  fourHDirectionalThreshold: 2, fourHStrongThreshold: 4,
};

export const STOCK_PARAMS: ScoringParams = {
  ...BASE,
  pricePositionWeight: 3, emaSlopeWeight: 1, structureWeight: 1, stackConfirmWeight: 0,
  adxWeakWeight: 1, adxModWeight: 2, adxStrongWeight: 3,
  rsiWeight: 3, macdMaxWeight: 3, vwapWeight: 1, stochWeight: 0, divergenceWeight: 0,
  crossAssetWeight: 1, derivativesWeight: 0,
  dailyDirectionalThreshold: 3, dailyStrongThreshold: 7,
  fourHDirectionalThreshold: 2, fourHStrongThreshold: 4,
};

export interface ScoringSnapshot {
  timeframe: string; isCrypto: boolean;
  ema20: number | null; ema50: number | null; ema200: number | null;
  emaCrossCount: number; ema20Rising: boolean; stackBullish: boolean; stackBearish: boolean;
  structureBullish: boolean; structureBearish: boolean;
  adxValue: number; adxBullish: boolean;
  rsi: number | null; macdHistogram: number; macdCrossover: string | null;
  macdHistAboveDeadZone: boolean; stochK: number | null; stochCrossover: string | null;
  aboveVwap: boolean; divergence: string | null;
  last3Green: boolean; last3Red: boolean; last3VolIncreasing: boolean; currentRSI: number | null;
  crossAssetSignal: number; volScalar: number;
  obvRising: boolean; adLineAccumulation: boolean;
  derivativesCombinedSignal: number;
}

const imax = (a: number, b: number) => Math.max(a, b);

// Faithful port of ScoringFunction.score — returns the signed integer score + bias label.
export function scoreSnapshot(s: ScoringSnapshot, p: ScoringParams): { score: number; bias: string } {
  let score = 0;
  const isDaily = s.timeframe === '1d' || s.timeframe === 'D';
  const is4H = s.timeframe === '4h';

  const haveEmas = s.ema20 !== null && s.ema50 !== null && s.ema200 !== null;
  type Reg = 'bullish' | 'bearish' | 'mixed';
  let emaRegime: Reg = 'mixed';
  if (haveEmas) emaRegime = s.stackBullish ? 'bullish' : s.stackBearish ? 'bearish' : 'mixed';

  // Layer 1a: price position vs EMAs
  if (haveEmas) {
    switch (s.emaCrossCount) {
      case 3: score += p.pricePositionWeight; break;
      case 2: score += imax(1, p.pricePositionWeight - 1); break;
      case 1: score -= imax(1, p.pricePositionWeight - 1); break;
      case 0: score -= p.pricePositionWeight; break;
    }
  }
  // 1b EMA20 slope
  if (p.emaSlopeWeight > 0) score += s.ema20Rising ? p.emaSlopeWeight : -p.emaSlopeWeight;
  // 1c structure
  if (s.structureBullish) score += p.structureWeight;
  else if (s.structureBearish) score -= p.structureWeight;
  // 1d stack confirm
  if (s.stackBullish) score += p.stackConfirmWeight;
  else if (s.stackBearish) score -= p.stackConfirmWeight;

  // Layer 2: ADX-weighted
  if (s.adxValue >= p.adxStrongBreak) score += s.adxBullish ? p.adxStrongWeight : -p.adxStrongWeight;
  else if (s.adxValue >= p.adxModBreak) score += s.adxBullish ? p.adxModWeight : -p.adxModWeight;
  else if (s.adxValue >= p.adxWeakBreak) score += s.adxBullish ? p.adxWeakWeight : -p.adxWeakWeight;

  // Layer 3: RSI (regime-aware)
  if (s.rsi !== null) {
    const r = s.rsi;
    if (emaRegime === 'bullish') {
      if (r < 40) score += p.rsiWeight;
      else if (r < 50) score += imax(1, p.rsiWeight - 1);
    } else if (emaRegime === 'bearish') {
      if (r > 60) score -= p.rsiWeight;
      else if (r > 50) score -= imax(1, p.rsiWeight - 1);
    } else {
      const rsiOB = Math.min(75.0, 70.0 + (s.volScalar - 1.0) * 15);
      const rsiBull = Math.min(60.0, 55.0 + (s.volScalar - 1.0) * 15);
      const rsiOS = Math.max(25.0, 30.0 - (s.volScalar - 1.0) * 15);
      const rsiBear = Math.max(40.0, 45.0 - (s.volScalar - 1.0) * 15);
      if (r > rsiOB) score += p.rsiWeight;
      else if (r > rsiBull) score += imax(1, p.rsiWeight - 1);
      else if (r < rsiOS) score -= p.rsiWeight;
      else if (r < rsiBear) score -= imax(1, p.rsiWeight - 1);
    }
  }
  // MACD (ADX-weighted, dead-zone gated)
  if (s.adxValue >= p.adxWeakBreak && s.macdHistAboveDeadZone) {
    const macdWeight = s.adxValue >= p.adxModBreak ? p.macdMaxWeight : imax(1, p.macdMaxWeight - 1);
    if (s.macdHistogram > 0) score += s.macdCrossover === 'bullish' ? macdWeight : imax(macdWeight - 1, 0);
    else score -= s.macdCrossover === 'bearish' ? macdWeight : imax(macdWeight - 1, 0);
  }

  // Layer 4: confirmation
  if (p.vwapWeight > 0) score += s.aboveVwap ? p.vwapWeight : -p.vwapWeight;
  if (s.stochK !== null && !isDaily) {
    const stochLow = Math.max(5.0, 15.0 - (s.volScalar - 1.0) * 20);
    const stochHigh = Math.min(95.0, 85.0 + (s.volScalar - 1.0) * 20);
    if (s.stochK < stochLow && s.stochCrossover === 'bullish') score += p.stochWeight;
    else if (s.stochK > stochHigh && s.stochCrossover === 'bearish') score -= p.stochWeight;
  }
  if (s.divergence === 'bullish' && score < 0) score += p.divergenceWeight;
  if (s.divergence === 'bearish' && score > 0) score -= p.divergenceWeight;

  // Stock-only volume confirmation
  if (!s.isCrypto) {
    score += s.obvRising ? 1 : -1;
    score += s.adLineAccumulation ? 1 : -1;
  }
  // Layer 5/6: cross-asset + derivatives (daily crypto only)
  if (isDaily && s.isCrypto) score += s.crossAssetSignal * p.crossAssetWeight;
  if (isDaily && s.isCrypto && p.derivativesWeight > 0) score += s.derivativesCombinedSignal * p.derivativesWeight;

  // Momentum override (non-daily, mixed regime only)
  const isMixedRegime = !s.stackBullish && !s.stackBearish;
  if (!isDaily && isMixedRegime && s.currentRSI !== null && s.rsi !== null) {
    const oversold = is4H ? 30 : 35;
    const overbought = is4H ? 70 : 65;
    const overrideWeight = is4H ? 2 : 3;
    const curRSI = s.currentRSI, r = s.rsi;
    if (r < oversold && curRSI > 60 && s.last3Green && s.last3VolIncreasing) score += overrideWeight;
    if (r > overbought && curRSI < 40 && s.last3Red && s.last3VolIncreasing) score -= overrideWeight;
    if (!(r < oversold && curRSI > 60) && !(r > overbought && curRSI < 40)) {
      if (s.last3Green && s.last3VolIncreasing && curRSI > 55) score += is4H ? 1 : 2;
      if (s.last3Red && s.last3VolIncreasing && curRSI < 45) score -= is4H ? 1 : 2;
    }
  }

  // Adaptive thresholds
  let adaptiveScalar = 1.0;
  if (p.useAdaptive) {
    if (s.adxValue >= p.adxModBreak) adaptiveScalar = 1.0 / s.volScalar;
    else if (s.adxValue < p.adxWeakBreak) adaptiveScalar = s.volScalar;
    else adaptiveScalar = 1.0;
  }
  let strongThreshold: number, directionalThreshold: number;
  if (isDaily) {
    strongThreshold = Math.max(3, Math.round(p.dailyStrongThreshold * adaptiveScalar));
    directionalThreshold = Math.max(2, Math.round(p.dailyDirectionalThreshold * adaptiveScalar));
  } else if (is4H) {
    strongThreshold = Math.max(3, Math.round(p.fourHStrongThreshold * adaptiveScalar));
    directionalThreshold = Math.max(2, Math.round(p.fourHDirectionalThreshold * adaptiveScalar));
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
  if (!p.skipGates) {
    const priceBelowAll = s.emaCrossCount === 0;
    const priceAboveAll = s.emaCrossCount === 3;
    if (haveEmas) {
      if (emaRegime === 'bearish') {
        if (priceBelowAll && !s.structureBullish) {
          if (bias === 'Strong Bullish' || bias === 'Bullish' || bias === 'Neutral') bias = 'Bearish';
        } else if (bias === 'Strong Bullish' || bias === 'Bullish') bias = 'Neutral';
      } else if (emaRegime === 'bullish') {
        if (priceAboveAll && !s.structureBearish) {
          if (bias === 'Strong Bearish' || bias === 'Bearish' || bias === 'Neutral') bias = 'Bullish';
        } else if (bias === 'Strong Bearish' || bias === 'Bearish') bias = 'Neutral';
      }
    }
    // Exhaustion cap
    if (Math.abs(score) > 8 && (bias === 'Strong Bullish' || bias === 'Strong Bearish')) {
      bias = bias.includes('Bullish') ? 'Bullish' : 'Bearish';
    }
    // Ranging override (daily only)
    if (isDaily && s.adxValue < p.adxWeakBreak && Math.abs(score) < strongThreshold) bias = 'Neutral';
  }

  return { score, bias };
}
