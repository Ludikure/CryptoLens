import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { envelopeFor, BIAS, MIN_STOCK_INFO } from './helpers/envelope';

const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
const NOW_MS = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'btc-rally-2026-08.json'), 'utf-8'))
  .fourH.slice(-1)[0].time + 14400e3;
const stock = (o: Record<string, unknown> = {}) => ({ symbol: 'AAPL', ...o });

// CONVERTED TO BEHAVIOURAL 2026-08-26. EVIDENCE STATUS: Part 8's EV arms are UNSUPPORTED (they
// scored the retracted lookahead column) AND its LONG_CONFIRMATION reconstruction used quantities
// the live rule does not use — `relStrengthVsSpy` is a 5-day return where the live gate reads the
// 1-day `relativeStrength1d`, and the live day-over-day daily-RSI delta is not exported under any
// name, so those arms cannot be re-run without an export change. The earnings VARIANCE test is
// independent of the entry simulation and survives. These tests pin CURRENT behaviour so Phase 3
// re-decides deliberately.
describe('Part 8 behaviour — stock-only envelope conditions', () => {
  it('a failing LONG_CONFIRMATION does not auto-FLAT; it caps', () => {
    const e = envelopeFor(stock({ ml: 0.80, ...BIAS.alignedBullish,
      stockInfo: { ...MIN_STOCK_INFO, relativeStrength1d: -3 } }) as never);
    expect(e.autoFlat).toEqual([]);
    expect(e.moderateBlocks).toContain('treatment_long_confirm_PARTIAL_cap_LOW');
    expect(e.maxAllowed).toBe('LOW');
  });

  it('a passing LONG_CONFIRMATION leaves conviction unrestricted', () => {
    const e = envelopeFor(stock({ ml: 0.80, ...BIAS.alignedBullish,
      stockInfo: { ...MIN_STOCK_INFO, relativeStrength1d: 5 } }) as never);
    expect(e.moderateBlocks.filter(r => r.startsWith('treatment_long_confirm'))).toEqual([]);
    expect(e.maxAllowed).toBe('HIGH');
  });

  it('aligned-bearish stock SHORTs are blocked, and the label carries no withdrawn number', () => {
    const e = envelopeFor(stock({ ml: 0.55, ...BIAS.alignedBearish }) as never);
    expect(e.autoFlat).toContain('aligned_bearish_stock_SHORT_evidence_under_review');
    expect(e.maxAllowed).toBe('FLAT');
    expect(e.autoFlat.join()).not.toMatch(/-0\.11R/);
  });

  it('the same bias on CRYPTO is not blocked by that stock-only rule', () => {
    const e = envelopeFor({ ml: 0.55, ...BIAS.alignedBearish } as never);
    expect(e.autoFlat.filter(r => r.startsWith('aligned_bearish_stock_SHORT'))).toEqual([]);
  });

  it('the earnings windows cap by distance, and the ladder honours them', () => {
    for (const [days, list, tier] of [
      [1, 'moderateBlocks', 'LOW'], [5, 'highBlocks', 'MODERATE'], [10, 'downgrade', 'HIGH'],
    ] as const) {
      const e = envelopeFor(stock({ ml: 0.80, ...BIAS.alignedBullish,
        stockInfo: { ...MIN_STOCK_INFO, earningsDate: NOW_MS + days * 86_400_000 } }) as never);
      const reasons = (e as never as Record<string, string[]>)[list];
      expect(`${days}d in ${list}: ${reasons.join()}`)
        .toMatch(new RegExp(`^${days}d in ${list}: earnings_in_${days}d_`));
      expect(`${days}d tier: ${e.maxAllowed}`).toBe(`${days}d tier: ${tier}`);
    }
  });

  it('no earnings date means no earnings gate', () => {
    const e = envelopeFor(stock({ ml: 0.80, ...BIAS.alignedBullish }) as never);
    expect([...e.autoFlat, ...e.highBlocks, ...e.moderateBlocks, ...e.downgrade]
      .filter(r => r.startsWith('earnings_'))).toEqual([]);
  });
});

// Source checks kept deliberately: absence of dead code and the exact prompt WORDING are properties
// of the source, not of the envelope's verdict.
describe('Part 8 — source-level properties', () => {
  it('treatment_long_confirm_FAIL can no longer auto-FLAT', () => {
    expect(src).not.toMatch(/autoFlat\.push\('treatment_long_confirm_FAIL'\)/);
  });

  it('the LONG_CONFIRMATION line no longer claims FAIL blocks the trade', () => {
    // The 2026-08-22g failure mode in reverse: leaving "FAIL — no LONG trade" in the prompt would
    // instruct the model to stand aside on a rule the envelope stopped enforcing.
    expect(src).not.toMatch(/'FAIL — no LONG trade'/);
    expect(src).toMatch(/FAIL — context only, NOT a block/);
  });

  it('keeps the PARTIAL conviction cap — it measured mildly positive and is a soft cap', () => {
    expect(src).toMatch(/treatmentLongConfirmStatus === 'PARTIAL'\) moderateBlocks\.push\('treatment_long_confirm_PARTIAL_cap_LOW'\)/);
  });

  it('aligned-bearish stock SHORTs are still blocked', () => {
    expect(src).toMatch(/isStock && alignedDirection === 'SHORT' && envAlignment === 'ALIGNED_BEARISH'/);
    // The -0.11R came from the retracted lookahead column and is withdrawn; the gate stands on the
    // anchor-independent coverage fact that its escape hatch fired 7 times in four years.
    expect(src).not.toMatch(/aligned_bearish_stock_SHORT_measured_-0\.11R/);
    expect(src).toMatch(/autoFlat\.push\('aligned_bearish_stock_SHORT_evidence_under_review'\)/);
  });

  it('drops the inert three-way escape hatch rather than leaving a rule that never fires', () => {
    // ML≥70 on 1.4% of applicable bars, 4H Stoch bearish on 11.5%, TRENDING on 32.0% — all three
    // together on 0.02%. A condition claiming predictive power has to earn it (Part 6 principle).
    expect(src).not.toMatch(/treatment_short_gate_stocks\(/);
    expect(src).not.toMatch(/stochOk = treatmentStochCross4H === 'bearish', regimeOk/);
  });

  it('carries the measured gap numbers into all three earnings windows', () => {
    // "gap risk" as a bare phrase invites the model to weigh it against a chart pattern.
    // "43% of stops fill BEYOND the stop" does not.
    // The stop-fill clause was withdrawn 2026-08-26 (it came from stock_gap_fill.py on the
    // retracted anchor). The GAP RATES survive — they compare gap frequency near vs far from
    // earnings, which a window shift of a few bars does not move — and are re-run in Phase 2.
    expect(src).toMatch(/52% of bars see an overnight gap >= 2 ATR against a 7\.4% baseline \(7\.1x\)/);
    expect(src).not.toMatch(/43% of stops fill BEYOND the stop/);
    expect(src).toMatch(/CONVICTION_CAP_MODERATE\. MEASURED: gap >= 2 ATR on 52% of bars \(7\.0x baseline\)/);
    expect(src).toMatch(/MEASURED: still 5\.0x the baseline gap rate/);
  });

  it('states the earnings finding as variance, never as direction', () => {
    // Every other envelope condition that claimed to predict direction measured inverted. This one
    // claims variance and delivered, and the prompt must not let it drift into a direction call.
    expect(src).toMatch(/This is a variance fact, not a direction call\./);
  });
});
