// Server-side trade-setup outcome tracking (2026-07-09 thin-client cutover).
//
// The full setup lifecycle — register at analysis time, resolve on the cron, write counted
// outcomes to trade_outcomes — runs HERE, replacing the iOS OutcomeTracker's on-device
// resolution (which only ran when the user opened the app). The state machine is a faithful
// port of OutcomeTracker.trackSetupOutcomes (OutcomeTracker.swift:118-335) including the
// load-bearing distinctions documented there:
//   • `terminal` (stop tracking) vs "counted" (include in stats) — tp1Hit alone is NOT terminal;
//     the runner continues to TP2 or the break-even stop. A 2026-05-09 iOS regression conflated
//     these and froze 23/24 winners at tp1 — the guard here is stop_hit||tp2_hit, never counted.
//   • Only COUNTED outcomes (tp2_win/tp1_win/partial_be/loss) are inserted into trade_outcomes;
//     invalidated/expired/not_triggered stay in tracked_setups as history so the prompt's
//     outcome-history (LIMIT 10) isn't flooded with non-trades.
//
// Documented deltas vs the iOS tracker (intentional):
//   • Pending re-eval drops the "direction changed vs latest cached analysis" and "latest
//     analysis says NO SETUP" checks (the cron has no LLM text) and the "no cached data →
//     conservative invalidate" branch (the server always has ML data). ML-drift, persistence,
//     and kill-condition checks are kept (kills read from the prompt:<symbol> KV state).
//   • FLAT outcomes grade at a fixed +24h horizon (falseFlat = |move| > 1.5%) instead of the
//     app-usage-dependent "3 refreshes" rule.
//   • The 6h stop-tighten uses candle time (point.time - entry_hit_at), not wall clock, so a
//     post-downtime backfill replays with correct chronology.
//   • Untriggered setups prune at 7d to terminal `not_triggered` (kept as rows, not deleted).
//   • Outcomes sync at TRUE terminal — fixes the iOS quirk of syncing tp1_win at TP1-hit and
//     never upgrading to tp2_win when the runner later reached TP2.
//
// D1 constraint (server/d1-adapter.ts): positional `?` placeholders ONLY — never `?N`.

import { classifyArchetype, isValidSetupGeometry, type TradeSetup } from './prompt';

// Minimal structural env — index.ts's Env satisfies it; tests can pass a bare adapter.
interface Env { DB: any; ALERTS: { get(k: string): Promise<string | null> } }

// ─── Constants (registry of record — keep iOS + the index.ts outcome query in sync) ─────────
export const TRACKED_MODEL_VERSION = 14;                       // = ml-model JSONs' `version`
export const TRACKED_PROMPT_VERSION = '2026-05-30-stoch-direction';
const PENDING_EXPIRY_MS = 12 * 3600_000;
const FLAT_HORIZON_MS = 24 * 3600_000;
const FLAT_FALSE_THRESHOLD_PCT = 1.5;
const UNTRIGGERED_PRUNE_MS = 7 * 86400_000;
const RESOLVE_INTERVAL_MS = 5 * 60_000;                        // full resolve pass cadence
const BACKFILL_OVERLAP_MS = 30 * 60_000;                       // re-feed window (latches → safe)

export const COUNTED_OUTCOMES = new Set(['tp2_win', 'tp1_win', 'partial_be', 'loss']);

// ─── Types ───────────────────────────────────────────────────────────────────────────────────

/** One tracked_setups row, camelCase. Mirrors the DDL below 1:1. */
export interface TrackedRow {
  id: string; deviceId: string; symbol: string; isCrypto: boolean;
  kind: 'setup' | 'flat';
  direction: string | null;
  entry: number | null; stopLoss: number | null; tp1: number | null; tp2: number | null;
  reasoning: string | null;
  priceAtSetup: number; atr: number | null; mlAtRegistration: number | null;
  conviction: string | null; modelVersion: number; promptVersion: string;
  archetype: string | null; setupType: string | null;
  state: 'pending' | 'active' | 'invalidated' | 'expired';
  terminal: boolean;
  entryHit: boolean; entryHitAt: number | null;
  stopHit: boolean; tp1Hit: boolean; tp2Hit: boolean;
  breakevenActivated: boolean; partialTaken: boolean;
  maxFavorable: number; maxAdverse: number;
  outcome: string | null; invalidReason: string | null;
  flatReason: string | null; falseFlat: boolean | null; priceAfter: number | null;
  pendingExpiresAt: number | null;
  registeredAt: number; resolvedAt: number | null; lastCheckedAt: number | null;
  outcomeRowId: number | null;
}

/** OHLC check point (ms epoch). The live tick is appended as a zero-width point. */
export interface Point { open: number; high: number; low: number; time: number }

