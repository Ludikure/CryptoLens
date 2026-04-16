// XGBoost inference — v9 dual models (crypto / stock).
// Predicts direction-agnostic goodR = P(>= 1.5 ATR favorable move in 24h).
// The LLM determines direction from candles and indicators.

import cryptoModelData from './ml-model-crypto.json';
import stockModelData from './ml-model-stock.json';

interface TreeNode {
    nodeid: number;
    split?: string;
    split_condition?: number;
    yes?: number;
    no?: number;
    missing?: number;
    leaf?: number;
    children?: TreeNode[];
}

const cryptoTrees: TreeNode[] = cryptoModelData.trees;
const stockTrees: TreeNode[] = stockModelData.trees;
const cryptoBaseScore: number = (cryptoModelData as any).base_score ?? 0.5;
const stockBaseScore: number = (stockModelData as any).base_score ?? 0.5;
const cryptoCal = (cryptoModelData as any).calibration as { x: number[]; y: number[] } | undefined;
const stockCal = (stockModelData as any).calibration as { x: number[]; y: number[] } | undefined;

function calibrate(rawProb: number, isCrypto: boolean): number {
    const cal = isCrypto ? cryptoCal : stockCal;
    if (!cal || cal.x.length < 2) return rawProb;
    const { x, y } = cal;
    if (rawProb <= x[0]) return y[0];
    if (rawProb >= x[x.length - 1]) return y[y.length - 1];
    let lo = 0;
    for (let i = 1; i < x.length; i++) { if (x[i] > rawProb) { lo = i - 1; break; } }
    const t = (rawProb - x[lo]) / (x[lo + 1] - x[lo]);
    return Math.max(0, Math.min(0.85, y[lo] + t * (y[lo + 1] - y[lo])));
}

function evaluateTree(node: TreeNode, input: Record<string, number>): number {
    if (node.leaf !== undefined) return node.leaf;
    if (!node.split || node.split_condition === undefined) return 0;
    const val = input[node.split] ?? 0;
    const goLeft = val < node.split_condition;
    const children = node.children || [];
    const next = goLeft
        ? children.find(c => c.nodeid === node.yes)
        : children.find(c => c.nodeid === node.no);
    if (!next) return 0;
    return evaluateTree(next, input);
}

function sigmoid(x: number): number { return 1.0 / (1.0 + Math.exp(-x)); }

export function mlPredict(input: Record<string, number>, isCrypto: boolean): number {
    const trees = isCrypto ? cryptoTrees : stockTrees;
    const baseScore = isCrypto ? cryptoBaseScore : stockBaseScore;
    const baseLogit = Math.log(baseScore / (1 - baseScore));
    let sum = baseLogit;
    for (const tree of trees) sum += evaluateTree(tree, input);
    if (!isFinite(sum)) return 0.5;
    return calibrate(sigmoid(sum), isCrypto);
}

/// Build feature dict from scoring results + candle data.
/// Some features (Bollinger, StochRSI, VWAP) are not computed on the worker — defaults used.
export function buildMLInput(
    dRsi: number, dMacdHist: number, dAdx: number, dAdxBullish: boolean,
    dEmaCross: number, dStackBull: boolean, dStackBear: boolean,
    dStructBull: boolean, dStructBear: boolean,
    hRsi: number, hMacdHist: number, hAdx: number, hAdxBullish: boolean,
    hEmaCross: number, hStackBull: boolean, hStackBear: boolean,
    hStructBull: boolean, hStructBear: boolean,
    atrPercent: number, volScalar: number, atrPercentile: number,
    dailyScore: number, fourHScore: number,
): Record<string, number> {
    return {
        dRsi, dMacdHist, dAdx, dAdxBullish: dAdxBullish ? 1 : 0,
        dEmaCross, dStackBull: dStackBull ? 1 : 0, dStackBear: dStackBear ? 1 : 0,
        dStructBull: dStructBull ? 1 : 0, dStructBear: dStructBear ? 1 : 0,
        dStochK: 50, dStochCross: 0, dMacdCross: 0, dDivergence: 0, dEma20Rising: 0,
        dBBPercentB: 0.5, dBBSqueeze: 0, dBBBandwidth: 0,
        dVolumeRatio: 1.0, dAboveVwap: 0,
        hRsi, hMacdHist, hAdx, hAdxBullish: hAdxBullish ? 1 : 0,
        hEmaCross, hStackBull: hStackBull ? 1 : 0, hStackBear: hStackBear ? 1 : 0,
        hStructBull: hStructBull ? 1 : 0, hStructBear: hStructBear ? 1 : 0,
        hStochK: 50, hStochCross: 0, hMacdCross: 0, hDivergence: 0, hEma20Rising: 0,
        hBBPercentB: 0.5, hBBSqueeze: 0, hBBBandwidth: 0,
        hVolumeRatio: 1.0, hAboveVwap: 0,
        eRsi: 50, eEmaCross: 0, eStochK: 50, eMacdHist: 0,
        fundingSignal: 0, oiSignal: 0, takerSignal: 0, crowdingSignal: 0, derivativesCombined: 0,
        fundingRateRaw: 0, oiChangePct: 0, takerRatioRaw: 1.0, longPctRaw: 50,
        vix: 20, dxyAboveEma20: 0, volScalarML: volScalar,
        last3Green: 0, last3Red: 0, last3VolIncreasing: 0,
        obvRising: 0, adLineAccumulation: 0,
        atrPercent, atrPercentile, dailyScore, fourHScore,
        tfAlignment: 0, momentumAlignment: 0, structureAlignment: 0,
        scoreSum: dailyScore + fourHScore, scoreDivergence: Math.abs(dailyScore - fourHScore),
        dayOfWeek: new Date().getDay(), barsSinceRegimeChange: 0, regimeCode: 1,
        dRsiDelta: 0, dAdxDelta: 0, hRsiDelta: 0, hAdxDelta: 0, hMacdHistDelta: 0,
        fearGreedIndex: 50, fearGreedZone: 0,
        ethBtcRatio: 0, ethBtcDelta6: 0,
        vpDistToPocATR: 0, vpAbovePoc: 1, vpVAWidth: 0, vpInValueArea: 1,
        vpDistToVAH_ATR: 0, vpDistToVAL_ATR: 0,
        hRsiDelta1: 0, hMacdHistDelta1: 0, dRsiDelta1: 0,
        hRsiAccel: 0, hMacdAccel: 0, dAdxAccel: 0,
        hourBucket: (() => { const h = new Date().getUTCHours(); return h < 8 ? 0 : h < 14 ? 1 : h < 21 ? 2 : 3; })(),
        isWeekend: new Date().getDay() === 0 || new Date().getDay() === 6 ? 1 : 0,
        basisPct: 0, basisExtreme: 0,
        fiftyTwoWeekPct: 50, distToFiftyTwoHigh: 0,
        gapPercent: 0, gapFilled: 0, gapDirectionAligned: 0,
        relStrengthVsSpy: 0, beta: 1, vixLevelCode: 1, isMarketHours: 1,
        volWeightedRsi: dRsi, hVolWeightedRsi: hRsi,
        atrExpansionRate: 0, fundingSlope: 0,
    };
}
