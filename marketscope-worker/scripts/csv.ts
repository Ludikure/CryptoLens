// CSV writer matching BacktestEngine.swift's exportCSV format exactly. Column order,
// number formatting (decimal places), and bool→0/1 coercion all mirror the Swift code
// at lines 1538-1762 of BacktestEngine.swift. Any drift here breaks training-data
// compatibility — Python scripts (calibrate_v9, calibrate_v12_stocks) read these CSVs
// by column index, so even reordering would silently corrupt training labels.

import type { FullFeatures } from '../src/scoring-full.js';

export interface BarOutput {
    symbol: string;
    timestampMs: number;
    price: number;
    dailyScore: number;
    fourHScore: number;
    oneHScore: number;
    dailyBias: string;
    fourHBias: string;
    oneHBias: string;
    biasAlignment: string;
    regime: string;
    emaRegime: string;
    volScalar: number;
    atrPercentile: number;
    isCrypto: boolean;
    features: FullFeatures | null;
    // Trade outcome (bar-by-bar, populated in Phase 2)
    tradeOutcome: string;
    tradePnlPct: number;
    tradeBarsToOutcome: number;
    tradeMaxFavorable: number;
    tradeMaxAdverse: number;
    // Forward windows (populated in Phase 2)
    fwdReturn4H: number;
    fwdReturn12H: number;
    fwdReturn24H: number;
    fwdMaxUp24H: number;
    fwdMaxDown24H: number;
    fwdMaxFavR: number;
    // Direction24H derived from fwdReturn24H, written by serializer
    // New 48/72h windows (Phase 2)
    fwdMaxFavR48H: number;
    fwdMaxFavR72H: number;
    /// Signed close-to-close fwd returns at 48/72h. New columns added 2026-05-08
    /// to support direction-agreement analysis — the existing fwdMaxFavR48H/72H
    /// columns are direction-agnostic (max excursion) and can't tell continuation
    /// from whipsaw. Persistence-analysis uses these to compute % of bars where
    /// 24h direction matches 48h/72h direction.
    fwdReturn48H: number;
    fwdReturn72H: number;
}

export const CSV_HEADER = [
    'symbol', 'timestamp', 'price',
    'dailyScore', 'fourHScore', 'oneHScore',
    'dailyBias', 'fourHBias', 'oneHBias',
    'biasAlignment', 'regime', 'emaRegime',
    'volScalar', 'atrPercentile',
    'dRsi', 'dMacdHist', 'dAdx', 'dAdxBullish',
    'dEmaCross', 'dStackBull', 'dStackBear', 'dStructBull', 'dStructBear',
    'dStochK', 'dStochCross', 'dMacdCross', 'dDivergence', 'dEma20Rising',
    'dBBPercentB', 'dBBSqueeze', 'dBBBandwidth', 'dVolumeRatio', 'dAboveVwap',
    'hRsi', 'hMacdHist', 'hAdx', 'hAdxBullish',
    'hEmaCross', 'hStackBull', 'hStackBear', 'hStructBull', 'hStructBear',
    'hStochK', 'hStochCross', 'hMacdCross', 'hDivergence', 'hEma20Rising',
    'hBBPercentB', 'hBBSqueeze', 'hBBBandwidth', 'hVolumeRatio', 'hAboveVwap',
    'eRsi', 'eEmaCross', 'eStochK', 'eMacdHist',
    'fundingSignal', 'oiSignal', 'takerSignal', 'crowdingSignal', 'derivativesCombined',
    'fundingRateRaw', 'oiChangePct', 'takerRatioRaw', 'longPctRaw',
    'vix', 'dxyAboveEma20', 'volScalarML',
    'last3Green', 'last3Red', 'last3VolIncreasing',
    'obvRising', 'adLineAccumulation',
    'atrPercent', 'isCrypto',
    'tfAlignment', 'momentumAlignment', 'structureAlignment',
    'dayOfWeek', 'barsSinceRegimeChange', 'regimeCode',
    'dRsiDelta', 'dAdxDelta', 'hRsiDelta', 'hAdxDelta', 'hMacdHistDelta',
    'fearGreedIndex', 'fearGreedZone', 'ethBtcRatio', 'ethBtcDelta6',
    'fiftyTwoWeekPct', 'distToFiftyTwoHigh',
    'gapPercent', 'gapFilled', 'gapDirectionAligned',
    'relStrengthVsSpy', 'beta', 'vixLevelCode', 'isMarketHours',
    'earningsProximity', 'shortVolumeRatio', 'shortVolumeZScore',
    'oiPriceInteraction', 'fundingSlope', 'bodyWickRatio',
    'relStrengthVsSector', 'vixTermStructure', 'dxyMomentum', 'iwmSpyRatio',
    'vpDistToPocATR', 'vpAbovePoc', 'vpVAWidth', 'vpInValueArea',
    'vpDistToVAH_ATR', 'vpDistToVAL_ATR',
    'hRsiDelta1', 'hMacdHistDelta1', 'dRsiDelta1',
    'hRsiAccel', 'hMacdAccel', 'dAdxAccel',
    'hourBucket', 'isWeekend',
    'tradeOutcome', 'tradePnlPct', 'tradeBarsToOutcome',
    'tradeMaxFavorable', 'tradeMaxAdverse',
    'fwdReturn4H', 'fwdReturn12H', 'fwdReturn24H',
    'fwdMaxUp24H', 'fwdMaxDown24H', 'fwdMaxFavR',
    'fwdDirection24H',
    // Phase-2 additions for the persistence-model experiment.
    'fwdMaxFavR48H', 'fwdMaxFavR72H',
    // Direction-aware horizons (signed close-to-close pct return).
    'fwdReturn48H', 'fwdReturn72H',
    // Basis features (2026-07-05): computed by computeAllFeatures since v11 but never
    // serialized — the audit found them MISSING from training CSVs (train/serve skew:
    // live serving computes real basis, the model trained on nothing). Appended at the
    // END so index-based readers of the existing columns are unaffected.
    'basisPct', 'basisExtreme',
].join(',');

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const f4 = (v: number) => v.toFixed(4);
const f6 = (v: number) => v.toFixed(6);
const b = (v: number | undefined) => (v ? 1 : 0);

