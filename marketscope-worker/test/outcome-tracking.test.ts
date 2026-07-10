// Server-side outcome tracking (2026-07-09 thin-client cutover).
// Pure state-machine tests on stepSetup/classifySetupType (synthetic candles, no I/O) +
// D1 glue tests on an in-memory adapter. The state machine is a port of the iOS
// OutcomeTracker (OutcomeTracker.swift:118-335) — several tests below guard the exact
// regressions that bit the iOS implementation (frozen winners at TP1, counted-vs-terminal).
import { describe, it, expect, beforeEach } from 'vitest';
import { D1Adapter } from '../server/d1-adapter';
import {
  classifySetupType, flatReasonFromText, outcomeString, stepSetup,
  ensureTrackedSetupsTable, registerTrackedSetups, resolveTrackedSetups,
  readActiveSetupsForPrompt, readTrackedSetups,
  TRACKED_MODEL_VERSION, TRACKED_PROMPT_VERSION, _resetForTests,
  type TrackedRow, type Point,
} from '../src/outcome-tracking';

const T0 = 1_700_000_000_000;               // fixed epoch base
const H = 3600_000, M15 = 900_000;

// In-memory KV stub (get-only is all the module needs).
function kvStub(entries: Record<string, string> = {}) {
  return { get: async (k: string) => entries[k] ?? null };
}

// A LONG setup row: entry 100, stop 95 (risk 5), tp1 110, tp2 120, registered at T0,
// price at setup 100 (market-style entry).
function longRow(over: Partial<TrackedRow> = {}): TrackedRow {
  return {
    id: 'row-1', deviceId: 'dev-1', symbol: 'BTCUSDT', isCrypto: true, kind: 'setup',
    direction: 'LONG', entry: 100, stopLoss: 95, tp1: 110, tp2: 120, reasoning: '',
    priceAtSetup: 100, atr: 2, mlAtRegistration: 0.7, conviction: null,
    modelVersion: TRACKED_MODEL_VERSION, promptVersion: TRACKED_PROMPT_VERSION,
    archetype: 'MOMENTUM_CONTINUATION', setupType: 'market',
    state: 'active', terminal: false,
    entryHit: false, entryHitAt: null, stopHit: false, tp1Hit: false, tp2Hit: false,
    breakevenActivated: false, partialTaken: false, maxFavorable: 0, maxAdverse: 0,
    outcome: null, invalidReason: null, flatReason: null, falseFlat: null, priceAfter: null,
    pendingExpiresAt: null, registeredAt: T0, resolvedAt: null, lastCheckedAt: null,
    outcomeRowId: null, ...over,
  };
}

function pt(open: number, high: number, low: number, time: number): Point {
  return { open, high, low, time };
}

describe('classifySetupType (SetupType.classify port)', () => {
  it('distance boundary: 0.29% is market, 0.31% is conditional', () => {
    expect(classifySetupType(100.29, 100, 'plain entry')).toBe('market');
    expect(classifySetupType(100.31, 100, 'plain entry')).toBe('conditional');
  });
  it('conditional keywords force conditional even at zero distance', () => {
    for (const kw of ['wait for', 'close above', 'close below', 'confirms', 'breakout', 'rejection', 'retest']) {
      expect(classifySetupType(100, 100, `Enter on ${kw} of the level`)).toBe('conditional');
    }
    expect(classifySetupType(100, 100, 'simple momentum entry')).toBe('market');
  });
});

describe('flatReasonFromText', () => {
  it('maps analysis text to the iOS reason taxonomy', () => {
    expect(flatReasonFromText('Setup BLOCKED by kill conditions')).toBe('KILL');
    expect(flatReasonFromText('FLAT per Rule 2')).toBe('FLAT_Rule2');
    expect(flatReasonFromText('NO SETUP — stand aside')).toBe('FLAT');
    expect(flatReasonFromText('quiet tape, nothing to do')).toBe('NO_SETUP');
  });
});

