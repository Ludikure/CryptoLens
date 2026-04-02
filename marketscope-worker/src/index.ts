// MarketScope Worker — Secure proxy with per-device isolation
// All API keys stay server-side. Device auth via signed tokens.

export interface Env {
  ALERTS: KVNamespace;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_BUNDLE_ID: string;
  CLAUDE_API_KEY: string;
  GEMINI_API_KEY: string;
  TWELVE_DATA_API_KEY: string;
  FINNHUB_API_KEY: string;
  FRED_API_KEY: string;
  TIINGO_API_KEY: string;
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

const CORS = {
  'Access-Control-Allow-Origin': 'capacitor://com.ludikure.CryptoLens',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Device-ID, X-Auth-Token, X-App-ID',
};

// Limits
const RATE_LIMIT_ANALYZE = 10;   // AI calls per device per hour
const MAX_ALERTS = 50;           // Max alerts per device
const MAX_PROMPT_CHARS = 40_000; // Max prompt size (weekly + SPY + spot pressure increase payload)
const MAX_BODY_BYTES = 256_000;  // Max request body size (256KB)
const MAX_NOTE_LENGTH = 500;     // Max alert note length
const DEVICE_ID_REGEX = /^[a-zA-Z0-9-]{1,128}$/;
const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];

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

    // Block non-app traffic — require app identifier header on all endpoints
    const appId = request.headers.get('X-App-ID');
    if (appId !== 'marketscope-ios') {
      return json({ error: 'Forbidden' }, 403);
    }

    // Enforce body size limit on POST requests
    if (request.method === 'POST') {
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

    // === Device registration — issues an auth token ===
    if (path === '/register' && request.method === 'POST') {
      try {
        const body = await request.json() as { deviceToken?: string };
        if (!deviceId) return json({ error: 'Missing device ID' }, 400);

        const existing = await env.ALERTS.get(`auth:${deviceId}`);

        if (existing) {
          // Existing device — must prove ownership by sending current token
          const providedToken = request.headers.get('X-Auth-Token') || '';
          if (!timingSafeEqual(providedToken, existing)) return json({ error: 'Unauthorized' }, 401);

          // Authenticated — update push token if provided
          if (body.deviceToken) {
            const reg: DeviceRegistration = { token: body.deviceToken, updatedAt: Date.now() };
            await env.ALERTS.put(`device:${deviceId}`, JSON.stringify(reg), { expirationTtl: 86400 * 30 });
          }
          return json({ ok: true });
        }

        // New device — rate limit by IP
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const ipLimited = await checkRateLimit(env, `reg-ip:${ip}`, 3, 86400);
        if (ipLimited) return json({ error: 'Too many registrations. Try again tomorrow.' }, 429);

        const token = crypto.randomUUID() + '-' + crypto.randomUUID();
        await env.ALERTS.put(`auth:${deviceId}`, token, { expirationTtl: 86400 * 90 });

        if (body.deviceToken) {
          const reg: DeviceRegistration = { token: body.deviceToken, updatedAt: Date.now() };
          await env.ALERTS.put(`device:${deviceId}`, JSON.stringify(reg), { expirationTtl: 86400 * 30 });
        }

        // Only return token on first creation
        return json({ ok: true, authToken: token });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // All endpoints (except /register) require valid auth token
    if (path !== '/register') {
      if (!deviceId || !authToken) return json({ error: 'Unauthorized' }, 401);
      const storedToken = await env.ALERTS.get(`auth:${deviceId}`);
      if (!storedToken || !timingSafeEqual(storedToken, authToken)) return json({ error: 'Unauthorized' }, 401);
    }

    // === Alert sync (per-device isolation) ===
    if (path === '/alerts' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      try {
        const body = await request.json() as { alerts: any[] };
        if (!body.alerts || !Array.isArray(body.alerts)) return json({ error: 'Missing alerts' }, 400);
        const validated = body.alerts.slice(0, MAX_ALERTS).map(validateAlert).filter((a): a is Alert => a !== null);
        await env.ALERTS.put(`alerts:${deviceId}`, JSON.stringify(validated), { expirationTtl: 86400 * 7 });
        return json({ ok: true, count: validated.length });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }
    if (path === '/alerts' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const data = await env.ALERTS.get(`alerts:${deviceId}`);
      return json(data ? JSON.parse(data) : []);
    }
    if (path === '/alerts' && request.method === 'DELETE') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      await env.ALERTS.delete(`alerts:${deviceId}`);
      return json({ ok: true });
    }

    // === AI Analysis Proxy ===
    if (path === '/analyze' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);

      // Rate limit per device
      const limited = await checkRateLimit(env, `analyze:${deviceId}`, RATE_LIMIT_ANALYZE);
      if (limited) return json({ error: 'Rate limited. Max 10 analyses per hour.' }, 429);

      try {
        const body = await request.json() as { model: string; system: string; prompt: string; provider?: string };
        if (!body.prompt || !body.system) return json({ error: 'Missing prompt or system' }, 400);

        // Validate prompt size
        if (body.prompt.length > MAX_PROMPT_CHARS || body.system.length > MAX_PROMPT_CHARS) {
          return json({ error: 'Prompt too large' }, 413);
        }

        const provider = body.provider || 'claude';

        if (provider === 'gemini') {
          // Gemini
          if (!env.GEMINI_API_KEY) return json({ error: 'Gemini not configured' }, 503);
          const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];
          const model = GEMINI_MODELS.includes(body.model) ? body.model : 'gemini-2.5-flash';

          // Note: Gemini requires API key in URL (no header auth). Server-to-server only.
          const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
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

          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': env.CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 4000,
              temperature: 0,
              system: body.system,
              messages: [{ role: 'user', content: body.prompt }],
            }),
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
        const startDate = new Date(Date.now() - parseInt(days) * 86400_000).toISOString().split('T')[0];
        let apiUrl: string;
        if (interval === '1day') {
          apiUrl = `${TIINGO_DAILY}/${symbol}/prices?startDate=${startDate}&token=${env.TIINGO_API_KEY}`;
        } else {
          apiUrl = `${TIINGO_IEX}/${symbol}/prices?startDate=${startDate}&resampleFreq=${interval}&columns=open,high,low,close,volume&token=${env.TIINGO_API_KEY}`;
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

    // === Twelve Data Candles (cached 5min, shared) ===
    if (path === '/twelvedata/candles') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval')?.replace(/[^0-9a-zA-Z]/g, '') || '1day';
      const outputsize = Math.min(parseInt(url.searchParams.get('outputsize') || '50'), 300);
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.TWELVE_DATA_API_KEY) return json({ error: 'Twelve Data not configured' }, 503);

      const cacheKey = `cache:td:${symbol}:${interval}:${outputsize}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        // Note: Twelve Data requires API key in URL. Server-to-server only.
        const resp = await fetch(`${TWELVE_DATA_BASE}/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${env.TWELVE_DATA_API_KEY}`);
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
        const resp = await fetch(`${TWELVE_DATA_BASE}/quote?symbol=${symbol}&apikey=${env.TWELVE_DATA_API_KEY}`);
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
      };

      const config = endpointMap[endpoint];
      if (!config) return json({ error: 'Unknown Finnhub endpoint' }, 404);

      const cacheKey = `cache:fh:${endpoint}:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < config.ttl) return json(parsed.data);
      }

      try {
        const finnhubUrl = `${FINNHUB_BASE}${config.path}?symbol=${symbol}${config.params || ''}`;
        const resp = await fetch(finnhubUrl, {
          headers: { 'X-Finnhub-Token': env.FINNHUB_API_KEY },
        });
        if (!resp.ok) return json({ error: `Finnhub ${resp.status}` }, 502);
        const data = await resp.json();
        const kvTtl = Math.max(Math.ceil(config.ttl / 1000), 60);
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: kvTtl });
        return json(data);
      } catch {
        return json({ error: 'Finnhub fetch failed' }, 502);
      }
    }

    // === Macro Data — now powered by FRED (cached 5m, shared) ===
    if (path === '/macro') {
      const cacheKey = 'cache:macro:v2';
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
          ['usdIndex', 'DTWEXBGS'],
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

      // Compute yield spread
      if (data.treasury10Y != null && data.treasury2Y != null) {
        data.yieldSpread = Math.round((data.treasury10Y - data.treasury2Y) * 100) / 100;
      }

      await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
      return json(data);
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
        const resp = await fetch(`${YAHOO_BASE}/v10/finance/quoteSummary/${symbol}?modules=${modules}`);
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
        const resp = await fetch(`${YAHOO_BASE}/v7/finance/options/${symbol}`);
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Fetch failed' }, 502);
      }
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkAllDeviceAlerts(env));
  },
};

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
  // Paginate through all alert keys (KV list returns max 1000 per call)
  let cursor: string | undefined = undefined;
  do {
    const listResult = await env.ALERTS.list({ prefix: 'alerts:', cursor });
    for (const key of listResult.keys) {
      const deviceId = key.name.replace('alerts:', '');
      await checkDeviceAlerts(env, deviceId);
    }
    cursor = listResult.list_complete ? undefined : (listResult as any).cursor;
  } while (cursor);
}

