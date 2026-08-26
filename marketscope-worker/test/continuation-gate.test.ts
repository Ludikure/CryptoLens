// `continuation` after Part 9 (envelope-rules.md).
//
// CONVERTED TO BEHAVIOURAL 2026-08-26 — these were regexes over `prompt.ts` source text.
//
// EVIDENCE STATUS: Part 9's EV measurement is UNSUPPORTED (it scored `d0.25_{side}_oppR`, the
// retracted lookahead column). Two of its findings are NOT measurements and survive independently:
//   - `continuation < 3` was DEGENERATE on stocks. One of the three signals requires derivatives,
//     and `index.ts` hard-wires those to null for stocks, so the count cannot exceed 2 and the rule
//     fired on 100% of stock bars. That is a code fact, re-asserted below against the live source.
//   - the crypto coverage figure (P(count=3) = 0.87%) is a distribution fact, not a payoff claim.
// The +0.0303R / 6/9 figure that scoped `< 2` to crypto SHORT is withdrawn pending re-measurement.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { envelopeFor, BIAS } from './helpers/envelope';

describe('Part 9 — continuation gates behaviourally', () => {
  it('never blocks HIGH conviction — the `< 3` rule is gone', () => {
    for (const o of [
      { ml: 0.80, ...BIAS.alignedBullish },
      { ml: 0.80, ...BIAS.alignedBearish },
      { ml: 0.55, ...BIAS.higherTfOnly },
      { ml: 0.80, symbol: 'AAPL', ...BIAS.alignedBullish },
      { ml: 0.55, symbol: 'AAPL', ...BIAS.alignedBearish },
    ]) {
      const e = envelopeFor(o as never);
      expect(`${JSON.stringify(o)}: ${e.highBlocks.filter(r => r.startsWith('continuation_')).join()}`)
        .toBe(`${JSON.stringify(o)}: `);
    }
  });

  it('caps a CRYPTO SHORT-biased bar, where the count is low', () => {
    const e = envelopeFor({ ml: 0.80, ...BIAS.alignedBearish });
    expect(e.moderateBlocks.some(r => r.startsWith('continuation_'))).toBe(true);
    expect(e.maxAllowed).toBe('LOW');            // and the ladder honours it (2026-08-26b)
  });

  it('does NOT cap a crypto LONG-biased bar — the rule is SHORT-scoped', () => {
    const e = envelopeFor({ ml: 0.80, ...BIAS.alignedBullish });
    expect(e.moderateBlocks.filter(r => r.startsWith('continuation_'))).toEqual([]);
  });

  it('does NOT cap a STOCK bar on either side — the rule is crypto-scoped', () => {
    for (const bias of [BIAS.alignedBullish, BIAS.alignedBearish]) {
      const e = envelopeFor({ ml: 0.80, symbol: 'AAPL', ...bias } as never);
      expect(e.moderateBlocks.filter(r => r.startsWith('continuation_'))).toEqual([]);
    }
  });

  it('still COMPUTES and reports the count — only the gate changed', () => {
    const p = envelopeFor({ ml: 0.62, ...BIAS.alignedBullish }).prompt;
    expect(p).toMatch(/Continuation Signals \(4H, with \w+ momentum\): /);
  });

  it('the stock-degeneracy premise still holds in the live source', () => {
    // A SOURCE check on purpose: if stocks ever gain derivatives enrichment the count could reach 3
    // and the Part 9 reasoning would silently expire. Pin the actual gate.
    const idx = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf-8');
    expect(idx).toMatch(/isCrypto \? fetchDerivativesEnrichment\(env, symbol\)\.catch\(\(\) => null\) : Promise\.resolve\(null\)/);
  });
});
