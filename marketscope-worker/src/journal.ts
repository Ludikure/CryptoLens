// Phase 3 — JOURNAL + ATTRIBUTION (corrected spec §42; definitions pre-declared in
// docs/research/journal-attribution.md BEFORE the first entry existed).
//
// The question: when you act, does it beat not acting — and when you choose which proposals to
// take, does your choosing beat taking them all? Nothing here could answer it before: the system
// graded what it PROPOSED and kept no record of what the user DID, and scanner rows were never
// logged at all.
//
// Three tables' worth of responsibility, one module:
//   opportunity_log   every scanner row, per device, deduped by 4H bar — graded at +72h on the
//                     box's own 1h candles at the structure it was priced at (the forward log
//                     §35 asks for, scoped to the scanner)
//   journal_entries   what the user took, with fill / size / exit when they give them
//   attribution       Tier 1 only (§25): expectancy, win rate, MFE/MAE, profit factor, fee
//                     burden, effective n (§21), period consistency — and the two numbers,
//                     SELECTION and ABSTENTION, with bootstrap CIs and a pre-declared verdict
//                     rule that renders nothing until taken >= 10 AND skipped >= 10.
import type { Env } from './index';
import { ensureTrackedSetupsTable } from './outcome-tracking';

// ─── Tables ──────────────────────────────────────────────────────────────────────────────────

let tablesReady = false;
export function _resetJournalForTests(): void { tablesReady = false; }

