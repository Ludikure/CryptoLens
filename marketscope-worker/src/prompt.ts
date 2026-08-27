// Shared LLM prompt builder. This is now the SINGLE SOURCE OF TRUTH for the analysis prompt:
// both the web app and iOS (thin client) call /full-analysis, which builds the prompt here.
// The old on-device Swift prompt builder (CryptoLens/Services/AnalysisPrompt.buildUserPrompt
// + systemPrompt + the Claude/Gemini/DeepSeek local services) was DELETED once the live path
// moved fully server-side — there is no longer a Swift counterpart to stay in parity with.
//
// systemPrompt text lives in prompt-system.json (now canonical — it was originally extracted
// from the Swift source via scripts/extract_system_prompt.py, but that source is gone, so the
// JSON is hand-maintained going forward; the extract script is defunct). classifyArchetype /
// useTighterBands / parseSetups are implemented here.
//
// Post the 2026-05-30 A/B collapse, the treatment path is always active, so useTighterBands
// uses the treatment rule (tighter-by-default, trendingSymbols opt out).

import systemPrompts from './prompt-system.json';
import { stopQuality } from './risk-engine';
import { tailRiskInfo } from './ml-predict';
import { evaluateEnvelope, type EnvelopeInput, type EnvelopeVerdict } from './envelope';

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
      }))
      // Geometry gate: the LLM occasionally emits a directionally-INVALID setup (e.g. a SHORT
      // with its stop BELOW entry, on the same side as the targets — the stop lands in profit
      // territory). Such a setup is unsizable (risk-per-unit points the wrong way) and would
      // mis-register in the outcome tracker. Drop it rather than surface a broken trade — better
      // to show no setup than one whose stop can't stop anything. Logged so we can see the rate.
      .filter((s) => {
        if (isValidSetupGeometry(s)) return true;
        console.log(`[setup] dropped invalid ${s.direction} geometry: entry=${s.entry} stop=${s.stopLoss} tp1=${s.tp1} tp2=${s.tp2}`);
        return false;
      });
  } catch { return []; }
}

/// A setup is geometrically valid only when the stop sits on the LOSING side of entry and every
/// target on the WINNING side — LONG: stop < entry < tp1(/tp2); SHORT: stop > entry > tp1(/tp2).
export function isValidSetupGeometry(s: { direction: string; entry: number; stopLoss: number; tp1: number; tp2?: number | null }): boolean {
  const dir = s.direction.toUpperCase();
  const { entry, stopLoss: stop, tp1, tp2 } = s;
  if (![entry, stop, tp1].every(Number.isFinite) || entry <= 0) return false;
  if (dir === 'LONG') {
    if (!(stop < entry && tp1 > entry)) return false;
    if (tp2 != null && !(tp2 > entry)) return false;
    return true;
  }
  if (dir === 'SHORT') {
    if (!(stop > entry && tp1 < entry)) return false;
    if (tp2 != null && !(tp2 < entry)) return false;
    return true;
  }
  return false;  // unknown direction
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

// ── Other formatters (mirror Utils/Formatters) ──
export function formatPercent(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }     // %+.2f%%
export function formatVolume(v: number): string {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}
export function compactNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}
// printf %.Nf / signed / Int()/.rounded() / %.2g equivalents
const f = (v: number, n = 0) => v.toFixed(n);
const sgn = (v: number, n = 1) => (v >= 0 ? '+' : '') + v.toFixed(n);   // %+.Nf
const iTrunc = (v: number) => Math.trunc(v);                            // Swift Int()
const round = (v: number) => Math.round(v);                            // Swift .rounded()
const g2 = (v: number) => parseFloat(v.toPrecision(2)).toString();     // %.2g
const last = <T>(a: T[]): T | undefined => (a && a.length ? a[a.length - 1] : undefined);
const has = (s: string | undefined | null, sub: string) => !!s && s.includes(sub);

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Helper analyzers — faithful TS ports of the iOS Analysis/* used by buildUserPrompt.
// ═══════════════════════════════════════════════════════════════════════════════════════════

// Analysis/DivergenceDetector.swift
function findDivSwings(values: number[], isLow: boolean, lookback = 2): Array<{ index: number; value: number }> {
  const pts: Array<{ index: number; value: number }> = [];
  if (values.length <= lookback * 2) return pts;
  for (let i = lookback; i < values.length - lookback; i++) {
    let isSwing = true;
    for (let k = 1; k <= lookback; k++) {
      if (isLow) { if (!(values[i] <= values[i - k]) || !(values[i] <= values[i + k])) { isSwing = false; break; } }
      else { if (!(values[i] >= values[i - k]) || !(values[i] >= values[i + k])) { isSwing = false; break; } }
    }
    if (isSwing) pts.push({ index: i, value: values[i] });
  }
  return pts;
}
function hasDivergence(candles: PromptCandle[], rsiSeries: number[], biasDirection: string): boolean {
  if (candles.length < 10 || rsiSeries.length < candles.length) return false;
  if (biasDirection.includes('Bearish')) {
    const lows = findDivSwings(candles.map(c => c.low), true, 2).slice(-2);
    if (lows.length !== 2) return false;
    const rA = rsiSeries[lows[0].index], rB = rsiSeries[lows[1].index];
    return lows[1].value < lows[0].value && rB > rA + 2;
  }
  if (biasDirection.includes('Bullish')) {
    const highs = findDivSwings(candles.map(c => c.high), false, 2).slice(-2);
    if (highs.length !== 2) return false;
    const rA = rsiSeries[highs[0].index], rB = rsiSeries[highs[1].index];
    return highs[1].value > highs[0].value && rB < rA - 2;
  }
  return false;
}

// AnalysisPrompt.findTroughs / findPeaks
function findTroughs(s: number[]): number[] {
  const out: number[] = []; if (s.length < 3) return out;
  for (let i = 1; i < s.length - 1; i++) if (s[i] < s[i - 1] && s[i] <= s[i + 1]) out.push(s[i]);
  return out;
}
function findPeaks(s: number[]): number[] {
  const out: number[] = []; if (s.length < 3) return out;
  for (let i = 1; i < s.length - 1; i++) if (s[i] > s[i - 1] && s[i] >= s[i + 1]) out.push(s[i]);
  return out;
}

// Indicators/MarketStructure.swift — MomentumAlignment.compute
function momentumAlignment(indicators: PromptIndicator[]): { score: number; label: string } {
  let score = 0;
  for (const ind of indicators) {
    if (ind.rsi != null) { if (ind.rsi > 55) score += 1; else if (ind.rsi < 45) score -= 1; }
    if (ind.macd) { if (ind.macd.histogram > 0) score += 1; else if (ind.macd.histogram < 0) score -= 1; }
    if (ind.stochRSI) { if (ind.stochRSI.k > ind.stochRSI.d) score += 1; else if (ind.stochRSI.k < ind.stochRSI.d) score -= 1; }
  }
  let label: string;
  if (score >= 7) label = 'strong bullish alignment';
  else if (score >= 4) label = 'bullish lean';
  else if (score <= -7) label = 'strong bearish alignment';
  else if (score <= -4) label = 'bearish lean';
  else label = 'mixed';
  return { score, label };
}

// AnalysisPrompt.computeClearance
function computeClearance(entryPrice: number, targetPrice: number, allLevels: TaggedLevel[]): number {
  const lo = Math.min(entryPrice, targetPrice), hi = Math.max(entryPrice, targetPrice);
  let obstacleSum = 0;
  for (const l of allLevels) if (l.price > lo && l.price < hi) obstacleSum += l.strength * 0.15;
  return Math.max(0, 1 - obstacleSum);
}

// Indicators/VolumeProfile.swift — pocAlignment
function pocAlignment(daily: VP | null | undefined, fourH: VP | null | undefined, atr: number): string | null {
  if (!daily || !fourH || atr <= 0) return null;
  const ratio = Math.abs(daily.poc - fourH.poc) / atr;
  const fp = (p: number) => (p >= 1 ? '$' + p.toFixed(2) : '$' + p.toFixed(4));
  if (ratio < 0.5) return `Daily/4H converged at ${fp((daily.poc + fourH.poc) / 2)} (within ${f(ratio, 1)}× ATR)`;
  return `Divergent (D: ${fp(daily.poc)}, 4H: ${fp(fourH.poc)})`;
}

const roundTo = (v: number, places: number) => { const m = Math.pow(10, places); return Math.round(v * m) / m; };

// Analysis/PriceActionAnalyzer.swift — analyze (regime + momentum + summaryText)
interface MomentumContext {
  rsiValue: number; rsiDirection: string; rsiSlope: number; stochK: number; stochD: number;
  stochCrossSignal: string; stochCrossAge: number; stochCrossFreshness: string;
  macdHistValue: number; macdHistDirection: string; volumeTrend: string; volumeRatio: number;
}
function priceActionAnalyze(ind: PromptIndicator): { regime: string; momentum: MomentumContext; summaryText: string } {
  const candles = ind.candles, tf = ind.timeframe;
  const period = tf === '1h' || tf === '15m' ? 8 : tf === '4h' ? 6 : tf === '1d' ? 5 : 8;

  // detectRegime
  const recent = candles.slice(-period);
  let regimeObj = { regime: 'insufficient_data', rangePercent: 0, rangeHigh: 0, rangeLow: 0, candleCount: recent.length };
  if (recent.length >= 3) {
    const rangeHigh = Math.max(...recent.map(c => c.high)), rangeLow = Math.min(...recent.map(c => c.low));
    const range = rangeHigh - rangeLow;
    const avgClose = recent.reduce((a, c) => a + c.close, 0) / recent.length;
    const rangePercent = avgClose > 0 ? (range / avgClose) * 100 : 0;
    const thr = tf === '1h' || tf === '15m' ? 2.0 : tf === '4h' ? 3.5 : tf === '1d' ? 5.0 : 2.0;
    if (rangePercent < thr) {
      regimeObj = { regime: 'consolidating', rangePercent: roundTo(rangePercent, 1), rangeHigh, rangeLow, candleCount: recent.length };
    } else {
      let hl = 0, lh = 0;
      for (let i = 1; i < recent.length; i++) { if (recent[i].low > recent[i - 1].low) hl++; if (recent[i].high < recent[i - 1].high) lh++; }
      const lastClose = recent[recent.length - 1].close, firstClose = recent[0].close;
      const up = lastClose > firstClose && hl >= Math.floor(period / 2);
      const down = lastClose < firstClose && lh >= Math.floor(period / 2);
      regimeObj = { regime: up ? 'trending_up' : down ? 'trending_down' : 'choppy', rangePercent: roundTo(rangePercent, 1), rangeHigh, rangeLow, candleCount: recent.length };
    }
  }

  // detectShape (only consolidating)
  let shape: string | null = null;
  if (regimeObj.regime === 'consolidating') {
    const r5 = candles.slice(-5);
    if (r5.length >= 3) {
      const lows = r5.map(c => c.low), highs = r5.map(c => c.high);
      let lr = 0, hf = 0;
      for (let i = 0; i < lows.length - 1; i++) { if (lows[i] < lows[i + 1]) lr++; if (highs[i] > highs[i + 1]) hf++; }
      const lowsRising = lr >= Math.floor(lows.length / 2), highsFalling = hf >= Math.floor(highs.length / 2);
      shape = lowsRising && highsFalling ? 'symmetrical' : lowsRising ? 'ascending_lows' : highsFalling ? 'descending_highs' : 'flat_range';
    } else shape = 'flat_range';
  }

  // analyzeMomentum
  const recentRSI = ind.rsiSeries.slice(-3);
  let rsiSlope = 0, rsiDirection = 'unknown';
  if (recentRSI.length >= 2) { rsiSlope = recentRSI[recentRSI.length - 1] - recentRSI[0]; rsiDirection = Math.abs(rsiSlope) < 2 ? 'flat' : rsiSlope > 0 ? 'rising' : 'falling'; }
  const kV = ind.stochKSeries.slice(-10), dV = ind.stochDSeries.slice(-10);
  let lastCrossAge = -1, lastCrossType = 'none';
  const pairCount = Math.min(kV.length, dV.length);
  if (pairCount >= 2) {
    for (let i = pairCount - 1; i >= 1; i--) {
      const kAboveD = kV[i] > dV[i], kBelowDPrev = kV[i - 1] <= dV[i - 1], kBelowD = kV[i] < dV[i], kAboveDPrev = kV[i - 1] >= dV[i - 1];
      if (kAboveD && kBelowDPrev) { lastCrossAge = pairCount - 1 - i; lastCrossType = 'bullish_cross'; break; }
      if (kBelowD && kAboveDPrev) { lastCrossAge = pairCount - 1 - i; lastCrossType = 'bearish_cross'; break; }
    }
  }
  const freshness = lastCrossAge < 0 ? 'none' : lastCrossAge <= 2 ? 'fresh' : lastCrossAge <= 5 ? 'developing' : 'stale';
  const recentHist = ind.macdHistSeries.slice(-3);
  let macdHistDirection = 'unknown';
  if (recentHist.length >= 2) {
    const hl = recentHist[recentHist.length - 1], hf = recentHist[0];
    if (Math.abs(hl) > Math.abs(hf) && hl > 0) macdHistDirection = 'expanding_bullish';
    else if (Math.abs(hl) > Math.abs(hf) && hl < 0) macdHistDirection = 'expanding_bearish';
    else if (Math.abs(hl) < Math.abs(hf)) macdHistDirection = 'contracting';
    else macdHistDirection = 'flat';
  }
  let volumeTrend = 'unknown', volRatio = 1.0;
  if (candles.length >= 6) {
    const recentVol = candles.slice(-3).reduce((a, c) => a + c.volume, 0) / 3;
    const priorVol = candles.slice(0, -3).slice(-3).reduce((a, c) => a + c.volume, 0) / 3;
    volRatio = priorVol > 0 ? roundTo(recentVol / priorVol, 1) : 1.0;
    volumeTrend = volRatio > 1.2 ? 'increasing' : volRatio < 0.8 ? 'decreasing' : 'stable';
  }
  const momentum: MomentumContext = {
    rsiValue: last(recentRSI) ?? 0, rsiDirection, rsiSlope: roundTo(rsiSlope, 1),
    stochK: last(kV) ?? 0, stochD: last(dV) ?? 0, stochCrossSignal: lastCrossType,
    stochCrossAge: Math.max(lastCrossAge, 0), stochCrossFreshness: freshness,
    macdHistValue: last(recentHist) ?? 0, macdHistDirection, volumeTrend, volumeRatio: volRatio,
  };

  // contextualizePatterns + buildSummaryText. Significance is DIRECTION-AWARE (2026-07-02):
  // a bullish pattern AT SUPPORT (or bearish at resistance) is the classical high-significance
  // read; the incongruent combination (bearish pattern at support etc.) is tagged
  // counter_context instead of being promoted to 'high' — the pre-fix code boosted ANY pattern
  // near ANY level, which is how "Evening Star at_support" got headlined in oversold tape.
  const BULLISH_PATTERNS = new Set(['Hammer', 'Inverted Hammer', 'Morning Star', 'Bullish Engulfing']);
  const BEARISH_PATTERNS = new Set(['Shooting Star', 'Hanging Man', 'Evening Star', 'Bearish Engulfing']);
  const sigAtLevel = (pattern: string, position: 'at_support' | 'at_resistance'): string => {
    const bull = BULLISH_PATTERNS.has(pattern), bear = BEARISH_PATTERNS.has(pattern);
    if (!bull && !bear) return 'moderate';   // Doji etc. — location adds interest, not direction
    return ((bull && position === 'at_support') || (bear && position === 'at_resistance')) ? 'high' : 'counter_context';
  };
  const patterns: Array<{ pattern: string; position: string; level: number | null; significance: string }> = [];
  if (ind.candlePatterns.length) {
    const price = ind.price, atrV = ind.atr?.atr ?? price * 0.01, thr = atrV * 0.3, e20 = ind.ema20 ?? 0;
    for (const p of ind.candlePatterns) {
      let placed = false;
      for (const s of ind.supportResistance.supports) { if (Math.abs(price - s) < thr) { patterns.push({ pattern: p.pattern, position: 'at_support', level: s, significance: sigAtLevel(p.pattern, 'at_support') }); placed = true; break; } }
      if (placed) continue;
      for (const r of ind.supportResistance.resistances) { if (Math.abs(price - r) < thr) { patterns.push({ pattern: p.pattern, position: 'at_resistance', level: r, significance: sigAtLevel(p.pattern, 'at_resistance') }); placed = true; break; } }
      if (placed) continue;
      if (e20 > 0 && Math.abs(price - e20) < thr) patterns.push({ pattern: p.pattern, position: 'at_ema20', level: e20, significance: 'moderate' });
      else patterns.push({ pattern: p.pattern, position: 'in_space', level: null, significance: 'low' });
    }
  }
  const sl: string[] = [];
  let regimeLine = `${ind.label}: ${regimeObj.regime}, ${f(regimeObj.rangePercent, 1)}% range`;
  regimeLine += ` (${formatPrice(regimeObj.rangeLow)}-${formatPrice(regimeObj.rangeHigh)}), ${regimeObj.candleCount} candles`;
  if (shape) regimeLine += `, shape: ${shape}`;
  sl.push(regimeLine);
  let mom = `Momentum: RSI ${f(momentum.rsiValue, 1)} ${momentum.rsiDirection}`;
  mom += `, Stoch RSI ${f(momentum.stochK, 0)}/${f(momentum.stochD, 0)}`;
  if (momentum.stochCrossSignal !== 'none') mom += ` (${momentum.stochCrossSignal} ${momentum.stochCrossAge} candles ago — ${momentum.stochCrossFreshness})`;
  mom += `, MACD hist ${momentum.macdHistDirection}, Volume ${momentum.volumeTrend} (${f(momentum.volumeRatio, 1)}x)`;
  sl.push(mom);
  const meaningful = patterns.filter(p => p.significance !== 'low');
  if (meaningful.length) sl.push('Patterns: ' + meaningful.map(p => {
    const base = p.level != null ? `${p.pattern} ${p.position} (${formatPrice(p.level)})` : `${p.pattern} ${p.position}`;
    return p.significance === 'counter_context' ? `${base} [counter-context — pattern direction contradicts the location; discount it]` : base;
  }).join(', '));
  return { regime: regimeObj.regime, momentum, summaryText: sl.join('\n') };
}

// ── ET timestamp formatting (Worker has full ICU; pure given nowMs) ──
const US_MARKET_HOLIDAYS = new Set([
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19',
  '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);
const ET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
function formatET(ms: number): string { return ET_FMT.format(new Date(ms)); }
function etParts(ms: number): { year: number; month: number; day: number; weekday: number; ymd: string } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const p = dtf.formatToParts(new Date(ms));
  const get = (t: string) => p.find(x => x.type === t)!.value;
  const wmap: Record<string, number> = { Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7 };
  const year = +get('year'), month = +get('month'), day = +get('day');
  const ymd = `${get('year')}-${get('month')}-${get('day')}`;
  return { year, month, day, weekday: wmap[get('weekday')], ymd };
}
// UTC epoch (ms) for an ET wall-clock time, accounting for EST/EDT.
function etEpoch(year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = dtf.formatToParts(new Date(guess));
  const get = (t: string) => +p.find(x => x.type === t)!.value;
  let hh = get('hour'); if (hh === 24) hh = 0;
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hh, get('minute'), get('second'));
  const offset = asUTC - guess;            // ET wall expressed as UTC − guess
  return guess - offset;
}
const isMarketHoliday = (ms: number) => US_MARKET_HOLIDAYS.has(etParts(ms).ymd);

export { hasDivergence, momentumAlignment, priceActionAnalyze, formatET };

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Data contract — what /full-analysis (and, after Phase 4, iOS) passes to buildUserPrompt.
// Per-TF indicators are the computeFullIndicators output (indicators-full.ts) plus an ML
// overlay. Enrichment types carry only the fields the prompt actually reads.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface PromptCandle { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface VP { poc: number; vah: number; val: number; }
interface TaggedLevel { price: number; type: string; proximity: string; atrDistance: number; strength: number; freshness: number; candlesAgo: number; isStructural: boolean; }

export interface PromptIndicator {
  timeframe: string; label: string; price: number; bias: string;
  rsi: number | null; stochRSI: { k: number; d: number; crossover: string | null } | null;
  macd: { histogram: number; crossover: string | null };
  adx: { adx: number; plusDI: number; minusDI: number; strength: string; direction: string } | null;
  bollingerBands: { percentB: number; squeeze: boolean; bandwidth: number; upper: number | null; middle: number | null; lower: number | null } | null;
  atr: { atr: number; atrPercent: number } | null;
  ema20: number | null; ema50: number | null; ema200: number | null; vwap: number | null;
  fibonacci: { trend: string; swingHigh: number; swingLow: number; nearestLevel: string; nearestPrice: number } | null;
  supportResistance: { supports: number[]; resistances: number[] };
  candlePatterns: Array<{ pattern: string; signal: string }>;
  volumeRatio: number | null; divergence: string | null;
  marketStructure: { label: string; swingHighs: number[]; swingLows: number[]; levelTests: Array<{ price: number; tests: number; candlesAgo: number }> } | null;
  volScalar: number | null; volumeProfile: VP | null;
  obv: { trend: string; divergence?: string | null } | null; adLine: { trend: string } | null;
  candles: PromptCandle[];
  rsiSeries: number[]; stochKSeries: number[]; stochDSeries: number[];
  macdHistSeries: number[]; macdLineSeries: number[]; macdSignalSeries: number[]; ema200Series: number[];
  atrPercentile: number | null; atrPercentileLabel: string | null;
  // ML overlay (supplied by /full-analysis from the cron/ml-predict path; daily TF carries these)
  mlWinProbability?: number | null; mlPersistenceProbability?: number | null; mlDirectionUp?: number | null;
  mlBigMoveProb?: number | null;  // tail head: P(>=4 ATR move in 24h), crypto-only
  mlCrashProb?: number | null;    // validated crash model: P(>=10% drawdown in 10d), crypto-only
  mlConfident?: boolean | null; mlMetaDirection?: number | null; mlMetaProbability?: number | null; mlQ75?: number | null;
  // Optional stock display extras (not yet computed by the worker; emitted when present)
  smaCross?: { status: string; recentCross?: string | null } | null;
  gap?: { direction: string; gapPercent: number; previousClose: number; filled: boolean } | null;
  addv?: { averageDollarVolume: number; liquidity: string } | null;
}

export interface CoinInfo { priceChangePercentage24h?: number | null; priceChangePercentage7d?: number | null; priceChangePercentage30d?: number | null; athChangePercentage: number; }
export interface CrossAssetContext { summary: string; dxyPrice: number; dxyEma20: number; dxyTrend: string; spyPrice: number; spyEma20: number; spyTrend: string; }
interface DataQuality { promptSection?: string | null; missingEnrichments: string[]; }
interface InsiderTx { date: number; isBuy: boolean; name: string; shares: number; value: number; }
export interface StockInfo {
  marketState: string; peRatio?: number | null; eps?: number | null; dividendYield?: number | null;
  fiftyTwoWeekLow: number; fiftyTwoWeekHigh: number; sector?: string | null; earningsDate?: number | null;
  analystTargetMean?: number | null; analystCount?: number | null; analystRating?: string | null;
  consecutiveBeats?: number | null; avgEarningsSurprise?: number | null;
  revenueGrowthYoY?: number | null; growthTrend?: string | null; earningsGrowthYoY?: number | null;
  insiderTransactions?: InsiderTx[] | null; insiderBuyCount6m?: number | null; insiderSellCount6m?: number | null; insiderNetBuying?: boolean | null;
  epsEstimateCurrent?: number | null; epsEstimate90dAgo?: number | null; revisionDirection?: string | null; upRevisions30d?: number | null; downRevisions30d?: number | null;
  exDividendDate?: number | null; dividendRate?: number | null; exDividendWarning?: boolean | null;
  sectorETF?: string | null; relativeStrength1d?: number | null; outperformingSector?: boolean | null;
  finnhubBuy?: number | null; finnhubHold?: number | null; finnhubSell?: number | null; finnhubStrongBuy?: number | null;
  marketCap?: number | null; beta?: number | null; newsHeadlines?: string[] | null;
}
export interface DerivativesData { fundingRatePercent: number; avgFundingRate: number; openInterestUSD: number; oiChange4h?: number | null; oiChange24h?: number | null; globalLongPercent: number; globalShortPercent: number; topTraderLongPercent: number; topTraderShortPercent: number; takerBuySellRatio: number; takerBuyVolume: number; }
export interface PositioningSnapshot { fundingSentiment: string; oiTrend: string; crowding: string; crowdingCode: string; smartMoneyBias: string; takerPressure: string; squeezeRisk: { level: string; direction: string }; signals: Array<{ strength: string; message: string }>; }
export interface StockSentimentData { vix?: number | null; vixLevel: string; vixChange?: number | null; shortPercentOfFloat?: number | null; shortRatio?: number | null; fiftyTwoWeekPosition: number; putCallRatio?: number | null; }
interface EconomicEvent { title: string; country: string; isHighImpact: boolean; isUpcoming: boolean; isRecentlyReleased: boolean; date: number; actual?: string | null; forecast?: string | null; surprise?: string | null; previous?: string | null; }
export interface MacroSnapshot { macroRegime?: string | null; vix?: number | null; treasury10Y?: number | null; treasury2Y?: number | null; yieldSpread?: number | null; fedFundsRate?: number | null; usdIndex?: number | null; }
export interface SpotPressure { takerBuyRatio: number; takerBuyLabel: string; cvd24h: number; cvdTrend: string; bookRatio?: number | null; bookLabel?: string | null; }
interface OutcomeHistoryItem { direction: string; entry: number; outcome: string; mlProb?: number | null; conviction?: string | null; }
interface ActiveSetup { direction: string; entry: number; risk: number; tp1: number; mlProbability?: number | null; entryHitTimeMs: number; maxFavorable: number; maxAdverse: number; tp1Hit: boolean; partialTaken: boolean; breakevenActivated: boolean; }

export interface PromptState {
  regime?: string | null; killDur?: Record<string, number>; killDurCandleMs?: number | null; nakedPOC?: { poc: number; dateMs: number } | null;
  // #6 (prior-analysis delta) — carried so each run can lead with what CHANGED since the last
  // analysis of this symbol (the antidote to same-y serial reads). prevMlWin/prevAnalysisMs are
  // set pre-LLM; prevBottomLine is filled by the caller AFTER the LLM responds (extracted from the
  // analysis text) and persisted back to KV, so the NEXT run sees it.
  prevMlWin?: number | null; prevBottomLine?: string | null; prevAnalysisMs?: number | null;
}
interface PromptSettings { accountSize?: number; riskPercent?: number; conformalGateEnabled?: boolean; }

export interface BuildPromptInput {
  symbol: string; nowMs: number; indicators: PromptIndicator[];
  livePrice?: number | null;   // live ticker price — candles/indicators are CLOSED-bar and up to 4h stale
  sentiment?: CoinInfo | null; stockInfo?: StockInfo | null; derivatives?: DerivativesData | null;
  positioning?: PositioningSnapshot | null; stockSentiment?: StockSentimentData | null;
  economicEvents?: EconomicEvent[]; macro?: MacroSnapshot | null; weeklyContext?: string | null; spyContext?: string | null;
  // Policy/macro catalyst headlines (src/news.ts). Context only — never an ML feature, never a
  // direction input; `catalystActive` marks a PRIMARY-source release inside the last ~12h.
  news?: { headlines: string[]; catalystActive: boolean; latestPrimaryAgeH: number | null } | null;
  spotPressure?: SpotPressure | null; dataQuality?: DataQuality | null; crossAsset?: CrossAssetContext | null;
  outcomeHistory?: OutcomeHistoryItem[];
  archetypeRecord?: { wins: number; losses: number; total: number } | null;   // E7 (from D1 trade_outcomes)
  activeSetups?: ActiveSetup[];                                                // C8 (active tracked trades)
  volForecast?: import('./vol').VolForecast | null;                            // Phase 1: HAR-RV expected range
  riskStates?: import('./risk-states').RiskState[];                            // Phase 5: discrete risk states
  // Insight enrichments (2026-07-02) — all derived from data the system already stores:
  mlCalibration?: { n: number; realizedPct: number; windowDays: number; bucketLabel: string } | null;  // live realized goodR for the CURRENT prediction's bucket (ml_calibration D1)
  calibratedMlWin?: number | null;   // raw ML_WIN corrected by the live forward calibration — used by the auto-FLAT/quality gate so drift can't over-suppress
  /**
   * RAW-scale cut rejecting the weakest fraction of the live prediction distribution. REPLACES the
   * envelope's fixed `calibrated < 50` floor when supplied, so recalibration cannot silently move
   * the gate's selectivity. See `docs/research/ml-floor-coverage.md`.
   */
  mlCoverageCut?: number | null;
  mlTrajectory?: { points: number[]; hours: number } | null;                   // sampled ML_WIN path over the last N hours, oldest→newest (score_history D1)
  btcContext?: { mlWin: number | null; bigMoveBucket: string | null; persistence: number | null } | null; // BTC regime read for alt analyses (ml_preds:all KV)
  volPricing?: { dvol: number; impliedMovePct: number; forecastMovePct: number } | null;  // options-implied vs model-forecast move (BTC/ETH, Deribit DVOL)
  // Observed forced-liquidation flow (Binance forceOrder stream archive, crypto only).
  // SAMPLED feed (Binance pushes <=1 event/s/symbol since 2021) - sums are lower bounds, not totals.
  liquidations?: { h1LongUsd: number; h1ShortUsd: number; h24LongUsd: number; h24ShortUsd: number } | null;
  prevState?: PromptState; settings?: PromptSettings;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// buildUserPrompt — TS port of AnalysisPrompt.buildUserPrompt (treatment branch, always active).
