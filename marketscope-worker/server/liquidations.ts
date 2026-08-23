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
// EGRESS (rewritten 2026-08-22 after this silently captured nothing for six weeks):
// the box's own IP is US and Binance serves NO websocket data to it — the socket opens and
// then stays mute forever, with no error and no close.
//
// REST rides gluetun's HTTP proxy (BINANCE_PROXY_URL) through undici's ProxyAgent and works.
// undici's WebSocket, however, IGNORES the dispatcher: `/health?probe=liquidations` measured
// proxied vs direct egress as CH/Zurich vs US/Virginia for fetch, while BOTH websocket paths
// behaved identically — impossible if one were really dialing from Zurich. So every socket
// attempt was leaving from the US address.
//
// Hence the `ws` client with an explicit HttpsProxyAgent, which tunnels wss through gluetun's
// CONNECT proxy for real. Chosen over `network_mode: service:gluetun` deliberately: that would
// force ALL egress (Claude, APNs, Yahoo) through the VPN and put the whole backend behind
// gluetun's killswitch, turning a VPN drop from "one dataset degrades" into "the app is down".
//
// D1 constraint (server/d1-adapter.ts): positional `?` placeholders only.

import { ProxyAgent, type Dispatcher } from 'undici';
import WsClient from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

interface Env { DB: any }

// Binance DECOMMISSIONED the legacy `/ws/` URL format on 2026-04-23, replacing it with
// category-scoped bases (/public, /market, /private). After that date the old endpoint still
// ACCEPTS connections and simply never pushes data — which is precisely the "open but silent"
// state this collector sat in.
//
// This collector shipped 2026-07-10, ~11 weeks AFTER the decommission, so it never captured a
// single event and never could have. Everything else investigated on 2026-08-22 — the US egress,
// the gluetun proxy, undici's dispatcher handling, the Swiss exit region — was real detail but
// none of it was the cause. REST kept working throughout because fapi.binance.com was unaffected;
// only the websocket host changed.
// Ref: developers.binance.com "Important WebSocket Change Notice".
const WS_URL_DEFAULT = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
/** The dead legacy endpoint — kept ONLY so the probe can demonstrate the difference on the box. */
const WS_URL_LEGACY = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const FLUSH_INTERVAL_MS = 5_000;
const BUFFER_CAP = 5_000;                 // safety valve for a market-wide cascade burst
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
// Silent-connection watchdog (2026-08-22). THE failure mode that cost six weeks of this
// non-backfillable series: Binance ACCEPTS the websocket and then serves no data. Verified by
// experiment — from a geoblocked IP, `!forceOrder@arr` AND a `btcusdt@aggTrade` control both
// reported open=true with zero messages in 20s, when aggTrade alone should deliver many per
// second. No 'error' fires and no 'close' fires, so the reconnect path — which only triggers on
// those two events — never runs. The collector logs `[liq] connected` once and then sits mute
// forever, and the logs look HEALTHY the entire time.
//
// So liveness must be judged on DATA, not on connection state. Across all USDⓈ-M symbols a
// forced liquidation lands far more often than this; several minutes of total silence means the
// socket is dead regardless of what its readyState claims.
const SILENT_TIMEOUT_MS = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 30_000;
/** How long the collector may sit in a non-open state before the watchdog forces a fresh attempt. */
const STUCK_TIMEOUT_MS = 2 * 60_000;

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
/**
 * Live collector state, readable over HTTP. This series CANNOT be backfilled, so a dead collector
 * has to be as visible as the cron dead-man's-switch — `/liquidations` returning an empty array
 * looks identical to a quiet market, which is exactly how six weeks went unnoticed.
 */
