// KVNamespace shape implemented over a single SQLite table.
//
// The worker uses exactly: get(key) [text only], put(key, value, {expirationTtl}), delete(key).
// No list(), no get(key, 'json'), no metadata, no `expiration` (absolute). Verified by audit.
//
// Shares the SAME better-sqlite3 connection as D1Adapter (passed in from env.ts) — WAL handles
// the cron + request concurrency within one process, and one handle avoids needless lock churn.

import type Database from 'better-sqlite3';

export class KVAdapter {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    )`);
    // Lazy GC of expired rows. unref() so this timer never keeps the process alive on its own.
    setInterval(() => {
      try {
        db.prepare('DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at < ?')
          .run(Date.now());
      } catch { /* a transient lock here is harmless — next tick retries */ }
    }, 60_000).unref();
  }

  async get(key: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT value, expires_at FROM kv_store WHERE key = ?')
      .get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }) {
    const exp = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
    this.db
      .prepare('INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)')
      .run(key, value, exp);
  }

  async delete(key: string) {
    this.db.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
  }
}
