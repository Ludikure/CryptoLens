// MarketScope Worker — Secure proxy with per-device isolation
// All API keys stay server-side. Device auth via signed tokens.

import { computeScore, type Candle as ScoreCandle, type ScoreResult } from './scoring';
import { mlPredict, mlPredictH72, mlPredictMeta, mlPredictQuantile, mlConfident, mlPredictDirection, buildMLInput } from './ml-predict';
import { computeAllFeatures, sectorETFForSymbol, type Candle as FullCandle, type FullFeatures } from './scoring-full';
import { aggregate1HTo4H_ET } from './aggregation';
import { computeFullIndicators } from './indicators-full';
import { buildUserPrompt, systemPrompt, parseSetups, type PromptIndicator, type PromptState } from './prompt';
import { fetchDerivativesEnrichment, fetchMacroEnrichment, fetchSpotPressureEnrichment, fetchSentimentEnrichment, fetchCrossAssetEnrichment } from './enrichment';

// Drop the most recent candle if it is still in-progress (closeTime > now).
// Without this, every minute's cron sees a different "current" close (the live tick),
// which mutates indicator values and ML features even though no candle has actually closed.
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};
function dropInProgress<T extends { time: number }>(candles: T[], interval: string): T[] {
  if (!candles.length) return candles;
  const ms = INTERVAL_MS[interval];
  if (!ms) return candles;
  const last = candles[candles.length - 1];
  return last.time + ms > Date.now() ? candles.slice(0, -1) : candles;
}

export interface Env {
  ALERTS: KVNamespace;       // Hot cache for market data
  DB: D1Database;            // Persistent state + candle archive
  MODELS: R2Bucket;          // ML models + archives
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_BUNDLE_ID: string;
  CLAUDE_API_KEY: string;
  GEMINI_API_KEY: string;
  DEEPSEEK_API_KEY: string;
  TWELVE_DATA_API_KEY: string;
  TWELVE_DATA_API_KEY_2?: string;
  FINNHUB_API_KEY: string;
  FRED_API_KEY: string;
  TIINGO_API_KEY: string;
  ALPHAVANTAGE_API_KEY: string;
  // Optional Cloudflare AI Gateway base, e.g.
  // https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_name>
  // When set, /analyze routes provider calls through the gateway (observability + caching +
  // fallback). When empty/unset, calls go direct — backward compatible.
  AI_GATEWAY_BASE?: string;
}

/// Route an upstream LLM call through Cloudflare AI Gateway when AI_GATEWAY_BASE is set,
/// else return the direct provider URL. The gateway URL shape is
/// `<base>/<provider-slug>/<upstream-path>` (host swapped, path preserved).
function aiGatewayURL(env: Env, providerSlug: string, upstreamPath: string, directURL: string): string {
  const base = env.AI_GATEWAY_BASE?.replace(/\/+$/, '');
  return base ? `${base}/${providerSlug}/${upstreamPath}` : directURL;
}

interface Alert {
  id: string;
  symbol: string;
  targetPrice: number;
  condition: 'above' | 'below';
  note: string;
  triggered: boolean;
}

interface DeviceRegistration {
  token: string;
  updatedAt: number;
}

const BINANCE_SPOT = 'https://data-api.binance.vision/api/v3';
const YAHOO_BASE = 'https://query1.finance.yahoo.com';
const TWELVE_DATA_BASE = 'https://api.twelvedata.com';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const TIINGO_IEX = 'https://api.tiingo.com/iex';
const TIINGO_DAILY = 'https://api.tiingo.com/tiingo/daily';
const ALPHAVANTAGE_BASE = 'https://www.alphavantage.co/query';

// Wildcard origin: the API is token-authed via the X-Auth-Token *header* (no cookies), so
// CORS '*' carries no CSRF risk — a cross-origin site still can't act without a valid token.
// Needed so the browser web app (marketscope-web.pages.dev) and the iOS capacitor app can
// both call the Worker. iOS was the only origin before; the hardcoded capacitor value
// blocked the web app entirely.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Device-ID, X-Auth-Token, X-App-ID',
};

