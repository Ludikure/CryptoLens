import { describe, it, expect } from 'vitest';
import { mlPredictMeta, mlPredictQuantile, mlConfident, mlPredictDirection } from '../src/ml-predict';

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

    it('direction head matches Python reference (calibrated pUp)', () => {
        const pUp = mlPredictDirection(zero, true);
        expect(pUp).not.toBeNull();
        expect(pUp!).toBeCloseTo(0.6706263423, 6);
    });

    it('heads are crypto-only / direction-gated (null otherwise)', () => {
        expect(mlPredictMeta(zero, false, 1)).toBeNull();   // stock
        expect(mlPredictMeta(zero, true, 0)).toBeNull();    // no direction
        expect(mlPredictQuantile(zero, false, '0.75')).toBeNull();
        expect(mlPredictDirection(zero, false)).toBeNull(); // stock
    });
});
