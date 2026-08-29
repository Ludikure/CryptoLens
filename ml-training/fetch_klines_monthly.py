#!/usr/bin/env python3
"""Pull 1h OHLC klines from Binance Vision MONTHLY archives.

Monthly rather than daily: ~78 requests per symbol for six years instead of ~2,200. 1h rather than
4h so the path simulator sees 72 observations inside a 72h horizon instead of 18 — stop/target
ordering is resolved far more accurately, which is the whole reason for using OHLC at all.
"""
import io, sys, zipfile, urllib.request, urllib.error
import pandas as pd
from pathlib import Path

BASE = "https://data.binance.vision/data/futures/um/monthly/klines"
OUT = Path('vision_backfill/klines_long'); OUT.mkdir(parents=True, exist_ok=True)
COLS = ['ot','open','high','low','close','volume','ct','qv','n','tb','tq','ig']

SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','BNBUSDT','DOTUSDT',
        'AVAXUSDT','LINKUSDT','LTCUSDT','UNIUSDT','ATOMUSDT','FILUSDT','AAVEUSDT','NEARUSDT',
        'ALGOUSDT','VETUSDT','ICPUSDT','SANDUSDT','MANAUSDT','AXSUSDT','EGLDUSDT','THETAUSDT']

def months(a, b):
    y, m = a
    while (y, m) <= b:
        yield y, m
        m += 1
        if m > 12: y, m = y+1, 1

def fetch(sym, y, m):
    url = f"{BASE}/{sym}/1h/{sym}-1h-{y}-{m:02d}.zip"
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            z = zipfile.ZipFile(io.BytesIO(r.read()))
            with z.open(z.namelist()[0]) as f:
                d = pd.read_csv(f, header=None, names=COLS)
        # some months ship a header row; drop anything non-numeric
        d = d[pd.to_numeric(d['ot'], errors='coerce').notna()]
        d['ts'] = (pd.to_numeric(d['ot']) // 1000).astype('int64')
        return d[['ts','open','high','low','close','volume']].astype(
            {'open':float,'high':float,'low':float,'close':float,'volume':float})
    except urllib.error.HTTPError:
        return None
    except Exception as e:
        print(f'  {sym} {y}-{m:02d}: {e}', flush=True)
        return None

def main():
    for i, sym in enumerate(SYMS, 1):
        out = OUT/f'{sym}.csv'
        if out.exists():
            print(f'[{i}/{len(SYMS)}] {sym} exists, skip', flush=True); continue
        parts = [d for y, m in months((2019,9),(2026,8)) if (d := fetch(sym, y, m)) is not None]
        if not parts:
            print(f'[{i}/{len(SYMS)}] {sym} NO DATA', flush=True); continue
        df = pd.concat(parts).drop_duplicates('ts').sort_values('ts').reset_index(drop=True)
        df.to_csv(out, index=False)
        t = pd.to_datetime(df.ts, unit='s', utc=True)
        print(f'[{i}/{len(SYMS)}] {sym}: {len(df):,} bars {t.min():%Y-%m} -> {t.max():%Y-%m}', flush=True)

if __name__ == '__main__':
    main()