// Limits
const RATE_LIMIT_ANALYZE = 30;   // AI calls per device per hour
const MAX_ALERTS = 50;           // Max alerts per device
const MAX_PROMPT_CHARS = 200_000; // ~50K tokens per field; fits within 1M context beta with room for thinking + output
const MAX_BODY_BYTES = 600_000;   // Max request body size (600KB) — covers system + user prompt + JSON wrapper headroom
const MAX_NOTE_LENGTH = 500;     // Max alert note length
const DEVICE_ID_REGEX = /^[a-zA-Z0-9-]{1,128}$/;
const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check — no KV, no auth
    if (path === '/' || path === '/health') {
      return json({ status: 'ok' });
    }

    // Dead-man's-switch for the cron pipeline. Public (no auth) so an external uptime
    // monitor can poll it. Returns 503 when the cron heartbeat is stale (> 10 min, i.e.
    // several missed minute-crons) — the whole ML + notification pipeline is down.
    if (path === '/cron-health') {
      const hb = await env.ALERTS.get('cron:heartbeat');
      const ageMs = hb ? Date.now() - Number(hb) : null;
      const stale = ageMs === null || ageMs > 10 * 60 * 1000;
      return json({ ok: !stale, heartbeatAgeSec: ageMs === null ? null : Math.round(ageMs / 1000) },
                  stale ? 503 : 200);
    }

    // Block non-app traffic — require app identifier header on all endpoints
    const appId = request.headers.get('X-App-ID');
    if (appId !== 'marketscope-ios') {
      return json({ error: 'Forbidden' }, 403);
    }

    // Enforce body size limit on POST requests (except candle uploads)
    if (request.method === 'POST' && path !== '/history') {
      const contentLength = parseInt(request.headers.get('Content-Length') || '0');
      if (contentLength > MAX_BODY_BYTES) {
        return json({ error: 'Request body too large' }, 413);
      }
    }

    // Device auth: server-issued token stored in X-Auth-Token header
    const deviceId = request.headers.get('X-Device-ID') || '';
    const authToken = request.headers.get('X-Auth-Token') || '';

    // Validate deviceId format to prevent KV key abuse
    if (deviceId && !DEVICE_ID_REGEX.test(deviceId)) {
      return json({ error: 'Invalid device ID format' }, 400);
    }

    // === Device registration — issues an auth token (D1) ===
    if (path === '/register' && request.method === 'POST') {
      try {
        const body = await request.json() as { deviceToken?: string };
        if (!deviceId) return json({ error: 'Missing device ID' }, 400);

        // Check D1 first, then KV fallback for legacy devices
        const device = await env.DB.prepare('SELECT auth_token FROM devices WHERE device_id = ?').bind(deviceId).first();
        const existing = (device?.auth_token as string) || await env.ALERTS.get(`auth:${deviceId}`);

        if (existing) {
          const providedToken = request.headers.get('X-Auth-Token') || '';
          if (!timingSafeEqual(providedToken, existing)) return json({ error: 'Unauthorized' }, 401);

          // Update push token + last_seen in D1
          await env.DB.prepare(
            'INSERT OR REPLACE INTO devices (device_id, push_token, auth_token, last_seen) VALUES (?, ?, ?, ?)'
          ).bind(deviceId, body.deviceToken || null, existing, new Date().toISOString()).run();
          return json({ ok: true });
        }

        // New device — rate limit by IP
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        // 20/24h per IP (was 3). The web app registers once per browser and persists the
        // token, but cache-clears / multiple browsers / a shared household IP made 3 too tight
        // — a single afternoon of testing exhausted it. Still anti-abuse, just web-friendly.
        const ipLimited = await checkRateLimit(env, `reg-ip:${ip}`, 20, 86400);
        if (ipLimited) return json({ error: 'Too many registrations. Try again tomorrow.' }, 429);

        const token = crypto.randomUUID() + '-' + crypto.randomUUID();
        // Write to D1 (primary) + KV (backward compat during migration)
        await env.DB.prepare(
          'INSERT INTO devices (device_id, push_token, auth_token) VALUES (?, ?, ?)'
        ).bind(deviceId, body.deviceToken || null, token).run();
        await env.ALERTS.put(`auth:${deviceId}`, token, { expirationTtl: 86400 * 90 });

        return json({ ok: true, authToken: token });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // All endpoints (except /register, /bls/actuals) require valid auth token.
    // /history is auth-gated; the iOS callers (BacktestEngine) send X-Auth-Token.
    if (path !== '/register' && path !== '/bls/actuals' && path !== '/derivatives' && path !== '/spot' && path !== '/candles/crypto' && path !== '/sentiment' && path !== '/darkpool' && !path.startsWith('/debug') && !path.startsWith('/twelvedata') && !path.startsWith('/finnhub/')) {
      if (!deviceId || !authToken) return json({ error: 'Unauthorized' }, 401);
      // Check D1 first, then KV fallback
      const device = await env.DB.prepare('SELECT auth_token FROM devices WHERE device_id = ?').bind(deviceId).first();
      const storedToken = (device?.auth_token as string) || await env.ALERTS.get(`auth:${deviceId}`);
      if (!storedToken || !timingSafeEqual(storedToken, authToken)) return json({ error: 'Unauthorized' }, 401);

      // Migrate legacy KV device to D1 on successful auth
      if (!device && storedToken) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO devices (device_id, auth_token) VALUES (?, ?)'
        ).bind(deviceId, storedToken).run();
      }

      const globalLimited = await checkRateLimit(env, `global:${deviceId}`, 60, 60);
      if (globalLimited) return json({ error: 'Rate limited. Try again in a minute.' }, 429);
    }

    // === Alert sync (D1) ===
    if (path === '/alerts' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      try {
        const body = await request.json() as { alerts: any[] };
        if (!body.alerts || !Array.isArray(body.alerts)) return json({ error: 'Missing alerts' }, 400);
        const validated = body.alerts.slice(0, MAX_ALERTS).map(validateAlert).filter((a): a is Alert => a !== null);
        // Write to D1
        const stmts = [env.DB.prepare('DELETE FROM alerts WHERE device_id = ?').bind(deviceId)];
        for (const a of validated) {
          stmts.push(env.DB.prepare(
            'INSERT INTO alerts (id, device_id, symbol, target_price, condition, note, triggered) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(a.id, deviceId, a.symbol, a.targetPrice, a.condition, a.note || '', a.triggered ? 1 : 0));
        }
        await env.DB.batch(stmts);
        return json({ ok: true, count: validated.length });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }
    if (path === '/alerts' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const rows = await env.DB.prepare(
        'SELECT id, symbol, target_price as targetPrice, condition, note, triggered FROM alerts WHERE device_id = ? AND triggered = 0'
      ).bind(deviceId).all();
      return json(rows.results);
    }
    if (path === '/alerts' && request.method === 'DELETE') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      await env.DB.prepare('DELETE FROM alerts WHERE device_id = ?').bind(deviceId).run();
      return json({ ok: true });
    }

    // === Pending Setup Tracking (entry-touched APNs) ===
    // iOS posts pending conditional setups here so the worker cron can monitor for
    // entry-zone touches and send a push notification when conditions are still
    // favorable. Closes the gap where a user-conditional entry sits silently waiting
    // until the user manually opens the app.
    if (path === '/pending-setups' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      try {
        // Lazy migration: idempotent. CREATE TABLE IF NOT EXISTS is a no-op after first
        // call. Schema kept here so the table can be recreated from source if needed.
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pending_setups (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          direction TEXT NOT NULL,
          entry REAL NOT NULL,
          atr REAL NOT NULL,
          ml_at_registration REAL,
          expires_at INTEGER NOT NULL,
          registered_at INTEGER NOT NULL,
          notified INTEGER DEFAULT 0
        )`).run();
        await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pending_setups_symbol ON pending_setups(symbol)`).run();
        await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pending_setups_device ON pending_setups(device_id)`).run();

        const body = await request.json() as {
          id: string; symbol: string; direction: string;
          entry: number; atr: number;
          mlAtRegistration?: number; expiresAt: number;
        };
        if (!body.id || !body.symbol || !body.direction ||
            typeof body.entry !== 'number' || typeof body.atr !== 'number' ||
            typeof body.expiresAt !== 'number') {
          return json({ error: 'Invalid request' }, 400);
        }
        const symbol = sanitizeSymbol(body.symbol);
        if (!symbol) return json({ error: 'Invalid symbol' }, 400);
        if (body.direction !== 'LONG' && body.direction !== 'SHORT') {
          return json({ error: 'Invalid direction' }, 400);
        }
        await env.DB.prepare(`INSERT OR REPLACE INTO pending_setups
          (id, device_id, symbol, direction, entry, atr, ml_at_registration, expires_at, registered_at, notified)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).bind(
          body.id, deviceId, symbol, body.direction,
          body.entry, body.atr,
          body.mlAtRegistration ?? null,
          body.expiresAt, Date.now()
        ).run();
        return json({ ok: true });
      } catch (e) {
        console.log(`[pending-setups POST] error: ${e}`);
        return json({ error: 'Invalid request' }, 400);
      }
    }
    if (path === '/pending-setups' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      try {
        const rows = await env.DB.prepare(
          'SELECT id, symbol, direction, entry, atr, ml_at_registration as mlAtRegistration, expires_at as expiresAt, registered_at as registeredAt, notified FROM pending_setups WHERE device_id = ?'
        ).bind(deviceId).all();
        return json(rows.results);
      } catch {
        return json([]);  // table may not exist yet
      }
    }
    const pendingDeleteMatch = path.match(/^\/pending-setups\/(.+)$/);
    if (pendingDeleteMatch && request.method === 'DELETE') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const id = pendingDeleteMatch[1];
      try {
        await env.DB.prepare('DELETE FROM pending_setups WHERE id = ? AND device_id = ?').bind(id, deviceId).run();
      } catch { /* table may not exist */ }
      return json({ ok: true });
    }

    // === AI Analysis Proxy ===
    if (path === '/analyze' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);

      // Rate limit per device
      const limited = await checkRateLimit(env, `analyze:${deviceId}`, RATE_LIMIT_ANALYZE);
      if (limited) return json({ error: 'Rate limited. Max 10 analyses per hour.' }, 429);

      try {
        const body = await request.json() as { model: string; system: string; prompt: string; provider?: string; thinkingBudget?: number };
        if (!body.prompt || !body.system) return json({ error: 'Missing prompt or system' }, 400);

        // Validate prompt size
        if (body.prompt.length > MAX_PROMPT_CHARS || body.system.length > MAX_PROMPT_CHARS) {
          return json({ error: 'Prompt too large' }, 413);
        }

        const provider = body.provider || 'claude';

        if (provider === 'deepseek') {
          // DeepSeek (OpenAI-compatible API). Models: deepseek-reasoner (R1) + deepseek-chat (V3).
          // R1 returns a `reasoning_content` field with its thinking, then `content` with the
          // final answer — we keep only `content` and normalize to Claude's response shape.
          if (!env.DEEPSEEK_API_KEY) return json({ error: 'DeepSeek not configured' }, 503);
          const DEEPSEEK_MODELS = ['deepseek-reasoner', 'deepseek-chat'];
          const model = DEEPSEEK_MODELS.includes(body.model) ? body.model : 'deepseek-reasoner';

          const resp = await fetch(aiGatewayURL(env, 'deepseek', 'v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions'), {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 8000,  // R1's reasoning + answer can be long
              temperature: 0,
              messages: [
                { role: 'system', content: body.system },
                { role: 'user', content: body.prompt },
              ],
            }),
          });

          if (!resp.ok) {
            const code = resp.status;
            if (code === 429) return json({ error: 'AI service busy. Try again shortly.' }, 429);
            if (code >= 500) return json({ error: 'AI service temporarily unavailable' }, 502);
            return json({ error: `AI error (${code})` }, code);
          }

          const dsResult = await resp.json() as any;
          const text = dsResult?.choices?.[0]?.message?.content || '';
          // Normalize to Claude's content envelope so iOS clients parse uniformly.
          return json({ content: [{ type: 'text', text }] });

        } else if (provider === 'gemini') {
          // Gemini
          if (!env.GEMINI_API_KEY) return json({ error: 'Gemini not configured' }, 503);
          const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];
          const model = GEMINI_MODELS.includes(body.model) ? body.model : 'gemini-2.5-flash';

          // Note: Gemini requires API key in URL (no header auth). Server-to-server only.
          const resp = await fetch(aiGatewayURL(env, 'google-ai-studio', `v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: body.system }] },
              contents: [{ parts: [{ text: body.prompt }] }],
              generationConfig: { maxOutputTokens: 2500, temperature: 0 },
            }),
          });

          if (!resp.ok) {
            const code = resp.status;
            if (code === 429) return json({ error: 'AI service busy. Try again shortly.' }, 429);
            if (code >= 500) return json({ error: 'AI service temporarily unavailable' }, 502);
            return json({ error: `AI error (${code})` }, code);
          }

          // Normalize Gemini response to Claude format for the app
          const gemResult = await resp.json() as any;
          const text = gemResult?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          return json({ content: [{ type: 'text', text }] });

        } else {
          // Claude (default)
          if (!env.CLAUDE_API_KEY) return json({ error: 'AI not configured' }, 503);
          const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'claude-sonnet-4-6';

          // Extended thinking: opt-in via thinkingBudget. Anthropic API requires
          // budget_tokens >= 1024 and < max_tokens. When enabled we bump max_tokens to
          // accommodate both thinking budget AND the response budget. temperature must be
          // 1.0 when thinking is enabled (per Anthropic API requirements).
          const thinkingBudget = body.thinkingBudget && body.thinkingBudget >= 1024 ? body.thinkingBudget : null;
          const requestBody: Record<string, unknown> = {
            model,
            max_tokens: thinkingBudget ? thinkingBudget + 4000 : 4000,
            temperature: thinkingBudget ? 1 : 0,
            system: body.system,
            messages: [{ role: 'user', content: body.prompt }],
          };
          if (thinkingBudget) {
            requestBody.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
          }

          // Sonnet 4.6 defaults to 200K context; the analysis prompt + indicator series
          // + economic events + news can push past that on busy macro days. The
          // `context-1m-2025-08-07` beta unlocks 1M context (input + thinking + output).
          // Cheap header, no behaviour change for smaller prompts.
          const resp = await fetch(aiGatewayURL(env, 'anthropic', 'v1/messages', 'https://api.anthropic.com/v1/messages'), {
            method: 'POST',
            headers: {
              'x-api-key': env.CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'context-1m-2025-08-07',
              'content-type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          if (!resp.ok) {
            const code = resp.status;
            if (code === 429) return json({ error: 'AI service busy. Try again shortly.' }, 429);
            if (code >= 500) return json({ error: 'AI service temporarily unavailable' }, 502);
            return json({ error: `AI error (${code})` }, code);
          }

          const result = await resp.json();
          return json(result);
        }
      } catch (e) {
        return json({ error: 'Analysis failed' }, 500);
      }
    }

    // === Tiingo Candles (cached 5min, shared) ===
    if (path === '/tiingo/candles') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval') || '1hour';  // 1hour or 1day
      const days = url.searchParams.get('days') || '60';
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.TIINGO_API_KEY) return json({ error: 'Tiingo not configured' }, 503);

      const cacheKey = `cache:tiingo:${symbol}:${interval}:${days}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        // Support explicit startDate/endDate params (for optimizer/backtester) or days-based
        const explicitStart = url.searchParams.get('startDate');
        const explicitEnd = url.searchParams.get('endDate');
        const startDate = explicitStart || new Date(Date.now() - parseInt(days) * 86400_000).toISOString().split('T')[0];
        const endParam = explicitEnd ? `&endDate=${explicitEnd}` : '';
        let apiUrl: string;
        if (interval === '1day') {
          apiUrl = `${TIINGO_DAILY}/${symbol}/prices?startDate=${startDate}${endParam}&token=${env.TIINGO_API_KEY}`;
        } else {
          apiUrl = `${TIINGO_IEX}/${symbol}/prices?startDate=${startDate}${endParam}&resampleFreq=${interval}&columns=open,high,low,close,volume&token=${env.TIINGO_API_KEY}`;
        }
        const resp = await fetch(apiUrl, {
          headers: { 'Content-Type': 'application/json' },
        });
        if (!resp.ok) return json({ error: `Tiingo ${resp.status}` }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Tiingo fetch failed' }, 502);
      }
    }

    // === Alpha Vantage Intraday (proxied, API key server-side) ===
    if (path === '/alphavantage/intraday') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval') || '60min';
      const month = url.searchParams.get('month') || '';
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.ALPHAVANTAGE_API_KEY) return json({ error: 'Alpha Vantage not configured' }, 503);

      try {
        const apiUrl = `${ALPHAVANTAGE_BASE}?function=TIME_SERIES_INTRADAY&symbol=${symbol}&interval=${interval}&month=${month}&outputsize=full&apikey=${env.ALPHAVANTAGE_API_KEY}`;
        const resp = await fetch(apiUrl);
        if (!resp.ok) return json({ error: `Alpha Vantage ${resp.status}` }, 502);
        const data = await resp.json();
        return json(data);
      } catch {
        return json({ error: 'Alpha Vantage fetch failed' }, 502);
      }
    }

    // === Twelve Data Candles (cached 5min, shared) ===
    if (path === '/twelvedata/candles') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval')?.replace(/[^0-9a-zA-Z]/g, '') || '1day';
      const startDate = url.searchParams.get('start_date')?.replace(/[^0-9\-\s:]/g, '') || '';
      const endDate = url.searchParams.get('end_date')?.replace(/[^0-9\-\s:]/g, '') || '';
      const outputsize = Math.min(parseInt(url.searchParams.get('outputsize') || '50'), 5000);
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.TWELVE_DATA_API_KEY) return json({ error: 'Twelve Data not configured' }, 503);

      const cacheKey = `cache:td:${symbol}:${interval}:${startDate || outputsize}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        // Round-robin between two API keys to double rate limit (16 req/min)
        const tdKeys = [env.TWELVE_DATA_API_KEY, env.TWELVE_DATA_API_KEY_2].filter(Boolean) as string[];
        const tdKey = tdKeys[Math.floor(Math.random() * tdKeys.length)];
        let apiUrl = `${TWELVE_DATA_BASE}/time_series?symbol=${symbol}&interval=${interval}&apikey=${tdKey}`;
        if (startDate && endDate) {
          apiUrl += `&start_date=${startDate}&end_date=${endDate}&outputsize=5000`;
        } else {
          apiUrl += `&outputsize=${outputsize}`;
        }
        const resp = await fetch(apiUrl);
        if (!resp.ok) return json({ error: `Twelve Data ${resp.status}` }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Twelve Data fetch failed' }, 502);
      }
    }

    // === Twelve Data Quote (cached 60s) ===
    if (path === '/twelvedata/quote') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.TWELVE_DATA_API_KEY) return json({ error: 'Twelve Data not configured' }, 503);

      const cacheKey = `cache:td-quote:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        const tdKeys2 = [env.TWELVE_DATA_API_KEY, env.TWELVE_DATA_API_KEY_2].filter(Boolean) as string[];
        const tdKey2 = tdKeys2[Math.floor(Math.random() * tdKeys2.length)];
        const resp = await fetch(`${TWELVE_DATA_BASE}/quote?symbol=${symbol}&apikey=${tdKey2}`);
        if (!resp.ok) return json({ error: `Twelve Data ${resp.status}` }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Twelve Data fetch failed' }, 502);
      }
    }

    // === Finnhub Enrichment (cached 24h for fundamentals, 1h for dynamic) ===
    // === Finnhub Market Status (special case — no symbol needed) ===
    if (path === '/finnhub/market-status') {
      if (!env.FINNHUB_API_KEY) return json({ error: 'Finnhub not configured' }, 503);
      const exchange = url.searchParams.get('symbol') || 'US';
      const cacheKey = `cache:fh:market-status:${exchange}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }
      try {
        const resp = await fetch(`${FINNHUB_BASE}/stock/market-status?exchange=${exchange}`, {
          headers: { 'X-Finnhub-Token': env.FINNHUB_API_KEY },
        });
        if (!resp.ok) return json({ error: `Finnhub ${resp.status}` }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Finnhub fetch failed' }, 502);
      }
    }

    // === BLS Economic Actuals (no auth — public data, cached 1h) ===
    if (path === '/bls/actuals') {
      const cacheKey = 'cache:bls:actuals:v2';
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 3600_000) return json(parsed.data);
      }

      // BLS v2 POST — all series in one request (no key needed, 25 req/day limit)
      const seriesIds = ['CUSR0000SA0', 'CUSR0000SA0L1E', 'LNS14000000', 'CES0000000001'];
      const actuals: Record<string, string> = {};

      try {
        const resp = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seriesid: seriesIds }),
        });
        if (!resp.ok) return json({ error: `BLS ${resp.status}` }, 502);
        const data = await resp.json() as any;
        const allSeries = data?.Results?.series || [];

        for (const s of allSeries) {
          const id = s.seriesID;
          const obs = s.data; // newest first
          if (!obs || obs.length < 2) continue;

          const latest = parseFloat(obs[0].value);
          const prev = parseFloat(obs[1].value);
          if (isNaN(latest) || isNaN(prev) || latest <= 0 || prev <= 0) continue;

          if (id === 'CUSR0000SA0') {
            actuals['CPI m/m'] = ((latest - prev) / prev * 100).toFixed(1) + '%';
            if (obs.length >= 13) {
              const yoy = parseFloat(obs[12].value);
              if (!isNaN(yoy) && yoy > 0) actuals['CPI y/y'] = ((latest - yoy) / yoy * 100).toFixed(1) + '%';
            }
          } else if (id === 'CUSR0000SA0L1E') {
            actuals['Core CPI m/m'] = ((latest - prev) / prev * 100).toFixed(1) + '%';
          } else if (id === 'LNS14000000') {
            actuals['Unemployment Rate'] = latest.toFixed(1) + '%';
          } else if (id === 'CES0000000001') {
            const diff = latest - prev;
            actuals['Non-Farm Employment Change'] = (diff >= 0 ? '+' : '') + diff.toFixed(0) + 'K';
          }
        }
      } catch { /* skip */ }

      const result = { actuals, fetchedAt: new Date().toISOString(), count: Object.keys(actuals).length };
      if (Object.keys(actuals).length > 0) {
        await env.ALERTS.put(cacheKey, JSON.stringify({ data: result, timestamp: Date.now() }), { expirationTtl: 3600 });
      }
      return json(result);
    }

    if (path.startsWith('/finnhub/')) {
      const endpoint = path.replace('/finnhub/', '');
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.FINNHUB_API_KEY) return json({ error: 'Finnhub not configured' }, 503);

      // Map endpoints to Finnhub URLs and cache TTLs
      const endpointMap: Record<string, { path: string; ttl: number; params?: string }> = {
        'recommendation': { path: '/stock/recommendation', ttl: 86400_000 },
        'metric': { path: '/stock/metric', ttl: 86400_000, params: '&metric=all' },
        'quote': { path: '/quote', ttl: 300_000 },
        'earnings': { path: '/calendar/earnings', ttl: 43200_000, params: `&from=${new Date(Date.now() - 30*86400_000).toISOString().split('T')[0]}&to=${new Date(Date.now() + 60*86400_000).toISOString().split('T')[0]}` },
        'news': { path: '/company-news', ttl: 3600_000, params: `&from=${new Date(Date.now() - 7*86400_000).toISOString().split('T')[0]}&to=${new Date().toISOString().split('T')[0]}` },
        'peers': { path: '/stock/peers', ttl: 86400_000 },
        'profile': { path: '/stock/profile2', ttl: 86400_000 },
        'insider': { path: '/stock/insider-transactions', ttl: 43200_000, params: '' },
      };

      const config = endpointMap[endpoint];
      if (!config) return json({ error: 'Unknown Finnhub endpoint' }, 404);

      // Optional from/to passthrough for endpoints that support date ranges (e.g., insider).
      // Keeps existing per-endpoint defaults (earnings/news) but lets callers override or add ranges.
      const fromParam = url.searchParams.get('from');
      const toParam = url.searchParams.get('to');
      const dateRangeStr = (fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam)) && (toParam && /^\d{4}-\d{2}-\d{2}$/.test(toParam))
        ? `&from=${fromParam}&to=${toParam}`
        : '';
      // Per-endpoint cache key includes from/to so different ranges don't collide.
      const rangeCacheKey = dateRangeStr ? `:${fromParam}:${toParam}` : '';
      const fullCacheKey = `cache:fh:${endpoint}:${symbol}${rangeCacheKey}`;
      const cachedRange = await env.ALERTS.get(fullCacheKey);
      if (cachedRange) {
        const parsed = JSON.parse(cachedRange);
        if (Date.now() - parsed.timestamp < config.ttl) return json(parsed.data);
      }

      try {
        // dateRangeStr (if provided) overrides config.params for endpoints that don't have hardcoded dates.
        const paramsToUse = dateRangeStr || (config.params || '');
        const finnhubUrl = `${FINNHUB_BASE}${config.path}?symbol=${symbol}${paramsToUse}`;
        const resp = await fetch(finnhubUrl, {
          headers: { 'X-Finnhub-Token': env.FINNHUB_API_KEY },
        });
        if (!resp.ok) return json({ error: `Finnhub ${resp.status}` }, 502);
        const data = await resp.json();
        const kvTtl = Math.max(Math.ceil(config.ttl / 1000), 60);
        await env.ALERTS.put(fullCacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: kvTtl });
        return json(data);
      } catch {
        return json({ error: 'Finnhub fetch failed' }, 502);
      }
    }

    // === Macro Data — now powered by FRED (cached 5m, shared) ===
    if (path === '/macro') {
      const cacheKey = 'cache:macro:v3';  // bumped to clear stale DXY data
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) {
          return json(parsed.data);
        }
      }

      const data: Record<string, any> = {};

      // FRED API — authoritative source for all macro data
      if (env.FRED_API_KEY) {
        const series: [string, string][] = [
          ['vix', 'VIXCLS'],
          ['treasury10Y', 'DGS10'],
          ['treasury2Y', 'DGS2'],
          ['fedFundsRate', 'FEDFUNDS'],
        ];
        for (const [key, seriesId] of series) {
          try {
            // FRED requires API key in URL. Server-to-server only.
            const resp = await fetch(`${FRED_BASE}?series_id=${seriesId}&sort_order=desc&limit=2&api_key=${env.FRED_API_KEY}&file_type=json`);
            if (resp.ok) {
              const result = await resp.json() as any;
              const obs = result?.observations;
              if (obs && obs.length > 0) {
                // Skip "." values (FRED uses "." for missing/unreported)
                const latest = obs.find((o: any) => o.value !== '.');
                if (latest) {
                  const val = parseFloat(latest.value);
                  data[key] = isNaN(val) ? null : val;
                  data[`${key}Date`] = latest.date;
                }
              }
            }
          } catch { /* skip */ }
        }
      }

      // USD Index (DXY) from Yahoo Finance — ICE US Dollar Index, same as TradingView
      try {
        const dxyResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/DX-Y.NYB?interval=1d&range=5d`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        });
        if (dxyResp.ok) {
          const dxyData = await dxyResp.json() as any;
          const meta = dxyData?.chart?.result?.[0]?.meta;
          const price = meta?.regularMarketPrice ?? meta?.previousClose;
          if (price != null && !isNaN(price) && price > 70 && price < 130) {
            data['usdIndex'] = Math.round(price * 100) / 100;
          }
        }
      } catch { /* skip */ }

      // Compute yield spread
      if (data.treasury10Y != null && data.treasury2Y != null) {
        data.yieldSpread = Math.round((data.treasury10Y - data.treasury2Y) * 100) / 100;
      }

      await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
      return json(data);
    }

    // === Yahoo Crumb Auth (cached 30 min) ===
    async function getYahooCrumb(env: Env): Promise<{cookie: string; crumb: string} | null> {
      const cacheKey = 'cache:yahoo-crumb';
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 1800_000) return parsed.data;
      }
      try {
        const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
        const fcResp = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': ua }, redirect: 'manual' });
        const setCookie = fcResp.headers.get('set-cookie') || '';
        const a3Match = setCookie.match(/A3=([^;]+)/);
        if (!a3Match) return null;
        const cookie = `A3=${a3Match[1]}`;
        const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
          headers: { 'User-Agent': ua, 'Cookie': cookie },
        });
        if (!crumbResp.ok) return null;
        const crumb = await crumbResp.text();
        if (!crumb || crumb.includes('Unauthorized')) return null;
        const result = { cookie, crumb };
        await env.ALERTS.put(cacheKey, JSON.stringify({ data: result, timestamp: Date.now() }), { expirationTtl: 1800 });
        return result;
      } catch { return null; }
    }

    // === Yahoo Proxies (cached) ===
    if (path === '/yahoo/quote') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:yahoo:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 30_000) return json(parsed.data);
      }

      try {
        const resp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=5d`);
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 60 });
        return json(data);
      } catch {
        return json({ error: 'Fetch failed' }, 502);
      }
    }

    if (path === '/yahoo/summary') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const modules = url.searchParams.get('modules')?.replace(/[^a-zA-Z,]/g, '') || 'defaultKeyStatistics,price';
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:yahoo-summary:${symbol}:${modules}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        let auth = await getYahooCrumb(env);
        const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
        let crumbParam = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : '';
        let headers: Record<string, string> = { 'User-Agent': ua };
        if (auth) headers['Cookie'] = auth.cookie;
        let resp = await fetch(`${YAHOO_BASE}/v10/finance/quoteSummary/${symbol}?modules=${modules}${crumbParam}`, { headers });
        // Retry with fresh crumb on 401
        if (resp.status === 401 && auth) {
          await env.ALERTS.delete('cache:yahoo-crumb');
          auth = await getYahooCrumb(env);
          crumbParam = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : '';
          headers = { 'User-Agent': ua };
          if (auth) headers['Cookie'] = auth.cookie;
          resp = await fetch(`${YAHOO_BASE}/v10/finance/quoteSummary/${symbol}?modules=${modules}${crumbParam}`, { headers });
        }
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Fetch failed' }, 502);
      }
    }

    if (path === '/yahoo/options') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:yahoo-options:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        let auth = await getYahooCrumb(env);
        const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
        let crumbParam = auth ? `?crumb=${encodeURIComponent(auth.crumb)}` : '';
        let headers: Record<string, string> = { 'User-Agent': ua };
        if (auth) headers['Cookie'] = auth.cookie;
        let resp = await fetch(`${YAHOO_BASE}/v7/finance/options/${symbol}${crumbParam}`, { headers });
        if (resp.status === 401 && auth) {
          await env.ALERTS.delete('cache:yahoo-crumb');
          auth = await getYahooCrumb(env);
          crumbParam = auth ? `?crumb=${encodeURIComponent(auth.crumb)}` : '';
          headers = { 'User-Agent': ua };
          if (auth) headers['Cookie'] = auth.cookie;
          resp = await fetch(`${YAHOO_BASE}/v7/finance/options/${symbol}${crumbParam}`, { headers });
        }
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Fetch failed' }, 502);
      }
    }

    // === Watchlist Sync (D1) ===
    if (path === '/watchlist' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const body = await request.json() as any;
      // Normalize through sanitizeSymbol + uppercase. The cron archive set and most
      // KV/prediction keys are uppercase by convention; a lowercase `btcusdt` from
      // a misbehaving client would otherwise create a parallel `btcusdt` archive
      // shadow and miss the shared `BTCUSDT` ARCHIVE_CRYPTO processing path.
      const symbols = (body.symbols || []).slice(0, 20)
        .map((s: any) => {
          if (typeof s !== 'string') return null;
          const clean = sanitizeSymbol(s);
          return clean ? clean.toUpperCase() : null;
        })
        .filter((s: string | null): s is string => s !== null);
      const cryptoThreshold = body.cryptoThreshold || 5;
      const stockThreshold = body.stockThreshold || 3;
      // Write to D1
      const stmts = [env.DB.prepare('DELETE FROM watchlist WHERE device_id = ?').bind(deviceId)];
      for (const s of symbols) {
        stmts.push(env.DB.prepare(
          'INSERT INTO watchlist (device_id, symbol, crypto_threshold, stock_threshold) VALUES (?, ?, ?, ?)'
        ).bind(deviceId, s, cryptoThreshold, stockThreshold));
      }
      // Refresh last_seen on this app-launch sync so the daily stale-device sweep
      // (deletes last_seen > 30d) doesn't orphan an actively-used device. Previously
      // last_seen was set ONLY on /register, which an authed app never calls again — so
      // every device got swept after 30 days, invalidating its token → blank ML "suddenly".
      stmts.push(env.DB.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?')
        .bind(new Date().toISOString(), deviceId));
      await env.DB.batch(stmts);
      // Also keep KV during migration (cron reads from KV)
      await env.ALERTS.put(`watchlist:${deviceId}`, JSON.stringify({
        symbols, cryptoThreshold, stockThreshold, updatedAt: Date.now()
      }), { expirationTtl: 86400 * 30 });
      return json({ ok: true, symbols: symbols.length });
    }

    // === ML Model Version (R2) ===
    // === ML Prediction Read (cron-cached) ===
    // Returns the latest cached ML probability + features for a symbol. Cache is populated
    // by the per-minute cron via a single `ml_preds:all` KV blob (5-min TTL) that maps
    // symbol → {symbol, probability, features, timestamp, isCrypto}. Was 76 separate
    // `ml_pred:<symbol>` keys; batching cut KV writes from ~3.3M/month to ~43K/month
    // (the dominant Cloudflare cost). Auth-gated via the standard header check above.
    if (path === '/ml-predict' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const cached = await env.ALERTS.get('ml_preds:all');
      if (!cached) return json({ error: 'No cached prediction', symbol }, 404);
      const entry = (JSON.parse(cached) as Record<string, any>)[symbol];
      if (!entry) return json({ error: 'No cached prediction', symbol }, 404);
      return json(entry);
    }

    // Full display indicators across daily/4H/1H — the shared analysis brain (no LLM). Both
    // the web app and (Phase 4) iOS render from this single implementation. crossAsset +
    // derivatives default to 0 here; /full-analysis supplies them for exact daily-crypto bias.
    if (path === '/indicators' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const isCrypto = symbol.endsWith('USDT');
      try {
        const { daily, fourH, oneH } = await fetchAllTimeframes(symbol, isCrypto);
        if (!daily.length) return json({ error: 'No candles', symbol }, 404);
        return json({
          symbol, isCrypto, timestamp: Date.now(),
          daily: computeFullIndicators(daily as FullCandle[], { timeframe: '1d', label: 'Daily', isCrypto }),
          fourH: fourH.length ? computeFullIndicators(fourH as FullCandle[], { timeframe: '4h', label: '4H', isCrypto }) : null,
          oneH: oneH.length ? computeFullIndicators(oneH as FullCandle[], { timeframe: '1h', label: '1H', isCrypto }) : null,
        });
      } catch (e) {
        return json({ error: `Indicator compute failed: ${e}`, symbol }, 502);
      }
    }

    // Full analysis — the shared brain end-to-end: candles → indicators → STATEFUL prompt
    // (buildUserPrompt, KV-backed regime/kill-duration/nakedPOC state) → LLM via the AI Gateway
    // → parsed setups. Both the web app and (Phase 4) iOS call this instead of building the
    // prompt client-side. v1 supplies the ML overlay + outcome history; richer enrichment
    // (derivatives/sentiment/macro/stockInfo) is layered in next — all optional in the builder.
    if (path === '/full-analysis' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const limited = await checkRateLimit(env, `analyze:${deviceId}`, RATE_LIMIT_ANALYZE);
      if (limited) return json({ error: 'Rate limited. Max 30 analyses per hour.' }, 429);

      let body: any = {};
      try { body = await request.json(); } catch { /* allow empty body; symbol may be in query */ }
      const symbol = sanitizeSymbol(body.symbol || url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const isCrypto = symbol.endsWith('USDT');

      try {
        const { daily, fourH, oneH } = await fetchAllTimeframes(symbol, isCrypto);
        if (!daily.length) return json({ error: 'No candles', symbol }, 404);
        const indicators: PromptIndicator[] = [computeFullIndicators(daily as FullCandle[], { timeframe: '1d', label: 'Daily', isCrypto }) as unknown as PromptIndicator];
        if (fourH.length) indicators.push(computeFullIndicators(fourH as FullCandle[], { timeframe: '4h', label: '4H', isCrypto }) as unknown as PromptIndicator);
        if (oneH.length) indicators.push(computeFullIndicators(oneH as FullCandle[], { timeframe: '1h', label: '1H', isCrypto }) as unknown as PromptIndicator);

        // ML overlay onto the daily indicator (cron-cached ml_preds:all; best-effort).
        try {
          const cached = await env.ALERTS.get('ml_preds:all');
          if (cached) {
            const e = (JSON.parse(cached) as Record<string, any>)[symbol];
            if (e) {
              const d = indicators[0];
              d.mlWinProbability = e.probability ?? null;
              d.mlPersistenceProbability = e.probabilityH72 ?? null;
              d.mlDirectionUp = e.pUp ?? null;
              d.mlConfident = e.confident ?? null;
              d.mlMetaDirection = e.metaDirection ?? null;
              d.mlMetaProbability = e.probabilityMeta ?? null;
              d.mlQ75 = e.q75 ?? null;
            }
          }
        } catch { /* ML overlay best-effort — prompt degrades gracefully without it */ }

        // Outcome feedback loop — last resolved trades for this device+symbol+model.
        let outcomeHistory: Array<{ direction: string; entry: number; outcome: string; mlProb?: number | null; conviction?: string | null }> = [];
        try {
          const modelVersion = isCrypto ? 11 : 13;
          const res = await env.DB.prepare(
            `SELECT direction, entry_price, outcome, ml_probability, conviction FROM trade_outcomes
             WHERE device_id = ? AND symbol = ? AND model_version = ? AND outcome IS NOT NULL
             ORDER BY opened_at DESC LIMIT 10`
          ).bind(deviceId, symbol, modelVersion).all();
          outcomeHistory = (res.results as any[]).map(r => ({ direction: r.direction, entry: r.entry_price, outcome: r.outcome, mlProb: r.ml_probability, conviction: r.conviction }));
        } catch { /* best-effort */ }

        // Enrichment (additive, best-effort, parallel). Crypto: Binance derivatives + positioning.
        // Both markets: macro (FRED/DXY from the /macro cache). The rest of the enrichment
        // (sentiment/stockInfo/stockSentiment/cross-asset/economic events) is layered in next.
        const [deriv, macro, spotPressure, sentiment, crossAsset] = await Promise.all([
          isCrypto ? fetchDerivativesEnrichment(env, symbol).catch(() => null) : Promise.resolve(null),
          fetchMacroEnrichment(env).catch(() => null),
          isCrypto ? fetchSpotPressureEnrichment(symbol).catch(() => null) : Promise.resolve(null),
          isCrypto ? fetchSentimentEnrichment(env, symbol).catch(() => null) : Promise.resolve(null),
          isCrypto ? fetchCrossAssetEnrichment().catch(() => null) : Promise.resolve(null),
        ]);

        // Stateful prompt build — KV-backed prevState (regime staleness, kill durations, naked POC).
        const stateKey = `prompt:${symbol}`;
        let prevState: PromptState = {};
        try { const s = await env.ALERTS.get(stateKey); if (s) prevState = JSON.parse(s) as PromptState; } catch { /* fresh state */ }
        const { prompt, newState } = buildUserPrompt({
          symbol, nowMs: Date.now(), indicators, outcomeHistory, prevState,
          derivatives: deriv?.derivatives ?? null, positioning: deriv?.positioning ?? null, macro, spotPressure, sentiment, crossAsset,
        });
        try { await env.ALERTS.put(stateKey, JSON.stringify(newState), { expirationTtl: 86400 * 7 }); } catch { /* state persist best-effort */ }

        if (prompt.length > MAX_PROMPT_CHARS) return json({ error: 'Prompt too large' }, 413);
        const system = systemPrompt(isCrypto);

        if (!env.CLAUDE_API_KEY) return json({ error: 'AI not configured' }, 503);
        const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'claude-sonnet-4-6';
        const resp = await fetch(aiGatewayURL(env, 'anthropic', 'v1/messages', 'https://api.anthropic.com/v1/messages'), {
          method: 'POST',
          headers: { 'x-api-key': env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'context-1m-2025-08-07', 'content-type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: 4000, temperature: 0, system, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!resp.ok) {
          const code = resp.status;
          if (code === 429) return json({ error: 'AI service busy. Try again shortly.' }, 429);
          if (code >= 500) return json({ error: 'AI service temporarily unavailable' }, 502);
          return json({ error: `AI error (${code})` }, code);
        }
        const result = await resp.json() as any;
        const text = result?.content?.[0]?.text || '';
        const setups = parseSetups(text);

        return json({
          symbol, isCrypto, timestamp: Date.now(), model, analysis: text, setups,
          ml: { win: indicators[0].mlWinProbability ?? null, persistence: indicators[0].mlPersistenceProbability ?? null, directionUp: indicators[0].mlDirectionUp ?? null },
          bias: { daily: indicators[0].bias, fourH: indicators[1]?.bias ?? null, oneH: indicators[2]?.bias ?? null },
        });
      } catch (e) {
        return json({ error: `Full analysis failed: ${e}`, symbol }, 500);
      }
    }

    if (path === '/ml-models/version') {
      try {
        const cryptoMeta = await env.MODELS.head('crypto/model-v3.json');
        const stockMeta = await env.MODELS.head('stock/model-v3.json');
        return json({
          crypto: { version: 'v3', features: 51, trees: 150, uploaded: cryptoMeta?.uploaded?.toISOString() },
          stock: { version: 'v3', features: 51, trees: 150, uploaded: stockMeta?.uploaded?.toISOString() }
        });
      } catch {
        return json({ error: 'Model info unavailable' }, 502);
      }
    }

    // === Derivatives Proxy (Binance fapi via Smart Placement) ===
    if (path === '/derivatives') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:deriv:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data); // 5min cache
      }

      const FAPI = 'https://fapi.binance.com';
      try {
        const [pi, fh, oi, oih, gls, ttls, tr] = await Promise.all([
          fetch(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=10`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=6`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${FAPI}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=1`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=1`).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        const data = { premiumIndex: pi, fundingHistory: fh, openInterest: oi, oiHistory: oih, globalLS: gls, topTraderLS: ttls, takerRatio: tr };

        // Only cache if we got meaningful data (premiumIndex is required)
        if (pi) {
          await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 300 });
        }
        return json(data);
      } catch {
        return json({ error: 'Derivatives fetch failed' }, 502);
      }
    }

    // === Spot Pressure Proxy (Binance order book + trades) ===
    if (path === '/spot') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:spot:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 60_000) return json(parsed.data); // 1min cache
      }

      try {
        const [depth, trades] = await Promise.all([
          fetch(`${BINANCE_SPOT}/depth?symbol=${symbol}&limit=20`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${BINANCE_SPOT}/trades?symbol=${symbol}&limit=200`).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        const data = { depth, trades };
        if (depth) {
          await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 60 });
        }
        return json(data);
      } catch {
        return json({ error: 'Spot fetch failed' }, 502);
      }
    }

    // === Crypto Candles Proxy (Binance via Smart Placement + D1 archive) ===
    if (path === '/candles/crypto') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval') || '1d';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '300'), 1000);
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:candles:${symbol}:${interval}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < (interval === '1d' ? 3600_000 : interval === '4h' ? 900_000 : 300_000)) {
          return json(parsed.data);
        }
      }

      try {
        const resp = await fetch(`${BINANCE_SPOT}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const raw = await resp.json() as any[];
        const candles = raw.map((k: any) => ({
          time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
        }));
        const ttl = interval === '1d' ? 3600 : interval === '4h' ? 900 : 300;
        await env.ALERTS.put(cacheKey, JSON.stringify({ data: candles, timestamp: Date.now() }), { expirationTtl: ttl });
        // Archive to D1
        archiveCandlesToD1(env, symbol, interval, candles).catch(() => {});
        return json(candles);
      } catch {
        return json({ error: 'Candle fetch failed' }, 502);
      }
    }

    // === Sentiment Proxy (CoinGecko) ===
    if (path === '/sentiment') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:sentiment:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 600_000) return json(parsed.data); // 10min
      }

      try {
        const coinId = symbol.replace('USDT', '').toLowerCase();
        const ids: Record<string, string> = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', xrp: 'ripple', bnb: 'binancecoin', ada: 'cardano', doge: 'dogecoin', avax: 'avalanche-2', dot: 'polkadot', link: 'chainlink' };
        const geckoId = ids[coinId] || coinId;
        const resp = await fetch(`https://api.coingecko.com/api/v3/coins/${geckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`);
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Sentiment fetch failed' }, 502);
      }
    }

    // === Debug: dump cron features ===
    if (path === '/debug/features') {
      const sym = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
      const raw = await env.ALERTS.get(`debug:${sym.toLowerCase()}_features`);
      if (raw) return json(JSON.parse(raw));
      return json({ error: 'No debug data yet' });
    }

    // === One-shot admin: backfill 1 year of derivatives history for a single crypto symbol ===
    // Only callable from the Mac (X-App-ID gate already filters non-app traffic). Used by
    // ml-training/backfill_derivatives.py since Binance fapi geo-blocks US IPs but the
    // Cloudflare worker reaches it fine from non-US edge nodes.
    if (path === '/debug/backfill-derivatives') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const days = parseInt(url.searchParams.get('days') || '365');
      const FAPI = 'https://fapi.binance.com';
      const BUCKET_MS = 4 * 3600 * 1000;
      const endMs = Date.now();
      const startMs = endMs - days * 86400 * 1000;

      // Bucket-aligned aggregator: bucketSec → field-map
      const buckets: Map<number, Record<string, number | null>> = new Map();
      const get = (ts: number) => {
        const k = Math.floor(ts / BUCKET_MS) * BUCKET_MS / 1000;  // sec
        if (!buckets.has(k)) {
          buckets.set(k, {
            funding_rate: null, open_interest: null, long_percent: null,
            taker_ratio: null, top_trader_long_pct: null,
            taker_buy_vol: null, taker_sell_vol: null,
          });
        }
        return buckets.get(k)!;
      };

      // 1) Funding rate (8h cadence — average to 4h bucket)
      const fundingRates: Map<number, number[]> = new Map();
      let curStart = startMs;
      while (curStart < endMs) {
        const r = await fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${curStart}&limit=1000`);
        if (!r.ok) break;
        const data = await r.json() as Array<{ fundingTime: number; fundingRate: string }>;
        if (!data.length) break;
        for (const d of data) {
          const k = Math.floor(d.fundingTime / BUCKET_MS) * BUCKET_MS / 1000;
          if (!fundingRates.has(k)) fundingRates.set(k, []);
          fundingRates.get(k)!.push(parseFloat(d.fundingRate));
        }
        const lastTs = Math.max(...data.map(d => d.fundingTime));
        if (lastTs <= curStart) break;
        curStart = lastTs + 1;
        if (data.length < 1000) break;
      }
      for (const [k, rates] of fundingRates) {
        get(k * 1000).funding_rate = rates.reduce((a, b) => a + b, 0) / rates.length;
      }

      // Helper: paginated 4h fetch. Binance /futures/data/* endpoints cap at 30 days per request,
      // so we walk back in 30-day windows providing explicit startTime + endTime.
      const WINDOW_DAYS = 29;  // 1 day buffer under the 30-day cap
      const WINDOW_MS = WINDOW_DAYS * 86400 * 1000;
      async function paginate4h(path: string): Promise<Array<{ timestamp: number; [k: string]: any }>> {
        const out: any[] = [];
        let winEnd = endMs;
        while (winEnd > startMs) {
          const winStart = Math.max(startMs, winEnd - WINDOW_MS);
          const url = `${FAPI}${path}?symbol=${symbol}&period=4h&startTime=${winStart}&endTime=${winEnd}&limit=500`;
          const r = await fetch(url);
          if (!r.ok) break;
          const data = await r.json() as any[];
          if (data.length) out.push(...data);
          if (winStart <= startMs) break;
          winEnd = winStart - 1;
        }
        return out;
      }

      // 2) Open interest history
      for (const d of await paginate4h('/futures/data/openInterestHist')) {
        const v = parseFloat(d.sumOpenInterestValue || d.sumOpenInterest || '0');
        if (v) get(+d.timestamp).open_interest = v;
      }
      // 3) Global long/short account ratio
      for (const d of await paginate4h('/futures/data/globalLongShortAccountRatio')) {
        const v = parseFloat(d.longAccount || '0');
        if (v) get(+d.timestamp).long_percent = v * 100;
      }
      // 4) Top trader long/short (smart money)
      for (const d of await paginate4h('/futures/data/topLongShortPositionRatio')) {
        const v = parseFloat(d.longAccount || '0');
        if (v) get(+d.timestamp).top_trader_long_pct = v * 100;
      }
      // 5) Taker buy/sell ratio + volumes
      for (const d of await paginate4h('/futures/data/takerlongshortRatio')) {
        const slot = get(+d.timestamp);
        slot.taker_ratio = parseFloat(d.buySellRatio || '0') || null;
        slot.taker_buy_vol = parseFloat(d.buyVol || '0') || null;
        slot.taker_sell_vol = parseFloat(d.sellVol || '0') || null;
      }

      // Insert into D1 in batches of 50 (D1 batch limit)
      let inserted = 0;
      const entries = Array.from(buckets.entries())
        .filter(([_, f]) => Object.values(f).some(v => v !== null))
        .sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < entries.length; i += 50) {
        const batch = entries.slice(i, i + 50);
        try {
          await env.DB.batch(batch.map(([ts, f]) => env.DB.prepare(
            'INSERT OR REPLACE INTO derivatives_history (symbol, timestamp, funding_rate, open_interest, long_percent, taker_ratio, top_trader_long_pct, taker_buy_vol, taker_sell_vol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(symbol, ts, f.funding_rate, f.open_interest, f.long_percent, f.taker_ratio, f.top_trader_long_pct, f.taker_buy_vol, f.taker_sell_vol)));
          inserted += batch.length;
        } catch (e) {
          // continue on partial failure
        }
      }
      return json({ symbol, buckets_total: buckets.size, inserted, days });
    }

    // === Dark Pool (FINRA RegSHO short sale volume) ===
    // Unauth'd cache read — IP-rate-limited so an enumerator can't strip-mine the
    // watchlist signal by hammering this endpoint.
    if (path === '/darkpool') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const dpLimited = await checkRateLimit(env, `darkpool-ip:${ip}`, 60, 60);
      if (dpLimited) return json({ error: 'Rate limited' }, 429);
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const dpCached = await env.ALERTS.get('darkpool:latest');
      if (dpCached) {
        const data = JSON.parse(dpCached) as Record<string, { ratio: number; zscore: number }>;
        if (data[symbol]) return json(data[symbol]);
      }
      return json({ ratio: 0.5, zscore: 0 });
    }

    // === D1 Candle History (permanent archive — for backtest/optimizer) ===
    if (path === '/history' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval') || '1d';
      const start = url.searchParams.get('start'); // Unix ms
      const end = url.searchParams.get('end');     // Unix ms
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      let query = 'SELECT timestamp, open, high, low, close, volume FROM candles WHERE symbol = ? AND interval = ?';
      const params: any[] = [symbol, interval];
      if (start) { query += ' AND timestamp >= ?'; params.push(parseInt(start)); }
      if (end) { query += ' AND timestamp <= ?'; params.push(parseInt(end)); }
      query += ' ORDER BY timestamp ASC LIMIT 100000';

      const rows = await env.DB.prepare(query).bind(...params).all();
      return json({ count: rows.results.length, candles: rows.results });
    }

    // Upload candles to D1 archive (from app backtest/stitching). Auth-gated by the
    // global gate above; the per-device rate limit caps abuse from a compromised token.
    if (path === '/history' && request.method === 'POST') {
      // 5 uploads / 5 min / device — generous for backtest runs, tight enough to bound
      // D1 write amplification from a single bad actor.
      const uploadLimited = await checkRateLimit(env, `history-upload:${deviceId}`, 5, 300);
      if (uploadLimited) return json({ error: 'Upload rate limited' }, 429);
      try {
        const body = await request.json() as { symbol: string; interval: string; candles: any[] };
        if (!body.symbol || !body.interval || !body.candles?.length) return json({ error: 'Missing fields' }, 400);
        const symbol = body.symbol.replace(/[^a-zA-Z0-9.^-]/g, '').substring(0, 20);
        const interval = body.interval;
        const candles = body.candles.slice(0, 5000); // Cap at 5000 per upload

        // Batch insert (50 at a time, D1 limit)
        let inserted = 0;
        for (let i = 0; i < candles.length; i += 50) {
          const batch = candles.slice(i, i + 50);
          try {
            await env.DB.batch(
              batch.map((c: any) =>
                env.DB.prepare(
                  'INSERT OR IGNORE INTO candles (symbol, interval, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(symbol, interval, c.time || c.timestamp, c.open, c.high, c.low, c.close, c.volume)
              )
            );
            inserted += batch.length;
          } catch { /* skip batch on error */ }
        }
        return json({ ok: true, inserted, total: candles.length });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // === Trade Outcomes (D1) ===
    if (path === '/outcomes' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      try {
        const body = await request.json() as any;
        if (!body.symbol || !body.direction || !body.entry) return json({ error: 'Missing required fields' }, 400);
        await env.DB.prepare(
          `INSERT INTO trade_outcomes
           (device_id, symbol, direction, entry_price, stop_loss, tp1, tp2,
            ml_probability, daily_score, four_h_score, conviction, outcome, pnl_percent,
            notes, model_version, prompt_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          deviceId, body.symbol, body.direction, body.entry, body.stopLoss || 0,
          body.tp1 || 0, body.tp2 || null, body.mlProb || null,
          body.dailyScore || null, body.fourHScore || null,
          body.conviction || null, body.outcome || null,
          body.pnlPercent || null, body.notes || null, body.modelVersion || null,
          body.promptVersion || null
        ).run();
        return json({ ok: true });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }
    if (path === '/outcomes' && request.method === 'PUT') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      try {
        const body = await request.json() as any;
        if (!body.id) return json({ error: 'Missing outcome ID' }, 400);
        await env.DB.prepare(
          'UPDATE trade_outcomes SET outcome = ?, pnl_percent = ?, closed_at = ?, notes = ? WHERE id = ? AND device_id = ?'
        ).bind(body.outcome, body.pnlPercent || null, new Date().toISOString(), body.notes || null, body.id, deviceId).run();
        return json({ ok: true });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }
    if (path === '/outcomes' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const symbol = url.searchParams.get('symbol');
      let query = 'SELECT * FROM trade_outcomes WHERE device_id = ?';
      const params: any[] = [deviceId];
      if (symbol) { query += ' AND symbol = ?'; params.push(symbol); }
      if (url.searchParams.get('model_version')) {
        query += ' AND model_version = ?';
        params.push(parseInt(url.searchParams.get('model_version')!));
      }
      if (url.searchParams.get('prompt_version')) {
        query += ' AND prompt_version = ?';
        params.push(url.searchParams.get('prompt_version')!);
      }
      if (url.searchParams.get('resolved') === 'true') {
        query += " AND outcome IS NOT NULL AND outcome NOT IN ('open', 'not_triggered')";
      }
      query += ' ORDER BY opened_at DESC LIMIT 100';
      const rows = await env.DB.prepare(query).bind(...params).all();
      return json(rows.results);
    }

    // === Score History (D1) ===
    if (path === '/scores' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
      let query = 'SELECT symbol, daily_score, four_h_score, ml_probability, bias, notification_sent, timestamp FROM score_history WHERE device_id = ?';
      const params: any[] = [deviceId];
      if (symbol) { query += ' AND symbol = ?'; params.push(symbol); }
      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);
      const rows = await env.DB.prepare(query).bind(...params).all();
      return json(rows.results);
    }

    // === Notification History (D1) ===
    if (path === '/notifications' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const rows = await env.DB.prepare(
        'SELECT * FROM notifications WHERE device_id = ? ORDER BY sent_at DESC LIMIT ?'
      ).bind(deviceId, limit).all();
      return json(rows.results);
    }

    // === Performance Dashboard (D1) ===
    if (path === '/performance') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const summary = await env.DB.prepare(`
        SELECT
          symbol,
          COUNT(*) as total_trades,
          SUM(CASE WHEN outcome IN ('TP1', 'TP2') THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN outcome = 'STOPPED' THEN 1 ELSE 0 END) as losses,
          AVG(CASE WHEN outcome IN ('TP1', 'TP2') THEN 1.0 ELSE 0.0 END) * 100 as win_rate,
          AVG(pnl_percent) as avg_pnl,
          AVG(ml_probability) as avg_ml_prob,
          SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as open_trades
        FROM trade_outcomes
        WHERE device_id = ?
        GROUP BY symbol
      `).bind(deviceId).all();

      const overall = await env.DB.prepare(`
        SELECT
          COUNT(*) as total_trades,
          AVG(CASE WHEN outcome IN ('TP1', 'TP2') THEN 1.0 ELSE 0.0 END) * 100 as win_rate,
          AVG(pnl_percent) as avg_pnl
        FROM trade_outcomes
        WHERE device_id = ? AND outcome IS NOT NULL
      `).bind(deviceId).first();

      return json({ bySymbol: summary.results, overall });
    }

    // Live forward track record for the dual-gate direction model. Universe-wide (not
    // per-device) — these signals are logged by the cron across all crypto symbols and
    // graded 24h later. This is the number that tells us whether the backtest's ~94%
    // holds out-of-sample. See logDirectionSignals/resolveDirectionSignals.
    if (path === '/direction-accuracy' && request.method === 'GET') {
      try {
        const overall = await env.DB.prepare(`
          SELECT
            COUNT(*) as resolved,
            SUM(correct) as correct,
            AVG(correct) * 100 as accuracy,
            SUM(CASE WHEN predicted_dir = 1 THEN 1 ELSE 0 END) as longs,
            SUM(CASE WHEN predicted_dir = -1 THEN 1 ELSE 0 END) as shorts
          FROM direction_signals WHERE resolved = 1
        `).first();
        const byConfidence = await env.DB.prepare(`
          SELECT
            CASE
              WHEN p_up >= 0.90 OR p_up <= 0.10 THEN '90+'
              WHEN p_up >= 0.80 OR p_up <= 0.20 THEN '80-90'
              ELSE '70-80'
            END as band,
            COUNT(*) as n,
            AVG(correct) * 100 as accuracy
          FROM direction_signals WHERE resolved = 1
          GROUP BY band ORDER BY band DESC
        `).all();
        // Accuracy split by predicted side. Directional models are often asymmetric
        // (e.g. shorts harder than longs in an up-drifting regime), and the holdout was
        // short-skewed — so pooled accuracy can mask a weak side. -1 = short, +1 = long.
        const byDirection = await env.DB.prepare(`
          SELECT predicted_dir, COUNT(*) as n, AVG(correct) * 100 as accuracy
          FROM direction_signals WHERE resolved = 1
          GROUP BY predicted_dir
        `).all();
        // Per-instrument breakdown — which symbols the model reads well vs poorly.
        // longs/shorts split per symbol too, so a symbol that's great short / weak long
        // is visible. Ordered by sample size so the most-evidenced symbols lead.
        const bySymbol = await env.DB.prepare(`
          SELECT symbol,
            COUNT(*) as n,
            SUM(correct) as correct,
            AVG(correct) * 100 as accuracy,
            SUM(CASE WHEN predicted_dir = 1 THEN 1 ELSE 0 END) as longs,
            SUM(CASE WHEN predicted_dir = 1 THEN correct ELSE 0 END) as long_correct,
            SUM(CASE WHEN predicted_dir = -1 THEN 1 ELSE 0 END) as shorts,
            SUM(CASE WHEN predicted_dir = -1 THEN correct ELSE 0 END) as short_correct
          FROM direction_signals WHERE resolved = 1
          GROUP BY symbol ORDER BY n DESC
        `).all();
        const pending = await env.DB.prepare(
          'SELECT COUNT(*) as n FROM direction_signals WHERE resolved = 0'
        ).first();
        const recent = await env.DB.prepare(`
          SELECT symbol, fired_at, p_up, predicted_dir, ml_win, fwd_return, correct
          FROM direction_signals WHERE resolved = 1
          ORDER BY resolve_at DESC LIMIT 20
        `).all();
        return json({
          overall: overall ?? { resolved: 0, correct: 0, accuracy: null, longs: 0, shorts: 0 },
          byConfidence: byConfidence.results ?? [],
          byDirection: byDirection.results ?? [],
          bySymbol: bySymbol.results ?? [],
          pending: (pending?.n as number) ?? 0,
          recent: recent.results ?? [],
          backtestBaseline: 94.7,   // frozen-holdout dual-gate accuracy for reference
        });
      } catch (e) {
        // Table not created yet (no cron has fired a signal) — return an empty shell.
        return json({ overall: { resolved: 0, accuracy: null }, byConfidence: [], byDirection: [], bySymbol: [], pending: 0, recent: [], backtestBaseline: 94.7 });
      }
    }

    // Live calibration of the ML quality model: realized goodR rate by predicted-probability
    // bucket. If predicted-70% bars hit ~70% in the wild, the model is still honest; large
    // gaps = drift. Universe-wide, forward, out-of-sample. See ml_calibration logging/grading.
    if (path === '/ml-calibration' && request.method === 'GET') {
      try {
        const buckets = await env.DB.prepare(`
          SELECT
            CASE
              WHEN predicted_prob < 0.30 THEN '00-30'
              WHEN predicted_prob < 0.50 THEN '30-50'
              WHEN predicted_prob < 0.60 THEN '50-60'
              WHEN predicted_prob < 0.70 THEN '60-70'
              ELSE '70-85' END as bucket,
            COUNT(*) as n,
            AVG(predicted_prob) * 100 as predicted,
            AVG(good_r) * 100 as realized
          FROM ml_calibration WHERE resolved = 1
          GROUP BY bucket ORDER BY bucket`).all();
        const overall = await env.DB.prepare(
          'SELECT COUNT(*) as resolved, SUM(CASE WHEN resolved=0 THEN 1 ELSE 0 END) as pending FROM ml_calibration'
        ).first();
        const pend = await env.DB.prepare('SELECT COUNT(*) as n FROM ml_calibration WHERE resolved = 0').first();
        return json({ buckets: buckets.results ?? [], resolved: (overall?.resolved as number) ?? 0, pending: (pend?.n as number) ?? 0 });
      } catch (e) {
        return json({ buckets: [], resolved: 0, pending: 0 });
      }
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkAllDeviceAlerts(env));
    ctx.waitUntil(checkAllDeviceScores(env));
    ctx.waitUntil(archiveShortInterest(env));
    ctx.waitUntil(cleanupStaleDevices(env));
  },
};

