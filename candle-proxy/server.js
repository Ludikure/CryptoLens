// MarketScope candle proxy — runs on TrueNAS (residential IP, not datacenter-blocked by
// Binance). The Cloudflare Worker calls this through your existing cloudflared tunnel to get
// Binance-native klines/prices. Gated by a shared secret. Zero dependencies (Node 18+ global fetch).
//
//   GET /health                                         → {ok:true}  (no auth, for tunnel checks)
//   GET /klines?symbol=BTCUSDT&interval=1h&limit=750    → Binance fapi klines (raw array)
//   GET /price?symbol=BTCUSDT                           → {symbol, price}
//
// Auth: every non-/health request must carry  X-Proxy-Secret: <PROXY_SECRET>.
const http = require('http');

const SECRET = process.env.PROXY_SECRET || '';
const PORT = parseInt(process.env.PORT || '8787', 10);
const FAPI = 'https://fapi.binance.com';            // USDT-M futures: same symbols as the model/Bybit
const VALID_INTERVAL = /^(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w)$/;

async function upstream(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) { const e = new Error(`upstream ${r.status}`); e.code = r.status; throw e; }
  return r.json();
}

const server = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    const u = new URL(req.url, 'http://local');
    if (u.pathname === '/health') return send(200, { ok: true, ts: Date.now() });
    if (SECRET && req.headers['x-proxy-secret'] !== SECRET) return send(401, { error: 'unauthorized' });

    const symbol = (u.searchParams.get('symbol') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!symbol) return send(400, { error: 'symbol required' });

    if (u.pathname === '/klines') {
      const interval = u.searchParams.get('interval') || '1h';
      if (!VALID_INTERVAL.test(interval)) return send(400, { error: 'bad interval' });
      const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '500', 10) || 500, 1), 1500);
      const data = await upstream(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      return send(200, data);                       // raw Binance array — Worker parses k[0..5]
    }
    if (u.pathname === '/price') {
      const data = await upstream(`${FAPI}/fapi/v1/ticker/price?symbol=${symbol}`);
      return send(200, { symbol, price: data?.price });
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    return send(e.code && e.code >= 400 && e.code < 500 ? e.code : 502, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => console.log(`MarketScope candle proxy listening on :${PORT} (auth ${SECRET ? 'on' : 'OFF — set PROXY_SECRET!'})`));
