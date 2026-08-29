#!/usr/bin/env python3
"""
User's hypothesis: "in a bearish trend, more trades are short than long, so direction isn't a coin flip."
This is TIME-SERIES MOMENTUM. Test it directly + cleanly on the leak-fixed data:

  When the trend is clearly UP, does price go UP over the next H hours >50% of the time? (and vice-versa)
  i.e. if you always trade WITH the established trend, what's your forward directional hit rate & EV?

Trend definitions tested (strongest → simplest):
  STACK   : daily EMA20>50>200 = up, 20<50<200 = down   (unambiguous stacked trend)
  200EMA  : price above/below daily EMA200
  BIAS    : the app's biasAlignment (aligned_bullish/bearish)
Horizons: 24h / 48h / 72h forward return. Also broken out by year (is it just the 2021 bull?).
The trap to watch for: a downtrend is a slow accumulation of tiny drift; each forward bar can STILL
be ~50/50 (random walk with drift). "Trend is down" != "next bar is predictably down."
"""
import glob, os, numpy as np, pandas as pd

def load_all():
    frames = []
    for f in glob.glob('csv_exports_v11_fixed/*.csv'):
        try:
            d = pd.read_csv(f, usecols=lambda c: c in {
                'timestamp','symbol','dStackBull','dStackBear','biasAlignment','fwdReturn24H','fwdReturn48H','fwdReturn72H','dAdx'})
            d['symbol'] = os.path.basename(f).replace('.csv','')
            frames.append(d)
        except Exception:
            pass
    return pd.concat(frames, ignore_index=True)

def hit(df, trend_up, trend_dn, ret_col, adx_min=0):
    """Directional hit-rate + mean forward return trading WITH the trend."""
    m = df[ret_col].notna()
    if adx_min: m &= (df['dAdx'] >= adx_min)
    up = df[m & trend_up]; dn = df[m & trend_dn]
    n = len(up) + len(dn)
    if n < 500: return None
    # hit = forward move in the trade direction is positive
    up_hit = (up[ret_col] > 0).mean(); dn_hit = (dn[ret_col] < 0).mean()
    hit_rate = (( up[ret_col] > 0).sum() + (dn[ret_col] < 0).sum()) / n * 100
    # EV of trading with trend: long in uptrend (+ret), short in downtrend (-ret)
    ev = (up[ret_col].sum() - dn[ret_col].sum()) / n   # fwdReturn already in %, do NOT *100
    return dict(n=n, hit=hit_rate, up_hit=up_hit*100, dn_hit=dn_hit*100, ev=ev)

def main():
    df = load_all()
    df['year'] = pd.to_datetime(df['timestamp'], unit='s').dt.year
    print(f"loaded {len(df):,} bars, {df['symbol'].nunique()} symbols, {df['year'].min()}–{df['year'].max()}")
    print("(coin flip = 50.0% hit, 0.00% EV)\n")

    defs = {
        'STACK (EMA20>50>200)': (df['dStackBull'] == 1, df['dStackBear'] == 1),
        'BIAS (app alignment)': (df['biasAlignment'] == 'aligned_bullish', df['biasAlignment'] == 'aligned_bearish'),
    }
    for name, (tu, td) in defs.items():
        print(f"── trend def: {name} ──")
        for rc in ['fwdReturn24H','fwdReturn48H','fwdReturn72H']:
            r = hit(df, tu, td, rc)
            if r: print(f"   {rc:>14}: hit {r['hit']:5.1f}%  (up-trend {r['up_hit']:4.1f}% / down-trend {r['dn_hit']:4.1f}%)  EV {r['ev']:+.3f}%/bar  n={r['n']:,}")
        # strong-trend only (ADX>=30)
        r = hit(df, tu, td, 'fwdReturn24H', adx_min=30)
        if r: print(f"   {'24H|ADX>=30':>14}: hit {r['hit']:5.1f}%  EV {r['ev']:+.3f}%/bar  n={r['n']:,}")
        print()

    print("── by year (STACK trend, 24H) — is any edge just the 2021 bull? ──")
    for y, g in df.groupby('year'):
        r = hit(g, g['dStackBull'] == 1, g['dStackBear'] == 1, 'fwdReturn24H')
        if r: print(f"   {y}: hit {r['hit']:5.1f}%  EV {r['ev']:+.3f}%/bar  n={r['n']:,}")

if __name__ == '__main__':
    main()
