#!/usr/bin/env python3
"""
One-time fetch: 4H stock OHLC from worker D1 for the setup-execution backtest
period. Saves as ml-training/stock_candles_4h.parquet.

Why D1 and not yfinance? D1 is what the production system uses for backtest
candles (per runBacktest.ts), so the OHLC is identical to the data that
generated the feature CSVs. yfinance would introduce subtle drift from
adjusted prices and provider quirks.

Approach: query per-symbol via `wrangler d1 execute --remote --json` to keep
each response under the 100k-row D1 limit. Sequential, ~2s per symbol,
~5 min total for 159 stocks.
"""
import glob
import json
import os
import subprocess
import sys
import time

import pandas as pd

CSV_DIR = os.path.join(os.path.dirname(__file__), 'csv_exports_v13')
OUT_PATH = os.path.join(os.path.dirname(__file__), 'stock_candles_4h.csv.gz')
WORKER_DIR = os.path.join(os.path.dirname(__file__), '..', 'marketscope-worker')

# Fetch the full WF-CV-relevant window so the 5-fold backtest can resolve
# setups from 2022-01 onward. Earlier bound includes a buffer week before the
# first validation fold's start.
START_MS = 1640000000000   # 2021-12-20 (buffer before 2022-01 fold 1 start)
END_MS = 1780000000000     # 2026-05-29 (past corpus end)


def fetch_symbol(symbol: str) -> list[dict] | None:
    """Run wrangler d1 execute and return list of {timestamp, open, high, low, close}."""
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
        # Wrangler emits JSON; the array is at root. Each element has .results.
        data = json.loads(result.stdout)
        rows = data[0]['results'] if data else []
        return rows
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        print(f"  ✗ {symbol}: parse error: {e}", file=sys.stderr)
        return None


def main():
    symbols = sorted([
        os.path.basename(f).replace('.csv', '')
        for f in glob.glob(os.path.join(CSV_DIR, '*.csv'))
    ])
    print(f"Fetching 4H OHLC for {len(symbols)} stocks via D1...")
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
