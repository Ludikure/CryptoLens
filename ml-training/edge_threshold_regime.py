#!/usr/bin/env python3
"""
On the clean forward split (timestamp-based, embargoed), quantify two more levers:
  1. ML rising-edge threshold sweep {0.65, 0.70, 0.75, 0.80} x band — does a higher
     gate raise EV/trade enough to justify fewer trades?
  2. Per-quarter EV breakdown — how much of the crypto edge is bull-regime beta vs
     a persistent edge? (test window spans 2024Q4..2026Q2)

Direction primitive fixed to dStochCross (the validated winner). Conservative
SL-first tie-break. Reuses the load/resolve machinery from edge_validation.py.
"""
import glob, os
import numpy as np, pandas as pd, xgboost as xgb

EMBARGO_DAYS = 14
TRAIN_FRAC = 0.70
HORIZON_BARS = 6
TOP = None
THRESHOLDS = [0.65, 0.70, 0.75, 0.80]
BANDS = [(1.0, 1.5), (1.0, 2.5), (1.5, 3.0)]

FEATURES = __import__('edge_validation').FEATURES
load_features = __import__('edge_validation').load_features
build_candle_index = __import__('edge_validation').build_candle_index
make_model = __import__('edge_validation').make_model
resolve_fill = __import__('edge_validation').resolve_fill


def forward_test(df):
    t_lo, t_hi = df['timestamp'].min(), df['timestamp'].max()
    split_t = t_lo + (t_hi - t_lo) * TRAIN_FRAC
    train = df[df['timestamp'] < split_t]
    test = df[df['timestamp'] >= split_t + EMBARGO_DAYS*86400].copy()
    m = make_model()
    m.fit(train[FEATURES].fillna(0), train['goodR'])
    test['mlProb'] = m.predict_proba(test[FEATURES].fillna(0))[:, 1]
    return test


def dstoch(row):
    s = row['dStochCross']
    return 1 if s == 1 else (-1 if s == -1 else 0)


def resolve(rising, idx, sl_atr, tp_atr):
    rows = []
    for _, row in rising.iterrows():
        d = dstoch(row)
        if d == 0: continue
        sym = row['symbol']
        if sym not in idx: continue
        ap = row['atrPercent']
        if ap <= 0: continue
        entry = row['price']; atrp = entry*ap/100.0
        if d == 1: sl, tp = entry-atrp*sl_atr, entry+atrp*tp_atr
        else: sl, tp = entry+atrp*sl_atr, entry-atrp*tp_atr
        c = idx[sym]; i = np.searchsorted(c['ts'], row['ts_ms'], side='right')
        if i >= len(c['ts']): continue
        block = {k: c[k][i:i+HORIZON_BARS] for k in ('open','high','low','close')}
        if len(block['high']) == 0: continue
        r = resolve_fill(d, entry, sl, tp, block, sl_atr, tp_atr)
        if r is None: continue
        rows.append({'symbol': sym, 'R': r, 'timestamp': row['timestamp']})
    return pd.DataFrame(rows)


def run(label, csv_dir, candles, sym=None):
    print(f"\n{'='*86}\n{label}\n{'='*86}")
    df = load_features(csv_dir, sym)
    idx = build_candle_index(candles, sym)
    test = forward_test(df)
    test = test.sort_values(['symbol','timestamp']).reset_index(drop=True)
    test['prevMl'] = test.groupby('symbol')['mlProb'].shift(1)

    print(f"\n  Threshold x band sweep (dStoch, clean OOS):")
    print(f"  {'thresh':>7} {'band':>9} {'n':>6} {'win%':>6} {'EV(R)':>8} {'totalR':>9}")
    print("  " + "-"*52)
    for th in THRESHOLDS:
        rising = test[(test['prevMl'] < th) & (test['mlProb'] >= th)].copy()
        for sl_atr, tp_atr in BANDS:
            res = resolve(rising, idx, sl_atr, tp_atr)
            if len(res) == 0:
                print(f"  {th:>7.2f} {f'{sl_atr}/{tp_atr}':>9} n=0"); continue
            print(f"  {th:>7.2f} {f'{sl_atr}/{tp_atr}':>9} {len(res):>6,} "
                  f"{(res['R']>0).mean()*100:>5.1f}% {res['R'].mean():>+7.3f} {res['R'].sum():>+8.1f}")

    # Per-quarter EV at production-ish gate (0.70, band 1.0/2.5) — regime check
    rising = test[(test['prevMl'] < 0.70) & (test['mlProb'] >= 0.70)].copy()
    res = resolve(rising, idx, 1.0, 2.5)
    if len(res):
        res['q'] = pd.to_datetime(res['timestamp'], unit='s').dt.to_period('Q').astype(str)
        print(f"\n  Per-quarter EV @ thresh0.70 band1.0/2.5 (regime check):")
        print(f"  {'quarter':>9} {'n':>5} {'win%':>6} {'EV(R)':>8}")
        for q, g in res.groupby('q'):
            print(f"  {q:>9} {len(g):>5} {(g['R']>0).mean()*100:>5.1f}% {g['R'].mean():>+7.3f}")


def main():
    run("STOCKS (159)", 'csv_exports_v13', 'stock_candles_4h.csv.gz')
    run("CRYPTO ALL (77)", 'csv_exports_v11', 'crypto_candles_4h.csv.gz')


if __name__ == '__main__':
    main()