// === Short Interest Archive ===
// Daily snapshot of Yahoo's `shortPercentOfFloat` and `shortRatio` (days to cover) per stock.
// Yahoo updates these values bi-weekly from FINRA filings; one fetch per day per symbol is enough.
// Idempotent via KV gate (short_arch:last_date) — first cron firing of each UTC day does the work,
// remaining ~1439 firings of that day skip after a single KV read.
const ARCHIVE_STOCKS = [
  // Mirrors STOCK_SYMBOLS in ml-training/calibrate_v11_stocks.py (159 symbols).
  'AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'CRM', 'NFLX', 'AMD',
  'ORCL', 'ADBE', 'INTC', 'CSCO',
  'NOW', 'INTU', 'CRWD', 'PANW', 'FTNT', 'SNOW', 'DDOG', 'NET', 'ZS', 'WDAY', 'TEAM', 'MDB',
  'AVGO', 'QCOM', 'MU', 'AMAT', 'LRCX', 'MRVL', 'TXN', 'KLAC', 'ON', 'MCHP',
  'PLTR', 'ROKU', 'SHOP', 'SNAP', 'COIN', 'RBLX',
  'BYND', 'GME',
  'UBER', 'ABNB', 'BKNG', 'DASH', 'PYPL', 'SPOT', 'F', 'GM',
  'JPM', 'GS', 'MS', 'BAC', 'WFC', 'BLK', 'SCHW',
  'AXP', 'C', 'COF', 'USB', 'PNC', 'CME', 'ICE', 'AIG',
  'UNH', 'LLY', 'ABBV', 'JNJ', 'PFE', 'MRK', 'TMO',
  'AMGN', 'BMY', 'ABT', 'MDT', 'DHR', 'ISRG', 'BSX', 'SYK', 'CVS', 'ELV',
  'REGN', 'VRTX', 'GILD', 'BIIB',
  'HD', 'MA', 'V', 'DIS', 'NKE', 'SBUX', 'MCD', 'WMT', 'COST',
  'LOW', 'TGT', 'TJX', 'CMG', 'MAR', 'HLT', 'MGM',
  'CAT', 'DE', 'BA',
  'HON', 'MMM', 'GE', 'EMR', 'ETN', 'ITW', 'PH',
  'XOM', 'OXY', 'FANG', 'CVX', 'SLB',
  'COP', 'EOG', 'PSX', 'VLO',
  'LMT', 'RTX', 'GD', 'NOC',
  'UNP', 'FDX', 'DAL',
  'T', 'VZ', 'CMCSA', 'TMUS', 'CHTR',
  'SPG', 'O',
  'AMT', 'EQIX', 'PLD', 'CCI', 'PSA',
  // ETFs are skipped — short interest doesn't apply meaningfully
];

