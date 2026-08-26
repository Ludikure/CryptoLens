// Divergence is context, not a gate (2026-08-25, envelope-rules.md Part 6 + follow-up).
//
// CONVERTED TO BEHAVIOURAL 2026-08-26. This file used to be regexes over `prompt.ts` source text,
// which never execute the envelope: they pin an implementation spelling, so they pass when the
// behaviour is wrong and fail when it is right but written differently.
//
// EVIDENCE STATUS, stated plainly: Part 6's measurement is UNSUPPORTED — it scored divergence on
// `d0.25_{side}_oppR`, a column produced by the retracted 4-hour-lookahead simulation. What survives
// is Part 6's PRINCIPLE (a rule claiming predictive power must earn it), which is a prior rather
// than a measurement, plus the episode-level correction (a daily divergence episode runs ~44 bars,
// so the per-bar significance was autocorrelation). These tests therefore pin the CURRENT
// behaviour so a re-decision in Phase 3 is deliberate rather than accidental — not a claim the
// removal was proven right.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { systemPrompt } from '../src/prompt';
import { envelopeFor, BIAS } from './helpers/envelope';

const STATES = [
  { name: 'aligned bullish', o: { ml: 0.80, ...BIAS.alignedBullish } },
  { name: 'aligned bearish', o: { ml: 0.62, ...BIAS.alignedBearish } },
  { name: 'higher-TF only', o: { ml: 0.55, ...BIAS.higherTfOnly } },
  { name: 'mixed', o: { ml: 0.55, ...BIAS.mixed } },
  { name: 'counter-trend pullback', o: { ml: 0.62, ...BIAS.counterTrendPullback } },
  { name: 'stock aligned bullish', o: { ml: 0.80, symbol: 'AAPL', ...BIAS.alignedBullish } },
];

describe('divergence never gates, in any envelope state', () => {
  it('no state produces a divergence auto-FLAT', () => {
    for (const { name, o } of STATES) {
      const e = envelopeFor(o as never);
      expect(`${name}: ${e.autoFlat.filter(r => /diverg/i.test(r)).join()}`).toBe(`${name}: `);
    }
  });

  it('no state produces a divergence conviction block either', () => {
    for (const { name, o } of STATES) {
      const e = envelopeFor(o as never);
      const hits = [...e.highBlocks, ...e.moderateBlocks, ...e.downgrade].filter(r => /diverg/i.test(r));
      expect(`${name}: ${hits.join()}`).toBe(`${name}: `);
    }
  });

  it('the Kill Conditions line does not list divergence where it renders at all', () => {
    // The kill block is wrapped in `if (oneHOpposes && oneH)`, so counter-trend-pullback is the
    // ONLY state in which it appears. Anything measuring a kill rule on every bar is mis-scoped.
    const p = envelopeFor({ ml: 0.62, ...BIAS.counterTrendPullback } as never).prompt;
    const line = /Kill Conditions:[^\n]*/.exec(p);
    expect(line, 'Kill Conditions line should render on a counter-trend bar').not.toBeNull();
    expect(line![0]).not.toMatch(/diverg/i);
  });

  it('the raw per-timeframe reading STAYS — the indicator block is descriptive', () => {
    // Legitimately a SOURCE check: this asserts a line exists in the descriptive block, and the
    // fixture happens not to produce a divergence reading, so behaviour cannot show it. Removing
    // one indicator because it was tested, while RSI/MACD/ADX sit there equally untested, would be
    // inconsistent — the prior is governed in the system prompt instead.
    const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
    expect(src).toMatch(/Divergence: \$\{ind\.divergence\}/);
  });

  it('no dead references survive the removal', () => {
    // Also legitimately a SOURCE check: absence of dead code is a property of the source, not of
    // behaviour. A splice or flag nothing reads still reads as live governance to the next author.
    const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
    expect(src).not.toMatch(/envDivergenceEscalated =/);
    expect(src).not.toMatch(/killParts\.push\(`divergence_against_bias/);
  });

  it('the SYSTEM prompt governs the model\'s prior, since the literature disagrees with the data', () => {
    for (const p of [systemPrompt(true), systemPrompt(false)]) {
      expect(p).toMatch(/RSI DIVERGENCE — CALIBRATION NOTE/);
      expect(p).toMatch(/do NOT cite it as evidence for a direction/i);
      expect(p).toMatch(/~44 bars/);                       // the episode correction, not the bar count
      expect(p).toMatch(/CVD divergence.*different, untested signal/s);
    }
  });
});
