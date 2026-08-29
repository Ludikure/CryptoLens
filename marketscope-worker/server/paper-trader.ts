// The paper trader: MarketScope signal → simulated order → REAL Coinbase market data → virtual
// portfolio. Runs for the life of the box process beside the liquidation collector.
//
// It places no orders and holds no key: the Coinbase Advanced Trade WebSocket serves level2 and
// market_trades for the US derivatives (venue "cde") without authentication, verified 2026-08-28.
// The box's threat model is unchanged.
//
// Flow, every 4H close (+3 min so the cron has refreshed ml_preds:all):
//   buildOpportunityBook()  — the SAME function the app's /opportunities handler calls
//   intentsFromBook()       — the same floor and mood cancel the app applies
//   sim.openShort()         — sells into the live bids at the contract's book
// then continuously: every public trade print drives stops and targets, a 15s clock drives time
// exits, every event is persisted and pushed. Positions survive a restart from D1.
import WsClient from 'ws';
import cron from 'node-cron';
import type { Env } from '../src/index';
import { buildOpportunityBook, pushToActiveDevices } from '../src/index';
import { DEFAULT_STRUCTURE } from '../src/trading/generator';
import { DEFAULT_LIMITS } from '../src/trading/sizing';
import { OrderBook } from '../src/paper/book';
import { resolveContracts, type ContractSpec } from '../src/paper/contracts';
import { PaperSim, paperStats, DEFAULT_FEES, type Position, type SimEvent } from '../src/paper/sim';
import { intentsFromBook, DEFAULT_INTENT_GATE } from '../src/paper/intents';

const WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const PRODUCTS_URL = 'https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&limit=250';
const SYMBOLS = (process.env.PAPER_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,ADAUSDT').split(',').map(s => s.trim()).filter(Boolean);
const START_EQUITY = Number(process.env.PAPER_EQUITY || 25_000);
const RISK = Number(process.env.PAPER_RISK || 0.02);
const HALT_DRAWDOWN = Number(process.env.PAPER_HALT_DD || 0.25);      // halt new entries past −25%
const SILENT_MS = 120_000;                                            // no l2 for 2 min = dead socket
const CLOCK_MS = 15_000;
const CONTRACT_REFRESH_MS = 6 * 3600_000;
// A comparison the record is measured against, from the $25k backtest on these symbols, max 3 open
// (CLAUDE.md 2026-08-28). Not a promise; the reference the paper line is drawn beside.
export const BACKTEST_REFERENCE = { meanR: 0.22, note: 'walk-forward backtest, ADA/BTC/DOGE/ETH/SOL/XRP, max 3 open, 2021-2026H1' };

interface Status {
  state: 'starting' | 'open' | 'reconnecting' | 'init-failed';
  connectedAt: number | null; lastL2At: number | null; lastTradeAt: number | null;
  messages: number; attempts: number; silentResets: number; lastError: string | null;
  lastSignalRunAt: number | null; lastSignalSummary: string | null; halted: string | null;
  contracts: Record<string, string | null>;
}

const status: Status = {
  state: 'starting', connectedAt: null, lastL2At: null, lastTradeAt: null, messages: 0, attempts: 0,
  silentResets: 0, lastError: null, lastSignalRunAt: null, lastSignalSummary: null, halted: null, contracts: {},
};

export async function ensurePaperTables(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS paper_positions (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, product_id TEXT NOT NULL, status TEXT NOT NULL,
    opened_at INTEGER NOT NULL, exit_at INTEGER, exit_reason TEXT, realized_r REAL, pnl_usd REAL,
    data TEXT NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_paper_status ON paper_positions(status, opened_at DESC)').run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS paper_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, symbol TEXT, detail TEXT
  )`).run();
}

async function upsert(env: Env, p: Position): Promise<void> {
  await env.DB.prepare(`INSERT INTO paper_positions (id, symbol, product_id, status, opened_at, exit_at, exit_reason, realized_r, pnl_usd, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, exit_at = excluded.exit_at, exit_reason = excluded.exit_reason,
      realized_r = excluded.realized_r, pnl_usd = excluded.pnl_usd, data = excluded.data`)
    .bind(p.id, p.symbol, p.productId, p.status, p.openedAt, p.exitAt ?? null, p.exitReason ?? null,
          p.realizedR ?? null, p.pnlUsd ?? null, JSON.stringify(p)).run();
}

async function logEvent(env: Env, kind: string, symbol: string | null, detail: any): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO paper_events (at, kind, symbol, detail) VALUES (?, ?, ?, ?)')
      .bind(Date.now(), kind, symbol, JSON.stringify(detail).slice(0, 4000)).run();
  } catch { /* best-effort */ }
}

export async function loadClosed(env: Env, limit = 200): Promise<Position[]> {
  const r = await env.DB.prepare("SELECT data FROM paper_positions WHERE status = 'closed' ORDER BY exit_at DESC LIMIT ?").bind(limit).all();
  return ((r.results || []) as any[]).map(x => JSON.parse(x.data));
}

export async function loadAllClosed(env: Env): Promise<Position[]> {
  const r = await env.DB.prepare("SELECT data FROM paper_positions WHERE status = 'closed'").all();
  return ((r.results || []) as any[]).map(x => JSON.parse(x.data));
}

export function startPaperTrader(env: Env): void {
  const sim = new PaperSim(DEFAULT_FEES);
  const books = new Map<string, OrderBook>();
  let contracts: Record<string, ContractSpec | null> = {};
  let ws: WsClient | null = null;
  let attempts = 0;
  let subscribed = new Set<string>();
  const startedAt = Date.now();

  const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d });
  const short = (s: string) => s.replace(/USDT$/, '');

  // ── contracts ──
  const refreshContracts = async () => {
    try {
      const r = await fetch(PRODUCTS_URL, { headers: { 'User-Agent': 'MarketScope/1.0' } });
      const j: any = await r.json();
      contracts = resolveContracts(j.products ?? [], SYMBOLS, Date.now(), DEFAULT_STRUCTURE.holdingHorizonHours * 3600_000);
      status.contracts = Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, v?.productId ?? null]));
      const untradeable = Object.entries(contracts).filter(([, v]) => !v).map(([k]) => k);
      if (untradeable.length) console.log(`[paper] no US contract for: ${untradeable.join(', ')}`);
      resubscribe();
    } catch (e) { console.log(`[paper] contract refresh failed: ${e}`); }
  };

  const wantedProducts = (): string[] => {
    const set = new Set<string>();
    for (const c of Object.values(contracts)) if (c) set.add(c.productId);
    for (const p of sim.open) set.add(p.productId);          // keep feeding a rolled contract until closed
    return [...set];
  };

  // ── websocket ──
  const send = (channel: string, ids: string[]) => {
    if (!ws || ws.readyState !== 1 || !ids.length) return;
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ids, channel }));
  };
  const resubscribe = () => {
    const ids = wantedProducts();
    const fresh = ids.filter(i => !subscribed.has(i));
    if (!fresh.length || !ws || ws.readyState !== 1) return;
    for (const ch of ['level2', 'market_trades']) send(ch, fresh);
    fresh.forEach(i => subscribed.add(i));
  };

  const connect = () => {
    try { ws = new WsClient(WS_URL); } catch (e) { scheduleReconnect(`constructor threw: ${e}`); return; }
    subscribed = new Set();
    ws.addEventListener('open', () => {
      attempts = 0; status.state = 'open'; status.connectedAt = Date.now();
      send('heartbeats', []);
      ws!.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats' }));
      resubscribe();
      console.log(`[paper] connected; subscribing ${wantedProducts().join(', ') || '(nothing yet)'}`);
    });
    ws.addEventListener('message', (ev: any) => {
      let m: any;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      status.messages++;
      const now = Date.now();
      if (m.channel === 'l2_data') {
        status.lastL2At = now;
        for (const e of m.events ?? []) {
          let b = books.get(e.product_id);
          if (!b) { b = new OrderBook(); books.set(e.product_id, b); }
          if (e.type === 'snapshot') b.applySnapshot(e.updates ?? [], now); else b.applyUpdate(e.updates ?? [], now);
        }
      } else if (m.channel === 'market_trades') {
        status.lastTradeAt = now;
        for (const e of m.events ?? []) {
          if (e.type !== 'update') continue;               // the subscribe-time snapshot is history, not a print
          for (const t of e.trades ?? []) {
            const b = books.get(t.product_id);
            if (!b) continue;
            const evs = sim.onTrade(t.product_id, Number(t.price), Number(t.size), Date.parse(t.time) || now, b);
            for (const x of evs) void handle(x);
          }
        }
      } else if (m.type === 'error') {
        status.lastError = String(m.message ?? 'ws error').slice(0, 200);
        console.log(`[paper] ws error frame: ${status.lastError}`);
      }
    });
    ws.addEventListener('error', (ev: any) => { status.lastError = String(ev?.message ?? 'unknown').slice(0, 200); });
    ws.addEventListener('close', (ev: any) => scheduleReconnect(`closed (code ${ev?.code ?? '?'})`));
  };
  const scheduleReconnect = (why: string) => {
    attempts++; status.state = 'reconnecting'; status.attempts = attempts;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
    if (attempts === 1 || attempts % 10 === 0) console.log(`[paper] ${why} — reconnect #${attempts} in ${Math.round(delay / 1000)}s`);
    for (const b of books.values()) b.ready = false;         // a reconnect brings a fresh snapshot
    setTimeout(connect, delay).unref?.();
  };

  // ── events → persistence + push ──
  const handle = async (x: SimEvent) => {
    if (x.kind === 'rejected') { await logEvent(env, 'rejected', x.symbol, { reason: x.reason }); return; }
    const p = x.position;
    await upsert(env, p);
    await logEvent(env, x.kind, p.symbol, { id: p.id, contracts: p.contracts, entry: p.entryPrice, exit: p.exitPrice, reason: p.exitReason, r: p.realizedR, pnl: p.pnlUsd });
    if (x.kind === 'opened') {
      console.log(`[paper] OPENED ${p.symbol} SHORT ${p.contracts}x ${p.productId} @ ${fmt(p.entryPrice, 4)} (slip ${fmt(p.entrySlippageBps, 1)}bps, ${p.entryLevels} lvls) stop ${fmt(p.stopPrice, 4)} tgt ${fmt(p.targetPrice, 4)} risk $${fmt(p.riskUsd)}`);
      void pushToActiveDevices(env, `Paper: ${short(p.symbol)} SHORT opened`, `${p.contracts} × ${p.productId} @ ${fmt(p.entryPrice, 4)} · stop ${fmt(p.stopPrice, 4)} · risk $${fmt(p.riskUsd, 0)}`);
    } else {
      console.log(`[paper] CLOSED ${p.symbol} ${p.exitReason} @ ${fmt(p.exitPrice ?? 0, 4)} → ${(p.realizedR ?? 0) >= 0 ? '+' : ''}${fmt(p.realizedR ?? 0)}R ($${fmt(p.pnlUsd ?? 0)})`);
      void pushToActiveDevices(env, `Paper: ${short(p.symbol)} closed — ${p.exitReason}`, `${(p.realizedR ?? 0) >= 0 ? '+' : ''}${fmt(p.realizedR ?? 0)}R · $${fmt(p.pnlUsd ?? 0, 0)} · exit ${fmt(p.exitPrice ?? 0, 4)}`);
      await checkHalt();
    }
  };

  // ── equity + halt ──
  const equity = async (): Promise<number> => {
    const r: any = await env.DB.prepare("SELECT COALESCE(SUM(pnl_usd), 0) AS pnl FROM paper_positions WHERE status = 'closed'").first();
    return START_EQUITY + Number(r?.pnl ?? 0);
  };
  const checkHalt = async () => {
    const closed = await loadAllClosed(env);
    const s = paperStats(closed, START_EQUITY);
    if (s.maxDrawdownUsd >= START_EQUITY * HALT_DRAWDOWN && !status.halted) {
      status.halted = `drawdown $${fmt(s.maxDrawdownUsd, 0)} ≥ ${HALT_DRAWDOWN * 100}% of start equity`;
      await env.ALERTS.put('paper:halt', status.halted);
      await logEvent(env, 'halt', null, { reason: status.halted });
      void pushToActiveDevices(env, 'Paper bot HALTED', status.halted);
    }
  };

  // ── the signal run ──
  const runSignals = async () => {
    const nowMs = Date.now();
    try {
      const enabled = (await env.ALERTS.get('paper:enabled')) ?? '1';
      const halt = await env.ALERTS.get('paper:halt');
      status.halted = halt || null;
      if (enabled !== '1' || halt) { status.lastSignalRunAt = nowMs; status.lastSignalSummary = halt ? `halted: ${halt}` : 'disabled'; return; }
      const eq = await equity();
      const limits = { ...DEFAULT_LIMITS, id: `${DEFAULT_LIMITS.id}|paper`, maxRiskPerTrade: RISK };
      const book = await buildOpportunityBook(env, { symbols: SYMBOLS, equity: eq, structure: DEFAULT_STRUCTURE, limits, nowMs });
      const fg = SYMBOLS.map(s => book.preds?.[s]?.features?.fearGreedIndex).find((v: any) => typeof v === 'number' && v !== 50) ?? null;
      const { intents, skipped } = intentsFromBook(book.result.allocation.accepted as any, fg, eq, DEFAULT_INTENT_GATE);
      const outcomes: string[] = [];
      for (const it of intents) {
        const c = contracts[it.symbol];
        if (!c) { outcomes.push(`${it.symbol}: no US contract`); await logEvent(env, 'rejected', it.symbol, { reason: 'no US contract' }); continue; }
        const b = books.get(c.productId);
        if (!b) { outcomes.push(`${it.symbol}: no book`); await logEvent(env, 'rejected', it.symbol, { reason: 'no book' }); continue; }
        const ev = sim.openShort(it, c.productId, c.contractSize, b, nowMs);
        await handle(ev);
        outcomes.push(ev.kind === 'opened' ? `${it.symbol}: opened ${ev.position.contracts}x` : `${it.symbol}: ${ev.kind === 'rejected' ? ev.reason : ev.kind}`);
      }
      status.lastSignalRunAt = nowMs;
      status.lastSignalSummary = `${book.result.allocation.accepted.length} accepted, ${intents.length} intents, ${skipped.length} gated, ${book.unavailable.length} unavailable; ${outcomes.join('; ') || 'nothing to do'}`;
      await logEvent(env, 'signal-run', null, { equity: eq, summary: status.lastSignalSummary, skipped, unavailable: book.unavailable });
      console.log(`[paper] signal run: ${status.lastSignalSummary}`);
    } catch (e) {
      status.lastError = String(e).slice(0, 200);
      status.lastSignalRunAt = nowMs; status.lastSignalSummary = `error: ${status.lastError}`;
      console.log(`[paper] signal run failed: ${e}`);
    }
  };

  // ── clock: time exits + watchdog ──
  setInterval(() => {
    const now = Date.now();
    for (const x of sim.onClock(now, id => books.get(id))) void handle(x);
    if (status.state === 'open' && status.connectedAt && now - (status.lastL2At ?? status.connectedAt) > SILENT_MS && wantedProducts().length) {
      status.silentResets++;
      console.log(`[paper] SILENT for ${Math.round((now - (status.lastL2At ?? status.connectedAt)) / 1000)}s — reconnecting`);
      try { ws?.close(); } catch { /* close handler reconnects */ }
      if (status.state === 'open') scheduleReconnect('watchdog: silent');
    }
    if (status.state !== 'open' && now - (status.connectedAt ?? startedAt) > 5 * 60_000 && attempts === 0) connect();
  }, CLOCK_MS).unref?.();

  // ── status for /paper and /health ──
  (globalThis as any).__marketscopePaper = {
    status: () => ({ ...status, feedHealthy: status.state === 'open' && !!status.lastL2At && Date.now() - status.lastL2At < SILENT_MS }),
    open: () => sim.open.map(p => ({ ...p, unrealizedUsd: sim.unrealizedUsd(p, books.get(p.productId)), mark: books.get(p.productId)?.bestAsk() ?? null })),
    books: () => Object.fromEntries([...books.entries()].map(([k, b]) => [k, { ready: b.ready, bid: b.bestBid(), ask: b.bestAsk(), spreadBps: b.spreadBps(), levels: b.size() }])),
    closeManual: async (id: string) => { const p = sim.open.find(x => x.id === id); if (!p) return null; const b = books.get(p.productId); if (!b) return null; const ev = sim.closeManual(id, b, Date.now()); if (ev) await handle(ev); return ev; },
    runSignalsNow: runSignals,
    startEquity: START_EQUITY, symbols: SYMBOLS, risk: RISK,
  };

  // ── boot ──
  ensurePaperTables(env)
    .then(async () => {
      const r = await env.DB.prepare("SELECT data FROM paper_positions WHERE status = 'open'").all();
      const open: Position[] = ((r.results || []) as any[]).map(x => JSON.parse(x.data));
      sim.load(open);
      status.halted = await env.ALERTS.get('paper:halt');
      await refreshContracts();
      connect();
      setInterval(() => { void refreshContracts(); }, CONTRACT_REFRESH_MS).unref?.();
      // 3 minutes after each 4H close, UTC — the cron needs a minute or two to refresh ml_preds:all
      cron.schedule('3 0,4,8,12,16,20 * * *', () => { void runSignals(); }, { timezone: 'UTC' });
      console.log(`[paper] started: ${SYMBOLS.join(',')} · equity $${fmt(START_EQUITY, 0)} · risk ${RISK * 100}% · ${open.length} open restored · signals at 4H close +3m UTC`);
    })
    .catch(e => { status.state = 'init-failed'; status.lastError = String(e).slice(0, 200); console.log(`[paper] init failed: ${e}`); });
}
