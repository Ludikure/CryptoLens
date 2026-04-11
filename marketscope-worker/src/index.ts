// MarketScope Worker — Secure proxy with per-device isolation
// All API keys stay server-side. Device auth via signed tokens.

import { computeScore, type Candle as ScoreCandle, type ScoreResult } from './scoring';
import { mlPredict, buildMLInput } from './ml-predict';
import { computeAllFeatures, type Candle as FullCandle, type FullFeatures } from './scoring-full';

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
  TWELVE_DATA_API_KEY: string;
  TWELVE_DATA_API_KEY_2?: string;
  FINNHUB_API_KEY: string;
  FRED_API_KEY: string;
  TIINGO_API_KEY: string;
  ALPHAVANTAGE_API_KEY: string;
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
        const ipLimited = await checkRateLimit(env, `reg-ip:${ip}`, 3, 86400);
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

    // All endpoints (except /register, /bls/actuals) require valid auth token
    if (path !== '/register' && path !== '/bls/actuals' && path !== '/derivatives' && path !== '/spot' && path !== '/candles/crypto' && path !== '/sentiment') {
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
      const symbols = (body.symbols || []).slice(0, 20).filter(
        (s: any) => typeof s === 'string' && s.length <= 20
      );
      const cryptoThreshold = body.cryptoThreshold || 5;
      const stockThreshold = body.stockThreshold || 3;
      // Write to D1
      const stmts = [env.DB.prepare('DELETE FROM watchlist WHERE device_id = ?').bind(deviceId)];
      for (const s of symbols) {
        stmts.push(env.DB.prepare(
          'INSERT INTO watchlist (device_id, symbol, crypto_threshold, stock_threshold) VALUES (?, ?, ?, ?)'
        ).bind(deviceId, s, cryptoThreshold, stockThreshold));
      }
      await env.DB.batch(stmts);
      // Also keep KV during migration (cron reads from KV)
      await env.ALERTS.put(`watchlist:${deviceId}`, JSON.stringify({
        symbols, cryptoThreshold, stockThreshold, updatedAt: Date.now()
      }), { expirationTtl: 86400 * 30 });
      return json({ ok: true, symbols: symbols.length });
    }

    // === ML Model Version (R2) ===
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
      query += ' ORDER BY timestamp ASC LIMIT 10000';

      const rows = await env.DB.prepare(query).bind(...params).all();
      return json({ count: rows.results.length, candles: rows.results });
    }

    // Upload candles to D1 archive (from app backtest/stitching)
    if (path === '/history' && request.method === 'POST') {
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
            ml_probability, daily_score, four_h_score, conviction, outcome, pnl_percent, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          deviceId, body.symbol, body.direction, body.entry, body.stopLoss || 0,
          body.tp1 || 0, body.tp2 || null, body.mlProb || null,
          body.dailyScore || null, body.fourHScore || null,
          body.conviction || null, body.outcome || null,
          body.pnlPercent || null, body.notes || null
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

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkAllDeviceAlerts(env));
    ctx.waitUntil(checkAllDeviceScores(env));
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
  // Get all devices with active alerts from D1
  const devices = await env.DB.prepare(
    'SELECT DISTINCT device_id FROM alerts WHERE triggered = 0'
  ).all();
  for (const row of devices.results) {
    const deviceId = row.device_id as string;
    await checkDeviceAlerts(env, deviceId);
  }
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
    await sendAPNs(env, pushToken, title, body);
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

// === Server-Side Score Notifications ===

async function checkAllDeviceScores(env: Env) {
  // Read all devices with watchlists from D1
  const devices = await env.DB.prepare(
    'SELECT DISTINCT device_id FROM watchlist'
  ).all();
  for (const row of devices.results) {
    const deviceId = row.device_id as string;
    try {
      await checkDeviceScores(env, deviceId);
    } catch (e) {
      console.log(`[score] device ${deviceId} error: ${e}`);
    }
  }
}