describe('stepSetup — ACTIVE state machine', () => {
  it('market entry within 0.1% of priceAtSetup fires on the first point', () => {
    const { row } = stepSetup(longRow(), [pt(100, 101, 99.8, T0 + M15)], { nowMs: T0 + H });
    expect(row.entryHit).toBe(true);
    expect(row.entryHitAt).toBe(T0 + M15);
  });

  it('pullback LONG (entry below priceAtSetup) fires only when price falls to entry', () => {
    const base = longRow({ entry: 98, stopLoss: 94, tp1: 106, tp2: 112, priceAtSetup: 100 });
    // High touches 106 but low never reaches 98 → NOT entered (and no phantom TP1).
    let res = stepSetup(base, [pt(100, 106, 99, T0 + M15)], { nowMs: T0 + H });
    expect(res.row.entryHit).toBe(false);
    expect(res.row.tp1Hit).toBe(false);
    // Low reaches 98 → entered.
    res = stepSetup(base, [pt(100, 101, 97.9, T0 + M15)], { nowMs: T0 + H });
    expect(res.row.entryHit).toBe(true);
  });

  it('breakout LONG (entry above priceAtSetup) fires when price rises to entry', () => {
    const base = longRow({ entry: 103, stopLoss: 99, tp1: 111, tp2: null, priceAtSetup: 100 });
    let res = stepSetup(base, [pt(100, 102.9, 99.5, T0 + M15)], { nowMs: T0 + H });
    expect(res.row.entryHit).toBe(false);
    res = stepSetup(base, [pt(100, 103.2, 99.5, T0 + M15)], { nowMs: T0 + H });
    expect(res.row.entryHit).toBe(true);
  });

  it('legacy priceAtSetup=0 falls back to the direction-only check', () => {
    const base = longRow({ priceAtSetup: 0 });
    const res = stepSetup(base, [pt(101, 102, 99.9, T0 + M15)], { nowMs: T0 + H });
    expect(res.row.entryHit).toBe(true);   // LONG: low <= entry
  });

  it('straight loss: stop cross → terminal + outcome "loss"', () => {
    const points = [pt(100, 100.5, 99.5, T0 + M15), pt(99.5, 99.8, 94.5, T0 + 2 * M15)];
    const { row } = stepSetup(longRow(), points, { nowMs: T0 + H });
    expect(row.stopHit).toBe(true);
    expect(row.terminal).toBe(true);
    expect(row.outcome).toBe('loss');
    expect(row.resolvedAt).not.toBeNull();
  });

  it('TP1 then BE stop → "tp1_win"; post-TP1 bars keep tracking (frozen-winners guard)', () => {
    const points = [
      pt(100, 100.5, 99.8, T0 + M15),        // entry
      pt(102, 110.5, 101.5, T0 + 2 * M15),   // TP1 hit (also >= +1R → BE activates; low stays above entry)
      pt(108, 109, 99.9, T0 + 3 * M15),      // BE stop at entry (low 99.9 <= 100)
    ];
    const { row } = stepSetup(longRow(), points, { nowMs: T0 + H });
    expect(row.tp1Hit).toBe(true);
    expect(row.breakevenActivated).toBe(true);
    expect(row.stopHit).toBe(true);
    expect(row.outcome).toBe('tp1_win');
    // Excursions must include the post-TP1 bar range (tracking continued past TP1).
    expect(row.maxFavorable).toBeCloseTo(10.5, 5);
  });

  it('TP1 then TP2 → "tp2_win" (a post-TP1 bar must still register TP2)', () => {
    const points = [
      pt(100, 100.5, 99.8, T0 + M15),
      pt(102, 111, 101.5, T0 + 2 * M15),     // TP1 (low stays above entry — no same-bar BE stop)
      pt(111, 120.5, 110, T0 + 3 * M15),     // TP2
    ];
    const { row } = stepSetup(longRow(), points, { nowMs: T0 + H });
    expect(row.tp2Hit).toBe(true);
    expect(row.terminal).toBe(true);
    expect(row.outcome).toBe('tp2_win');
  });

  it('+1R BE activation without TP1, then stop at entry → "partial_be"', () => {
    // tp1 at 112 (further than +1R=105) so BE activates before TP1 can hit.
    const base = longRow({ tp1: 112, tp2: null });
    const points = [
      pt(100, 100.5, 99.8, T0 + M15),
      pt(102, 105.5, 101.5, T0 + 2 * M15),   // +1.1R → BE activates, TP1 (112) not hit
      pt(105, 105.5, 99.9, T0 + 3 * M15),    // BE stop at entry
    ];
    const { row } = stepSetup(base, points, { nowMs: T0 + H });
    expect(row.breakevenActivated).toBe(true);
    expect(row.partialTaken).toBe(true);
    expect(row.tp1Hit).toBe(false);
    expect(row.stopHit).toBe(true);
    expect(row.outcome).toBe('partial_be');
  });

  it('same-bar stop+TP1 ambiguity resolves by open proximity', () => {
    const wideBar = pt(96, 110.5, 94.5, T0 + 2 * M15);   // hits both stop and TP1 (110)
    const entryBar = pt(100, 100.5, 99.8, T0 + M15);
    // Open 96 is nearer the stop. NOTE (iOS parity): a bar reaching TP1 is >= +1R, so BE
    // activates BEFORE the stop check — the stop that fires is the BE stop at entry, and
    // partialTaken is already set → outcome 'partial_be' (exactly what the iOS loop does).
    let res = stepSetup(longRow(), [entryBar, wideBar], { nowMs: T0 + H });
    expect(res.row.stopHit).toBe(true);
    expect(res.row.tp1Hit).toBe(false);
    expect(res.row.partialTaken).toBe(true);
    expect(res.row.outcome).toBe('partial_be');
    // Open 109 is nearer TP1 → tp1 hit, tracking continues.
    const wideBarNearTp1 = pt(109, 110.5, 94.5, T0 + 2 * M15);
    res = stepSetup(longRow(), [entryBar, wideBarNearTp1], { nowMs: T0 + H });
    expect(res.row.tp1Hit).toBe(true);
    expect(res.row.stopHit).toBe(false);
  });

  it('6h stop tighten (candle-time based): stagnant trade stopped at 0.7R', () => {
    // Risk 5 → tightened stop at entry - 3.5 = 96.5. maxFavorable stays < 0.5R (2.5).
    const points = [
      pt(100, 100.5, 99.8, T0 + M15),                 // entry
      pt(100, 101, 99, T0 + 2 * M15),                 // meander (fav 1 < 2.5)
      pt(99, 99.5, 96.4, T0 + M15 + 7 * H),           // 7h after entry: hits 96.5 but not 95
    ];
    const { row } = stepSetup(longRow(), points, { nowMs: T0 + 8 * H });
    expect(row.stopHit).toBe(true);
    expect(row.outcome).toBe('loss');
  });

  it('7-day prune: untriggered active setup → terminal "not_triggered"', () => {
    const base = longRow({ entry: 90, priceAtSetup: 100 });   // never reached
    const { row } = stepSetup(base, [pt(100, 101, 99, T0 + M15)], { nowMs: T0 + 8 * 86400_000 });
    expect(row.terminal).toBe(true);
    expect(row.outcome).toBe('not_triggered');
    expect(row.entryHit).toBe(false);
  });

  it('is idempotent over overlapping candle windows', () => {
    const points = [
      pt(100, 100.5, 99.8, T0 + M15),
      pt(100, 111, 99.9, T0 + 2 * M15),
      pt(111, 120.5, 110, T0 + 3 * M15),
    ];
    const once = stepSetup(longRow(), points, { nowMs: T0 + H }).row;
    const twice = stepSetup(once, points, { nowMs: T0 + 2 * H }).row;   // re-feed same bars
    expect(twice).toEqual(once);
  });
});