// Stateful: reads prevState (regime/kill-duration/nakedPOC), returns the new state for the
// caller to persist (KV on the worker, UserDefaults on iOS Phase 4).
// ═══════════════════════════════════════════════════════════════════════════════════════════
export function buildUserPrompt(input: BuildPromptInput): {
  prompt: string;
  newState: PromptState;
  /// The Conviction Envelope's actual verdict, not a re-parse of the rendered text. Null only if
  /// the envelope block did not run at all. Returned because `HIGH_blocked_because` and friends are
  /// rendered ONLY on non-FLAT bars — a replay that reads the prompt is blind on FLAT bars, which
  /// are the majority and the interesting ones.
  envelope: EnvelopeVerdict | null;
  /// The inputs that produced it, so an export can record WHY without re-deriving anything.
  envelopeInput: EnvelopeInput | null;
  /// Removed-but-still-computed conditions, for research. Null outside their own domain.
  diagnostics: Record<string, number | null>;
} {
  const {
    symbol, nowMs, indicators, sentiment, stockInfo, derivatives, positioning, stockSentiment,
    economicEvents = [], macro, weeklyContext, spyContext, spotPressure, dataQuality, crossAsset,
    outcomeHistory = [], archetypeRecord, activeSetups = [],
  } = input;
  const prevState = input.prevState ?? {};
  const settings = input.settings ?? {};
  const lines: string[] = [`Symbol: ${symbol}`];
  const L = (s = '') => lines.push(s);
  const isCryptoSym = symbol.toUpperCase().endsWith('USDT');

  // LIVE PRICE anchor. Every candle/indicator in this prompt is computed on CLOSED bars
  // (training parity — the in-progress bar is dropped), so the newest "price" the sections
  // below reference can be up to 4h stale. Without this anchor the model writes triggers
  // that are already past ("if price holds over X" when live price blew through X hours ago).
  const lp = input.livePrice ?? null;
  if (lp != null && lp > 0 && indicators.length > 0) {
    const closedRef = indicators[indicators.length - 1].price || indicators[0].price;
    const dPct = closedRef > 0 ? ((lp - closedRef) / closedRef) * 100 : 0;
    L();
    L('=== LIVE PRICE (authoritative current price) ===');
    L(`LIVE price right now: ${formatPrice(lp)}. The candles/indicators below end at the last CLOSED bar `
      + `(${formatPrice(closedRef)}, ${dPct >= 0 ? '+' : ''}${dPct.toFixed(2)}% from live).`);
    L('Anchor ALL statements about current price, level proximity, triggers, and entries to the LIVE price. '
      + 'If a level or trigger is already past at the live price, say so explicitly — never present it as pending.');
  }
  const newState: PromptState = { regime: prevState.regime ?? null, killDur: { ...(prevState.killDur ?? {}) }, killDurCandleMs: prevState.killDurCandleMs ?? null, nakedPOC: prevState.nakedPOC ?? null };
  // Hoisted so the envelope's verdict can be RETURNED rather than only rendered (2026-08-26).
  // Three of the four lists are printed only on non-FLAT bars, so a caller that reads the prompt
  // text sees nothing on exactly the bars a research replay cares most about.
  let envelopeVerdict: EnvelopeVerdict | null = null;
  let envelopeInput: EnvelopeInput | null = null;
  /// Conditions that are still COMPUTED by the real rules but no longer feed any gate. Exported so
  /// research can measure them without rebuilding them: `funding_supports_counter` and both
  /// divergence rules were removed in Parts 6-7 on evidence since retracted, and re-deciding them
  /// needs the real values. Note they are only defined on counter-trend-pullback bars, because the
  /// whole kill block is wrapped in `if (oneHOpposes && oneH)` — that scoping IS the thing Part 7
  /// got wrong, so it must survive into the export rather than be flattened.
  const diagnostics: Record<string, number | null> = {
    killFunding: null, killVolume: null, killMacro: null, killDivergence: null,
  };

  // #6 — SINCE LAST ANALYSIS: a snapshot of the previous run for this symbol so the LLM can lead
  // with what CHANGED (the antidote to same-y serial reads). Emitted only when the prior state is
  // present and fresh (<3 days). prevMlWin/prevAnalysisMs are stamped now; prevBottomLine is filled
  // by the /full-analysis caller AFTER the LLM responds and persisted back, so the NEXT run sees it.
  const curMlWin = indicators[0]?.mlWinProbability ?? null;
  {
    const pMs = prevState.prevAnalysisMs ?? null;
    const pWin = prevState.prevMlWin ?? null;
    const pBL = prevState.prevBottomLine ?? null;
    const age = pMs != null ? nowMs - pMs : -1;
    if (age > 0 && age < 86_400_000 * 3) {
      const ageMin = Math.round(age / 60_000);
      const ageStr = ageMin < 60 ? `${ageMin}m` : `${(ageMin / 60).toFixed(1)}h`;
      L(); L('=== SINCE LAST ANALYSIS ===');
      L(`Previous analysis: ${ageStr} ago.`);
      if (pWin != null && curMlWin != null) {
        const thenPct = Math.round(pWin * 100), nowPct = Math.round(curMlWin * 100), d = nowPct - thenPct;
        L(`ML move-likelihood then → now: ${thenPct}% → ${nowPct}% (${d > 0 ? `rising +${d}pp` : d < 0 ? `falling ${d}pp` : 'flat'}).`);
      }
      if (pBL) L(`Previous Bottom Line: "${pBL}"`);
      L('→ If something material changed (ML ≥15pp, regime flip, a flag newly fired/cleared, a level newly IN_PLAY), LEAD the Bottom Line with it. If not, say "largely unchanged" and keep the whole output short.');
    }
  }
  // Keep the prior ML baseline when the current read is null (ml_preds cache miss) — otherwise
  // one stale cache would erase the delta the next successful run should report.
  newState.prevMlWin = curMlWin ?? prevState.prevMlWin ?? null;
  newState.prevAnalysisMs = nowMs;
  newState.prevBottomLine = prevState.prevBottomLine ?? null;

  if (dataQuality?.promptSection) { L(); L('=== DATA QUALITY ==='); L(dataQuality.promptSection); }
  if (crossAsset) {
    L(); L('=== CROSS-ASSET CONTEXT ===');
    L(crossAsset.summary);
    L(`DXY: ${formatPrice(crossAsset.dxyPrice)} vs EMA20 ${formatPrice(crossAsset.dxyEma20)} → ${crossAsset.dxyTrend}`);
    L(`SPY: ${formatPrice(crossAsset.spyPrice)} vs EMA20 ${formatPrice(crossAsset.spyEma20)} → ${crossAsset.spyTrend}`);
  }

  if (indicators.length >= 2) {
    const daily = indicators[0], fourH = indicators[1], oneH = indicators.length > 2 ? indicators[2] : null;
    // `envDivergenceEscalated` removed 2026-08-25: nothing read it once the auto-FLAT was deleted.
    let envAnyKilled = false, envMacroRisk = 'NONE', envContinuationCount = 0, envAlignment = 'UNKNOWN', envNewsConflicts = false;
    let envChaseLevel = 'none';   // CHASE/EXHAUSTION level, hoisted so the Conviction Envelope can hard-FLAT a mature-aligned chase
    const isTreatment = true;
    let treatmentStochCrossDaily = 'none', treatmentStochCross4H = 'none', treatmentLongConfirmStatus = 'n/a';
    const treatmentLongConfirmReasons: string[] = [];
    // `envConformalNotConfident` removed 2026-08-25: it was declared `false` and never assigned
    // anywhere, so `conformal_abstain_not_confident_cap_LOW` could not fire. Dead since the
    // leak-era conformal head was retracted.
    let envCryptoBearRegime = false;

    // CRYPTO REGIME guard
    if (isCryptoSym && daily.ema200 != null && daily.price > 0) {
      const belowMA = daily.price < daily.ema200;
      const s = daily.ema200Series;
      const ma200Falling = s.length >= 21 && s[s.length - 1] < s[s.length - 21];
      if (belowMA && ma200Falling) {
        envCryptoBearRegime = true;
        L('CRYPTO REGIME: BEARISH — daily price below 200D EMA and 200D sloping down.');
        L('  The ML quality edge held in historical bear folds, but only on symbols that survived; with leverage this is a real tail risk the backtest cannot see.');
        L('  LONG setups: cap conviction at MODERATE and HALVE position size vs normal risk. SHORT / aligned-bearish setups: unaffected (crypto shorts are +EV in every historical fold).');
      } else if (belowMA) {
        L('CRYPTO REGIME: WEAK — daily price below 200D EMA (200D not yet sloping down). LONGs require extra confirmation; sizing normal.');
      }
    }

    // Phase 1 — Regime label
    const adxDaily = daily.adx?.adx ?? 0;
    let maAlignment = 'tangled';
    if (daily.ema20 != null && daily.ema50 != null && daily.ema200 != null) {
      if (daily.ema20 > daily.ema50 && daily.ema50 > daily.ema200) maAlignment = 'bullish_stacked';
      else if (daily.ema20 < daily.ema50 && daily.ema50 < daily.ema200) maAlignment = 'bearish_stacked';
    }
    const bbSqueezeAny = indicators.some(i => i.bollingerBands?.squeeze === true);
    let regime: string;
    if (adxDaily > 25 && maAlignment !== 'tangled') regime = 'TRENDING';
    else if (bbSqueezeAny || (adxDaily >= 20 && adxDaily <= 25)) regime = 'TRANSITIONING';
    else if (adxDaily < 20) regime = 'RANGING';
    else regime = 'TRANSITIONING';

    // Phase 2 — Regime staleness (KV-backed prevState)
    const regimeChanged = prevState.regime !== regime;
    newState.regime = regime;
    L(); L('=== PRE-COMPUTED FLAGS (authoritative — do not reclassify) ===');
    if (regimeChanged) {
      L(`Regime: ${regime} (ADX_daily: ${f(adxDaily, 1)}, MA_alignment: ${maAlignment}, BB_squeeze: ${bbSqueezeAny})`);
      L('Regime Changed: true');
    } else { L(`Regime: ${regime}`); L('Regime Changed: false'); }

    // Phase 2b — ENVIRONMENT RISK (trend/volatility danger). Why this exists, verified on 141K
    // clean bars (ml-training/retrain_diagnostic.py): ML_WIN is WELL-CALIBRATED even in the
    // high-ADX/high-ATR tail (predicted within ~1-2pp of actual; if anything it slightly
    // over-predicts there). It is NOT broken and does NOT "under-read" trends. The catch is that
    // ML_WIN is ATR-NORMALIZED (goodR = >=1.5 ATR): when vol is already high, a 1.5-ATR bar is a
    // LARGE absolute move, so a FURTHER such move is genuinely less likely (~42% in strong trends
    // vs ~62% in calm). So a LOW ML_WIN in a violent trend is CORRECT but MISLEADING as a risk
    // signal — the trend itself is the danger even though >=1.5-ATR-forward is unlikely. This flag
    // is a SEPARATE, non-ATR-normalized trend-danger read (ADX + stretch) that leads the output so
    // a correctly-low ML_WIN is not mistaken for "safe/quiet." (BTC 2026-06-01→03 was a true
    // ~30-40% bar resolving 1 in an autocorrelated streak — a low-prob realization, not a defect.)
    const adx4HVal = fourH.adx?.adx ?? 0;
    const adxMax = Math.max(adxDaily, adx4HVal);
    const dAtrVal = daily.atr?.atr ?? 0;
    const stretchATR = (dAtrVal > 0 && daily.ema200 != null) ? Math.abs(daily.price - daily.ema200) / dAtrVal : 0;
    const trendDir = maAlignment === 'bearish_stacked' ? 'down' : maAlignment === 'bullish_stacked' ? 'up' : 'mixed';
    // stretchATR is ATR-normalized, so a COMPRESSED current ATR inflates it exactly when the
    // tape is coiled rather than violent (the live "violent downtrend @ 20th-pct ATR in an
    // active squeeze" self-contradiction). The flag LEVEL is kept (a deeply-extended coiled
    // trend IS dangerous — expansion resumes the trend more often than not), but the WORDING
    // is now computed from the ATR percentile instead of patched over in the system prompt.
    const atrPctlDaily = daily.atrPercentile ?? null;
    const volCompressed = atrPctlDaily != null && atrPctlDaily < 40;
    let envRisk: string, envReason: string;
    if (adxMax >= 40 || (regime === 'TRENDING' && stretchATR >= 3)) {
      envRisk = 'HIGH';
      envReason = volCompressed
        ? `deeply extended ${trendDir}-trend but COILED (ADX ${f(adxMax, 0)}, price ${f(stretchATR, 1)} ATR from 200D, ATR ${f(atrPctlDaily!, 0)}th pct) — expansion risk: a vol release here most often resumes the trend; fading it or holding against it is dangerous`
        : `violent ${trendDir}-trend (ADX ${f(adxMax, 0)}, price ${f(stretchATR, 1)} ATR from 200D) — momentum can carry far past prior extremes; fading it or holding against it is dangerous`;
    } else if (adxMax >= 28 || regime === 'TRENDING' || (stretchATR >= 2 && regime !== 'RANGING')) {
      envRisk = 'ELEVATED';
      envReason = `directional ${trendDir}-trend in force (ADX ${f(adxMax, 0)}, ${f(stretchATR, 1)} ATR from 200D)${volCompressed ? ` — extended but coiled (ATR ${f(atrPctlDaily!, 0)}th pct), expansion + trend-continuation risk` : ' — trend-continuation risk'}`;
    } else if (regime === 'TRANSITIONING' || stretchATR >= 1) {
      envRisk = 'MODERATE';
      envReason = `${regime.toLowerCase()} — expansion possible, no dominant trend`;
    } else {
      envRisk = 'LOW';
      envReason = 'ranging / quiet — no dominant trend, mean-reversion regime';
    }
    // Learned big-move/tail head (crypto-only): P(>=4 ATR move in 24h). Supersedes the
    // ADX/stretch heuristic as the big-move read when present, and can ESCALATE Environment
    // Risk — a HIGH tail bucket in an otherwise-quiet tape is exactly the "ML_WIN says calm
    // but an outsized move is brewing" case the heuristic can't see.
    const bigMove = daily.mlBigMoveProb;
    let bigMoveBucket: string | null = null;
    if (bigMove != null) {
      // Thresholds + base rate from the model JSON via tailRiskInfo (2026-07-02) — these were
      // hardcoded here (0.064/0.079/0.10), duplicating ml-predict and drifting on retrain.
      const tri = tailRiskInfo(bigMove);
      bigMoveBucket = tri?.bucket ?? (bigMove >= 0.10 ? 'HIGH' : bigMove >= 0.079 ? 'ELEVATED' : 'NORMAL');
      const xBase = tri?.multiple ?? (bigMove / 0.064);
      const baseRate = xBase > 0 ? bigMove / xBase : 0.064;
      L(`Big-Move Risk: ${bigMoveBucket} (model: ${f(bigMove * 100, 0)}% chance of a >=4 ATR move in 24h, ${f(xBase, 1)}x the ${f(baseRate * 100, 0)}% base). Direction-agnostic — an outsized move is more likely than normal, EITHER way. This is the learned tail gauge ML_WIN (>=1.5 ATR) cannot provide.`);
      // Escalate Environment Risk if the tail head fires while the heuristic read low.
      if (bigMoveBucket === 'HIGH' && (envRisk === 'LOW' || envRisk === 'MODERATE')) {
        envRisk = 'ELEVATED'; envReason = `${envReason}; tail model flags HIGH outsized-move risk (${f(xBase, 1)}x base) despite a calmer trend read`;
      } else if (bigMoveBucket === 'HIGH' && envRisk === 'ELEVATED') {
        envRisk = 'HIGH'; envReason = `${envReason}; tail model also flags HIGH outsized-move risk`;
      }
    }
    L(`Environment Risk: ${envRisk} — ${envReason}.`);

    // CRASH RISK (2026-08-24). Distinct from Environment Risk above, which is a HEURISTIC read of
    // trend danger from ADX/regime/stretch. This is a MEASURED model: P(price falls >=10% below
    // here within 10 days), and it is the one signal in this project that survived every control
    // (drawdown -76.6% -> -40.4%, replicated leave-one-symbol-out with placebos at ~0.05).
    //
    // The episodic caveat ships WITH the number, deliberately. The signal stayed quiet through five
    // separate 20-28% drawdowns in 2023-25, so a low reading is NOT evidence of safety and the model
    // must never treat it that way.
    const crashP = daily.mlCrashProb;
    if (crashP != null && Number.isFinite(crashP)) {
      const pct = Math.round(crashP * 100);
      // FIXED 2026-08-25: this line labelled the band off the SIZING curve's 0.30/0.50 breakpoints,
      // so a 39% reading — BELOW the 41% base rate — printed as "Crash Risk: ELEVATED ... raise the
      // bar for a new entry". A live BTC analysis said exactly that, in one sentence that both
      // reported a below-average day and called it elevated.
      //
      // This is the SAME defect fixed in `crashWarning` on 2026-08-24 (where six symbols warned at
      // 41/41/43/41/50/39%), and the fix was never propagated here. Root cause both times: a SIZING
      // threshold reused as a WARNING threshold. They answer different questions and 0.30 is below
      // the base rate, so as a warning it fires on an ordinary day.
      //
      // The two are now stated SEPARATELY, because both facts are true at 39%: the validated T8
      // arm-D curve really does halve size above 0.30 (that stays — it is the measured finding),
      // while 39% is genuinely unremarkable as a risk READING. Warning thresholds match crash.ts:
      // base + 0.08 and base + 0.18.
      const CRASH_BASE = 0.41;
      const band = crashP >= CRASH_BASE + 0.18 ? 'HIGH' : crashP >= CRASH_BASE + 0.08 ? 'ELEVATED' : 'ORDINARY';
      const vsBase = crashP >= CRASH_BASE
        ? `${Math.round((crashP - CRASH_BASE) * 100)}pp ABOVE the ${Math.round(CRASH_BASE * 100)}% base rate`
        : `${Math.round((CRASH_BASE - crashP) * 100)}pp BELOW the ${Math.round(CRASH_BASE * 100)}% base rate`;
      const sizing = crashP > 0.50
        ? 'The overlay has cut size to zero.'
        : crashP > 0.30 ? 'The overlay halves size here (validated at 0.30, which sits below the base rate — so this is routine, not a warning).'
          : 'No size reduction from this gauge.';
      const action = band === 'HIGH'
        ? 'Treat any new entry as needing exceptional evidence.'
        : band === 'ELEVATED'
          ? 'Raise the bar for a new entry; prefer waiting to sizing down further.'
          : 'This reading is NOT a reason to raise the bar on an entry — do not cite it as one.';
      L(`Crash Risk: ${band} — ${pct}% chance of a >=10% fall within 10 days, ${vsBase}. ${sizing} ${action}`);
      L(`  Crash Risk is about DRAWDOWN, not direction — it never says which way price goes, and a `
        + `high reading is not a SHORT signal. It is EPISODIC: it has stayed quiet through real `
        + `20-28% falls, so ORDINARY is "no warning", NOT "safe". Never cite a low reading as `
        + `support for a trade.`);
    }
    // Phase 1: HAR-RV expected range — the direction-agnostic "how big", calibrated bands.
    const vf = input.volForecast;
    if (vf?.horizons?.['24h']) {
      const h = vf.horizons['24h'];
      L(`Expected 24h Range: ${formatPrice(h.s1[0])}–${formatPrice(h.s1[1])} (1σ, ~68%) · ${formatPrice(h.s2[0])}–${formatPrice(h.s2[1])} (2σ, ~95%). Calibrated vol forecast (σ=${f(h.sigma * 100, 1)}%), direction-AGNOSTIC — the honest "how big", not which way. Bands are fat-tail-adjusted (empirical, not Gaussian).`);
    } else if (stockInfo && daily.atr?.atr && daily.price > 0) {
      // Stocks have no HAR-RV forecast (vol.ts is crypto-only — needs deep 1H history), but the
      // stock system prompt instructs on EXPECTED RANGE — without a band the LLM risked
      // hallucinating one. Emit an honest ATR-based approximation instead (2026-07-02).
      const a = daily.atr.atr;
      L(`Expected 24h Range (ATR-based approximation): ${formatPrice(daily.price - a)}–${formatPrice(daily.price + a)} (±1× daily ATR — a rough typical-day band, NOT a calibrated forecast; gaps can exceed it).`);
    }
    // OPTIONS-IMPLIED VOL (2026-07-02, BTC/ETH) — CONTEXT ONLY. The "buy a straddle when vol is
    // cheap" edge was BACKTESTED AND REJECTED (options_straddle_test.py, 4yr): implied vol exceeds
    // realized on average (positive vol-risk-premium → buying vol is structurally -EV), and the
    // forecast>implied "cheap" read did NOT predict realized>implied (mildly backwards — it fires
    // after a vol spike, right as vol mean-reverts). So this line is a REGIME read (how much
    // turbulence the market is pricing), never a trade signal.
    if (input.volPricing) {
      const vp = input.volPricing;
      const regime = vp.dvol >= 80 ? 'EXTREME' : vp.dvol >= 58 ? 'ELEVATED' : vp.dvol >= 40 ? 'NORMAL' : 'LOW';
      L(`Options-Implied Vol (BTC/ETH, context): 30d DVOL ${f(vp.dvol, 0)}% (${regime}) — the options market is pricing a ±${f(vp.impliedMovePct, 2)}% typical day (model forecasts ±${f(vp.forecastMovePct, 2)}%). This is the market's expected turbulence, NOT a trade signal: buying this vol (straddles) is structurally negative-EV (vol-risk-premium), backtest-confirmed.`);
    }
    // Phase 5/8: discrete risk states (VALIDATED = vol-grounded, can lead; ctx = positioning context).
    const rs = input.riskStates ?? [];
    if (rs.length) {
      L('Risk States: ' + rs.map(s => `${s.state}(${s.severity}${s.validated ? '' : ',ctx'})`).join(' · '));
      for (const s of rs) L(`  - ${s.state} [${s.severity}${s.validated ? '' : ', context-only'}]: ${s.detail}`);
    }
    // Aligned with the ELEVATED gate (2026-07-02) — at ADX 30 the prompt used to say both
    // "directional trend in force" (Environment Risk) and "range/transition regime" (here).
    const trendDominates = adxMax >= 28 || (stretchATR >= 2 && regime !== 'RANGING');
    if (trendDominates) {
      L('ML_WIN Context: in this strong trend a low ML_WIN is CORRECT but MISLEADING — ML_WIN is ATR-normalized, so a >=1.5-ATR move on top of already-high vol is genuinely less likely (~42% vs ~62% in calm). Do NOT read a low ML_WIN here as "safe/quiet"; the trend itself is the danger. Lead the risk read from Environment Risk + structure, not ML_WIN.');
    } else {
      L('ML_WIN Context: range/transition regime — ML_WIN reads as a normal move-likelihood gauge.');
    }

    // Phase 2a — Counter-trend + bias
    const dailyBias = daily.bias, fourHBias = fourH.bias, oneHBias = oneH?.bias ?? 'Neutral';
    const dailyBearish = has(dailyBias, 'Bearish'), dailyBullish = has(dailyBias, 'Bullish');
    const fourHBearish = has(fourHBias, 'Bearish'), fourHBullish = has(fourHBias, 'Bullish');
    const biasAligned = (dailyBearish && fourHBearish) || (dailyBullish && fourHBullish);
    const oneHOpposes = biasAligned && ((dailyBearish && has(oneHBias, 'Bullish')) || (dailyBullish && has(oneHBias, 'Bearish')));
    const alignedDirection = dailyBearish ? 'SHORT' : dailyBullish ? 'LONG' : 'FLAT';
    const prevDurState = prevState.killDur ?? {};
    L(`Bias Alignment: Daily=${dailyBias}, 4H=${fourHBias}, 1H=${oneHBias}`);
    L(`Counter-Trend Pullback: ${oneHOpposes} | Aligned Direction: ${alignedDirection}`);

    // Treatment-only flags
    if (isTreatment) {
      treatmentStochCrossDaily = daily.stochRSI?.crossover ?? 'none';
      treatmentStochCross4H = fourH.stochRSI?.crossover ?? 'none';
      // DIRECTION IS NOT PREDICTABLE (2026-06-01). A data leak (in-progress daily candle, now
      // fixed) inflated every crypto direction signal — the direction model (pUp), the daily
      // Stoch cross, and bias. On clean, leak-free data they all collapse to ~chance: next-24h
      // crypto direction is ~50% even at high ML_WIN. The pUp head, the CONFORMAL/meta direction,
      // and the "94% / +0.998R Stoch" claims were all artifacts. ML_WIN is a VOLATILITY signal
      // (a ≥1.5 ATR move is likely) — it says nothing about which way. So: do NOT pick a side
      // from ML signals. STOCH_CROSS is shown only as weak momentum context.
      L(`STOCH_CROSS (momentum context only, NOT directional): daily=${treatmentStochCrossDaily} | 4H=${treatmentStochCross4H}`);
      L('  A Stoch crossover does NOT predict next-24h direction (validated ~51% = coin flip on clean data). Do not raise conviction or pick a side on it.');

      if (daily.mlWinProbability != null) {
        // Sizing is gated ONLY by quality (ML_WIN). Direction is NOT predictable from ML
        // (validated ~chance), so the model can't size by direction — the side, if any, must
        // come from the LLM's own structural read, and is inherently a coin-flip-ish bet.
        // Sizing gates on the LIVE-CALIBRATED ML_WIN, the same quantity the Conviction Envelope
        // uses (2026-08-25). It previously used the RAW value, so on a bar the envelope allowed at
        // max_allowed:LOW this line printed a flat "POSITION SIZING: NO TRADE — ML_WIN < 60%" —
        // observed live on BTCUSDT alongside a contradictory ML Bucket line. Unlike the TOP tier,
        // this 0.60 threshold has no drift-independence argument behind it: it is a quality gate,
        // and the gate the system honours is the calibrated one.
        const rawWin = daily.mlWinProbability;
        const mlWin = input.calibratedMlWin ?? rawWin;
        const rawTxt = input.calibratedMlWin != null && iTrunc(rawWin * 100) !== iTrunc(mlWin * 100)
          ? ` (raw ${iTrunc(rawWin * 100)}%, live-calibrated ${iTrunc(mlWin * 100)}%)` : '';
        const qualityOK = mlWin >= 0.60;
        let mult: number, reason: string;
        if (!qualityOK) { mult = 0.0; reason = `ML_WIN < 60%${rawTxt} — below quality threshold, no trade`; }
        else if (mlWin >= 0.70) { mult = 0.75; reason = `high move-quality (≥1.5 ATR move likely)${rawTxt} but direction is a coin flip — size for a direction-uncertain bet (0.75x), or trade direction-agnostic (breakout either way). Only go full size if YOUR structural read gives a genuinely clear side`; }
        else { mult = 0.5; reason = `marginal quality + unknowable direction${rawTxt} — half size or pass`; }
        const multTxt = mult === 0 ? 'NO TRADE' : `${g2(mult)}x base risk`;
        L(`POSITION SIZING: ${multTxt} — ${reason}. Cap 1.0x. ML_WIN is a VOLATILITY signal, not a directional one.`);
      }

      const relStrApprox = stockInfo?.relativeStrength1d;
      const dRsiDelta = daily.rsiSeries.length >= 2 ? daily.rsiSeries[daily.rsiSeries.length - 1] - daily.rsiSeries[daily.rsiSeries.length - 2] : null;
      if (relStrApprox != null && dRsiDelta != null) {
        const rsPass = relStrApprox >= 1.0, drsPass = dRsiDelta >= 1.0;
        treatmentLongConfirmStatus = rsPass && drsPass ? 'PASS' : rsPass || drsPass ? 'PARTIAL' : 'FAIL';
        treatmentLongConfirmReasons.push(`relStrengthVsSpy=${f(relStrApprox, 2)}${rsPass ? '✓' : '✗(need>=1.0)'}`);
        treatmentLongConfirmReasons.push(`dRsiDelta=${f(dRsiDelta, 2)}${drsPass ? '✓' : '✗(need>=1.0)'}`);
        // FAIL no longer says "no LONG trade" — the auto-FLAT behind that sentence was removed
        // 2026-08-25 (Part 8) after measuring −0.0070R on the very bars it governed. Leaving the
        // old wording would instruct the model to stand aside on a rule the envelope no longer
        // enforces, which is the 2026-08-22g failure mode: an input whose output contract lies.
        const resultText = treatmentLongConfirmStatus === 'PASS' ? 'PASS — LONG conviction unrestricted'
          : treatmentLongConfirmStatus === 'PARTIAL' ? 'PARTIAL — cap LONG conviction at LOW'
          : 'FAIL — context only, NOT a block (tested: no measured edge either way)';
        L(`LONG_CONFIRMATION: ${treatmentLongConfirmReasons.join(' | ')} → ${resultText}`);
      } else {
        L('LONG_CONFIRMATION: n/a (crypto or missing data — gate inactive)');
      }

      if (daily.bollingerBands) {
        const pctB = daily.bollingerBands.percentB;
        if (pctB <= 0.1) L(`BB_EXTREME: daily price at/below lower band (%B=${f(pctB, 2)}). DO NOT short this. Backtest: fading band touches LOSES money (-0.052R EV). Treat as continuation, not fade.`);
        else if (pctB >= 0.9) L(`BB_EXTREME: daily price at/above upper band (%B=${f(pctB, 2)}). DO NOT short this. Backtest: fading band touches LOSES money. Treat as continuation, not fade — either skip the SHORT or pivot LONG if other signals confirm.`);
      }

      const macroParts: string[] = [];
      if (crossAsset) { macroParts.push(`DXY ${crossAsset.dxyTrend}`); macroParts.push(`SPY ${crossAsset.spyTrend}`); }
      if (stockSentiment?.vix != null) macroParts.push(`VIX ${f(stockSentiment.vix, 1)} (${stockSentiment.vixLevel})`);
      if (macroParts.length) L(`MACRO_CONTEXT: ${macroParts.join(' | ')}`);
    }

    // Phase 2b — Kill conditions (counter-trend only)
    if (oneHOpposes && oneH) {
      let killDivergence = false, killVolume = false, killFunding = false, killMacro = false;
      if (fourH.macdHistSeries.length >= 10) {
        const hist = fourH.macdHistSeries;
        if (dailyBearish) { const t = findTroughs(hist); if (t.length >= 2) { const o = t[t.length - 2], n = t[t.length - 1]; if (o < 0 && n < 0 && n > o) killDivergence = true; } }
        if (dailyBullish) { const p = findPeaks(hist); if (p.length >= 2) { const o = p[p.length - 2], n = p[p.length - 1]; if (o > 0 && n > 0 && n < o) killDivergence = true; } }
      }
      if (fourH.rsiSeries.length >= 15 && fourH.candles.length >= 15) {
        const lc = fourH.candles.slice(-20), lr = fourH.rsiSeries.slice(-Math.min(20, fourH.rsiSeries.length));
        if (lc.length === lr.length && hasDivergence(lc, lr, dailyBearish ? 'Bearish' : 'Bullish')) killDivergence = true;
      }
      if (oneH.candles.length >= 6) {
        const recent = oneH.candles.slice(-6);
        const counter = dailyBearish ? recent.filter(c => c.close > c.open) : recent.filter(c => c.close < c.open);
        const trend = dailyBearish ? recent.filter(c => c.close <= c.open) : recent.filter(c => c.close >= c.open);
        const counterAvg = counter.length ? counter.reduce((a, c) => a + c.volume, 0) / counter.length : 0;
        const trendAvg = trend.length ? trend.reduce((a, c) => a + c.volume, 0) / trend.length : 0;
        const avgVol = recent.reduce((a, c) => a + c.volume, 0) / recent.length;
        if (trendAvg > 0 && counterAvg > trendAvg * 1.2 && counterAvg > avgVol * 0.3) killVolume = true;
      }
      if (derivatives) { const fr = derivatives.fundingRatePercent; if (dailyBearish && fr < -0.01) killFunding = true; if (dailyBullish && fr > 0.01) killFunding = true; }
      killMacro = economicEvents.some(e => e.isHighImpact && e.isUpcoming && (e.date - nowMs) > 0 && (e.date - nowMs) < 4 * 3600 * 1000);

      // `killDivergence` no longer contributes to ANY_KILLED (2026-08-25). It is still COMPUTED and
      // still REPORTED below, because it is informative context for the model — it just no longer
      // hard-FLATs the analysis, having been directly tested and found to gate nothing (twelve
      // variant tests, zero passes; every LONG lift negative). The other three kill conditions are
      // untouched: counter-move volume and funding are structural, and macro guards an exogenous
      // event rather than claiming prediction.
      // `killFunding` removed from ANY_KILLED 2026-08-25 (envelope-rules.md Part 7). It blocked bars
      // averaging +0.0911R against a +0.0624R baseline on the SHORT side and kept +0.0506R — the
      // same block-the-best-bars signature as biases_MIXED, alignment_not_full and the divergence
      // rules. On LONG it was +0.0132 at 6/9: consistent, but under the +0.02 magnitude bar.
      //
      // It is a PREDICTION CLAIM — that funding paying the counter side makes the counter move more
      // likely — and by the Part 6 principle a prediction claim has to be earned. Still computed and
      // reported in the DERIVATIVES block as positioning context; it just no longer hard-FLATs.
      //
      // `killVolume` stays: noise rather than inverted, and it fires on 1.2% of bars, so removing it
      // would change almost nothing. "Does nothing measurable" is not "proven wrong".
      const anyKilled = killVolume || killMacro;
      envAnyKilled = anyKilled;
      diagnostics.killFunding = killFunding ? 1 : 0;
      diagnostics.killVolume = killVolume ? 1 : 0;
      diagnostics.killMacro = killMacro ? 1 : 0;
      diagnostics.killDivergence = killDivergence ? 1 : 0;

      // Phase 3 — Kill duration tracking (candle-anchored)
      const lastTracked = prevState.killDurCandleMs ?? null;
      const latest4H = last(fourH.candles)?.time ?? null;
      const isNewCandle = lastTracked == null || (latest4H != null && latest4H > lastTracked);
      const durState: Record<string, number> = { ...prevDurState };
      if (isNewCandle) {
        durState.divergence = killDivergence ? (durState.divergence ?? 0) + 1 : 0;
        durState.volume = killVolume ? (durState.volume ?? 0) + 1 : 0;
        durState.funding = killFunding ? (durState.funding ?? 0) + 1 : 0;
        if (latest4H != null) newState.killDurCandleMs = latest4H;
      } else {
        if (!killDivergence) durState.divergence = 0;
        if (!killVolume) durState.volume = 0;
        if (!killFunding) durState.funding = 0;
      }
      newState.killDur = durState;

      const killParts: string[] = [];
      // RSI divergence is NOT listed here. It was removed from ANY_KILLED on 2026-08-25 after direct
      // testing, and listing a non-blocking item under a heading called "Kill Conditions" is
      // contradictory — a tag saying "does not block" is weaker governance than not being there.
      // (CVD divergence, a different signal in the whale-trap flag, is untested and untouched.)
      if (killVolume) killParts.push(`counter_move_volume_exceeds(${durState.volume ?? 1} candles)`);
      if (killMacro) killParts.push('macro_event_within_4h');
      L(`Kill Conditions: ${killParts.length ? killParts.join(', ') : 'none'}, ANY_KILLED=${anyKilled}`);
    }

    // Phase 5 — Macro event window
    const highImpactUpcoming = economicEvents.filter(e => e.isHighImpact && e.isUpcoming);
    if (highImpactUpcoming.length) {
      const nearest = highImpactUpcoming[0];
      const hoursUntil = (nearest.date - nowMs) / 3600000;
      const macroRisk = hoursUntil <= 2 ? 'IMMINENT' : hoursUntil <= 4 ? 'NEARBY' : hoursUntil <= 12 ? 'UPCOMING' : 'ON_HORIZON';
      L(`Macro Risk: ${macroRisk} — ${nearest.title} in ${f(hoursUntil, 1)}h`);
      L(`Conviction Cap: ${macroRisk === 'IMMINENT' ? 'LOW (no trade)' : macroRisk === 'NEARBY' ? 'MODERATE max' : 'no cap'}`);
      envMacroRisk = macroRisk;
    } else { L('Macro Risk: NONE'); envMacroRisk = 'NONE'; }

    // Phase C1 — Parabolic. NB: on the worker `daily.price` IS the last daily close
    // (dropInProgress everywhere), so the pre-2026-07-02 "daily.price − last(candles).close"
    // was identically 0 and this flag NEVER fired (the deleted iOS original compared the live
    // ticker against the last close). Use the freshest closed price (1H close when present)
    // vs the PRIOR daily close — the move over the most recent ~24h of closed data.
    if (daily.candles.length >= 2 && daily.price > 0) {
      const oneHPx = indicators.length > 2 ? indicators[2].price : 0;
      const freshPrice = oneHPx > 0 ? oneHPx : daily.price;
      const priorDailyClose = daily.candles[daily.candles.length - 2].close;
      if (priorDailyClose > 0) {
        const pct24h = (freshPrice - priorDailyClose) / priorDailyClose * 100;
        const threshold = stockInfo ? 3.0 : 5.0;
        if (pct24h >= threshold) L(`Parabolic Risk: ELEVATED_LONG (24h move +${f(pct24h, 1)}% > ${f(threshold, 0)}% — mean-reversion bias next 48h, cap conviction MODERATE on longs, tighten TP1)`);
        else if (pct24h <= -threshold) L(`Parabolic Risk: ELEVATED_SHORT (24h move ${f(pct24h, 1)}% < -${f(threshold, 0)}% — mean-reversion bias next 48h, cap conviction MODERATE on shorts, tighten TP1)`);
        else L(`Parabolic Risk: NONE (24h move ${sgn(pct24h, 1)}%)`);
      }
    }

    // Phase C2 — After-hours floor (stocks)
    if (stockInfo && stockInfo.marketState !== 'OPEN' && daily.price > 0) {
      const priceStr = formatPrice(daily.price);
      L(`After-Hours Entry Floor: today's close ${priceStr}. Longs must enter >= ${priceStr}; shorts <= ${priceStr}. Otherwise present as a conditional for next session.`);
    }

    // Phase C3 — Volume confirmation
    if (fourH.candles.length >= 23) {
      const recent3 = fourH.candles.slice(-3);
      const priorAvg = fourH.candles.slice(0, -3).slice(-20).reduce((a, c) => a + c.volume, 0) / 20;
      if (priorAvg > 0) {
        const recentAvg = recent3.reduce((a, c) => a + c.volume, 0) / 3;
        const volMultiple = recentAvg / priorAvg;
        const allUp = recent3.every(c => c.close > c.open), allDown = recent3.every(c => c.close < c.open);
        const volStr = f(volMultiple, 2);
        let state: string;
        if (allUp && volMultiple > 1.2) state = `CONFIRMING_UP (avg vol ${volStr}× trailing 20-bar, all 3 bars green)`;
        else if (allDown && volMultiple > 1.2) state = `CONFIRMING_DOWN (avg vol ${volStr}× trailing 20-bar, all 3 bars red)`;
        else if (allUp && volMultiple < 0.8) state = `DIVERGING_UP (price up but avg vol only ${volStr}× — hollow rally)`;
        else if (allDown && volMultiple < 0.8) state = `DIVERGING_DOWN (price down but avg vol only ${volStr}× — hollow drop)`;
        else state = `NONE (avg vol ${volStr}×, direction mixed or volume neutral)`;
        L(`Volume Confirmation (4H, last 3 bars): ${state}`);
      }
    }

    // Phase C4 — Momentum confirmation
    const pa4H = priceActionAnalyze(fourH).momentum;
    const momentumParts: string[] = [];
    if (pa4H.rsiDirection !== 'unknown') momentumParts.push(`rsi: ${pa4H.rsiDirection}`);
    if (pa4H.macdHistDirection !== 'unknown') momentumParts.push(`macd_hist: ${pa4H.macdHistDirection}`);
    if (pa4H.stochCrossSignal !== 'none' && pa4H.stochCrossSignal !== '') momentumParts.push(`stoch_cross: ${pa4H.stochCrossSignal} (${pa4H.stochCrossFreshness}, ${pa4H.stochCrossAge} bars ago)`);
    if (momentumParts.length) L(`Momentum Confirmation (4H): ${momentumParts.join(' | ')}`);

    // Phase C7 — Exhaustion / Continuation
    const bullish4H = has(fourH.bias, 'Bullish'), bearish4H = has(fourH.bias, 'Bearish');
    if (bullish4H || bearish4H) {
      const direction = bullish4H ? 'Bullish' : 'Bearish';
      const exhaustion: string[] = [], continuation: string[] = [];
      if (fourH.rsiSeries.length >= 15 && fourH.candles.length >= 15) {
        const lc = fourH.candles.slice(-20), lr = fourH.rsiSeries.slice(-Math.min(20, fourH.rsiSeries.length));
        if (lc.length === lr.length && hasDivergence(lc, lr, direction)) exhaustion.push(bullish4H ? 'rsi_bearish_divergence' : 'rsi_bullish_divergence');
      }
      if (fourH.candles.length >= 23) {
        const recent3 = fourH.candles.slice(-3);
        const priorAvg = fourH.candles.slice(0, -3).slice(-20).reduce((a, c) => a + c.volume, 0) / 20;
        if (priorAvg > 0) {
          const recentAvg = recent3.reduce((a, c) => a + c.volume, 0) / 3, volMultiple = recentAvg / priorAvg;
          const allUp = recent3.every(c => c.close > c.open), allDown = recent3.every(c => c.close < c.open), ms = f(volMultiple, 2);
          if (bullish4H && allUp && volMultiple > 1.2) continuation.push(`volume_confirming_up_${ms}x`);
          else if (bullish4H && allUp && volMultiple < 0.8) exhaustion.push(`volume_diverging_up_${ms}x`);
          else if (bearish4H && allDown && volMultiple > 1.2) continuation.push(`volume_confirming_down_${ms}x`);
          else if (bearish4H && allDown && volMultiple < 0.8) exhaustion.push(`volume_diverging_down_${ms}x`);
        }
      }
      const lastC = last(fourH.candles);
      if (lastC) {
        const body = Math.abs(lastC.close - lastC.open);
        if (body > 0) {
          const upperWick = lastC.high - Math.max(lastC.close, lastC.open), lowerWick = Math.min(lastC.close, lastC.open) - lastC.low;
          if (bullish4H && upperWick > body * 2) exhaustion.push('rejection_wick_upper');
          else if (bearish4H && lowerWick > body * 2) exhaustion.push('rejection_wick_lower');
        }
      }
      if (positioning) {
        if (bullish4H && positioning.crowdingCode === 'crowdedLong') exhaustion.push('crowded_longs');
        else if (bearish4H && positioning.crowdingCode === 'crowdedShort') exhaustion.push('crowded_shorts');
      }
      if (spotPressure) {
        if (bullish4H && spotPressure.cvdTrend === 'Falling') exhaustion.push('cvd_divergence_distribution');
        else if (bearish4H && spotPressure.cvdTrend === 'Rising') exhaustion.push('cvd_divergence_accumulation');
      }
      if (fourH.ema20 != null && fourH.ema50 != null && fourH.ema200 != null) {
        if (bullish4H && fourH.ema20 > fourH.ema50 && fourH.ema50 > fourH.ema200) continuation.push('ema_stack_bullish_aligned');
        else if (bearish4H && fourH.ema20 < fourH.ema50 && fourH.ema50 < fourH.ema200) continuation.push('ema_stack_bearish_aligned');
      }
      if (derivatives) { const fr = derivatives.fundingRatePercent; if (bullish4H && fr < -0.005) continuation.push('funding_negative_supports_long'); else if (bearish4H && fr > 0.005) continuation.push('funding_positive_supports_short'); }
      L(`Exhaustion Signals (4H, vs ${direction} momentum): ${exhaustion.length ? `${exhaustion.length} — ${exhaustion.join(', ')}` : '0 — none'}`);
      L(`Continuation Signals (4H, with ${direction} momentum): ${continuation.length ? `${continuation.length} — ${continuation.join(', ')}` : '0 — none'}`);
      envContinuationCount = continuation.length;

      // Phase C7b — CHASE / EXHAUSTION guard (F-1). Direction-AGNOSTIC "are you about to
      // buy the top / short the bottom?" check, aimed at the single most common retail loss:
      // entering AFTER a move has already run, at the extreme, where early entrants distribute
      // to late chasers. Synthesizes signals already gathered above (extension from the 200D
      // mean, stretched oscillators, running into a level in the chase direction, and the
      // exhaustion tally) into ONE loud, plain-language risk read. The "chase direction" is the
      // prevailing 4H momentum (bullish → buying a rally; bearish → shorting a sell-off).
      const chaseDir = bullish4H ? 'LONG' : 'SHORT';
      const dAtrChase = daily.atr?.atr ?? 0;
      const stretch = (dAtrChase > 0 && daily.ema200 != null) ? Math.abs(daily.price - daily.ema200) / dAtrChase : 0;
      const rsiHot = bullish4H
        ? ((daily.rsi ?? 0) >= 70 || (fourH.rsi ?? 0) >= 72)
        : ((daily.rsi ?? 100) <= 30 || (fourH.rsi ?? 100) <= 28);
      const stochHot = bullish4H
        ? ((daily.stochRSI?.k ?? 0) >= 85 || (fourH.stochRSI?.k ?? 0) >= 85)
        : ((daily.stochRSI?.k ?? 100) <= 15 || (fourH.stochRSI?.k ?? 100) <= 15);
      // Running INTO a level in the chase direction (resistance/VAH just above for longs;
      // support/VAL just below for shorts) — the place a tired move is most likely to reject.
      const pxChase = fourH.price;
      const levelBand = 0.6 * (fourH.atr?.atr ?? dAtrChase);
      let intoLevel = false, levelPx = 0;
      if (levelBand > 0) {
        if (bullish4H) {
          const above = [...fourH.supportResistance.resistances, ...daily.supportResistance.resistances, daily.volumeProfile?.vah ?? NaN]
            .filter(v => Number.isFinite(v) && v >= pxChase && v - pxChase <= levelBand);
          if (above.length) { intoLevel = true; levelPx = Math.min(...above); }
        } else {
          const below = [...fourH.supportResistance.supports, ...daily.supportResistance.supports, daily.volumeProfile?.val ?? NaN]
            .filter(v => Number.isFinite(v) && v <= pxChase && pxChase - v <= levelBand);
          if (below.length) { intoLevel = true; levelPx = Math.max(...below); }
        }
      }
      let chaseScore = 0;
      if (stretch >= 2) chaseScore++;
      if (rsiHot) chaseScore++;
      if (stochHot) chaseScore++;
      if (intoLevel) chaseScore++;
      if (exhaustion.length >= 1) chaseScore++;
      // HIGH requires the CORE ingredient of a chase (an already-extended OR visibly-exhausting
      // move) plus confirmation, so two oscillators alone can't trip it.
      const coreChase = stretch >= 2 || exhaustion.length >= 2;
      const chaseLevel = (coreChase && chaseScore >= 3) ? 'HIGH' : (chaseScore >= 2 ? 'ELEVATED' : 'none');
      envChaseLevel = chaseLevel;   // hand to the Conviction Envelope
      if (chaseLevel !== 'none') {
        const verb = bullish4H ? 'BUYING THE TOP' : 'SHORTING THE BOTTOM';
        const parts: string[] = [];
        if (stretch >= 2) parts.push(`price is ${f(stretch, 1)} ATR from its 200D mean (extended)`);
        if (rsiHot) parts.push(`RSI is ${bullish4H ? 'overbought' : 'oversold'}`);
        if (stochHot) parts.push(`Stoch is at an extreme`);
        if (intoLevel) parts.push(`it is running into ${bullish4H ? 'resistance' : 'support'} at ${formatPrice(levelPx)}`);
        if (exhaustion.length >= 1) parts.push(`${exhaustion.length} exhaustion signal${exhaustion.length > 1 ? 's' : ''} firing (${exhaustion.join(', ')})`);
        L(`CHASE / EXHAUSTION RISK: ${chaseLevel} — entering ${chaseDir} here risks ${verb}. ${parts.join('; ')}.`);
        L(`  This is the classic retail trap: a ${bullish4H ? 'rally' : 'sell-off'} that has ALREADY run is where early entrants distribute to late chasers. If the user wants ${chaseDir} exposure, the lower-risk play is to WAIT — for a pullback${intoLevel ? ` (the ${bullish4H ? 'resistance' : 'support'} at ${formatPrice(levelPx)} is more likely to reject than break here)` : ''} or for a fresh ${bullish4H ? 'higher-low' : 'lower-high'} to form — NOT to enter at the extreme. ${chaseLevel === 'HIGH' ? 'Surface this PROMINENTLY in the Risk Map (lead with it). ' : 'Surface this in the Risk Map. '}In "If You Take a Position", if a ${chaseDir} setup is still permitted, state plainly that it is a CHASE, and the Entry you publish — in the table AND in the JSON block — MUST be that pullback level as a CONDITIONAL, named to the price. Do NOT publish the current extreme as the entry while recommending a pullback in prose: the JSON is the only part of your output anything downstream reads, so a setup that contradicts your own stated preference is the version the user is shown. If no valid pullback level exists to name, emit no setup at all. (This is a CONSISTENCY requirement, not a claim that pullback entries pay better — that claim was retracted, see ENTRY METHOD.)`);
      }
    }

    // Phase C9 — Bias Feasibility asymmetry
    {
      const scoreDir = (dir: string): number => {
        let s = 0; const bull = dir === 'LONG';
        if (bull ? has(daily.bias, 'Bullish') : has(daily.bias, 'Bearish')) s += 1;
        if (bull ? has(fourH.bias, 'Bullish') : has(fourH.bias, 'Bearish')) s += 1;
        if (oneH) { if (bull ? has(oneH.bias, 'Bullish') : has(oneH.bias, 'Bearish')) s += 1; }
        if (daily.mlWinProbability != null && daily.mlWinProbability >= 0.70) s += 1;
        if (fourH.candles.length >= 23) {
          const recent3 = fourH.candles.slice(-3);
          const priorAvg = fourH.candles.slice(0, -3).slice(-20).reduce((a, c) => a + c.volume, 0) / 20;
          if (priorAvg > 0) {
            const mult = (recent3.reduce((a, c) => a + c.volume, 0) / 3) / priorAvg;
            const allUp = recent3.every(c => c.close > c.open), allDown = recent3.every(c => c.close < c.open);
            if (bull && allUp && mult > 1.2) s += 1; else if (!bull && allDown && mult > 1.2) s += 1;
          }
        }
        if (fourH.ema20 != null && fourH.ema50 != null && fourH.ema200 != null) {
          if (bull && fourH.ema20 > fourH.ema50 && fourH.ema50 > fourH.ema200) s += 1;
          else if (!bull && fourH.ema20 < fourH.ema50 && fourH.ema50 < fourH.ema200) s += 1;
        }
        if (derivatives) { const fr = derivatives.fundingRatePercent; if (bull && fr < -0.005) s += 1; else if (!bull && fr > 0.005) s += 1; }
        else if (stockInfo) { if (daily.mlWinProbability != null && daily.mlWinProbability >= 0.85) s += 1; }
        return s;
      };
      const longScore = scoreDir('LONG'), shortScore = scoreDir('SHORT'), asymmetry = Math.abs(longScore - shortScore);
      const favored = longScore > shortScore ? 'LONG' : shortScore > longScore ? 'SHORT' : 'NONE';
      const cap = asymmetry <= 2 ? 'FLAT_required_close_call' : asymmetry === 3 ? 'MODERATE_max' : asymmetry <= 5 ? 'HIGH_allowed' : 'HIGH_strong';
      L(`Bias Feasibility: LONG ${longScore}/7, SHORT ${shortScore}/7 — asymmetry ${asymmetry} (favored: ${favored}, conviction_cap: ${cap})`);
    }

    // Phase E4/E7 — Failure modes + archetype track record
    {
      const archetype = classifyArchetype(indicators as any);
      const modesMap: Record<string, string[]> = {
        COUNTER_TREND_REVERSAL: [
          '(a) 4H reversal was a single-bar bounce, not a structural flip — invalidated by next 4H closing back through swing point',
          '(b) Daily trend reasserts within hours — watch for 1H structural break in daily direction within 6 bars of entry',
          '(c) ML_WIN was elevated by features that don\'t apply to counter-trend regime (e.g., high vol on a kill-clearing bar)',
          '(d) key level being faded was the wrong level — fresh 4H test at adjacent level would invalidate',
        ],
        COUNTER_TREND_PULLBACK: [
          '(a) higher-TF trend was actually exhausting, not pausing — confirmed by 4H structural break against thesis (LL on bullish thesis, HH on bearish)',
          '(b) 1H exhaustion signal was a single wick, 1H continuation resumes — wait for 1H close back across the level',
          '(c) Volume on counter-move is institutional not retail — counter_move_volume_exceeds kill condition catches this',
          '(d) news/macro catalyst hit during the pullback window that justifies the counter-move',
        ],
        MOMENTUM_CONTINUATION: [
          '(a) momentum was fading not confirming — declining MACD hist on next 4H close confirms',
          '(b) entry level held by stop hunts not real demand — invalidated by quick sweep + close back through within 1-2 bars',
          '(c) higher-TF retracement target was already hit and exhausted — daily structure may be shifting silently',
          '(d) Parabolic Risk flag elevated → mean-reversion bias next 48h reduces continuation probability',
        ],
        RANGE_EDGE_FADE: [
          '(a) range is actually breaking out — confirmed by close beyond VAH/VAL with volume >1.5× avg',
          '(b) the level being faded has been tested 4+ times (worn) and is likely to break',
          '(c) range is widening, not stable — recent 4H bars show ATR expansion >1.3× trailing avg',
          '(d) macro catalyst within 4h is likely to break the range regardless of structure',
        ],
        BREAKOUT_RETEST: [
          '(a) the breakout was a fakeout — retest fails because the move didn\'t have real participation (volume <1.2× on breakout bar)',
          '(b) you\'re entering the breakout bar itself, not the retest — wait for the retest, the retest IS the trade',
          '(c) the squeeze hasn\'t actually fired — Bollinger bands haven\'t expanded materially on the breakout candle',
          '(d) opposite kill (failed breakdown / breakout) clears the trade thesis — watch for close back inside the prior range',
        ],
      };
      const modes = modesMap[archetype] ?? [
        '(a) no archetype matched — biases mixed, regime ambiguous, no strong evidence either way',
        '(b) consider FLAT — without an archetype, the failure surface is wide and undefined',
      ];
      L(`Likely Failure Modes (${archetype}):`);
      for (const m of modes) L(`  ${m}`);

      const rec = archetypeRecord ?? { wins: 0, losses: 0, total: 0 };
      if (rec.total >= 5) {
        const winRate = rec.wins / rec.total * 100;
        const verdict = winRate >= 60 ? 'pattern_reliable_on_this_symbol_trust_signal' : winRate <= 30 ? 'distrust_this_archetype_on_this_symbol_require_extra_confluence' : 'mixed_no_strong_edge_size_conservatively';
        L(`Archetype Track Record (${symbol} ${archetype}, 30d): ${rec.wins}W ${rec.losses}L (${f(winRate, 0)}%) — ${verdict}`);
      } else if (rec.total > 0) {
        L(`Archetype Track Record (${symbol} ${archetype}, 30d): ${rec.wins}W ${rec.losses}L — too few samples (${rec.total}) for verdict`);
      } else {
        L(`Archetype Track Record (${symbol} ${archetype}, 30d): no resolved samples yet`);
      }
    }

    // Phase E6 — News-thesis conflict (stocks)
    if (stockInfo?.newsHeadlines && stockInfo.newsHeadlines.length && (has(fourH.bias, 'Bullish') || has(fourH.bias, 'Bearish'))) {
      const bullishKw = ['beat', 'beats', 'raises', 'raised', 'upgrade', 'upgraded', 'surge', 'surged', 'surges', 'growth', 'jumps', 'soars', 'rallies', 'breakthrough', 'approval', 'approves', 'wins', 'boost', 'boosts', 'robust', 'exceeds', 'record high'];
      const bearishKw = ['miss', 'misses', 'missed', 'downgrade', 'downgraded', 'plunge', 'plunges', 'slumps', 'declines', 'lawsuit', 'sued', 'investigation', 'recall', 'fraud', 'probe', 'layoffs', 'slashes', 'warns', 'warning', 'halts', 'suspends', 'falls', 'drops', 'tumbles', 'sinks', 'cuts'];
      let bullishHits = 0, bearishHits = 0;
      for (const h of stockInfo.newsHeadlines.slice(0, 8)) {
        const lo = h.toLowerCase();
        for (const kw of bullishKw) if (lo.includes(kw)) { bullishHits++; break; }
        for (const kw of bearishKw) if (lo.includes(kw)) { bearishHits++; break; }
      }
      const biasDir = has(fourH.bias, 'Bullish') ? 'BULLISH' : 'BEARISH';
      let newsLabel: string, conflictState: string;
      if (bullishHits >= 2 && bullishHits > bearishHits) { newsLabel = `BULLISH_NEWS (${bullishHits} bull / ${bearishHits} bear keywords, last 8 headlines)`; conflictState = biasDir === 'BULLISH' ? 'SUPPORTS' : 'CONFLICTS'; }
      else if (bearishHits >= 2 && bearishHits > bullishHits) { newsLabel = `BEARISH_NEWS (${bullishHits} bull / ${bearishHits} bear keywords, last 8 headlines)`; conflictState = biasDir === 'BEARISH' ? 'SUPPORTS' : 'CONFLICTS'; }
      else { newsLabel = `NEUTRAL_NEWS (${bullishHits} bull / ${bearishHits} bear keywords — no strong tilt)`; conflictState = 'NEUTRAL'; }
      L(`News-Thesis Conflict: ${newsLabel} vs Bias=${biasDir} → ${conflictState}`);
      if (conflictState === 'CONFLICTS') { L('  Action: name the conflict explicitly in Bias; either justify why technicals override OR downgrade conviction / call FLAT'); envNewsConflicts = true; }
    }

    // Phase E1 — Multi-TF alignment
    {
      const dailyDir = has(daily.bias, 'Bullish') ? 'Bullish' : has(daily.bias, 'Bearish') ? 'Bearish' : 'Neutral';
      const fourHDir = has(fourH.bias, 'Bullish') ? 'Bullish' : has(fourH.bias, 'Bearish') ? 'Bearish' : 'Neutral';
      const oneHDir = oneH ? (has(oneH.bias, 'Bullish') ? 'Bullish' : has(oneH.bias, 'Bearish') ? 'Bearish' : 'Neutral') : '—';
      let state: string;
      if (dailyDir === 'Bullish' && fourHDir === 'Bullish' && (oneHDir === 'Bullish' || oneHDir === '—')) state = 'ALIGNED_BULLISH';
      else if (dailyDir === 'Bearish' && fourHDir === 'Bearish' && (oneHDir === 'Bearish' || oneHDir === '—')) state = 'ALIGNED_BEARISH';
      else if (dailyDir === fourHDir && dailyDir !== 'Neutral') state = `ALIGNED_${dailyDir.toUpperCase()}_HIGHER_TF_ONLY`;
      else state = 'MIXED';
      L(`Multi-TF Alignment: ${state} (Daily ${dailyDir}, 4H ${fourHDir}, 1H ${oneHDir})`);
      envAlignment = state;
    }

    // Phase E2 — Vol regime
    if (daily.atrPercentile != null) {
      const pctInt = iTrunc(daily.atrPercentile);
      const implication = pctInt >= 85 ? 'expect_mean_reversion_next_24_48h (extreme high vol contracts)'
        : pctInt <= 15 ? 'expect_expansion_soon (extreme low vol expands — Bollinger squeeze territory)'
        : pctInt >= 70 ? 'elevated_vol_caution_on_extension_targets'
        : pctInt <= 30 ? 'compressed_vol_breakout_setups_favored' : 'normal_range_no_bias';
      L(`Vol Regime: ATR_PERCENTILE_${pctInt} → ${implication}`);
    }

    // SHALLOW PULLBACK BAND — REMOVED 2026-08-25. It computed the 0.2-0.5 ATR entry band in prices
    // to enforce the ENTRY DISCIPLINE rule. That rule was retracted the same day: `level_entry.py`
    // began its fill window at T+1h while the feature row's `price` is the CLOSE of the bar
    // spanning T..T+4h, so a pullback that had already happened inside the signal bar counted as a
    // fill. Corrected on the same 290,791 opportunities the effect INVERTS on shorts
    // (+0.0660R -> -0.0296R, 9/9 periods -> 0/9) and vanishes on longs (+0.0919R -> +0.0009R).
    // Emitting a band that enforces a rule which measures negative is worse than emitting nothing.
    // See docs/research/envelope-rules.md, "PARTS 4-5 RETRACTED".

    // Phase E3 — Structure levels (neutral)
    if (fourH.marketStructure && fourH.marketStructure.levelTests.length && daily.price > 0 && fourH.atr?.atr && fourH.atr.atr > 0) {
      const ms = fourH.marketStructure, atr = fourH.atr.atr, currentPrice = daily.price, flipThreshold = atr * 0.15;
      const structureEntries: string[] = [];
      for (const level of ms.levelTests.slice(0, 8)) {
        const atrDist = Math.abs(level.price - currentPrice) / atr;
        if (atrDist > 2.0) continue;
        const direction = level.price > currentPrice ? 'RES' : level.price < currentPrice ? 'SUP' : 'AT';
        const appearsAsHigh = ms.swingHighs.some(p => Math.abs(p - level.price) < flipThreshold);
        const appearsAsLow = ms.swingLows.some(p => Math.abs(p - level.price) < flipThreshold);
        const tags = [`tested_${level.tests}x`]; if (appearsAsHigh && appearsAsLow) tags.push('FLIP');
        structureEntries.push(`${direction} ${formatPrice(level.price)} [${tags.join(',')}]`);
      }
      if (structureEntries.length) L(`Structure Levels (4H, within 2× ATR of price): ${structureEntries.join(' | ')}`);

      // CASCADE ZONE (2026-08-22) — measured, not assumed. Per-event liquidation data
      // (docs/research/liquidation-map.md) shows price spends only ~1.2% of its time beyond the
      // prior 7-day extreme, yet ~40% of ALL forced-liquidation notional prints there:
      //
      //     32 symbols measured. MAJORS median 34.6x long / 30.5x short; ALTS median 30.2x /
      //     26.0x. Range 13x (AAVE short) to 66x (TRX long). 24h-VWAP control: 1.1-2.2x in every
      //     cell — the metric CAN return "nothing structural", which is why the 30x is credible.
      //     Alts run slightly LOWER than majors, so thin books do not amplify the effect.
      //
      // Intensity is time-normalised, so this is NOT the tautology "longs die when price falls":
      // it is forced flow per unit of time spent at that price, ~30-40x its baseline.
      //
      // STRICTLY CONDITIONAL. It says what waits there IF price arrives — nothing about whether
      // price will go. The "liquidity magnet" claim is untested and the wording below must not
      // imply it, because that would be a direction call and direction is a coin flip here.
      // The actionable use is STOP PLACEMENT: a stop just past a multi-day extreme sits in the
      // densest liquidation zone on the chart.
      const sevenDayHigh = Math.max(...(fourH.candles ?? []).slice(-42).map((c: any) => c.high ?? 0));
      const sevenDayLow = Math.min(...(fourH.candles ?? []).slice(-42).map((c: any) => c.low ?? Infinity));
      if (Number.isFinite(sevenDayHigh) && Number.isFinite(sevenDayLow) && sevenDayHigh > 0 && sevenDayLow > 0) {
        L(`CASCADE ZONES (measured): beyond ${formatPrice(sevenDayLow)} (7d low) and beyond ${formatPrice(sevenDayHigh)} (7d high).`);
        L(`  Forced-liquidation density past a 7-day extreme runs ~20-45x its time-weighted baseline (median ~30x; measured on per-event data across 32 crypto symbols, both sides — majors ~35x, alts ~30x, and every symbol above 13x). Two uses, both CONDITIONAL on price getting there: (a) a stop placed just beyond one of these sits in the densest liquidation zone on the chart — prefer the far side of it or accept it will likely be swept; (b) if price does break one, expect acceleration rather than a clean retest. This says NOTHING about whether price will travel there — do not present it as a target, a magnet, or a direction call.`);
      }
    }

    // Phase E — stock-only context flags
    if (stockInfo) {
      const si = stockInfo;
      if (si.sectorETF && si.relativeStrength1d != null && si.outperformingSector != null) {
        const label = si.outperformingSector ? 'OUTPERFORMING' : 'UNDERPERFORMING';
        const bias = si.outperformingSector ? 'risk-on tailwind' : 'risk-off headwind';
        L(`Sector Strength: ${si.sectorETF} ${label} vs SPY (${sgn(si.relativeStrength1d, 1)}%) → ${bias}`);
      }
      if (si.insiderTransactions && si.insiderTransactions.length) {
        const cutoff = nowMs - 30 * 86400000;
        const recent = si.insiderTransactions.filter(t => t.date >= cutoff);
        const buys = recent.filter(t => t.isBuy), sells = recent.filter(t => !t.isBuy);
        const buyOfficers = new Set(buys.map(t => t.name)).size, sellOfficers = new Set(sells.map(t => t.name)).size;
        const buyValueM = buys.reduce((a, t) => a + t.value, 0) / 1e6, sellValueM = sells.reduce((a, t) => a + t.value, 0) / 1e6;
        if (buys.length >= 3 && buyOfficers >= 3) L(`Insider Cluster: ${buys.length} buys in 30d from ${buyOfficers} officers ($${f(buyValueM, 1)}M total) — fundamental buy signal`);
        else if (sells.length >= 5 && sellOfficers >= 4) L(`Insider Cluster: ${sells.length} sells in 30d from ${sellOfficers} officers ($${f(sellValueM, 1)}M total) — possible distribution`);
      }
      if (si.earningsDate != null && si.earningsDate > nowMs) {
        const days = Math.floor((si.earningsDate - nowMs) / 86400000);
        // MEASURED 2026-08-25 (Part 8) on 487k stock opportunities, 159 symbols, 2020-2026 — the
        // first envelope condition validated on its OWN stated mechanism rather than merely
        // surviving an EV null. Baseline P(overnight gap >= 2 ATR inside the hold window) away from
        // earnings is 8.05%; inside these windows it is 33% / 47% / 33% — 4.06x / 5.88x / 4.13x,
        // in 9/9 half-year periods each, with cluster CIs [3.68,4.43] / [5.46,6.30] / [3.86,4.39].
        //
        // RE-MEASURED 2026-08-26 (Phase 2 C2); the previously published figures were OVERSTATED.
        // Part 8 gave 7.08x / 7.03x / 4.99x against a 7.4% baseline. Three inputs differ — corrected
        // anchor, full 300-bar warm-up, and a baseline of >14d bars rather than all bars — and the
        // gap is not attributable to any one of them. The VERDICT is unchanged, every window clears
        // the 1.5x bar by a wide margin, but the prompt was quoting numbers that were too large.
        //
        // The ORDERING also flipped: 3-7d is now highest, not 0-2d. That is NOT an ATR artifact —
        // ATR is flat across the windows (1.94-2.00 against a 2.070 baseline) and the ordering
        // survives an ATR-free gap threshold. No mechanism is offered for it. The numbers are in the prompt because "gap risk" as a
        // bare phrase invites the model to weigh it against a chart pattern; "42% of stops gap
        // straight through" does not.
        // The "43% of stops fill beyond the stop, averaging 1.4R lost" clause was removed
        // 2026-08-26: it came from `stock_gap_fill.py`, which re-prices stops on the retracted
        // lookahead anchor. The GAP RATES below survive that retraction — they are computed from
        // `maxGapATR`, a window-shift-robust comparison of gap frequency near vs far from earnings,
        // not from any entry simulation — but they are re-run in Phase 2 C2 regardless.
        if (days <= 2) L(`Earnings Proximity: ${days}d to earnings — CONVICTION_CAP_LOW. MEASURED (re-run 2026-08-26): 33% of bars see an overnight gap >= 2 ATR against an 8.1% baseline away from earnings — 4.1x, in 9 of 9 half-year periods. A gap that size jumps clean over a 2 ATR stop, so the stop cannot be relied on through the report. This is a variance fact, not a direction call.`);
        else if (days <= 7) L(`Earnings Proximity: ${days}d to earnings — CONVICTION_CAP_MODERATE. MEASURED (re-run 2026-08-26): gap >= 2 ATR on 47% of bars, 5.9x the away-from-earnings baseline and the HIGHEST of the three windows, 9/9 periods. Skip if 4H momentum opposes thesis.`);
        else if (days <= 14) L(`Earnings Proximity: ${days}d to earnings — flag in Risk Factors, no conviction cap. MEASURED (re-run 2026-08-26): 33% of bars, still 4.1x the baseline gap rate, because a multi-day hold opened this far out often straddles the report anyway.`);
      }
    }

    // Phase C10 — Conviction Envelope
    {
      // The rule bodies live in `src/envelope.ts` (2026-08-26). They were extracted because three
      // of the four verdict lists are computed here and then discarded on a FLAT bar — nothing
      // outside this builder could observe `highBlocks` / `moderateBlocks` / `downgrade`, which is
      // why every measurement of them so far reconstructed the rules in Python instead. The
      // exporter and the research layer now call the same function this does.
      const staleCount = dataQuality?.missingEnrichments.length ?? 0;
      const envIn: EnvelopeInput = {
        rawMlWin: daily.mlWinProbability ?? null,
        calibratedMlWin: input.calibratedMlWin ?? null,
        staleCount,
        anyKilled: envAnyKilled,
        macroRisk: envMacroRisk,
        newsConflicts: envNewsConflicts,
        alignment: envAlignment,
        alignedDirection,
        continuationCount: envContinuationCount,
        isCrypto: isCryptoSym,
        isStock: !!stockInfo,
        isTreatment,
        regime,
        longConfirmStatus: treatmentLongConfirmStatus,
        oneHOpposes,
        cryptoBearRegime: envCryptoBearRegime,
        // Resolved here so the envelope itself has no notion of "now" — a pure function is what
        // makes a historical replay honest.
        daysToEarnings: stockInfo?.earningsDate != null && stockInfo.earningsDate > nowMs
          ? Math.floor((stockInfo.earningsDate - nowMs) / 86400000) : null,
        mlCoverageCut: input.mlCoverageCut ?? null,
      };
      const env = evaluateEnvelope(envIn);
      envelopeInput = envIn; envelopeVerdict = env;
      const { rawMlPct, mlPct, calibLifted, autoFlat, highBlocks, moderateBlocks, downgrade, maxAllowed } = env;
      L('Conviction Envelope:');
      L(`  max_allowed: ${maxAllowed}`);
      if (calibLifted) L(`  note: raw ML_WIN ${rawMlPct}% would auto-FLAT, but the live forward calibration corrects it to ~${mlPct}% (bucket realizes higher than the drifted model predicts) — NOT auto-FLAT on ML alone.`);
      if (autoFlat.length) {
        L(`  auto_FLAT_active: ${autoFlat.join(', ')}`);
        L('  → Output NO SETUP regardless of any other reasoning');
        // Reframe the low-ML-in-a-trend case so the output isn't a demoralizing "nothing here":
        // ML_WIN measures a SHARP (>=1.5 ATR/24h) move; a slow trend grind is a low-ML_WIN state
        // BY DESIGN, and "no vol-edge entry" is NOT "no trend / stand down".
        //
        // 2026-07-24 — the hatch fires when EVERY auto-FLAT reason is a QUALITY-gate reason
        // (ML_WIN under the bar, or the ML-gated biases_MIXED block) rather than a real hazard.
        // It previously required the reason set to be EXACTLY one `ML_WIN_*` entry, which made it
        // unreachable in the single most common FLAT case — `biases_MIXED_and_ML_<70` — so a slow
        // mixed-bias trend emitted a bare "NO SETUP" on every bar with none of the context below.
        // Measured by replaying this builder over BTC 07-13→07-25 (73 4H bars, real candles): 71
        // bars FLATted, 63 of them on biases_MIXED alone, Environment Risk ELEVATED on every
        // single one, and NOT ONE emitted this line — a week of silence through a +7.5% 4H
        // advance whose daily bias never confirmed. Hazard reasons (ANY_KILLED, macro_IMMINENT,
        // divergence_escalated, chase_into_extended_aligned_trend) still suppress the hatch:
        // those are genuine stand-down states where "the trend is intact, riding it is your call"
        // would be actively dangerous. `biases_MIXED_(ML_unavailable)` is deliberately EXCLUDED —
        // with no ML value we cannot characterise move likelihood at all.
        const isQualityGateReason = (r: string) => r.startsWith('ML_WIN_') || r.startsWith('biases_MIXED_and_ML_');
        const onlyQualityGate = autoFlat.every(isQualityGateReason);
        if (onlyQualityGate && (envRisk === 'ELEVATED' || envRisk === 'HIGH')) {
          // The mixed-bias variant of this line was removed 2026-08-25 along with the
          // `biases_MIXED_and_ML_<70` rule that produced its trigger. `mixedGated` could no longer
          // be true, so that branch was unreachable — dead code that still compiled, which is the
          // pattern that has bitten this codebase repeatedly this week.
          L(`  FRAMING: this FLAT is "no volatility-edge entry" (ML_WIN gauges a sharp >=1.5-ATR move, unlikely here), NOT "quiet / nothing happening" — Environment Risk is ${envRisk} and the ${trendDir}-trend is intact. Riding an existing trend is a separate decision this tool does not gate; say so plainly instead of a flat "stand aside". Do NOT imply the tape is safe.`);
        }
        // Catalyst framing on a CHASE flat (2026-08-22). The chase guard fires on extended +
        // exhaustion, and its evidence is real (trend_direction_test.py: a mature aligned trend
        // carries ~0% forward EV). But its implicit model is a move that ran out of buyers, and a
        // policy repricing is a different animal — the whole range resets rather than mean-reverts.
        // This does NOT open the gate: the FLAT stands, because "a catalyst exists" is a heuristic
        // with no walk-forward evidence behind it and loosening a validated guard on narrative
        // would be exactly the mistake this project's graveyard is full of. What it fixes is the
        // MESSAGE — a chase FLAT otherwise suppresses the framing hatch entirely and emits a bare
        // NO SETUP, which reads as "nothing here" on the one day the tape is repricing hardest.
        // RETARGETED 2026-08-25 (Part 10). This fired on `autoFlat.includes('chase_...')`, which can
        // no longer be true — the chase auto-FLAT is gone. The framing itself is still worth having,
        // so it now keys on the chase READING, and its tail no longer orders a NO SETUP: on an
        // extended bar the correct output is a conditional entry at the pullback band, not silence.
        if (input.news?.catalystActive && envChaseLevel === 'HIGH') {
          L(`  FRAMING (catalyst): a PRIMARY-source policy release landed ~${input.news.latestPrimaryAgeH}h ago (see POLICY / MACRO HEADLINES). An extended move WITH a fresh policy catalyst behind it is a repricing, not buyer exhaustion — the whole range can reset rather than mean-revert. Two consequences: do NOT treat the extension itself as a reason to stand aside, and do NOT assume price must return to the pullback band just because it is extended. Set the conditional entry at the band and accept that it may never fill. If the user already holds a position in the trend direction, this is explicitly NOT an exit signal.`);
        }
      }
      else {
        if (highBlocks.length) L(`  HIGH_blocked_because: ${highBlocks.join(', ')}`);
        if (moderateBlocks.length) L(`  MODERATE_blocked_because: ${moderateBlocks.join(', ')}`);
        if (downgrade.length) L(`  downgrade_one_tier_if_LLM_decides: ${downgrade.join(', ')}`);
        // Must-offer-entry rule (2026-08-21). During the Aug-2026 62k→80k BTC run, every
        // quantitative gate was open (replayed: 34/34 bars envelope-CLEAN at ML 80) yet the
        // analyses still declined to construct a setup — "extended, wait for the retest" prose
        // rendered as NO ENTRY EDGE through a +25% move. When the system's own stack says its
        // strongest tradeable state is active, declining is no longer an allowed output: the
        // honest form of caution is a CONDITIONAL entry at a named level, not silence.
        // ── The mandate's ML tier (rewritten 2026-08-21c) ────────────────────────────────────
        // The first cut floored this gate at the live calibration CEILING, which was circular:
        // applyCalibration clamps at that ceiling, so `calibrated <= ceiling` holds by
        // construction and requiring `calibrated >= ceiling` admitted only bars at the very top
        // point of the fitted curve. Measured both ways: on the coarse Aug curve it demanded raw
        // >= 0.760 and on the box's real fitted curve raw >= 0.792 — BOTH stricter than the plain
        // raw >= 0.70 the change was meant to widen, i.e. the remedy was narrower than the
        // problem. The floor also swung 68<->70 purely on which sparse buckets cleared n >= 40.
        //
        // So the tier is now read off the RAW model scale, where "top bucket" is a fixed,
        // documented, drift-independent quantity: v14 reliability has raw 70-85 realizing 75.9%
        // (crypto) / 73.8% (stocks) at 76.6% top-decile precision, and the ML Bucket line below
        // already calls raw >= 70 "TOP" — so this now agrees with it instead of quietly using a
        // second scale. The live calibration keeps its job (correcting the auto-FLAT/quality gate
        // that was over-suppressing) and additionally acts as a VETO here: if the forward data
        // says these bars no longer realize even the notify threshold, the model's self-reported
        // top tier has decayed and nothing is mandated.
        // Veto at the FAVORABLE boundary of the prompt's own ML Bucket taxonomy (>=70 TOP, >=60
        // FAVORABLE, >=50 MARGINAL, <50 no-trade): if a bar the model calls TOP no longer clears
        // even FAVORABLE on graded forward data, the tier has decayed and nothing is mandated.
        // Deliberately NOT set at the notify threshold — on the box's real curve raw-70 bars
        // calibrate to ~65.6, so a 65 veto would trip on ordinary mild drift rather than decay.
        const MANDATE_RAW_PCT = 70, MANDATE_LIVE_VETO_PCT = 60;
        const inTopTier = rawMlPct != null && rawMlPct >= MANDATE_RAW_PCT;
        const liveVetoes = mlPct != null && mlPct < MANDATE_LIVE_VETO_PCT;
        // Both numbers get quoted wherever the mandate speaks — one prompt was otherwise printing
        // "ML_WIN 68%" (calibrated) next to "ML Bucket: TOP (ML_WIN 80%)" (raw) with no way to
        // tell they are the same bar on two scales.
        const mlBoth = mlPct != null && mlPct !== rawMlPct ? `ML_WIN raw ${rawMlPct}% (live-calibrated ${mlPct}%)` : `ML_WIN ${rawMlPct}%`;
        // Exclusions — states where forcing a setup would be actively wrong. These are NOT
        // auto-FLATs (the tape may still be tradeable by the user's own judgment); they only
        // suspend the MANDATE, leaving the LLM its normal discretion.
        const mandateBlocks: string[] = [];
        if (staleCount >= 2) mandateBlocks.push(`data_stale_${staleCount}_sources`);   // the missing feeds are exactly the ones that would close this window
        if (stockInfo?.earningsDate != null && stockInfo.earningsDate > nowMs && Math.floor((stockInfo.earningsDate - nowMs) / 86400000) <= 2) mandateBlocks.push('earnings_within_2d');
        if (liveVetoes) mandateBlocks.push(`live_calibration_${mlPct}%_below_${MANDATE_LIVE_VETO_PCT}`);   // model says top tier, forward data disagrees
        const mandateOK = mandateBlocks.length === 0;
        // Precedence: the mandate compels an ENTRY, never a conviction tier or a direction, and
        // never overrides a hazard flag. Appended to both windows so a co-emitted counter-order
        // (BB_EXTREME "DO NOT short", news conflict, bear-regime LONG cap, a LOW max_allowed)
        // has a stated resolution instead of two absolutes the model resolves arbitrarily.
        const precedence = ` PRECEDENCE: this compels an ENTRY, not a tier and not a side — obey every other flag on top of it (max_allowed caps conviction; a "DO NOT short"/news-conflict/regime-cap line means satisfy this with the OTHER side, a tighter conditional trigger, or reduced size — never by ignoring that flag). If a flag genuinely forbids every entry in this direction, say so explicitly in one line and give the conditional entry for the case that resolves it.`;
        const alignedWindow = envAlignment.startsWith('ALIGNED_BULLISH') || envAlignment.startsWith('ALIGNED_BEARISH');
        if (alignedWindow && inTopTier) {
          const wDir = envAlignment.startsWith('ALIGNED_BULLISH') ? 'LONG' : 'SHORT';
          // HIGHER_TF_ONLY = daily+4H agree, 1H opposing/neutral — i.e. an active pullback. That
          // is the entry bar this remedy names, so it is IN the window, not excluded from it.
          const pullbackNote = envAlignment.endsWith('_HIGHER_TF_ONLY') ? ' The 1H is counter to the higher timeframes — that IS the pullback, so anchor the entry to it rather than treating it as a reason to wait.' : '';
          if (mandateOK) {
            L(`  HIGH_CONVICTION_WINDOW: biases aligned ${wDir}, ${mlBoth} — the model's TOP tier (raw >= ${MANDATE_RAW_PCT}) — and NO auto-FLAT reason is active — the system's strongest tradeable state. A concrete ${wDir} setup is MANDATORY: immediate entry if price sits at a valid level, otherwise a CONDITIONAL entry at the nearest validated pullback level or breakout trigger (name the exact price). Outputting NO SETUP or "wait and see" without an Entry/Stop/TP table is NOT an acceptable response in this window — if you judge price extended, that judgment belongs in the CONDITION of the entry, not in declining to provide one.${pullbackNote}${precedence}`);
          } else {
            L(`  HIGH_CONVICTION_WINDOW_SUSPENDED: aligned ${wDir} at ${mlBoth} would mandate a setup, but ${mandateBlocks.join(' + ')} — the inputs that would normally CLOSE this window are missing or a gap event is imminent, so a forced entry would be a blind one. Normal discretion applies; say plainly why you are standing aside rather than implying the tape is quiet.`);
          }
        }
        if (envAlignment === 'MIXED' && inTopTier) {
          // The MIXED window bypasses the stock-SHORT gate, which is scoped to full alignment.
          // Harmless while declining was allowed; load-bearing once a tail forbids NO SETUP — so
          // the MANDATE tail is withheld in those states while the informational window still prints.
          //
          // `chaseUnguarded` is DELIBERATELY KEPT after Part 10 removed the chase auto-FLAT. Part 10
          // tested the chase reading as a bar FILTER and found it noise; it did NOT test it as a
          // suppressor of a mandate that FORBIDS declining. Those are different questions, and the
          // asymmetric cost points the same way it did for `treatment_long_confirm`: leaving a
          // conservative brake on a rule that forces output is cheap, removing it on an untested
          // inference is not. The comment is corrected rather than the behaviour.
          const chaseUnguarded = envChaseLevel === 'HIGH';
          const stockShortUnguarded = !!stockInfo && has(daily.bias, 'Bearish');
          const mixedMandate = mandateOK && !chaseUnguarded && !stockShortUnguarded;
          // The withheld case must carry the SUSPENDED token, not just prose: the system-prompt
          // rules that force a JSON setup and require the position section match on the WINDOW
          // token and carve out "(not SUSPENDED)". A parenthetical "Setup NOT mandated here"
          // left both rules firing, so the model was told a NO SETUP was acceptable AND that the
          // JSON array must carry one — in the chase state the 2026-07-02 symmetry fix blocks.
          const label = mixedMandate ? 'MIXED_HIGH_ML_WINDOW' : 'MIXED_HIGH_ML_WINDOW_SUSPENDED';
          const tail = mixedMandate
            ? ` A concrete structure-led setup is MANDATORY in this window (CONDITIONAL at the nearest valid level if none is IN_PLAY) — do NOT output NO SETUP.${precedence}`
            : ` (Setup NOT mandated here: ${[...mandateBlocks, ...(chaseUnguarded ? ['chase_risk_HIGH'] : []), ...(stockShortUnguarded ? ['stock_short_gate_does_not_apply_in_MIXED'] : [])].join(' + ')} — normal discretion, and a NO SETUP is acceptable if you say why.)`;
          L(`  ${label}: timeframes disagree but ${mlBoth} is in the model's TOP tier (raw >= ${MANDATE_RAW_PCT}) — statistically the BEST big-move cell (non-aligned bars carry ~2x the >=1.5-ATR move rate of aligned trends; measured on 1.37M clean bars). Direction is NOT implied: trade only a structure-led setup (4H reversal or range-edge level with tight invalidation), counter-trend bands apply, cap MODERATE. Do not frame this as trend-following and do not cite "wait for alignment" — by the time TFs align, the move is statistically spent.${tail}`);
        }
        L('  LLM_judgment_required: failure_mode_specific_not_generic, thesis_intact_check');
        L('  → Pick conviction within max_allowed. You may NOT output a tier above max_allowed.');
      }
    }

    // Phase C5 — ML Bucket
    if (daily.mlWinProbability != null) {
      // FIXED 2026-08-25: this banded on the RAW ML_WIN while the Conviction Envelope gates on the
      // LIVE-CALIBRATED one, so a single prompt could say
      //     Conviction Envelope: max_allowed: LOW ... NOT auto-FLAT on ML alone   (calibrated 60%)
      //     ML Bucket: UNFAVORABLE (ML_WIN 44%) — NO TRADE regardless of directional clarity  (raw)
      // — a categorical NO TRADE directly contradicting the gate two lines above it. Observed live
      // on BTCUSDT. Same defect the mandate lines were fixed for on 2026-08-22 ("one prompt
      // printing ML_WIN on two scales with no annotation"); the fix was never propagated here.
      //
      // The TIER stays on the RAW scale deliberately — the mandate reads `rawMlPct >= 70` and the
      // 2026-08-22 fix aligned it to THIS line's "TOP" label precisely so the two stop disagreeing.
      // Banding the tier on the calibrated value would re-split them. What changes is the DIRECTIVE:
      // a quality descriptor must not issue a categorical NO TRADE that overrules the gate, and both
      // numbers are now rendered whenever they differ so no cross-scale comparison can happen
      // silently.
      const mlPct = iTrunc(daily.mlWinProbability * 100), isStock = !!stockInfo;
      const calPct = input.calibratedMlWin != null ? iTrunc(input.calibratedMlWin * 100) : null;
      const shown = calPct != null && calPct !== mlPct
        ? `ML_WIN raw ${mlPct}% (live-calibrated ${calPct}%)` : `ML_WIN ${mlPct}%`;
      let bucket: string;
      if (isStock && mlPct >= 85) bucket = `STOCK_TOP (${shown}) — direction-agnostic move quality, conviction ceiling HIGH, counter-trend qualified: yes, relaxed_confluence: 2_ok`;
      else if (mlPct >= 70) bucket = `TOP (${shown}) — direction-agnostic move quality, conviction ceiling HIGH, counter-trend qualified: yes`;
      else if (mlPct >= 60) bucket = `FAVORABLE (${shown}) — direction-agnostic move quality, conviction ceiling HIGH, counter-trend qualified: no`;
      else if (mlPct >= 50) bucket = `MARGINAL (${shown}) — direction-agnostic move quality, conviction ceiling MODERATE, counter-trend qualified: no`;
      else bucket = `UNFAVORABLE (${shown}) — weakest quality tier on the raw scale`
        + (calPct != null && calPct >= 50
            ? `. NOTE: the live forward calibration corrects this bar to ${calPct}%, and the Conviction Envelope — which gates on the CALIBRATED value — is the authority on whether a trade is allowed. Do NOT read this tier as a veto; read max_allowed.`
            : `. The Conviction Envelope is the authority on whether a trade is allowed — read max_allowed, not this tier.`);
      L(`ML Bucket: ${bucket}`);
    } else {
      // Missing-ML was previously SILENT (every ML section just disappeared, including the
      // ML<50 auto-FLAT) — the LLM had no way to know the quality signal was absent vs good.
      L('ML Bucket: UNAVAILABLE (prediction cache stale) — no quality signal this run; treat as no statistical edge to enter and cap aggressiveness. Say "ML unavailable", never estimate a number.');
    }

    // Live calibration (2026-07-02): the realized goodR rate for the CURRENT prediction's bucket,
    // measured forward on ml_calibration D1 — turns ML_WIN from an assertion into an audited number.
    // n>=20 so a thin bucket can't mislead.
    if (input.mlCalibration && input.mlCalibration.n >= 20) {
      const c = input.mlCalibration;
      L(`ML Calibration (live, audited): bars predicted ${c.bucketLabel} realized a >=1.5-ATR move ${f(c.realizedPct, 0)}% of the time over the last ${c.windowDays}d (n=${c.n}). Weight ML_WIN by this measured rate, not the raw number.`);
    }

    // ML_WIN trajectory (2026-07-02): the sampled path from score_history — a building path means
    // a vol regime forming; a decaying one means the move is already spent. Context the
    // instantaneous number can't carry.
    if (input.mlTrajectory && input.mlTrajectory.points.length >= 3) {
      const pts = input.mlTrajectory.points;
      const deltaPp = (pts[pts.length - 1] - pts[0]) * 100;
      const trend = deltaPp >= 5 ? 'RISING — vol regime building' : deltaPp <= -5 ? 'FALLING — move likelihood decaying' : 'flat';
      L(`ML_WIN ${input.mlTrajectory.hours}h path: ${pts.map(p => Math.round(p * 100)).join('→')}% (${trend}).`);
    }

    // BTC regime context for alts (2026-07-02): alts were analyzed blind to BTC; alt beta
    // amplifies any BTC move regardless of the alt's own chart.
    if (input.btcContext && isCryptoSym && symbol.toUpperCase() !== 'BTCUSDT') {
      const b = input.btcContext;
      const parts: string[] = [];
      if (b.mlWin != null) parts.push(`ML_WIN ${iTrunc(b.mlWin * 100)}%`);
      if (b.bigMoveBucket && b.bigMoveBucket !== 'NORMAL') parts.push(`Big-Move ${b.bigMoveBucket}`);
      if (b.persistence != null) parts.push(`persistence ${iTrunc(b.persistence * 100)}%`);
      if (parts.length) L(`BTC CONTEXT: ${parts.join(', ')} — alt beta amplifies any BTC move; a BTC flush or squeeze drags this symbol regardless of its own chart. Fold BTC's state into the risk read.`);
    }

    // ML Persistence (72h)
    if (daily.mlPersistenceProbability != null) {
      const p72Pct = iTrunc(daily.mlPersistenceProbability * 100);
      // Labels are stated against the TARGET'S OWN BASE RATE, not against 50%. The old ladder called
      // 50-59% "WEAK" — a band that straddles the base rate, so an entirely average bar read as
      // sub-par and biased the model toward shorter holds and tighter trails on the most common
      // reading there is. Same defect class as the crash band: absolute thresholds applied to a
      // probability whose base is not 50%. **The management guidance is unchanged** — only the
      // words describing the number moved; the ladder was tuned for trade management and that
      // tuning was never in question.
      //
      // FIXED 2026-08-25 (second review): the base rate was hardcoded at 54% — the CRYPTO figure —
      // in a block guarded only on `mlPersistenceProbability != null`, and a stock h72t25 model
      // ships. Measured on the v14 regens: P(fwdMaxFavR72H >= 2.5) is **54.1% crypto** but **60.8%
      // stocks**. So on a stock a 60-69% reading printed "ABOVE AVERAGE vs a 54% base" while
      // sitting AT OR BELOW its real base, telling the model to hold longer and trail wider on a
      // sub-par bar — reintroducing on stocks the exact defect this change fixed on crypto.
      const p72Base = stockInfo ? 61 : 54;
      const vs = (band: string) => `${band} (vs a ${p72Base}% base for this market)`;
      const guidance = p72Pct >= p72Base + 16 ? vs('WELL ABOVE AVERAGE') + ' — full 72h hold viable, TP2 at 4-5× ATR(4H), runner targets the upper multiplier, trail 1-1.5× ATR after TP1'
        : p72Pct >= p72Base + 6 ? vs('ABOVE AVERAGE') + ' — TP2 at 3-4× ATR(4H), 48h hold target, take partial 50% at TP1 + trail the runner 1× ATR'
        : p72Pct >= p72Base - 4 ? vs('AVERAGE') + ' — an ORDINARY reading, not a weak one — TP2 at 2-3× ATR(4H) max, 24h hold, take TP1 at +1R-1.5R and trail tightly (0.7× ATR) or exit at BE after TP1'
        : vs('BELOW AVERAGE') + ' — do NOT hold for TP2. Take TP1 fast (+1R-1.5R) or pass the setup if TP1 < 1.5R. Persistence model expects mean-reversion before 2.5 ATR.';
      L(`ML Persistence (72h ≥2.5 ATR): ${p72Pct}% — ${guidance}`);
    }

    // Phase C8 — Active Trade State
    if (activeSetups.length && daily.price > 0) {
      const currentMLWin = daily.mlWinProbability, currentMLPersist = daily.mlPersistenceProbability;
      const currentPrice = daily.price;
      for (const t of activeSetups) {
        const dir = t.direction.toUpperCase(), entry = t.entry, risk = t.risk;
        if (!(entry > 0) || !(risk > 0)) continue;
        const isLong = dir === 'LONG', ageHours = (nowMs - t.entryHitTimeMs) / 3600000;
        const currentPnL = isLong ? currentPrice - entry : entry - currentPrice, currentR = currentPnL / risk;
        const peakR = t.maxFavorable / risk, drawdownR = t.maxAdverse / risk;
        const tp1Distance = Math.abs(t.tp1 - entry);
        const tp1ProgressPct = tp1Distance > 0 ? Math.min(100, Math.max(0, t.maxFavorable / tp1Distance * 100)) : 0;
        const headerParts: string[] = [`${dir} entry ${formatPrice(entry)}`, `${f(ageHours, 0)}h elapsed`, `PnL ${sgn(currentR, 2)}R`];
        if (peakR > currentR + 0.2) headerParts.push(`peak +${f(peakR, 2)}R`);
        if (drawdownR > 0.2) headerParts.push(`drawdown -${f(drawdownR, 2)}R`);
        if (tp1Distance > 0 && t.maxFavorable > 0) headerParts.push(`TP1 ${f(tp1ProgressPct, 0)}% reached`);
        L('Active Trade: ' + headerParts.join(', '));
        if (t.mlProbability != null) {
          if (currentMLWin != null) {
            const delta = (currentMLWin - t.mlProbability) * 100, trend = Math.abs(delta) < 2 ? 'stable' : delta > 0 ? 'rising' : 'declining';
            L(`ML Win at registration: ${f(t.mlProbability * 100, 0)}% | current: ${f(currentMLWin * 100, 0)}% (${sgn(delta, 0)}pp, ${trend})`);
          } else L(`ML Win at registration: ${f(t.mlProbability * 100, 0)}%`);
        }
        if (currentMLPersist != null) L(`ML Persistence current: ${f(currentMLPersist * 100, 0)}%`);
        const milestones: string[] = [];
        if (ageHours >= 24) milestones.push('T+24h crossed');
        if (ageHours >= 48) milestones.push('T+48h crossed');
        if (ageHours >= 72) milestones.push('T+72h crossed');
        if (t.tp1Hit) milestones.push('TP1 hit');
        if (t.partialTaken) milestones.push('partial taken');
        if (t.breakevenActivated) milestones.push('BE-stop active');
        if (milestones.length) L('Milestones: ' + milestones.join(', '));
        let action: string;
        if (currentR <= -0.7) action = `Near stop (${f(currentR, 1)}R). Cut at SL. No average-down, no stop widening.`;
        else if (t.tp1Hit && t.partialTaken) action = 'TP1 partial in pocket. Trail BE-stop on remainder. Re-evaluate at +1.5R or 48h elapsed.';
        else if (currentR >= 0.5) action = `In profit (+${f(currentR, 2)}R). Trail stop to BE if not already. Hold to TP1 unless 4H reverses against direction.`;
        else if (ageHours < 24) action = 'Pre-T+24h hold window. No mandatory action. Cut early only if thesis breaks (kills fire or 4H reverses against direction).';
        else action = `Flat (${sgn(currentR, 2)}R) past T+24h. Re-evaluate as if at entry. Exit at BE if kills fire or 4H structure breaks against thesis.`;
        L('Action: ' + action);
      }
    }

    // Phase 2d — Kills-clearing
    if (oneHOpposes && oneH) {
      const killsClearing: string[] = [];
      if ((prevDurState.divergence ?? 0) > 0) {
        const histSeries = fourH.macdHistSeries.slice(-3);
        if (histSeries.length >= 2) {
          const latest = last(histSeries) ?? 0, prior = histSeries[histSeries.length - 2];
          if (has(daily.bias, 'Bearish') && latest < prior) killsClearing.push('divergence_weakening');
          if (has(daily.bias, 'Bullish') && latest > prior) killsClearing.push('divergence_weakening');
        }
      }
      if (oneH.candles.length >= 6) {
        const recent = oneH.candles.slice(-6);
        const latestVol = last(recent)?.volume ?? 0, avgVol = recent.slice(0, 3).reduce((a, c) => a + c.volume, 0) / 3;
        if (avgVol > 0 && latestVol < avgVol * 0.8) killsClearing.push('volume_normalizing');
      }
      if (killsClearing.length) L(`Kills Clearing: ${killsClearing.join(', ')}`);
    }

    // Phase 2c — Candle close timestamps
    const fourHIntervalMs = 4 * 3600 * 1000;
    const nextFourHClose = (Math.floor(nowMs / fourHIntervalMs) + 1) * fourHIntervalMs;
    let dailyCloseMs: number;
    if (stockInfo) {
      const et = etParts(nowMs);
      const todayClose = etEpoch(et.year, et.month, et.day, 16, 0);
      if (nowMs < todayClose && !isMarketHoliday(nowMs) && et.weekday >= 2 && et.weekday <= 6) {
        dailyCloseMs = todayClose;
      } else {
        let probe = nowMs + 86400000, guard = 0;
        while (guard < 14) {
          const p = etParts(probe);
          if (p.weekday !== 1 && p.weekday !== 7 && !isMarketHoliday(probe)) break;
          probe += 86400000; guard++;
        }
        const p = etParts(probe);
        dailyCloseMs = etEpoch(p.year, p.month, p.day, 16, 0);
      }
    } else {
      const u = new Date(nowMs);
      dailyCloseMs = Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate() + 1, 0, 0, 0);
    }
    L(`Next 4H Close: ${formatET(nextFourHClose)} ET`);
    L(`Next Daily Close: ${formatET(dailyCloseMs)} ET`);
  }

  // RECENT OUTCOME HISTORY
  if (outcomeHistory.length >= 3) {
    L(); L(`=== RECENT OUTCOME HISTORY (${symbol}) ===`);
    const wins = outcomeHistory.filter(o => o.outcome.includes('win')).length;
    const losses = outcomeHistory.filter(o => o.outcome === 'loss').length;
    const total = wins + losses, winRate = total > 0 ? wins / total * 100 : 0;
    const longs = outcomeHistory.filter(o => o.direction === 'LONG'), shorts = outcomeHistory.filter(o => o.direction === 'SHORT');
    const longWins = longs.filter(o => o.outcome.includes('win')).length, shortWins = shorts.filter(o => o.outcome.includes('win')).length;
    L(`Last ${total} resolved: ${wins}W / ${losses}L (${f(winRate, 0)}% win rate)`);
    if (longs.length) L(`  LONG: ${longWins}/${longs.length} won`);
    if (shorts.length) L(`  SHORT: ${shortWins}/${shorts.length} won`);
    L('Recent:');
    for (const o of outcomeHistory.slice(0, 3)) {
      const mlStr = o.mlProb != null ? ` ML:${f(o.mlProb * 100, 0)}%` : '';
      L(`  ${o.direction} ${formatPrice(o.entry)} → ${o.outcome}${mlStr}`);
    }
    L('Use this history to calibrate confidence. Patterns of losses in one direction = require extra evidence.');
  }

  // Sentiment (crypto)
  if (sentiment) {
    const sentParts: string[] = [];
    if (sentiment.priceChangePercentage24h != null) sentParts.push(`24h: ${formatPercent(sentiment.priceChangePercentage24h)}`);
    if (sentiment.priceChangePercentage7d != null) sentParts.push(`7d: ${formatPercent(sentiment.priceChangePercentage7d)}`);
    if (sentiment.priceChangePercentage30d != null) sentParts.push(`30d: ${formatPercent(sentiment.priceChangePercentage30d)}`);
    sentParts.push(`ATH distance: ${formatPercent(sentiment.athChangePercentage)}`);
    L(`Sentiment: ${sentParts.join(', ')}`);
  }

  // Stock fundamentals
  if (stockInfo) {
    const si = stockInfo, parts: string[] = [];
    if (si.peRatio != null) parts.push(`P/E: ${f(si.peRatio, 1)}`);
    if (si.eps != null) parts.push(`EPS: $${f(si.eps, 2)}`);
    if (si.dividendYield != null) parts.push(`Div Yield: ${f(si.dividendYield, 2)}%`);
    parts.push(`52w: ${formatPrice(si.fiftyTwoWeekLow)} – ${formatPrice(si.fiftyTwoWeekHigh)}`);
    if (si.sector) parts.push(`Sector: ${si.sector}`);
    parts.push(`Market: ${si.marketState}`);
    if (si.earningsDate != null) { const days = Math.floor((si.earningsDate - nowMs) / 86400000); if (days > 0) parts.push(`Earnings in ${days}d`); }
    L(`Fundamentals: ${parts.join(' | ')}`);
    const curPrice = indicators[0]?.price ?? 0;
    if (si.analystTargetMean != null && si.analystCount != null) {
      const pctFromTarget = curPrice > 0 ? (si.analystTargetMean - curPrice) / curPrice * 100 : 0;
      let analystLine = `Analysts: ${si.analystCount} covering, Mean Target ${formatPrice(si.analystTargetMean)} (${formatPercent(pctFromTarget)})`;
      if (si.analystRating) analystLine += `, Rating: ${si.analystRating}`;
      L(analystLine);
    }
    if (si.consecutiveBeats != null) { let e = `Earnings: Beat ${si.consecutiveBeats}/4 quarters`; if (si.avgEarningsSurprise != null) e += `, Avg Surprise ${formatPercent(si.avgEarningsSurprise)}`; L(e); }
    if (si.revenueGrowthYoY != null) { let g = `Growth: Revenue ${formatPercent(si.revenueGrowthYoY)} YoY`; if (si.growthTrend) g += ` (${si.growthTrend})`; if (si.earningsGrowthYoY != null) g += ` | EPS ${formatPercent(si.earningsGrowthYoY)} YoY`; L(g); }
    if (si.insiderTransactions && si.insiderTransactions.length) {
      const buys = si.insiderTransactions.filter(t => t.isBuy), sells = si.insiderTransactions.filter(t => !t.isBuy);
      const buyValue = buys.reduce((a, t) => a + t.value, 0), sellValue = sells.reduce((a, t) => a + t.value, 0);
      let il = `Insider Transactions (3mo): ${buys.length} buys ($${compactNumber(buyValue)}) / ${sells.length} sells ($${compactNumber(sellValue)})`;
      il += buys.length > sells.length ? ' — Net buying' : sells.length > buys.length ? ' — Net selling' : '';
      L(il);
      for (const tx of si.insiderTransactions.slice(0, 3)) {
        const action = tx.isBuy ? 'BOUGHT' : 'SOLD';
        const d = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(tx.date));
        L(`  ${tx.name} ${action} ${Math.abs(tx.shares).toLocaleString('en-US')} shares ($${compactNumber(tx.value)}) on ${d}`);
      }
    } else if (si.insiderBuyCount6m != null && si.insiderSellCount6m != null) {
      L(`Insiders (6mo): ${si.insiderBuyCount6m} buys / ${si.insiderSellCount6m} sells — ${si.insiderNetBuying === true ? 'Net buying' : 'Net selling'}`);
    }
    if (si.epsEstimateCurrent != null && si.epsEstimate90dAgo != null && si.epsEstimate90dAgo !== 0) {
      const changePct = (si.epsEstimateCurrent - si.epsEstimate90dAgo) / Math.abs(si.epsEstimate90dAgo) * 100;
      let rl = `Estimate Revisions (90d): EPS est ${formatPrice(si.epsEstimate90dAgo)} → ${formatPrice(si.epsEstimateCurrent)} (${formatPercent(changePct)})`;
      if (si.revisionDirection) rl += ` ${si.revisionDirection}`;
      if (si.upRevisions30d != null && si.downRevisions30d != null) rl += ` | 30d: ${si.upRevisions30d} up, ${si.downRevisions30d} down`;
      L(rl);
    }
    if (si.exDividendDate != null && si.exDividendDate > nowMs) {
      const days = Math.floor((si.exDividendDate - nowMs) / 86400000);
      const d = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(si.exDividendDate));
      let dl = `Ex-Dividend: ${d} (${days}d)`;
      if (si.dividendRate != null) dl += ` $${f(si.dividendRate, 2)}/yr`;
      if (si.exDividendWarning === true) dl += ' ⚠️ WITHIN 5 DAYS';
      L(dl);
    }
    if (si.sectorETF && si.relativeStrength1d != null) L(`Sector: ${si.sector ?? 'N/A'} (${si.sectorETF}) — ${si.outperformingSector === true ? 'Outperforming' : 'Underperforming'} by ${formatPercent(Math.abs(si.relativeStrength1d))}`);
    if (si.finnhubBuy != null && si.finnhubHold != null && si.finnhubSell != null) { const tot = si.finnhubBuy + si.finnhubHold + si.finnhubSell; if (tot > 0) L(`Analyst Consensus: ${si.finnhubBuy} Buy, ${si.finnhubHold} Hold, ${si.finnhubSell} Sell (${tot} analysts)`); }
    if (si.beta != null) L(`Beta: ${f(si.beta, 2)}${si.beta > 1.5 ? ' — HIGH volatility' : si.beta < 0.5 ? ' — LOW volatility' : ''}`);
    if (si.newsHeadlines && si.newsHeadlines.length) {
      L(); L('Recent News (last ~7d, most-recent first — read for narrative + catalysts):');
      for (const item of si.newsHeadlines.slice(0, 8)) L(`  - ${item}`);
      L();
    }
  }

  // Stock sentiment
  if (stockSentiment) {
    const ss = stockSentiment;
    L(); L('=== STOCK SENTIMENT ===');
    if (ss.vix != null) L(`VIX (intraday): ${f(ss.vix, 1)} (${ss.vixLevel})${ss.vixChange != null ? ` ${sgn(ss.vixChange, 1)}%` : ''}`);
    if (ss.shortPercentOfFloat != null) {
      let sl = `Short Interest: ${f(ss.shortPercentOfFloat, 1)}% of float`;
      if (ss.shortRatio != null) sl += `, Days to Cover: ${f(ss.shortRatio, 1)}`;
      if (ss.shortPercentOfFloat > 20) sl += ' — HEAVILY SHORTED, squeeze candidate'; else if (ss.shortPercentOfFloat > 10) sl += ' — elevated';
      L(sl);
    }
    L(`52-Week Position: ${f(ss.fiftyTwoWeekPosition, 0)}% (0%=52w low, 100%=52w high)`);
    if (ss.putCallRatio != null) L(`Put/Call Ratio: ${f(ss.putCallRatio, 2)}${ss.putCallRatio > 1.0 ? ' — bearish sentiment' : ss.putCallRatio < 0.7 ? ' — complacent' : ''}`);
  }

  // Macro
  if (macro) {
    const m = macro;
    L(); L('=== MACRO CONTEXT ===');
    if (m.macroRegime) L(`Macro Regime: ${m.macroRegime}`);
    if (m.vix != null) { const lvl = m.vix > 35 ? 'EXTREME FEAR' : m.vix > 25 ? 'ELEVATED' : m.vix < 15 ? 'LOW/COMPLACENT' : 'NORMAL'; L(`VIX (EOD): ${f(m.vix, 1)} — ${lvl}`); }
    if (m.treasury10Y != null) L(`10Y Treasury Yield: ${f(m.treasury10Y, 2)}%`);
    if (m.treasury2Y != null) L(`2Y Treasury Yield: ${f(m.treasury2Y, 2)}%`);
    if (m.yieldSpread != null) { const st = m.yieldSpread < 0 ? 'INVERTED — recession signal' : m.yieldSpread < 0.5 ? 'Flat — caution' : 'Normal'; L(`2Y/10Y Spread: ${f(m.yieldSpread, 2)}% (${st})`); }
    if (m.fedFundsRate != null) L(`Fed Funds Rate: ${f(m.fedFundsRate, 2)}%`);
    if (m.usdIndex != null) L(`USD Index: ${f(m.usdIndex, 2)}`);
  }

  // Derivatives
  if (derivatives && positioning) {
    const d = derivatives, p = positioning;
    L(); L('=== DERIVATIVES POSITIONING ===');
    const frDelta = d.fundingRatePercent - d.avgFundingRate * 100;
    const frTrend = frDelta > 0.002 ? 'rising' : frDelta < -0.002 ? 'falling' : 'stable';
    L(`Funding Rate: ${f(d.fundingRatePercent, 4)}% (avg last 10: ${f(d.avgFundingRate * 100, 4)}%, ${frTrend}) — ${p.fundingSentiment}`);
    L(`Open Interest: ${formatVolume(d.openInterestUSD)}${d.oiChange4h != null ? ` (4h: ${sgn(d.oiChange4h, 1)}%)` : ''}${d.oiChange24h != null ? ` (24h: ${sgn(d.oiChange24h, 1)}%)` : ''} — ${p.oiTrend}`);
    if (d.globalLongPercent !== 50 || d.globalShortPercent !== 50) L(`Global L/S: Long ${iTrunc(d.globalLongPercent)}% / Short ${iTrunc(d.globalShortPercent)}% — ${p.crowding}`);
    else L('Global L/S: Data unavailable (fallback source)');
    if (d.topTraderLongPercent !== 50 || d.topTraderShortPercent !== 50) L(`Top Traders: Long ${iTrunc(d.topTraderLongPercent)}% / Short ${iTrunc(d.topTraderShortPercent)}% — ${p.smartMoneyBias}`);
    else L('Top Traders: Data unavailable (fallback source)');
    if (d.takerBuySellRatio !== 1.0 || d.takerBuyVolume > 0) L(`Taker Buy/Sell: ${f(d.takerBuySellRatio, 2)} — ${p.takerPressure}`);
    if (p.squeezeRisk.level !== 'NONE') L(`Squeeze Risk: ${p.squeezeRisk.level} ${p.squeezeRisk.direction}`);
    if (p.signals.length) { L('Signals:'); for (const sig of p.signals) L(`- [${sig.strength}] ${sig.message}`); }

    // F-2 — WHALE TRAP detector. Repackages crowding + smart-money divergence + stretched
    // funding + CVD divergence into ONE plain-language verdict that NAMES the trap: when the
    // retail crowd is piled onto one side and the conditions for a flush/squeeze against them are
    // stacking up, entering on the crowd's side means joining the cohort most likely to be
    // liquidated. RISK read, never a direction call. Crypto-only (needs derivatives).
    const retailLong = d.globalLongPercent, retailShort = d.globalShortPercent;
    const crowdLong = p.crowdingCode === 'crowdedLong' || retailLong >= 60;
    const crowdShort = p.crowdingCode === 'crowdedShort' || retailShort >= 60;
    if (crowdLong || crowdShort) {
      const crowdSide = crowdLong ? 'LONG' : 'SHORT';
      const fr = d.fundingRatePercent;
      const haveTop = d.topTraderLongPercent !== 50 || d.topTraderShortPercent !== 50;
      // Smart money leaning AGAINST the retail crowd is the strongest tell.
      const smartAgainst = haveTop && (crowdLong ? d.topTraderShortPercent > d.topTraderLongPercent
                                                  : d.topTraderLongPercent > d.topTraderShortPercent);
      // Funding extreme in the crowd's direction = the crowd is paying to hold a stretched bet.
      // ±0.03 (2026-07-02): 0.01%/8h is the exchange BASELINE — the enrichment's own scale calls
      // >0.01 "Positive (normal)" and reserves "Elevated" for >0.05. At ±0.01 this tell was nearly
      // free whenever the crowd leaned one way, and the "stretched — paying to hold" text
      // contradicted the Funding Rate line printed above it.
      const fundingStretched = crowdLong ? fr > 0.03 : fr < -0.03;
      // CVD diverging against the crowd (distribution under longs / accumulation under shorts).
      const cvdAgainst = spotPressure ? (crowdLong ? spotPressure.cvdTrend === 'Falling'
                                                   : spotPressure.cvdTrend === 'Rising') : false;
      const oiBuilding = (d.oiChange24h ?? 0) > 2 || p.oiTrend === 'Building';
      const tells: string[] = [];
      if (smartAgainst) tells.push(`top traders are leaning ${crowdLong ? 'SHORT' : 'LONG'} — opposite the crowd`);
      if (fundingStretched) tells.push(`funding is ${crowdLong ? 'positive' : 'negative'} & stretched (${f(fr, 3)}% — the crowd is paying to hold)`);
      if (cvdAgainst) tells.push(`spot CVD is ${crowdLong ? 'falling (distribution into the rally)' : 'rising (accumulation into the drop)'}`);
      if (oiBuilding) tells.push('open interest is building (more fuel for a cascade)');
      if (tells.length >= 2) {
        const flush = crowdLong ? 'long flush / liquidation cascade DOWN' : 'short squeeze UP';
        const retailPct = crowdLong ? iTrunc(retailLong) : iTrunc(retailShort);
        L();
        // The two sides are NOT symmetric, measured against 5,357 days of real liquidation data
        // (docs/research/whale-trap-validation.md, BTC/ETH/SOL 2020-2026):
        //
        //   crowded SHORT -> next-day long-liq share 52.9% -> 34.9%. An 18pp swing: shorts really
        //     do become the liquidated side. 25 distinct episodes, bootstrap CI [-24.0, -12.9]pp,
        //     present in every year. Caveat: 29 of 33 firings are BTC, so it is a BTC result with
        //     ETH support and no SOL firings at all.
        //
        //   crowded LONG  -> 52.9% -> 57.7%. Only +4.8pp, and it MISSED the pre-declared +5pp bar.
        //     Worse, it is regime-unstable: strong 2021-23, but INVERTS in 2024 (49.6%, below
        //     baseline). The reason it reads weak is that long liquidations are ~53% of the total
        //     on an ordinary day — crypto simply carries more leveraged longs — so "a long flush
        //     is coming" is barely more informative than the base rate.
        //
        // So the language is differentiated rather than symmetric. Previously both sides claimed
        // conditions were "stacking up", which the data supports for shorts and overstates badly
        // for longs. The tells themselves are KEPT: they beat crowding-alone by 2.8pp (long) and
        // 8.4pp (short), so the machinery earns its place — it is only the wording that was wrong.
        if (crowdLong) {
          L(`WHALE TRAP: ${tells.length >= 3 ? 'HIGH' : 'ELEVATED'} — ${retailPct}% of retail is positioned LONG. Going LONG here means joining the crowded side.`);
          L(`  Calibration: measured on real liquidation data, this state raises the next-day long-liquidation share only modestly (53% -> 58%) and the effect is NOT stable across regimes — do NOT present a cascade as imminent. State the crowding as a POSITIONING fact, not a forecast.`);
        } else {
          L(`WHALE TRAP: ${tells.length >= 3 ? 'HIGH' : 'ELEVATED'} — ${retailPct}% of retail is positioned SHORT and the conditions for a ${flush} are stacking up.`);
          L(`  Calibration: this is the well-supported side — measured on real liquidation data, this state flips the next-day liquidation balance decisively onto SHORTS (long share 53% -> 35%). Surface it prominently. (Measured mostly on BTC; treat alts as plausible-but-untested.)`);
        }
        L(`  Tells: ${tells.join('; ')}.`);
        L(`  Read for the user: going ${crowdSide} here means JOINING the crowd that is most exposed to a flush — the setup where the majority gets hurt. It is a RISK flag, not a direction call (the squeeze can be slow or never come), but if the user is about to enter ${crowdSide}, they should know they'd be on the crowded, vulnerable side. Surface this in the Risk Map and name the cascade direction (${flush}).`);
      }
    }
  }

  // Observed forced-liquidation flow (from the box's forceOrder websocket archive). This is
  // OBSERVED forced selling/buying - it upgrades the inferred crowding reads (whale trap,
  // squeeze risk) with what actually fired. Sampled feed: lower bounds, not exact totals.
  if (isCryptoSym && input.liquidations) {
    const lq = input.liquidations;
    const fUsd = (v: number) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${Math.round(v / 1000)}k`;
    const h1Total = lq.h1LongUsd + lq.h1ShortUsd;
    const skew = h1Total > 0 ? (lq.h1LongUsd > lq.h1ShortUsd ? 'longs' : 'shorts') : null;
    L();
    L(`LIQUIDATIONS (observed, Binance futures - sampled feed, treat as lower bounds): last 1h ${fUsd(lq.h1LongUsd)} longs / ${fUsd(lq.h1ShortUsd)} shorts force-closed; 24h ${fUsd(lq.h24LongUsd)} / ${fUsd(lq.h24ShortUsd)}.`);
    if (skew && h1Total >= 500_000) {
      L(`  Interpretation: heavy one-sided ${skew === 'longs' ? 'LONG liquidations = forced SELLING already hit the tape (cascade risk if support breaks; exhaustion/capitulation if it holds)' : 'SHORT liquidations = forced BUYING already hit the tape (squeeze fuel burning off)'}. Recent-flow context, NOT a direction signal.`);
    }
  }

  // Spot pressure
  if (spotPressure) {
    const sp = spotPressure;
    L(); L('=== SPOT PRESSURE ===');
    L(`Taker Buy Ratio (24h): ${f(sp.takerBuyRatio, 2)} (${sp.takerBuyLabel})`);
    L(`CVD 24h: ${f(sp.cvd24h, 1)} (${sp.cvdTrend})`);
    if (sp.bookRatio != null && sp.bookLabel) L(`Order Book: ${f(sp.bookRatio, 2)} (${sp.bookLabel})`);
  }

  // Policy / macro catalyst headlines (2026-08-22). Context, NOT a signal — see src/news.ts.
  // Placed before the economic calendar because the calendar covers SCHEDULED releases while
  // these are the unscheduled catalysts (a regulator ruling, a Treasury action, legislation)
  // that repriced the tape without ever appearing on a calendar.
  if (input.news?.headlines?.length) {
    L(); L('=== POLICY / MACRO HEADLINES (context, not a trade signal) ===');
    for (const h of input.news.headlines) L(`  ${h}`);
    L('  Interpretation: use these ONLY to explain WHY the tape is behaving as it is and to size event risk.');
    L('  They are NOT direction: headlines are priced in seconds by machines, long before this analysis runs,');
    L('  and no headline here has been shown to predict the next move. Never raise conviction on a headline alone,');
    L('  and never contradict the pre-computed flags because of one.');
  }

  // Economic events
  const releasedEvents = economicEvents.filter(e => e.isRecentlyReleased);
  const upcomingEvents = economicEvents.filter(e => e.isUpcoming);
  if (releasedEvents.length) {
    L(); L('=== RECENTLY RELEASED ECONOMIC DATA ===');
    for (const e of releasedEvents.slice(0, 12)) {
      let line = `✅ ${e.title} (${e.country}) — Released ${formatET(e.date)} ET`;
      if (e.actual) { line += ` | Actual: ${e.actual}`; if (e.forecast) line += ` vs Exp: ${e.forecast}`; if (e.surprise) line += ` [${e.surprise}]`; }
      else { line += ' | Actual: pending'; if (e.forecast) line += ` | Exp: ${e.forecast}`; }
      if (e.previous) line += ` | Prev: ${e.previous}`;
      L(line);
    }
    L('NOTE: These events ALREADY HAPPENED. Discuss their IMPACT on current price action, not as upcoming risk.');
  }
  if (upcomingEvents.length) {
    L(); L('=== UPCOMING ECONOMIC EVENTS ===');
    for (const e of upcomingEvents.slice(0, 12)) {
      let line = `${e.title} (${e.country}) — ${formatET(e.date)} ET`;
      if (e.forecast) line += ` | Exp: ${e.forecast}`;
      if (e.previous) line += ` | Prev: ${e.previous}`;
      const hoursAway = (e.date - nowMs) / 3600000;
      if (hoursAway < 12) line += ` ⚠️ IN ${iTrunc(hoursAway)}H`; else if (hoursAway < 48) line += ' ⚠️ WITHIN 48H';
      L(line);
    }
  }

  // ATR percentile + momentum alignment
  if (indicators.length) {
    const daily = indicators[0];
    if (daily.atrPercentile != null && daily.atrPercentileLabel) L(`ATR Percentile: ${iTrunc(daily.atrPercentile)}% (${daily.atrPercentileLabel})`);
  }
  if (indicators.length) {
    const al = momentumAlignment(indicators);
    L(`Momentum Alignment: ${al.score > 0 ? '+' : ''}${al.score}/9 (${al.label})`);
  }

  // PRICE ACTION SUMMARY
  if (indicators.length) {
    const summaries = indicators.map(i => priceActionAnalyze(i));
    if (summaries.some(s => s.summaryText !== '' && s.regime !== 'insufficient_data')) {
      L(); L('=== PRICE ACTION SUMMARY ===');
      for (const s of summaries) if (s.regime !== 'insufficient_data') { L(s.summaryText); L(); }
    }
  }

  // Weekly context
  if (weeklyContext) { L(); L('=== WEEKLY CONTEXT ==='); L(weeklyContext); }
  else if (indicators[0] && indicators[0].candles.length >= 5) {
    const wk = indicators[0].candles.slice(-5);
    const weekOpen = wk[0]?.open ?? 0, weekClose = last(wk)?.close ?? 0;
    const weekHigh = Math.max(...wk.map(c => c.high)), weekLow = Math.min(...wk.map(c => c.low));
    const weekChange = weekOpen > 0 ? (weekClose - weekOpen) / weekOpen * 100 : 0;
    const weekTrend = weekChange > 1 ? 'Bullish' : weekChange < -1 ? 'Bearish' : 'Neutral';
    L(); L('=== WEEKLY CONTEXT (estimated from daily) ===');
    L(`Trend: ${weekTrend} (${sgn(weekChange, 1)}%), Range: ${formatPrice(weekLow)} – ${formatPrice(weekHigh)}`);
  }

  if (spyContext) { L(); L('=== BROAD MARKET (SPY) ==='); L(spyContext); }

  // Phase 3+4 — Tagged levels + R:R + candidate setups
  const currentPrice = (indicators.length ? (last(indicators)!.price || indicators[0].price) : 0);
  const atrForRR = indicators.length > 2 ? indicators[2].atr?.atr : indicators[1]?.atr?.atr;
  if (currentPrice && atrForRR != null) {
    const atr = atrForRR;
    // ONE price anchor for all level geometry: the LIVE price when available (the closed-bar
    // `currentPrice` can be up to 4h stale intra-bar, and the LIVE PRICE section declares live
    // authoritative). Every proximity/atrDistance below — tagged-level display AND the candidate-
    // setup entry filter — measures from this same anchor.
    const refPx = (lp != null && lp > 0) ? lp : currentPrice;
    const allLevels: TaggedLevel[] = [];
    const prox = (dist: number) => dist <= 1.0 ? 'IN_PLAY' : dist <= 2.0 ? 'NEARBY' : 'DISTANT';
    for (const ind of indicators) {
      const prefix = ind.label, srStrength = prefix.includes('Daily') ? 2.5 : prefix.includes('4H') ? 2.0 : 1.5;
      for (const s of ind.supportResistance.supports) { const dist = Math.abs(refPx - s) / Math.max(atr, 0.0001); allLevels.push({ price: s, type: `${prefix} support`, proximity: prox(dist), atrDistance: dist, strength: srStrength, freshness: 1.0, candlesAgo: 0, isStructural: false }); }
      for (const r of ind.supportResistance.resistances) { const dist = Math.abs(refPx - r) / Math.max(atr, 0.0001); allLevels.push({ price: r, type: `${prefix} resistance`, proximity: prox(dist), atrDistance: dist, strength: srStrength, freshness: 1.0, candlesAgo: 0, isStructural: false }); }
      if (ind.vwap != null) { const dist = Math.abs(refPx - ind.vwap) / Math.max(atr, 0.0001); allLevels.push({ price: ind.vwap, type: `${prefix} VWAP`, proximity: prox(dist), atrDistance: dist, strength: 2.0, freshness: 0.5, candlesAgo: 0, isStructural: false }); }
      if (ind.volumeProfile) {
        for (const [label, price] of [['POC', ind.volumeProfile.poc], ['VAH', ind.volumeProfile.vah], ['VAL', ind.volumeProfile.val]] as Array<[string, number]>) {
          const dist = Math.abs(refPx - price) / Math.max(atr, 0.0001);
          allLevels.push({ price, type: `${prefix} ${label}`, proximity: prox(dist), atrDistance: dist, strength: label === 'POC' ? 3.5 : 3.0, freshness: 1.0, candlesAgo: 0, isStructural: false });
        }
      }
    }
    for (const ind of indicators) {
      if (ind.marketStructure) {
        const tfWeight = ind.label.includes('Daily') ? 1.5 : ind.label.includes('4H') ? 1.0 : 0.5;
        for (const level of ind.marketStructure.levelTests) {
          const dist = Math.abs(refPx - level.price) / Math.max(atr, 0.0001);
          const freshnessText = level.candlesAgo <= 3 ? 'fresh' : level.candlesAgo <= 10 ? 'recent' : 'old';
          const levelStrength = Math.min(Math.min(level.tests, 5) * tfWeight, 5.0);
          const levelFreshness = level.candlesAgo <= 3 ? 1.0 : level.candlesAgo <= 10 ? 0.5 : 0.0;
          allLevels.push({ price: level.price, type: `${ind.label} structure (${level.tests}× tested, ${freshnessText})`, proximity: prox(dist), atrDistance: dist, strength: levelStrength, freshness: levelFreshness, candlesAgo: level.candlesAgo, isStructural: true });
        }
      }
    }
    // Confluence clustering
    const sortedLevels = [...allLevels].sort((a, b) => a.price - b.price);
    const used = new Set<number>();
    const clustered: TaggedLevel[] = [];
    for (let i = 0; i < sortedLevels.length; i++) {
      if (used.has(i)) continue;
      const clusterIndices = [i];
      for (let j = i + 1; j < sortedLevels.length; j++) {
        if (used.has(j)) continue;
        if (Math.abs(sortedLevels[j].price - sortedLevels[i].price) / Math.max(atr, 0.0001) <= 0.3) clusterIndices.push(j);
        else break;
      }
      clusterIndices.forEach(k => used.add(k));
      const members = clusterIndices.map(k => sortedLevels[k]);
      const anchor = members.reduce((a, b) => (b.strength > a.strength ? b : a));
      const totalStrength = Math.min(members.reduce((a, m) => a + m.strength, 0), 5.0);
      const bestFreshness = Math.max(...members.map(m => m.freshness));
      const minCandlesAgo = Math.min(...members.map(m => m.candlesAgo));
      const anyStructural = members.some(m => m.isStructural);
      const typeStr = members.length === 1 ? anchor.type : members.map(m => m.type).join(' + ');
      // Distance/proximity anchored to the LIVE price (refPx), not the closed bar: the LIVE PRICE
      // section declares live authoritative, and this atrDistance/proximity feeds BOTH the TAGGED
      // LEVELS display AND the CANDIDATE SETUPS entry filter below — one anchor, one geometry.
      // (Previously the display re-anchored to live while the setups kept closed-bar proximity,
      // so a single prompt carried two contradictory distances for the same level.)
      const dist = Math.abs(refPx - anchor.price) / Math.max(atr, 0.0001);
      clustered.push({ price: anchor.price, type: typeStr, proximity: prox(dist), atrDistance: dist, strength: totalStrength, freshness: bestFreshness, candlesAgo: minCandlesAgo, isStructural: anyStructural });
    }
    const uniqueLevels = clustered;
    if (uniqueLevels.length) {
      // Each level is tagged ABOVE / BELOW live and the list is ordered high→low so the model
      // reads the geometry correctly and never mislabels a one-sided cluster as a "squeeze":
      // the previous bare list let it call two below-price supports "squeezed between", which is
      // geometrically wrong.
      L(); L('=== TAGGED LEVELS ===');
      L(`(ABOVE / BELOW is each level's side of the LIVE price ${formatPrice(refPx)} — resistance sits ABOVE, support BELOW. `
        + `Only call price "between"/"squeezed"/"pinned"/"caught" when at least one ABOVE level AND one BELOW level bracket it. `
        + `A cluster entirely on one side means price is sitting ABOVE it or BELOW it — not squeezed. Name the actual bracketing levels, not just any two.)`);
      L(`(Distances here are in 1H ATR. The SHALLOW PULLBACK BAND above is in 4H ATR — a different, `
        + `larger unit. NEVER convert between them: to judge whether a level is a valid entry, compare `
        + `its PRICE against the band's PRICES, never its "x 1H-ATR" figure against the band's 0.2-0.5.)`);
      // Cap by NEAREST-to-live (the actionable levels), then display high→low. Slicing the
      // high→low sort kept the 15 highest prices and silently dropped the nearest below-live
      // supports — exactly the levels the bracketing directive above depends on.
      const nearest = [...uniqueLevels].sort((a, b) => a.atrDistance - b.atrDistance).slice(0, 15);
      const sortedForDisplay = nearest.sort((a, b) => b.price - a.price);   // high → low
      for (const level of sortedForDisplay) {
        const side = level.price >= refPx ? 'ABOVE live' : 'BELOW live';
        // "1H ATR" is spelled out because this prompt carries THREE quantities called ATR — daily,
        // 4H and 1H — differing by ~2x at any moment ($2,248 / $1,282 / $669 on 2026-08-25). This
        // section and the CANDIDATE SETUPS geometry use the 1H ATR (`atrForRR`), while the SHALLOW
        // PULLBACK BAND uses the 4H ATR, because that is the unit the Parts 4-5 entry measurement
        // was made in (`atrPercent`, which is 4H). Both are correct for their purpose and the
        // collision is only in the NAME — but an unlabelled "0.5x ATR" invites converting a level
        // into the band's units and getting a number ~1.9x wrong. It fooled me on 2026-08-25 into
        // reporting a compliant 0.50-ATR entry as a 0.99-ATR violation; the model can make the same
        // mistake, and unlike me it will not check.
        L(`${formatPrice(level.price)} [${side}] (${level.type}) [${level.proximity}, ${f(level.atrDistance, 1)}x 1H-ATR from live, str=${f(level.strength, 1)}]`);
      }
    }

    if (indicators.length >= 2) {
      const daily = indicators[0];
      const dailyBearish4 = has(daily.bias, 'Bearish'), dailyBullish4 = has(daily.bias, 'Bullish');
      const fourHBearish4 = has(indicators[1].bias, 'Bearish'), fourHBullish4 = has(indicators[1].bias, 'Bullish');
      const aligned4 = (dailyBearish4 && fourHBearish4) || (dailyBullish4 && fourHBullish4);
      const direction4 = dailyBearish4 ? 'SHORT' : dailyBullish4 ? 'LONG' : '';
      const isCounterTrend = !aligned4 && direction4 !== '';
      const adxDaily4 = daily.adx?.adx ?? 0;
      let maAlignment4 = 'tangled';
      if (daily.ema20 != null && daily.ema50 != null && daily.ema200 != null) {
        if (daily.ema20 > daily.ema50 && daily.ema50 > daily.ema200) maAlignment4 = 'bullish_stacked';
        else if (daily.ema20 < daily.ema50 && daily.ema50 < daily.ema200) maAlignment4 = 'bearish_stacked';
      }
      const bbSqueezeAny4 = indicators.some(i => i.bollingerBands?.squeeze === true);
      const regime = adxDaily4 > 25 && maAlignment4 !== 'tangled' ? 'TRENDING' : bbSqueezeAny4 || (adxDaily4 >= 20 && adxDaily4 <= 25) ? 'TRANSITIONING' : adxDaily4 < 20 ? 'RANGING' : 'TRANSITIONING';

      if (direction4 !== '') {
        const effectiveDirection = direction4;
        const entryLevels = uniqueLevels.filter(l => l.proximity === 'IN_PLAY');
        const candidates: string[] = [];
        const h1Structure = indicators.length > 2 ? indicators[2].marketStructure : null;
        const h4Structure = indicators.length > 1 ? indicators[1].marketStructure : null;
        for (const entry of entryLevels) {
          let stop: number;
          if (effectiveDirection === 'SHORT') {
            const sh = h1Structure?.swingHighs[0] ?? h4Structure?.swingHighs[0];
            if (sh != null) stop = sh + atr * 0.3;
            else { const above = uniqueLevels.filter(l => l.price > entry.price).sort((a, b) => a.price - b.price); stop = (above[0]?.price ?? entry.price) + atr * 0.5; }
          } else {
            const slw = h1Structure?.swingLows[0] ?? h4Structure?.swingLows[0];
            if (slw != null) stop = slw - atr * 0.3;
            else { const below = uniqueLevels.filter(l => l.price < entry.price).sort((a, b) => b.price - a.price); stop = (below[0]?.price ?? entry.price) - atr * 0.5; }
          }
          let adjustedStop = stop;
          // MINIMUM STOP DISTANCE, direction-dependent since 2026-08-26.
          //
          // LONG uses 4 ATR, SHORT stays at 2. Pre-declared in docs/research/stop-width.md and tested
          // with reward:risk HELD FIXED at 1.25, so only the stop width varies — widening the stop
          // widens the target with it, which is what was measured. Changing the ratio would be a
          // different and untested intervention.
          //
          //   LONG net R by stop floor:  -0.0342 (2 ATR)  ->  -0.0109 (3)  ->  +0.0020 (4)
          //   4-vs-2 ATR: +0.0362R, 95% CI [+0.0245, +0.0484], 10 of 10 half-year periods positive
          //   spanning the 2022 bear and the 2023-24 bull, on 55,752 bars / ~3,097 effective.
          //   The GROSS series climbs too (-0.0048 -> +0.0168), so it is not fee dilution — about
          //   59% of the gain is the stop and 41% is paying proportionally less fee.
          //   SHORT measured FLAT across the whole sweep, so it is deliberately unchanged.
          //
          // Mechanism: a 2 ATR stop is inside the noise. On high-ML bullish bars the measured
          // outcome was P(2 ATR stop hit) 26.9% against P(2.5 ATR target hit) 14.4% — the trade was
          // being stopped before it had room, which is why longs lost regardless of ML.
          //
          // NOT an edge: this takes longs from reliably losing to roughly break-even (~+$20/trade at
          // a $28k account risking 2%). It closes a leak.
          //
          // 1R IS DEFINED BY THE STOP, so a wider floor means a proportionally SMALLER position for
          // the same dollar risk. `suggestedQty` below is `riskDollars / risk` and adjusts by
          // construction — but anyone sizing by NOTIONAL will not, and at 4 ATR the same contract
          // count carries roughly twice the risk.
          const minStopMultiple = effectiveDirection === 'SHORT' ? 2.0 : 4.0;
          const minStopDist = atr * minStopMultiple;
          if (Math.abs(entry.price - adjustedStop) < minStopDist) adjustedStop = effectiveDirection === 'SHORT' ? entry.price + minStopDist : entry.price - minStopDist;
          const risk = Math.abs(entry.price - adjustedStop);
          if (!(risk > 0)) continue;
          const acctSize = settings.accountSize ?? 0, riskPct = settings.riskPercent ?? 0;
          const riskDollars = acctSize > 0 && riskPct > 0 ? acctSize * riskPct / 100.0 : 500.0;
          const suggestedQty = riskDollars / risk;
          const qtyStr = suggestedQty >= 1 ? f(suggestedQty, 0) : f(suggestedQty, 4);
          const isWideBand = useTighterBands(symbol), isCrypto = isCryptoSym;
          // TARGETS SCALE WITH THE STOP, because that is the structure that was tested.
          //
          // `stop-width.md:44`: "The reward:risk ratio is NOT changed — widening the stop widens the
          // target with it, which is what was tested." The stop floor shipped on 2026-08-26; this
          // half did not. Every ATR-distance band and fallback below was tuned when the floor was
          // 2 ATR, and they are ABSOLUTE distances — so raising the LONG floor to 4 ATR halved every
          // reward:risk instead of holding it, which is the opposite of the tested intervention.
          //
          // The consequence was total, not marginal. `viable` needs TP1 R:R >= 0.5, and every TP1
          // band caps distance at 2.0 ATR, so TP1 R:R <= 2/stopAtr. At a 4 ATR floor that is <= 0.5
          // exactly — reachable only at a measure-zero point. Measured on the real BTC tape: 0 of 3
          // LONG candidates viable, 1 of 3 SHORT. And `prompt-system.json` says "Emit a setup ONLY
          // if a Viable risk-defined level exists", so ordinary LONG setups could not be emitted at
          // all. Fourth instance of this project's recurring defect — a threshold compared against a
          // quantity whose attainable RANGE was never re-checked after something moved.
          //
          // The scale is a UNITS fix, not a re-tune: it is exactly 1.0 at a 2 ATR stop, so every
          // band keeps the value it was tuned with, stocks (1.5 ATR floor) are untouched via the
          // clamp, and the ATR fallback's reward:risk becomes invariant at the 0.75 it always had.
          // Keyed on the FLOOR that changed, not on the realised stop.
          //
          // Keying it on `risk` re-tuned bars the 2026-08-26 floor change never touched: a 5.4 ATR
          // structural stop on the real BTC tape pushed the TP2 fallback to 8.1 ATR and an 8 ATR
          // stop to 12 ATR, targets `excursion-model.md` measures as unreachable inside a 72h
          // horizon. It also fired on SHORT, which the stop-width test says is deliberately
          // unchanged. The floor is the quantity that moved, so it is the quantity that scales.
          //
          // A genuinely wide STRUCTURAL stop with nearby levels does have poor reward:risk, and
          // `viable` reporting false there is the correct answer, not a defect to engineer around.
          const stopScale = Math.max(1, minStopMultiple / 2.0);
          const sc = (b: [number, number]): [number, number] => [b[0] * stopScale, b[1] * stopScale];
          let tp1RRBand: [number, number], tp1ATRBand: [number, number], idealTP1RR: number;
          if (isCounterTrend) { tp1RRBand = [0.8, 1.5]; tp1ATRBand = sc([0.5, 2.0]); idealTP1RR = 1.0; }
          else if (isWideBand) { tp1RRBand = [0.5, 1.0]; tp1ATRBand = sc([1.0, 2.0]); idealTP1RR = 0.75; }
          else { tp1RRBand = [1.0, 1.7]; tp1ATRBand = sc([0.8, 2.0]); idealTP1RR = 1.3; }
          let tp2RRBand: [number, number], tp2ATRBand: [number, number], idealTP2RR: number;
          if (isCounterTrend) { tp2RRBand = [1.3, 2.5]; tp2ATRBand = sc([1.0, 3.5]); idealTP2RR = 1.8; }
          else if (isWideBand) {
            if (isCrypto) { tp2RRBand = [0.75, 1.75]; tp2ATRBand = sc([2.0, 3.5]); idealTP2RR = 1.5; }
            else { tp2RRBand = [0.75, 1.5]; tp2ATRBand = sc([2.0, 3.0]); idealTP2RR = 1.25; }
          } else { tp2RRBand = [1.3, 4.0]; tp2ATRBand = sc([1.5, 5.0]); idealTP2RR = 2.5; }
          const directionalLevels = effectiveDirection === 'SHORT' ? uniqueLevels.filter(l => l.price < entry.price) : uniqueLevels.filter(l => l.price > entry.price);
          const tp1Score = (level: TaggedLevel): number | null => {
            const reward = Math.abs(level.price - entry.price), rr = reward / risk, atrDist = reward / Math.max(atr, 0.0001);
            if (!(rr >= tp1RRBand[0] && rr <= tp1RRBand[1] && atrDist >= tp1ATRBand[0] && atrDist <= tp1ATRBand[1])) return null;
            const rrFit = Math.max(0, 1.0 - Math.abs(rr - idealTP1RR) / idealTP1RR);
            const clearance = computeClearance(entry.price, level.price, uniqueLevels);
            return 1.5 * level.strength + 1.0 * rrFit + 1.0 * clearance + 0.5 * level.freshness;
          };
          let tp1: TaggedLevel | null = null, tp1Best = -Infinity;
          for (const l of directionalLevels) { const sc = tp1Score(l); if (sc != null && sc > tp1Best) { tp1Best = sc; tp1 = l; } }
          const tp1RR = tp1 ? Math.abs(tp1.price - entry.price) / risk : 0;
          const tp2MinRR = Math.max(tp2RRBand[0], tp1RR + 0.3);
          const tp2Score = (level: TaggedLevel): number | null => {
            const reward = Math.abs(level.price - entry.price), rr = reward / risk, atrDist = reward / Math.max(atr, 0.0001);
            if (!(rr >= tp2MinRR && rr <= tp2RRBand[1] && atrDist >= tp2ATRBand[0] && atrDist <= tp2ATRBand[1])) return null;
            if (Math.abs(level.price - (tp1?.price ?? entry.price)) / Math.max(atr, 0.0001) < 0.5) return null;
            if (tp1) { if (effectiveDirection === 'SHORT' ? !(level.price < tp1.price) : !(level.price > tp1.price)) return null; }
            const rrFit = Math.max(0, 1.0 - Math.abs(rr - idealTP2RR) / idealTP2RR);
            const clearance = computeClearance(tp1?.price ?? entry.price, level.price, uniqueLevels);
            return 1.5 * level.strength + 1.0 * rrFit + 1.0 * clearance + 0.5 * level.freshness;
          };
          let tp2: TaggedLevel | null = null, tp2Best = -Infinity;
          for (const l of directionalLevels) { const sc = tp2Score(l); if (sc != null && sc > tp2Best) { tp2Best = sc; tp2 = l; } }
          // Placed in R, not in ATR.
          //
          // The ATR-multiple fallbacks could not satisfy their own R:R bands. Non-wideBand puts TP1
          // at 1.2 ATR and then demands `finalTP1RR >= 1.0`, which needs 1.2 ATR >= the whole stop —
          // false at the 4 ATR floor (R:R 0.60) and false at the OLD 2 ATR floor too (also 0.60).
          // So for the 18 `trendingSymbols` every candidate has always fallen back to a target that
          // fails viability, and `prompt-system.json` says "Emit a setup ONLY if a Viable
          // risk-defined level exists". The 2026-08-27 scaling fix repaired only the wideBand path,
          // where the numbers happened to coincide, and its test used BTCUSDT so it never saw this.
          //
          // Anchoring the fallback at the band's own ideal R:R makes it satisfy the band and the
          // viability bar at ANY stop width, with no scale factor involved. At the geometry these
          // bands were tuned on it lands where the ATR multiple already did (wideBand crypto: 0.75R
          // and 1.5R = 3 ATR and 6 ATR against a 4 ATR stop), so it is a re-expression of the
          // intent rather than a re-tune.
          const rFallback = (rr: number, label: string): { price: number; type: string } => {
            const dist = rr * risk;
            const fp = effectiveDirection === 'SHORT' ? entry.price - dist : entry.price + dist;
            let nearest: TaggedLevel | null = null, nd = Infinity;
            for (const l of uniqueLevels) { const dd = Math.abs(l.price - fp); if (dd < nd) { nd = dd; nearest = l; } }
            if (nearest && Math.abs(nearest.price - fp) / Math.max(atr, 0.0001) <= 0.5) return { price: nearest.price, type: `ATR target (${label}) → ${nearest.type}` };
            return { price: fp, type: `ATR target (${label})` };
          };
          let finalTP1Price: number, finalTP1Type: string;
          if (tp1) { finalTP1Price = tp1.price; finalTP1Type = tp1.type; }
          else { const fb = rFallback(idealTP1RR, `${f(idealTP1RR, 2)}R`); finalTP1Price = fb.price; finalTP1Type = fb.type; }
          let finalTP2Price: number, finalTP2Type: string;
          if (tp2) { finalTP2Price = tp2.price; finalTP2Type = tp2.type; }
          else {
            // Kept strictly above TP1's R so the two can never collapse onto each other.
            const tp2R = Math.max(idealTP2RR, tp2MinRR);
            const fb = rFallback(tp2R, `${f(tp2R, 2)}R`); finalTP2Price = fb.price; finalTP2Type = fb.type;
          }
          const finalTP1RR = Math.abs(finalTP1Price - entry.price) / risk, finalTP2RR = Math.abs(finalTP2Price - entry.price) / risk;
          const targetLines = [`${formatPrice(finalTP1Price)} (${finalTP1Type}) R:R=${f(finalTP1RR, 2)}`, `${formatPrice(finalTP2Price)} (${finalTP2Type}) R:R=${f(finalTP2RR, 2)}`];
          const viable = finalTP1RR >= (isCounterTrend ? 0.8 : isWideBand ? 0.5 : 1.0);
          const setupLabel = isCounterTrend ? 'COUNTER-TREND' : 'TREND';
          const confirmation = isCounterTrend ? 'WICK_REJECTION_CLOSE_BACK_ACROSS_LEVEL' : regime === 'TRENDING' ? 'VOLUME_1.2X_OR_SECOND_TEST' : 'NONE';
          // Stop quality (2026-07-02): risk-engine's reflection-principle noise-hit probability —
          // P(pure noise alone wicks this stop within 24h) at the HAR-RV σ. Built + tested since
          // Phase 3 but never wired to the analysis path; aimed at the wicked-stop retail loss.
          let stopQ = '';
          const sigma24 = input.volForecast?.horizons?.['24h']?.sigma;
          if (sigma24 && sigma24 > 0) {
            const q = stopQuality(entry.price, adjustedStop, sigma24);
            if (Number.isFinite(q.noiseHit)) {
              stopQ = ` | Stop noise-hit ~${Math.round(q.noiseHit * 100)}% (${q.rating}${q.rating === 'TIGHT' ? ' — noise alone likely wicks this stop; widen it or skip' : ''})`;
            }
          }
          candidates.push(`[${setupLabel}] Entry ${formatPrice(entry.price)} (${entry.type}) | Stop ${formatPrice(adjustedStop)} | Risk ${formatPrice(risk)} (${qtyStr} units @ ${formatPrice(riskDollars)} risk) | TP1: ${targetLines[0]} | TP2: ${targetLines[1]} | Confirmation: ${confirmation}${stopQ} | Viable: ${viable}`);
        }
        if (candidates.length) { L(); L('=== CANDIDATE SETUPS (pre-computed R:R — do not recalculate) ==='); for (const c of candidates) L(c); }
      }
    }
  }

  L();

  // Per-timeframe indicator dumps
  for (const ind of indicators) {
    L(`=== ${ind.label} ===`);
    let biasLine = `Price: ${formatPrice(ind.price)}`;
    if (ind.mlWinProbability != null) biasLine += ` | ML_WIN: ${iTrunc(ind.mlWinProbability * 100)}%`;
    if (ind.volScalar != null) biasLine += ` [vol_scalar: ${f(ind.volScalar, 2)}]`;
    L(biasLine);
    if (ind.marketStructure) {
      const ms = ind.marketStructure;
      let msLine = `Structure: ${ms.label}`;
      if (ms.swingHighs.length) msLine += ` | Highs: ${ms.swingHighs.slice(0, 3).map(formatPrice).join(' > ')}`;
      if (ms.swingLows.length) msLine += ` | Lows: ${ms.swingLows.slice(0, 3).map(formatPrice).join(' > ')}`;
      L(msLine);
      for (const level of ms.levelTests.slice(0, 3)) {
        const freshness = level.candlesAgo <= 3 ? 'fresh' : level.candlesAgo <= 10 ? 'recent' : 'old';
        L(`  ${formatPrice(level.price)} (tested ${level.tests}×, ${freshness} — ${level.candlesAgo} candles ago)`);
      }
    }
    if (ind.rsi != null) {
      let rsiStr = `RSI: ${ind.rsi}`;
      if (ind.stochRSI) { rsiStr += ` | Stoch RSI: ${ind.stochRSI.k}/${ind.stochRSI.d}`; rsiStr += ind.stochRSI.crossover ? ` (${ind.stochRSI.crossover} crossover)` : ' (no crossover)'; }
      L(rsiStr);
    }
    if (ind.macd) {
      const macdLine = last(ind.macdLineSeries), macdSignal = last(ind.macdSignalSeries);
      const crossLabel = ind.macd.crossover ? ` Crossover: ${ind.macd.crossover}` : ' (no crossover)';
      L(`MACD: ${macdLine ?? 0} Signal: ${macdSignal ?? 0} Hist: ${ind.macd.histogram}${crossLabel}`);
    }
    if (ind.adx) {
      if (ind.adx.adx < 20) L(`ADX: ${ind.adx.adx} (No Trend — direction unreliable) +DI: ${ind.adx.plusDI} -DI: ${ind.adx.minusDI}`);
      else L(`ADX: ${ind.adx.adx} (${ind.adx.strength}, ${ind.adx.direction}) +DI: ${ind.adx.plusDI} -DI: ${ind.adx.minusDI}`);
    }
    if (ind.bollingerBands) {
      const bb = ind.bollingerBands;
      L(`BB: Upper=${formatPrice(bb.upper ?? 0)} Mid=${formatPrice(bb.middle ?? 0)} Lower=${formatPrice(bb.lower ?? 0)} | %B ${bb.percentB}, BW ${bb.bandwidth}%${bb.squeeze ? ' SQUEEZE' : ' (no squeeze)'}`);
    }
    if (ind.atr) L(`ATR: ${formatPrice(ind.atr.atr)} (${ind.atr.atrPercent}%)`);
    const maParts: string[] = [];
    if (ind.ema20 != null) maParts.push(`EMA20=${formatPrice(ind.ema20)}`);
    if (ind.ema50 != null) maParts.push(`EMA50=${formatPrice(ind.ema50)}`);
    if (ind.ema200 != null) maParts.push(`EMA200=${formatPrice(ind.ema200)}`);
    if (maParts.length) L(`MAs: ${maParts.join(' ')}`);
    if (ind.vwap != null) {
      const priceVsVwap = ind.price > ind.vwap ? 'above' : 'below';
      const distancePercent = roundTo((ind.price - ind.vwap) / ind.vwap * 100, 2);
      L(`VWAP: ${formatPrice(ind.vwap)} (${priceVsVwap}, ${formatPercent(distancePercent)})`);
    }
    if (ind.volumeRatio != null) L(`Volume: ${ind.volumeRatio}x avg`);
    if (ind.supportResistance.supports.length) L(`Support: ${ind.supportResistance.supports.map(formatPrice).join(', ')}`);
    if (ind.supportResistance.resistances.length) L(`Resistance: ${ind.supportResistance.resistances.map(formatPrice).join(', ')}`);
    if (ind.fibonacci) L(`Fib (${ind.fibonacci.trend}): swing ${formatPrice(ind.fibonacci.swingLow)}-${formatPrice(ind.fibonacci.swingHigh)} | Nearest: ${ind.fibonacci.nearestLevel} at ${formatPrice(ind.fibonacci.nearestPrice)}`);
    if (ind.volumeProfile) {
      const vp = ind.volumeProfile, vaWidth = vp.poc > 0 ? (vp.vah - vp.val) / vp.poc * 100 : 0;
      L(`Volume Profile: POC ${formatPrice(vp.poc)} | VAH ${formatPrice(vp.vah)} | VAL ${formatPrice(vp.val)} (${f(vaWidth, 1)}% VA width)`);
    }
    if (ind.divergence) L(`Divergence: ${ind.divergence}`);
    if (ind.candlePatterns.length) L(`Patterns: ${ind.candlePatterns.map(p => p.pattern).join(', ')}`);
    if (ind.obv) L(`OBV: ${ind.obv.trend}${ind.obv.divergence ? ` — ${ind.obv.divergence}` : ''}`);
    if (ind.adLine) L(`A/D Line: ${ind.adLine.trend}`);
    if (ind.smaCross) L(`SMA Cross: ${ind.smaCross.status}${ind.smaCross.recentCross ? ` — ${ind.smaCross.recentCross}` : ''}`);
    if (ind.gap) L(`Gap: ${ind.gap.direction} ${formatPercent(ind.gap.gapPercent)} from ${formatPrice(ind.gap.previousClose)}${ind.gap.filled ? ' (FILLED)' : ''}`);
    if (ind.addv) L(`ADDV: ${formatVolume(ind.addv.averageDollarVolume)} (${ind.addv.liquidity})`);
    L();
  }

  // POC alignment + naked POC
  if (indicators.length >= 2) {
    const dailyVP = indicators[0].volumeProfile, fourHVP = indicators[1].volumeProfile, atrVal = indicators[0].atr?.atr ?? 0;
    const align = pocAlignment(dailyVP, fourHVP, atrVal);
    if (align) L(`POC Alignment: ${align}`);
    // storePOC (state): persist today's daily POC keyed by symbol for next-session naked-POC check
    const todayStartMs = (() => { const u = new Date(nowMs); return Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()); })();
    // naked POC from previous session (before overwriting state)
    const lastCandle = last(indicators[0].candles);
    if (lastCandle && prevState.nakedPOC) {
      const np = prevState.nakedPOC;
      if (np.dateMs < todayStartMs && !(lastCandle.low <= np.poc && lastCandle.high >= np.poc)) {
        const d = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(np.dateMs));
        L(`Naked POC: ${formatPrice(np.poc)} (untested from ${d})`);
      }
    }
    if (dailyVP?.poc != null) newState.nakedPOC = { poc: dailyVP.poc, dateMs: todayStartMs };
  }

  // RECENT CANDLES
  if (indicators.some(i => i.candles.length)) {
    L('=== RECENT CANDLES ===');
    for (const ind of indicators) {
      const recent = ind.candles.slice(-6);
      if (!recent.length) continue;
      L(`${ind.label} (last ${recent.length}, newest first, format: [O, H, L, C, Vol]):`);
      const rev = [...recent].reverse();
      // All bars are CLOSED — every feed path applies dropInProgress. The old "(forming)" tag on
      // the newest bar told the LLM the very bar its patterns/kills fired on "may still change".
      rev.forEach((c, i) => {
        L(`${i + 1}. [${formatPrice(c.open)}, ${formatPrice(c.high)}, ${formatPrice(c.low)}, ${formatPrice(c.close)}, ${f(c.volume, 0)}]`);
      });
      L();
    }
  }

  return { prompt: lines.join('\n'), newState, envelope: envelopeVerdict, envelopeInput, diagnostics };
}

