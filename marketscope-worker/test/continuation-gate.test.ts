// `continuation` after Part 9 (docs/research/envelope-rules.md).
//
// The count sums exactly three 4H signals — volume confirmation, EMA stack, and funding support.
// Funding requires `derivatives`, and index.ts hard-wires those to null for stocks, so the count
// maxes at 2 on every stock. Measured: P(count = 3) is 0.87% on crypto and 0.0000% on stocks.
//
//   continuation < 3   fired on 100.0% of stock bars — HIGH conviction was structurally unreachable
//                      for the entire stock universe. On crypto it left 0.87% of bars against a
//                      declared 20% floor, and measured −0.0981R (3/9) on LONG. REMOVED.
//   continuation < 2   crypto SHORT +0.0303R at 6/9 with 22.5% coverage — clears all three
//                      criteria. Crypto LONG −0.0284R at 3/9, INVERTED. Stocks fire on 97.4%,
//                      leaving 2.56% coverage. SCOPED to crypto SHORT.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
const idx = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf-8');

describe('Part 9 — continuation', () => {
  it('continuation < 3 no longer blocks HIGH conviction', () => {
    expect(src).not.toMatch(/envContinuationCount < 3/);
    expect(src).not.toMatch(/highBlocks\.push\(`continuation_/);
  });

  it('continuation < 2 is scoped to crypto SHORT, not applied to every bar', () => {
    expect(src).toMatch(/const continuationBlockApplies = isCryptoSym && alignedDirection === 'SHORT';/);
    expect(src).toMatch(/continuationBlockApplies && envContinuationCount < 2/);
  });

  it('the transitioning hatch no longer strips a prefix nothing emits', () => {
    // A splice matching `continuation_` in highBlocks after that rule is gone reads as live
    // governance while being dead — the same shape as the conformal_abstain flag.
    expect(src).not.toMatch(/highBlocks\[i\]\.startsWith\('continuation_'\)/);
    expect(src).toMatch(/highBlocks\[i\]\.startsWith\('ML_WIN_'\)/);
  });

  it('documents WHY the largest lift in the vault was not adopted', () => {
    // continuation < 3 on crypto SHORT measured +0.1345R — on 0.87% coverage. The coverage floor
    // exists to catch exactly this, and Part 3 was already burned by a thin-slice ADOPT.
    expect(src).toMatch(/largest number in the research vault and is deliberately NOT adopted/);
  });

  it('the stock unreachability has a live source, so the finding cannot silently expire', () => {
    // If stocks ever gain derivatives enrichment, the count could reach 3 and this comment would
    // become wrong. Pin the actual gate so the test fails when the premise changes.
    expect(idx).toMatch(/isCrypto \? fetchDerivativesEnrichment\(env, symbol\)\.catch\(\(\) => null\) : Promise\.resolve\(null\)/);
  });

  it('still COMPUTES and reports the count — it is context, only the gate changed', () => {
    expect(src).toMatch(/envContinuationCount = continuation\.length;/);
    expect(src).toMatch(/L\(`Continuation Signals \(4H/);
  });
});
