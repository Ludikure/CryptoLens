// Temporary cutover passthrough. Forwards every request from the old workers.dev URL
// (marketscope-proxy.ludikure.workers.dev) to the self-hosted box via marketscope.ludikure.org,
// so installed iOS apps keep working without an update. No bindings, no cron — deploying this
// FREEZES the Cloudflare D1 (nothing writes to it anymore) and stops the CF cron.
//
// Rollback: `npx wrangler deploy` (the normal wrangler.toml redeploys the real worker + cron).
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    url.hostname = 'marketscope.ludikure.org';
    return fetch(new Request(url, request));
  },
};
