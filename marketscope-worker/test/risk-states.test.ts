import { describe, it, expect } from 'vitest';
import { computeRiskStates } from '../src/risk-states';

describe('risk-states — discrete risk conditions', () => {
  it('COMPRESSION fires on low ATR percentile, HIGH below 5%', () => {
    const s = computeRiskStates({ atrPercentile: 3, bbSqueeze4h: true, bbSqueezeDaily: true });
    const c = s.find(x => x.state === 'COMPRESSION')!;
    expect(c.severity).toBe('HIGH');
    expect(c.validated).toBe(true);
    expect(computeRiskStates({ atrPercentile: 30 }).length).toBe(0);   // not compressed
  });

  it('EXTREME_BAND fires when %B outside [0,1]', () => {
    expect(computeRiskStates({ bbPercentBDaily: -0.1 }).some(x => x.state === 'EXTREME_BAND')).toBe(true);
    expect(computeRiskStates({ bbPercentBDaily: 1.05 }).some(x => x.state === 'EXTREME_BAND')).toBe(true);
    expect(computeRiskStates({ bbPercentBDaily: 0.5 }).some(x => x.state === 'EXTREME_BAND')).toBe(false);
  });

  it('LIQUIDATION_SETUP is context-only (validated:false, capped MEDIUM)', () => {
    const s = computeRiskStates({ isCrypto: true, longPct: 70, cvdFalling: true, cascadeWithin2ATR: true });
    const liq = s.find(x => x.state === 'LIQUIDATION_SETUP')!;
    expect(liq.validated).toBe(false);
    expect(liq.severity).toBe('MEDIUM');           // never HIGH even with all 3 conditions
    // only one condition → no state
    expect(computeRiskStates({ isCrypto: true, longPct: 70, cvdFalling: false }).some(x => x.state === 'LIQUIDATION_SETUP')).toBe(false);
  });

  it('SQUEEZE_RISK needs crowding + funding extreme + OI building (crypto)', () => {
    expect(computeRiskStates({ isCrypto: true, longPct: 72, fundingZ: 2.5, oiChangePct: 5 })
      .some(x => x.state === 'SQUEEZE_RISK')).toBe(true);
    expect(computeRiskStates({ isCrypto: true, longPct: 72, fundingZ: 2.5, oiChangePct: -2 })
      .some(x => x.state === 'SQUEEZE_RISK')).toBe(false);   // OI not building
    expect(computeRiskStates({ isCrypto: false, longPct: 72, fundingZ: 2.5, oiChangePct: 5 })
      .some(x => x.state === 'SQUEEZE_RISK')).toBe(false);   // stocks: no derivatives
  });

  it('sorts HIGH first, validated before context', () => {
    const s = computeRiskStates({ atrPercentile: 3, isCrypto: true, longPct: 70, cvdFalling: true, cascadeWithin2ATR: true, macroImminent: true });
    expect(s[0].severity).toBe('HIGH');
    const liqIdx = s.findIndex(x => x.state === 'LIQUIDATION_SETUP');
    const compIdx = s.findIndex(x => x.state === 'COMPRESSION');
    expect(compIdx).toBeLessThan(liqIdx);          // validated COMPRESSION before context LIQUIDATION
  });
});