export interface LiqStatus {
  state: 'starting' | 'open' | 'reconnecting' | 'table-init-failed';
  connectedAt: number | null;
  lastMessageAt: number | null;
  messages: number;
  attempts: number;
  silentResets: number;
  lastError: string | null;
  /** Last time the collector made ANY progress (connect attempt or message) — drives the stuck check. */
  lastProgressAt?: number | null;
}
const status: LiqStatus = {
  state: 'starting', connectedAt: null, lastMessageAt: null,
  messages: 0, attempts: 0, silentResets: 0, lastError: null,
};
/** Snapshot for /health. `healthy` is judged on DATA FLOW, never on connection state. */
export function liquidationStatus(): LiqStatus & { healthy: boolean; quietSec: number | null } {
  const since = status.lastMessageAt ?? status.connectedAt;
  const quietSec = since ? Math.round((Date.now() - since) / 1000) : null;
  return { ...status, quietSec, healthy: status.state === 'open' && status.messages > 0 && (quietSec ?? 1e9) < SILENT_TIMEOUT_MS / 1000 };
}

/**
 * One-shot diagnostic for the collector's network path, served by `/health?probe=liquidations`.
 *
 * Exists because the failure modes are indistinguishable from outside and each implies a DIFFERENT
 * fix: a websocket rejected at the HTTP upgrade points at the proxy's handling of `Upgrade:` (fix =
 * put the container on gluetun's network so no proxy is involved); a websocket that OPENS and then
 * delivers nothing means the exit region is Binance-geoblocked (fix = change gluetun's exit
 * country). Six weeks were lost to guessing between them, so this measures both directly, plus the
 * REST controls that prove whether the route itself is sound.
 *
 * The egress IP is MASKED to two octets — enough to tell two exits apart, not enough to publish the
 * user's VPN endpoint on a public route.
 */
