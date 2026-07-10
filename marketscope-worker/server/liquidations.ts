// Binance USDⓈ-M forced-liquidation collector (box-only, 2026-07-10).
//
// WHY: liquidation events are the one derivatives series that CANNOT be backfilled — Binance
// removed the REST endpoint years ago; the data exists only as a live websocket stream
// (`!forceOrder@arr`, all symbols on one connection). Every uncollected day is gone forever.
// Uses: (a) ground truth for the homemade liquidation heatmap whose inputs `oi_snapshots`
// has accumulated since 2026-06-03 (predicted clusters vs observed cascades), (b) future
// cascade-exhaustion / asymmetry features (pre-declare a WF test before believing anything —
// see the whale-feature precedent in docs/research/rejected-hypotheses.md), (c) an observed
// forced-flow line in the analysis prompt (vs the inferred crowding reads).
//
// KNOWN FEED LIMITATION: since 2021 Binance pushes AT MOST one liquidation order per second
// per symbol — this is a SAMPLE (lower bound), not the full tape. All public liquidation
// totals (Coinglass included) share this cap. Fine for bursts/asymmetry/timing; never treat
// the sums as exact volumes.
//
// EGRESS: the box's residential IP is Binance-geoblocked; REST rides gluetun's HTTP proxy
// (BINANCE_PROXY_URL) via undici ProxyAgent. Gluetun's proxy supports CONNECT, so the
// websocket takes the same route (undici WebSocket accepts a custom dispatcher). The
// fetch-proxy monkey-patch does NOT cover websockets — the dispatcher here is explicit.
//
// D1 constraint (server/d1-adapter.ts): positional `?` placeholders only.

import { WebSocket, ProxyAgent, type Dispatcher } from 'undici';

interface Env { DB: any }

const WS_URL_DEFAULT = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const FLUSH_INTERVAL_MS = 5_000;
const BUFFER_CAP = 5_000;                 // safety valve for a market-wide cascade burst
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export interface LiquidationRow {
  symbol: string;
  ts: number;          // ms epoch (order trade time)
  side: 'long' | 'short';   // the LIQUIDATED side (SELL order = a long was force-closed)
  price: number;       // average fill price
  qty: number;         // filled quantity (base asset)
  notional: number;    // price × qty, USD
}

/** Parse one `forceOrder` stream message into a row. Exported for unit tests.
 *  Only FILLED orders are recorded (partial fills stream interim updates for the same order;
 *  the FILLED event carries the cumulative fill `z` + average price `ap`). USDT-quoted only. */
export function parseForceOrder(msg: any): LiquidationRow | null {
  if (!msg || msg.e !== 'forceOrder' || !msg.o) return null;
  const o = msg.o;
  if (o.X !== 'FILLED') return null;
  const symbol = String(o.s || '');
  if (!symbol.endsWith('USDT')) return null;
  const price = parseFloat(o.ap ?? o.p);
  const qty = parseFloat(o.z ?? o.q);
  if (!(price > 0) || !(qty > 0)) return null;
  return {
    symbol,
    ts: Number(o.T ?? msg.E ?? Date.now()),
    side: o.S === 'SELL' ? 'long' : 'short',
    price,
    qty,
    notional: price * qty,
  };
}

let liqTableReady = false;
export async function ensureLiquidationsTable(env: Env): Promise<void> {
  if (liqTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS liquidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    ts INTEGER NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    qty REAL NOT NULL,
    notional REAL NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_liq_symbol ON liquidations(symbol, ts DESC)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_liq_ts ON liquidations(ts)').run();
  liqTableReady = true;
}

/** Batched insert (one transaction). Exported for tests. */
export async function flushLiquidations(env: Env, rows: LiquidationRow[]): Promise<void> {
  if (!rows.length) return;
  await ensureLiquidationsTable(env);
  await env.DB.batch(rows.map(r => env.DB.prepare(
    'INSERT INTO liquidations (symbol, ts, side, price, qty, notional) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(r.symbol, r.ts, r.side, r.price, r.qty, r.notional)));
}

/** Start the collector: connect (via the gluetun proxy when configured), buffer parsed events,
 *  flush every 5s, reconnect with exponential backoff on any close/error. Binance also drops
 *  every connection at the 24h mark — the same reconnect path covers it. Runs for the process
 *  lifetime; never throws out of this function. */
export function startLiquidationCollector(env: Env): void {
  const wsUrl = process.env.LIQ_WS_URL || WS_URL_DEFAULT;
  const proxyUrl = process.env.BINANCE_PROXY_URL;
  const dispatcher: Dispatcher | undefined = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  let buffer: LiquidationRow[] = [];
  let attempts = 0;
  let dropped = 0;

  // Flusher runs independently of connection state (drains whatever arrived before a drop).
  setInterval(() => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    flushLiquidations(env, batch).catch(e => console.log(`[liq] flush failed (${batch.length} rows): ${e}`));
  }, FLUSH_INTERVAL_MS).unref?.();

  const connect = () => {
    let ws: WebSocket;
    try {
      // undici extension: options.dispatcher routes the CONNECT tunnel through gluetun.
      ws = new WebSocket(wsUrl, { dispatcher } as any);
    } catch (e) {
      scheduleReconnect(`constructor threw: ${e}`);
      return;
    }

    ws.addEventListener('open', () => {
      attempts = 0;
      console.log(`[liq] connected (${proxyUrl ? 'via gluetun proxy' : 'direct'})`);
    });

    ws.addEventListener('message', (ev: any) => {
      try {
        const row = parseForceOrder(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()));
        if (!row) return;
        if (buffer.length >= BUFFER_CAP) { dropped++; return; }   // cascade-burst safety valve
        buffer.push(row);
      } catch { /* malformed frame — ignore */ }
    });

    ws.addEventListener('error', (ev: any) => {
      console.log(`[liq] socket error: ${ev?.message ?? ev?.error ?? 'unknown'}`);
      // 'close' always follows 'error' — reconnect happens there.
    });

    ws.addEventListener('close', (ev: any) => {
      scheduleReconnect(`closed (code ${ev?.code ?? '?'})${dropped ? `, ${dropped} dropped` : ''}`);
      dropped = 0;
    });
  };

  const scheduleReconnect = (why: string) => {
    attempts++;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 6));
    if (attempts === 1 || attempts % 10 === 0) {
      console.log(`[liq] ${why} — reconnect #${attempts} in ${Math.round(delay / 1000)}s`
        + (attempts >= 10 ? ' (persistent failure — check BINANCE_PROXY_URL / gluetun reachability)' : ''));
    }
    setTimeout(connect, delay).unref?.();
  };

  ensureLiquidationsTable(env)
    .then(connect)
    .catch(e => console.log(`[liq] table init failed — collector NOT started: ${e}`));
}
