# MarketScope candle proxy (TrueNAS)

A tiny zero-dependency service that fetches Binance market data and serves it to the Cloudflare
Worker through your existing `cloudflared` tunnel. Bybit stays as the automatic fallback, so a
home reboot never causes an outage.

**Your home country is Binance-blocked at the residential level** (your phone only reaches Binance
on VPN), so the proxy must exit through **NordVPN** to a permitted region — exactly like your phone.
`docker-compose.yml` runs a `gluetun` NordVPN container and routes the proxy's traffic through it.
Use the **same country that works on your phone** (one Binance serves *and* Nord can reach).

## Endpoints
- `GET /health` — no auth (tunnel/health checks)
- `GET /klines?symbol=BTCUSDT&interval=1h&limit=750` — raw Binance fapi klines
- `GET /price?symbol=BTCUSDT` — `{symbol, price}`

All non-health requests require header `X-Proxy-Secret: <PROXY_SECRET>`.

## Deploy on TrueNAS SCALE

1. Copy this `candle-proxy/` folder to the NAS (e.g. `/mnt/pool/apps/candle-proxy`).
2. Get your NordVPN WireGuard key: Nord dashboard → **Manual setup / NordLynx** → copy the
   private key. (Or use OpenVPN *service* credentials — see the note in `docker-compose.yml`.)
3. Create a `.env` next to `docker-compose.yml`:
   ```
   PROXY_SECRET=<openssl rand -hex 32>
   NORD_WG_KEY=<your NordLynx WireGuard private key>
   NORD_COUNTRY=<a region that works on your phone, e.g. Canada>
   ```
4. Build + run:
   ```
   docker compose up -d --build
   ```
5. **Verify the VPN is actually carrying the traffic** (this is the key check):
   ```
   # the proxy's exit IP should be NordVPN's, not your home IP:
   docker exec marketscope-candle-proxy wget -qO- https://api.ipify.org ; echo
   # and Binance should now be reachable through it:
   curl -s "localhost:8787/klines?symbol=BTCUSDT&interval=1h&limit=2" -H "X-Proxy-Secret: <PROXY_SECRET>"
   ```
   If `/klines` returns an array, the VPN route to Binance works. If it errors, try a different
   `NORD_COUNTRY`.

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
