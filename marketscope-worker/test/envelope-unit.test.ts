import { describe, it, expect } from 'vitest';
import { evaluateEnvelope, type EnvelopeInput } from '../src/envelope';

// Unit coverage for the extracted Conviction Envelope (2026-08-26, plan step 1.8).
//
// `test/envelope-ladder.test.ts` exercises the same rules THROUGH a real prompt built from the real
// BTC tape — that is the integration check and it stays. These tests are the complement: they call
// the rule function directly, which is the only way to see the three verdict lists the prompt
// discards on a FLAT bar, and it makes exhaustive property checks cheap enough to be worth running.

/** A deliberately quiet bar: nothing fires, so each test turns on exactly what it is about. */
const CLEAN: EnvelopeInput = {
  rawMlWin: 0.80, calibratedMlWin: 0.80, staleCount: 0, anyKilled: false,
  macroRisk: 'NONE', newsConflicts: false, alignment: 'ALIGNED_BULLISH', alignedDirection: 'LONG',
  continuationCount: 3, isCrypto: true, isStock: false, isTreatment: true,
  regime: 'TRENDING', longConfirmStatus: 'n/a', oneHOpposes: false, cryptoBearRegime: false,
  daysToEarnings: null,
};
const on = (o: Partial<EnvelopeInput>) => {
  const v = evaluateEnvelope({ ...CLEAN, ...o });
  const all = [...v.autoFlat, ...v.highBlocks, ...v.moderateBlocks, ...v.downgrade];
  return { ...v, has: (prefix: string) => all.some(r => r.startsWith(prefix)) };
};

describe('the cap ladder is monotone', () => {
  // The 2026-08-26b defect in property form: `highBlocks` cap at MODERATE and `moderateBlocks` cap
  // at LOW, so a moderateBlock must never be overridden by the absence of a highBlock.
  const STATES: Array<[string, Partial<EnvelopeInput>]> = [
    ['clean', {}],
    ['ML under 70 (highBlock)', { rawMlWin: 0.65, calibratedMlWin: 0.65 }],
    ['ML under 60 (moderateBlock, no highBlock left uncovered)', { rawMlWin: 0.55, calibratedMlWin: 0.55 }],
    ['ML under 50 (autoFlat)', { rawMlWin: 0.40, calibratedMlWin: 0.40 }],
    ['crypto SHORT with no continuation (moderateBlock only)',
      { alignedDirection: 'SHORT', alignment: 'ALIGNED_BEARISH', continuationCount: 0 }],
    ['macro NEARBY (both tiers)', { macroRisk: 'NEARBY' }],
    ['macro UPCOMING (highBlock only)', { macroRisk: 'UPCOMING' }],
    ['stock one day from earnings (moderateBlock only)',
      { isCrypto: false, isStock: true, daysToEarnings: 1 }],
    ['stock five days from earnings (highBlock only)',
      { isCrypto: false, isStock: true, daysToEarnings: 5 }],
    ['news conflict (highBlock only)', { newsConflicts: true }],
    ['killed (autoFlat)', { anyKilled: true }],
  ];

  for (const [name, patch] of STATES) {
    it(`holds for: ${name}`, () => {
      const v = on(patch);
      const expected = v.autoFlat.length ? 'FLAT'
        : v.moderateBlocks.length ? 'LOW'
        : v.highBlocks.length ? 'MODERATE' : 'HIGH';
      expect(v.maxAllowed).toBe(expected);
      // The invariant that actually matters, stated independently of the implementation: a
      // disallowed MODERATE can never coexist with an allowed HIGH.
      if (v.moderateBlocks.length) expect(v.maxAllowed).not.toBe('HIGH');
      if (v.highBlocks.length) expect(['MODERATE', 'LOW', 'FLAT']).toContain(v.maxAllowed);
    });
  }

  it('a stock one day from earnings cannot report HIGH', () => {
    // The exact bar the ladder bug mis-reported. The 0-2d earnings gate is the one condition in
    // this system validated on its own stated mechanism (7.08x the baseline gap rate, 8/8 periods),
    // and it was being overridden to the TOP tier.
    const v = on({ isCrypto: false, isStock: true, daysToEarnings: 1 });
    expect(v.moderateBlocks).toContain('earnings_in_1d_cap_LOW');
    expect(v.maxAllowed).toBe('LOW');
  });
});

