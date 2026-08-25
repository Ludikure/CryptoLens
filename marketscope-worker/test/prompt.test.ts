import { describe, it, expect } from 'vitest';
import { systemPrompt, classifyArchetype, useTighterBands, parseSetups, formatPrice, buildUserPrompt, isValidSetupGeometry, type PromptIndicator } from '../src/prompt';
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
    // risk-first output structure — Bottom Line + merged "The Tape" (Environment Risk headline,
    // ML_WIN demoted), no separate Direction header (lean folds into Bottom Line)
    expect(c).toContain('## Bottom Line');
    expect(c).toContain('## The Tape');
    expect(c).toContain('SHORT MODE');                   // quiet-bar mode switch
    expect(c).toContain('SINCE LAST ANALYSIS');          // prior-analysis delta (#6)
    expect(c).toContain('ML_WIN Context');               // ATR-normalized: correctly-but-misleadingly low in trends
    expect(c).toContain('ATR-normalized');
    expect(c).toContain('## Risk Map');
    expect(c).not.toContain('## Direction');             // dropped — lean lives in Bottom Line
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

  it('insight enrichments: live calibration, ML trajectory, BTC context render (and gate correctly)', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const daily = mk(230, DAY, 'Daily (1D)', '1d');
    const fourH = mk(230, H4, '4H', '4h');
    const oneH = mk(120, H1, '1H', '1h');
    daily.mlWinProbability = 0.63;

    const { prompt } = buildUserPrompt({
      symbol: 'ETHUSDT', nowMs: NOW, indicators: [daily, fourH, oneH],
      mlCalibration: { n: 41, realizedPct: 63.4, windowDays: 90, bucketLabel: '60-70%' },
      mlTrajectory: { points: [0.31, 0.44, 0.62], hours: 24 },
      btcContext: { mlWin: 0.41, bigMoveBucket: 'ELEVATED', persistence: 0.55 },
    });
    expect(prompt).toContain('ML Calibration (live, audited): bars predicted 60-70% realized a >=1.5-ATR move 63% of the time over the last 90d (n=41)');
    expect(prompt).toContain('ML_WIN 24h path: 31→44→62% (RISING — vol regime building)');
    expect(prompt).toContain('BTC CONTEXT: ML_WIN 41%, Big-Move ELEVATED, persistence 55%');

    // Gates: thin calibration (n<20) suppressed; BTC context never renders for BTC itself.
    const gated = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH],
      mlCalibration: { n: 7, realizedPct: 80, windowDays: 90, bucketLabel: '60-70%' },
      btcContext: { mlWin: 0.41, bigMoveBucket: 'ELEVATED', persistence: 0.55 },
    });
    expect(gated.prompt).not.toContain('ML Calibration');
    expect(gated.prompt).not.toContain('BTC CONTEXT');
  });

  it('Options-Implied Vol: regime context only (straddle edge rejected in backtest)', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const daily = mk(230, DAY, 'Daily (1D)', '1d');
    const fourH = mk(230, H4, '4H', '4h');
    const oneH = mk(120, H1, '1H', '1h');
    // forecast 3.0% vs implied 2.0% → ratio 1.5 ≥ 1.25 → cheap vol.
    const { prompt } = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH],
      volPricing: { dvol: 40, impliedMovePct: 2.0, forecastMovePct: 3.0 },
    });
    expect(prompt).toContain('Options-Implied Vol (BTC/ETH, context): 30d DVOL 40% (NORMAL)');
    expect(prompt).toContain('NOT a trade signal');
    expect(prompt).not.toContain('straddle favorable');
  });

  it('calibration-corrected ML gate: a drifted-low raw ML_WIN no longer auto-FLATs when the live bucket realizes higher', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const daily = mk(230, DAY, 'Daily (1D)', '1d');
    const fourH = mk(230, H4, '4H', '4h');
    const oneH = mk(120, H1, '1H', '1h');
    daily.mlWinProbability = 0.42;   // raw < 50 → would auto-FLAT on the raw number

    // calibratedMlWin 0.35*0.42 + 0.65*0.65 = 0.57 → clears 50, so ML is NOT an auto-FLAT reason.
    const lifted = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH],
      calibratedMlWin: 0.35 * 0.42 + 0.65 * 0.65,
    });
    expect(lifted.prompt).toContain('the live forward calibration corrects it');
    expect(lifted.prompt).not.toContain('auto_FLAT_active: ML_WIN');

    // Without calibration, the raw 42% still auto-FLATs (unchanged behavior).
    const raw = buildUserPrompt({ symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH] });
    expect(raw.prompt).toContain('auto_FLAT_active: ML_WIN_42%<50');
  });

  it('biases_MIXED NEVER auto-FLATs — the rule measured inverted and was removed', () => {
    // Superseded 2026-08-25 (envelope-rules.md Part 1). The 2026-07-06 change ML-gated this rule
    // after mixed_flat_test showed non-aligned bars carry ~2x the goodR rate. Right direction,
    // not far enough: measured as a GATE, it blocked bars averaging +0.0503R against a +0.0197R
    // baseline at 2/9 periods. The correct gate strength was zero, so it is gone at every ML level.
    // The ML_WIN < 50 floor still flats a genuinely dead tape.
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mirror = (cs: Candle[]) => cs.map(c => ({
      time: c.time, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close, volume: c.volume,
    }));
    const daily = computeFullIndicators(synthCandles(230, NOW - 230 * DAY, DAY, 100), { timeframe: '1d', label: 'Daily (1D)', isCrypto: true }) as unknown as PromptIndicator;
    const fourH = computeFullIndicators(mirror(synthCandles(230, NOW - 230 * H4, H4, 100)), { timeframe: '4h', label: '4H', isCrypto: true }) as unknown as PromptIndicator;
    const oneH = computeFullIndicators(synthCandles(120, NOW - 120 * H1, H1, 100), { timeframe: '1h', label: '1H', isCrypto: true }) as unknown as PromptIndicator;

    daily.mlWinProbability = 0.74;
    const open = buildUserPrompt({ symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH] });
    expect(open.prompt).toContain('Multi-TF Alignment: MIXED');
    expect(open.prompt).not.toContain('biases_MIXED');
    expect(open.prompt).toContain('MIXED_HIGH_ML_WINDOW');
    expect(open.prompt).toContain('cap MODERATE');

    daily.mlWinProbability = 0.55;   // above the ML<50 auto-FLAT, below the 70 window
    const blocked = buildUserPrompt({ symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH] });
    // The whole point of the removal: a MIXED bar at LOW ML is no longer flatted for being mixed.
    expect(blocked.prompt).not.toContain('biases_MIXED');
  });

  it('FRAMING hatch fires on a quality-gate FLAT, never on a hazard FLAT', () => {
    // 2026-07-24, and still load-bearing after the 2026-08-25 removal of the biases_MIXED rule.
    // The hatch used to require exactly one `ML_WIN_*` entry, so it could not fire on
    // `biases_MIXED_and_ML_<70` — then the most common FLAT reason. That reason no longer exists
    // (it measured inverted), so the hatch is exercised here on the ML_WIN quality gate itself,
    // which is what it was widened to cover. Replaying this builder over BTC 07-13→07-25 (73 real 4H bars): 71 FLATs, 63 from
    // biases_MIXED alone, Environment Risk ELEVATED on every bar, zero FRAMING lines emitted.
    // Same fixture as the test above (daily bullish vs mirrored-bearish 4H → MIXED, HIGH env risk).
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mirror = (cs: Candle[]) => cs.map(c => ({
      time: c.time, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close, volume: c.volume,
    }));
    const daily = computeFullIndicators(synthCandles(230, NOW - 230 * DAY, DAY, 100), { timeframe: '1d', label: 'Daily (1D)', isCrypto: true }) as unknown as PromptIndicator;
    const fourH = computeFullIndicators(mirror(synthCandles(230, NOW - 230 * H4, H4, 100)), { timeframe: '4h', label: '4H', isCrypto: true }) as unknown as PromptIndicator;
    const oneH = computeFullIndicators(synthCandles(120, NOW - 120 * H1, H1, 100), { timeframe: '1h', label: '1H', isCrypto: true }) as unknown as PromptIndicator;
    daily.mlWinProbability = 0.42;   // below the ML<50 floor → a pure quality-gate FLAT

    const gated = buildUserPrompt({ symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH] });
    expect(gated.prompt).toMatch(/auto_FLAT_active: ML_WIN_42%?<50/);
    expect(gated.prompt).toMatch(/Environment Risk: (ELEVATED|HIGH)/);
    expect(gated.prompt).toContain('FRAMING:');
    expect(gated.prompt).toContain('no volatility-edge entry');
    expect(gated.prompt).toContain('does not gate');               // riding a trend is the user's call
    // Must NOT claim a big move is "unlikely" — ML 50-70 realizes 56-64% per the live calibration.
    // "unlikely here" is now CORRECT language: the fixture sits below the ML<50 floor, where a
    // >=1.5-ATR move genuinely is unlikely. The old assertion guarded the mixed-bias variant,
    // which must not have claimed that at ML 50-70 (a band realising 56-64%) — that variant was
    // removed 2026-08-25 along with the rule that triggered it.
    expect(gated.prompt).toContain('unlikely here');
    // Still a hard FLAT: the hatch reframes, it never authorizes a setup.
    expect(gated.prompt).toContain('→ Output NO SETUP regardless of any other reasoning');
    // "do NOT present a setup" lived only in the removed mixed-bias variant. The instruction is
    // not lost — the auto-FLAT directive asserted on the line above carries it for every FLAT.

    // A genuine hazard in the FLAT set suppresses the hatch entirely — "the trend is intact, ride
    // it if you like" would be actively dangerous 1h before a high-impact macro print.
    const hazard = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH],
      economicEvents: [{ title: 'CPI', country: 'US', isHighImpact: true, isUpcoming: true, isRecentlyReleased: false, date: NOW + 3600_000 }],
    });
    expect(hazard.prompt).toContain('macro_IMMINENT');
    expect(hazard.prompt).not.toContain('FRAMING:');
  });

  it('systemPrompt no longer discounts the retrained 72h persistence model', () => {
    // The h72t25 head was retrained on clean data (2026-06-05) and again for v14 (2026-07-06,
    // monotone reliability, crypto top bucket 75.5% / stock 78.1%), but both system prompts still
    // told the LLM it was "not retrained on fresh data — treat as soft", discounting the ONE model
    // whose 72h horizon matches a multi-day hold. ML_WIN's 24h window cannot see a slow grind.
    for (const p of [systemPrompt(true), systemPrompt(false)]) {
      expect(p).not.toContain('Not retrained on fresh data');
      expect(p).toContain('horizon closest to a multi-day hold');
    }
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
      riskStates: [{ state: 'COMPRESSION', severity: 'HIGH', detail: 'ATR percentile 3% — expansion likely', validated: true }],
      prevState: { regime: 'RANGING' }, settings: { accountSize: 25000, riskPercent: 2 },
    });
    expect(prompt).toContain('Expected 24h Range:');      // Phase 1 HAR-RV range surfaced
    expect(prompt).toContain('Risk States: COMPRESSION(HIGH)');  // Phase 5/8 states in prompt

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

  it('TAGGED LEVELS tag each level ABOVE/BELOW the LIVE price so one-sided clusters cannot be called a "squeeze"', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const daily = mk(230, DAY, 'Daily (1D)', '1d');
    const fourH = mk(230, H4, '4H', '4h');
    const oneH = mk(120, H1, '1H', '1h');

    // The user's exact bug: live price sits ABOVE the whole level cluster, yet the model narrated
    // it as "squeezed between" two below-price levels. With live price above every computed level,
    // every tagged line must read "BELOW live" and NONE "ABOVE live" — proving the geometry is
    // anchored to live, not to the (stale) closed bar, and the anti-squeeze directive is present.
    const { prompt } = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH], livePrice: 1_000_000,
    });
    expect(prompt).toContain('=== TAGGED LEVELS ===');
    expect(prompt).toContain('Only call price "between"/"squeezed"');   // geometry directive present
    expect(prompt).toContain('[BELOW live]');                            // levels tagged by side
    expect(prompt).not.toContain('[ABOVE live]');                        // nothing is above 1,000,000
  });

  it('#6: SINCE LAST ANALYSIS surfaces the ML delta + prior Bottom Line, and stamps newState for the next run', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const daily = mk(230, DAY, 'Daily (1D)', '1d');
    const fourH = mk(230, H4, '4H', '4h');
    const oneH = mk(120, H1, '1H', '1h');
    daily.mlWinProbability = 0.71;
    const { prompt, newState } = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH],
      prevState: { regime: 'RANGING', prevMlWin: 0.44, prevBottomLine: 'Quiet, mid-range — nothing to do.', prevAnalysisMs: NOW - 4 * H1 },
    });
    expect(prompt).toContain('=== SINCE LAST ANALYSIS ===');
    expect(prompt).toContain('4.0h ago');
    expect(prompt).toContain('44% → 71% (rising +27pp)');
    expect(prompt).toContain('Previous Bottom Line: "Quiet, mid-range — nothing to do."');
    // newState re-stamped so the NEXT run sees THIS run's values
    expect(newState.prevMlWin).toBe(0.71);
    expect(newState.prevAnalysisMs).toBe(NOW);

    // No prior state → section omitted entirely (first analysis of a symbol)
    const fresh = buildUserPrompt({ symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH], prevState: {} });
    expect(fresh.prompt).not.toContain('SINCE LAST ANALYSIS');
    expect(fresh.newState.prevMlWin).toBe(0.71);

    // Stale prior state (>3 days) → section omitted
    const stale = buildUserPrompt({ symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH], prevState: { prevMlWin: 0.44, prevAnalysisMs: NOW - 4 * DAY } });
    expect(stale.prompt).not.toContain('SINCE LAST ANALYSIS');
  });

  it('F-1: CHASE / EXHAUSTION guard fires HIGH when buying an extended, overbought rally into a crowded long', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const daily = mk(230, DAY, 'Daily (1D)', '1d');
    const fourH = mk(230, H4, '4H', '4h');
    const oneH = mk(120, H1, '1H', '1h');
    // Force a textbook "buying the top" tape: bullish momentum, price far above its 200D mean,
    // overbought oscillators, into a crowded long (→ crowded_longs exhaustion signal).
    daily.bias = 'Strong Bullish'; fourH.bias = 'Bullish';
    daily.price = 120; daily.ema200 = 100; daily.atr = { atr: 5, atrPercent: 4 }; // stretch = 4 ATR
    daily.rsi = 78; fourH.rsi = 76;
    if (daily.stochRSI) daily.stochRSI.k = 92;
    daily.mlWinProbability = 0.66;

    const { prompt } = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH],
      positioning: { fundingSentiment: 'Positive', oiTrend: 'Building', crowding: 'Crowded Long', crowdingCode: 'crowdedLong', smartMoneyBias: 'Neutral', takerPressure: 'Buy', squeezeRisk: { level: 'MODERATE', direction: 'LONG SQUEEZE' }, signals: [] },
      prevState: { regime: 'TRENDING' },
    });
    expect(prompt).toContain('CHASE / EXHAUSTION RISK: HIGH');
    expect(prompt).toContain('BUYING THE TOP');
    expect(prompt).toContain('classic retail trap');
    expect(prompt).toContain('extended');
    // Part 10 (2026-08-25): the chase READING survives — every assertion above still holds — but
    // it no longer auto-FLATs. Measured as a bar filter on 274,079 opportunities it was noise in
    // all four cells (MARKET −0.0005/+0.0022, PULLBACK −0.0017/−0.0005) and its robust arm was
    // INVERTED on LONG. The thing it protected against, chasing, is already forbidden outright by
    // ENTRY DISCIPLINE, so it was blocking 27% of bars from producing the best action available.
    expect(prompt).not.toContain('chase_into_extended_aligned_trend');
    // The guidance that actually does the work is untouched: prefer a pullback entry, never chase.
    expect(prompt).toContain('the lower-risk play is to WAIT');
    expect(prompt).toContain('prefer a pullback entry over the current extreme');
  });

  it('F-1: CHASE / EXHAUSTION guard stays quiet on a calm, mid-range tape', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const daily = mk(230, DAY, 'Daily (1D)', '1d');
    const fourH = mk(230, H4, '4H', '4h');
    const oneH = mk(120, H1, '1H', '1h');
    // Bullish but un-stretched: price near its mean, neutral oscillators, no crowding.
    daily.bias = 'Bullish'; fourH.bias = 'Bullish';
    daily.price = 101; daily.ema200 = 100; daily.atr = { atr: 5, atrPercent: 4 }; // stretch = 0.2 ATR
    daily.rsi = 54; fourH.rsi = 52;
    if (daily.stochRSI) daily.stochRSI.k = 50;
    const { prompt } = buildUserPrompt({ symbol: 'BTCUSDT', nowMs: NOW, indicators: [daily, fourH, oneH], prevState: { regime: 'RANGING' } });
    expect(prompt).not.toContain('CHASE / EXHAUSTION RISK: HIGH');
  });

  it('F-2: WHALE TRAP fires when retail is crowded long against top traders + stretched funding + falling CVD', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const indicators = [mk(230, DAY, 'Daily (1D)', '1d'), mk(230, H4, '4H', '4h'), mk(120, H1, '1H', '1h')];
    const { prompt } = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators,
      // 68% retail long, top traders net short, funding positive & stretched, OI building.
      derivatives: { fundingRatePercent: 0.018, avgFundingRate: 0.0001, openInterestUSD: 8e9, oiChange4h: 1, oiChange24h: 6, globalLongPercent: 68, globalShortPercent: 32, topTraderLongPercent: 42, topTraderShortPercent: 58, takerBuySellRatio: 1.1, takerBuyVolume: 1000 },
      positioning: { fundingSentiment: 'Positive (elevated)', oiTrend: 'Building', crowding: 'Crowded Long', crowdingCode: 'crowdedLong', smartMoneyBias: 'Bearish', takerPressure: 'Buy', squeezeRisk: { level: 'MODERATE', direction: 'LONG SQUEEZE' }, signals: [] },
      spotPressure: { takerBuyRatio: 0.55, takerBuyLabel: 'Buying', cvd24h: -300, cvdTrend: 'Falling', bookRatio: 0.5, bookLabel: 'Balanced' },
      prevState: { regime: 'TRENDING' },
    });
    expect(prompt).toContain('WHALE TRAP: HIGH');
    expect(prompt).toContain('68% of retail is positioned LONG');
    expect(prompt).toContain('liquidation cascade DOWN');
    expect(prompt).toContain('opposite the crowd');
  });

  it('F-2: WHALE TRAP stays quiet when positioning is balanced', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const indicators = [mk(230, DAY, 'Daily (1D)', '1d'), mk(230, H4, '4H', '4h'), mk(120, H1, '1H', '1h')];
    const { prompt } = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators,
      derivatives: { fundingRatePercent: 0.001, avgFundingRate: 0.0001, openInterestUSD: 8e9, oiChange4h: 0, oiChange24h: 0, globalLongPercent: 52, globalShortPercent: 48, topTraderLongPercent: 51, topTraderShortPercent: 49, takerBuySellRatio: 1.0, takerBuyVolume: 1000 },
      positioning: { fundingSentiment: 'Neutral', oiTrend: 'Stable', crowding: 'Balanced', crowdingCode: 'balanced', smartMoneyBias: 'Neutral', takerPressure: 'Neutral', squeezeRisk: { level: 'NONE', direction: '' }, signals: [] },
      prevState: { regime: 'RANGING' },
    });
    expect(prompt).not.toContain('WHALE TRAP');
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

