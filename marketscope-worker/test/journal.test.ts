// Phase 3 — journal + attribution. Definitions pre-declared in docs/research/journal-attribution.md.
import { describe, it, expect, beforeEach } from 'vitest';
import { D1Adapter } from '../server/d1-adapter';
import {
  ensureJournalTables, logOpportunities, gradeOpportunity, resolveOpportunityLog, barBucket,
  realizedRForSetup, realizedRForFill, effectiveN, groupStats, attribute, bootstrapDiffCI,
  createJournalEntry, updateJournalEntry, computeAttribution, _resetJournalForTests,
  VERDICT_MIN_TAKEN, VERDICT_MIN_SKIPPED, type Obs, type Bar,
} from '../src/journal';
import { ensureTrackedSetupsTable, _resetForTests } from '../src/outcome-tracking';

const T0 = 1_787_900_000_000;
const H = 3600_000;
const STRUCT = { id: 'convex-1r5r-72h-test', targetR: 5, holdingHorizonHours: 72 };

function makeEnv() {
  const db = new D1Adapter(':memory:');
  return { DB: db, ALERTS: { get: async () => null, put: async () => {} } } as any;
}
function bar(time: number, o: number, h: number, l: number, c: number): Bar { return { time, open: o, high: h, low: l, close: c }; }
const longRow = { direction: 'LONG', entry: 100, stop: 99, target: 105, targetR: 5, loggedAt: T0, resolveAt: T0 + 72 * H };

beforeEach(() => { _resetJournalForTests(); _resetForTests(); });

describe('gradeOpportunity — the grading truth table', () => {
  it('target first → +targetR, with fav/adv in R', () => {
    const g = gradeOpportunity(longRow, [bar(T0 + H, 100, 101, 99.5, 100.5), bar(T0 + 2 * H, 100.5, 105.2, 100, 105)]);
    expect(g).toMatchObject({ outcome: 'target', exitR: 5 });
    expect(g!.favR).toBeCloseTo(5.2, 6);
    expect(g!.advR).toBeCloseTo(0.5, 6);
  });
  it('stop first → −1', () => {
    const g = gradeOpportunity(longRow, [bar(T0 + H, 100, 100.4, 98.9, 99)]);
    expect(g).toMatchObject({ outcome: 'stop', exitR: -1 });
  });
  it('SAME-BAR target and stop counts as the STOP (conservative, pre-declared)', () => {
    const g = gradeOpportunity(longRow, [bar(T0 + H, 100, 106, 98, 104)]);
    expect(g!.outcome).toBe('stop');
  });
  it('neither → horizon close in R, SHORT sign handled', () => {
    const short = { ...longRow, direction: 'SHORT', stop: 101, target: 95 };
    const g = gradeOpportunity(short, [bar(T0 + H, 100, 100.5, 99.5, 99.5), bar(T0 + 2 * H, 99.5, 100, 99, 99.2)]);
    expect(g!.outcome).toBe('horizon');
    expect(g!.exitR).toBeCloseTo(0.8, 6);
  });
  it('the bar containing the scan is EXCLUDED (strictly after logged_at) and bars past the horizon are ignored', () => {
    const g = gradeOpportunity(longRow, [bar(T0, 100, 106, 99, 100), bar(T0 + 73 * H, 100, 106, 99, 100), bar(T0 + H, 100, 100.2, 99.8, 100.1)]);
    expect(g!.outcome).toBe('horizon');
  });
  it('no bars in window → null (retry later), zero risk → null', () => {
    expect(gradeOpportunity(longRow, [])).toBeNull();
    expect(gradeOpportunity({ ...longRow, stop: 100 }, [bar(T0 + H, 100, 101, 99, 100)])).toBeNull();
  });
});

