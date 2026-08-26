// The stock-only envelope conditions, after Part 8 (docs/research/envelope-rules.md).
//
// Part 7 filed all four as untestable — "stocks only, no stock intraday paths". That described a
// directory, not a data gap: the stock hourly bars have been in the box's own candle archive since
// 2019-01-07. 487,155 opportunities, 159 symbols, the app's own geometry.
//
//   treatment_long_confirm_FAIL   4/9 periods, +0.0007R global, −0.0070R on the LONG bars it
//                                 governs. Hard block, no benefit, mild inversion → REMOVED.
//   treatment_long_confirm_PARTIAL +0.0074R, 6/9. Soft cap, mildly positive → KEPT.
//   treatment_short_gate_stocks   the ban is right (−0.1123R blocked vs a −0.0457R stock-SHORT
//                                 average, 8/9); the three-way escape hatch fired on 7 bars in
//                                 four years and those averaged −0.2082R → hatch REMOVED.
//   earnings 0-2d / 3-7d / 8-14d  the FIRST envelope conditions validated on their own stated
//                                 mechanism: P(overnight gap ≥ 2 ATR) runs 7.1x / 7.0x / 5.0x the
//                                 away-from-earnings baseline, in 8/8, 9/9, 9/9 periods → KEPT,
//                                 with the measured numbers now carried into the prompt.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');

describe('Part 8 — stock-only envelope conditions', () => {
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
