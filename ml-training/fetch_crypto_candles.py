#!/usr/bin/env python3
"""
One-time fetch: 4H crypto OHLC from worker D1 for the setup-execution backtest.
Crypto-mirror of fetch_stock_candles.py. Source symbols from csv_exports_v11/.

Output: ml-training/crypto_candles_4h.csv.gz (gitignored).
"""
import glob
import json
import os
import subprocess
import sys
import time

import pandas as pd

CSV_DIR = os.path.join(os.path.dirname(__file__), 'csv_exports_v11')
OUT_PATH = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')
WORKER_DIR = os.path.join(os.path.dirname(__file__), '..', 'marketscope-worker')

# Same window as the stock fetch — covers 5-fold WF starting 2022-01.
START_MS = 1640000000000   # 2021-12-20
END_MS = 1780000000000     # 2026-05-29


def fetch_symbol(symbol: str) -> list[dict] | None:
    sql = (
        f"SELECT timestamp, open, high, low, close FROM candles "
        f"WHERE symbol = '{symbol}' AND interval = '4h' "
        f"AND timestamp >= {START_MS} AND timestamp <= {END_MS} "
        f"ORDER BY timestamp ASC"
    )
    try:
        result = subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', 'marketscope-db',
             '--remote', '--json', '--command', sql],
            cwd=WORKER_DIR, capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        print(f"  ✗ {symbol}: timed out", file=sys.stderr)
        return None
    if result.returncode != 0:
        print(f"  ✗ {symbol}: wrangler failed: {result.stderr[:200]}", file=sys.stderr)
        return None
    try:
        data = json.loads(result.stdout)
        return data[0]['results'] if data else []
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        print(f"  ✗ {symbol}: parse error: {e}", file=sys.stderr)
        return None


def main():
    symbols = sorted([
        os.path.basename(f).replace('.csv', '')
        for f in glob.glob(os.path.join(CSV_DIR, '*.csv'))
    ])
    print(f"Fetching 4H OHLC for {len(symbols)} crypto symbols via D1...")
    print(f"  range: {pd.Timestamp(START_MS, unit='ms')} → {pd.Timestamp(END_MS, unit='ms')}")

    all_rows = []
    t0 = time.time()
    for i, sym in enumerate(symbols, 1):
        rows = fetch_symbol(sym)
        if not rows:
            continue
        for r in rows:
            r['symbol'] = sym
        all_rows.extend(rows)
        if i % 10 == 0 or i == len(symbols):
            elapsed = time.time() - t0
            rate = i / elapsed
            eta = (len(symbols) - i) / rate
            print(f"  {i:>3}/{len(symbols)}  last: {sym}  rows so far: {len(all_rows):,}  "
                  f"({elapsed:.0f}s elapsed, ~{eta:.0f}s remaining)")

    if not all_rows:
        sys.exit("No rows fetched — check wrangler auth and D1 access.")

    df = pd.DataFrame(all_rows)
    df = df[['symbol', 'timestamp', 'open', 'high', 'low', 'close']]
    df = df.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    df.to_csv(OUT_PATH, index=False, compression='gzip')
    print(f"\n✓ wrote {OUT_PATH}")
    print(f"  total rows: {len(df):,}  | symbols: {df['symbol'].nunique()}")


if __name__ == '__main__':
    main()