describe('opportunity log — dedupe and resolution', () => {
  it('logs once per (device, symbol, direction, 4H bar); re-scans in the same bar add nothing', async () => {
    const env = makeEnv();
    const row = { symbol: 'SOLUSDT', isCrypto: true, direction: 'SHORT' as const, entry: 100, stop: 101, target: 95,
                  expectedValueR: 0.07, grossR: 0.15, feeBurdenR: 0.08, winProb: 0.076, headShippable: true, crashMultiplier: 1, fearGreed: 55, shown: true };
    expect(await logOpportunities(env, 'dev', [row], STRUCT, T0)).toBe(1);
    expect(await logOpportunities(env, 'dev', [row], STRUCT, T0 + 20 * 60_000)).toBe(0);      // same bar
    expect(await logOpportunities(env, 'dev', [row], STRUCT, barBucket(T0) + 4 * H)).toBe(1); // next bar
    expect(await logOpportunities(env, 'dev2', [row], STRUCT, T0)).toBe(1);                   // other device
    const n: any = await env.DB.prepare('SELECT COUNT(*) n FROM opportunity_log').first();
    expect(n.n).toBe(3);
  });
  it('resolves due rows from the 1h candle archive (ms timestamps), leaves undue rows alone', async () => {
    const env = makeEnv();
    await env.DB.prepare(`CREATE TABLE candles (symbol TEXT, interval TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL, PRIMARY KEY(symbol, interval, timestamp))`).run();
    const row = { symbol: 'SOLUSDT', isCrypto: true, direction: 'LONG' as const, entry: 100, stop: 99, target: 105,
                  expectedValueR: 0.07, feeBurdenR: 0.08, shown: true };
    await logOpportunities(env, 'dev', [row], STRUCT, T0);
    for (let i = 1; i <= 72; i++) {
      const hit = i === 10;
      await env.DB.prepare('INSERT INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
        .bind('SOLUSDT', '1h', T0 + i * H, 100, hit ? 105.5 : 100.3, 99.7, 100.1).run();
    }
    expect(await resolveOpportunityLog(env, T0 + 10 * H)).toEqual({ graded: 0, ungraded: 0 });   // not due
    expect(await resolveOpportunityLog(env, T0 + 73 * H)).toEqual({ graded: 1, ungraded: 0 });
    const r: any = await env.DB.prepare('SELECT resolved, outcome, exit_r FROM opportunity_log').first();
    expect(r).toMatchObject({ resolved: 1, outcome: 'target', exit_r: 5 });
  });
  it('a row with no bars for 7 days past due is closed as ungraded, not retried forever', async () => {
    const env = makeEnv();
    await env.DB.prepare(`CREATE TABLE candles (symbol TEXT, interval TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL)`).run();
    await logOpportunities(env, 'dev', [{ symbol: 'XUSDT', isCrypto: true, direction: 'LONG' as const, entry: 1, stop: 0.9, target: 1.5, expectedValueR: 0.1, feeBurdenR: 0.01, shown: true }], STRUCT, T0);
    expect(await resolveOpportunityLog(env, T0 + 73 * H)).toEqual({ graded: 0, ungraded: 0 });
    expect(await resolveOpportunityLog(env, T0 + (72 + 24 * 8) * H)).toEqual({ graded: 0, ungraded: 1 });
  });
});

describe('realised R', () => {
  const geo = { direction: 'LONG', entry: 100, stopLoss: 95, tp1: 110, tp2: 120 };   // RR1 2, RR2 4
  it('maps the cron\'s terminal outcomes to the composite-band execution', () => {
    expect(realizedRForSetup({ ...geo, outcome: 'loss' })).toBe(-1);
    expect(realizedRForSetup({ ...geo, outcome: 'partial_be' })).toBe(0.5);
    expect(realizedRForSetup({ ...geo, outcome: 'tp1_win' })).toBeCloseTo(1.0, 9);
    expect(realizedRForSetup({ ...geo, outcome: 'tp2_win' })).toBeCloseTo(3.0, 9);
    for (const o of ['invalidated', 'expired', 'not_triggered', 'open', null]) {
      expect(realizedRForSetup({ ...geo, outcome: o })).toBeNull();
    }
  });
  it('your fill and exit, signed per side', () => {
    expect(realizedRForFill('LONG', 100, 95, 110)).toBeCloseTo(2, 9);
    expect(realizedRForFill('SHORT', 100, 105, 90)).toBeCloseTo(2, 9);
    expect(realizedRForFill('SHORT', 100, 105, 107)).toBeCloseTo(-1.4, 9);
    expect(realizedRForFill('LONG', 100, 100, 110)).toBeNull();
  });
});

describe('effective n — overlapping windows on one symbol are one observation', () => {
  const o = (sym: string, s: number, e: number): Obs => ({ key: `${sym}${s}`, source: 'setup', symbol: sym, direction: 'LONG', startMs: s, endMs: e, r: 0, gross: true });
  it('three overlapping BTC trades + one disjoint + one ETH → 3', () => {
    expect(effectiveN([o('BTC', 0, 10), o('BTC', 5, 15), o('BTC', 12, 20), o('BTC', 30, 40), o('ETH', 0, 10)])).toBe(3);
  });
  it('empty → 0; identical windows on different symbols stay separate', () => {
    expect(effectiveN([])).toBe(0);
    expect(effectiveN([o('A', 0, 10), o('B', 0, 10)])).toBe(2);
  });
});

describe('attribute — the two numbers and the pre-declared verdict rule', () => {
  const mk = (i: number, r: number | null, sym = `S${i}`): Obs => ({ key: `opp:${i}`, source: 'opportunity', symbol: sym, direction: 'LONG', startMs: T0 + i * 100 * H, endMs: T0 + (i * 100 + 72) * H, r, gross: false, feeR: 0.08 });
  it('renders NO verdict below the bar, and says how many more are needed', () => {
    const proposed = [mk(1, 1), mk(2, -1), mk(3, 2)];
    const a = attribute(proposed, [proposed[0]]);
    expect(a.verdict.status).toBe('insufficient');
    expect(a.verdict.selection).toBeNull();
    expect(a.verdict.needTaken).toBe(VERDICT_MIN_TAKEN - 1);
    expect(a.verdict.needSkipped).toBe(VERDICT_MIN_SKIPPED - 2);
    expect(a.skipped.n).toBe(2);
    expect(a.selectionR).toBeCloseTo(1 - (2 / 3), 9);
  });
  it('at the bar, a clear selection edge is called, and a null one is "no_difference" rather than rounded to a finding', () => {
    const winners = Array.from({ length: 12 }, (_, i) => mk(i, 2));
    const losers = Array.from({ length: 12 }, (_, i) => mk(100 + i, -1));
    const a = attribute([...winners, ...losers], winners);
    expect(a.verdict.status).toBe('ready');
    expect(a.verdict.selection).toBe('picks_beat_list');
    expect(a.verdict.abstention).toBe('skipping_helped');
    // Same-distribution picks: the CI must span zero.
    const mixed = Array.from({ length: 40 }, (_, i) => mk(i, i % 2 ? 1.3 : -1));
    const b = attribute(mixed, mixed.filter((_, i) => i % 4 < 2));
    expect(b.verdict.status).toBe('ready');
    expect(b.verdict.selection).toBe('no_difference');
  });
  it('ungraded observations count toward n but not toward the bar or the mean', () => {
    const a = attribute([mk(1, null), mk(2, 1)], [mk(1, null)]);
    expect(a.taken.n).toBe(1); expect(a.taken.graded).toBe(0); expect(a.taken.expectancyR).toBeNull();
  });
  it('bootstrap CI is deterministic and brackets the point estimate', () => {
    const a = [1, -1, 2, -1, 3, -1, 1, -1], b = [0, 0, 0, 0];
    const ci = bootstrapDiffCI(a, b)!;
    expect(ci).toEqual(bootstrapDiffCI(a, b));
    const diff = a.reduce((x, y) => x + y, 0) / a.length;
    expect(ci[0]).toBeLessThanOrEqual(diff); expect(ci[1]).toBeGreaterThanOrEqual(diff);
    expect(bootstrapDiffCI([1], [])).toBeNull();
  });
  it('groupStats: profit factor, win rate, monthly consistency', () => {
    const g = groupStats([mk(1, 2), mk(2, -1), mk(3, 3, 'S1'), mk(4, -1, 'S1')]);
    expect(g.profitFactor).toBeCloseTo(5 / 2, 9);
    expect(g.winRate).toBe(0.5);
    expect(g.avgFeeR).toBeCloseTo(0.08, 9);
    expect(g.effectiveN).toBe(4);
  });
});

describe('journal end to end on D1', () => {
  it('links a setup entry to its tracked row by geometry, closes with a fill+exit, and attributes YOUR R', async () => {
    const env = makeEnv();
    await ensureTrackedSetupsTable(env);
    await ensureJournalTables(env);
    // Two terminal setups for this device: one taken (closed by hand), one skipped (system loss).
    const ins = `INSERT INTO tracked_setups (id, device_id, symbol, is_crypto, kind, direction, entry, stop_loss, tp1, tp2,
      price_at_setup, model_version, prompt_version, state, terminal, entry_hit, outcome, max_favorable, max_adverse, registered_at, resolved_at)
      VALUES (?, 'dev', ?, 1, 'setup', ?, ?, ?, ?, ?, 100, 14, 'v', 'active', 1, 1, ?, ?, ?, ?, ?)`;
    await env.DB.prepare(ins).bind('ts-1', 'BTCUSDT', 'LONG', 100, 95, 110, 120, 'tp1_win', 12, 2, T0, T0 + 30 * H).run();
    await env.DB.prepare(ins).bind('ts-2', 'ETHUSDT', 'SHORT', 50, 52, 46, 44, 'loss', 1, 2.5, T0 + 200 * H, T0 + 210 * H).run();

    const { id, refId } = await createJournalEntry(env, 'dev', {
      source: 'setup', symbol: 'BTCUSDT', isCrypto: true, direction: 'LONG',
      proposedEntry: 100.05, proposedStop: 95, proposedTarget: 110, fillPrice: 100.5, contracts: 80,
    }, T0 + H);
    expect(refId).toBe('ts-1');                                   // matched within 0.1%

    let a = await computeAttribution(env, 'dev', T0 + 300 * H);
    expect(a.proposed.n).toBe(2);
    expect(a.taken.n).toBe(1); expect(a.skipped.n).toBe(1);
    expect(a.taken.expectancyR).toBeCloseTo(1.0, 9);              // inherits the system's tp1_win R (½·RR1)
    expect(a.skipped.expectancyR).toBe(-1);
    expect(a.verdict.status).toBe('insufficient');

    // Close it by hand at 108 from a 100.5 fill: (108−100.5)/(100.5−95) = 1.3636…
    expect(await updateJournalEntry(env, 'dev', { id, exitPrice: 108, exitReason: 'took profit early' }, T0 + 20 * H)).toBe(true);
    a = await computeAttribution(env, 'dev', T0 + 300 * H);
    expect(a.taken.expectancyR).toBeCloseTo(7.5 / 5.5, 6);
    // Execution drag: same exit from the PROPOSED entry would be (108−100.05)/(100.05−95).
    expect(a.executionN).toBe(1);
    expect(a.executionDragR).toBeCloseTo(7.5 / 5.5 - 7.95 / 5.05, 6);
    expect(a.entries.length).toBe(1);
    expect(a.entries[0].status).toBe('closed');
  });
  it('an entry for another device is invisible and un-updatable', async () => {
    const env = makeEnv();
    const { id } = await createJournalEntry(env, 'dev', { source: 'manual', symbol: 'BTCUSDT', isCrypto: true, direction: 'LONG', fillPrice: 1, proposedStop: 0.9 }, T0);
    expect(await updateJournalEntry(env, 'other', { id, exitPrice: 2 }, T0)).toBe(false);
    const a = await computeAttribution(env, 'other', T0);
    expect(a.entries.length).toBe(0);
  });
});