export interface StepOpts {
  nowMs: number;
  mlProb?: number | null;          // current 24h ML for this symbol (pending re-eval)
  mlPersistence?: number | null;   // current 72h persistence (pending re-eval)
  killDur?: Record<string, number> | null;  // prompt:<symbol> KV state's kill durations
}

// ─── DDL ─────────────────────────────────────────────────────────────────────────────────────

let trackedTableReady = false;
export async function ensureTrackedSetupsTable(env: Env): Promise<void> {
  if (trackedTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tracked_setups (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    is_crypto INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'setup',
    direction TEXT,
    entry REAL, stop_loss REAL, tp1 REAL, tp2 REAL,
    reasoning TEXT,
    price_at_setup REAL NOT NULL DEFAULT 0,
    atr REAL,
    ml_at_registration REAL,
    conviction TEXT,
    model_version INTEGER NOT NULL,
    prompt_version TEXT NOT NULL,
    archetype TEXT,
    setup_type TEXT,
    state TEXT NOT NULL,
    terminal INTEGER NOT NULL DEFAULT 0,
    entry_hit INTEGER NOT NULL DEFAULT 0,
    entry_hit_at INTEGER,
    stop_hit INTEGER NOT NULL DEFAULT 0,
    tp1_hit INTEGER NOT NULL DEFAULT 0,
    tp2_hit INTEGER NOT NULL DEFAULT 0,
    breakeven_activated INTEGER NOT NULL DEFAULT 0,
    partial_taken INTEGER NOT NULL DEFAULT 0,
    max_favorable REAL NOT NULL DEFAULT 0,
    max_adverse REAL NOT NULL DEFAULT 0,
    outcome TEXT,
    invalid_reason TEXT,
    flat_reason TEXT,
    false_flat INTEGER,
    price_after REAL,
    pending_expires_at INTEGER,
    registered_at INTEGER NOT NULL,
    resolved_at INTEGER,
    last_checked_at INTEGER,
    outcome_row_id INTEGER
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tracked_open ON tracked_setups(terminal, symbol)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tracked_device ON tracked_setups(device_id, registered_at DESC)').run();
  // The entry-zone glue rows INSERT into pending_setups; that table was historically lazy-created
  // only by the POST /pending-setups handler, which post-cutover may never run on a fresh DB —
  // ensure it here too (same schema as index.ts) so the registration batch can't fail on it.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pending_setups (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL,
    entry REAL NOT NULL, atr REAL NOT NULL, ml_at_registration REAL,
    expires_at INTEGER NOT NULL, registered_at INTEGER NOT NULL, notified INTEGER DEFAULT 0
  )`).run();
  trackedTableReady = true;
}

function rowFromDb(r: any): TrackedRow {
  return {
    id: r.id, deviceId: r.device_id, symbol: r.symbol, isCrypto: !!r.is_crypto,
    kind: r.kind, direction: r.direction ?? null,
    entry: r.entry ?? null, stopLoss: r.stop_loss ?? null, tp1: r.tp1 ?? null, tp2: r.tp2 ?? null,
    reasoning: r.reasoning ?? null,
    priceAtSetup: r.price_at_setup ?? 0, atr: r.atr ?? null,
    mlAtRegistration: r.ml_at_registration ?? null, conviction: r.conviction ?? null,
    modelVersion: r.model_version, promptVersion: r.prompt_version,
    archetype: r.archetype ?? null, setupType: r.setup_type ?? null,
    state: r.state, terminal: !!r.terminal,
    entryHit: !!r.entry_hit, entryHitAt: r.entry_hit_at ?? null,
    stopHit: !!r.stop_hit, tp1Hit: !!r.tp1_hit, tp2Hit: !!r.tp2_hit,
    breakevenActivated: !!r.breakeven_activated, partialTaken: !!r.partial_taken,
    maxFavorable: r.max_favorable ?? 0, maxAdverse: r.max_adverse ?? 0,
    outcome: r.outcome ?? null, invalidReason: r.invalid_reason ?? null,
    flatReason: r.flat_reason ?? null,
    falseFlat: r.false_flat == null ? null : !!r.false_flat,
    priceAfter: r.price_after ?? null,
    pendingExpiresAt: r.pending_expires_at ?? null,
    registeredAt: r.registered_at, resolvedAt: r.resolved_at ?? null,
    lastCheckedAt: r.last_checked_at ?? null, outcomeRowId: r.outcome_row_id ?? null,
  };
}

// ─── Classification (port of SetupType.classify, TradeSetup.swift:10-20) ────────────────────

const CONDITIONAL_KEYWORDS = ['wait for', 'close above', 'close below', 'confirms', 'breakout', 'rejection', 'retest'];

export function classifySetupType(entry: number, currentPrice: number, reasoning: string): 'market' | 'conditional' {
  if (currentPrice > 0 && Math.abs(entry - currentPrice) / currentPrice > 0.003) return 'conditional';
  const lower = (reasoning || '').toLowerCase();
  if (CONDITIONAL_KEYWORDS.some(k => lower.includes(k))) return 'conditional';
  return 'market';
}

// FLAT reason derivation (port of AnalysisService.swift:863-865).
export function flatReasonFromText(analysisText: string): string {
  if (analysisText.includes('BLOCKED')) return 'KILL';
  if (analysisText.includes('Rule 2')) return 'FLAT_Rule2';
  if (analysisText.includes('NO SETUP')) return 'FLAT';
  return 'NO_SETUP';
}

// ─── Registration (called from runFullAnalysisCore after parseSetups) ───────────────────────

export interface RegisterArgs {
  deviceId: string; symbol: string; isCrypto: boolean;
  setups: TradeSetup[]; analysisText: string;
  livePrice: number | null;
  indicators: any[];               // PromptIndicator[] — bias/atr/mlWinProbability consumed
  nowMs?: number;                  // injectable for tests
  marketOpen?: boolean;            // injectable for tests (default: computed for stocks)
}

/** US market-hours gate for stock registration (parity with AnalysisService.swift:846).
 *  Best-effort Finnhub market-status KV cache first; ET-clock fallback. */
export async function isUSMarketOpen(env: Env, nowMs = Date.now()): Promise<boolean> {
  try {
    const cached = await env.ALERTS.get('cache:fh:market-status:US');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (nowMs - parsed.timestamp < 600_000 && typeof parsed.data?.isOpen === 'boolean') {
        return parsed.data.isOpen;
      }
    }
  } catch { /* fall through to clock */ }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;   // 9:30–16:00 ET
}

export async function registerTrackedSetups(env: Env, args: RegisterArgs): Promise<void> {
  const now = args.nowMs ?? Date.now();
  // Stocks after hours: skip (parity — iOS gated on MarketHours.isMarketOpen()).
  if (!args.isCrypto) {
    const open = args.marketOpen ?? await isUSMarketOpen(env, now);
    if (!open) return;
  }
  await ensureTrackedSetupsTable(env);

  const daily = args.indicators[0] ?? {};
  const priceAtSetup = (args.livePrice != null && args.livePrice > 0) ? args.livePrice : (daily.price ?? 0);
  const atr = args.indicators[1]?.atr?.atr ?? null;                 // 4H ATR, price units
  const ml = daily.mlWinProbability ?? null;
  let archetype: string | null = null;
  try { archetype = classifyArchetype(args.indicators as any); } catch { /* best-effort */ }

  const stmts: any[] = [];
  const INSERT = `INSERT INTO tracked_setups
    (id, device_id, symbol, is_crypto, kind, direction, entry, stop_loss, tp1, tp2, reasoning,
     price_at_setup, atr, ml_at_registration, conviction, model_version, prompt_version,
     archetype, setup_type, state, terminal, flat_reason, pending_expires_at, registered_at, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`;

  if (args.setups.length === 0) {
    if (!args.analysisText) return;
    // FLAT: one row, graded at +24h against the price then.
    stmts.push(env.DB.prepare(INSERT).bind(
      crypto.randomUUID(), args.deviceId, args.symbol, args.isCrypto ? 1 : 0, 'flat',
      null, null, null, null, null, null,
      priceAtSetup, atr, ml, null, TRACKED_MODEL_VERSION, TRACKED_PROMPT_VERSION,
      archetype, null, 'active', flatReasonFromText(args.analysisText), null, now, now,
    ));
  } else {
    for (const s of args.setups) {
      const setupType = classifySetupType(s.entry, priceAtSetup, s.reasoning ?? '');
      const isConditional = setupType === 'conditional';
      const id = crypto.randomUUID();
      stmts.push(env.DB.prepare(INSERT).bind(
        id, args.deviceId, args.symbol, args.isCrypto ? 1 : 0, 'setup',
        s.direction, s.entry, s.stopLoss, s.tp1, s.tp2 ?? null, s.reasoning ?? null,
        priceAtSetup, atr, ml, null, TRACKED_MODEL_VERSION, TRACKED_PROMPT_VERSION,
        archetype, setupType, isConditional ? 'pending' : 'active', null,
        isConditional ? now + PENDING_EXPIRY_MS : null, now, now,
      ));
      // pending_setups glue: keeps the cron's entry-zone-touch APNs alive now that iOS no
      // longer registers via WorkerPendingSetupService (crypto conditional only, atr>0 —
      // parity with OutcomeTracker.swift:544). Follow-up: consolidate onto tracked_setups.
      if (isConditional && args.isCrypto && atr != null && atr > 0) {
        stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO pending_setups
          (id, device_id, symbol, direction, entry, atr, ml_at_registration, expires_at, registered_at, notified)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).bind(
          id, args.deviceId, args.symbol, s.direction, s.entry, atr, ml, now + PENDING_EXPIRY_MS, now,
        ));
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// ─── Pending re-eval (simplified port of OutcomeTracker.reEvaluate:341-421) ─────────────────

function reEvalPending(row: TrackedRow, opts: StepOpts): { validated: boolean; reason: string } {
  // Kill conditions (iOS check 3) — from the prompt:<symbol> KV state's kill durations.
  const kd = opts.killDur;
  if (kd) {
    const reasons: string[] = [];
    if ((kd['divergence'] ?? 0) > 0) reasons.push('divergence');
    if ((kd['volume'] ?? 0) > 0) reasons.push('counter-volume');
    if ((kd['funding'] ?? 0) > 0) reasons.push('funding flip');
    if (reasons.length) return { validated: false, reason: `Kill conditions active: ${reasons.join(', ')}` };
  }
  // ML drift (iOS check 4).
  const ml = opts.mlProb;
  if (ml != null) {
    if (ml < 0.50) return { validated: false, reason: `ML_WIN below 50% (${Math.round(ml * 100)}%)` };
    const orig = row.mlAtRegistration ?? 0;
    if (orig > 0 && orig - ml > 0.15) {
      return { validated: false, reason: `ML_WIN dropped ${Math.round((orig - ml) * 100)}pp (${Math.round(orig * 100)}% → ${Math.round(ml * 100)}%)` };
    }
  }
  // Persistence collapse (iOS check 5).
  const h72 = opts.mlPersistence;
  if (h72 != null && h72 < 0.40) {
    return { validated: false, reason: `ML Persistence collapsed below 40% (${Math.round(h72 * 100)}%) — runner thesis broken` };
  }
  return { validated: true, reason: `Re-eval confirmed: ${row.direction}, ML ${ml != null ? Math.round(ml * 100) + '%' : 'n/a'}` };
  // Dropped vs iOS: direction-vs-latest-analysis + latest-analysis-FLAT checks (no LLM text in
  // the cron) and the "no cached data → conservative invalidate" branch (ML is always available).
}

// ─── Outcome string (port of TradeOutcome.result, TradeSetup.swift:205-216) ─────────────────

export function outcomeString(row: TrackedRow): string {
  if (row.state === 'invalidated') return 'invalidated';
  if (row.state === 'expired') return 'expired';
  if (!row.entryHit) return 'not_triggered';
  if (row.tp2Hit) return 'tp2_win';
  if (row.tp1Hit && row.stopHit) return 'tp1_win';       // runner stopped at BE after TP1
  if (row.stopHit && row.partialTaken) return 'partial_be';
  if (row.stopHit) return 'loss';
  if (row.tp1Hit) return 'tp1_win';
  return 'open';
}

// ─── The pure state machine (port of trackSetupOutcomes, OutcomeTracker.swift:118-335) ──────

export function stepSetup(input: TrackedRow, points: Point[], opts: StepOpts): { row: TrackedRow; changed: boolean } {
  const row: TrackedRow = { ...input };
  let changed = false;
  const now = opts.nowMs;

  if (row.kind === 'flat') return stepFlat(row, points, opts);
  if (row.terminal || row.state === 'invalidated' || row.state === 'expired') return { row, changed };
  // `resolved` guard: stop/tp2 already hit → nothing to do (terminal was set alongside).
  if (row.state === 'active' && (row.stopHit || row.tp2Hit)) return { row, changed };

  const isLong = row.direction === 'LONG';
  const entry = row.entry ?? 0, stopLoss = row.stopLoss ?? 0, tp1 = row.tp1 ?? 0;
  const risk = Math.abs(entry - stopLoss);

  const finalize = (outcome: string) => {
    row.terminal = true; row.outcome = outcome;
    if (row.resolvedAt == null) row.resolvedAt = now;
    changed = true;
  };

  // ── PENDING ──
  if (row.state === 'pending') {
    if (row.pendingExpiresAt != null && now > row.pendingExpiresAt) {
      row.state = 'expired';
      row.invalidReason = 'Pending window expired (12h)';
      finalize('expired');
      return { row, changed };
    }
    // Proactive re-validation for aging pendings (≥1h old).
    if (now - row.registeredAt >= 3600_000) {
      const ev = reEvalPending(row, opts);
      if (!ev.validated) {
        row.state = 'invalidated';
        row.invalidReason = ev.reason;
        finalize('invalidated');
        return { row, changed };
      }
    }
    // Entry touch (direction-only, iOS :180-182).
    const touch = points.find(p => p.time >= row.registeredAt && (isLong ? p.low <= entry : p.high >= entry));
    if (touch) {
      const ev = reEvalPending(row, opts);
      if (ev.validated) {
        row.state = 'active';
        row.entryHit = true;
        row.entryHitAt = touch.time;
      } else {
        row.state = 'invalidated';
        row.invalidReason = ev.reason;
        finalize('invalidated');
        return { row, changed };
      }
      changed = true;
    }
    if (row.state === 'pending') return { row, changed };
    // fell through to active — continue into the active loop with the same points
  }

  // ── ACTIVE ──
  const priceAtSetup = row.priceAtSetup;
  for (const point of points) {
    if (point.time < row.registeredAt) continue;

    // Entry-hit for market setups that weren't auto-entered (direction-aware vs priceAtSetup).
    if (!row.entryHit) {
      let hit: boolean;
      if (priceAtSetup > 0) {
        if (Math.abs(entry - priceAtSetup) / priceAtSetup < 0.001) hit = true;          // market entry
        else if (entry < priceAtSetup) hit = point.low <= entry;                        // price must fall
        else hit = point.high >= entry;                                                 // price must rise
      } else {
        hit = isLong ? point.low <= entry : point.high >= entry;                        // legacy fallback
      }
      if (hit) { row.entryHit = true; row.entryHitAt = point.time; changed = true; }
      continue;
    }
    if (row.entryHitAt != null && point.time < row.entryHitAt) continue;

    // Excursions (max-latches → idempotent under overlap re-feeds).
    const favorable = isLong ? point.high - entry : entry - point.low;
    const adverse = isLong ? entry - point.low : point.high - entry;
    if (favorable > row.maxFavorable) { row.maxFavorable = favorable; changed = true; }
    if (adverse > row.maxAdverse) { row.maxAdverse = adverse; changed = true; }

    // Terminal guard: after stop/tp2, excursion-only. NEVER include tp1 here (the
    // 23/24-frozen-winners regression) — the runner continues to TP2 or the BE stop.
    if (row.stopHit || row.tp2Hit) continue;

    // Break-even activation at +1R (this point's favorable, not the max — iOS parity).
    if (!row.breakevenActivated && risk > 0 && favorable / risk >= 1.0) {
      row.breakevenActivated = true;
      row.partialTaken = true;
      changed = true;
    }

    // Active stop for THIS point: BE wins; else the 6h tighten (candle-time based — replays
    // correctly across downtime backfills, unlike iOS's wall-clock Date()); else the setup stop.
    let activeStop: number;
    if (row.breakevenActivated) activeStop = entry;
    else if (row.entryHitAt != null && point.time - row.entryHitAt > 6 * 3600_000 && risk > 0 && row.maxFavorable / risk < 0.5) {
      const tightened = risk * 0.7;
      activeStop = isLong ? entry - tightened : entry + tightened;
    } else activeStop = stopLoss;

    // Stop / TP1 with the same-bar open-proximity heuristic (iOS :291-313).
    const stopHit = isLong ? point.low <= activeStop : point.high >= activeStop;
    const tp1Hit = isLong ? point.high >= tp1 : point.low <= tp1;
    if (stopHit && tp1Hit && !row.tp1Hit) {
      if (Math.abs(point.open - activeStop) <= Math.abs(point.open - tp1)) {
        row.stopHit = true; finalize(outcomeString(row)); break;
      } else {
        row.tp1Hit = true; changed = true;
      }
    } else if (stopHit) {
      row.stopHit = true; finalize(outcomeString(row)); break;
    } else if (tp1Hit && !row.tp1Hit) {
      row.tp1Hit = true; changed = true;
    }

    // TP2 (terminal).
    if (row.tp2 != null && !row.tp2Hit) {
      const hit = isLong ? point.high >= row.tp2 : point.low <= row.tp2;
      if (hit) { row.tp2Hit = true; finalize(outcomeString(row)); break; }
    }
  }

  // 7-day prune of untriggered setups → terminal not_triggered (kept as history; iOS deleted).
  if (!row.terminal && row.state === 'active' && !row.entryHit && row.registeredAt < now - UNTRIGGERED_PRUNE_MS) {
    finalize('not_triggered');
  }

  return { row, changed };
}

// FLAT grading: at +24h, falseFlat = |move| > 1.5% (fixed horizon replaces "3 refreshes").
function stepFlat(row: TrackedRow, points: Point[], opts: StepOpts): { row: TrackedRow; changed: boolean } {
  if (row.terminal) return { row, changed: false };
  if (opts.nowMs < row.registeredAt + FLAT_HORIZON_MS) return { row, changed: false };
  // Grade against the most recent price available (the live tick is appended last with
  // open == high == low, so the midpoint IS the tick; for a plain candle it's a fair proxy).
  const last = points.length ? points[points.length - 1] : null;
  if (!last || row.priceAtSetup <= 0) return { row, changed: false };
  const price = (last.high + last.low) / 2;
  const movePct = Math.abs(price - row.priceAtSetup) / row.priceAtSetup * 100;
  row.priceAfter = price;
  row.falseFlat = movePct > FLAT_FALSE_THRESHOLD_PCT;
  row.outcome = row.falseFlat ? 'flat_false' : 'flat_true';
  row.terminal = true;
  row.resolvedAt = opts.nowMs;
  return { row, changed: true };
}

// ─── Cron resolver ───────────────────────────────────────────────────────────────────────────

/** Injected fetchers — index.ts passes its own (avoids a circular import; tests inject synthetic). */
export interface ResolveFetchers {
  /** Closed klines for a crypto symbol (proxy→Binance→Bybit chain). time = ms epoch. */
  cryptoKlines(symbol: string, interval: string, limit: number): Promise<Array<{ time: number; open: number; high: number; low: number; close: number }>>;
  /** Live price (crypto: Binance/Bybit tick; stock: Yahoo). */
  livePrice(symbol: string, isCrypto: boolean): Promise<number | null>;
  /** The cron's `candles:all:1h` KV blob (whole universe) — stock candles come from here. */
  stock1hMap(): Promise<Record<string, Array<{ time: number; open: number; high: number; low: number; close: number }>>>;
}

export interface PredLike { isCrypto: boolean; last4HClose: number; mlProb: number }

let lastResolveMs = 0;
/** Test hook — clears the module-level cadence gate + table-ready flag. */
export function _resetForTests(): void { lastResolveMs = 0; trackedTableReady = false; }

export async function resolveTrackedSetups(
  env: Env,
  predictions: Map<string, PredLike>,
  fetchers: ResolveFetchers,
  opts?: { force?: boolean; nowMs?: number },
): Promise<void> {
  const now = opts?.nowMs ?? Date.now();
  if (!opts?.force && now - lastResolveMs < RESOLVE_INTERVAL_MS) return;
  lastResolveMs = now;

  await ensureTrackedSetupsTable(env);
  const open = await env.DB.prepare('SELECT * FROM tracked_setups WHERE terminal = 0 LIMIT 500').all();
  const rows: TrackedRow[] = (open.results || []).map(rowFromDb);
  if (!rows.length) return;

  const updates: any[] = [];
  const pendingDeletes: any[] = [];
  const countedInserts: TrackedRow[] = [];
  let stockMap: Record<string, Array<{ time: number; open: number; high: number; low: number; close: number }>> | null = null;

  // Per-symbol grouping (one candle fetch serves every row on that symbol).
  const bySymbol = new Map<string, TrackedRow[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }

  const symbols = [...bySymbol.keys()];
  await mapLimitLocal(symbols, 3, async (symbol) => {
    const group = bySymbol.get(symbol)!;
    const isCrypto = group[0].isCrypto;

    // Candle window: from the oldest last_checked_at (minus overlap) to now. Latched state
    // machine → re-feeding overlap bars is safe/idempotent.
    const oldestChecked = Math.min(...group.map(r => r.lastCheckedAt ?? r.registeredAt));
    const sinceMs = oldestChecked - BACKFILL_OVERLAP_MS;

    let candles: Array<{ time: number; open: number; high: number; low: number; close: number }> = [];
    try {
      if (isCrypto) {
        // 15m klines; limit sized to cover the gap (1000 bars ≈ 10.4d downtime backfill).
        const limit = Math.min(1000, Math.max(8, Math.ceil((now - sinceMs) / 900_000) + 4));
        candles = await fetchers.cryptoKlines(symbol, '15m', limit);
      } else {
        if (stockMap == null) { try { stockMap = await fetchers.stock1hMap(); } catch { stockMap = {}; } }
        candles = stockMap[symbol] ?? [];
      }
    } catch { candles = []; }

    // Live tick appended as a zero-width point (iOS parity :129). Best-effort.
    let live: number | null = null;
    const pred = predictions.get(symbol);
    try { live = await fetchers.livePrice(symbol, isCrypto); } catch { /* best-effort */ }
    if (live == null && pred && pred.last4HClose > 0) live = pred.last4HClose;

    const points: Point[] = candles
      .filter(c => c.time >= sinceMs)
      .map(c => ({ open: c.open, high: c.high, low: c.low, time: c.time }));
    if (live != null) points.push({ open: live, high: live, low: live, time: now });

    // Wall-clock-only rules (expiry/prune/flat) must run even with zero points; price rules
    // no-op then (stocks off-hours behave exactly like the iOS tracker over a weekend).
    // killDur best-effort from the prompt KV state (used by pending re-eval).
    let killDur: Record<string, number> | null = null;
    if (group.some(r => r.state === 'pending')) {
      try {
        const s = await env.ALERTS.get(`prompt:${symbol}`);
        if (s) killDur = (JSON.parse(s).killDur as Record<string, number>) ?? null;
      } catch { /* best-effort */ }
    }

    const stepOpts: StepOpts = {
      nowMs: now,
      mlProb: pred?.mlProb ?? null,
      mlPersistence: (pred as any)?.mlPersistence ?? null,
      killDur,
    };

    const maxPointTime = points.length ? Math.max(...points.map(p => p.time)) : null;
    for (const r of group) {
      const wasPending = r.state === 'pending';
      const { row, changed } = stepSetup(r, points, stepOpts);
      // last_checked_at advances to the newest processed point (NOT `now` — a bar closing
      // between fetch and stamp would otherwise be skipped; overlap covers the rest).
      const newChecked = maxPointTime != null ? Math.max(row.lastCheckedAt ?? 0, maxPointTime) : row.lastCheckedAt;
      if (changed || newChecked !== row.lastCheckedAt) {
        row.lastCheckedAt = newChecked ?? row.lastCheckedAt;
        updates.push(env.DB.prepare(`UPDATE tracked_setups SET
            state = ?, terminal = ?, entry_hit = ?, entry_hit_at = ?, stop_hit = ?, tp1_hit = ?, tp2_hit = ?,
            breakeven_activated = ?, partial_taken = ?, max_favorable = ?, max_adverse = ?,
            outcome = ?, invalid_reason = ?, false_flat = ?, price_after = ?,
            resolved_at = ?, last_checked_at = ?
          WHERE id = ?`).bind(
          row.state, row.terminal ? 1 : 0, row.entryHit ? 1 : 0, row.entryHitAt,
          row.stopHit ? 1 : 0, row.tp1Hit ? 1 : 0, row.tp2Hit ? 1 : 0,
          row.breakevenActivated ? 1 : 0, row.partialTaken ? 1 : 0,
          row.maxFavorable, row.maxAdverse,
          row.outcome, row.invalidReason,
          row.falseFlat == null ? null : (row.falseFlat ? 1 : 0), row.priceAfter,
          row.resolvedAt, row.lastCheckedAt, row.id,
        ));
      }
      if (wasPending && row.state !== 'pending') {
        pendingDeletes.push(env.DB.prepare('DELETE FROM pending_setups WHERE id = ?').bind(row.id));
      }
      if (row.terminal && row.outcome && COUNTED_OUTCOMES.has(row.outcome) && row.outcomeRowId == null) {
        countedInserts.push(row);
      }
    }
  });

  if (updates.length || pendingDeletes.length) await env.DB.batch([...updates, ...pendingDeletes]);

  // Counted terminals → trade_outcomes (existing 16-col shape, index.ts:1902-1915) so the
  // prompt's outcome-history and GET /outcomes keep working unchanged. Individual .run()s to
  // capture last_row_id (batches can't RETURNING); volume is tiny.
  let synced = 0;
  for (const row of countedInserts) {
    try {
      const res = await env.DB.prepare(`INSERT INTO trade_outcomes
        (device_id, symbol, direction, entry_price, stop_loss, tp1, tp2, ml_probability,
         daily_score, four_h_score, conviction, outcome, pnl_percent, notes, model_version, prompt_version, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).bind(
        row.deviceId, row.symbol, row.direction, row.entry, row.stopLoss, row.tp1, row.tp2,
        row.mlAtRegistration, null, null, row.conviction, row.outcome, 0, null,
        row.modelVersion, row.promptVersion,
      ).run();
      const rowId = (res as any)?.meta?.last_row_id ?? null;
      await env.DB.prepare('UPDATE tracked_setups SET outcome_row_id = ? WHERE id = ?')
        .bind(rowId ?? -1, row.id).run();
      synced++;
    } catch (e) {
      console.log(`[tracked] outcome insert failed ${row.symbol}: ${e}`);
    }
  }

  const terminals = countedInserts.length;
  if (updates.length || terminals) {
    console.log(`[tracked] updated ${updates.length} row(s), ${terminals} counted outcome(s) synced (${synced} ok)`);
  }
}

