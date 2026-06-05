import { describe, it, expect } from 'vitest';
import { mlPredictMeta, mlPredictQuantile, mlConfident, mlPredictDirection, mlPredictTail, tailRiskBucket, tailRiskInfo } from '../src/ml-predict';

// Worker↔Python parity for the Phase 1/2 additive heads (crypto-only). These heads
// are NOT computed by BacktestEngine, so they can't use the worker↔BacktestEngine
// fixtures — instead we assert the worker TS evaluator reproduces the Python export's
// reference values (export_heads.py) on a fixed input. Reference computed on an
// all-zero feature vector with tradeDir=+1 (LONG); evaluateTree defaults missing
// features to 0, so an empty input == all-features-zero.
describe('Phase 1/2 heads — worker TS vs Python export reference', () => {
    const zero: Record<string, number> = {};

    it('meta head matches Python reference (calibrated)', () => {
        const meta = mlPredictMeta(zero, true, 1);
        expect(meta).not.toBeNull();
        expect(meta!).toBeCloseTo(0.3812932372, 6);
    });

    it('quantile q75 matches Python reference', () => {
        const q = mlPredictQuantile(zero, true, '0.75');
        expect(q).not.toBeNull();
        expect(q!).toBeCloseTo(2.5287118124, 5);
    });

    it('conformal gate uses the exported threshold', () => {
        const meta = mlPredictMeta(zero, true, 1);
        // calibrated 0.3813 < tau 0.393 → not confident
        expect(mlConfident(meta, true)).toBe(false);
    });

    it('direction head is DROPPED — always null (leak-invalidated 2026-06-02)', () => {
        // The crypto direction head was retired after the daily-in-progress-candle leak
        // was found: clean-data crypto direction is ~50% (coin flip) even at high ML_WIN,
        // confirmed by the live forward test (3/7). mlPredictDirection now returns null
        // unconditionally. See ml-predict.ts for the full rationale.
        expect(mlPredictDirection(zero, true)).toBeNull();
        expect(mlPredictDirection(zero, false)).toBeNull();
    });

    it('heads are crypto-only / direction-gated (null otherwise)', () => {
        expect(mlPredictMeta(zero, false, 1)).toBeNull();   // stock
        expect(mlPredictMeta(zero, true, 0)).toBeNull();    // no direction
        expect(mlPredictQuantile(zero, false, '0.75')).toBeNull();
    });

    // Tail head: P(fwdMaxFavR >= 4 ATR in 24h) — the dedicated big-move gauge (2026-06-04).
    // Reference computed by ml-training/train_tail_head.py on the all-zero input against the
    // exact embedded heads.tail trees + isotonic calibration (cap 0.60).
    it('tail head matches Python reference (calibrated, crypto)', () => {
        const t = mlPredictTail(zero, true);
        expect(t).not.toBeNull();
        expect(t!).toBeCloseTo(0.1654135338, 6);
    });

    it('tail head is crypto-only; buckets map to the exported thresholds', () => {
        expect(mlPredictTail(zero, false)).toBeNull();      // stocks have no tail head
        expect(tailRiskBucket(0.15)).toBe('HIGH');          // >= 0.10
        expect(tailRiskBucket(0.085)).toBe('ELEVATED');     // >= 0.079
        expect(tailRiskBucket(0.05)).toBe('NORMAL');
        expect(tailRiskBucket(null)).toBeNull();
    });

    it('tailRiskInfo gives display bucket + x-base multiple', () => {
        const hi = tailRiskInfo(0.106);
        expect(hi).not.toBeNull();
        expect(hi!.bucket).toBe('HIGH');
        expect(hi!.multiple).toBeGreaterThan(1.5);            // ~1.66x the ~6.4% base
        expect(hi!.multiple).toBeLessThan(1.8);
        expect(tailRiskInfo(0.05)!.bucket).toBe('NORMAL');
        expect(tailRiskInfo(null)).toBeNull();
        expect(tailRiskInfo(undefined)).toBeNull();
    });
});
