# MarketScope Web

Browser client for MarketScope — a **thin client** over the Cloudflare Worker
(`marketscope-proxy.ludikure.workers.dev`). All indicator computation, ML scoring, and
LLM prompt-building live server-side (the Phase 1 "shared brain"); this app just renders
`GET /indicators` and `POST /full-analysis`.

## Run

```bash
cd web
npm install
npm run dev        # http://localhost:5173 (talks to the live Worker)
npm run build      # tsc + vite → dist/
npm run preview    # serve the production build locally
```

Point at a different Worker with `VITE_WORKER_BASE` (e.g. a `.env.local` with
`VITE_WORKER_BASE=https://…`). Defaults to the production Worker.

## Auth

Mirrors iOS: a `device_id` (localStorage) is registered via `POST /register` on first use,
the returned token is stored in localStorage and sent as `X-Auth-Token` (+ `X-App-ID` +
`X-Device-ID`) on every request. A 401 rotates the device_id and re-registers.

## Deploy (Cloudflare Pages)

```bash
npm run build
npx wrangler pages deploy dist --project-name marketscope-web
```

(First deploy creates the Pages project. Outward-facing — deploy intentionally.)

## Status (v1)

- ✅ Auth bootstrap, symbol load, quick-pick symbols
- ✅ Price header (price + bias + ATR percentile)
- ✅ Candlestick chart (lightweight-charts) with EMA20/50/200 overlays + S/R + setup price lines
- ✅ Per-timeframe indicator table (Daily / 4H / 1H)
- ✅ Run AI Analysis → markdown + setups table + ML/bias card
- ⬜ Outcome dashboard / ML calibration / direction scoreboard (read existing endpoints)
- ⬜ Sub-panels (RSI/MACD/Stoch/ADX/Volume), watchlist, settings, alerts