async function archiveShortInterest(env: Env) {
  const today = new Date().toISOString().split('T')[0];
  const lastDate = await env.ALERTS.get('short_arch:last_date');
  if (lastDate === today) return;  // already archived today

  const auth = await getYahooCrumb(env);
  if (!auth) return;
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  const headers = { 'User-Agent': ua, 'Cookie': auth.cookie };
  const crumbParam = `&crumb=${encodeURIComponent(auth.crumb)}`;

  // Process in parallel batches of 25 to keep total fetch time well under cron CPU limits.
  let inserted = 0;
  for (let i = 0; i < ARCHIVE_STOCKS.length; i += 25) {
    const batch = ARCHIVE_STOCKS.slice(i, i + 25);
    const stmts: any[] = [];
    await Promise.all(batch.map(async (symbol) => {
      try {
        const r = await fetch(
          `${YAHOO_BASE}/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics${crumbParam}`,
          { headers }
        );
        if (!r.ok) return;
        const data = await r.json() as any;
        const stats = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
        const shortPct = stats?.shortPercentOfFloat?.raw;
        const shortRatio = stats?.shortRatio?.raw;
        if (shortPct == null && shortRatio == null) return;
        stmts.push(env.DB.prepare(
          'INSERT OR REPLACE INTO short_interest_history (symbol, date, short_pct_of_float, days_to_cover) VALUES (?, ?, ?, ?)'
        ).bind(symbol, today, shortPct ?? null, shortRatio ?? null));
      } catch { /* skip on error */ }
    }));
    if (stmts.length) {
      try {
        await env.DB.batch(stmts);
        inserted += stmts.length;
      } catch { /* partial-failure is OK */ }
    }
  }
  await env.ALERTS.put('short_arch:last_date', today);
  console.log(`[short_arch] ${today}: ${inserted}/${ARCHIVE_STOCKS.length} symbols archived`);
}

// === Input Validation ===
function sanitizeSymbol(input: string | null): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^a-zA-Z0-9.%^-]/g, '').substring(0, 20);
  return cleaned || null;
}

/** Constant-time string comparison to prevent timing side-channel attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

/** Validate and sanitize an alert object. Returns null if invalid. */
function validateAlert(raw: any): Alert | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || raw.id.length > 128) return null;
  if (typeof raw.symbol !== 'string' || raw.symbol.length > 20) return null;
  if (typeof raw.targetPrice !== 'number' || !isFinite(raw.targetPrice) || raw.targetPrice <= 0) return null;
  if (raw.condition !== 'above' && raw.condition !== 'below') return null;
  const note = typeof raw.note === 'string' ? raw.note.substring(0, MAX_NOTE_LENGTH) : '';
  const triggered = raw.triggered === true;
  return { id: raw.id, symbol: raw.symbol, targetPrice: raw.targetPrice, condition: raw.condition, note, triggered };
}

// === Rate Limiting ===
async function checkRateLimit(env: Env, key: string, limit: number, windowSec: number = 3600): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const rlKey = `rl:${key}:${bucket}`;
  const current = parseInt(await env.ALERTS.get(rlKey) || '0');
  if (current >= limit) return true;
  await env.ALERTS.put(rlKey, String(current + 1), { expirationTtl: windowSec * 2 });
  return false;
}

