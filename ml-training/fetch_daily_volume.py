#!/usr/bin/env python3
"""
Fetch daily OHLCV (WITH volume) for the archive's crypto + stock symbols → two gz files,
so the volume-at-level study has the raw volume the 4H archive dropped.

Crypto: Binance spot daily klines (paginated). Stocks: Yahoo daily chart (10y range).
Symbols taken from the existing 4H archives. Failures skipped. Gitignored output.

Run:  python3 fetch_daily_volume.py
"""
import gzip
import io
import json
import time
import urllib.request
import urllib.error
import pandas as pd

UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}


def get(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def binance_daily(symbol, start_ms=1577836800000):
    """Paginated daily klines from start (Jan 2020) to now. volume = field 5."""
    rows = []
    cur = start_ms
    while True:
        url = (f"https://api.binance.com/api/v3/klines?symbol={symbol}"
               f"&interval=1d&startTime={cur}&limit=1000")
        try:
            data = json.loads(get(url))
        except Exception as e:
            print(f"  {symbol} binance err {e}"); break
        if not data:
            break
        for k in data:
            rows.append((symbol, int(k[0]), float(k[1]), float(k[2]), float(k[3]),
                         float(k[4]), float(k[5])))
        if len(data) < 1000:
            break
        cur = data[-1][0] + 86400000
        time.sleep(0.25)
    return rows


def yahoo_daily(symbol):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?interval=1d&range=10y")
    try:
        j = json.loads(get(url, headers=UA))
        res = j['chart']['result'][0]
        ts = res['timestamp']
        q = res['indicators']['quote'][0]
        rows = []
        for i, t in enumerate(ts):
            o, h, l, c, v = q['open'][i], q['high'][i], q['low'][i], q['close'][i], q['volume'][i]
            if None in (o, h, l, c, v):
                continue
            rows.append((symbol, int(t) * 1000, float(o), float(h), float(l), float(c), float(v)))
        return rows
    except Exception as e:
        print(f"  {symbol} yahoo err {e}"); return []


def save(rows, path):
    df = pd.DataFrame(rows, columns=['symbol', 'timestamp', 'open', 'high', 'low', 'close', 'volume'])
    with gzip.open(path, 'wt') as f:
        df.to_csv(f, index=False)
    print(f"  wrote {path}: {len(df):,} rows, {df['symbol'].nunique()} symbols")


def main():
    cr = sorted(pd.read_csv('crypto_candles_4h.csv.gz', usecols=['symbol'])['symbol'].unique())
    st = sorted(pd.read_csv('stock_candles_4h.csv.gz', usecols=['symbol'])['symbol'].unique())

    print(f"crypto: {len(cr)} symbols (Binance daily)")
    crows = []
    for i, s in enumerate(cr):
        r = binance_daily(s)
        crows += r
        if (i + 1) % 10 == 0:
            print(f"  ...{i+1}/{len(cr)} ({len(crows):,} rows)")
        time.sleep(0.3)
    save(crows, 'daily_candles_crypto.csv.gz')

    print(f"stock: {len(st)} symbols (Yahoo daily)")
    srows = []
    for i, s in enumerate(st):
        srows += yahoo_daily(s)
        if (i + 1) % 20 == 0:
            print(f"  ...{i+1}/{len(st)} ({len(srows):,} rows)")
        time.sleep(0.6)
    save(srows, 'daily_candles_stock.csv.gz')


if __name__ == '__main__':
    main()