async function checkDeviceScores(env: Env, deviceId: string) {
  // Read watchlist from D1
  const watchlistRows = await env.DB.prepare(
    'SELECT symbol, crypto_threshold, stock_threshold FROM watchlist WHERE device_id = ?'
  ).bind(deviceId).all();
  if (!watchlistRows.results.length) return;
  const config = {
    symbols: watchlistRows.results.map(r => r.symbol as string),
    cryptoThreshold: (watchlistRows.results[0].crypto_threshold as number) || 5,
    stockThreshold: (watchlistRows.results[0].stock_threshold as number) || 3,
  };

  // Load previous ML probabilities (D1 with KV fallback)
  const prevScores = await env.DB.prepare(
    'SELECT symbol, ml_probability FROM score_history WHERE device_id = ? AND id IN (SELECT MAX(id) FROM score_history WHERE device_id = ? GROUP BY symbol)'
  ).bind(deviceId, deviceId).all();
  const prevProbs: Record<string, number> = {};
  for (const row of prevScores.results) {
    prevProbs[row.symbol as string] = row.ml_probability as number;
  }
  // KV fallback for first run after migration
  if (Object.keys(prevProbs).length === 0) {
    const prevRaw = await env.ALERTS.get(`mlprobs:${deviceId}`);
    if (prevRaw) Object.assign(prevProbs, JSON.parse(prevRaw));
  }
  const newProbs: Record<string, number> = {};
  const triggered: { symbol: string; score: number; mlProb: number; direction: string }[] = [];
  const ML_THRESHOLD = 0.60;

  for (const symbol of config.symbols) {
    try {
      const isCrypto = symbol.endsWith('USDT');

      // Check candle cache first (5-min TTL)
      const cacheKey = `candles:${symbol}:1d`;
      let candles: ScoreCandle[];
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        candles = JSON.parse(cached);
      } else {
        candles = await fetchScoreCandles(symbol, isCrypto);
        if (candles.length > 0) {
          await env.ALERTS.put(cacheKey, JSON.stringify(candles), { expirationTtl: 300 });
          // Archive to D1 (non-blocking)
          archiveCandlesToD1(env, symbol, '1d', candles).catch(() => {});
        }
      }
      if (candles.length < 210) continue;

      // Fetch 4H + 1H candles for full ML features
      let fourHCandles: FullCandle[] = [];
      let oneHCandles: FullCandle[] = [];
      if (isCrypto) {
        // 4H candles
        const cacheKey4H = `candles:${symbol}:4h`;
        const cached4H = await env.ALERTS.get(cacheKey4H);
        if (cached4H) {
          fourHCandles = JSON.parse(cached4H);
        } else {
          try {
            const resp = await fetch(`${BINANCE_SPOT}/klines?symbol=${symbol}&interval=4h&limit=260`);
            if (resp.ok) {
              const data = await resp.json() as any[];
              fourHCandles = data.map((k: any) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
              await env.ALERTS.put(cacheKey4H, JSON.stringify(fourHCandles), { expirationTtl: 300 });
              archiveCandlesToD1(env, symbol, '4h', fourHCandles).catch(() => {});
            }
          } catch {}
        }
        // 1H candles
        const cacheKey1H = `candles:${symbol}:1h`;
        const cached1H = await env.ALERTS.get(cacheKey1H);
        if (cached1H) {
          oneHCandles = JSON.parse(cached1H);
        } else {
          try {
            const resp = await fetch(`${BINANCE_SPOT}/klines?symbol=${symbol}&interval=1h&limit=100`);
            if (resp.ok) {
              const data = await resp.json() as any[];
              oneHCandles = data.map((k: any) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
              await env.ALERTS.put(cacheKey1H, JSON.stringify(oneHCandles), { expirationTtl: 300 });
            }
          } catch {}
        }
      }

      // Compute all 51 features
      const zeroDeriv = { fundingSignal: 0, oiSignal: 0, takerSignal: 0, crowdingSignal: 0, derivativesCombined: 0 };
      const defaultMacro = { vix: 20, dxyAboveEma20: 0 };
      const features = computeAllFeatures(candles as FullCandle[], fourHCandles, oneHCandles, isCrypto, zeroDeriv, defaultMacro);

      // ML predict using full features
      const mlProb = mlPredict(features as Record<string, number>, isCrypto);
      newProbs[symbol] = mlProb;

      const prevProb = prevProbs[symbol] || 0;

      // ML probability crossing detection
      if (prevProb < ML_THRESHOLD && mlProb >= ML_THRESHOLD) {
        const bias = features.dailyScore < 0 ? 'Bearish' : features.dailyScore > 0 ? 'Bullish' : 'Neutral';
        triggered.push({ symbol, score: features.dailyScore, mlProb, direction: bias });
      }
    } catch (e) {
      console.log(`[score] ${symbol} error: ${e}`);
    }
  }

  // Save new ML probabilities to KV (fast) + D1 (persistent)
  await env.ALERTS.put(`mlprobs:${deviceId}`, JSON.stringify(newProbs),
    { expirationTtl: 86400 * 7 });
  // Log score history to D1
  for (const [sym, prob] of Object.entries(newProbs)) {
    const t = triggered.find(t => t.symbol === sym);
    await env.DB.prepare(
      'INSERT INTO score_history (device_id, symbol, daily_score, four_h_score, ml_probability, bias, notification_sent) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(deviceId, sym, 0, 0, prob, prob > 0.5 ? 'Bullish' : 'Bearish', t ? 1 : 0).run();
  }

  // Send push notifications for crossings
  if (triggered.length === 0) return;

  // Get push token from D1 first, then KV fallback
  const deviceRow = await env.DB.prepare('SELECT push_token FROM devices WHERE device_id = ?').bind(deviceId).first();
  let pushToken = deviceRow?.push_token as string | null;
  if (!pushToken) {
    const deviceData = await env.ALERTS.get(`device:${deviceId}`);
    if (!deviceData) return;
    const device = JSON.parse(deviceData);
    pushToken = device.pushToken || device.token;
  }
  if (!pushToken) return;

  for (const t of triggered) {
    const ticker = t.symbol.replace('USDT', '');
    await sendAPNs(env, pushToken,
      `${ticker} — High Conviction ${t.direction} (ML: ${Math.round(t.mlProb * 100)}%)`,
      `Win probability crossed 60%. Score: ${t.score > 0 ? '+' : ''}${t.score}. Tap to analyze.`
    );
    // Log notification to D1
    await env.DB.prepare(
      'INSERT INTO notifications (device_id, symbol, type, ml_probability, score, direction) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(deviceId, t.symbol, 'ml_crossing', t.mlProb, t.score, t.direction).run();
  }
}

async function fetchScoreCandles(symbol: string, isCrypto: boolean): Promise<ScoreCandle[]> {
  if (isCrypto) {
    const resp = await fetch(
      `${BINANCE_SPOT}/klines?symbol=${symbol}&interval=1d&limit=260`
    );
    if (!resp.ok) return [];
    const data = await resp.json() as any[];
    return data.map((k: any) => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
    }));
  } else {
    const resp = await fetch(
      `${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=2y`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!resp.ok) return [];
    const data = await resp.json() as any;
    const r = data?.chart?.result?.[0];
    if (!r?.timestamp) return [];
    const ts = r.timestamp;
    const q = r.indicators.quote[0];
    return ts.map((t: number, i: number) => ({
      time: t * 1000,
      open: q.open[i] || 0, high: q.high[i] || 0,
      low: q.low[i] || 0, close: q.close[i] || 0,
      volume: q.volume[i] || 0
    })).filter((c: ScoreCandle) => c.close > 0);
  }
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
