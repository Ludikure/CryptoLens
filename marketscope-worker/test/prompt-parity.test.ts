import { describe, it, expect } from 'vitest';
import { buildUserPrompt, type PromptIndicator, type BuildPromptInput } from '../src/prompt';
import { computeFullIndicators } from '../src/indicators-full';
import type { Candle } from '../src/scoring-full';

// Structural-completeness parity gate: build a FULLY-enriched prompt and assert every section the
// iOS buildUserPrompt emits is present. This is the regression net that would have auto-caught the
// economic-calendar gap (no "UPCOMING ECONOMIC EVENTS" section) the manual comparison surfaced.
// It checks the builder wires each enrichment into its section — NOT byte-parity (that needs an
// iOS input-capture fixture). Run against the dry-run /full-analysis (promptOnly) for live diffs.

function synthCandles(n: number, startMs: number, stepMs: number, base = 100): Candle[] {
  const out: Candle[] = []; let price = base;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 9) * 2 + i * 0.03;
    const open = price, close = base + drift;
    out.push({ time: startMs + i * stepMs, open, high: Math.max(open, close) + 0.6, low: Math.min(open, close) - 0.6, close, volume: 1000 + (i % 7) * 120 });
    price = close;
  }
  return out;
}

const NOW = 1748736000000; // 2025-06-01T00:00:00Z
const DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
const mk = (n: number, step: number, label: string, tf: string, crypto: boolean) =>
  computeFullIndicators(synthCandles(n, NOW - n * step, step, crypto ? 100 : 200), { timeframe: tf, label, isCrypto: crypto }) as unknown as PromptIndicator;

function fullCryptoInput(): BuildPromptInput {
  const daily = mk(230, DAY, 'Daily', '1d', true);
  const fourH = mk(230, H4, '4H', '4h', true);
  const oneH = mk(120, H1, '1H', '1h', true);
  daily.mlWinProbability = 0.72; daily.mlPersistenceProbability = 0.64; daily.mlDirectionUp = 0.71;
  return {
    symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH],
    sentiment: { athChangePercentage: -12.3, priceChangePercentage24h: 1.2, priceChangePercentage7d: -3, priceChangePercentage30d: 8 },
    derivatives: { fundingRatePercent: 0.012, avgFundingRate: 0.0001, openInterestUSD: 7.7e9, oiChange4h: 1.2, oiChange24h: 4.5, globalLongPercent: 62, globalShortPercent: 38, topTraderLongPercent: 48, topTraderShortPercent: 52, takerBuySellRatio: 1.35, takerBuyVolume: 1200 },
    positioning: { fundingSentiment: 'Positive (normal)', oiTrend: 'Building', crowding: 'Crowded Long', crowdingCode: 'crowdedLong', smartMoneyBias: 'Neutral', takerPressure: 'Strong buy pressure', squeezeRisk: { level: 'MODERATE', direction: 'LONG SQUEEZE' }, signals: [{ strength: 'Moderate', message: 'Aggressive buying — taker ratio 1.35' }] },
    spotPressure: { takerBuyRatio: 0.58, takerBuyLabel: 'Aggressive Buying', cvd24h: -216, cvdTrend: 'Rising', bookRatio: 0.42, bookLabel: 'Balanced' },
    macro: { vix: 15.7, treasury10Y: 4.2, treasury2Y: 4.0, yieldSpread: 0.2, fedFundsRate: 4.5, usdIndex: 99.0 },
    crossAsset: { summary: 'Cross-asset: SPY up (risk-on) → +1 for BTC', dxyPrice: 99, dxyEma20: 99.5, dxyTrend: 'down', spyPrice: 590, spyEma20: 585, spyTrend: 'up' },
    economicEvents: [
      { title: 'ISM Manufacturing PMI', country: 'USD', isHighImpact: true, isUpcoming: true, isRecentlyReleased: false, date: NOW + 10 * H1, actual: null, forecast: '53.3', previous: '52.7', surprise: null },
      { title: 'CPI m/m', country: 'USD', isHighImpact: true, isUpcoming: false, isRecentlyReleased: true, date: NOW - 2 * H1, actual: '0.3%', forecast: '0.2%', previous: '0.2%', surprise: 'BEAT' },
    ],
    outcomeHistory: [
      { direction: 'LONG', entry: 95, outcome: 'win_tp1', mlProb: 0.7, conviction: 'HIGH' },
      { direction: 'SHORT', entry: 110, outcome: 'loss', mlProb: 0.6, conviction: 'MODERATE' },
      { direction: 'LONG', entry: 98, outcome: 'win_tp2', mlProb: 0.75, conviction: 'HIGH' },
    ],
    activeSetups: [
      { direction: 'LONG', entry: 100, risk: 3, tp1: 105, mlProbability: 0.7, entryHitTimeMs: NOW - 30 * H1, maxFavorable: 4, maxAdverse: 1, tp1Hit: false, partialTaken: false, breakevenActivated: false },
    ],
    prevState: { regime: 'RANGING' }, settings: { accountSize: 25000, riskPercent: 2 },
  };
}

