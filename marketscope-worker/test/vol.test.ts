import { describe, it, expect } from 'vitest';
import { realizedVol, predictSigma, volBands, forecastVol } from '../src/vol';

describe('vol.ts — HAR-RV forecaster', () => {
    it('realizedVol = sqrt(sum logret^2) over the window', () => {
        // closes with constant +1% steps: each logret = ln(1.01); RV over 3 = sqrt(3)*ln(1.01)
        const closes = [100, 101, 102.01, 103.0301];
        const rv = realizedVol(closes, 3)!;
        expect(rv).toBeCloseTo(Math.sqrt(3) * Math.log(1.01), 10);
        expect(realizedVol([100, 101], 5)).toBeNull(); // insufficient
    });

    it('predictSigma matches the HAR linear combo (Python parity)', () => {
        // beta_24h from ml-vol-crypto.json; reference computed in Python:
        // 0.0057995276 + 0.3747162023*0.03 + 0.0829486274*0.05 + 0.0401734*0.10
        const s = predictSigma(0.03, 0.05, 0.10, '24h')!;
        expect(s).toBeCloseTo(0.0252057850, 8);
        expect(predictSigma(0.03, 0.05, 0.10, 'nope')).toBeNull();
    });

    it('volBands are multiplicative + fat-tailed (95% mult > Gaussian 1.96)', () => {
        const b = volBands(65000, 0.0252057850, '24h')!;
        // s1=0.919: hi = 65000*exp(0.919*0.025206)
        expect(b.s1[1]).toBeCloseTo(65000 * Math.exp(0.919 * 0.0252057850), 4);
        expect(b.s1[0]).toBeCloseTo(65000 * Math.exp(-0.919 * 0.0252057850), 4);
        // band ordering: 99% wider than 95% wider than 68%
        expect(b.s99[1]).toBeGreaterThan(b.s2[1]);
        expect(b.s2[1]).toBeGreaterThan(b.s1[1]);
    });

    it('forecastVol: crypto-only, needs 721+ closes', () => {
        const closes = Array.from({ length: 800 }, (_, i) => 100 * Math.exp(0.0005 * Math.sin(i / 5)));
        const f = forecastVol(closes, true, closes[closes.length - 1])!;
        expect(f).not.toBeNull();
        expect(f.horizons['24h']).toBeDefined();
        expect(f.horizons['24h'].s1[0]).toBeLessThan(f.horizons['24h'].s1[1]);
        expect(forecastVol(closes, false, 100)).toBeNull();            // stocks → null
        expect(forecastVol(closes.slice(0, 100), true, 100)).toBeNull(); // too few bars
    });
});