// === Alert Checking (Cron — iterates all devices) ===
async function checkAllDeviceAlerts(env: Env) {
  // Get all devices with active alerts from D1
  const devices = await env.DB.prepare(
    'SELECT DISTINCT device_id FROM alerts WHERE triggered = 0'
  ).all();
  // Parallel + allSettled so one device's failure (rate-limited provider, malformed
  // alert row, etc.) doesn't push subsequent devices past the cron's wall-time budget.
  // Pre-fix this was sequential and a slow upstream could starve the tail of the list.
  const results = await Promise.allSettled(
    devices.results.map(row => checkDeviceAlerts(env, row.device_id as string))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.log(`[cron] alert check failed for ${devices.results[i].device_id}: ${r.reason}`);
    }
  });
}

async function checkDeviceAlerts(env: Env, deviceId: string) {
  const rows = await env.DB.prepare(
    'SELECT id, symbol, target_price as targetPrice, condition, note, triggered FROM alerts WHERE device_id = ? AND triggered = 0'
  ).bind(deviceId).all();
  const activeAlerts = rows.results as unknown as Alert[];
  if (activeAlerts.length === 0) return;

  const symbols = [...new Set(activeAlerts.map(a => a.symbol))];
  const prices: Record<string, number> = {};

  for (const symbol of symbols) {
    try {
      // Try Binance for crypto (USDT pairs), fallback to Coinbase
      if (symbol.endsWith('USDT')) {
        // Binance
        try {
          const resp = await fetch(`${BINANCE_SPOT}/ticker/price?symbol=${symbol}`);
          if (resp.ok) {
            const data = await resp.json() as { price: string };
            prices[symbol] = parseFloat(data.price);
            continue;
          }
        } catch { /* Binance failed */ }
        // Coinbase fallback (e.g., BTCUSDT → BTC-USD)
        try {
          const cbSymbol = symbol.replace('USDT', '-USD');
          const resp = await fetch(`https://api.exchange.coinbase.com/products/${cbSymbol}/ticker`);
          if (resp.ok) {
            const data = await resp.json() as { price: string };
            prices[symbol] = parseFloat(data.price);
            continue;
          }
        } catch { /* Coinbase failed */ }
      }
      // Stocks/ETFs — use Finnhub quote
      if (env.FINNHUB_API_KEY) {
        try {
          const resp = await fetch(`${FINNHUB_BASE}/quote?symbol=${symbol}`, {
            headers: { 'X-Finnhub-Token': env.FINNHUB_API_KEY },
          });
          if (resp.ok) {
            const data = await resp.json() as { c: number };
            if (data.c && data.c > 0) { prices[symbol] = data.c; continue; }
          }
        } catch { /* Finnhub failed */ }
      }
    } catch { /* skip */ }
  }

  console.log(`[cron] prices: ${JSON.stringify(prices)}`);
  const triggered: Alert[] = [];
  for (const alert of activeAlerts) {
    const price = prices[alert.symbol];
    if (!price) { console.log(`[cron] no price for ${alert.symbol}`); continue; }
    const hit = alert.condition === 'above' ? price >= alert.targetPrice : price <= alert.targetPrice;
    console.log(`[cron] ${alert.symbol} ${alert.condition} ${alert.targetPrice} vs ${price} → ${hit ? 'TRIGGERED' : 'no'}`);
    if (hit) {
      alert.triggered = true;
      triggered.push(alert);
    }
  }

  if (triggered.length === 0) return;

  // Mark triggered alerts in D1
  for (const alert of triggered) {
    await env.DB.prepare(
      'UPDATE alerts SET triggered = 1, triggered_at = ? WHERE id = ?'
    ).bind(new Date().toISOString(), alert.id).run();
  }

  // Get push token from D1
  const deviceRow = await env.DB.prepare('SELECT push_token FROM devices WHERE device_id = ?').bind(deviceId).first();
  let pushToken = deviceRow?.push_token as string | null;
  if (!pushToken) {
    const deviceData = await env.ALERTS.get(`device:${deviceId}`);
    if (!deviceData) return;
    const device = JSON.parse(deviceData);
    pushToken = device.pushToken || device.token;
  }
  if (!pushToken) return;

  for (const alert of triggered) {
    const price = prices[alert.symbol];
    const name = alert.symbol.replace('USDT', '');
    const title = `${name} Alert`;
    const body = `${name} hit $${price?.toLocaleString('en-US', { maximumFractionDigits: 2 })} (${alert.condition} $${alert.targetPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })})`;
    const result = await sendAPNs(env, pushToken, title, body);
    if (result === 'unregistered') {
      await deleteDevice(env, deviceId);
      return;
    }
  }
}

// === APNs ===
type APNsResult = 'sent' | 'unregistered' | 'failed';

async function sendAPNs(env: Env, deviceToken: string, title: string, body: string): Promise<APNsResult> {
  // Try sandbox first (development builds), fall back to production
  const endpoints = [
    'https://api.sandbox.push.apple.com',
    'https://api.push.apple.com',
  ];

  try {
    const jwt = await buildAPNsJWT(env);
    if (!jwt) { console.error('APNs: JWT build returned null'); return 'failed'; }

    let lastStatus: number | null = null;
    let lastBody = '';
    for (const endpoint of endpoints) {
      const resp = await fetch(`${endpoint}/3/device/${deviceToken}`, {
        method: 'POST',
        headers: {
          'authorization': `bearer ${jwt}`,
          'apns-topic': env.APNS_BUNDLE_ID || 'com.ludikure.CryptoLens',
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          aps: { alert: { title, body }, sound: 'default', badge: 1 },
        }),
      });

      if (resp.ok) {
        console.log(`APNs sent via ${endpoint.includes('sandbox') ? 'sandbox' : 'production'}`);
        return 'sent';
      }
      lastStatus = resp.status;
      lastBody = await resp.text();
      const env_ = endpoint.includes('sandbox') ? 'sandbox' : 'prod';
      console.error(`APNs ${env_} ${resp.status}: ${lastBody}`);
      // Only break on responses that conclusively describe the token itself — anything
      // else (transient sandbox 5xx, rate-limit 429, generic network failure surfaced
      // as 500) should still attempt production, since a production token rejected by
      // sandbox for non-token reasons would otherwise be permanently stranded.
      // Conclusive token-level errors: 400 BadDeviceToken doesn't apply (we want to
      // fall through to prod), but 410 Unregistered, 403 InvalidProviderToken (key
      // misconfig), and 413 PayloadTooLarge all describe the request/token, not the
      // endpoint, so retrying production is pointless.
      if (resp.status === 400 && lastBody.includes('BadDeviceToken')) continue;
      if (resp.status === 410 || resp.status === 403 || resp.status === 413) break;
      // Transient: try production as a fallback. Worst case, prod also fails the same
      // way and we surface the prod error to the caller.
      continue;
    }
    // 410 from production = token unregistered (uninstall, device wipe). Sandbox 410 we
    // distrust (token may still be valid via prod), so treat only the last-tried endpoint
    // as authoritative. Since the sandbox→prod fallthrough only happens on 400 BadDeviceToken,
    // any 410 we surface is from whichever endpoint was the actual route for this token.
    return lastStatus === 410 ? 'unregistered' : 'failed';
  } catch (e) {
    console.error(`APNs send failed: ${e}`);
    return 'failed';
  }
}

// Cascade-delete every row tied to a device. Called when APNs returns 410 (token dead)
// or by the daily stale-device sweep. D1 doesn't enforce the watchlist FK, so we delete
// children explicitly. notif_claims is keyed by push_token, not device_id, so we look
// up the token first and delete by that.
async function deleteDevice(env: Env, deviceId: string) {
  const row = await env.DB.prepare('SELECT push_token FROM devices WHERE device_id = ?').bind(deviceId).first();
  const pushToken = (row?.push_token as string | null) ?? null;
  const stmts = [
    env.DB.prepare('DELETE FROM watchlist WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM score_history WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM notifications WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM alerts WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM devices WHERE device_id = ?').bind(deviceId),
  ];
  if (pushToken) {
    stmts.push(env.DB.prepare('DELETE FROM notif_claims WHERE push_token = ?').bind(pushToken));
  }
  await env.DB.batch(stmts);
  await env.ALERTS.delete(`device:${deviceId}`);
  await env.ALERTS.delete(`watchlist:${deviceId}`);
  console.log(`[cleanup] deleted device ${deviceId}`);
}

// Daily sweep: prune devices that haven't checked in for 30 days. Idempotent — KV-gated to
// run once per UTC day. iOS rotates device_id on auth recovery (see PushService.handleAuthFailure),
// orphaning the old D1 row immediately. Without this sweep those orphans accumulate forever
// and the per-cron device pass walks them all (one row per minute per orphan), wasting
// compute and writing dead score_history rows.
const STALE_DEVICE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function cleanupStaleDevices(env: Env) {
  const today = new Date().toISOString().split('T')[0];
  const lastDate = await env.ALERTS.get('cleanup:last_date');
  if (lastDate === today) return;

  const cutoffIso = new Date(Date.now() - STALE_DEVICE_AGE_MS).toISOString();
  const stale = await env.DB.prepare(
    'SELECT device_id FROM devices WHERE last_seen < ? OR last_seen IS NULL'
  ).bind(cutoffIso).all();
  for (const row of stale.results) {
    try {
      await deleteDevice(env, row.device_id as string);
    } catch (e) {
      console.log(`[cleanup] failed for ${row.device_id}: ${e}`);
    }
  }
  // Also expire stale notif_claims whose tokens no longer map to any device.
  await env.DB.prepare(
    'DELETE FROM notif_claims WHERE push_token NOT IN (SELECT push_token FROM devices WHERE push_token IS NOT NULL)'
  ).run();
  await env.ALERTS.put('cleanup:last_date', today, { expirationTtl: 86400 * 2 });
  console.log(`[cleanup] sweep complete: ${stale.results.length} stale devices removed`);
}

// Apple validates the JWT against `iat` and accepts tokens up to ~1h old. We cache for
// 50 minutes (well inside Apple's window) so a single cron tick that sends N notifications
// reuses one JWT instead of rebuilding (crypto.subtle.importKey + sign per send was the
// dominant per-notification cost). Process-local memory; cron isolates restart cleanly.
let cachedAPNsJWT: { jwt: string; expiresAt: number } | null = null;
const APNS_JWT_TTL_MS = 50 * 60 * 1000;

async function buildAPNsJWT(env: Env): Promise<string | null> {
  if (cachedAPNsJWT && Date.now() < cachedAPNsJWT.expiresAt) {
    return cachedAPNsJWT.jwt;
  }
  try {
    const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_PRIVATE_KEY: privateKeyB64 } = env;
    if (!keyId || !teamId || !privateKeyB64) return null;

    const privateKeyPem = atob(privateKeyB64);
    const pemContents = privateKeyPem.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
    const keyData = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

    const header = btoa(JSON.stringify({ alg: 'ES256', kid: keyId })).replace(/=/g, '');
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(JSON.stringify({ iss: teamId, iat: now })).replace(/=/g, '');
    const signingInput = `${header}.${payload}`;

    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const jwt = `${header}.${payload}.${sigB64}`;
    cachedAPNsJWT = { jwt, expiresAt: Date.now() + APNS_JWT_TTL_MS };
    return jwt;
  } catch {
    console.error('JWT build failed');
    return null;
  }
}

// === Server-Side Score Notifications ===

// Crypto symbols processed every cron pass for D1 archive coverage of derivatives,
// regardless of any device's watchlist. Matches the model's training universe.
const ARCHIVE_CRYPTO = [
  // Pre-2021
  'BTCUSDT', 'ETHUSDT', 'BCHUSDT', 'XRPUSDT', 'LTCUSDT', 'TRXUSDT', 'ETCUSDT', 'LINKUSDT', 'XLMUSDT', 'ADAUSDT',
  'XMRUSDT', 'DASHUSDT', 'ZECUSDT', 'XTZUSDT', 'BNBUSDT', 'ATOMUSDT', 'ONTUSDT', 'IOTAUSDT', 'BATUSDT', 'VETUSDT',
  'NEOUSDT', 'QTUMUSDT', 'IOSTUSDT', 'THETAUSDT', 'ALGOUSDT', 'ZILUSDT', 'KNCUSDT', 'ZRXUSDT', 'COMPUSDT', 'DOGEUSDT',
  'KAVAUSDT', 'BANDUSDT', 'RLCUSDT', 'SNXUSDT', 'DOTUSDT', 'YFIUSDT', 'CRVUSDT', 'TRBUSDT', 'RUNEUSDT', 'SUSHIUSDT',
  'EGLDUSDT', 'SOLUSDT', 'ICXUSDT', 'STORJUSDT', 'UNIUSDT', 'AVAXUSDT', 'ENJUSDT', 'KSMUSDT', 'NEARUSDT', 'AAVEUSDT',
  'FILUSDT', 'RSRUSDT', 'BELUSDT', 'AXSUSDT', 'SKLUSDT', 'GRTUSDT',
  // Post-2021
  'SANDUSDT', 'MANAUSDT', 'HBARUSDT', 'MATICUSDT', 'ICPUSDT', 'DYDXUSDT', 'GALAUSDT',
  'IMXUSDT', 'GMTUSDT', 'APEUSDT', 'INJUSDT', 'LDOUSDT', 'APTUSDT',
  'ARBUSDT', 'SUIUSDT', 'PENDLEUSDT', 'SEIUSDT', 'TIAUSDT', 'JUPUSDT', 'PEPEUSDT',
];

const ML_THRESHOLD = 0.70;            // top-bucket only — [0.70, 0.85) had 73.1% actual win rate in WF validation
const NOTIFY_COOLDOWN_SEC = 3.5 * 60 * 60;

interface SymbolPrediction {
  symbol: string;
  isCrypto: boolean;
  mlProb: number;
  dailyScore: number;
  // True iff the previous cron's mlProb was below ML_THRESHOLD and current is at/above.
  // The notification gate fires only on this rising edge, not on continued elevation —
  // a symbol that sits at 0.75 for hours pages once when it crossed up, not every cron.
  crossed: boolean;
  // Daily Stochastic RSI crossover direction (+1 = bullish cross, -1 = bearish cross,
  // 0 = no recent cross). Combined with biasAlignment as the notification direction
  // primitive via the union rule (bias OR Stoch, skip conflicts).
  dStochCross: number;
  // Bias alignment from per-timeframe scoring: 'aligned_bullish', 'aligned_bearish',
  // 'conflict', or 'neutral'. Used together with dStochCross to determine the notification
  // direction. Backtest (direction_primitive_sweep.py, 2022-2026): the union (bias OR
  // Stoch with conflict-skip) captured 12× more total R than bias-alone on stocks
  // and 1.9× on crypto top-10, while keeping per-trade EV nearly identical.
  biasAlignment: string;
  // Last 4H bar high/low/close — used by pending-setup entry-zone touch detection so
  // we don't re-fetch the price for each device's setup checks. The 4H high/low covers
  // any intra-bar touch of the entry level; close is for staleness gating.
  last4HHigh: number;
  last4HLow: number;
  last4HClose: number;
  // ATR in price units (atrPercent × close / 100), used to define the entry-zone width
  // (default 0.3 × ATR around the entry price).
  atrPrice: number;
  // Calibrated P(up 24h) from the crypto direction head (null for stocks — no model).
  // Carried here so the dual-gate live-validation logger (logDirectionSignals) can read
  // it alongside mlProb + crossed without re-reading the KV blob.
  pUp: number | null;
}

/// Combine daily + 4H bias labels into the alignment string. Mirrors
/// alignFromBiases in scripts/scoring-bias.ts (kept inline so the worker src
/// doesn't depend on the scripts dir).
function biasAlignmentFromLabels(dailyBias: string, fourHBias: string): string {
  const dB = dailyBias.includes('Bullish');
  const dBr = dailyBias.includes('Bearish');
  const hB = fourHBias.includes('Bullish');
  const hBr = fourHBias.includes('Bearish');
  if (dBr && hBr) return 'aligned_bearish';
  if (dB && hB) return 'aligned_bullish';
  if ((dBr && hB) || (dB && hBr)) return 'conflict';
  return 'neutral';
}

/// Notification direction primitive: union of bias-aligned OR dStochCross.
/// Returns +1 for LONG, -1 for SHORT, 0 to skip the notification.
/// Skips on conflicts (bias and Stoch disagree). See direction_primitive_sweep.py
/// for the comparison that motivated this rule.
function notificationDirection(biasAlignment: string, dStochCross: number): number {
  const biasDir = biasAlignment === 'aligned_bullish' ? 1 :
                  biasAlignment === 'aligned_bearish' ? -1 : 0;
  const stochDir = dStochCross === 1 ? 1 : (dStochCross === -1 ? -1 : 0);
  if (biasDir !== 0 && stochDir !== 0 && biasDir !== stochDir) return 0; // conflict
  return biasDir !== 0 ? biasDir : stochDir;
}

// Orchestrates the per-cron score pass.
// Pre-refactor (commit 7148670 and earlier) this function called `checkDeviceScores` once
// per device, and each device's call independently fetched candles + derivatives + sector
// ETFs + ran ML for every symbol in (watchlist ∪ ARCHIVE_CRYPTO). Across 13 devices that
// meant ~13× redundant compute per symbol per cron, pushing single-cron runtime to 2-3
// minutes — well past the 60s cron interval. Subsequent cron events fired before previous
// runs finished and the resulting concurrency raced past the cooldown KV (eventually
// consistent), producing duplicate APNs.
//
// Post-refactor: ML compute happens once per symbol (the union across all devices), then
// each device just reads its watchlist's predictions from an in-memory map and applies
// per-device gating (notify window + cooldown + score_history write + APN). One full pass
// finishes in seconds instead of minutes; concurrency is gone, so notifications dedupe
// naturally without needing atomic D1 cooldowns.
async function checkAllDeviceScores(env: Env) {
  const watchlistRows = await env.DB.prepare('SELECT device_id, symbol FROM watchlist').all();
  if (!watchlistRows.results.length) return;

  const watchlistsByDevice = new Map<string, string[]>();
  for (const row of watchlistRows.results) {
    const deviceId = row.device_id as string;
    const symbol = row.symbol as string;
    let list = watchlistsByDevice.get(deviceId);
    if (!list) { list = []; watchlistsByDevice.set(deviceId, list); }
    list.push(symbol);
  }

  const watchlistSymbols = new Set<string>();
  for (const list of watchlistsByDevice.values()) for (const s of list) watchlistSymbols.add(s);
  const allSymbols = [...new Set([...watchlistSymbols, ...ARCHIVE_CRYPTO])];

  const predictions = await computeSymbolPredictions(env, allSymbols);

  // Live validation of the dual-gate direction claim ("~94% directional accuracy
  // when ML Win >= 70% AND the direction model is >= 70% confident"). Independent of
  // the LLM/setup path — this logs the raw model signal at fire time and grades it
  // 24h later against the realized forward price, accumulating a forward, out-of-sample
  // track record across the whole crypto universe. Both calls are fault-isolated so a
  // schema hiccup never blocks notifications.
  try {
    await resolveDirectionSignals(env, predictions);
    await logDirectionSignals(env, predictions);
  } catch (e) {
    console.log(`[dirsignal] error: ${e}`);
  }

  for (const [deviceId, watchlist] of watchlistsByDevice) {
    try {
      await processDeviceNotifications(env, deviceId, watchlist, predictions);
    } catch (e) {
      console.log(`[score] device ${deviceId} error: ${e}`);
    }
  }

  // Dead-man's-switch heartbeat — stamped only after a full pass completes.
  await stampHeartbeat(env);
}