async function checkDeviceAlerts(env: Env, deviceId: string) {
  const alertsData = await env.ALERTS.get(`alerts:${deviceId}`);
  if (!alertsData) return;
  let alerts: Alert[] = JSON.parse(alertsData);
  const activeAlerts = alerts.filter(a => !a.triggered);
  console.log(`[cron] device=${deviceId.substring(0,8)} total=${alerts.length} active=${activeAlerts.length}`);
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
  await env.ALERTS.put(`alerts:${deviceId}`, JSON.stringify(alerts), { expirationTtl: 86400 * 7 });

  // Send push notifications
  const deviceData = await env.ALERTS.get(`device:${deviceId}`);
  if (!deviceData) return;
  const device: DeviceRegistration = JSON.parse(deviceData);

  for (const alert of triggered) {
    const price = prices[alert.symbol];
    const name = alert.symbol.replace('USDT', '');
    const title = `${name} Alert`;
    const body = `${name} hit $${price?.toLocaleString('en-US', { maximumFractionDigits: 2 })} (${alert.condition} $${alert.targetPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })})`;
    await sendAPNs(env, device.token, title, body);
  }
}

// === APNs ===
async function sendAPNs(env: Env, deviceToken: string, title: string, body: string) {
  // Try sandbox first (development builds), fall back to production
  const endpoints = [
    'https://api.sandbox.push.apple.com',
    'https://api.push.apple.com',
  ];

  try {
    const jwt = await buildAPNsJWT(env);
    if (!jwt) { console.error('APNs: JWT build returned null'); return; }

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
        return;
      }
      const errBody = await resp.text();
      console.error(`APNs ${endpoint.includes('sandbox') ? 'sandbox' : 'prod'} ${resp.status}: ${errBody}`);
      // If sandbox says BadDeviceToken, try production (token is from a release build)
      if (resp.status === 400 && errBody.includes('BadDeviceToken')) continue;
      // Any other error, stop trying
      return;
    }
  } catch (e) {
    console.error(`APNs send failed: ${e}`);
  }
}

async function buildAPNsJWT(env: Env): Promise<string | null> {
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

    return `${header}.${payload}.${sigB64}`;
  } catch {
    console.error('JWT build failed');
    return null;
  }
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