describe('prompt parity — structural completeness', () => {
  it('a fully-enriched crypto prompt emits every expected section', () => {
    const { prompt } = buildUserPrompt(fullCryptoInput());
    const required = [
      'Symbol: BTCUSDT',
      '=== PRE-COMPUTED FLAGS',
      'STOCH_CROSS (momentum context only, NOT directional)',
      'POSITION SIZING:',
      'Bias Feasibility:',
      'Likely Failure Modes',
      'Multi-TF Alignment:',
      'Conviction Envelope:',
      'ML Bucket:',
      'ML Persistence (72h',
      'Active Trade:',                       // activeSetups wired (C8)
      '=== RECENT OUTCOME HISTORY',
      '=== CROSS-ASSET CONTEXT',
      '=== DERIVATIVES POSITIONING',
      '=== SPOT PRESSURE',
      '=== MACRO CONTEXT',
      '=== RECENTLY RELEASED ECONOMIC DATA',  // economicEvents wired (released)
      '=== UPCOMING ECONOMIC EVENTS',         // economicEvents wired (upcoming) — the caught gap
      'Macro Risk:',                          // macro event window
      '=== TAGGED LEVELS',
      '=== Daily ===', '=== 4H ===', '=== 1H ===',
      '=== RECENT CANDLES',
    ];
    const missing = required.filter(s => !prompt.includes(s));
    expect(missing, `missing sections: ${missing.join(' | ')}`).toEqual([]);
  });

  it('macro event within range surfaces ISM PMI + sets Macro Risk', () => {
    const { prompt } = buildUserPrompt(fullCryptoInput());
    expect(prompt).toContain('ISM Manufacturing PMI');
    expect(prompt).toContain('CPI m/m');
    expect(prompt).toMatch(/Macro Risk: (IMMINENT|NEARBY|UPCOMING|ON_HORIZON)/);
  });

  it('stock prompt emits the stock-only flags when stockInfo is present', () => {
    const daily = mk(230, DAY, 'Daily', '1d', false);
    const fourH = mk(230, H4, '4H', '4h', false);
    const oneH = mk(120, H1, '1H', '1h', false);
    daily.mlWinProbability = 0.66;
    const { prompt } = buildUserPrompt({
      symbol: 'NVDA', nowMs: NOW, indicators: [daily, fourH, oneH],
      stockInfo: { marketState: 'CLOSED', peRatio: 32, eps: 6.5, fiftyTwoWeekLow: 135, fiftyTwoWeekHigh: 236, sector: 'Technology', beta: 2.2, earningsDate: NOW + 5 * DAY, analystTargetMean: 296, analystCount: 58, analystRating: 'strong_buy' },
      stockSentiment: { vix: 15.7, vixLevel: 'Low', shortPercentOfFloat: 1.3, shortRatio: 1.1, fiftyTwoWeekPosition: 75, putCallRatio: null },
      economicEvents: [],
    });
    expect(prompt).toContain('Fundamentals:');
    expect(prompt).toContain('Earnings Proximity: 5d');   // → conviction envelope cap
    expect(prompt).toContain('After-Hours Entry Floor');   // marketState !== OPEN
    expect(prompt).toContain('=== STOCK SENTIMENT');
  });
});
