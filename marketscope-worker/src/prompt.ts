// Shared LLM prompt builder — TS port of CryptoLens/Services/AnalysisPrompt.swift, so the web
// app (and, after Phase 4, iOS) build one identical prompt instead of duplicating ~2,700 lines.
//
// systemPrompt is byte-extracted from the Swift source (scripts/extract_system_prompt.py →
// prompt-system.json) for guaranteed parity. classifyArchetype / useTighterBands / parseSetups
// are ported here. buildUserPrompt (the ~2,090-line pre-computed-flags core) is ported next.
//
// Post the 2026-05-30 A/B collapse, the treatment path is always active, so useTighterBands
// uses the treatment rule (tighter-by-default, trendingSymbols opt out).

import systemPrompts from './prompt-system.json';

export function systemPrompt(isCrypto: boolean): string {
  return isCrypto ? (systemPrompts as { crypto: string }).crypto : (systemPrompts as { stock: string }).stock;
}

// ── Band selection (mirrors AnalysisPrompt.useTighterBands, treatment path) ──
const TRENDING_SYMBOLS = new Set([
  'GLD', 'COIN', 'PFE', 'GME', 'CAT', 'TEAM', 'XLC', 'SNAP', 'ON', 'NVDA',
  'JUPUSDT', 'INTC', 'MU', 'HBARUSDT', 'NEOUSDT', 'ENJUSDT', 'CMG', 'TIAUSDT',
]);
export function useTighterBands(symbol: string): boolean {
  return !TRENDING_SYMBOLS.has(symbol.toUpperCase());
}

// ── Archetype classification (mirrors AnalysisPrompt.classifyArchetype) ──
interface ArchetypeInput {
  bias: string;
  adx: { adx: number } | null;
  ema20: number | null; ema50: number | null; ema200: number | null;
  bollingerBands?: { squeeze?: boolean } | null;
}
export function classifyArchetype(indicators: ArchetypeInput[]): string {
  if (indicators.length < 2) return 'UNCLEAR_INSUFFICIENT_DATA';
  const daily = indicators[0], fourH = indicators[1], oneH = indicators.length > 2 ? indicators[2] : null;
  const dB = daily.bias.includes('Bullish'), dBr = daily.bias.includes('Bearish');
  const hB = fourH.bias.includes('Bullish'), hBr = fourH.bias.includes('Bearish');
  const oB = oneH?.bias.includes('Bullish') ?? false, oBr = oneH?.bias.includes('Bearish') ?? false;

  const dirAligned4 = (dB && hB) || (dBr && hBr);
  const allAligned = (dB && hB && oB) || (dBr && hBr && oBr);
  const oneHCounters = dirAligned4 && ((dB && oBr) || (dBr && oB));
  const counterTrendDisagree = !dirAligned4 && (dB || dBr) && (hB || hBr);

  if (counterTrendDisagree) return 'COUNTER_TREND_REVERSAL';
  if (oneHCounters) return 'COUNTER_TREND_PULLBACK';
  if (allAligned) return 'MOMENTUM_CONTINUATION';

  const adxDaily = daily.adx?.adx ?? 0;
  let maAlignment = 'tangled';
  if (daily.ema20 !== null && daily.ema50 !== null && daily.ema200 !== null) {
    if (daily.ema20 > daily.ema50 && daily.ema50 > daily.ema200) maAlignment = 'bullish_stacked';
    else if (daily.ema20 < daily.ema50 && daily.ema50 < daily.ema200) maAlignment = 'bearish_stacked';
  }
  const bbSqueezeAny = indicators.some(i => i.bollingerBands?.squeeze === true);
  if (adxDaily > 25 && maAlignment !== 'tangled') return 'MOMENTUM_CONTINUATION';
  if (bbSqueezeAny || (adxDaily >= 20 && adxDaily <= 25)) return 'BREAKOUT_RETEST';
  if (adxDaily < 20) return 'RANGE_EDGE_FADE';
  return 'UNCLEAR_NO_STRONG_DIRECTION';
}

// ── Setup parsing (mirrors AnalysisPrompt.parseSetups / decodeSetups) ──
export interface TradeSetup {
  direction: string; entry: number; stopLoss: number; tp1: number; tp2: number | null;
  reasoning?: string; suggestedQty?: number;
}
function decodeSetups(jsonString: string): TradeSetup[] {
  try {
    const arr = JSON.parse(jsonString);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x: any) => x && typeof x.entry === 'number' && typeof x.stopLoss === 'number'
        && typeof x.tp1 === 'number' && typeof x.direction === 'string')
      .map((x: any) => ({
        direction: x.direction, entry: x.entry, stopLoss: x.stopLoss, tp1: x.tp1,
        tp2: typeof x.tp2 === 'number' ? x.tp2 : null,
        reasoning: typeof x.reasoning === 'string' ? x.reasoning : undefined,
        suggestedQty: typeof x.suggestedQty === 'number' ? x.suggestedQty : undefined,
      }));
  } catch { return []; }
}
export function parseSetups(text: string): TradeSetup[] {
  const fenced = text.match(/```json\n([\s\S]*?)\n```/);
  if (fenced) return decodeSetups(fenced[1]);
  const inline = text.match(/```json([\s\S]*?)```/);
  if (inline) return decodeSetups(inline[1].trim());
  return [];
}
