// MarketScope Push Notification Worker
// - Cron: checks prices vs alerts every minute
// - API: syncs alerts + device tokens from the app
// - APNs: sends push notifications when alerts trigger

export interface Env {
  ALERTS: KVNamespace;
  APNS_KEY_ID: string;      // Apple APNs key ID
  APNS_TEAM_ID: string;     // Apple Developer Team ID
  APNS_PRIVATE_KEY: string; // .p8 key content (base64 encoded)
  APNS_BUNDLE_ID: string;   // com.ludikure.CryptoLens
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  // HTTP handler — sync alerts + register device
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/health') {
      return json({ status: 'ok', service: 'marketscope-alerts' });
    }

    // Register device token
    if (path === '/register' && request.method === 'POST') {
      try {
        const body = await request.json() as { deviceToken: string };
        if (!body.deviceToken) return json({ error: 'Missing deviceToken' }, 400);
        const reg: DeviceRegistration = { token: body.deviceToken, updatedAt: Date.now() };
        await env.ALERTS.put('device:default', JSON.stringify(reg));
        return json({ ok: true });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // Sync alerts from app
    if (path === '/alerts' && request.method === 'POST') {
      try {
        const body = await request.json() as { alerts: Alert[] };
        if (!body.alerts) return json({ error: 'Missing alerts' }, 400);
        await env.ALERTS.put('alerts:default', JSON.stringify(body.alerts));
        return json({ ok: true, count: body.alerts.length });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // Get current alerts
    if (path === '/alerts' && request.method === 'GET') {
      const data = await env.ALERTS.get('alerts:default');
      return json(data ? JSON.parse(data) : []);
    }

    // Clear alerts
    if (path === '/alerts' && request.method === 'DELETE') {
      await env.ALERTS.put('alerts:default', '[]');
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },

  // Cron handler — check prices and send notifications
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkAlerts(env));
  },
};

async function checkAlerts(env: Env) {
  // Load alerts
  const alertsData = await env.ALERTS.get('alerts:default');
  if (!alertsData) return;
  let alerts: Alert[] = JSON.parse(alertsData);
  const activeAlerts = alerts.filter(a => !a.triggered);
  if (activeAlerts.length === 0) return;

  // Get unique symbols
  const symbols = [...new Set(activeAlerts.map(a => a.symbol))];

  // Fetch current prices
  const prices: Record<string, number> = {};
  for (const symbol of symbols) {
    try {
      const resp = await fetch(`${BINANCE_SPOT}/ticker/price?symbol=${symbol}`);
      if (resp.ok) {
        const data = await resp.json() as { price: string };
        prices[symbol] = parseFloat(data.price);
      }
    } catch { /* skip */ }
  }

  // Check each alert
  const triggered: Alert[] = [];
  for (const alert of activeAlerts) {
    const price = prices[alert.symbol];
    if (!price) continue;

    const hit = alert.condition === 'above'
      ? price >= alert.targetPrice
      : price <= alert.targetPrice;

    if (hit) {
      alert.triggered = true;
      triggered.push(alert);
    }
  }

  if (triggered.length === 0) return;

  // Save updated alerts
  await env.ALERTS.put('alerts:default', JSON.stringify(alerts));

  // Send push notifications
  const deviceData = await env.ALERTS.get('device:default');
  if (!deviceData) return;
  const device: DeviceRegistration = JSON.parse(deviceData);

  for (const alert of triggered) {
    const price = prices[alert.symbol];
    const coinName = alert.symbol.replace('USDT', '');
    const title = `${coinName} Alert`;
    const body = `${coinName} hit $${price?.toLocaleString('en-US', { maximumFractionDigits: 2 })} (${alert.condition} $${alert.targetPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })})${alert.note ? '\n' + alert.note : ''}`;

    await sendAPNs(env, device.token, title, body);
  }
}

async function sendAPNs(env: Env, deviceToken: string, title: string, body: string) {
  try {
    // Build JWT for APNs
    const jwt = await buildAPNsJWT(env);
    if (!jwt) return;

    const payload = {
      aps: {
        alert: { title, body },
        sound: 'default',
        badge: 1,
      },
    };

    const apnsHost = 'https://api.push.apple.com'; // Production
    const resp = await fetch(`${apnsHost}/3/device/${deviceToken}`, {
      method: 'POST',
      headers: {
        'authorization': `bearer ${jwt}`,
        'apns-topic': env.APNS_BUNDLE_ID || 'com.ludikure.CryptoLens',
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      console.error(`APNs error: ${resp.status} ${await resp.text()}`);
    }
  } catch (e) {
    console.error('APNs send failed:', e);
  }
}

async function buildAPNsJWT(env: Env): Promise<string | null> {
  try {
    const keyId = env.APNS_KEY_ID;
    const teamId = env.APNS_TEAM_ID;
    const privateKeyB64 = env.APNS_PRIVATE_KEY;
    if (!keyId || !teamId || !privateKeyB64) return null;

    // Decode the .p8 key
    const privateKeyPem = atob(privateKeyB64);
    const pemContents = privateKeyPem
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s/g, '');
    const keyData = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const key = await crypto.subtle.importKey(
      'pkcs8',
      keyData,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );

    // JWT header + payload
    const header = btoa(JSON.stringify({ alg: 'ES256', kid: keyId })).replace(/=/g, '');
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(JSON.stringify({ iss: teamId, iat: now })).replace(/=/g, '');
    const signingInput = `${header}.${payload}`;

    // Sign
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(signingInput)
    );

    // Convert DER signature to raw
    const sigArray = new Uint8Array(signature);
    const sigB64 = btoa(String.fromCharCode(...sigArray))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    return `${header}.${payload}.${sigB64}`;
  } catch (e) {
    console.error('JWT build failed:', e);
    return null;
  }
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
