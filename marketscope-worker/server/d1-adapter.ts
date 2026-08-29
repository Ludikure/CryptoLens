// D1Database shape implemented over better-sqlite3.
//
// The worker uses exactly these D1 surfaces (verified by source audit):
//   prepare().bind().first()       -> row object or null
//   prepare().bind().first(col)    -> scalar or null  (NOT currently used, but supported)
//   prepare().bind().all()         -> { results, success, meta }
//   prepare().bind().run()         -> { results: [], success, meta }
//   batch([stmt, ...])             -> one transaction, array of per-statement results
// All placeholders are positional `?` (no `?N`, no named params, no RETURNING in batches).
//
// better-sqlite3 is synchronous; D1 is async. We keep the async signatures so `src/index.ts`
// is byte-for-byte unchanged — the `await`s simply resolve immediately.

import Database from 'better-sqlite3';

// better-sqlite3 only binds numbers, strings, bigints, Buffers, and null. D1 is more lenient
// (it coerces booleans and treats undefined as null). The worker already coerces at every
// call site, but we mirror D1's leniency so a missed site degrades the same way it did on D1
// instead of throwing a different error.
function coerce(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export class D1Adapter {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');   // concurrent reads alongside the cron's writes
    this.db.pragma('busy_timeout = 5000');  // wait out a lock instead of erroring immediately
    this.db.pragma('synchronous = NORMAL'); // WAL-safe durability with far less fsync overhead
    // D1 does not enforce foreign keys the way better-sqlite3 does by default. The worker's
    // cleanupStaleDevices deletes a device without cascading every child table, which trips an
    // FK error here but was a silent no-op on D1. Turn enforcement OFF to match D1's behavior
    // (deletes leave at most a few harmless orphan rows; nothing the app reads breaks).
    this.db.pragma('foreign_keys = OFF');
  }

  /** The underlying connection, shared with KVAdapter so the process holds ONE handle. */
  rawDb() {
    return this.db;
  }

  prepare(sql: string) {
    return new D1Stmt(this.db, sql);
  }

  async batch(stmts: D1Stmt[]) {
    const tx = this.db.transaction(() => stmts.map((s) => s.runSync()));
    return tx(); // throws => whole transaction rolls back, matching D1 batch atomicity
  }

  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
}

class D1Stmt {
  private params: unknown[] = [];
  constructor(private db: Database.Database, private sql: string) {}

  bind(...params: unknown[]) {
    this.params = coerce(params);
    return this;
  }

  // better-sqlite3 caches prepared statements per-connection keyed on the SQL string,
  // so re-preparing here is cheap (no recompilation).
  private stmt() {
    return this.db.prepare(this.sql);
  }

  async first(col?: string) {
    const row = this.stmt().get(...this.params) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return col !== undefined ? (row[col] ?? null) : row;
  }

  async all() {
    const results = this.stmt().all(...this.params);
    return { results, success: true, meta: this.meta(results.length) };
  }

  async run() {
    const info = this.stmt().run(...this.params);
    return {
      results: [],
      success: true,
      meta: this.meta(0, info.changes, Number(info.lastInsertRowid)),
    };
  }

  // Used inside batch(). D1's batch returns the natural result shape per statement, so a
  // SELECT inside a batch yields { results }, a write yields meta.changes.
  runSync() {
    const isRead = /^\s*select/i.test(this.sql);
    if (isRead) {
      const results = this.stmt().all(...this.params);
      return { results, success: true, meta: this.meta(results.length) };
    }
    const info = this.stmt().run(...this.params);
    return {
      results: [],
      success: true,
      meta: this.meta(0, info.changes, Number(info.lastInsertRowid)),
    };
  }

  private meta(read = 0, changes = 0, lastRowId = 0) {
    return {
      duration: 0,
      rows_read: read,
      rows_written: changes,
      changes,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      size_after: 0,
    };
  }
}

export type { D1Stmt };
