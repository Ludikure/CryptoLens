// HTTP entry point. Bridges Node's http server to the worker's Web-standard fetch() handler,
// boots the cron, and runs a startup self-test on the APNs key before accepting traffic.

import http from 'node:http';
import { Readable } from 'node:stream';
import worker from '../src/index';
import { buildEnv, assertApnsKeyValid } from './env';
import { installFetchProxy } from './fetch-proxy';
import { startCron } from './cron';
import { startLiquidationCollector } from './liquidations';

async function main() {
  installFetchProxy();          // must run before any fetch (worker imports may not fetch at load, but be safe)
  const env = buildEnv();

  // Fail loudly at boot if the APNs key is the wrong format — never discover it as silent
  // push loss in production.
  try {
    await assertApnsKeyValid(env);
    console.log('APNs key OK (importKey succeeded)');
  } catch (e) {
    console.error('FATAL: APNs key failed to import — check APNS_PRIVATE_KEY is base64(PEM):', e);
    process.exit(1);
  }

  const PORT = Number(process.env.PORT ?? 8787);

  const server = http.createServer(async (req, res) => {
    try {
      const url = `http://${req.headers.host ?? 'localhost'}${req.url}`;
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: hasBody ? (Readable.toWeb(req) as any) : undefined,
        // @ts-expect-error Node requires duplex for streamed request bodies
        duplex: hasBody ? 'half' : undefined,
      });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error('request error', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal"}');
    }
  });

  server.listen(PORT, () => console.log(`marketscope listening on :${PORT}`));
  startCron(worker as any, env);
  // Binance forced-liquidation websocket → `liquidations` D1. Non-backfillable data — every
  // uncollected day is gone forever, so this starts unconditionally with the process.
  startLiquidationCollector(env);
}

main().catch((e) => {
  console.error('FATAL: failed to start', e);
  process.exit(1);
});
