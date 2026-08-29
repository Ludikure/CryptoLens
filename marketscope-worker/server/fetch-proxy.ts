// Monkey-patches globalThis.fetch for two self-hosting concerns, so src/index.ts stays unchanged:
//
//  1. Binance egress via the gluetun/NordVPN sidecar. The TrueNAS residential IP is
//     geo-blocked by Binance, so hosts in PROXIED_HOSTS are dispatched through the HTTP proxy.
//     Set PROXIED_HOSTS from MEASURED reachability (see Phase 2.2 pre-flight) — do not assume
//     data-api.binance.vision / Bybit are reachable direct just because they were on Cloudflare.
//
//  2. NOTIFY_DRY_RUN. During Phase 5 validation the rehearsal app runs its cron alongside the
//     still-live Cloudflare cron; both hold real device tokens. Without this, you'd get
//     duplicate pushes for the whole soak. When NOTIFY_DRY_RUN is set, APNs POSTs are
//     intercepted and answered with a synthetic 200 — the worker logs "sent", nothing leaves
//     the box. Flip it off only for the single deliberate end-to-end push test.

import { ProxyAgent } from 'undici';

const APNS_HOSTS = new Set(['api.push.apple.com', 'api.sandbox.push.apple.com']);

export function installFetchProxy() {
  const proxyUrl = process.env.BINANCE_PROXY_URL; // e.g. http://gluetun:8888
  const proxiedHosts = new Set(
    (process.env.PROXIED_HOSTS ?? 'fapi.binance.com,api.binance.com')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  );
  const dryRun = process.env.NOTIFY_DRY_RUN === '1' || process.env.NOTIFY_DRY_RUN === 'true';
  const agent = proxyUrl ? new ProxyAgent(proxyUrl) : null;

  if (!agent && !dryRun) return; // nothing to intercept

  const orig = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    let host = '';
    try {
      host = new URL(typeof input === 'string' ? input : input.url).hostname;
    } catch {
      return orig(input, init);
    }

    // Dry-run: swallow APNs sends, return a synthetic OK so sendAPNs() reports 'sent'.
    if (dryRun && APNS_HOSTS.has(host)) {
      console.log(`[NOTIFY_DRY_RUN] suppressed APNs POST to ${host}`);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }

    // Binance (and any other measured-blocked host): dispatch through the VPN proxy.
    if (agent && proxiedHosts.has(host)) {
      return orig(input, { ...init, dispatcher: agent });
    }

    return orig(input, init);
  }) as typeof fetch;
}