describe('stepSetup — PENDING state machine', () => {
  const pendingRow = (over: Partial<TrackedRow> = {}) => longRow({
    state: 'pending', setupType: 'conditional', entry: 96, priceAtSetup: 100,
    pendingExpiresAt: T0 + 12 * H, ...over,
  });

  it('expires at 12h', () => {
    const { row } = stepSetup(pendingRow(), [], { nowMs: T0 + 12 * H + 1000 });
    expect(row.state).toBe('expired');
    expect(row.terminal).toBe(true);
    expect(row.outcome).toBe('expired');
    expect(row.invalidReason).toContain('12h');
  });

  it('entry touch with passing re-eval → active with entryHitAt of the touching bar', () => {
    const touch = pt(97, 98, 95.9, T0 + 2 * H);
    const { row } = stepSetup(pendingRow(), [touch], { nowMs: T0 + 2 * H, mlProb: 0.65 });
    expect(row.state).toBe('active');
    expect(row.entryHit).toBe(true);
    expect(row.entryHitAt).toBe(T0 + 2 * H);
  });

  it('proactive invalidation at >=1h: ML below 50%', () => {
    const { row } = stepSetup(pendingRow(), [], { nowMs: T0 + 2 * H, mlProb: 0.49 });
    expect(row.state).toBe('invalidated');
    expect(row.outcome).toBe('invalidated');
    expect(row.invalidReason).toContain('below 50%');
  });

  it('proactive invalidation: ML dropped >15pp from registration', () => {
    const { row } = stepSetup(pendingRow({ mlAtRegistration: 0.72 }), [], { nowMs: T0 + 2 * H, mlProb: 0.55 });
    expect(row.state).toBe('invalidated');
    expect(row.invalidReason).toContain('dropped 17pp');
  });

  it('proactive invalidation: persistence collapse below 40%', () => {
    const { row } = stepSetup(pendingRow(), [], { nowMs: T0 + 2 * H, mlProb: 0.7, mlPersistence: 0.39 });
    expect(row.state).toBe('invalidated');
    expect(row.invalidReason).toContain('Persistence');
  });

  it('proactive invalidation: kill conditions from the prompt KV state', () => {
    const { row } = stepSetup(pendingRow(), [], { nowMs: T0 + 2 * H, mlProb: 0.7, killDur: { divergence: 2 } });
    expect(row.state).toBe('invalidated');
    expect(row.invalidReason).toContain('divergence');
  });

  it('young pending (<1h) is NOT proactively re-evaluated', () => {
    const { row } = stepSetup(pendingRow(), [], { nowMs: T0 + 30 * 60_000, mlProb: 0.30 });
    expect(row.state).toBe('pending');   // bad ML, but too young for the proactive check
  });
});

