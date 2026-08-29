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

  // 2026-08-08: deferring must NOT release the claim. Releasing it double-triggered — the analysis
  // takes 30-90s, the claim dropped, and the very next cron tick re-claimed and logged a second
  // trigger ~1 min after the first (paired rows in `notifications`, e.g. ADA 18:00:42 + 18:02:08).
  // It always stopped at two because the second attempt hit the 3.5h autorun guard. Holding the
  // claim gives the intended retry cadence for free: claim and guard are both 3.5h, so they lapse
  // together and the next tick does a REAL retry.
  it('re-arms the cross but HOLDS the claim (no double trigger a tick later)', async () => {
    const { db, kv, env } = mkEnv();
    const exp = Date.now() + 3.5 * 3600_000;
    await db.prepare('INSERT INTO notif_claims (push_token, symbol, expires_at) VALUES (?, ?, ?)')
      .bind('tok-1', 'BTCUSDT', exp).run();

    await deferAutoAnalysisCross(env, 'tok-1', 'BTCUSDT', 'no setup');

    const btc = await db.prepare('SELECT COUNT(*) as n FROM notif_claims WHERE symbol = ?').bind('BTCUSDT').first();
    expect(btc.n).toBe(1);                                   // held → next tick cannot re-trigger
    expect(kv['notif_resuppress:BTCUSDT']).toBeDefined();     // but the cross stays armed for the retry
    expect(Number(kv['notif_resuppress:BTCUSDT'])).toBeGreaterThan(0);
  });

  it('never throws when there is no claim to release (idempotent retry)', async () => {
    const { kv, env } = mkEnv();
    await expect(deferAutoAnalysisCross(env, 'tok-missing', 'SOLUSDT', 'exception')).resolves.toBeUndefined();
    expect(kv['notif_resuppress:SOLUSDT']).toBeDefined();
  });

  // 2026-08-06 regression. The auto-analysis deferral used to be cleared the moment the envelope
  // read clean — but that tick is ALWAYS swallowed by runAutoAnalysis's 3.5h autorun guard (set
  // when the first attempt ran), so it returned silently and the deferral was gone by the next
  // tick. The cross was still dropped, one tick later than before the fix. The key must outlive an
  // envelope-clear and survive until a push actually happens, ML fades, or the 24h TTL expires.
  it('the auto-analysis deferral OUTLIVES an envelope-clear tick (survives the autorun guard)', async () => {
    const { kv, env } = mkEnv();
    await deferAutoAnalysisCross(env, 'tok-1', 'BTCUSDT', 'no setup');
    expect(kv['notif_resuppress:BTCUSDT']).toBeDefined();

    // Envelope-clear tick: the blob deferral resolves, the KEY must NOT.
    const next = nextSuppressionState({ crossed: false, wasSuppressed: true, flat: false });
    expect(next).toEqual({ effectiveCross: true, suppressed: false });
    expect(kv['notif_resuppress:BTCUSDT']).toBeDefined();   // still pending a real retry

    // Only an actual push retires it (runAutoAnalysis deletes the key after sendAPNs).
    await env.ALERTS.delete('notif_resuppress:BTCUSDT');
    expect(kv['notif_resuppress:BTCUSDT']).toBeUndefined();
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