export async function ensureJournalTables(env: Env): Promise<void> {
  if (tablesReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS opportunity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    symbol TEXT NOT NULL, is_crypto INTEGER NOT NULL, direction TEXT NOT NULL,
    bar_ms INTEGER NOT NULL, logged_at INTEGER NOT NULL,
    entry REAL NOT NULL, stop REAL NOT NULL, target REAL NOT NULL,
    expected_value_r REAL NOT NULL, gross_r REAL, fee_burden_r REAL NOT NULL DEFAULT 0,
    win_prob REAL, head_shippable INTEGER, crash_multiplier REAL, fear_greed REAL,
    shown INTEGER NOT NULL DEFAULT 1,
    structure_id TEXT NOT NULL, target_r REAL NOT NULL, horizon_hours REAL NOT NULL,
    resolve_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0, fav_r REAL, adv_r REAL, exit_r REAL, outcome TEXT,
    UNIQUE(device_id, symbol, direction, bar_ms, structure_id)
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_opplog_unresolved ON opportunity_log(resolved, resolve_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_opplog_device ON opportunity_log(device_id, logged_at DESC)').run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,                 -- 'setup' | 'opportunity' | 'manual'
    ref_id TEXT,                          -- tracked_setups.id or opportunity_log.id (as text)
    symbol TEXT NOT NULL, is_crypto INTEGER NOT NULL, direction TEXT NOT NULL,
    proposed_entry REAL, proposed_stop REAL, proposed_target REAL,
    fill_price REAL NOT NULL, contracts REAL, risk_usd REAL, note TEXT,
    exit_price REAL, exit_at INTEGER, exit_reason TEXT,
    status TEXT NOT NULL DEFAULT 'open'   -- 'open' | 'closed'
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_journal_device ON journal_entries(device_id, created_at DESC)').run();
  tablesReady = true;
}

// ─── Opportunity log (the scanner's forward record) ──────────────────────────────────────────

export interface OppLogRow {
  symbol: string; isCrypto: boolean; direction: 'LONG' | 'SHORT';
  entry: number; stop: number; target: number;
  expectedValueR: number; grossR?: number | null; feeBurdenR: number; winProb?: number | null;
  headShippable?: boolean | null; crashMultiplier?: number | null; fearGreed?: number | null;
  shown: boolean;
}

const FOUR_H = 4 * 3600_000;
export function barBucket(ms: number): number { return Math.floor(ms / FOUR_H) * FOUR_H; }

/**
 * Insert-or-ignore every row of one scan. Keyed on the 4H bar so the same book re-fetched every
 * few minutes lands ONE row, and per device so "proposed to you" means what it says.
 */
export async function logOpportunities(
  env: Env, deviceId: string, rows: OppLogRow[],
  structure: { id: string; targetR: number; holdingHorizonHours: number }, nowMs: number,
): Promise<number> {
  if (!rows.length) return 0;
  await ensureJournalTables(env);
  const bar = barBucket(nowMs);
  const resolveAt = nowMs + structure.holdingHorizonHours * 3600_000;
  const stmts = rows.map(r => env.DB.prepare(`INSERT OR IGNORE INTO opportunity_log
    (device_id, symbol, is_crypto, direction, bar_ms, logged_at, entry, stop, target,
     expected_value_r, gross_r, fee_burden_r, win_prob, head_shippable, crash_multiplier, fear_greed,
     shown, structure_id, target_r, horizon_hours, resolve_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      deviceId, r.symbol, r.isCrypto ? 1 : 0, r.direction, bar, nowMs, r.entry, r.stop, r.target,
      r.expectedValueR, r.grossR ?? null, r.feeBurdenR, r.winProb ?? null,
      r.headShippable == null ? null : (r.headShippable ? 1 : 0),
      r.crashMultiplier ?? null, r.fearGreed ?? null,
      r.shown ? 1 : 0, structure.id, structure.targetR, structure.holdingHorizonHours, resolveAt));
  const res = await env.DB.batch(stmts);
  return res.reduce((n: number, r: any) => n + (r?.meta?.changes ?? 0), 0);
}

export interface Bar { time: number; open: number; high: number; low: number; close: number }

/**
 * Grade one row at the structure it was priced at. First bar STRICTLY after the scan; target
 * first → +targetR, stop first → −1, neither → horizon close in R. Same-bar target AND stop
 * counts as the STOP: 1h bars cannot order intrabar, and the conservative reading is the one
 * that cannot flatter the record. fav/adv are the max excursions in R over the window.
 */
export function gradeOpportunity(
  row: { direction: string; entry: number; stop: number; target: number; targetR: number; loggedAt: number; resolveAt: number },
  bars: Bar[],
): { outcome: 'target' | 'stop' | 'horizon'; exitR: number; favR: number; advR: number } | null {
  const risk = Math.abs(row.entry - row.stop);
  if (!(risk > 0)) return null;
  const long = row.direction === 'LONG';
  const inWindow = bars.filter(b => b.time > row.loggedAt && b.time <= row.resolveAt)
                       .sort((a, b) => a.time - b.time);
  if (!inWindow.length) return null;
  let favR = 0, advR = 0;
  for (const b of inWindow) {
    const fav = long ? (b.high - row.entry) / risk : (row.entry - b.low) / risk;
    const adv = long ? (row.entry - b.low) / risk : (b.high - row.entry) / risk;
    favR = Math.max(favR, fav); advR = Math.max(advR, adv);
    const hitStop = long ? b.low <= row.stop : b.high >= row.stop;
    const hitTarget = long ? b.high >= row.target : b.low <= row.target;
    if (hitStop) return { outcome: 'stop', exitR: -1, favR, advR };       // stop wins a tie
    if (hitTarget) return { outcome: 'target', exitR: row.targetR, favR, advR };
  }
  const last = inWindow[inWindow.length - 1];
  const exitR = long ? (last.close - row.entry) / risk : (row.entry - last.close) / risk;
  return { outcome: 'horizon', exitR, favR, advR };
}

/**
 * Resolve every due row. Candles come from the box's own 1h archive (`candles` table, ms
 * timestamps — verified 2026-08-28 against SOLUSDT) with an optional fetcher fallback for a
 * symbol the archive does not cover. A row whose window has no bars at all stays unresolved and
 * is retried next pass; a row more than 7 days past due with still no bars is marked
 * `outcome='ungraded'` so it cannot be retried forever.
 */
export async function resolveOpportunityLog(
  env: Env, nowMs: number,
  fetchBars?: (symbol: string, isCrypto: boolean, fromMs: number, toMs: number) => Promise<Bar[]>,
): Promise<{ graded: number; ungraded: number }> {
  await ensureJournalTables(env);
  const due = await env.DB.prepare(
    'SELECT * FROM opportunity_log WHERE resolved = 0 AND resolve_at <= ? ORDER BY resolve_at LIMIT 200'
  ).bind(nowMs).all();
  const rows: any[] = due.results || [];
  let graded = 0, ungraded = 0;
  const cache = new Map<string, Bar[]>();
  for (const r of rows) {
    const key = `${r.symbol}|${r.logged_at}|${r.resolve_at}`;
    let bars = cache.get(key);
    if (!bars) {
      const q = await env.DB.prepare(
        `SELECT timestamp AS time, open, high, low, close FROM candles
         WHERE symbol = ? AND interval = '1h' AND timestamp > ? AND timestamp <= ? ORDER BY timestamp`
      ).bind(r.symbol, r.logged_at, r.resolve_at).all();
      bars = ((q.results || []) as any[]).map(b => ({
        time: Number(b.time), open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
      }));
      if (!bars.length && fetchBars) {
        try { bars = await fetchBars(r.symbol, !!r.is_crypto, r.logged_at, r.resolve_at); } catch { bars = []; }
      }
      cache.set(key, bars);
    }
    const g = gradeOpportunity({
      direction: r.direction, entry: r.entry, stop: r.stop, target: r.target, targetR: r.target_r,
      loggedAt: r.logged_at, resolveAt: r.resolve_at,
    }, bars);
    if (g) {
      await env.DB.prepare(
        'UPDATE opportunity_log SET resolved = 1, fav_r = ?, adv_r = ?, exit_r = ?, outcome = ? WHERE id = ?'
      ).bind(g.favR, g.advR, g.exitR, g.outcome, r.id).run();
      graded++;
    } else if (nowMs - r.resolve_at > 7 * 86400_000) {
      await env.DB.prepare("UPDATE opportunity_log SET resolved = 1, outcome = 'ungraded' WHERE id = ?").bind(r.id).run();
      ungraded++;
    }
  }
  return { graded, ungraded };
}

// ─── Realised R for a system-managed setup ──────────────────────────────────────────────────

/**
 * The cron simulates the composite-band execution (half off at TP1, stop to break-even, runner
 * to TP2 — strategy-targets-bands). Its terminal outcome string maps to a realised R under that
 * management. GROSS: the analysis path does not model fees, and the number is labelled so.
 *   loss        −1
 *   partial_be  +0.5      half booked at the +1R partial, half stopped at break-even
 *   tp1_win     +½·RR₁    half at TP1, runner stopped at break-even
 *   tp2_win     +½·RR₁ + ½·RR₂
 * Anything else (invalidated / expired / not_triggered / open) never held a position → null.
 */
export function realizedRForSetup(row: {
  outcome: string | null; direction: string | null; entry: number | null; stopLoss: number | null;
  tp1: number | null; tp2: number | null;
}): number | null {
  if (!row.outcome || row.entry == null || row.stopLoss == null) return null;
  const risk = Math.abs(row.entry - row.stopLoss);
  if (!(risk > 0)) return null;
  const rr = (p: number | null) => p == null ? null : Math.abs(p - row.entry!) / risk;
  const rr1 = rr(row.tp1), rr2 = rr(row.tp2 ?? row.tp1);
  switch (row.outcome) {
    case 'loss': return -1;
    case 'partial_be': return 0.5;
    case 'tp1_win': return rr1 == null ? null : 0.5 * rr1;
    case 'tp2_win': return (rr1 == null || rr2 == null) ? null : 0.5 * rr1 + 0.5 * rr2;
    default: return null;
  }
}

/** Your realised R when you gave a fill and an exit — the only YOUR-result figure in the app. */
export function realizedRForFill(direction: string, fill: number, stop: number, exit: number): number | null {
  const risk = Math.abs(fill - stop);
  if (!(risk > 0)) return null;
  return direction === 'LONG' ? (exit - fill) / risk : (fill - exit) / risk;
}

// ─── Journal CRUD ────────────────────────────────────────────────────────────────────────────

export interface JournalCreate {
  source: 'setup' | 'opportunity' | 'manual';
  refId?: string | null;
  symbol: string; isCrypto: boolean; direction: 'LONG' | 'SHORT';
  proposedEntry?: number | null; proposedStop?: number | null; proposedTarget?: number | null;
  fillPrice: number; contracts?: number | null; riskUsd?: number | null; note?: string | null;
}

/**
 * Link a 'setup' entry to its tracked_setups row when the client could not name it — the
 * analysis response mints setup ids that differ from the tracked row's, so the phone usually
 * cannot. Match on (device, symbol, direction, entry within 0.1%) over the last 48h, newest wins.
 */
export async function findTrackedRef(
  env: Env, deviceId: string, symbol: string, direction: string, entry: number, nowMs: number,
): Promise<string | null> {
  const tol = Math.abs(entry) * 0.001;
  try {
    const r: any = await env.DB.prepare(
      `SELECT id FROM tracked_setups WHERE device_id = ? AND symbol = ? AND kind = 'setup'
         AND direction = ? AND ABS(entry - ?) <= ? AND registered_at >= ?
       ORDER BY registered_at DESC LIMIT 1`
    ).bind(deviceId, symbol, direction, entry, tol, nowMs - 48 * 3600_000).first();
    return r?.id ?? null;
  } catch { return null; }
}

/** Same idea for an 'opportunity' entry: the row this device was shown for that bar. */
export async function findOpportunityRef(
  env: Env, deviceId: string, symbol: string, direction: string, nowMs: number,
): Promise<string | null> {
  try {
    const r: any = await env.DB.prepare(
      `SELECT id FROM opportunity_log WHERE device_id = ? AND symbol = ? AND direction = ?
         AND logged_at >= ? ORDER BY logged_at DESC LIMIT 1`
    ).bind(deviceId, symbol, direction, nowMs - 48 * 3600_000).first();
    return r?.id == null ? null : String(r.id);
  } catch { return null; }
}

export async function createJournalEntry(env: Env, deviceId: string, body: JournalCreate, nowMs: number): Promise<{ id: string; refId: string | null }> {
  await ensureJournalTables(env);
  let refId = body.refId ?? null;
  if (!refId && body.source === 'setup' && body.proposedEntry != null) {
    refId = await findTrackedRef(env, deviceId, body.symbol, body.direction, body.proposedEntry, nowMs);
  }
  if (!refId && body.source === 'opportunity') {
    refId = await findOpportunityRef(env, deviceId, body.symbol, body.direction, nowMs);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO journal_entries
    (id, device_id, created_at, updated_at, source, ref_id, symbol, is_crypto, direction,
     proposed_entry, proposed_stop, proposed_target, fill_price, contracts, risk_usd, note, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`).bind(
      id, deviceId, nowMs, nowMs, body.source, refId, body.symbol, body.isCrypto ? 1 : 0, body.direction,
      body.proposedEntry ?? null, body.proposedStop ?? null, body.proposedTarget ?? null,
      body.fillPrice, body.contracts ?? null, body.riskUsd ?? null, body.note ?? null).run();
  return { id, refId };
}

export interface JournalUpdate {
  id: string; fillPrice?: number | null; contracts?: number | null; riskUsd?: number | null;
  note?: string | null; exitPrice?: number | null; exitAt?: number | null; exitReason?: string | null;
  reopen?: boolean;
}

export async function updateJournalEntry(env: Env, deviceId: string, u: JournalUpdate, nowMs: number): Promise<boolean> {
  await ensureJournalTables(env);
  const cur: any = await env.DB.prepare('SELECT * FROM journal_entries WHERE id = ? AND device_id = ?').bind(u.id, deviceId).first();
  if (!cur) return false;
  const closing = u.exitPrice != null;
  const status = u.reopen ? 'open' : (closing ? 'closed' : cur.status);
  await env.DB.prepare(`UPDATE journal_entries SET updated_at = ?, fill_price = ?, contracts = ?, risk_usd = ?,
      note = ?, exit_price = ?, exit_at = ?, exit_reason = ?, status = ? WHERE id = ? AND device_id = ?`).bind(
    nowMs,
    u.fillPrice ?? cur.fill_price, u.contracts === undefined ? cur.contracts : u.contracts,
    u.riskUsd === undefined ? cur.risk_usd : u.riskUsd, u.note === undefined ? cur.note : u.note,
    u.reopen ? null : (u.exitPrice ?? cur.exit_price),
    u.reopen ? null : (closing ? (u.exitAt ?? nowMs) : cur.exit_at),
    u.reopen ? null : (u.exitReason === undefined ? cur.exit_reason : u.exitReason),
    status, u.id, deviceId).run();
  return true;
}

export async function deleteJournalEntry(env: Env, deviceId: string, id: string): Promise<boolean> {
  await ensureJournalTables(env);
  const r: any = await env.DB.prepare('DELETE FROM journal_entries WHERE id = ? AND device_id = ?').bind(id, deviceId).run();
  return (r?.meta?.changes ?? 0) > 0;
}

// ─── Attribution ─────────────────────────────────────────────────────────────────────────────

/** One gradable proposal or trade, normalised. */
export interface Obs {
  key: string;                 // 'setup:<id>' | 'opp:<id>' | 'journal:<id>'
  source: 'setup' | 'opportunity' | 'manual';
  symbol: string; direction: string;
  startMs: number; endMs: number;
  r: number | null;            // realised R (null = not yet graded / never held)
  mfeR?: number | null; maeR?: number | null;
  feeR?: number;               // fee burden in R (opportunities only)
  gross: boolean;              // true when r is gross of fees
}

export interface GroupStats {
  n: number; effectiveN: number; graded: number;
  expectancyR: number | null; winRate: number | null;
  avgMfeR: number | null; avgMaeR: number | null; profitFactor: number | null;
  avgFeeR: number | null;
  byMonth: Array<{ month: string; n: number; meanR: number }>;
  consistency: { positive: number; months: number } | null;
}

/** Trades on the same symbol whose windows overlap are ONE observation (greedy on start). */
export function effectiveN(obs: Obs[]): number {
  const bySym = new Map<string, Obs[]>();
  for (const o of obs) { const l = bySym.get(o.symbol) ?? []; l.push(o); bySym.set(o.symbol, l); }
  let clusters = 0;
  for (const list of bySym.values()) {
    list.sort((a, b) => a.startMs - b.startMs);
    let end = -Infinity;
    for (const o of list) {
      if (o.startMs >= end) { clusters++; end = o.endMs; }
      else end = Math.max(end, o.endMs);
    }
  }
  return clusters;
}

function monthKey(ms: number): string {
  const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function groupStats(obs: Obs[]): GroupStats {
  const graded = obs.filter(o => o.r != null);
  const rs = graded.map(o => o.r as number);
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r < 0);
  const sumW = wins.reduce((a, b) => a + b, 0), sumL = Math.abs(losses.reduce((a, b) => a + b, 0));
  const months = new Map<string, number[]>();
  for (const o of graded) { const k = monthKey(o.startMs); const l = months.get(k) ?? []; l.push(o.r as number); months.set(k, l); }
  const byMonth = [...months.entries()].sort().map(([month, xs]) => ({ month, n: xs.length, meanR: mean(xs) as number }));
  const eligible = byMonth.filter(m => m.n >= 3);
  return {
    n: obs.length, effectiveN: effectiveN(obs), graded: graded.length,
    expectancyR: mean(rs), winRate: rs.length ? wins.length / rs.length : null,
    avgMfeR: mean(graded.map(o => o.mfeR).filter((x): x is number => x != null)),
    avgMaeR: mean(graded.map(o => o.maeR).filter((x): x is number => x != null)),
    profitFactor: sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : null),
    avgFeeR: mean(graded.map(o => o.feeR).filter((x): x is number => x != null)),
    byMonth,
    consistency: eligible.length ? { positive: eligible.filter(m => m.meanR > 0).length, months: eligible.length } : null,
  };
}

/** Deterministic PRNG so a test can pin an interval. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% bootstrap CI on mean(a) − mean(b) over trades. `b` may be empty → CI on mean(a). */
export function bootstrapDiffCI(a: number[], b: number[], B = 2000, seed = 7): [number, number] | null {
  if (a.length < 2) return null;
  const rnd = mulberry32(seed);
  const draw = (xs: number[]) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)]; return s / xs.length; };
  const out: number[] = [];
  for (let i = 0; i < B; i++) out.push(draw(a) - (b.length ? draw(b) : 0));
  out.sort((x, y) => x - y);
  return [out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B) - 1]];
}

