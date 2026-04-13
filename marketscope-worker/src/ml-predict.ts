// XGBoost inference in TypeScript — evaluates exported tree JSON.
// v6: Dual models with 80 features each. Crypto (150 trees), Stock (150 trees).

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

function evaluateTree(node: TreeNode, input: Record<string, number>): number {
    if (node.leaf !== undefined) return node.leaf;
    if (!node.split || node.split_condition === undefined) return 0;

    const val = input[node.split] ?? 0;
    const goLeft = val < node.split_condition;

    const children = node.children || [];
    const yesNode = children.find(c => c.nodeid === node.yes);
    const noNode = children.find(c => c.nodeid === node.no);

    const next = goLeft ? yesNode : noNode;
    if (!next) return 0;
    return evaluateTree(next, input);
}

function sigmoid(x: number): number {
    return 1.0 / (1.0 + Math.exp(-x));
}

export function mlPredict(input: Record<string, number>, isCrypto: boolean): number {
    const trees = isCrypto ? cryptoTrees : stockTrees;
    let sum = 0;
    for (const tree of trees) {
        sum += evaluateTree(tree, input);
    }
    return sigmoid(sum);
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
    oneHScore?: number
): Record<string, number> {
    const _oneHScore = oneHScore ?? 0;
    // Cross-timeframe interactions
    const dBull = dailyScore > 3, dBear = dailyScore < -3;
    const hBull = fourHScore > 3, hBear = fourHScore < -3;
    let tfAlign = 0;
    if (dBull) tfAlign += 1; else if (dBear) tfAlign -= 1;
    if (hBull) tfAlign += 1; else if (hBear) tfAlign -= 1;

    return {
        // Daily core
        dRsi, dMacdHist, dAdx, dAdxBullish: dAdxBullish ? 1 : 0,
        dEmaCross, dStackBull: dStackBull ? 1 : 0, dStackBear: dStackBear ? 1 : 0,
        dStructBull: dStructBull ? 1 : 0, dStructBear: dStructBear ? 1 : 0,
        // Daily momentum (defaults — not computed on worker)
        dStochK: 50, dStochCross: 0, dMacdCross: 0, dDivergence: 0, dEma20Rising: 0,
        // Daily vol/volume (defaults)
        dBBPercentB: 0.5, dBBSqueeze: 0, dBBBandwidth: 0, dVolumeRatio: 1.0, dAboveVwap: 0,
        // 4H core
        hRsi, hMacdHist, hAdx, hAdxBullish: hAdxBullish ? 1 : 0,
        hEmaCross, hStackBull: hStackBull ? 1 : 0, hStackBear: hStackBear ? 1 : 0,
        hStructBull: hStructBull ? 1 : 0, hStructBear: hStructBear ? 1 : 0,
        // 4H momentum (defaults)
        hStochK: 50, hStochCross: 0, hMacdCross: 0, hDivergence: 0, hEma20Rising: 0,
        // 4H vol/volume (defaults)
        hBBPercentB: 0.5, hBBSqueeze: 0, hBBBandwidth: 0, hVolumeRatio: 1.0, hAboveVwap: 0,
        // 1H entry (defaults — no 1H data on worker)
        eRsi: 50, eEmaCross: 0, eStochK: 50, eMacdHist: 0,
        // Derivatives (defaults — could add Binance API calls later)
        fundingSignal: 0, oiSignal: 0, takerSignal: 0, crowdingSignal: 0, derivativesCombined: 0,
        fundingRateRaw: 0, oiChangePct: 0, takerRatioRaw: 1.0, longPctRaw: 50,
        // Macro (defaults)
        vix: 20, dxyAboveEma20: 0, volScalarML: volScalar,
        // Candle patterns (defaults)
        last3Green: 0, last3Red: 0, last3VolIncreasing: 0,
        // Stock-only (defaults)
        obvRising: 0, adLineAccumulation: 0,
        // Context
        atrPercent, atrPercentile,
        dailyScore, fourHScore,
        // Cross-timeframe interactions
        tfAlignment: tfAlign,
        momentumAlignment: (dMacdHist > 0 && hMacdHist > 0) ? 1 : (dMacdHist < 0 && hMacdHist < 0) ? -1 : 0,
        structureAlignment: (dStructBull && hStructBull) ? 1 : (dStructBear && hStructBear) ? -1 : 0,
        scoreSum: dailyScore + fourHScore + _oneHScore,
        scoreDivergence: Math.abs(dailyScore - fourHScore),
        // Temporal
        dayOfWeek: new Date().getDay(), // 0=Sun..6=Sat
        barsSinceRegimeChange: 0, // not tracked on worker — default
        regimeCode: (dAdx > 25 && (dStackBull || dStackBear)) ? 2 : dAdx < 20 ? 0 : 1,
        // Rate-of-change (defaults — not tracked on worker)
        dRsiDelta: 0, dAdxDelta: 0, hRsiDelta: 0, hAdxDelta: 0, hMacdHistDelta: 0,
        // Sentiment + cross-asset (defaults — not tracked on worker)
        fearGreedIndex: 50, fearGreedZone: 0, ethBtcRatio: 0, ethBtcDelta6: 0,
        // Volume profile (defaults — not computed on worker via buildMLInput)
        vpDistToPocATR: 0, vpAbovePoc: 1, vpVAWidth: 0, vpInValueArea: 1,
        vpDistToVAH_ATR: 0, vpDistToVAL_ATR: 0,
        // 1-bar deltas + acceleration (defaults)
        hRsiDelta1: 0, hMacdHistDelta1: 0, dRsiDelta1: 0,
        hRsiAccel: 0, hMacdAccel: 0, dAdxAccel: 0,
        // Time-of-day
        hourBucket: (() => { const h = new Date().getUTCHours(); return h < 8 ? 0 : h < 14 ? 1 : h < 21 ? 2 : 3; })(),
        isWeekend: new Date().getDay() === 0 || new Date().getDay() === 6 ? 1 : 0,
        // Basis (defaults — not available in buildMLInput path)
        basisPct: 0, basisExtreme: 0,
    };
}
