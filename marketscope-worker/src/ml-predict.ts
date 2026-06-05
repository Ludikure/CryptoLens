// XGBoost inference — v9 dual models (crypto / stock).
// Predicts direction-agnostic goodR = P(>= 1.5 ATR favorable move in 24h).
// The LLM determines direction from candles and indicators.

import cryptoModelData from './ml-model-crypto.json';
import stockModelData from './ml-model-stock.json';
// 72h persistence models: same feature set, different target (goodR72h_2.5 instead of goodR_1.5)
import cryptoH72ModelData from './ml-model-crypto-h72t25.json';
import stockH72ModelData from './ml-model-stock-h72t25.json';
// Phase 1/2 additive heads (crypto-only): triple-barrier meta + fwdMaxFavR quantiles
// + conformal abstention. Separate file (like the H72 head) so the quality model JSON
// stays byte-identical and its parity tests are untouched.
import cryptoHeadsModelData from './ml-model-crypto.heads.json';

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

// 72h persistence
const cryptoH72Trees: TreeNode[] = cryptoH72ModelData.trees;
const stockH72Trees: TreeNode[] = stockH72ModelData.trees;
const cryptoH72BaseScore: number = (cryptoH72ModelData as any).base_score ?? 0.5;
const stockH72BaseScore: number = (stockH72ModelData as any).base_score ?? 0.5;
const cryptoH72Cal = (cryptoH72ModelData as any).calibration as { x: number[]; y: number[] } | undefined;
const stockH72Cal = (stockH72ModelData as any).calibration as { x: number[]; y: number[] } | undefined;

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

/// 72h persistence model: probability of >= 2.5 ATR favorable move within 72h.
/// Different question than mlPredict (which is 24h @ 1.5 ATR). Used to gate the
/// "hold for the runner" decision: high persistence → TP2 is reachable;
/// low persistence → take TP1 and exit, mean-reversion likely before 2.5 ATR.
export function mlPredictH72(input: Record<string, number>, isCrypto: boolean): number {
    const trees = isCrypto ? cryptoH72Trees : stockH72Trees;
    const baseScore = isCrypto ? cryptoH72BaseScore : stockH72BaseScore;
    const cal = isCrypto ? cryptoH72Cal : stockH72Cal;
    const baseLogit = Math.log(baseScore / (1 - baseScore));
    let sum = baseLogit;
    for (const tree of trees) sum += evaluateTree(tree, input);
    if (!isFinite(sum)) return 0.5;
    // Reuse the calibrate logic but with the h72 calibration table
    const rawProb = sigmoid(sum);
    if (!cal || cal.x.length < 2) return rawProb;
    const { x, y } = cal;
    if (rawProb <= x[0]) return y[0];
    if (rawProb >= x[x.length - 1]) return y[y.length - 1];
    let lo = 0;
    for (let i = 1; i < x.length; i++) { if (x[i] > rawProb) { lo = i - 1; break; } }
    const t = (rawProb - x[lo]) / (x[lo + 1] - x[lo]);
    return Math.max(0, Math.min(0.85, y[lo] + t * (y[lo + 1] - y[lo])));
}

// ── Phase 1/2 additive heads (crypto): triple-barrier meta + fwdMaxFavR quantiles
//    + conformal abstention. Loaded defensively from model JSON `heads`: absent in
//    current production → all functions return null and serving is unchanged; active
//    once ml-model-crypto.heads.json is swapped in. Python parity self-check (against
//    this exact aggregation) is 1.48e-7 (meta) / 1.9e-6 (quantile). See export_heads.py.
interface Heads {
    meta?: { trees: TreeNode[]; base_score: number;
             calibration: { x: number[]; y: number[]; cap?: number } };
    quantiles?: { q: Record<string, { trees: TreeNode[]; base_score: number }> };
    conformal?: { threshold: number | null; target_coverage: number };
    direction?: { trees: TreeNode[]; base_score: number;
                  calibration: { x: number[]; y: number[]; cap?: number } };
}
const cryptoHeads = (cryptoHeadsModelData as any).heads as Heads | undefined;
// Tail head lives in the CLEAN main model (ml-model-crypto.json heads.tail), not the
// leak-era heads file. Clean lineage (csv_exports_v11_fixed). See train_tail_head.py.
const cryptoTailHead = (cryptoModelData as any).heads?.tail as
    { trees: TreeNode[]; base_score: number;
      calibration: { x: number[]; y: number[]; cap?: number };
      buckets?: { elevated: number; high: number }; base_rate?: number } | undefined;

function isoCalibrate(cal: { x: number[]; y: number[]; cap?: number }, rawProb: number): number {
    const { x, y } = cal; const cap = cal.cap ?? 0.85;
    if (x.length < 2) return rawProb;
    if (rawProb <= x[0]) return y[0];
    if (rawProb >= x[x.length - 1]) return Math.min(cap, y[y.length - 1]);
    let lo = 0;
    for (let i = 1; i < x.length; i++) { if (x[i] > rawProb) { lo = i - 1; break; } }
    const t = (rawProb - x[lo]) / (x[lo + 1] - x[lo]);
    return Math.max(0, Math.min(cap, y[lo] + t * (y[lo + 1] - y[lo])));
}

/// Direction-conditioned meta probability P(triple-barrier win | take `direction`).
/// `direction` is +1 (LONG) / -1 (SHORT); appended as the `tradeDir` feature. Crypto
/// only. Returns null when no meta head is present (current production).
export function mlPredictMeta(input: Record<string, number>, isCrypto: boolean, direction: number): number | null {
    if (!isCrypto || !cryptoHeads?.meta || direction === 0) return null;
    const { trees, base_score, calibration } = cryptoHeads.meta;
    const metaInput = { ...input, tradeDir: direction };
    let sum = Math.log(base_score / (1 - base_score));
    for (const tree of trees) sum += evaluateTree(tree, metaInput);
    if (!isFinite(sum)) return null;
    return isoCalibrate(calibration, sigmoid(sum));
}

