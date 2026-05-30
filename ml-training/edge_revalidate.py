#!/usr/bin/env python3
"""
RE-VALIDATION: reproduce every leakage-derived edge number quoted in
AnalysisPrompt.swift / CLAUDE.md / the worker, but with a leakage-FREE
multi-regime walk-forward.

The bug in the old scripts (direction_primitive_sweep, setup_execution_*,
notification_compare): they split a pooled multi-symbol frame by ROW INDEX
and purge 48 ROWS. With N correlated symbols sharing each wall-clock bar, 48
rows ≈ zero time, so train/test overlap in time → cross-symbol leakage.

This script keeps the SAME 5 expanding folds and the SAME model, but:
  * splits by TIMESTAMP quantile (not row index)
  * embargoes by TIME (14 days), not rows
Folds cover time-fraction [0.25 .. 1.00] so fold 1 lands on the 2022 bear —
preserving multi-regime coverage that the single forward split lacks.

Two gate modes (matching the two production paths):
  A. rising-edge through 0.70   (notification path)
  B. continuous ML >= 0.65      (setup-construction path)

Reports per primitive (bias / dStoch / union), with LONG/SHORT split, plus a
per-fold regime breakdown. Band fixed to production 1.0/1.5, SL-first tie-break.

Run:  python3 edge_revalidate.py
"""
import numpy as np, pandas as pd

ev = __import__('edge_validation')
FEATURES, load_features, build_candle_index = ev.FEATURES, ev.load_features, ev.build_candle_index
make_model, resolve_fill = ev.make_model, ev.resolve_fill

EMBARGO = 14 * 86400
SL_ATR, TP_ATR, HORIZON = 1.0, 1.5, 6
RISING, CONT = 0.70, 0.65
TOP10 = {'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','TRXUSDT'}


def wf_clean(df):
    """5 expanding folds, timestamp-split + 14d time embargo. Returns concat val
    frame with mlProb + fold id."""
    t = df['timestamp'].values
    t_lo, t_hi = t.min(), t.max()
    span = t_hi - t_lo
    out = []
    for i in range(5):
        val_lo_t = t_lo + span * (0.25 + i * 0.15)
        val_hi_t = t_lo + span * (0.25 + (i + 1) * 0.15) if i < 4 else t_hi + 1
        train = df[df['timestamp'] < val_lo_t - EMBARGO]
        val = df[(df['timestamp'] >= val_lo_t) & (df['timestamp'] < val_hi_t)].copy()
        if len(train) < 5000 or len(val) < 200:
            continue
        m = make_model()
        m.fit(train[FEATURES].fillna(0), train['goodR'])
        val['mlProb'] = m.predict_proba(val[FEATURES].fillna(0))[:, 1]
        val['fold'] = i + 1
        out.append(val)
    return pd.concat(out, ignore_index=True)


def dir_bias(r):
    a = r['biasAlignment']; return 1 if a == 'aligned_bullish' else (-1 if a == 'aligned_bearish' else 0)

def dir_dstoch(r):
    s = r['dStochCross']; return 1 if s == 1 else (-1 if s == -1 else 0)

def dir_union(r):
    b, s = dir_bias(r), dir_dstoch(r)
    if b != 0 and s != 0 and b != s: return 0
    return b if b != 0 else s


def resolve(rows, idx, dir_fn):
    out = []
    for _, r in rows.iterrows():
        d = dir_fn(r)
        if d == 0: continue
        sym = r['symbol']
        if sym not in idx: continue
        ap = r['atrPercent']
        if ap <= 0: continue
        entry = r['price']; atrp = entry * ap / 100.0
        if d == 1: sl, tp = entry - atrp*SL_ATR, entry + atrp*TP_ATR
        else: sl, tp = entry + atrp*SL_ATR, entry - atrp*TP_ATR
        c = idx[sym]; i = np.searchsorted(c['ts'], r['ts_ms'], side='right')
        if i >= len(c['ts']): continue
        block = {k: c[k][i:i+HORIZON] for k in ('open','high','low','close')}
        if len(block['high']) == 0: continue
        res = resolve_fill(d, entry, sl, tp, block, SL_ATR, TP_ATR)
        if res is None: continue
        out.append({'symbol': sym, 'fold': r['fold'], 'direction': d, 'R': res,
                    'timestamp': r['timestamp']})
    return pd.DataFrame(out)