export const VERDICT_MIN_TAKEN = 10;
export const VERDICT_MIN_SKIPPED = 10;

export interface Attribution {
  proposed: GroupStats; taken: GroupStats; skipped: GroupStats;
  selectionR: number | null; selectionCI: [number, number] | null;
  abstentionR: number | null; abstentionCI: [number, number] | null;
  executionDragR: number | null; executionN: number;
  verdict: { status: 'insufficient' | 'ready'; needTaken: number; needSkipped: number;
             selection: 'picks_beat_list' | 'list_beat_picks' | 'no_difference' | null;
             abstention: 'skipping_helped' | 'skipped_winners' | 'no_difference' | null };
  note: string;
}

export function attribute(proposed: Obs[], taken: Obs[]): Attribution {
  const takenRefs = new Set(taken.map(t => t.key));
  const skipped = proposed.filter(p => !takenRefs.has(p.key));
  const P = groupStats(proposed), T = groupStats(taken), S = groupStats(skipped);
  const rT = taken.filter(o => o.r != null).map(o => o.r as number);
  const rP = proposed.filter(o => o.r != null).map(o => o.r as number);
  const rS = skipped.filter(o => o.r != null).map(o => o.r as number);
  const selectionR = (T.expectancyR != null && P.expectancyR != null) ? T.expectancyR - P.expectancyR : null;
  const selectionCI = bootstrapDiffCI(rT, rP);
  const abstentionR = S.expectancyR;
  const abstentionCI = bootstrapDiffCI(rS, []);

  const ready = T.graded >= VERDICT_MIN_TAKEN && S.graded >= VERDICT_MIN_SKIPPED;
  const call = (ci: [number, number] | null, pos: any, neg: any) =>
    !ci ? null : ci[0] > 0 ? pos : ci[1] < 0 ? neg : 'no_difference';
  return {
    proposed: P, taken: T, skipped: S,
    selectionR, selectionCI, abstentionR, abstentionCI,
    executionDragR: null, executionN: 0,
    verdict: {
      status: ready ? 'ready' : 'insufficient',
      needTaken: Math.max(0, VERDICT_MIN_TAKEN - T.graded), needSkipped: Math.max(0, VERDICT_MIN_SKIPPED - S.graded),
      selection: ready ? call(selectionCI, 'picks_beat_list', 'list_beat_picks') : null,
      abstention: ready ? call(abstentionCI, 'skipped_winners', 'skipping_helped') : null,
    },
    note: 'Tier 1 metrics only. Setup R is GROSS (the analysis path does not model fees); scanner R is net of the row\'s fee burden. '
        + 'A taken trade without an exit inherits its proposal\'s graded R, i.e. it is scored as if managed the way the system manages it. '
        + `No verdict is rendered until taken >= ${VERDICT_MIN_TAKEN} and skipped >= ${VERDICT_MIN_SKIPPED} graded trades.`,
  };
}