export async function probeLiquidationPath(): Promise<any> {
  const proxyUrl = process.env.BINANCE_PROXY_URL;
  const wsUrl = process.env.LIQ_WS_URL || WS_URL_DEFAULT;
  const dispatcher: Dispatcher | undefined = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const mask = (ip: string) => ip.split('.').slice(0, 2).join('.') + '.x.x';

  const rest = async (useProxy: boolean) => {
    try {
      const r = await fetch('https://fapi.binance.com/fapi/v1/time', {
        ...(useProxy && dispatcher ? { dispatcher } as any : {}),
        signal: AbortSignal.timeout(6000),
      });
      return { status: r.status, ok: r.ok };
    } catch (e) { return { status: 0, ok: false, error: String(e).slice(0, 140) }; }
  };

  const egress = async (useProxy: boolean) => {
    try {
      const r = await fetch('https://ipinfo.io/json', {
        ...(useProxy && dispatcher ? { dispatcher } as any : {}),
        signal: AbortSignal.timeout(6000),
      });
      const j: any = await r.json();
      return { country: j?.country ?? null, region: j?.region ?? null, ip: j?.ip ? mask(String(j.ip)) : null };
    } catch (e) { return { error: String(e).slice(0, 140) }; }
  };

  // Distinguishes "rejected at upgrade" from "opens then stays mute" — the whole point of the probe.
  const ws = (useProxy: boolean, client: 'undici' | 'ws', urlOverride?: string) => new Promise<any>((resolve) => {
    const t0 = Date.now();
    let opened = false, messages = 0, err: string | null = null, settled = false;
    let openedAt: number | null = null;   // captured AT the open event; computing it at resolution
                                          // made every path report ~the 10s timeout, hiding the
                                          // latency difference that reveals whether the proxy is
                                          // actually in the path.
    let sock: any = null;
    const done = (verdict: string) => {
      if (settled) return; settled = true;
      try { sock?.close(); } catch { /* ignore */ }
      resolve({ verdict, opened, messages, openedAfterMs: openedAt != null ? openedAt - t0 : null, error: err });
    };
    try {
      // `client` selects the implementation so the probe can PROVE which one honors the proxy:
      // undici's WebSocket ignored its dispatcher (both egress paths behaved identically), while
      // `ws` + HttpsProxyAgent tunnels through gluetun's CONNECT for real.
      const target = urlOverride ?? wsUrl;
      sock = client === 'ws'
        ? (new WsClient(target, useProxy && proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}) as any)
        : (new WebSocket(target, (useProxy && dispatcher ? { dispatcher } : {}) as any) as any);
    } catch (e) { err = String(e).slice(0, 140); return done('constructor-threw'); }
    sock.addEventListener('open', () => { opened = true; openedAt = Date.now(); });
    sock.addEventListener('message', () => { messages++; if (messages === 1) done('DELIVERING'); });
    sock.addEventListener('error', (ev: any) => { err = String(ev?.message ?? ev?.error ?? 'unknown').slice(0, 140); });
    sock.addEventListener('close', (ev: any) => {
      if (!opened) { err = err ?? `closed code ${ev?.code ?? '?'}`; done('REJECTED-AT-UPGRADE'); }
    });
    setTimeout(() => done(opened ? 'OPEN-BUT-SILENT (exit region likely geoblocked)' : 'NO-CONNECTION'), 10_000);
  });

  const [restProxy, restDirect, egProxy, egDirect] = await Promise.all([
    rest(true), rest(false), egress(true), egress(false),
  ]);
  const wsWsProxy = await ws(true, 'ws');
  const wsDirect = await ws(false, 'ws');
  // The decisive comparison: same client, same proxy, only the URL differs. A US dev machine
  // cannot run this test — the geoblock silences every stream — so it has to happen on the box.
  const wsLegacy = await ws(true, 'ws', WS_URL_LEGACY);
  return {
    proxyConfigured: !!proxyUrl,
    wsUrl,
    rest: { viaProxy: restProxy, direct: restDirect },
    egress: { viaProxy: egProxy, direct: egDirect },
    websocket: {
      wsViaProxy: wsWsProxy,           // NEW url + proxy — should DELIVER
      direct: wsDirect,                // NEW url, no proxy (US egress — expect silence)
      legacyViaProxy: wsLegacy,        // DEAD url + proxy — expect silence, proving the URL was the cause
    },
    collector: liquidationStatus(),
    hint: 'wsViaProxy DELIVERING while legacyViaProxy is silent => the decommissioned URL was the cause. '
        + 'BOTH silent => the exit IP is the problem after all. '
        + 'wsViaProxy OPEN-BUT-SILENT while undiciViaProxy is too => the tunnel is fine but that exit '
        + 'country is Binance-geoblocked: change gluetun SERVER_COUNTRIES (Singapore/Japan/Netherlands). '
        + 'wsViaProxy REJECTED-AT-UPGRADE => gluetun refuses CONNECT for wss; fall back to '
        + 'network_mode: service:gluetun (and move the 8787 port + FIREWALL_INPUT_PORTS to gluetun).',
  };
}

