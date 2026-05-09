// Derivatives resolver: merges Binance fapi history with the D1 archive, then computes
// per-bar `DerivativesSignals` (the discrete -1/0/+1 signals + raw values) using the
// same logic the worker cron applies live (index.ts:2149-2168).
//
// Strategy: D1 wins for any field it has (it's the higher-fidelity source — captured
// at cron time with full extended fields). Binance fapi backfills funding for the
// older history beyond D1's ~7-month window, plus OI/LS/Taker for the last 30 days.

import {
    fetchDerivativesHistory,
    round4H,
    type DerivativesHistory,
} from './fetchers/derivatives-binance.js';
import { type D1DerivativesArchive } from './fetchers/derivatives-d1.js';
import type { DerivativesSignals } from '../src/scoring-full.js';

const FOUR_H_MS = 14_400_000;

export interface MergedDerivBar {
    fundingRate?: number;       // % (already × 100)
    openInterest?: number;
    longPercent?: number;
    takerRatio?: number;
    basisPct?: number;
}

export type MergedDerivativesHistory = Map<number, MergedDerivBar>;

/// Pull both sources for a symbol and merge. Binance fapi is fetched fresh; D1 is
/// passed in as a pre-loaded map (one D1 dump covers all symbols, no need to re-query).
export async function loadMergedDerivatives(
    symbol: string, startMs: number, endMs: number, d1: D1DerivativesArchive | null,
): Promise<MergedDerivativesHistory> {
    const fapi = await fetchDerivativesHistory(symbol, startMs, endMs);
    const merged: MergedDerivativesHistory = new Map();
    for (const [k, b] of fapi) {
        merged.set(k, {
            fundingRate: b.fundingRate,
            openInterest: b.openInterest,
            longPercent: b.longPercent,
            takerRatio: b.takerBuySellRatio,
        });
    }
    const d1Sym = d1?.get(symbol);
    if (d1Sym) {
        for (const [k, b] of d1Sym) {
            const existing = merged.get(k) ?? {};
            // D1 stores fundingRate as raw decimal; fapi merge stores rate × 100. Convert
            // D1's value to the same convention before overlaying.
            const d1Funding = b.fundingRate !== undefined ? b.fundingRate * 100 : undefined;
            merged.set(k, {
                fundingRate: d1Funding ?? existing.fundingRate,
                openInterest: b.openInterest ?? existing.openInterest,
                longPercent: b.longPercent ?? existing.longPercent,
                takerRatio: b.takerRatio ?? existing.takerRatio,
                basisPct: b.basisPct,
            });
        }
    }
    return merged;
}

/// Per-bar signal computation. Mirrors worker/src/index.ts:2149-2168 line-for-line.
/// Returns the full DerivativesSignals struct + an updated fundingHist (rolling 4-bar
/// window) that the caller threads into PreviousSnapshot.
export function resolveDerivativesAt(
    history: MergedDerivativesHistory,
    evalTimeMs: number,
    priceRising: boolean,
    prevFundingHist: number[],
): { signals: DerivativesSignals; basisPct: number; fundingHistOut: number[] } {
    const cur = history.get(round4H(evalTimeMs));
    const prev = history.get(round4H(evalTimeMs) - FOUR_H_MS);

    const fundingRate = cur?.fundingRate ?? 0;
    const openInterest = cur?.openInterest ?? 0;
    const prevOI = prev?.openInterest ?? 0;
    const longPct = cur?.longPercent ?? 50;
    const takerRatio = cur?.takerRatio ?? 1.0;
    const basisPct = cur?.basisPct ?? 0;

    let fundingSignal = 0;
    if (fundingRate > 0.03) fundingSignal = -1;
    else if (fundingRate < -0.03) fundingSignal = 1;

    let takerSignal = 0;
    if (takerRatio > 1.1) takerSignal = 1;
    else if (takerRatio < 0.9) takerSignal = -1;

    let crowdingSignal = 0;
    if (longPct > 60) crowdingSignal = -1;
    else if (longPct < 40) crowdingSignal = 1;

    let oiSignal = 0;
    const oiUp = openInterest > prevOI && prevOI > 0;
    const oiDown = openInterest < prevOI && prevOI > 0;
    if (oiUp && priceRising) oiSignal = 1;
    else if (oiUp && !priceRising) oiSignal = -1;
    else if (oiDown && priceRising) oiSignal = -1;
    else if (oiDown && !priceRising) oiSignal = 1;

    const oiChangePct = prevOI > 0 ? ((openInterest - prevOI) / prevOI) * 100 : 0;

    const derivativesCombined = Math.max(-2, Math.min(2,
        fundingSignal + oiSignal + takerSignal + crowdingSignal,
    ));

    // Funding history threading: append the current rate to the rolling 4-bar window.
    // Mirrors worker/src/index.ts:2192. fundingSlope feature reads this from
    // PreviousSnapshot.fundingHist.
    const fundingHistOut = [...prevFundingHist, fundingRate].slice(-4);

    return {
        signals: {
            fundingSignal, oiSignal, takerSignal, crowdingSignal, derivativesCombined,
            fundingRateRaw: fundingRate,
            oiChangePct,
            takerRatioRaw: takerRatio,
            longPctRaw: longPct,
        },
        basisPct,
        fundingHistOut,
    };
}