// One-time retroactive cleanup (2026-07-14): void any tracked_setup whose geometry is directionally
// INVALID — stop on the wrong side of entry (e.g. a SHORT with its stop BELOW entry, on the target
// side). Such a setup is not a real trade: the wrong-side stop is ALREADY breached at registration,
// so the state machine records an INSTANT phantom "loss" — even when the entry condition never fired
// — polluting the win/loss track record. The registration guard (parseSetups/isValidSetupGeometry)
// blocks these going forward; this sweeps the ones registered BEFORE that guard shipped. Voided rows
// become state='invalidated' outcome='invalid_geometry' (a NON-counted state) and their trade_outcomes
// row is deleted so they drop out of the counted stats entirely. KV-gated → runs once; idempotent
// (re-running would find nothing). On error the flag is NOT set, so it retries next cron.
export async function voidInvalidGeometrySetups(env: Env): Promise<void> {
  const FLAG = 'geometry_void_v1_done';
  try {
    if (await env.ALERTS.get(FLAG)) return;
    await ensureTrackedSetupsTable(env);
    const all = await env.DB.prepare(
      'SELECT id, direction, entry, stop_loss, tp1, tp2, outcome, outcome_row_id, state FROM tracked_setups'
    ).all();
    const rows = (all.results || []) as Array<any>;
    let voided = 0;
    for (const r of rows) {
      if (r.state === 'invalidated' && r.outcome === 'invalid_geometry') continue;  // already voided
      if (r.entry == null || r.stop_loss == null || r.tp1 == null || !r.direction) continue;  // FLAT/partial rows
      if (isValidSetupGeometry({ direction: r.direction, entry: r.entry, stopLoss: r.stop_loss, tp1: r.tp1, tp2: r.tp2 })) continue;
      const stmts: any[] = [];
      if (r.outcome_row_id != null) {
        stmts.push(env.DB.prepare('DELETE FROM trade_outcomes WHERE id = ?').bind(r.outcome_row_id));  // drop the phantom loss
      }
      stmts.push(env.DB.prepare(
        `UPDATE tracked_setups SET state = 'invalidated', terminal = 1, outcome = 'invalid_geometry',
           invalid_reason = 'invalid_geometry (voided retroactively)', outcome_row_id = NULL WHERE id = ?`
      ).bind(r.id));
      await env.DB.batch(stmts);
      voided++;
      console.log(`[tracked] voided invalid-geometry setup ${r.id} (${r.direction} entry=${r.entry} stop=${r.stop_loss} was outcome=${r.outcome})`);
    }
    await env.ALERTS.put(FLAG, String(Date.now()));
    console.log(`[tracked] geometry void sweep complete: ${voided} invalid setup(s) removed from counted stats`);
  } catch (e) {
    console.log(`[tracked] geometry void sweep failed (will retry): ${e}`);
  }
}

