#!/usr/bin/env python3
"""Dump stock hourly klines out of the box's D1 snapshot, in the crypto backfill's shape.

The stock intraday paths were the missing half of four envelope conditions. They were never missing
from the DATA -- they have been sitting in the candle archive since 2019-01-07, deeper than the
crypto set. What was missing was a reason to look locally: `/history` over the tunnel for 159 x 13k
rows framed this as an expensive pull, and it is not one.

Output matches vision_backfill/klines_long/*.csv exactly (ts,open,high,low,close,volume; ts in
SECONDS) so every downstream script works by swapping one path constant.

NOTE the snapshot is the 2026-06-12 migration copy, so stock coverage ends ~7 weeks before the
crypto set's 2026-07-31. Periods are counted per-window, so a shorter tail costs at most the final
half-year window, not the comparison.
"""
import os, sqlite3
import pandas as pd

DB  = '../marketscope-worker/marketscope.db'
OUT = 'stock_klines'
MIN_BARS = 5000

os.makedirs(OUT, exist_ok=True)
con = sqlite3.connect(DB)

syms = [r[0] for r in con.execute(
    "SELECT symbol FROM candles WHERE interval='1h' AND symbol NOT LIKE '%USDT' "
    f"GROUP BY symbol HAVING COUNT(*)>={MIN_BARS} ORDER BY symbol")]
print(f'{len(syms)} stock symbols with >={MIN_BARS} hourly bars')

total = 0
for s in syms:
    d = pd.read_sql(
        "SELECT timestamp/1000 AS ts, open, high, low, close, volume FROM candles "
        "WHERE symbol=? AND interval='1h' ORDER BY timestamp", con, params=(s,))
    # Same-timestamp duplicates would corrupt the searchsorted join downstream.
    d = d.drop_duplicates('ts').sort_values('ts')
    d = d[(d.high >= d.low) & (d.close > 0) & (d.open > 0)]
    d.to_csv(f'{OUT}/{s}.csv', index=False)
    total += len(d)

print(f'wrote {total:,} bars across {len(syms)} symbols to {OUT}/')