def line(name, df):
    if len(df) == 0: print(f"    {name:<30} n=0"); return None
    n, win, evr, cum = len(df), (df['R']>0).mean()*100, df['R'].mean(), df['R'].sum()
    nl, ns = int((df['direction']==1).sum()), int((df['direction']==-1).sum())
    print(f"    {name:<30} n={n:>5,}  L={nl:>4}/S={ns:>4}  win={win:>4.1f}%  EV={evr:>+6.3f}R  totR={cum:>+8.1f}")
    return cum


def gate_block(title, rising, idx):
    print(f"\n  --- {title} ---")
    cb = line('bias-aligned', resolve(rising, idx, dir_bias))
    cd = line('dStochCross',  resolve(rising, idx, dir_dstoch))
    cu = line('union (bias OR dStoch)', resolve(rising, idx, dir_union))
    if cb and cb != 0:
        print(f"    union/bias total-R multiple: {cu/cb:.1f}x")


def run(label, csv_dir, candles, sym=None):
    print(f"\n{'='*92}\n{label}\n{'='*92}")
    df = load_features(csv_dir, sym)
    idx = build_candle_index(candles, sym)
    print(f"  bars {len(df):,} | symbols {df['symbol'].nunique()}")
    val = wf_clean(df)
    val = val.sort_values(['symbol','timestamp']).reset_index(drop=True)
    val['prevMl'] = val.groupby('symbol')['mlProb'].shift(1)
    # date labels per fold
    fold_dates = {f: (pd.to_datetime(g['timestamp'].min(),unit='s').date(),
                      pd.to_datetime(g['timestamp'].max(),unit='s').date())
                  for f,g in val.groupby('fold')}
    print(f"  fold windows: " + " | ".join(f"f{f}:{d[0]}→{d[1]}" for f,d in fold_dates.items()))

    rising = val[(val['prevMl'] < RISING) & (val['mlProb'] >= RISING)].copy()
    cont = val[val['mlProb'] >= CONT].copy()
    gate_block(f"GATE A: rising-edge ↑{RISING} (notification path)", rising, idx)
    gate_block(f"GATE B: continuous ML≥{CONT} (setup path)", cont, idx)

    # Per-fold regime breakdown on dStoch / rising-edge
    print(f"\n  Per-fold (regime) — dStoch, rising-edge ↑0.70:")
    res = resolve(rising, idx, dir_dstoch)
    for f in sorted(fold_dates):
        g = res[res['fold'] == f]
        d = fold_dates[f]
        if len(g) == 0: print(f"    f{f} {d[0]}→{d[1]}: n=0"); continue
        gl, gs = g[g['direction']==1], g[g['direction']==-1]
        print(f"    f{f} {d[0]}→{d[1]}: n={len(g):>4} EV={g['R'].mean():>+6.3f}R | "
              f"LONG n={len(gl):>4} EV={gl['R'].mean() if len(gl) else 0:>+6.3f} | "
              f"SHORT n={len(gs):>4} EV={gs['R'].mean() if len(gs) else 0:>+6.3f}")


def main():
    run("STOCKS (159)", 'csv_exports_v13', 'stock_candles_4h.csv.gz')
    run("CRYPTO TOP-10", 'csv_exports_v11', 'crypto_candles_4h.csv.gz', sym=TOP10)
    run("CRYPTO ALL (77)", 'csv_exports_v11', 'crypto_candles_4h.csv.gz')


if __name__ == '__main__':
    main()
