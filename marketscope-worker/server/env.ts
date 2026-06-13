// Builds the Env object the worker expects: real secrets from process.env + the three
// binding adapters (DB/ALERTS/MODELS). Keeps `src/index.ts` unchanged.

import { readFileSync } from 'node:fs';
import { D1Adapter } from './d1-adapter';
import { KVAdapter } from './kv-adapter';
import { R2Adapter } from './r2-adapter';

const DATA_DIR = process.env.DATA_DIR ?? '/data';

// Secrets the worker reads. APNS_PRIVATE_KEY is handled separately (file or base64 below);
// TWELVE_DATA_API_KEY_2 is optional.
const REQUIRED = [
  'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID',
  'CLAUDE_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY',
  'TWELVE_DATA_API_KEY', 'FINNHUB_API_KEY', 'FRED_API_KEY',
  'TIINGO_API_KEY', 'ALPHAVANTAGE_API_KEY',
];

export function buildEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

  // ── APNs key format trap ───────────────────────────────────────────────────────────────
  // buildAPNsJWT (src/index.ts:2167) does atob(APNS_PRIVATE_KEY) FIRST — it expects
  // base64(PEM), i.e. the Cloudflare secret value VERBATIM, NOT a raw .p8 PEM. Feeding a raw
  // PEM garbles through atob -> importKey throws -> the catch returns null -> every push
  // silently no-ops. So: prefer APNS_PRIVATE_KEY (already base64); if instead a .p8 FILE is
  // mounted, base64-encode its contents here so the worker's atob() yields the PEM back.
  const apnsKey =
    process.env.APNS_PRIVATE_KEY ??
    (process.env.APNS_PRIVATE_KEY_FILE
      ? Buffer.from(readFileSync(process.env.APNS_PRIVATE_KEY_FILE, 'utf8')).toString('base64')
      : undefined);
  if (!apnsKey) {
    throw new Error('APNs key missing: set APNS_PRIVATE_KEY (base64 PEM) or APNS_PRIVATE_KEY_FILE');
  }

  // ONE connection, shared by D1 + KV. Two handles on the same WAL file in one process is
  // needless contention.
  const d1 = new D1Adapter(`${DATA_DIR}/marketscope.db`);

  // Lazy-created tables: the worker creates pending_setups on-demand inside the POST
  // /pending-setups handler (index.ts:260), but the cron READS it every tick. On a fresh
  // SQLite DB that handler may never have run, so create it up front to match the live D1.
  d1.rawDb().exec(`
    CREATE TABLE IF NOT EXISTS pending_setups (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, symbol TEXT NOT NULL,
      direction TEXT NOT NULL, entry REAL NOT NULL, atr REAL NOT NULL,
      ml_at_registration REAL, expires_at INTEGER NOT NULL,
      registered_at INTEGER NOT NULL, notified INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pending_setups_symbol ON pending_setups(symbol);
    CREATE INDEX IF NOT EXISTS idx_pending_setups_device ON pending_setups(device_id);
  `);

  return {
    DB: d1,
    ALERTS: new KVAdapter(d1.rawDb()),
    MODELS: new R2Adapter(`${DATA_DIR}/models`),
    APNS_PRIVATE_KEY: apnsKey,
    AI_GATEWAY_BASE: process.env.AI_GATEWAY_BASE ?? '',
    // Self-hosted Binance proxy indirection: leave UNSET on TrueNAS (this service IS the box).
    // Present here only so setProxyConfig() reads them if a value is ever supplied.
    BINANCE_PROXY_BASE: process.env.BINANCE_PROXY_BASE,
    BINANCE_PROXY_SECRET: process.env.BINANCE_PROXY_SECRET,
    ...Object.fromEntries(REQUIRED.map((k) => [k, process.env[k]!])),
    TWELVE_DATA_API_KEY_2: process.env.TWELVE_DATA_API_KEY_2,
  } as any;
}

// Boot self-test: run the SAME decode + WebCrypto importKey path buildAPNsJWT uses and throw
// loudly if the key is malformed. Catches the base64-of-PEM mistake class at startup instead
// of as silent push loss days later. Mirrors index.ts:2175-2179.
export async function assertApnsKeyValid(env: { APNS_PRIVATE_KEY: string }) {
  const pem = atob(env.APNS_PRIVATE_KEY); // base64(PEM) -> PEM text
  const contents = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(contents), (c) => c.charCodeAt(0));
  await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
