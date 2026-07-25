// Notification envelope precheck (2026-07-11): "don't page the user into an auto-FLAT
// analysis". The precheck builds the REAL prompt and parses its auto_FLAT_active line —
// these tests exercise the parse against genuine buildUserPrompt output (zero-drift by
// construction) and the defer-not-drop suppression transition.
import { describe, it, expect } from 'vitest';
import { parseAutoFlatReasons, nextSuppressionState, deferAutoAnalysisCross } from '../src/index';
import { D1Adapter } from '../server/d1-adapter';
import { buildUserPrompt, type PromptIndicator } from '../src/prompt';
import { computeFullIndicators } from '../src/indicators-full';
import type { Candle } from '../src/scoring-full';

const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;

function synthCandles(n: number, startMs: number, stepMs: number, base = 100): Candle[] {
  const out: Candle[] = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 9) * 2 + i * 0.03;
    const open = price, close = base + drift;
    out.push({ time: startMs + i * stepMs, open, high: Math.max(open, close) + 0.6, low: Math.min(open, close) - 0.6, close, volume: 1000 + (i % 7) * 120 });
    price = close;
  }
  return out;
}

function mkIndicators(): PromptIndicator[] {
  const mk = (n: number, step: number, label: string, tf: string) =>
    computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
  return [mk(230, DAY, 'Daily (1D)', '1d'), mk(230, H4, '4H', '4h'), mk(120, H1, '1H', '1h')];
}

describe('parseAutoFlatReasons (against real buildUserPrompt output)', () => {
  it('extracts the reasons when the envelope auto-FLATs (calibrated ML below 50)', () => {
    const indicators = mkIndicators();
    (indicators[0] as any).mlWinProbability = 0.72;
    // The calibrated gate keys on calibratedMlWin when present — 0.30 forces the ML auto-FLAT.
    const { prompt } = buildUserPrompt({ symbol: 'BTCUSDT', nowMs: NOW, indicators, calibratedMlWin: 0.30 });
    const reasons = parseAutoFlatReasons(prompt);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some(r => r.startsWith('ML_WIN_'))).toBe(true);
  });

  it('returns [] when no auto_FLAT_active line is present', () => {
    expect(parseAutoFlatReasons('## Bottom Line\nall clear\nConviction Envelope:\n  max_allowed: HIGH')).toEqual([]);
  });

  it('parses a multi-reason line', () => {
    const reasons = parseAutoFlatReasons('Conviction Envelope:\n  auto_FLAT_active: ANY_KILLED=true, macro_IMMINENT, chase_into_extended_aligned_trend\n');
    expect(reasons).toEqual(['ANY_KILLED=true', 'macro_IMMINENT', 'chase_into_extended_aligned_trend']);
  });
});

describe('nextSuppressionState (defer-not-drop)', () => {
  it('fresh cross + envelope flat → suppress, no notification', () => {
    expect(nextSuppressionState({ crossed: true, wasSuppressed: false, flat: true }))
      .toEqual({ effectiveCross: false, suppressed: true });
  });

  it('fresh cross + envelope clean → notify', () => {
    expect(nextSuppressionState({ crossed: true, wasSuppressed: false, flat: false }))
      .toEqual({ effectiveCross: true, suppressed: false });
  });

  it('suppressed cross whose envelope clears → DEFERRED notification fires', () => {
    expect(nextSuppressionState({ crossed: false, wasSuppressed: true, flat: false }))
      .toEqual({ effectiveCross: true, suppressed: false });
  });

  it('suppressed cross still flat → stays suppressed, still no notification', () => {
    expect(nextSuppressionState({ crossed: false, wasSuppressed: true, flat: true }))
      .toEqual({ effectiveCross: false, suppressed: true });
  });

  it('precheck failure fails OPEN (notify) — for a fresh cross and a deferred one', () => {
    expect(nextSuppressionState({ crossed: true, wasSuppressed: false, flat: null }))
      .toEqual({ effectiveCross: true, suppressed: false });
    expect(nextSuppressionState({ crossed: false, wasSuppressed: true, flat: null }))
      .toEqual({ effectiveCross: true, suppressed: false });
  });
});

// 2026-07-24. The precheck defers correctly, but the LATER enrichment-aware gate inside
// runAutoAnalysis (no setup / analysis failed / exception) used to just `return` — dropping a real
// cross, because the caller had already consumed it: `crossed` is a single-tick rising edge and the
// notif_claims claim is taken as a PRECONDITION of queueing the push. deferAutoAnalysisCross hands
// the signal back so the symbol pass retries it.
describe('deferAutoAnalysisCross (defer-not-drop, part 2)', () => {
  function mkEnv() {
    const db = new D1Adapter(':memory:');
    db.prepare(`CREATE TABLE IF NOT EXISTS notif_claims (
      push_token TEXT, symbol TEXT, expires_at INTEGER, PRIMARY KEY (push_token, symbol))`).run();
    const kv: Record<string, string> = {};
    return {
      db, kv,
      env: {
        DB: db,
        ALERTS: {
          get: async (k: string) => kv[k] ?? null,
          put: async (k: string, v: string) => { kv[k] = v; },
          delete: async (k: string) => { delete kv[k]; },
        },
      } as any,
    };
  }

  it('releases the burned claim and re-arms the cross', async () => {
    const { db, kv, env } = mkEnv();
    await db.prepare('INSERT INTO notif_claims (push_token, symbol, expires_at) VALUES (?, ?, ?)')
      .bind('tok-1', 'BTCUSDT', Date.now() + 3.5 * 3600_000).run();
    // An unrelated claim that must survive.
    await db.prepare('INSERT INTO notif_claims (push_token, symbol, expires_at) VALUES (?, ?, ?)')
      .bind('tok-1', 'ETHUSDT', Date.now() + 3.5 * 3600_000).run();

    await deferAutoAnalysisCross(env, 'tok-1', 'BTCUSDT', 'no setup');

    const btc = await db.prepare('SELECT COUNT(*) as n FROM notif_claims WHERE symbol = ?').bind('BTCUSDT').first();
    expect(btc.n).toBe(0);                                  // claim released → next tick can re-claim
    const eth = await db.prepare('SELECT COUNT(*) as n FROM notif_claims WHERE symbol = ?').bind('ETHUSDT').first();
    expect(eth.n).toBe(1);                                  // scoped to (push_token, symbol)
    expect(kv['notif_resuppress:BTCUSDT']).toBeDefined();    // re-armed for the symbol pass to adopt
    expect(Number(kv['notif_resuppress:BTCUSDT'])).toBeGreaterThan(0);
  });

  it('never throws when there is no claim to release (idempotent retry)', async () => {
    const { kv, env } = mkEnv();
    await expect(deferAutoAnalysisCross(env, 'tok-missing', 'SOLUSDT', 'exception')).resolves.toBeUndefined();
    expect(kv['notif_resuppress:SOLUSDT']).toBeDefined();
  });

  it('a re-armed cross reads back as suppressed → the deferred notification fires when clean', async () => {
    const { kv, env } = mkEnv();
    await deferAutoAnalysisCross(env, 'tok-1', 'BTCUSDT', 'no setup');
    // What the symbol pass does with it: adopt the key as wasSuppressed, then transition.
    const wasSuppressed = (await env.ALERTS.get('notif_resuppress:BTCUSDT')) !== null;
    expect(wasSuppressed).toBe(true);
    expect(nextSuppressionState({ crossed: false, wasSuppressed, flat: false }))
      .toEqual({ effectiveCross: true, suppressed: false });   // retried, not lost
  });
});