// ─── Dual-gate direction live-validation ──────────────────────────────────────
// The crypto direction head claims ~94% directional accuracy at high confidence on
// the frozen backtest holdout. These two passes turn that into a *live*, forward
// track record so we can see whether it holds out-of-sample (and net of nothing —
// this measures the raw 24h direction sign, the same quantity the backtest measured).

const DIR_SIGNAL_HORIZON_MS = 24 * 3600 * 1000;  // grade 24h after firing
const DIR_PUP_GATE = 0.70;                        // |conviction| threshold (>=.70 long / <=.30 short)
const DIR_MODEL_VERSION = 'crypto-dir-1';

let dirTableReady = false;
async function ensureDirectionSignalsTable(env: Env) {
  if (dirTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS direction_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    ml_win REAL NOT NULL,
    p_up REAL NOT NULL,
    predicted_dir INTEGER NOT NULL,
    model_version TEXT NOT NULL,
    is_crypto INTEGER NOT NULL,
    resolve_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    exit_price REAL,
    fwd_return REAL,
    actual_dir INTEGER,
    correct INTEGER
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_dirsig_unresolved ON direction_signals(resolved, resolve_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_dirsig_symbol ON direction_signals(symbol, fired_at DESC)`).run();
  dirTableReady = true;
}

// Log a new signal whenever the dual gate fires on a rising ML edge. Deduped: at most
// one *open* (unresolved) signal per symbol at a time, so a symbol whose ML chatters
// across 0.70 doesn't spam overlapping rows for the same move.
async function logDirectionSignals(env: Env, predictions: Map<string, SymbolPrediction>) {
  await ensureDirectionSignalsTable(env);
  const now = Date.now();

  const fired: SymbolPrediction[] = [];
  for (const pred of predictions.values()) {
    if (!pred.crossed) continue;                       // rising edge through ML 0.70
    if (pred.pUp == null) continue;                    // crypto-only (direction model)
    if (pred.last4HClose <= 0) continue;
    const confident = pred.pUp >= DIR_PUP_GATE || pred.pUp <= 1 - DIR_PUP_GATE;
    if (!confident) continue;                          // direction model must commit
    fired.push(pred);
  }
  if (!fired.length) return;

  // Skip symbols that already have an open signal (dedupe overlapping crosses).
  const openRows = await env.DB.prepare(
    'SELECT DISTINCT symbol FROM direction_signals WHERE resolved = 0'
  ).all();
  const open = new Set((openRows.results || []).map(r => r.symbol as string));

  const inserts = [];
  for (const p of fired) {
    if (open.has(p.symbol)) continue;
    const dir = p.pUp! >= DIR_PUP_GATE ? 1 : -1;
    inserts.push(env.DB.prepare(
      `INSERT INTO direction_signals
        (symbol, fired_at, entry_price, ml_win, p_up, predicted_dir, model_version, is_crypto, resolve_at, resolved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(p.symbol, now, p.last4HClose, p.mlProb, p.pUp, dir, DIR_MODEL_VERSION,
           p.isCrypto ? 1 : 0, now + DIR_SIGNAL_HORIZON_MS));
  }
  if (inserts.length) {
    await env.DB.batch(inserts);
    console.log(`[dirsignal] logged ${inserts.length} new dual-gate signal(s)`);
  }
}

// ─── ML quality-model live calibration ────────────────────────────────────────
// The direction scoreboard validates the direction head live. This does the same for the
// QUALITY model (ML Win): log a sample of predictions and grade them against realized goodR
// (max favorable excursion >= 1.5 ATR in 24h, direction-agnostic — the model's actual
// target). Tells us whether predicted-70% bars really hit ~70% in the wild, or whether the
// model has drifted. One sample per symbol per ~20h keeps D1 writes bounded.

const CAL_LOG_INTERVAL_MS = 20 * 3600 * 1000;
const CAL_HORIZON_MS = 24 * 3600 * 1000;
const CAL_GOODR_ATR = 1.5;

let calTableReady = false;
async function ensureCalibrationTable(env: Env) {
  if (calTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ml_calibration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, is_crypto INTEGER NOT NULL,
    logged_at INTEGER NOT NULL, entry_price REAL NOT NULL, atr_price REAL NOT NULL,
    predicted_prob REAL NOT NULL, resolve_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0, fav_r REAL, good_r INTEGER
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cal_unresolved ON ml_calibration(resolved, resolve_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cal_symbol ON ml_calibration(symbol)`).run();
  calTableReady = true;
}

// Dead-man's-switch: the cron stamps a heartbeat each successful pass; /cron-health returns
// 503 when it goes stale so an external uptime monitor (UptimeRobot etc.) can alert. A dead
// cron can't push, so detection is external-on-read by design.
async function stampHeartbeat(env: Env) {
  try { await env.ALERTS.put('cron:heartbeat', String(Date.now())); } catch {}
}

// Grade every signal whose 24h horizon has elapsed against the current price.
// fwd_return = exit/entry - 1; correct = predicted_dir matches the realized sign.
// Uses the live price from this cron's predictions (the symbol is in ARCHIVE_CRYPTO so
// it's always recomputed); rows whose symbol is absent this cron are simply graded on
// the next cron that has it.
async function resolveDirectionSignals(env: Env, predictions: Map<string, SymbolPrediction>) {
  await ensureDirectionSignalsTable(env);
  const now = Date.now();
  const due = await env.DB.prepare(
    'SELECT id, symbol, entry_price, predicted_dir FROM direction_signals WHERE resolved = 0 AND resolve_at <= ? LIMIT 200'
  ).bind(now).all();
  if (!due.results || !due.results.length) return;

  const updates = [];
  for (const row of due.results) {
    const symbol = row.symbol as string;
    const pred = predictions.get(symbol);
    if (!pred || pred.last4HClose <= 0) continue;       // no price this cron — grade later
    const entry = row.entry_price as number;
    const exit = pred.last4HClose;
    const fwd = exit / entry - 1;
    const actualDir = fwd > 0 ? 1 : (fwd < 0 ? -1 : 0);
    const correct = actualDir === (row.predicted_dir as number) ? 1 : 0;
    updates.push(env.DB.prepare(
      'UPDATE direction_signals SET resolved = 1, exit_price = ?, fwd_return = ?, actual_dir = ?, correct = ? WHERE id = ?'
    ).bind(exit, fwd, actualDir, correct, row.id as number));
  }
  if (updates.length) {
    await env.DB.batch(updates);
    console.log(`[dirsignal] resolved ${updates.length} signal(s)`);
  }
}

// Symbol pass: fetches global market data once, then for each symbol computes features +
// `mlPredict`, accumulates predictions, and returns a Map consumed by the device pass.
// Side-effects beyond the return value:
//  - `ml_preds:all` KV write (5-min TTL, one batched blob covering all symbols) — fed
//    to iOS via /ml-predict?symbol=X which extracts the requested symbol's record.
//    Previously a per-symbol `ml_pred:<symbol>` write; batching cut KV writes ~75×.
//  - `ml_snapshots` KV write (24h TTL) — feeds next cron's rate-of-change deltas
//  - `prev_oi:<symbol>` KV write (24h TTL) — for OI delta on next cron
//  - `derivatives_history` D1 archive every ~4H per symbol
//  - `candles:<symbol>:<interval>` KV cache + D1 candle archive
//  - `debug:<symbol>_features` KV write (1h TTL) for parity verification
async function computeSymbolPredictions(
  env: Env,
  allSymbols: string[],
): Promise<Map<string, SymbolPrediction>> {
  const predictions = new Map<string, SymbolPrediction>();
  // Accumulates per-symbol ML predictions for a single batched KV write after the loop —
  // replaces what used to be 76 individual `ml_pred:<symbol>` writes per cron run.
  const mlPredBatch: Record<string, { symbol: string; probability: number; features: FullFeatures; timestamp: number; isCrypto: boolean;
    // Phase 1/2 additive heads (crypto-only; null/absent otherwise). Served by /ml-predict.
    probabilityMeta?: number | null; q75?: number | null; confident?: boolean | null; metaDirection?: number;
    pUp?: number | null }> = {};
  // Per-cron batched lookups: previous-bar open interest, last-derivatives-archive
  // timestamps (4H gate), and the candle cache for 1d/4h/1h. Each replaces 76 individual
  // KV reads + writes per cron with a single read + write of one blob. Candle cache is
  // the biggest line — was 228 reads/cron (76 × 3 intervals); now 3.
  const prevOIBatchRaw = await env.ALERTS.get('prev_oi:all');
  const prevOIMap: Record<string, number> = prevOIBatchRaw ? JSON.parse(prevOIBatchRaw) : {};
  const derivArchiveBatchRaw = await env.ALERTS.get('deriv_archive:all');
  const derivArchiveMap: Record<string, number> = derivArchiveBatchRaw ? JSON.parse(derivArchiveBatchRaw) : {};
  const candles1dRaw = await env.ALERTS.get('candles:all:1d');
  const candles4hRaw = await env.ALERTS.get('candles:all:4h');
  const candles1hRaw = await env.ALERTS.get('candles:all:1h');
  const candles1dMap: Record<string, ScoreCandle[]> = candles1dRaw ? JSON.parse(candles1dRaw) : {};
  const candles4hMap: Record<string, FullCandle[]> = candles4hRaw ? JSON.parse(candles4hRaw) : {};
  const candles1hMap: Record<string, FullCandle[]> = candles1hRaw ? JSON.parse(candles1hRaw) : {};
  const candlesDirty = { '1d': false, '4h': false, '1h': false };
  const hasStocks = allSymbols.some(s => !s.endsWith('USDT'));

  // Fetch Fear & Greed index (global, once per cron run)
  let fearGreedIndex = 50, fearGreedZone = 0;
  try {
    const fgResp = await fetch('https://api.alternative.me/fng/?limit=1&format=json');
    if (fgResp.ok) {
      const fgData = await fgResp.json() as any;
      const val = parseInt(fgData?.data?.[0]?.value ?? '50');
      fearGreedIndex = val;
      fearGreedZone = val <= 20 ? -2 : val <= 40 ? -1 : val <= 60 ? 0 : val <= 80 ? 1 : 2;
    }
  } catch {}

  // Fetch ETH/BTC ratio (global, once per cron run)
  // iOS training used delta of last two 4H closes (1-bar delta despite the "6" suffix).
  // Matching that so the model sees the same feature distribution it was trained on.
  let ethBtcRatio = 0, ethBtcDelta6 = 0;
  try {
    const ebResp = await fetch(`${BINANCE_SPOT}/klines?symbol=ETHBTC&interval=4h&limit=2`);
    if (ebResp.ok) {
      const ebData = await ebResp.json() as any[];
      if (ebData.length >= 2) {
        ethBtcRatio = +ebData[ebData.length - 1][4];
        const prev = +ebData[ebData.length - 2][4];
        ethBtcDelta6 = prev > 0 ? (ethBtcRatio - prev) / prev * 100 : 0;
      } else if (ebData.length > 0) {
        ethBtcRatio = +ebData[ebData.length - 1][4];
      }
    }
  } catch {}

  // Fetch VIX + DXY (once per cron run, cached)
  let vixValue = 20, dxyAboveEma20 = 0;
  // Try cached VIX first (in case fetch fails)
  const cachedVix = await env.ALERTS.get('cache:vix_value');
  if (cachedVix) vixValue = parseFloat(cachedVix);
  try {
    const vixResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/%5EVIX?interval=1d&range=5d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (vixResp.ok) {
      const vixData = await vixResp.json() as any;
      const result = vixData?.chart?.result?.[0];
      const ts: number[] = result?.timestamp || [];
      const closes: (number|null)[] = result?.indicators?.quote?.[0]?.close || [];
      // Build paired (time, close) pairs, then drop in-progress so we use the latest CLOSED
      // daily VIX (yesterday's close during market hours, today's close after market close).
      // This matches BacktestEngine's training canonical: closing VIX as of the date.
      const pairs = ts.map((t, i) => ({ time: t * 1000, close: closes[i] }))
                      .filter(p => p.close != null) as { time: number; close: number }[];
      const closedPairs = dropInProgress(pairs, '1d');
      if (closedPairs.length) {
        vixValue = closedPairs[closedPairs.length - 1].close;
        await env.ALERTS.put('cache:vix_value', String(vixValue), { expirationTtl: 3600 });
      }
    }
  } catch {}
  try {
    const dxyResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/DX-Y.NYB?interval=1d&range=30d`);
    if (dxyResp.ok) {
      const dxyData = await dxyResp.json() as any;
      const closes = dxyData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((v: any) => v != null) || [];
      if (closes.length >= 20) {
        const ema20k = 2 / 21;
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) ema = closes[i] * ema20k + ema * (1 - ema20k);
        dxyAboveEma20 = closes[closes.length - 1] > ema ? 1 : 0;
      }
    }
  } catch {}

  // Fetch SPY candles once for stock relative strength + beta
  let spyCandles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  if (hasStocks) {
    try {
      const spyResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/SPY?interval=1d&range=6mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (spyResp.ok) {
        const spyData = await spyResp.json() as any;
        const result = spyData?.chart?.result?.[0];
        const ts = result?.timestamp || [];
        const q = result?.indicators?.quote?.[0] || {};
        for (let i = 0; i < ts.length; i++) {
          if (q.open?.[i] != null && q.close?.[i] != null) {
            spyCandles.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
          }
        }
        // Drop in-progress to match TSLA's daily candles (also dropped in fetchScoreCandles).
        // Without this, beta and relStrength computations correlate misaligned dates.
        spyCandles = dropInProgress(spyCandles, '1d');
      }
    } catch {}
  }

  // Fetch IWM candles for breadth ratio
  let iwmCandles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  if (hasStocks) {
    try {
      const iwmResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/IWM?interval=1d&range=1mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (iwmResp.ok) {
        const iwmData = await iwmResp.json() as any;
        const result = iwmData?.chart?.result?.[0];
        const ts = result?.timestamp || [];
        const q = result?.indicators?.quote?.[0] || {};
        for (let i = 0; i < ts.length; i++) {
          if (q.open?.[i] != null && q.close?.[i] != null) {
            iwmCandles.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
          }
        }
        iwmCandles = dropInProgress(iwmCandles, '1d');
      }
    } catch {}
  }

  // Fetch VIX3M for term structure ratio
  let vix3mPrice = 0;
  try {
    const vix3mResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/%5EVIX3M?interval=1d&range=5d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (vix3mResp.ok) {
      const vix3mData = await vix3mResp.json() as any;
      const closes = vix3mData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if (closes?.length) vix3mPrice = closes[closes.length - 1] ?? 0;
    }
  } catch {}

  // Fetch DXY candles for momentum (full 1mo for 5-day lookback)
  let dxyCandles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  try {
    const dxyResp2 = await fetch(`${YAHOO_BASE}/v8/finance/chart/DX-Y.NYB?interval=1d&range=1mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (dxyResp2.ok) {
      const dxyData2 = await dxyResp2.json() as any;
      const result = dxyData2?.chart?.result?.[0];
      const ts = result?.timestamp || [];
      const q = result?.indicators?.quote?.[0] || {};
      for (let i = 0; i < ts.length; i++) {
        if (q.open?.[i] != null && q.close?.[i] != null) {
          dxyCandles.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
        }
      }
      dxyCandles = dropInProgress(dxyCandles, '1d');
    }
  } catch {}

  // Fetch sector ETF candles for relative strength. Stocks subset of allSymbols.
  const sectorETFCandlesMap: Record<string, { time: number; open: number; high: number; low: number; close: number; volume: number }[]> = {};
  if (hasStocks) {
    const neededETFs = new Set<string>();
    for (const s of allSymbols) {
      if (!s.endsWith('USDT')) {
        const etf = sectorETFForSymbol(s);
        if (etf) neededETFs.add(etf);
      }
    }
    for (const etf of neededETFs) {
      try {
        const etfResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${etf}?interval=1d&range=1mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (etfResp.ok) {
          const etfData = await etfResp.json() as any;
          const result = etfData?.chart?.result?.[0];
          const ts = result?.timestamp || [];
          const q = result?.indicators?.quote?.[0] || {};
          const candles: typeof iwmCandles = [];
          for (let i = 0; i < ts.length; i++) {
            if (q.open?.[i] != null && q.close?.[i] != null) {
              candles.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
            }
          }
          sectorETFCandlesMap[etf] = dropInProgress(candles, '1d');
        }
      } catch {}
    }
  }

  // Fetch FINRA dark pool data (once per day, cached in KV)
  let darkPoolData: Record<string, { ratio: number; zscore: number }> = {};
  if (hasStocks) {
    const dpCacheKey = 'darkpool:latest';
    const dpCached = await env.ALERTS.get(dpCacheKey);
    if (dpCached) {
      darkPoolData = JSON.parse(dpCached);
    } else {
      try {
        // FINRA publishes after market close; try today, fall back to yesterday
        const now = new Date();
        const tryDates = [0, 1, 2, 3].map(d => {
          const dt = new Date(now.getTime() - d * 86400000);
          return dt.toISOString().slice(0, 10).replace(/-/g, '');
        });
        let lines: string[] = [];
        for (const dateStr of tryDates) {
          try {
            const resp = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${dateStr}.txt`);
            if (resp.ok) {
              lines = (await resp.text()).split('\n');
              break;
            }
          } catch {}
        }
        if (lines.length > 0) {
          // Parse and compute ratios for our symbols
          for (const line of lines) {
            const parts = line.split('|');
            if (parts.length < 5) continue;
            const sym = parts[1];
            const shortVol = parseFloat(parts[2]);
            const totalVol = parseFloat(parts[4]);
            if (totalVol > 0 && !isNaN(shortVol)) {
              darkPoolData[sym] = { ratio: shortVol / totalVol, zscore: 0 };
            }
          }
          // Load historical ratios from KV for Z-score computation
          const histKey = 'darkpool:history';
          const histRaw = await env.ALERTS.get(histKey);
          const hist: Record<string, number[]> = histRaw ? JSON.parse(histRaw) : {};
          for (const [sym, dp] of Object.entries(darkPoolData)) {
            if (!hist[sym]) hist[sym] = [];
            hist[sym].push(dp.ratio);
            if (hist[sym].length > 20) hist[sym] = hist[sym].slice(-20);
            const arr = hist[sym];
            if (arr.length >= 5) {
              const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
              const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
              dp.zscore = std > 0.001 ? (dp.ratio - mean) / std : 0;
            }
          }
          await env.ALERTS.put(histKey, JSON.stringify(hist), { expirationTtl: 86400 * 30 });
          await env.ALERTS.put(dpCacheKey, JSON.stringify(darkPoolData), { expirationTtl: 14400 });
        }
      } catch {}
    }
  }

  // Load previous ML snapshots for rate-of-change deltas + acceleration. `mlProb` was
  // added 2026-05-05 for rising-edge notification gating; older blobs lack it (treated as
  // undefined, so first cron after deploy fires normally for any symbol already above
  // threshold — a one-time noise event, not a regression).
  const prevSnapshotsRaw = await env.ALERTS.get('ml_snapshots');
  const prevSnapshots: Record<string, { dRsi: number; dAdx: number; hRsi: number; hAdx: number; hMacdHist: number;
    hRsiD1?: number; hMacdD1?: number; dRsiD1?: number; dAdxD1?: number; fundingHist?: number[];
    mlProb?: number }> =
    prevSnapshotsRaw ? JSON.parse(prevSnapshotsRaw) : {};
  const newSnapshots: typeof prevSnapshots = {};

  // Calibration: load the per-symbol last-log gate + any rows due for grading. Logging and
  // resolution happen inside the loop (resolution needs the 4H candle history for the max
  // excursion). Inserts/updates are batched after the loop.
  await ensureCalibrationTable(env);
  const nowCal = Date.now();
  const calLogged: Record<string, number> = JSON.parse((await env.ALERTS.get('cal_logged:all')) || '{}');
  const calDueBySymbol = new Map<string, Array<{ id: number; logged_at: number; entry_price: number; atr_price: number }>>();
  try {
    const due = await env.DB.prepare(
      'SELECT id, symbol, logged_at, entry_price, atr_price FROM ml_calibration WHERE resolved = 0 AND resolve_at <= ? LIMIT 300'
    ).bind(nowCal).all();
    for (const r of due.results || []) {
      const s = r.symbol as string;
      if (!calDueBySymbol.has(s)) calDueBySymbol.set(s, []);
      calDueBySymbol.get(s)!.push({ id: r.id as number, logged_at: r.logged_at as number,
        entry_price: r.entry_price as number, atr_price: r.atr_price as number });
    }
  } catch (e) { console.log(`[cal] due-load err ${e}`); }
  const calInserts: D1PreparedStatement[] = [];
  const calUpdates: D1PreparedStatement[] = [];

  for (const symbol of allSymbols) {
    try {
      const isCrypto = symbol.endsWith('USDT');

      // Candle cache: lookup in per-interval batched maps; fetch + insert on miss.
      let candles: ScoreCandle[] = candles1dMap[symbol] ?? [];
      if (!candles.length) {
        candles = await fetchScoreCandles(symbol, isCrypto);
        if (candles.length > 0) {
          candles1dMap[symbol] = candles;
          candlesDirty['1d'] = true;
          archiveCandlesToD1(env, symbol, '1d', candles).catch(() => {});
        }
      }
      if (candles.length < 210) continue;

      // Fetch 4H + 1H candles for full ML features
      let fourHCandles: FullCandle[] = candles4hMap[symbol] ?? [];
      let oneHCandles: FullCandle[] = candles1hMap[symbol] ?? [];
      if (isCrypto) {
        if (!fourHCandles.length) {
          try {
            const resp = await fetch(`${BINANCE_SPOT}/klines?symbol=${symbol}&interval=4h&limit=260`);
            if (resp.ok) {
              const data = await resp.json() as any[];
              const parsed = data.map((k: any) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
              fourHCandles = dropInProgress(parsed, '4h');
              candles4hMap[symbol] = fourHCandles;
              candlesDirty['4h'] = true;
              archiveCandlesToD1(env, symbol, '4h', fourHCandles).catch(() => {});
            }
          } catch {}
        }
        if (!oneHCandles.length) {
          try {
            const resp = await fetch(`${BINANCE_SPOT}/klines?symbol=${symbol}&interval=1h&limit=100`);
            if (resp.ok) {
              const data = await resp.json() as any[];
              const parsed = data.map((k: any) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
              oneHCandles = dropInProgress(parsed, '1h');
              candles1hMap[symbol] = oneHCandles;
              candlesDirty['1h'] = true;
              archiveCandlesToD1(env, symbol, '1h', oneHCandles).catch(() => {});
            }
          } catch {}
        }
      } else {
        // Stock: fetch 1H from Yahoo, aggregate to 4H
        if (!oneHCandles.length) {
          try {
            const resp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1h&range=6mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (resp.ok) {
              const data = await resp.json() as any;
              const r = data?.chart?.result?.[0];
              if (r?.timestamp) {
                const ts = r.timestamp;
                const q = r.indicators.quote[0];
                const parsed: FullCandle[] = [];
                for (let i = 0; i < ts.length; i++) {
                  if (q.open?.[i] != null && q.close?.[i] != null) {
                    parsed.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
                  }
                }
                oneHCandles = dropInProgress(parsed, '1h');
                candles1hMap[symbol] = oneHCandles;
                candlesDirty['1h'] = true;
              }
            }
          } catch {}
        }
        // Aggregate 1H → 4H via shared helper (mirrors iOS CandleAggregator.aggregate1HTo4H).
        // Cache the aggregated stock 4H so the next cron skips the recompute on hit.
        if (!fourHCandles.length && oneHCandles.length > 0) {
          fourHCandles = dropInProgress(aggregate1HTo4H_ET(oneHCandles), '4h');
          if (fourHCandles.length) {
            candles4hMap[symbol] = fourHCandles;
            candlesDirty['4h'] = true;
          }
        }
        if (fourHCandles.length > 0) {
          archiveCandlesToD1(env, symbol, '4h', fourHCandles).catch(() => {});
        }
        if (oneHCandles.length > 0) {
          archiveCandlesToD1(env, symbol, '1h', oneHCandles).catch(() => {});
        }
      }

      // Fetch live derivatives for crypto (funding + top trader + taker + OI + basis)
      let derivSignals: any = { fundingSignal: 0, oiSignal: 0, takerSignal: 0, crowdingSignal: 0, derivativesCombined: 0 };
      let basisPct = 0, largeBuyVol = 0, largeSellVol = 0;
      if (isCrypto) {
        const prevOI = prevOIMap[symbol] ?? 0;
        const FAPI = 'https://fapi.binance.com';
        let fundingRate = 0, topTraderLongPct = 0, takerBuyVol = 0, takerSellVol = 0;
        let openInterest = 0, markPrice = 0, indexPrice = 0, longPct = 0, takerRatio = 0;

        try {
          const r = await fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
          if (r.ok) { const d = await r.json() as any[]; if (d.length) fundingRate = parseFloat(d[0].fundingRate) * 100; }
        } catch {}

        try {
          const r = await fetch(`${FAPI}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=4h&limit=1`);
          if (r.ok) { const d = await r.json() as any[]; if (d.length) topTraderLongPct = parseFloat(d[0].longAccount) * 100; }
        } catch {}

        try {
          const r = await fetch(`${FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=4h&limit=1`);
          if (r.ok) {
            const d = await r.json() as any[];
            if (d.length) { takerBuyVol = parseFloat(d[0].buyVol); takerSellVol = parseFloat(d[0].sellVol); takerRatio = parseFloat(d[0].buySellRatio); }
          }
        } catch {}

        try {
          const r = await fetch(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=1`);
          if (r.ok) { const d = await r.json() as any[]; if (d.length) openInterest = parseFloat(d[0].sumOpenInterest); }
        } catch {}

        let oiChangePct = 0;
        if (prevOI > 0 && openInterest > 0) {
          oiChangePct = (openInterest - prevOI) / prevOI * 100;
        }
        if (openInterest > 0) {
          prevOIMap[symbol] = openInterest;
        }

        try {
          const r = await fetch(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=4h&limit=1`);
          if (r.ok) { const d = await r.json() as any[]; if (d.length) longPct = parseFloat(d[0].longAccount) * 100; }
        } catch {}

        try {
          const r = await fetch(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`);
          if (r.ok) {
            const d = await r.json() as any;
            markPrice = parseFloat(d.markPrice); indexPrice = parseFloat(d.indexPrice);
            if (indexPrice > 0) basisPct = (markPrice - indexPrice) / indexPrice * 100;
          }
        } catch {}

        let largeBuyCount = 0, largeSellCount = 0;
        try {
          const atResp = await fetch(`https://api.binance.com/api/v3/aggTrades?symbol=${symbol}&limit=1000`);
          if (atResp.ok) {
            const trades = await atResp.json() as any[];
            const lastPrice = trades.length > 0 ? parseFloat(trades[trades.length - 1].p) : 1;
            const threshold = lastPrice * 0.5;
            for (const t of trades) {
              const qty = parseFloat(t.q);
              const price = parseFloat(t.p);
              const notional = qty * price;
              if (notional < threshold) continue;
              if (t.m) {
                largeSellVol += notional;
                largeSellCount++;
              } else {
                largeBuyVol += notional;
                largeBuyCount++;
              }
            }
          }
        } catch {}

        derivSignals.fundingRateRaw = fundingRate;
        derivSignals.oiChangePct = oiChangePct;
        derivSignals.longPctRaw = longPct || 50;
        derivSignals.takerRatioRaw = takerRatio || 1.0;
        if (fundingRate > 0.03) derivSignals.fundingSignal = -1;
        else if (fundingRate < -0.03) derivSignals.fundingSignal = 1;
        if (takerRatio > 1.1) derivSignals.takerSignal = 1;
        else if (takerRatio < 0.9) derivSignals.takerSignal = -1;
        if (longPct > 60) derivSignals.crowdingSignal = -1;
        else if (longPct < 40) derivSignals.crowdingSignal = 1;
        const priceRising = candles.length >= 2 && candles[candles.length - 1].close > candles[candles.length - 2].close;
        const oiUp = oiChangePct > 1.0;
        const oiDown = oiChangePct < -1.0;
        if (oiUp && priceRising) derivSignals.oiSignal = 1;
        else if (oiUp && !priceRising) derivSignals.oiSignal = -1;
        else if (oiDown && priceRising) derivSignals.oiSignal = -1;
        else if (oiDown && !priceRising) derivSignals.oiSignal = 1;
        derivSignals.derivativesCombined = Math.max(-3, Math.min(3,
          derivSignals.fundingSignal + derivSignals.oiSignal + derivSignals.takerSignal + derivSignals.crowdingSignal));

        // Archive to D1 (every 4H). Per-symbol gate moved into the in-memory map; the
        // batched blob is flushed at the end of computeSymbolPredictions only if any
        // symbol actually archived this cron.
        const lastArchive = derivArchiveMap[symbol];
        if (!lastArchive || Date.now() - lastArchive > 3.5 * 3600 * 1000) {
          const ts = Math.floor(Date.now() / 1000);
          try {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO derivatives_history (symbol, timestamp, funding_rate, open_interest, long_percent, taker_ratio, top_trader_long_pct, taker_buy_vol, taker_sell_vol, mark_price, index_price, basis_pct, large_buy_vol, large_sell_vol, large_buy_count, large_sell_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(symbol, ts, fundingRate, openInterest, longPct, takerRatio, topTraderLongPct, takerBuyVol, takerSellVol, markPrice, indexPrice, basisPct, largeBuyVol, largeSellVol, largeBuyCount, largeSellCount).run();
            derivArchiveMap[symbol] = Date.now();
          } catch {}
        }
      }
      const defaultMacro = { vix: vixValue, dxyAboveEma20 };

      const sentiment = isCrypto ? { fearGreedIndex, fearGreedZone, ethBtcRatio, ethBtcDelta6, basisPct } : undefined;
      const sectorETF = isCrypto ? null : sectorETFForSymbol(symbol);
      const sectorCandles = sectorETF ? (sectorETFCandlesMap[sectorETF] || []) as FullCandle[] : [];
      const features = computeAllFeatures(candles as FullCandle[], fourHCandles, oneHCandles, isCrypto, derivSignals, defaultMacro, sentiment, prevSnapshots[symbol], spyCandles, isCrypto ? undefined : darkPoolData[symbol], iwmCandles as FullCandle[], sectorCandles, dxyCandles as FullCandle[], vix3mPrice, symbol);

      // Save snapshot for next cron's rate-of-change deltas + acceleration
      const ps = prevSnapshots[symbol];
      const prevFundingHist = ps?.fundingHist || [];
      const newFundingHist = isCrypto ? [...prevFundingHist, derivSignals.fundingRateRaw || 0].slice(-4) : [];
      // v9 single-model: direction-agnostic goodR probability
      const mlProb = mlPredict(features as Record<string, number>, isCrypto);
      // 72h persistence: probability of >= 2.5 ATR favorable move within 72h.
      // Different question than mlProb — runner-hold confidence vs trade-quality gate.
      const mlProbH72 = mlPredictH72(features as Record<string, number>, isCrypto);

      newSnapshots[symbol] = {
        dRsi: features.dRsi, dAdx: features.dAdx,
        hRsi: features.hRsi, hAdx: features.hAdx, hMacdHist: features.hMacdHist,
        hRsiD1: ps ? features.hRsi - ps.hRsi : 0,
        hMacdD1: ps ? features.hMacdHist - ps.hMacdHist : 0,
        dRsiD1: ps ? features.dRsi - ps.dRsi : 0,
        dAdxD1: ps ? features.dAdx - ps.dAdx : 0,
        fundingHist: newFundingHist,
        mlProb,
      };

      // Capture prediction for the batched ml_preds:all blob written at the end of the
      // symbol pass. Per-symbol KV writes were the dominant Cloudflare cost — 76 crypto
      // symbols × every minute × 5-min TTL = ~3.3M writes/month, 60% of the bill. The
      // batched blob is ~110KB (well under the 25MB KV value limit) and writes once per
      // cron instead of 76 times.
      // probabilityH72 is the runner-hold persistence score; kept alongside the existing
      // `probability` field so old iOS clients can ignore it cleanly (additive change).
      mlPredBatch[symbol] = { symbol, probability: mlProb, probabilityH72: mlProbH72, features, timestamp: Date.now(), isCrypto };

      // Debug: dump features for comparison with iOS
      if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT' || symbol === 'TSLA' || symbol === 'NVDA') {
        await env.ALERTS.put(`debug:${symbol.toLowerCase()}_features`, JSON.stringify({ features, mlProbability: mlProb }), { expirationTtl: 3600 });
      }

      const prevMl = ps?.mlProb;
      const crossed = prevMl !== undefined && prevMl < ML_THRESHOLD && mlProb >= ML_THRESHOLD;

      // Last 4H bar for pending-setup entry-touch detection. Defensive fallback to 0
      // if candles disappeared — the device-pass code handles 0 by skipping the check.
      const last4H = fourHCandles[fourHCandles.length - 1];
      const last4HHigh = last4H?.high ?? 0;
      const last4HLow = last4H?.low ?? 0;
      const last4HClose = last4H?.close ?? 0;
      const atrPrice = (features.atrPercent / 100) * last4HClose;

      // Per-timeframe bias labels for the notification direction primitive. The
      // worker's simplified scorer (~80% accurate vs Swift ScoringFunction) is fine
      // for direction gating — the actual setup direction in the app comes from the
      // iOS ComputeAll which sees the user the same labels.
      const dailyScoreRes = computeScore(candles as ScoreCandle[], isCrypto);
      const fourHScoreRes = computeScore(fourHCandles as ScoreCandle[], isCrypto);
      const biasAlignment = biasAlignmentFromLabels(dailyScoreRes.bias, fourHScoreRes.bias);

      // Phase 1/2 heads (crypto-only): direction-conditioned triple-barrier meta prob,
      // adaptive-TP2 q75, and the conformal `confident` gate. Additive — served by
      // /ml-predict alongside the existing probability; current prompt/notify behaviour
      // is unchanged until the app reads them. metaDirection = the union(bias, dStoch)
      // the meta head was conditioned on (so the app knows which side it scored).
      const metaDirection = notificationDirection(biasAlignment, features.dStochCross || 0);
      const probabilityMeta = mlPredictMeta(features as Record<string, number>, isCrypto, metaDirection);
      const q75 = mlPredictQuantile(features as Record<string, number>, isCrypto, '0.75');
      const confident = mlConfident(probabilityMeta, isCrypto);
      // Calibrated P(up 24h) — the dedicated direction model. Beats the indicator
      // heuristics (holdout: ~80% acc full-coverage, ~95% at pUp>=0.70, conditional on
      // high ML); crypto only. Direction-agnostic input (no tradeDir).
      const pUp = mlPredictDirection(features as Record<string, number>, isCrypto);
      mlPredBatch[symbol].probabilityMeta = probabilityMeta;
      mlPredBatch[symbol].q75 = q75;
      mlPredBatch[symbol].confident = confident;
      mlPredBatch[symbol].metaDirection = metaDirection;
      mlPredBatch[symbol].pUp = pUp;

      predictions.set(symbol, {
        symbol,
        isCrypto,
        mlProb,
        dailyScore: features.dailyScore,
        crossed,
        dStochCross: features.dStochCross || 0,
        biasAlignment,
        last4HHigh,
        last4HLow,
        last4HClose,
        atrPrice,
        pUp,
      });

      // Calibration log: sample this symbol's ML Win at most once per ~20h.
      if (atrPrice > 0 && last4HClose > 0 && (nowCal - (calLogged[symbol] || 0) >= CAL_LOG_INTERVAL_MS)) {
        calInserts.push(env.DB.prepare(
          `INSERT INTO ml_calibration (symbol, is_crypto, logged_at, entry_price, atr_price, predicted_prob, resolve_at, resolved)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
        ).bind(symbol, isCrypto ? 1 : 0, nowCal, last4HClose, atrPrice, mlProb, nowCal + CAL_HORIZON_MS));
        calLogged[symbol] = nowCal;
      }
      // Calibration grade: any due rows for this symbol → max excursion over [logged, resolve]
      // from the 4H candle history (direction-agnostic, matches the goodR target).
      const due = calDueBySymbol.get(symbol);
      if (due && fourHCandles.length) {
        for (const row of due) {
          let maxHigh = -Infinity, minLow = Infinity;
          for (const c of fourHCandles) {
            const t = (c as { time?: number }).time ?? 0;
            if (t > row.logged_at && t <= row.logged_at + CAL_HORIZON_MS) {
              if (c.high > maxHigh) maxHigh = c.high;
              if (c.low < minLow) minLow = c.low;
            }
          }
          if (maxHigh === -Infinity || row.atr_price <= 0) continue;  // no bars yet — grade next cron
          const favR = Math.max(maxHigh - row.entry_price, row.entry_price - minLow) / row.atr_price;
          calUpdates.push(env.DB.prepare(
            'UPDATE ml_calibration SET resolved = 1, fav_r = ?, good_r = ? WHERE id = ?'
          ).bind(favR, favR >= CAL_GOODR_ATR ? 1 : 0, row.id));
        }
      }
    } catch (e) {
      console.log(`[score] ${symbol} error: ${e}`);
    }
  }

  // Flush calibration inserts/updates + the per-symbol log gate (batched, once per cron).
  try {
    if (calInserts.length) await env.DB.batch(calInserts);
    if (calUpdates.length) await env.DB.batch(calUpdates);
    if (calInserts.length) await env.ALERTS.put('cal_logged:all', JSON.stringify(calLogged), { expirationTtl: 86400 * 3 });
    if (calInserts.length || calUpdates.length) console.log(`[cal] +${calInserts.length} logged, ${calUpdates.length} graded`);
  } catch (e) { console.log(`[cal] flush err ${e}`); }

  // Save ML snapshots for next cron's rate-of-change deltas
  await env.ALERTS.put('ml_snapshots', JSON.stringify(newSnapshots), { expirationTtl: 86400 });

  // Batched KV blobs written once per cron in place of 4-5 × 76 per-symbol writes.
  // 5-min TTL on ml_preds:all and candles:all:<interval> preserves the "drop out of
  // cache when cron stops" behaviour the per-symbol blobs had; prev_oi:all and
  // deriv_archive:all use longer TTLs since they're internal state that should survive
  // cron-cycle gaps. Candle blobs only flush when at least one symbol was missing —
  // saves writes during the ~4 of 5 crons where everything hits cache.
  await env.ALERTS.put('ml_preds:all', JSON.stringify(mlPredBatch), { expirationTtl: 300 });
  await env.ALERTS.put('prev_oi:all', JSON.stringify(prevOIMap), { expirationTtl: 86400 });
  await env.ALERTS.put('deriv_archive:all', JSON.stringify(derivArchiveMap), { expirationTtl: 14400 });
  if (candlesDirty['1d']) await env.ALERTS.put('candles:all:1d', JSON.stringify(candles1dMap), { expirationTtl: 300 });
  if (candlesDirty['4h']) await env.ALERTS.put('candles:all:4h', JSON.stringify(candles4hMap), { expirationTtl: 300 });
  if (candlesDirty['1h']) await env.ALERTS.put('candles:all:1h', JSON.stringify(candles1hMap), { expirationTtl: 300 });

  return predictions;
}

// Device pass: reads device's watchlist from the precomputed predictions Map (no fresh
// candle/derivative fetches), writes per-(device, symbol) score_history, and applies
// per-device notification gating (notify-window + ML threshold + cooldown).
//
// Dedupe is an atomic D1 claim against `notif_claims` keyed by (push_token, symbol).
// Concurrent cron passes — which can overlap when a single pass exceeds the 60s cron
// interval — race through D1's primary region serializer; only one INSERT/UPDATE
// changes a row, the rest see `meta.changes === 0` and skip. Push_token (not device_id)
// is the key so rotated device_ids pointing at the same physical phone share a claim.
// (Pre-2026-05-05 the gate used `notif:<pushToken>:<symbol>` in KV which raced because
// KV is eventually consistent — two parallel readers both saw "no prior fire" and both
// fired, producing the duplicate APNs the user observed.)
async function processDeviceNotifications(
  env: Env,
  deviceId: string,
  watchlist: string[],
  predictions: Map<string, SymbolPrediction>,
) {
  const pushToken = await getPushToken(env, deviceId);
  const triggered: { symbol: string; score: number; mlProb: number; direction: string }[] = [];
  const now = Date.now();
  const expiresAt = now + NOTIFY_COOLDOWN_SEC * 1000;

  // Notify gate. Records score_history regardless (so the user's history endpoint sees
  // every cron), but only adds to triggered if all of: (a) the symbol just crossed up
  // through ML_THRESHOLD this cron, (b) the union direction primitive returns non-zero
  // (bias-aligned OR Stoch cross fired, conflicts skipped), and (c) the atomic D1 claim
  // succeeds. Continued elevation doesn't re-fire — paged once per crossing event.
  //
  // Direction primitive history:
  //   - Original: bias-aligned only. Backtest showed n=613 / +0.079R EV / +48R total
  //     on stocks across 4.4 years. Bias is a complex 6-layer score that's restrictive
  //     enough to miss most actionable setups on stocks (no derivatives/cross-asset
  //     layers like crypto has).
  //   - Brief detour (rolled back same day): bias AND Stoch — intersection dropped total
  //     R by 80% by requiring two redundant direction signals.
  //   - Current (2026-05-30): bias OR Stoch union, skip-on-conflict. Backtest captured
  //     12× more total R on stocks and 1.9× on crypto top-10, with per-trade EV nearly
  //     identical to bias-alone. See ml-training/direction_primitive_sweep.py for the
  //     full sweep vs 11 alternative primitives — union won both markets.
  for (const symbol of watchlist) {
    const pred = predictions.get(symbol);
    if (!pred) continue;
    // Real-time gate (2026-05-30): fire the instant a cross is detected, any hour,
    // protected only by the 3.5h per-(token,symbol) cooldown below. The previous fixed
    // notify-window gate (8/12/16/20/23:30 ET) silently DROPPED crosses that landed
    // off-window: mlProb only moves on a 4H close and `crossed` is true for a single
    // cron tick (prevMl = previous minute), so a close outside a window was missed
    // entirely, not deferred. With crypto closing 24/7 and most closes falling outside
    // the 4-5 hour-wide windows, the majority of signals were lost. The cooldown already
    // prevents spam; quiet-hours is delegated to the user's iOS Focus/DND.
    if (!pred.crossed || !pushToken) continue;
    const dir = notificationDirection(pred.biasAlignment, pred.dStochCross);
    if (dir === 0) continue;  // No direction signal (neither fires, or they conflict)
    // Atomic claim: insert if absent, otherwise overwrite only if the prior claim has
    // expired. `meta.changes === 1` means we won (either fresh insert or expired-claim
    // takeover); `0` means another concurrent caller already holds an unexpired claim.
    const claim = await env.DB.prepare(
      `INSERT INTO notif_claims (push_token, symbol, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(push_token, symbol) DO UPDATE SET expires_at = ?3
       WHERE notif_claims.expires_at < ?4`
    ).bind(pushToken, symbol, expiresAt, now).run();
    if ((claim.meta.changes ?? 0) === 0) continue;
    triggered.push({ symbol, score: pred.dailyScore, mlProb: pred.mlProb,
                     direction: dir === 1 ? 'LONG' : 'SHORT' });
  }

  // Score history per watchlisted symbol (one row per cron, even if not notified).
  // Batched: pre-batch this was N D1 round-trips per device × M devices per cron, easily
  // 1000+ writes/minute. four_h_score stays 0 — SymbolPrediction doesn't carry a 4H
  // score today; expose `features.fourH.score` through predictions if /scores starts
  // surfacing it.
  const historyStmts = watchlist
    .map(symbol => {
      const pred = predictions.get(symbol);
      if (!pred) return null;
      const wasNotified = triggered.some(t => t.symbol === symbol);
      return env.DB.prepare(
        'INSERT INTO score_history (device_id, symbol, daily_score, four_h_score, ml_probability, bias, notification_sent) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(deviceId, symbol, pred.dailyScore, 0, pred.mlProb, pred.mlProb > 0.5 ? 'Bullish' : 'Bearish', wasNotified ? 1 : 0);
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
  if (historyStmts.length > 0) {
    await env.DB.batch(historyStmts);
  }

  // === Entry-touched check for this device's pending setups ===
  // For each pending setup, check if the latest 4H bar's high/low touched the entry
  // zone (entry ± 0.3 ATR) AND ML still favorable AND not yet notified. Fire APNs once,
  // mark notified=1 so we don't spam. Also expire old setups.
  if (pushToken) {
    try {
      const setupRows = await env.DB.prepare(
        'SELECT id, symbol, direction, entry, atr, ml_at_registration, expires_at, notified FROM pending_setups WHERE device_id = ?'
      ).bind(deviceId).all();
      const setups = setupRows.results as unknown as Array<{
        id: string; symbol: string; direction: string; entry: number; atr: number;
        ml_at_registration: number | null; expires_at: number; notified: number;
      }>;
      const now = Date.now();
      for (const setup of setups) {
        // Cleanup expired
        if (setup.expires_at < now) {
          await env.DB.prepare('DELETE FROM pending_setups WHERE id = ?').bind(setup.id).run();
          continue;
        }
        if (setup.notified === 1) continue;
        const pred = predictions.get(setup.symbol);
        if (!pred || pred.atrPrice <= 0) continue;
        // ML must still be favorable. Use 0.55 as the entry-touched gate (slightly
        // below the 70% conviction gate so we don't suppress moderate setups during
        // an entry touch, but firm enough to skip stale signals where ML collapsed).
        if (pred.mlProb < 0.55) continue;
        // Entry zone: ±0.3 × ATR around the setup's entry price.
        const zoneWidth = setup.atr * 0.3;
        const zoneLow = setup.entry - zoneWidth;
        const zoneHigh = setup.entry + zoneWidth;
        // For LONG: bar's low ended INSIDE the zone (price reached the pullback without
        // plunging through). For SHORT: bar's high ended INSIDE the zone (price spiked
        // up to the entry without overshooting). Pre-fix the lower/upper bound used an
        // extra `±zoneWidth` "grace" term that doubled the effective window to 0.9 ATR,
        // firing on bars that had already gapped well past the documented ±0.3 ATR zone.
        const isLong = setup.direction === 'LONG';
        const touched = isLong
          ? pred.last4HLow <= zoneHigh && pred.last4HLow >= zoneLow
          : pred.last4HHigh >= zoneLow && pred.last4HHigh <= zoneHigh;
        if (!touched) continue;
        // Send the notification
        const name = setup.symbol.replace('USDT', '');
        const title = `${name} entry zone reached`;
        const dirStr = setup.direction;
        const mlPct = Math.round(pred.mlProb * 100);
        const entryStr = setup.entry < 10 ? setup.entry.toFixed(4) : setup.entry.toFixed(2);
        const body = `${dirStr} setup at $${entryStr} is in range. ML ${mlPct}% — open the app to confirm + act.`;
        const result = await sendAPNs(env, pushToken, title, body);
        if (result === 'unregistered') {
          await deleteDevice(env, deviceId);
          return;
        }
        await env.DB.prepare('UPDATE pending_setups SET notified = 1 WHERE id = ?').bind(setup.id).run();
      }
    } catch (e) {
      console.log(`[pending-setups] check failed for ${deviceId}: ${e}`);
    }
  }

  if (triggered.length === 0 || !pushToken) return;

  // Single APN per device, batching all crossings in this window. Single-symbol case
  // keeps the original wording with the ML% so a glance at the lock screen still tells
  // the user the conviction; multi-symbol case lists tickers without per-symbol probs
  // (they all cleared 70%) to keep the title scannable.
  const tickers = triggered.map(t => t.symbol.replace('USDT', ''));
  let title: string;
  let body: string;
  if (triggered.length === 1) {
    const t = triggered[0];
    title = `${tickers[0]} ${t.direction} — ML ${Math.round(t.mlProb * 100)}%`;
    body = `Open the app for the full directional analysis.`;
  } else {
    // Group by direction so the lock-screen view shows LONG/SHORT split at a glance.
    const longs = triggered.filter(t => t.direction === 'LONG').map(t => t.symbol.replace('USDT', ''));
    const shorts = triggered.filter(t => t.direction === 'SHORT').map(t => t.symbol.replace('USDT', ''));
    const parts: string[] = [];
    if (longs.length) parts.push(`LONG: ${longs.join(', ')}`);
    if (shorts.length) parts.push(`SHORT: ${shorts.join(', ')}`);
    title = `${triggered.length} setups favorable`;
    body = parts.join(' | ');
  }
  const result = await sendAPNs(env, pushToken, title, body);
  if (result === 'unregistered') {
    await deleteDevice(env, deviceId);
    return;
  }
  // Log every triggered symbol regardless of how many APNs we sent — `notifications`
  // is the per-symbol audit trail, not the per-push log.
  for (const t of triggered) {
    await env.DB.prepare(
      'INSERT INTO notifications (device_id, symbol, type, ml_probability, score, direction) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(deviceId, t.symbol, 'ml_crossing', t.mlProb, t.score, t.direction).run();
  }
}

/// Resolves a device's APNs push token. D1 is authoritative; falls back to the KV blob
/// from older registration paths. Returns null if neither has a token (device hasn't
/// finished registration yet). Called twice per `checkDeviceScores` in the worst case
/// (once per triggering symbol at the gate, once before APN send) — both are short
/// indexed lookups so no caching needed.
async function getPushToken(env: Env, deviceId: string): Promise<string | null> {
  const deviceRow = await env.DB.prepare('SELECT push_token FROM devices WHERE device_id = ?').bind(deviceId).first();
  const fromDb = (deviceRow?.push_token as string | null) ?? null;
  if (fromDb) return fromDb;
  const deviceData = await env.ALERTS.get(`device:${deviceId}`);
  if (!deviceData) return null;
  try {
    const device = JSON.parse(deviceData);
    return device.pushToken || device.token || null;
  } catch {
    return null;
  }
}

async function fetchScoreCandles(symbol: string, isCrypto: boolean): Promise<ScoreCandle[]> {
  if (isCrypto) {
    const resp = await fetch(
      `${BINANCE_SPOT}/klines?symbol=${symbol}&interval=1d&limit=260`
    );
    if (!resp.ok) return [];
    const data = await resp.json() as any[];
    const candles = data.map((k: any) => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
    }));
    return dropInProgress(candles, '1d');
  } else {
    const resp = await fetch(
      `${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=1y`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!resp.ok) return [];
    const data = await resp.json() as any;
    const r = data?.chart?.result?.[0];
    if (!r?.timestamp) return [];
    const ts = r.timestamp;
    const q = r.indicators.quote[0];
    const candles = ts.map((t: number, i: number) => ({
      time: t * 1000,
      open: q.open[i] || 0, high: q.high[i] || 0,
      low: q.low[i] || 0, close: q.close[i] || 0,
      volume: q.volume[i] || 0
    })).filter((c: ScoreCandle) => c.close > 0);
    return dropInProgress(candles, '1d');
  }
}

// Fetch all three timeframes for the /indicators endpoint. Crypto: Binance klines direct.
// Stock: Yahoo daily + 1H, 4H aggregated from 1H (mirrors the cron + iOS). In-progress dropped.
async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<ScoreCandle[]> {
  const resp = await fetch(`${BINANCE_SPOT}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!resp.ok) return [];
  const data = await resp.json() as any[];
  return dropInProgress(data.map((k: any) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })), interval);
}
async function fetchYahooCandlesTF(symbol: string, interval: string, range: string): Promise<ScoreCandle[]> {
  const resp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return [];
  const data = await resp.json() as any;
  const r = data?.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const ts = r.timestamp, q = r.indicators.quote[0];
  const out: ScoreCandle[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.open?.[i] != null && q.close?.[i] != null) out.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
  }
  return dropInProgress(out, interval);
}
async function fetchAllTimeframes(symbol: string, isCrypto: boolean): Promise<{ daily: ScoreCandle[]; fourH: ScoreCandle[]; oneH: ScoreCandle[] }> {
  if (isCrypto) {
    const [daily, fourH, oneH] = await Promise.all([
      fetchBinanceKlines(symbol, '1d', 260), fetchBinanceKlines(symbol, '4h', 300), fetchBinanceKlines(symbol, '1h', 300),
    ]);
    return { daily, fourH, oneH };
  }
  const [daily, oneH] = await Promise.all([
    fetchYahooCandlesTF(symbol, '1d', '1y'), fetchYahooCandlesTF(symbol, '1h', '6mo'),
  ]);
  const fourH = oneH.length ? dropInProgress(aggregate1HTo4H_ET(oneH as FullCandle[]), '4h') : [];
  return { daily, fourH, oneH };
}

// === D1 Candle Archive ===
async function archiveCandlesToD1(env: Env, symbol: string, interval: string, candles: ScoreCandle[]) {
  if (candles.length === 0) return;
  // Batch insert, 50 at a time (D1 batch limit)
  const recent = candles.slice(-100); // Only archive the most recent 100 candles per fetch
  for (let i = 0; i < recent.length; i += 50) {
    const batch = recent.slice(i, i + 50);
    try {
      await env.DB.batch(
        batch.map(c =>
          env.DB.prepare(
            'INSERT OR IGNORE INTO candles (symbol, interval, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(symbol, interval, c.time, c.open, c.high, c.low, c.close, c.volume)
        )
      );
    } catch { /* D1 write failed — non-critical */ }
  }
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
