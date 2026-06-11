import { describe, it, expect } from 'vitest';
import { normCdf, noiseHitProb, stopQuality, valueAtRisk, liqDistance, breakeven, positionRisk } from '../src/risk-engine';

describe('risk-engine — stop quality, VaR, liq, fees', () => {
    it('normCdf matches known values', () => {
        expect(normCdf(0)).toBeCloseTo(0.5, 6);
        expect(normCdf(1.645)).toBeCloseTo(0.95, 3);
        expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
    });

    it('noiseHitProb: first-passage 2·Φ(−d/σ), monotone in stop distance', () => {
        // stop exactly 1σ away: d/σ=1 → 2·Φ(−1)=2·0.1587=0.3173
        const entry = 100, sigma = 0.05;            // 5% horizon vol
        const stop1s = entry * Math.exp(-sigma);    // 1σ below
        expect(noiseHitProb(entry, stop1s, sigma)).toBeCloseTo(0.3173, 3);
        // wider stop → lower noise-hit
        const stop2s = entry * Math.exp(-2 * sigma);
        expect(noiseHitProb(entry, stop2s, sigma)).toBeLessThan(noiseHitProb(entry, stop1s, sigma));
        expect(noiseHitProb(entry, stop2s, sigma)).toBeCloseTo(2 * normCdf(-2), 4);
    });

    it('stopQuality rates tight stops worse', () => {
        const entry = 65000, sigma = 0.027;
        const tight = stopQuality(entry, entry * 0.99, sigma);   // ~0.37σ → high noise-hit
        const wide = stopQuality(entry, entry * 0.94, sigma);    // ~2.3σ → low
        expect(tight.noiseHit).toBeGreaterThan(wide.noiseHit);
        expect(wide.rating).toBe('WIDE');
        expect(tight.distSigma).toBeLessThan(wide.distSigma);
    });

    it('valueAtRisk: empirical fat-tail > Gaussian', () => {
        const v = valueAtRisk(10000, 0.027, { s2: 2.20, s99: 3.51 });
        expect(v.var95).toBeCloseTo(10000 * 0.027 * 1.645, 4);
        expect(v.var95emp).toBeCloseTo(10000 * 0.027 * 2.20, 4);
        expect(v.var95emp).toBeGreaterThan(v.var95);             // fat tails → bigger
        expect(v.var99emp).toBeGreaterThan(v.var99);
        expect(v.es95).toBeGreaterThan(v.var95);
    });

    it('liqDistance: leverage closer to entry, expressed in σ', () => {
        const l3 = liqDistance(65000, 3, 0.027, 'long');
        const l10 = liqDistance(65000, 10, 0.027, 'long');
        expect(l3.liqPrice).toBeCloseTo(65000 * (1 - 1 / 3), 2);
        expect(l10.liqPrice).toBeGreaterThan(l3.liqPrice);       // 10x liq is closer (higher price for long)
        expect(l10.sigmaMult).toBeLessThan(l3.sigmaMult);        // closer in σ → more dangerous
    });

    it('breakeven: venue round-trip fees', () => {
        expect(breakeven('binance')!.roundTrip).toBeCloseTo(0.0010, 6);
        expect(breakeven('coinbase_intx')!.roundTrip).toBeGreaterThan(breakeven('binance')!.roundTrip);
        expect(breakeven('nope')).toBeNull();
    });

    it('positionRisk assembles the full picture', () => {
        const r = positionRisk(
            { entry: 65000, stop: 63000, positionValue: 25000, leverage: 4, dir: 'long', venue: 'coinbase_intx' },
            0.027, { s2: 2.20, s99: 3.51 });
        expect(r.stop!.rating).toBeDefined();
        expect(r.var.var95emp).toBeGreaterThan(0);
        expect(r.liq!.liqPrice).toBeCloseTo(65000 * 0.75, 2);
        expect(r.fees!.label).toContain('Coinbase');
    });
});