export function rowToCSV(o: BarOutput): string {
    const f = o.features;
    const v = (key: keyof FullFeatures, fallback: number) =>
        (f && f[key] !== undefined) ? (f[key] as number) : fallback;

    const direction24H = o.fwdReturn24H > 0.5 ? '1' : o.fwdReturn24H < -0.5 ? '-1' : '0';

    return [
        o.symbol,
        // Match Swift BacktestEngine.swift:1618 (`Int(timeIntervalSince1970)`) so the
        // Python training scripts (calibrate_v12_stocks etc.) and parity-diff can
        // ingest these CSVs directly without unit-conversion shims.
        String(Math.floor(o.timestampMs / 1000)),
        f4(o.price),
        String(o.dailyScore), String(o.fourHScore), String(o.oneHScore),
        o.dailyBias, o.fourHBias, o.oneHBias,
        o.biasAlignment, o.regime, o.emaRegime,
        f2(o.volScalar),
        Math.round(o.atrPercentile).toString(),
        f1(v('dRsi', 50)), f6(v('dMacdHist', 0)), f1(v('dAdx', 0)), b(v('dAdxBullish', 0)),
        String(v('dEmaCross', 0)),
        b(v('dStackBull', 0)), b(v('dStackBear', 0)),
        b(v('dStructBull', 0)), b(v('dStructBear', 0)),
        f1(v('dStochK', 50)),
        String(v('dStochCross', 0)), String(v('dMacdCross', 0)),
        String(v('dDivergence', 0)), b(v('dEma20Rising', 0)),
        f4(v('dBBPercentB', 0.5)), b(v('dBBSqueeze', 0)),
        f4(v('dBBBandwidth', 0)),
        f2(v('dVolumeRatio', 1.0)),
        b(v('dAboveVwap', 0)),
        f1(v('hRsi', 50)), f6(v('hMacdHist', 0)), f1(v('hAdx', 0)), b(v('hAdxBullish', 0)),
        String(v('hEmaCross', 0)),
        b(v('hStackBull', 0)), b(v('hStackBear', 0)),
        b(v('hStructBull', 0)), b(v('hStructBear', 0)),
        f1(v('hStochK', 50)),
        String(v('hStochCross', 0)), String(v('hMacdCross', 0)),
        String(v('hDivergence', 0)), b(v('hEma20Rising', 0)),
        f4(v('hBBPercentB', 0.5)), b(v('hBBSqueeze', 0)),
        f4(v('hBBBandwidth', 0)),
        f2(v('hVolumeRatio', 1.0)),
        b(v('hAboveVwap', 0)),
        f1(v('eRsi', 50)), String(v('eEmaCross', 0)),
        f1(v('eStochK', 50)), f6(v('eMacdHist', 0)),
        String(v('fundingSignal', 0)), String(v('oiSignal', 0)),
        String(v('takerSignal', 0)), String(v('crowdingSignal', 0)),
        String(v('derivativesCombined', 0)),
        f6(v('fundingRateRaw', 0)),
        f4(v('oiChangePct', 0)),
        f4(v('takerRatioRaw', 1.0)),
        f2(v('longPctRaw', 50)),
        f1(v('vix', 20)), b(v('dxyAboveEma20', 0)),
        f2(v('volScalarML', 1.0)),
        b(v('last3Green', 0)), b(v('last3Red', 0)),
        b(v('last3VolIncreasing', 0)),
        b(v('obvRising', 0)), b(v('adLineAccumulation', 0)),
        f4(v('atrPercent', 0)),
        b(o.isCrypto ? 1 : 0),
        String(v('tfAlignment', 0)), String(v('momentumAlignment', 0)),
        String(v('structureAlignment', 0)),
        String(v('dayOfWeek', 0)),
        String(v('barsSinceRegimeChange', 0)),
        String(v('regimeCode', 0)),
        f4(v('dRsiDelta', 0)), f4(v('dAdxDelta', 0)),
        f4(v('hRsiDelta', 0)), f4(v('hAdxDelta', 0)),
        f6(v('hMacdHistDelta', 0)),
        f1(v('fearGreedIndex', 50)),
        String(v('fearGreedZone', 0)),
        f6(v('ethBtcRatio', 0)),
        f4(v('ethBtcDelta6', 0)),
        f2(v('fiftyTwoWeekPct', 50)),
        f4(v('distToFiftyTwoHigh', 0)),
        f4(v('gapPercent', 0)),
        b(v('gapFilled', 0)),
        String(v('gapDirectionAligned', 0)),
        f4(v('relStrengthVsSpy', 0)),
        f4(v('beta', 1.0)),
        String(v('vixLevelCode', 1)),
        b(v('isMarketHours', 0)),
        f4(v('earningsProximity', 0)),
        f6(v('shortVolumeRatio', 0.5)),
        f4(v('shortVolumeZScore', 0)),
        f4(v('oiPriceInteraction', 0)),
        f6(v('fundingSlope', 0)),
        f4(v('bodyWickRatio', 0.5)),
        f4(v('relStrengthVsSector', 0)),
        f4(v('vixTermStructure', 1.0)),
        f4(v('dxyMomentum', 0)),
        f4(v('iwmSpyRatio', 0)),
        f4(v('vpDistToPocATR', 0)),
        b(v('vpAbovePoc', 0)),
        f4(v('vpVAWidth', 0)),
        b(v('vpInValueArea', 0)),
        f4(v('vpDistToVAH_ATR', 0)),
        f4(v('vpDistToVAL_ATR', 0)),
        f4(v('hRsiDelta1', 0)),
        f6(v('hMacdHistDelta1', 0)),
        f4(v('dRsiDelta1', 0)),
        f4(v('hRsiAccel', 0)),
        f6(v('hMacdAccel', 0)),
        f4(v('dAdxAccel', 0)),
        String(v('hourBucket', 0)),
        b(v('isWeekend', 0)),
        o.tradeOutcome,
        f4(o.tradePnlPct),
        String(o.tradeBarsToOutcome),
        f4(o.tradeMaxFavorable),
        f4(o.tradeMaxAdverse),
        f4(o.fwdReturn4H),
        f4(o.fwdReturn12H),
        f4(o.fwdReturn24H),
        f4(o.fwdMaxUp24H),
        f4(o.fwdMaxDown24H),
        f4(o.fwdMaxFavR),
        direction24H,
        f4(o.fwdMaxFavR48H),
        f4(o.fwdMaxFavR72H),
        f4(o.fwdReturn48H),
        f4(o.fwdReturn72H),
        f4(v('basisPct', 0)),
        String(v('basisExtreme', 0)),
    ].join(',');
}
