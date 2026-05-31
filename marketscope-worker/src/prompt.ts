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

// ── Price formatting (mirrors Utils/Formatters.formatPrice — used pervasively in the prompt) ──
// >=1: en-US decimal, 2dp + thousands grouping ("$73,884.38"); 0.01–1: 4dp; <0.01: 6dp.
export function formatPrice(price: number): string {
  if (price >= 1) return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 0.01) return '$' + price.toFixed(4);
  return '$' + price.toFixed(6);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// buildUserPrompt — PORT ROADMAP (NOT YET IMPLEMENTED; the ~2,090-line core)
// Source: CryptoLens/Services/AnalysisPrompt.swift lines 551–2640.
//
// DESIGN (decided 2026-05-31 during scoping):
//   - STATEFUL. iOS uses UserDefaults per-symbol: `regime_<symbol>` (regime-staleness →
//     "Regime Changed") and `killDur_<symbol>` (kill-condition candle durations). The worker
//     must replicate this via KV (one blob per symbol, or a batched blob). The pure builder
//     should take `prevState` in and return `{ prompt, newState }`; /full-analysis reads/writes
//     the KV around it. Don't write state inside the builder.
//   - Post the 2026-05-30 A/B collapse, `isTreatment` is ALWAYS true — port only that branch.
//   - Uses ~15 enrichment inputs (define a PromptInput type): indicators[] (computeFullIndicators
//     output), CoinInfo, StockInfo, DerivativesData, PositioningSnapshot, StockSentimentData,
//     EconomicEvent[], MacroSnapshot, weeklyContext, spyContext, SpotPressure, DataQuality,
//     CrossAssetContext, outcomeHistory[]. /full-analysis populates these from existing fetches.
//   - Needs a captured Swift fixture (buildUserPrompt output for a symbol) for byte-parity, like
//     the indicator fixtures. Add to test/.
//   - Several sections call analyzers not yet ported: PriceActionAnalyzer (PRICE ACTION SUMMARY),
//     the level-proximity/R:R + CANDIDATE SETUPS machinery (Phase 3+4, the largest sub-block,
//     ~lines 2140–2487 in the source), Bias-Feasibility (C9), Conviction Envelope (C10).
//
// SECTION ORDER (source-line offsets within 551–2640; port in this order):
//   1. Header "Symbol: X"                                    2. DATA QUALITY
//   3. CROSS-ASSET CONTEXT                                   4. CRYPTO REGIME guard (bear/weak)
//   5. Phase 1 Regime label   6. Phase 2 Regime staleness (KV)  7. Phase 2a Counter-trend + bias
//   8. Treatment flags: STOCH_CROSS + rules                  9. Phase 2b Kill conditions
//   10. Phase 3 Kill-duration tracking (KV)                  11. Phase 5 Macro event window
//   12. C1 Parabolic flag   13. C2 After-hours floor (stock) 14. C3 Volume confirmation
//   15. C4 Momentum confirmation  16. C7 Exhaustion/Continuation counts
//   17. C9 Bias Feasibility asymmetry  18. E4/E7 Failure modes + archetype track record
//   19. E6 News-thesis conflict (stock)  20. E1 Multi-TF alignment  21. E2 Vol regime
//   22. E3 Structure levels (NEUTRAL — no strength tags, per docs/research/strategy-levels.md)
//   23. E stock-only flags (sector/insider/earnings/long-confirmation)
//   24. C10 Conviction Envelope (large)  25. C5 ML Bucket  26. C8 Active Trade State
//   27. 2d Kills-clearing  28. 2c Candle-close timestamps   29. RECENT OUTCOME HISTORY
//   30. STOCK SENTIMENT  31. MACRO CONTEXT  32. DERIVATIVES POSITIONING  33. SPOT PRESSURE
//   34. RECENTLY RELEASED / UPCOMING ECONOMIC  35. PRICE ACTION SUMMARY  36. WEEKLY / SPY
//   37. Phase 3+4 TAGGED LEVELS + R:R + CANDIDATE SETUPS (largest sub-block)
//   38. Per-timeframe indicator dumps (=== Daily/4H/1H ===)  39. RECENT CANDLES
// ═══════════════════════════════════════════════════════════════════════════════════════════
