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

const CORS = {
  'Access-Control-Allow-Origin': 'capacitor://com.ludikure.CryptoLens',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Device-ID, X-Auth-Token',
};

// Limits
const RATE_LIMIT_ANALYZE = 10;   // AI calls per device per hour
const MAX_ALERTS = 50;           // Max alerts per device
const MAX_PROMPT_CHARS = 20_000; // Max prompt size
const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/health') {
      return json({ status: 'ok', service: 'marketscope-proxy' });
    }

    // Device auth: server-issued token stored in X-Auth-Token header
    const deviceId = request.headers.get('X-Device-ID') || '';
    const authToken = request.headers.get('X-Auth-Token') || '';

    // === Device registration — issues an auth token ===
    if (path === '/register' && request.method === 'POST') {
      try {
        const body = await request.json() as { deviceToken?: string };
        if (!deviceId) return json({ error: 'Missing device ID' }, 400);

        const existing = await env.ALERTS.get(`auth:${deviceId}`);

        if (existing) {
          // Existing device — must prove ownership by sending current token
          const providedToken = request.headers.get('X-Auth-Token') || '';
          if (providedToken !== existing) return json({ error: 'Unauthorized' }, 401);

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

    // All other endpoints require valid auth token (except /macro which is public)
    if (path !== '/macro') {
      if (!deviceId || !authToken) return json({ error: 'Unauthorized' }, 401);
      const storedToken = await env.ALERTS.get(`auth:${deviceId}`);
      if (!storedToken || storedToken !== authToken) return json({ error: 'Unauthorized' }, 401);
    }

    // === Alert sync (per-device isolation) ===
    if (path === '/alerts' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      try {
        const body = await request.json() as { alerts: Alert[] };
        if (!body.alerts || !Array.isArray(body.alerts)) return json({ error: 'Missing alerts' }, 400);
        const capped = body.alerts.slice(0, MAX_ALERTS);
        await env.ALERTS.put(`alerts:${deviceId}`, JSON.stringify(capped), { expirationTtl: 86400 * 7 });
        return json({ ok: true, count: capped.length });
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
              max_tokens: 2500,
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

    // === Macro Data (cached, shared across all users) ===
    if (path === '/macro') {
      const cacheKey = 'cache:macro';
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) {
          return json(parsed.data);
        }
      }

      const data: Record<string, any> = {};

      if (env.TWELVE_DATA_API_KEY) {
        try {
          // Note: Twelve Data requires API key in URL (no header auth). Server-to-server only.
          const resp = await fetch(`${TWELVE_DATA_BASE}/quote?symbol=EUR/USD&apikey=${env.TWELVE_DATA_API_KEY}`);
          if (resp.ok) {
            const quote = await resp.json() as Record<string, any>;
            if (!quote.code) {
              data.eurusd = parseFloat(quote.close as string) || null;
              data.eurusdChange = parseFloat(quote.percent_change as string) || null;
            }
          }
        } catch { /* skip */ }
      }

      for (const [key, symbol] of [['treasury10Y', '%5ETNX'], ['treasury2Y', '%5EIRX']]) {
        try {
          const resp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=2d`);
          if (resp.ok) {
            const chart = await resp.json() as any;
            const price = chart?.chart?.result?.[0]?.meta?.regularMarketPrice;
            if (price) data[key] = price;
          }
        } catch { /* skip */ }
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
  // List all alert keys
  const alertKeys = await env.ALERTS.list({ prefix: 'alerts:' });
  for (const key of alertKeys.keys) {
    const deviceId = key.name.replace('alerts:', '');
    await checkDeviceAlerts(env, deviceId);
  }
}

async function checkDeviceAlerts(env: Env, deviceId: string) {
  const alertsData = await env.ALERTS.get(`alerts:${deviceId}`);
  if (!alertsData) return;
  let alerts: Alert[] = JSON.parse(alertsData);
  const activeAlerts = alerts.filter(a => !a.triggered);
  if (activeAlerts.length === 0) return;

  const symbols = [...new Set(activeAlerts.map(a => a.symbol))];
  const prices: Record<string, number> = {};

  for (const symbol of symbols) {
    try {
      // Try Binance for crypto (USDT pairs)
      if (symbol.endsWith('USDT')) {
        const resp = await fetch(`${BINANCE_SPOT}/ticker/price?symbol=${symbol}`);
        if (resp.ok) {
          const data = await resp.json() as { price: string };
          prices[symbol] = parseFloat(data.price);
          continue;
        }
      }
      // Fall back to Yahoo for stocks
      const resp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=1d`);
      if (resp.ok) {
        const chart = await resp.json() as any;
        const price = chart?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price) prices[symbol] = price;
      }
    } catch { /* skip */ }
  }

  const triggered: Alert[] = [];
  for (const alert of activeAlerts) {
    const price = prices[alert.symbol];
    if (!price) continue;
    const hit = alert.condition === 'above' ? price >= alert.targetPrice : price <= alert.targetPrice;
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
  try {
    const jwt = await buildAPNsJWT(env);
    if (!jwt) return;

    const resp = await fetch(`https://api.push.apple.com/3/device/${deviceToken}`, {
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

    if (!resp.ok) {
      // Log status code only, not response body
      console.error(`APNs ${resp.status}`);
    }
  } catch {
    console.error('APNs send failed');
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
