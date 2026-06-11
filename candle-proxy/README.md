# MarketScope candle proxy (TrueNAS)

A tiny zero-dependency service that fetches Binance market data from your **residential IP**
(Binance blocks Cloudflare/datacenter IPs, not homes). The Cloudflare Worker calls this through
your existing `cloudflared` tunnel, so it gets Binance-native candles/prices. Bybit stays as the
automatic fallback, so a home reboot never causes an outage.

## Endpoints
- `GET /health` — no auth (tunnel/health checks)
- `GET /klines?symbol=BTCUSDT&interval=1h&limit=750` — raw Binance fapi klines
- `GET /price?symbol=BTCUSDT` — `{symbol, price}`

All non-health requests require header `X-Proxy-Secret: <PROXY_SECRET>`.

## Deploy on TrueNAS SCALE

1. Copy this `candle-proxy/` folder to the NAS (e.g. `/mnt/pool/apps/candle-proxy`).
2. Create a `.env` next to `docker-compose.yml`:
   ```
   PROXY_SECRET=<generate a long random string>
   ```
   (generate one: `openssl rand -hex 32`)
3. Build + run:
   ```
   docker compose up -d --build
   ```
   Verify locally: `curl localhost:8787/health` → `{"ok":true,...}`

## Wire the tunnel

In your Cloudflare Zero Trust dashboard (or `~/.cloudflared/config.yml`), add a public-hostname
route to your existing tunnel:
```
hostname: marketscope.ludikure.org   →   service: http://localhost:8787
```
Verify from anywhere: `curl https://marketscope.ludikure.org/health` → `{"ok":true,...}`

## Tell the Worker about it

From `marketscope-worker/`:
```
npx wrangler secret put BINANCE_PROXY_BASE      # → https://marketscope.ludikure.org
npx wrangler secret put BINANCE_PROXY_SECRET    # → the same PROXY_SECRET from step 2
npx wrangler deploy
```
The Worker tries the proxy first, falls back to Bybit, then Binance-direct. Until these secrets
are set it ignores the proxy entirely (Bybit only) — so setting them is a clean cut-over.