describe('stepSetup — FLAT grading (24h horizon)', () => {
  const flatRow = (over: Partial<TrackedRow> = {}) => longRow({
    kind: 'flat', direction: null, entry: null, stopLoss: null, tp1: null, tp2: null,
    priceAtSetup: 100, flatReason: 'FLAT', ...over,
  });

  it('before 24h: unchanged', () => {
    const { row, changed } = stepSetup(flatRow(), [pt(103, 103, 103, T0 + 23 * H)], { nowMs: T0 + 23 * H });
    expect(changed).toBe(false);
    expect(row.terminal).toBe(false);
  });

  it('at 24h with a 1.6% move → flat_false (false conservatism)', () => {
    const { row } = stepSetup(flatRow(), [pt(101.6, 101.6, 101.6, T0 + 25 * H)], { nowMs: T0 + 25 * H });
    expect(row.terminal).toBe(true);
    expect(row.falseFlat).toBe(true);
    expect(row.outcome).toBe('flat_false');
    expect(row.priceAfter).toBeCloseTo(101.6, 5);
  });

  it('at 24h with a 1.4% move → flat_true (correct FLAT)', () => {
    const { row } = stepSetup(flatRow(), [pt(101.4, 101.4, 101.4, T0 + 25 * H)], { nowMs: T0 + 25 * H });
    expect(row.falseFlat).toBe(false);
    expect(row.outcome).toBe('flat_true');
  });
});

