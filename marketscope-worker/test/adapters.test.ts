// Proves the self-hosting adapters reproduce the D1/KV/R2 surfaces the worker relies on.
// These run in plain vitest (Node) — no Cloudflare, no TrueNAS — so the contract is verified
// before any deploy.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { D1Adapter } from '../server/d1-adapter';
import { KVAdapter } from '../server/kv-adapter';
import { R2Adapter } from '../server/r2-adapter';

describe('D1Adapter', () => {
  let db: D1Adapter;
  beforeEach(async () => {
    db = new D1Adapter(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER)');
  });

  it('run() reports changes + last_row_id; first() returns row or null', async () => {
    const r = await db.prepare('INSERT INTO t (name, flag) VALUES (?, ?)').bind('a', 1).run();
    expect(r.success).toBe(true);
    expect(r.meta.changes).toBe(1);
    expect(r.meta.last_row_id).toBe(1);

    const row = await db.prepare('SELECT * FROM t WHERE id = ?').bind(1).first();
    expect(row).toEqual({ id: 1, name: 'a', flag: 1 });

    const missing = await db.prepare('SELECT * FROM t WHERE id = ?').bind(999).first();
    expect(missing).toBeNull();
  });

  it('first(col) returns the scalar; null when missing', async () => {
    await db.prepare('INSERT INTO t (name) VALUES (?)').bind('z').run();
    const name = await db.prepare('SELECT name FROM t WHERE id = ?').bind(1).first('name');
    expect(name).toBe('z');
    const none = await db.prepare('SELECT name FROM t WHERE id = ?').bind(42).first('name');
    expect(none).toBeNull();
  });

  it('all() returns { results, success, meta }', async () => {
    await db.prepare('INSERT INTO t (name) VALUES (?)').bind('a').run();
    await db.prepare('INSERT INTO t (name) VALUES (?)').bind('b').run();
    const res = await db.prepare('SELECT name FROM t ORDER BY id').all();
    expect(res.success).toBe(true);
    expect(res.results).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(res.meta.rows_read).toBe(2);
  });

  it('coerces booleans -> 0/1 and undefined -> null (D1 leniency)', async () => {
    await db.prepare('INSERT INTO t (name, flag) VALUES (?, ?)').bind(undefined, true).run();
    const row = await db.prepare('SELECT name, flag FROM t WHERE id = 1').first() as any;
    expect(row.name).toBeNull();
    expect(row.flag).toBe(1);
  });

  it('batch() runs in ONE transaction and returns per-statement results', async () => {
    const out = await db.batch([
      db.prepare('INSERT INTO t (name) VALUES (?)').bind('x'),
      db.prepare('INSERT INTO t (name) VALUES (?)').bind('y'),
      db.prepare('SELECT COUNT(*) AS n FROM t'),
    ]);
    expect(out).toHaveLength(3);
    expect((out[2] as any).results[0].n).toBe(2);
  });

  it('batch() rolls back entirely on error', async () => {
    await db.prepare('INSERT INTO t (id, name) VALUES (1, ?)').bind('keep').run();
    await expect(
      db.batch([
        db.prepare('INSERT INTO t (name) VALUES (?)').bind('temp'),
        db.prepare('INSERT INTO t (id, name) VALUES (1, ?)').bind('dup'), // PK conflict -> throw
      ]),
    ).rejects.toThrow();
    // The first insert in the batch must NOT have committed.
    const count = await db.prepare('SELECT COUNT(*) AS n FROM t').first('n');
    expect(count).toBe(1);
  });

  it('INSERT OR REPLACE behaves like D1 (upsert by PK)', async () => {
    await db.prepare('INSERT OR REPLACE INTO t (id, name) VALUES (1, ?)').bind('first').run();
    await db.prepare('INSERT OR REPLACE INTO t (id, name) VALUES (1, ?)').bind('second').run();
    const name = await db.prepare('SELECT name FROM t WHERE id = 1').first('name');
    expect(name).toBe('second');
  });
});

describe('KVAdapter', () => {
  let kv: KVAdapter;
  beforeEach(() => {
    const d1 = new D1Adapter(':memory:');
    kv = new KVAdapter(d1.rawDb());
  });

  it('put/get/delete round-trip', async () => {
    expect(await kv.get('missing')).toBeNull();
    await kv.put('k', 'v');
    expect(await kv.get('k')).toBe('v');
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
  });

  it('put overwrites (last write wins)', async () => {
    await kv.put('k', 'one');
    await kv.put('k', 'two');
    expect(await kv.get('k')).toBe('two');
  });

  it('expirationTtl expires the key', async () => {
    // 1ms TTL: by the time we read, Date.now() has advanced past expiry.
    await kv.put('k', 'v', { expirationTtl: 0.001 });
    await new Promise((r) => setTimeout(r, 5));
    expect(await kv.get('k')).toBeNull();
  });

  it('no TTL means no expiry', async () => {
    await kv.put('k', 'v');
    await new Promise((r) => setTimeout(r, 5));
    expect(await kv.get('k')).toBe('v');
  });
});

describe('R2Adapter', () => {
  let root: string;
  let r2: R2Adapter;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-'));
    r2 = new R2Adapter(root);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('head() returns null for a missing object', async () => {
    expect(await r2.head('crypto/model-v3.json')).toBeNull();
  });

  it('put() then head() reports size + metadata', async () => {
    await r2.put('crypto/model-v3.json', '{"v":3}');
    const meta = await r2.head('crypto/model-v3.json');
    expect(meta).not.toBeNull();
    expect(meta!.key).toBe('crypto/model-v3.json');
    expect(meta!.size).toBe(7);
    expect(meta!.uploaded).toBeInstanceOf(Date);
  });

  it('get() round-trips text/json', async () => {
    await r2.put('stock/model-v3.json', '{"v":3}');
    const obj = await r2.get('stock/model-v3.json');
    expect(await obj!.text()).toBe('{"v":3}');
    expect(await obj!.json()).toEqual({ v: 3 });
  });

  it('rejects path traversal outside the root', async () => {
    await expect(r2.put('../escape.json', 'x')).rejects.toThrow('bad key');
  });
});