/// Predicted quantile of fwdMaxFavR (ATR units) — drives adaptive TP2. q in {"0.50",
/// "0.75","0.90"}. Raw regressor: base + Σleaves (no sigmoid/calibration). Crypto only.
export function mlPredictQuantile(input: Record<string, number>, isCrypto: boolean, q: string): number | null {
    const head = isCrypto ? cryptoHeads?.quantiles?.q?.[q] : undefined;
    if (!head) return null;
    let sum = head.base_score;
    for (const tree of head.trees) sum += evaluateTree(tree, input);
    return isFinite(sum) ? sum : null;
}

/// Conformal abstention: true iff the calibrated meta-prob clears the threshold whose
/// selected-set win-rate is guaranteed (Wilson-90%-LB) to meet the target. null = no head.
export function mlConfident(metaProb: number | null, isCrypto: boolean): boolean | null {
    const tau = isCrypto ? cryptoHeads?.conformal?.threshold : undefined;
    if (tau == null || metaProb == null) return null;
    return metaProb >= tau;
}

/// DROPPED (2026-06-02). The direction head's ~80%/~95% holdout accuracy was an ARTIFACT
/// of a data leak: the backtest's daily slice included the in-progress (current-day) daily
/// candle, so daily features (dRsi/dRsiDelta/dStochCross/dBBPercentB) saw the rest of the
/// day — overlapping the 24h forward label. Live drops the in-progress daily; the backtest
/// didn't. Fixed in runBacktest.ts; on clean data crypto direction is ~50% (coin flip) even
/// at high ML_WIN, confirmed by the live forward test (3/7 correct). The leak was crypto-
/// fatal (continuous 24/7 price → leaked daily close ≈ forward price) and stock-spared
/// (overnight gaps decorrelate) — which is exactly why direction "worked" only for crypto.
/// We no longer claim a direction edge. ML_WIN (direction-AGNOSTIC quality) survives clean
/// (top-bucket ~76% vs ~51% base) and is the only real signal. Returns null unconditionally;
/// callers already handle null (prompt/table hide the row, direction-signals logging skips).
export function mlPredictDirection(_input: Record<string, number>, _isCrypto: boolean): number | null {
    return null;
}

/// Big-move / tail-risk head: P(fwdMaxFavR >= 4 ATR in 24h). A dedicated gauge for the
/// HUGE moves ML_WIN structurally under-flags — ML_WIN targets >=1.5 ATR (a near-coinflip
/// "normal move?" question), so in a violent move it can read ~40% while a 5-ATR move lands.
/// This head is aimed at the big moves directly: OOF AUC ~0.65, top decile ~2x base tail rate.
/// Calibrated (isotonic, cap 0.60). Crypto-only; null when no tail head present (e.g. stocks).
/// See ml-training/train_tail_head.py + predictability_test.py for the build + honest ceiling.
export function mlPredictTail(input: Record<string, number>, isCrypto: boolean): number | null {
    if (!isCrypto || !cryptoTailHead) return null;
    const { trees, base_score, calibration } = cryptoTailHead;
    let sum = Math.log(base_score / (1 - base_score));
    for (const tree of trees) sum += evaluateTree(tree, input);
    if (!isFinite(sum)) return null;
    return isoCalibrate(calibration, sigmoid(sum));
}

/// Map a calibrated tail prob to a relative risk bucket using the head's exported thresholds
/// (NORMAL / ELEVATED / HIGH ≈ bottom-70 / next-20 / top-10 percent of bars). The absolute
/// prob is low even in HIGH (~12% / ~2x base) — these are rare events; this is a relative
/// "outsized-move risk" ranking, not a probability of a specific move. null when no head.
export function tailRiskBucket(prob: number | null): 'HIGH' | 'ELEVATED' | 'NORMAL' | null {
    if (prob == null) return null;
    const hi = cryptoTailHead?.buckets?.high ?? 0.10;
    const el = cryptoTailHead?.buckets?.elevated ?? 0.079;
    return prob >= hi ? 'HIGH' : prob >= el ? 'ELEVATED' : 'NORMAL';
}

/// Display-ready tail risk: bucket + how many times the base rate it is (the "1.7x normal"
/// the UI shows instead of a confusing bare 10%). Single source of the thresholds/base rate
/// (from the model JSON) so iOS + web don't each hardcode them. null when no head/prob.
export function tailRiskInfo(prob: number | null | undefined):
    { prob: number; bucket: 'HIGH' | 'ELEVATED' | 'NORMAL'; multiple: number } | null {
    if (prob == null) return null;
    const base = cryptoTailHead?.base_rate ?? 0.064;
    return { prob, bucket: tailRiskBucket(prob)!, multiple: prob / base };
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
        atrPercent, atrPercentile,
        tfAlignment: 0, momentumAlignment: 0, structureAlignment: 0,
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
        relStrengthVsSpy: 0, beta: 1, vixLevelCode: 1, isMarketHours: 1, earningsProximity: 0, shortVolumeRatio: 0.5, shortVolumeZScore: 0, oiPriceInteraction: 0, fundingSlope: 0, bodyWickRatio: 0.5,
        relStrengthVsSector: 0, vixTermStructure: 1, dxyMomentum: 0, iwmSpyRatio: 0,
        volWeightedRsi: dRsi, hVolWeightedRsi: hRsi,
        atrExpansionRate: 0,
    };
}
