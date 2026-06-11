import { describe, it, expect } from 'vitest';
import { systemPrompt, classifyArchetype, useTighterBands, parseSetups, formatPrice, buildUserPrompt, type PromptIndicator } from '../src/prompt';
import { computeFullIndicators } from '../src/indicators-full';
import type { Candle } from '../src/scoring-full';

// Deterministic synthetic candles (no Math.random — banned in scripts; keep tests reproducible).
function synthCandles(n: number, startMs: number, stepMs: number, base = 100): Candle[] {
  const out: Candle[] = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 9) * 2 + i * 0.03;       // mild trend + wave
    const open = price;
    const close = base + drift;
    const high = Math.max(open, close) + 0.6;
    const low = Math.min(open, close) - 0.6;
    const volume = 1000 + (i % 7) * 120;
    out.push({ time: startMs + i * stepMs, open, high, low, close, volume });
    price = close;
  }
  return out;
}

describe('prompt.ts (AnalysisPrompt port)', () => {
  it('systemPrompt is the risk-first reframe (leaked directional claim removed)', () => {
    const c = systemPrompt(true), s = systemPrompt(false);
    // role flipped: risk analyst, not trader
    expect(c.startsWith('You are MarketScope — a RISK and VOLATILITY analyst')).toBe(true);
    expect(c).not.toContain('a trader, not an analyst');
    // the leaked crypto-direction claim must be gone
    expect(c).not.toContain('HIGH-confidence and commit');
    expect(c).not.toContain('treat direction as HIGH');
    expect(c).toContain('DATA-LEAK ARTIFACT');
    // risk-first output structure — Environment Risk is now the headline, ML_WIN demoted
    expect(c).toContain('## Environment Risk');
    expect(c).toContain('## Move Likelihood (secondary)');
    expect(c).toContain('ML_WIN Context');               // ATR-normalized: correctly-but-misleadingly low in trends
    expect(c).toContain('ATR-normalized');
    expect(c).toContain('## Risk Map');
    expect(c).toContain('Direction (your read)');
    expect(c).toContain('DERIVATIVES / SPOT');
    // stock keeps news + market hours, drops crypto derivatives
    expect(s.startsWith('You are MarketScope — a RISK and VOLATILITY analyst')).toBe(true);
    expect(s).toContain('Recent News');
    expect(s).toContain('9:30 AM');
    expect(s).not.toContain('DERIVATIVES / SPOT');
    expect(c).not.toContain('\\(');  // no unresolved interpolations
    expect(c.length).toBeGreaterThan(5000);
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

  it('formatPrice matches iOS Formatters.formatPrice', () => {
    expect(formatPrice(73884.38)).toBe('$73,884.38');
    expect(formatPrice(2.5)).toBe('$2.50');
    expect(formatPrice(0.4263)).toBe('$0.4263');
    expect(formatPrice(0.0000123)).toBe('$0.000012');
  });

  it('buildUserPrompt runs end-to-end over real computeFullIndicators output (crypto)', () => {
    const NOW = 1748736000000; // fixed (2025-06-01T00:00:00Z) — scripts can't use Date.now()
    const DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const daily = mk(230, DAY, 'Daily (1D)', '1d');
    const fourH = mk(230, H4, '4H', '4h');
    const oneH = mk(120, H1, '1H', '1h');
    daily.mlWinProbability = 0.72; daily.mlPersistenceProbability = 0.64; daily.mlDirectionUp = 0.68;
    daily.mlBigMoveProb = 0.12;   // HIGH tail bucket (>= 0.10)

    const { prompt, newState } = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH],
      sentiment: { athChangePercentage: -12.3, priceChangePercentage24h: 1.2 },
      volForecast: { rv: { h24: 0.03, d7: 0.05, d30: 0.10 },
        horizons: { '24h': { sigma: 0.025, s1: [63500, 66500], s2: [62000, 69000], s99: [60000, 71000] } } },
      prevState: { regime: 'RANGING' }, settings: { accountSize: 25000, riskPercent: 2 },
    });
    expect(prompt).toContain('Expected 24h Range:');      // Phase 1 HAR-RV range surfaced

    expect(prompt.startsWith('Symbol: BTCUSDT')).toBe(true);
    expect(prompt).toContain('=== PRE-COMPUTED FLAGS');
    expect(prompt).toContain('STOCH_CROSS (momentum context only, NOT directional)');  // direction stripped
    expect(prompt).not.toContain('DIRECTION MODEL');    // pUp head removed (leak)
    expect(prompt).toContain('ML_WIN is a VOLATILITY signal');
    expect(prompt).toContain('Environment Risk:');        // computed trend-risk flag (ML_WIN-independent)
    expect(prompt).toContain('Big-Move Risk: HIGH');       // learned tail head surfaced
    expect(prompt).toContain('ML_WIN Context:');           // ATR-normalization caveat emitted
    expect(prompt).toContain('ML Bucket: TOP (ML_WIN 72%)');
    expect(prompt).toContain('Momentum Alignment:');
    expect(prompt).toContain('=== RECENT CANDLES ===');
    expect(prompt).toContain('Next 4H Close:');
    // Stateful: regime recomputed + returned for persistence
    expect(typeof newState.regime).toBe('string');
    expect(['TRENDING', 'TRANSITIONING', 'RANGING']).toContain(newState.regime);
  });

  it('buildUserPrompt handles a stock (no crossAsset/derivatives) without throwing', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 200), { timeframe: tf, label, isCrypto: false }) as unknown as PromptIndicator;
    const indicators = [mk(230, DAY, 'Daily (1D)', '1d'), mk(230, H4, '4H', '4h'), mk(120, H1, '1H', '1h')];
    indicators[0].mlWinProbability = 0.55;
    const { prompt } = buildUserPrompt({
      symbol: 'AAPL', nowMs: NOW, indicators,
      stockInfo: { marketState: 'CLOSED', fiftyTwoWeekLow: 150, fiftyTwoWeekHigh: 260, earningsDate: NOW + 5 * DAY },
    });
    expect(prompt.startsWith('Symbol: AAPL')).toBe(true);
    expect(prompt).toContain('ML Bucket: MARGINAL (ML_WIN 55%)');
    expect(prompt).toContain('Earnings Proximity: 5d');
    expect(prompt).toContain('Next Daily Close:');
  });
});