export function startLiquidationCollector(env: Env): void {
  const wsUrl = process.env.LIQ_WS_URL || WS_URL_DEFAULT;
  const proxyUrl = process.env.BINANCE_PROXY_URL;
  let buffer: LiquidationRow[] = [];
  let attempts = 0;
  let dropped = 0;
  let current: WebSocket | null = null;
  const startedAt = Date.now();

  // Flusher runs independently of connection state (drains whatever arrived before a drop).
  setInterval(() => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    flushLiquidations(env, batch).catch(e => console.log(`[liq] flush failed (${batch.length} rows): ${e}`));
  }, FLUSH_INTERVAL_MS).unref?.();

  const connect = () => {
    let ws: WsClient;
    try {
      // `ws` honors `agent`, so the CONNECT tunnel through gluetun is real (undici's WebSocket
      // silently ignored its dispatcher, which is what cost six weeks of this series).
      ws = new WsClient(wsUrl, proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {});
    } catch (e) {
      scheduleReconnect(`constructor threw: ${e}`);
      return;
    }

    current = ws;
    ws.addEventListener('open', () => {
      attempts = 0;
      status.state = 'open';
      status.connectedAt = Date.now();
      status.lastProgressAt = Date.now();
      // Deliberately NOT reset on open: the point is to detect a socket that opens and stays mute,
      // so the watchdog clock runs from the connection, not from the last message.
      console.log(`[liq] connected (${proxyUrl ? 'via gluetun proxy' : 'direct'}) — awaiting first event`);
    });

    ws.addEventListener('message', (ev: any) => {
      try {
        const row = parseForceOrder(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()));
        if (!row) return;
        if (buffer.length >= BUFFER_CAP) { dropped++; return; }   // cascade-burst safety valve
        buffer.push(row);
        if (status.messages === 0) console.log('[liq] first event received — stream is delivering');
        status.messages++;
        status.lastMessageAt = Date.now();
      } catch { /* malformed frame — ignore */ }
    });

    ws.addEventListener('error', (ev: any) => {
      status.lastError = String(ev?.message ?? ev?.error ?? 'unknown').slice(0, 200);
      console.log(`[liq] socket error: ${status.lastError}`);
      // 'close' always follows 'error' — reconnect happens there.
    });

    ws.addEventListener('close', (ev: any) => {
      scheduleReconnect(`closed (code ${ev?.code ?? '?'})${dropped ? `, ${dropped} dropped` : ''}`);
      dropped = 0;
    });
  };

  const scheduleReconnect = (why: string) => {
    attempts++;
    status.state = 'reconnecting';
    status.attempts = attempts;
    status.lastProgressAt = Date.now();
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 6));
    if (attempts === 1 || attempts % 10 === 0) {
      console.log(`[liq] ${why} — reconnect #${attempts} in ${Math.round(delay / 1000)}s`
        + (attempts >= 10 ? ' (persistent failure — check BINANCE_PROXY_URL / gluetun reachability)' : ''));
    }
    setTimeout(connect, delay).unref?.();
  };

  // Publish the status getter for the /health handler. A global rather than an import because
  // src/index.ts is the portable worker code and must not pull in Node-only modules; the handler
  // reads it defensively, so /health still works when the collector isn't running at all.
  (globalThis as any).__marketscopeLiqStatus = liquidationStatus;
  (globalThis as any).__marketscopeLiqProbe = probeLiquidationPath;

  // Watchdog: a socket that is open but mute is the failure this collector could not see.
  setInterval(() => {
    // A wedged NON-open collector is just as dead as a mute open one, and was not covered before:
    // observed live with state='starting', attempts=0 and lastError set — the boot-time 'error'
    // fired but no 'close' followed, so scheduleReconnect never ran and nothing ever retried. The
    // handler comment claiming "close always follows error" is simply not true for this failure.
    if (status.state !== 'open') {
      const stuckFor = Date.now() - (status.lastProgressAt ?? startedAt);
      if (stuckFor > STUCK_TIMEOUT_MS) {
        console.log(`[liq] stuck in '${status.state}' for ${Math.round(stuckFor / 1000)}s with no connection — forcing a retry (last error: ${status.lastError ?? 'none'})`);
        status.lastProgressAt = Date.now();
        connect();
      }
      return;
    }
    if (!status.connectedAt) return;
    const quietSince = status.lastMessageAt ?? status.connectedAt;
    const quietMs = Date.now() - quietSince;
    if (quietMs < SILENT_TIMEOUT_MS) return;
    console.log(`[liq] SILENT for ${Math.round(quietMs / 1000)}s while "connected" — treating as dead`
      + ` (total events since start: ${status.messages}). If this repeats, the gluetun exit is`
      + ` probably in a Binance-geoblocked region: the socket opens and Binance serves no data.`);
    status.silentResets++;
    try { current?.close(); } catch { /* the close handler drives the reconnect */ }
    // If close() does not fire (a wedged socket), force the reconnect path ourselves.
    if (status.state === 'open') scheduleReconnect('watchdog: silent connection');
  }, WATCHDOG_INTERVAL_MS).unref?.();

  ensureLiquidationsTable(env)
    .then(connect)
    .catch(e => {
      status.state = 'table-init-failed';
      status.lastError = String(e).slice(0, 200);
      console.log(`[liq] table init failed — collector NOT started: ${e}`);
    });
}