describe('outcomeString', () => {
  it('matches the TradeOutcome.result table', () => {
    expect(outcomeString(longRow({ state: 'invalidated' }))).toBe('invalidated');
    expect(outcomeString(longRow({ state: 'expired' }))).toBe('expired');
    expect(outcomeString(longRow({ entryHit: false }))).toBe('not_triggered');
    expect(outcomeString(longRow({ entryHit: true, tp2Hit: true }))).toBe('tp2_win');
    expect(outcomeString(longRow({ entryHit: true, tp1Hit: true, stopHit: true }))).toBe('tp1_win');
    expect(outcomeString(longRow({ entryHit: true, stopHit: true, partialTaken: true }))).toBe('partial_be');
    expect(outcomeString(longRow({ entryHit: true, stopHit: true }))).toBe('loss');
    expect(outcomeString(longRow({ entryHit: true }))).toBe('open');
  });
});

// ─── D1 glue ─────────────────────────────────────────────────────────────────────────────────

const TRADE_OUTCOMES_DDL = `CREATE TABLE trade_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL,
  entry_price REAL NOT NULL, stop_loss REAL, tp1 REAL, tp2 REAL,
  ml_probability REAL, daily_score REAL, four_h_score REAL, conviction TEXT,
  opened_at TEXT DEFAULT CURRENT_TIMESTAMP, closed_at TEXT,
  outcome TEXT, pnl_percent REAL, notes TEXT,
  model_version INTEGER, prompt_version TEXT
)`;

function makeEnv(kv: Record<string, string> = {}) {
  const db = new D1Adapter(':memory:');
  return { DB: db, ALERTS: kvStub(kv) } as any;
}

const INDICATORS = [
  { bias: 'Bullish', price: 100, mlWinProbability: 0.7, adx: { adx: 30 }, ema20: 3, ema50: 2, ema200: 1, bollingerBands: null },
  { bias: 'Bullish', price: 100, atr: { atr: 2 }, adx: { adx: 28 }, ema20: 3, ema50: 2, ema200: 1, bollingerBands: null },
  { bias: 'Bullish', price: 100, adx: { adx: 25 }, ema20: 3, ema50: 2, ema200: 1, bollingerBands: null },
];