describe('setup geometry gate (isValidSetupGeometry + parseSetups)', () => {
  it('rejects the reported bug: a SHORT with its stop BELOW entry (on the target side)', () => {
    // The exact Jul 14 case: SHORT, stop $62,958 is below entry $63,732 — same side as the targets.
    expect(isValidSetupGeometry({ direction: 'SHORT', entry: 63732.66, stopLoss: 62958.31, tp1: 63283.26, tp2: 62932.73 })).toBe(false);
  });

  it('accepts a correct SHORT (stop above entry, targets below)', () => {
    expect(isValidSetupGeometry({ direction: 'SHORT', entry: 63732.66, stopLoss: 64299.0, tp1: 63283.26, tp2: 62932.73 })).toBe(true);
  });

  it('accepts a correct LONG and rejects a LONG with stop above entry', () => {
    expect(isValidSetupGeometry({ direction: 'LONG', entry: 65000, stopLoss: 63500, tp1: 67000, tp2: 69000 })).toBe(true);
    expect(isValidSetupGeometry({ direction: 'LONG', entry: 65000, stopLoss: 66000, tp1: 67000, tp2: 69000 })).toBe(false);
  });

  it('rejects wrong-side targets and unknown direction', () => {
    expect(isValidSetupGeometry({ direction: 'SHORT', entry: 100, stopLoss: 110, tp1: 105 })).toBe(false); // tp1 above entry
    expect(isValidSetupGeometry({ direction: 'LONG', entry: 100, stopLoss: 95, tp1: 110, tp2: 90 })).toBe(false); // tp2 below entry
    expect(isValidSetupGeometry({ direction: 'FLAT', entry: 100, stopLoss: 95, tp1: 110 })).toBe(false);
  });

  it('tolerates a valid SHORT with no tp2', () => {
    expect(isValidSetupGeometry({ direction: 'SHORT', entry: 100, stopLoss: 105, tp1: 95, tp2: null })).toBe(true);
  });

  it('parseSetups drops the invalid setup from a full JSON block', () => {
    const text = 'blah\n```json\n[{"direction":"SHORT","entry":63732.66,"stopLoss":62958.31,"tp1":63283.26,"tp2":62932.73}]\n```';
    expect(parseSetups(text)).toEqual([]);   // dropped by the geometry gate
  });

  it('parseSetups keeps a valid setup', () => {
    const text = '```json\n[{"direction":"SHORT","entry":63732.66,"stopLoss":64299.0,"tp1":63283.26,"tp2":62932.73}]\n```';
    const out = parseSetups(text);
    expect(out.length).toBe(1);
    expect(out[0].stopLoss).toBe(64299.0);
  });
});