describe('the verdict lists survive an auto-FLAT', () => {
  // This is the property the extraction exists for. `buildUserPrompt` renders the three block lists
  // only in the `else` branch of `if (autoFlat.length)`, so on a FLAT bar they are computed and
  // thrown away — unobservable to the exporter and to every measurement made so far.
  it('a FLAT bar still reports why HIGH and MODERATE were blocked', () => {
    const v = on({ rawMlWin: 0.30, calibratedMlWin: 0.30, macroRisk: 'IMMINENT' });
    expect(v.maxAllowed).toBe('FLAT');
    expect(v.autoFlat).toEqual(['ML_WIN_30%<50_(calibrated_from_raw_30%)', 'macro_IMMINENT']);
    expect(v.highBlocks).toContain('ML_WIN_30<70');
    expect(v.moderateBlocks).toContain('ML_WIN_30<60');
  });
});

describe('direction- and market-scoping', () => {
  // Every one of these was one rule averaged across two populations until 2026-08-25, which is how
  // an inverted gate hid inside a working one.
  it('alignment_not_full applies to LONG, not SHORT', () => {
    expect(on({ alignment: 'MIXED', alignedDirection: 'LONG' }).has('alignment_')).toBe(true);
    expect(on({ alignment: 'MIXED', alignedDirection: 'SHORT' }).has('alignment_')).toBe(false);
  });

  it('the continuation cap applies to crypto SHORT only', () => {
    const fires = (o: Partial<EnvelopeInput>) =>
      on({ continuationCount: 0, ...o }).moderateBlocks.some(r => r.startsWith('continuation_'));
    expect(fires({ isCrypto: true, alignedDirection: 'SHORT', alignment: 'ALIGNED_BEARISH' })).toBe(true);
    expect(fires({ isCrypto: true, alignedDirection: 'LONG' })).toBe(false);
    expect(fires({ isCrypto: false, isStock: true, alignedDirection: 'SHORT', alignment: 'ALIGNED_BEARISH' })).toBe(false);
  });

  it('the aligned-bearish stock SHORT ban is stock-only and carries no withdrawn number', () => {
    const stock = on({ isCrypto: false, isStock: true, alignedDirection: 'SHORT', alignment: 'ALIGNED_BEARISH' });
    expect(stock.autoFlat).toContain('aligned_bearish_stock_SHORT_evidence_under_review');
    expect(stock.autoFlat.join()).not.toMatch(/-0\.11R/);
    const crypto = on({ alignedDirection: 'SHORT', alignment: 'ALIGNED_BEARISH' });
    expect(crypto.autoFlat.some(r => r.startsWith('aligned_bearish'))).toBe(false);
  });
});

describe('gate thresholds are compared against an attainable range', () => {
  // The Part 9 lesson, as an assertion rather than a comment: `continuation < 3` shipped against a
  // quantity that reaches 3 on 0.87% of crypto bars and NEVER on stocks, because funding — the
  // third signal — is null for stocks by construction (index.ts:492). A 0% or 100% fire rate is the
  // tell, and checking a threshold against its variable's domain costs nothing.
  it('the continuation threshold is satisfiable across the domain, and not universal', () => {
    const fired = [0, 1, 2, 3].map(continuationCount =>
      on({ continuationCount, alignedDirection: 'SHORT', alignment: 'ALIGNED_BEARISH' })
        .moderateBlocks.some(r => r.startsWith('continuation_')));
    expect(fired).toEqual([true, true, false, false]);
  });

  it('the macro ladder distinguishes all five tiers rather than collapsing', () => {
    const tier = (macroRisk: string) => on({ macroRisk }).maxAllowed;
    expect(tier('NONE')).toBe('HIGH');
    expect(tier('ON_HORIZON')).toBe('HIGH');
    expect(tier('UPCOMING')).toBe('MODERATE');
    expect(tier('NEARBY')).toBe('LOW');
    expect(tier('IMMINENT')).toBe('FLAT');
  });
});

describe('the calibrated value is what the gates read', () => {
  it('a raw value under the floor does not FLAT when the live curve lifts it', () => {
    const v = on({ rawMlWin: 0.45, calibratedMlWin: 0.62 });
    expect(v.autoFlat).toEqual([]);
    expect(v.calibLifted).toBe(true);
    expect(v.rawMlPct).toBe(45);
    expect(v.mlPct).toBe(62);
  });

  it('with no calibration available the raw value gates, and says so', () => {
    const v = on({ rawMlWin: 0.45, calibratedMlWin: null });
    expect(v.autoFlat).toEqual(['ML_WIN_45%<50']);
    expect(v.calibLifted).toBe(false);
  });

  it('a missing ML value gates nothing on ML — it must not read as zero', () => {
    const v = on({ rawMlWin: null, calibratedMlWin: null });
    expect(v.mlPct).toBeNull();
    expect([...v.autoFlat, ...v.highBlocks, ...v.moderateBlocks].some(r => r.startsWith('ML_WIN'))).toBe(false);
  });
});