/** Load the device's populations from D1 and attribute. */
export async function computeAttribution(env: Env, deviceId: string, nowMs: number): Promise<Attribution & { entries: any[] }> {
  await ensureJournalTables(env);
  // tracked_setups is created lazily by the resolver; a device that has never run an analysis
  // (or a fresh box) must get an empty record, not a 500. Caught by the test suite, not in prod.
  await ensureTrackedSetupsTable(env);
  const setups = ((await env.DB.prepare(
    `SELECT id, symbol, direction, entry, stop_loss, tp1, tp2, outcome, max_favorable, max_adverse,
            registered_at, resolved_at, entry_hit FROM tracked_setups
     WHERE device_id = ? AND kind = 'setup' AND terminal = 1`).bind(deviceId).all()).results || []) as any[];
  const opps = ((await env.DB.prepare(
    `SELECT id, symbol, direction, entry, stop, target, fee_burden_r, logged_at, resolve_at, resolved, fav_r, adv_r, exit_r, outcome
     FROM opportunity_log WHERE device_id = ? AND shown = 1`).bind(deviceId).all()).results || []) as any[];
  const entries = ((await env.DB.prepare(
    'SELECT * FROM journal_entries WHERE device_id = ? ORDER BY created_at DESC').bind(deviceId).all()).results || []) as any[];

  const proposed: Obs[] = [];
  for (const s of setups) {
    const r = realizedRForSetup({ outcome: s.outcome, direction: s.direction, entry: s.entry, stopLoss: s.stop_loss, tp1: s.tp1, tp2: s.tp2 });
    if (r == null && !s.entry_hit) continue;             // never held a position → not a proposal you could have lost on
    const risk = s.entry != null && s.stop_loss != null ? Math.abs(s.entry - s.stop_loss) : 0;
    proposed.push({
      key: `setup:${s.id}`, source: 'setup', symbol: s.symbol, direction: s.direction,
      startMs: s.registered_at, endMs: s.resolved_at ?? s.registered_at, r, gross: true,
      mfeR: risk > 0 ? (s.max_favorable ?? 0) / risk : null, maeR: risk > 0 ? (s.max_adverse ?? 0) / risk : null,
    });
  }
  for (const o of opps) {
    const graded = o.resolved && o.outcome && o.outcome !== 'ungraded' && o.exit_r != null;
    proposed.push({
      key: `opp:${o.id}`, source: 'opportunity', symbol: o.symbol, direction: o.direction,
      startMs: o.logged_at, endMs: o.resolve_at, r: graded ? o.exit_r - (o.fee_burden_r ?? 0) : null,
      mfeR: graded ? o.fav_r : null, maeR: graded ? o.adv_r : null, feeR: o.fee_burden_r ?? 0, gross: false,
    });
  }
  const byKey = new Map(proposed.map(p => [p.key, p]));

  const taken: Obs[] = [];
  let dragSum = 0, dragN = 0;
  for (const e of entries) {
    const refKey = e.ref_id ? (e.source === 'setup' ? `setup:${e.ref_id}` : `opp:${e.ref_id}`) : null;
    const linked = refKey ? byKey.get(refKey) ?? null : null;
    let r: number | null = null; let gross = true;
    if (e.status === 'closed' && e.exit_price != null && e.proposed_stop != null) {
      r = realizedRForFill(e.direction, e.fill_price, e.proposed_stop, e.exit_price);
      if (linked?.source === 'opportunity' && r != null) { r -= linked.feeR ?? 0; gross = false; }
      if (r != null && linked?.r != null && e.proposed_entry != null) {
        const rProposed = realizedRForFill(e.direction, e.proposed_entry, e.proposed_stop, e.exit_price);
        if (rProposed != null) { dragSum += r - rProposed; dragN++; }
      }
    } else if (linked) { r = linked.r; gross = linked.gross; }
    taken.push({
      key: refKey ?? `journal:${e.id}`, source: e.source, symbol: e.symbol, direction: e.direction,
      startMs: e.created_at, endMs: e.exit_at ?? linked?.endMs ?? e.created_at, r, gross,
      mfeR: linked?.mfeR ?? null, maeR: linked?.maeR ?? null, feeR: linked?.feeR,
    });
  }
  const out = attribute(proposed, taken);
  out.executionDragR = dragN ? dragSum / dragN : null;
  out.executionN = dragN;
  return { ...out, entries };
}
