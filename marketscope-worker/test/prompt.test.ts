import { describe, it, expect } from 'vitest';
import { systemPrompt, classifyArchetype, useTighterBands, parseSetups } from '../src/prompt';

describe('prompt.ts (AnalysisPrompt port)', () => {
  it('systemPrompt returns the byte-extracted text per market', () => {
    const c = systemPrompt(true), s = systemPrompt(false);
    expect(c.startsWith('You are MarketScope — a trader, not an analyst')).toBe(true);
    expect(c).toContain('CRYPTO CONTEXT');
    expect(c).toContain('DERIVATIVES POSITIONING');
    expect(s).toContain('STOCK CONTEXT');
    expect(s).toContain('MACRO CONTEXT');
    expect(s).not.toContain('CRYPTO CONTEXT');
    expect(c).not.toContain('\\(');  // no unresolved interpolations
    expect(c.length).toBeGreaterThan(20000);
  });

  it('useTighterBands: tighter by default, trending opt out', () => {
    expect(useTighterBands('BTCUSDT')).toBe(true);
    expect(useTighterBands('nvda')).toBe(false);   // case-insensitive, trending
    expect(useTighterBands('JUPUSDT')).toBe(false);
  });

  it('classifyArchetype directional cases', () => {
    const ind = (bias: string) => ({ bias, adx: { adx: 30 }, ema20: 3, ema50: 2, ema200: 1, bollingerBands: null });
    expect(classifyArchetype([ind('Strong Bullish'), ind('Bullish'), ind('Bullish')])).toBe('MOMENTUM_CONTINUATION');
    expect(classifyArchetype([ind('Bullish'), ind('Bullish'), ind('Bearish')])).toBe('COUNTER_TREND_PULLBACK');
    expect(classifyArchetype([ind('Bullish'), ind('Bearish'), ind('Neutral')])).toBe('COUNTER_TREND_REVERSAL');
    expect(classifyArchetype([ind('Neutral')])).toBe('UNCLEAR_INSUFFICIENT_DATA');
  });

  it('parseSetups extracts the JSON block', () => {
    const txt = 'analysis...\n```json\n[{"direction":"LONG","entry":65000,"stopLoss":63500,"tp1":67000,"tp2":69000,"reasoning":"x"}]\n```';
    const s = parseSetups(txt);
    expect(s.length).toBe(1);
    expect(s[0].direction).toBe('LONG');
    expect(s[0].entry).toBe(65000);
    expect(s[0].tp2).toBe(69000);
    expect(parseSetups('no json here []')).toEqual([]);
    expect(parseSetups('```json\n[]\n```')).toEqual([]);
  });
});