// Local bounded-concurrency map (index.ts's mapLimit isn't exported; 5 lines beats a circular import).
async function mapLimitLocal<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

// ─── Readers ─────────────────────────────────────────────────────────────────────────────────

/** Active-trade rows for the prompt's Active Trade State (maps 1:1 to prompt.ts ActiveSetup). */
export async function readActiveSetupsForPrompt(env: Env, deviceId: string, symbol: string): Promise<any[]> {
  try {
    await ensureTrackedSetupsTable(env);
    const res = await env.DB.prepare(
      `SELECT * FROM tracked_setups
       WHERE device_id = ? AND symbol = ? AND kind = 'setup' AND state = 'active'
         AND entry_hit = 1 AND terminal = 0
       ORDER BY registered_at DESC LIMIT 5`
    ).bind(deviceId, symbol).all();
    return (res.results || []).map((r: any) => {
      const row = rowFromDb(r);
      return {
        direction: row.direction,
        entry: row.entry,
        risk: Math.abs((row.entry ?? 0) - (row.stopLoss ?? 0)),
        tp1: row.tp1,
        mlProbability: row.mlAtRegistration,
        entryHitTimeMs: row.entryHitAt ?? row.registeredAt,
        maxFavorable: row.maxFavorable,
        maxAdverse: row.maxAdverse,
        tp1Hit: row.tp1Hit,
        partialTaken: row.partialTaken,
        breakevenActivated: row.breakevenActivated,
      };
    });
  } catch { return []; }
}

/** Full per-device rows for the GET /tracked-setups endpoint (camelCase, epoch-ms). */
export async function readTrackedSetups(env: Env, deviceId: string, symbol?: string | null, limit = 200):
  Promise<{ setups: any[]; flats: any[] }> {
  try {
    await ensureTrackedSetupsTable(env);
    const cap = Math.min(Math.max(1, limit), 500);
    let query = 'SELECT * FROM tracked_setups WHERE device_id = ?';
    const params: any[] = [deviceId];
    if (symbol) { query += ' AND symbol = ?'; params.push(symbol); }
    query += ' ORDER BY registered_at DESC LIMIT ?';
    params.push(cap);
    const res = await env.DB.prepare(query).bind(...params).all();
    const all = (res.results || []).map(rowFromDb);
    return {
      setups: all.filter(r => r.kind === 'setup'),
      flats: all.filter(r => r.kind === 'flat'),
    };
  } catch { return { setups: [], flats: [] }; }
}
