// Drives the worker's scheduled() handler on a per-minute schedule, reproducing the Cloudflare
// cron trigger. The worker collects background work via ctx.waitUntil; we gather those promises
// and await them so the run only "ends" once every task settles.

import cron from 'node-cron';

export function startCron(worker: { scheduled: Function }, env: any) {
  // Re-entrancy lock. node-cron does NOT skip a tick if the previous run is still going. The
  // Cloudflare per-symbol refactor exists specifically to stop overlapping runs from sending
  // duplicate APNs — and VPN latency on Binance calls makes a >60s run more likely here than
  // it ever was on Workers. So if a run is still in flight, skip this tick.
  let running = false;

  cron.schedule('* * * * *', async () => {
    if (running) {
      console.warn('cron: previous run still in flight, skipping this tick');
      return;
    }
    running = true;
    const started = Date.now();
    const tasks: Promise<unknown>[] = [];
    const ctx = {
      // Time each scheduled task independently. Order matches src/index.ts scheduled():
      // [0] checkAllDeviceAlerts  [1] checkAllDeviceScores  [2] archiveShortInterest  [3] cleanupStaleDevices
      waitUntil: (p: Promise<unknown>) => {
        const i = tasks.length;
        const t0 = Date.now();
        tasks.push(Promise.resolve(p).finally(() => console.log(`cron task[${i}] ${Date.now() - t0}ms`)));
      },
      passThroughOnException() {},
    };
    const event = { scheduledTime: Date.now(), cron: '* * * * *' };
    try {
      await worker.scheduled(event, env, ctx);
      const results = await Promise.allSettled(tasks);
      for (const r of results) {
        if (r.status === 'rejected') console.error('cron task failed:', r.reason);
      }
    } catch (err) {
      console.error('cron run failed:', err);
    } finally {
      const ms = Date.now() - started;
      console.log(`cron: pass completed in ${ms}ms`);
      if (ms > 55_000) console.warn(`cron: run took ${ms}ms (approaching the 60s tick)`);
      running = false;
    }
  });

  console.log('cron started: * * * * * (per-minute)');
}
