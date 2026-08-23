import { describe, it, expect } from 'vitest';
import { annualizeBasis, netAnnualized, rallyToMarginCall, findBasisOpportunities, type BasisRow } from '../src/basis';

const row = (o: Partial<BasisRow> = {}): BasisRow => ({
  productId: 'BIT-25SEP26-CDE', underlying: 'BTC', futuresPrice: 78220, spotPrice: 77366,
  basis: 78220 / 77366 - 1, daysToExpiry: 32.9, annualized: 0.129, contractSize: 0.01,
  notionalPerContract: 773.66, volume24h: 39139, expiry: '2026-09-25T15:00:00Z', ...o,
});

describe('annualizeBasis', () => {
  it('reproduces the live BTC September reading', () => {
    // spot 77,366 -> future 78,220 over 32.9 days = 1.104% raw, ~12.9% compounded
    const a = annualizeBasis(77366, 78220, 32.9)!;
    expect(a).toBeGreaterThan(0.12);
    expect(a).toBeLessThan(0.14);
  });

  it('compounds rather than scaling linearly', () => {
    // 1% over 30d is >12.0% compounded; linear scaling would give exactly 12.17%
    const a = annualizeBasis(100, 101, 30)!;
    expect(a).toBeGreaterThan(0.1217);
  });

  it('returns null for a sub-day expiry instead of a fantasy rate', () => {
    // guards the exponent: 0.1% over 0.2 days would annualise to something absurd
    expect(annualizeBasis(100, 100.1, 0.2)).toBeNull();
  });

  it('handles backwardation (negative carry) without blowing up', () => {
    const a = annualizeBasis(100, 99, 30)!;
    expect(a).toBeLessThan(0);
  });

  it('rejects degenerate inputs', () => {
    expect(annualizeBasis(0, 100, 30)).toBeNull();
    expect(annualizeBasis(100, 0, 30)).toBeNull();
    expect(annualizeBasis(100, 101, 0)).toBeNull();
  });
});

describe('netAnnualized', () => {
  it('covered form (futures legs only) keeps most of the edge', () => {
    const net = netAnnualized(77366, 78220, 32.9, 0.001)!;
    expect(net).toBeGreaterThan(0.09);   // ~10% survives two 0.10% legs
  });

  it('buying the spot leg destroys it — the finding that makes this covered-only', () => {
    // 0.40% per side (Coinbase retail maker spot) against a 1.10% basis
    const net = netAnnualized(77366, 78220, 32.9, 0.004)!;
    expect(net).toBeLessThan(0.04);
  });

  it('reports a linear rate when net is negative rather than compounding a loss', () => {
    const net = netAnnualized(100, 100.1, 30, 0.004)!;
    expect(net).toBeLessThan(0);
    expect(Number.isFinite(net)).toBe(true);
  });
});

describe('rallyToMarginCall', () => {
  it('reports the ~29% buffer at the Coinbase overnight short rate', () => {
    expect(rallyToMarginCall(0.289)).toBeCloseTo(0.289, 5);
  });
  it('scales with an explicit cushion', () => {
    expect(rallyToMarginCall(0.289, 2)).toBeCloseTo(0.578, 5);
  });
});

describe('findBasisOpportunities', () => {
  it('surfaces a contract paying above the threshold', () => {
    const out = findBasisOpportunities([row()], 0.05);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toContain('BTC');
  });

  it('suppresses an illiquid contract however good the print looks', () => {
    // a stale print on a no-volume contract is not an opportunity — crossing its spread
    // would give back more than the premium
    const out = findBasisOpportunities([row({ volume24h: 12, futuresPrice: 80000 })], 0.05);
    expect(out).toHaveLength(0);
  });

  it('suppresses a contract below the net threshold', () => {
    expect(findBasisOpportunities([row()], 0.99)).toHaveLength(0);
  });

  it('gates on NET, not gross — the same basis passes covered and fails if spot must be bought', () => {
    // 0.60% gross over 33d: ~4.5% annualized against two 0.10% futures legs, but NEGATIVE once
    // the ~0.40%/side spot leg is charged. This is the whole covered-vs-textbook distinction.
    const thin = row({ futuresPrice: 77830, basis: 77830 / 77366 - 1 });
    expect(findBasisOpportunities([thin], 0.03, 1000, 0.001).length).toBe(1);
    expect(findBasisOpportunities([thin], 0.03, 1000, 0.004).length).toBe(0);
  });
});
