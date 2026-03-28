// MarketScope Derivatives Proxy
// Proxies Bybit API through Cloudflare to bypass US geo-blocks.
// Binance blocks cloud IPs too, Bybit may be more permissive through CF.

const BYBIT = 'https://api.bybit.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams.toString();

    if (path === '/' || path === '/health') {
      return json({ status: 'ok', service: 'marketscope-proxy' });
    }

    // Proxy /v5/* to Bybit
    if (path.startsWith('/v5/')) {
      const target = `${BYBIT}${path}${params ? '?' + params : ''}`;
      try {
        const resp = await fetch(target, {
          headers: { 'Accept': 'application/json' },
        });
        return new Response(await resp.text(), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10', ...CORS_HEADERS },
        });
      } catch (err: any) {
        return json({ error: 'Upstream error', message: err.message }, 502);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