describe('registration + resolution (D1 glue)', () => {
  beforeEach(() => _resetForTests());

  it('registers setups with stamps; conditional gets pending state + a pending_setups glue row', async () => {
    const env = makeEnv();
    await registerTrackedSetups(env, {
      deviceId: 'dev-1', symbol: 'BTCUSDT', isCrypto: true,
      setups: [
        { direction: 'LONG', entry: 100.05, stopLoss: 95, tp1: 110, tp2: 120, reasoning: 'momentum entry' },
        { direction: 'SHORT', entry: 104, stopLoss: 108, tp1: 98, tp2: null, reasoning: 'wait for rejection' },
      ],
      analysisText: 'analysis', livePrice: 100, indicators: INDICATORS, nowMs: T0,
    });
    const { setups } = await readTrackedSetups(env, 'dev-1');
    expect(setups).toHaveLength(2);
    const market = setups.find((s: any) => s.direction === 'LONG');
    const conditional = setups.find((s: any) => s.direction === 'SHORT');
    expect(market.state).toBe('active');
    expect(market.setupType).toBe('market');
    expect(market.modelVersion).toBe(TRACKED_MODEL_VERSION);
    expect(market.promptVersion).toBe(TRACKED_PROMPT_VERSION);
    expect(market.archetype).toBeTruthy();
    expect(market.atr).toBeCloseTo(2, 5);
    expect(market.priceAtSetup).toBeCloseTo(100, 5);
    expect(conditional.state).toBe('pending');
    expect(conditional.pendingExpiresAt).toBe(T0 + 12 * H);
    // Glue row for the entry-zone APNs (crypto conditional only).
    const glue = await env.DB.prepare('SELECT * FROM pending_setups').all();
    expect(glue.results).toHaveLength(1);
    expect(glue.results[0].id).toBe(conditional.id);
  });

  it('zero setups + analysis text registers ONE flat row with the mapped reason', async () => {
    const env = makeEnv();
    await registerTrackedSetups(env, {
      deviceId: 'dev-1', symbol: 'BTCUSDT', isCrypto: true, setups: [],
      analysisText: 'Envelope BLOCKED by kill conditions', livePrice: 100,
      indicators: INDICATORS, nowMs: T0,
    });
    const { flats, setups } = await readTrackedSetups(env, 'dev-1');
    expect(setups).toHaveLength(0);
    expect(flats).toHaveLength(1);
    expect(flats[0].flatReason).toBe('KILL');
    expect(flats[0].priceAtSetup).toBeCloseTo(100, 5);
  });

  it('stock registration is skipped off-hours', async () => {
    const env = makeEnv();
    await registerTrackedSetups(env, {
      deviceId: 'dev-1', symbol: 'AAPL', isCrypto: false,
      setups: [{ direction: 'LONG', entry: 100, stopLoss: 95, tp1: 110, tp2: null }],
      analysisText: 'analysis', livePrice: 100, indicators: INDICATORS, nowMs: T0,
      marketOpen: false,
    });
    const { setups } = await readTrackedSetups(env, 'dev-1');
    expect(setups).toHaveLength(0);
  });

  it('resolves a winner end-to-end: counted outcome lands in trade_outcomes with outcome_row_id', async () => {
    const env = makeEnv();
    await env.DB.prepare(TRADE_OUTCOMES_DDL).run();
    await registerTrackedSetups(env, {
      deviceId: 'dev-1', symbol: 'BTCUSDT', isCrypto: true,
      setups: [{ direction: 'LONG', entry: 100.05, stopLoss: 95, tp1: 110, tp2: 120, reasoning: 'momentum' }],
      analysisText: 'analysis', livePrice: 100, indicators: INDICATORS, nowMs: T0,
    });
    const klines = [
      { time: T0 + M15, open: 100, high: 100.5, low: 99.8, close: 100.2 },
      { time: T0 + 2 * M15, open: 102, high: 111, low: 100.6, close: 110.5 },
      { time: T0 + 3 * M15, open: 110.5, high: 120.5, low: 110, close: 119 },
    ];
    await resolveTrackedSetups(env, new Map([['BTCUSDT', { isCrypto: true, last4HClose: 119, mlProb: 0.7 }]]), {
      cryptoKlines: async () => klines,
      livePrice: async () => 119,
      stock1hMap: async () => ({}),
    }, { force: true, nowMs: T0 + H });

    const { setups } = await readTrackedSetups(env, 'dev-1');
    expect(setups[0].terminal).toBe(true);
    expect(setups[0].outcome).toBe('tp2_win');
    expect(setups[0].outcomeRowId).not.toBeNull();
    const outcomes = await env.DB.prepare('SELECT * FROM trade_outcomes').all();
    expect(outcomes.results).toHaveLength(1);
    expect(outcomes.results[0].outcome).toBe('tp2_win');
    expect(outcomes.results[0].model_version).toBe(TRACKED_MODEL_VERSION);
    expect(outcomes.results[0].prompt_version).toBe(TRACKED_PROMPT_VERSION);
    expect(outcomes.results[0].closed_at).toBeTruthy();
  });

  it('non-counted terminals (expired pending) do NOT insert into trade_outcomes; glue row deleted', async () => {
    const env = makeEnv();
    await env.DB.prepare(TRADE_OUTCOMES_DDL).run();
    await registerTrackedSetups(env, {
      deviceId: 'dev-1', symbol: 'BTCUSDT', isCrypto: true,
      setups: [{ direction: 'SHORT', entry: 104, stopLoss: 108, tp1: 98, tp2: null, reasoning: 'wait for rejection' }],
      analysisText: 'analysis', livePrice: 100, indicators: INDICATORS, nowMs: T0,
    });
    expect((await env.DB.prepare('SELECT * FROM pending_setups').all()).results).toHaveLength(1);

    await resolveTrackedSetups(env, new Map([['BTCUSDT', { isCrypto: true, last4HClose: 100, mlProb: 0.7 }]]), {
      cryptoKlines: async () => [],
      livePrice: async () => 100,
      stock1hMap: async () => ({}),
    }, { force: true, nowMs: T0 + 13 * H });   // past the 12h pending expiry

    const { setups } = await readTrackedSetups(env, 'dev-1');
    expect(setups[0].state).toBe('expired');
    expect(setups[0].terminal).toBe(true);
    expect((await env.DB.prepare('SELECT * FROM trade_outcomes').all()).results).toHaveLength(0);
    expect((await env.DB.prepare('SELECT * FROM pending_setups').all()).results).toHaveLength(0);
  });

  it('readActiveSetupsForPrompt returns only active+entry-hit rows in the ActiveSetup shape', async () => {
    const env = makeEnv();
    await env.DB.prepare(TRADE_OUTCOMES_DDL).run();
    await registerTrackedSetups(env, {
      deviceId: 'dev-1', symbol: 'BTCUSDT', isCrypto: true,
      setups: [{ direction: 'LONG', entry: 100.05, stopLoss: 95, tp1: 110, tp2: 120, reasoning: 'momentum' }],
      analysisText: 'analysis', livePrice: 100, indicators: INDICATORS, nowMs: T0,
    });
    // Advance through entry + TP1 (not terminal): active trade with management state.
    await resolveTrackedSetups(env, new Map([['BTCUSDT', { isCrypto: true, last4HClose: 111, mlProb: 0.7 }]]), {
      cryptoKlines: async () => [
        { time: T0 + M15, open: 100, high: 100.5, low: 99.8, close: 100.2 },
        { time: T0 + 2 * M15, open: 102, high: 111, low: 100.6, close: 110.5 },
      ],
      livePrice: async () => 110.5,
      stock1hMap: async () => ({}),
    }, { force: true, nowMs: T0 + H });

    const active = await readActiveSetupsForPrompt(env, 'dev-1', 'BTCUSDT');
    expect(active).toHaveLength(1);
    expect(active[0].direction).toBe('LONG');
    expect(active[0].risk).toBeCloseTo(5.05, 5);
    expect(active[0].tp1Hit).toBe(true);
    expect(active[0].breakevenActivated).toBe(true);
    expect(active[0].entryHitTimeMs).toBe(T0 + M15);
    expect(active[0].maxFavorable).toBeGreaterThan(10);
    // Wrong device / wrong symbol → empty.
    expect(await readActiveSetupsForPrompt(env, 'dev-2', 'BTCUSDT')).toHaveLength(0);
    expect(await readActiveSetupsForPrompt(env, 'dev-1', 'ETHUSDT')).toHaveLength(0);
  });

  it('readTrackedSetups isolates devices', async () => {
    const env = makeEnv();
    for (const dev of ['dev-A', 'dev-B']) {
      await registerTrackedSetups(env, {
        deviceId: dev, symbol: 'BTCUSDT', isCrypto: true,
        setups: [{ direction: 'LONG', entry: 100, stopLoss: 95, tp1: 110, tp2: null }],
        analysisText: 'analysis', livePrice: 100, indicators: INDICATORS, nowMs: T0,
      });
    }
    const a = await readTrackedSetups(env, 'dev-A');
    expect(a.setups).toHaveLength(1);
    expect(a.setups[0].deviceId ?? 'dev-A').toBeTruthy();
    const b = await readTrackedSetups(env, 'dev-B');
    expect(b.setups).toHaveLength(1);
    expect(a.setups[0].id).not.toBe(b.setups[0].id);
  });
});
