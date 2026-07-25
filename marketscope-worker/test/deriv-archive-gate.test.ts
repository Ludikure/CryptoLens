// The derivatives D1 archive is gated to one row per symbol per 3.5h. That gate used to live in the
// `deriv_archive:all` KV blob alone, so an eviction (or an overlapping cron reading a blob the other
// pass hadn't flushed) reset every symbol to "never archived" and re-archived the whole universe —
// ~9 writes/day/symbol against an intended 6.85, i.e. ~700 surplus rows/day across 76 symbols.
// mergeDerivArchiveGate seeds the gate from D1, the thing actually being gated.
import { describe, it, expect } from 'vitest';
import { mergeDerivArchiveGate } from '../src/index';

// D1 stores derivatives_history.timestamp in SECONDS; the KV blob stores ms.
const SEC = 1_781_273_973;
const MS = SEC * 1000;

describe('mergeDerivArchiveGate', () => {
  it('seeds an EMPTY (evicted) KV map from D1 instead of leaving the gate wide open', () => {
    const kv: Record<string, number> = {};
    mergeDerivArchiveGate(kv, [{ symbol: 'BTCUSDT', ts: SEC }, { symbol: 'ETHUSDT', ts: SEC - 100 }]);
    expect(kv.BTCUSDT).toBe(MS);
    expect(kv.ETHUSDT).toBe((SEC - 100) * 1000);
    // The gate check is `Date.now() - lastArchive > 3.5h`; with the seed present a just-archived
    // symbol is correctly gated instead of being re-archived.
    expect(MS + 3.5 * 3600_000 > MS).toBe(true);
  });

  it('converts seconds → ms (a raw seconds value would read as 1970 and never gate)', () => {
    const kv: Record<string, number> = {};
    mergeDerivArchiveGate(kv, [{ symbol: 'BTCUSDT', ts: SEC }]);
    expect(kv.BTCUSDT).toBeGreaterThan(1_700_000_000_000);   // ms scale, not seconds
    expect(Date.now() - kv.BTCUSDT).toBeLessThan(400 * 86400_000);
  });

  it('keeps the LATER of KV and D1 — a fresher in-memory write is not clobbered', () => {
    const fresher = MS + 60_000;                              // archived this cron, not yet in D1
    const kv: Record<string, number> = { BTCUSDT: fresher };
    mergeDerivArchiveGate(kv, [{ symbol: 'BTCUSDT', ts: SEC }]);
    expect(kv.BTCUSDT).toBe(fresher);
  });

  it('a stale KV entry is advanced by D1 (the eviction-recovery direction)', () => {
    const kv: Record<string, number> = { BTCUSDT: MS - 10 * 3600_000 };
    mergeDerivArchiveGate(kv, [{ symbol: 'BTCUSDT', ts: SEC }]);
    expect(kv.BTCUSDT).toBe(MS);
  });

  it('ignores junk rows and preserves symbols D1 has never seen', () => {
    const kv: Record<string, number> = { NEWUSDT: 123 };
    mergeDerivArchiveGate(kv, [
      { symbol: '', ts: SEC },
      { symbol: 'BADUSDT', ts: NaN },
      { symbol: 'NULLUSDT', ts: null as unknown as number },   // MAX() over an empty group
    ]);
    expect(kv.NEWUSDT).toBe(123);
    expect(kv['']).toBeUndefined();
    expect(kv.BADUSDT).toBeUndefined();
    expect(kv.NULLUSDT).toBeUndefined();
  });
});
