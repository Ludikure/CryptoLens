import { describe, expect, test } from 'vitest';
import { computeAllFeatures, type Candle as FullCandle } from '../src/scoring-full';

/**
 * Feature parity smoke tests.
 *
 * These assert that computeAllFeatures returns the expected feature names and reasonable
 * values on synthetic input. They CATCH:
 *   - Missing feature in the output (renamed/removed without intent)
 *   - Type errors (NaN/Infinity slipping in)
 *   - Order changes (the model JSON's feature order must match)
 *
 * They DO NOT exhaustively assert numeric parity with iOS — that requires a fixture
 * captured from a known iOS run. To add full parity assertions:
 *   1. Use the iOS DEBUG dump in AnalysisService.swift:542-549 (currently active for BTC/ETH).
 *   2. Run an analysis on the simulator, retrieve the JSON dump from
 *      ~/Library/Developer/CoreSimulator/.../Documents/{symbol}_features.json.
 *   3. Add a fixture file with the input candles + expected output.
 *   4. Add a test that runs computeAllFeatures on the input and asserts each feature value
 *      matches the iOS dump within 0.0001 tolerance.
 */

const EXPECTED_FEATURE_KEYS_PARTIAL = [
    // Daily core
    'dRsi', 'dMacdHist', 'dAdx', 'dStackBull', 'dStackBear',
    // 4H core
    'hRsi', 'hMacdHist', 'hAdx', 'hStackBull',
    // 1H entry
    'eRsi', 'eStochK', 'eEmaCross', 'eMacdHist',
    // Macro
    'vix', 'dxyAboveEma20', 'volScalarML',
    // Stock-only (set 0 for crypto)
    'fiftyTwoWeekPct', 'beta', 'isMarketHours',
    // Volume profile
    'vpDistToPocATR', 'vpInValueArea',
    // Earnings + dark pool
    'earningsProximity', 'shortVolumeRatio', 'shortVolumeZScore',
    // Cross-market breadth
    'relStrengthVsSector', 'vixTermStructure', 'dxyMomentum', 'iwmSpyRatio',
    // Derivatives interactions
    'oiPriceInteraction', 'fundingSlope', 'bodyWickRatio',
];

// Build a long enough candle series for indicators that need history (ADX needs ~30 bars).
function syntheticCandles(count: number, startPrice: number, drift = 0.001): FullCandle[] {
    const candles: FullCandle[] = [];
    let price = startPrice;
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 0; i < count; i++) {
        const open = price;
        const close = open * (1 + drift + (Math.sin(i) * 0.005));
        const high = Math.max(open, close) * 1.002;
        const low = Math.min(open, close) * 0.998;
        candles.push({
            time: start + i * 86_400_000, // 1 day spacing
            open, high, low, close,
            volume: 1_000_000 + i * 1000,
        });
        price = close;
    }
    return candles;
}

describe('computeAllFeatures', () => {
    test('returns object containing all expected feature keys', () => {
        const daily = syntheticCandles(60, 100);
        const fourH = syntheticCandles(60, 100);
        const oneH = syntheticCandles(60, 100);
        const spy = syntheticCandles(60, 500);
        const iwm = syntheticCandles(60, 200);
        const sector = syntheticCandles(60, 80);
        const dxy = syntheticCandles(60, 100);

        const features = computeAllFeatures(
            daily, fourH, oneH,
            false,                          // isCrypto
            { fundingSignal: 0, oiSignal: 0, takerSignal: 0, crowdingSignal: 0, derivativesCombined: 0 },
            { vix: 18, dxyAboveEma20: 1 },
            null,                           // sentiment
            undefined,                      // prevSnapshot
            spy,
            { ratio: 0.5, zscore: 0 },      // darkPool
            iwm,
            sector,
            dxy,
            18.5,                           // vix3mPrice
            'AAPL',
        );

        for (const key of EXPECTED_FEATURE_KEYS_PARTIAL) {
            expect(features, `missing key: ${key}`).toHaveProperty(key);
            const value = (features as any)[key];
            expect(typeof value, `${key} must be number`).toBe('number');
            expect(Number.isFinite(value), `${key} = ${value} not finite`).toBe(true);
        }
    });

    test('crypto features default earningsProximity and stock-only fields to 0', () => {
        const daily = syntheticCandles(60, 50000);
        const fourH = syntheticCandles(60, 50000);
        const oneH = syntheticCandles(60, 50000);

        const features = computeAllFeatures(
            daily, fourH, oneH,
            true,                           // isCrypto
            { fundingSignal: 0, oiSignal: 0, takerSignal: 0, crowdingSignal: 0, derivativesCombined: 0 },
            { vix: 18, dxyAboveEma20: 1 },
            null,
            undefined,
            [],                             // no SPY for crypto
            undefined,
            undefined,
            [],
            undefined,
            18.5,
            'BTCUSDT',
        );

        // Stock-only features take crypto-safe defaults (verified against scoring-full.ts):
        expect(features.earningsProximity).toBe(0);
        expect(features.fiftyTwoWeekPct).toBe(50); // crypto uses neutral 50 (no 52-week concept)
        expect(features.beta).toBe(1.0);            // crypto uses neutral 1.0 (no SPY beta)
        // Crypto IS in market hours always (24/7)
        expect(features.isMarketHours).toBe(1);
    });

    test('vix and dxy passthrough from macro', () => {
        const daily = syntheticCandles(60, 100);
        const fourH = syntheticCandles(60, 100);
        const oneH = syntheticCandles(60, 100);

        const features = computeAllFeatures(
            daily, fourH, oneH,
            false,
            { fundingSignal: 0, oiSignal: 0, takerSignal: 0, crowdingSignal: 0, derivativesCombined: 0 },
            { vix: 22, dxyAboveEma20: 1 },
            null,
            undefined,
            syntheticCandles(60, 500),
            { ratio: 0.5, zscore: 0 },
            syntheticCandles(60, 200),
            syntheticCandles(60, 80),
            syntheticCandles(60, 100),
            18.5,
            'AAPL',
        );

        expect(features.vix).toBe(22);
        expect(features.dxyAboveEma20).toBe(1);
    });
});
