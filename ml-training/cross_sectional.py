#!/usr/bin/env python3
"""Cross-sectional question: at each moment, can we RANK the symbols by what's coming —
relative to each other — where the per-symbol ABSOLUTE model couldn't?
Two targets, both ATR-normalized so it's vol-EXPANSION not "which coin is structurally wild":
  - VOL rank:    max(fwdMaxUp24H, fwdMaxDown24H)  [direction-agnostic magnitude]
  - RETURN rank: fwdReturn24H / atr               [cross-sectional momentum / relative strength]
Metric: per-day Spearman rank IC (pred vs realized) + t-stat across days, and the tradeable
top-quintile vs bottom-quintile realized spread. Within-day shuffle = null. Clean WF.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
from scipy.stats import spearmanr
import lightgbm as lgb
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
MIN_SYMS = 20


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdMaxUp24H'].notna() & df['fwdMaxDown24H'].notna() & df['fwdReturn24H'].notna() & (df['atrPercent'] > 0)].copy()
    df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
    df = df.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)
    df['volT'] = np.maximum(df['fwdMaxUp24H'], df['fwdMaxDown24H'])         # ATR units
    df['retT'] = df['fwdReturn24H'] / (df['atrPercent'] / 100)             # ATR-normalized return
    df = df.sort_values('timestamp').reset_index(drop=True)
    # day index for cross-sections
    df['di'] = pd.factorize(df['date'])[0]
    ndays = df['di'].max() + 1
    X = df[H.FEATURES].fillna(0).values
    print(f"clean daily cross-sections: {len(df):,} rows, {ndays} days, "
          f"{df.groupby('di').size().median():.0f} symbols/day median\n")

    def mdl():
        return lgb.LGBMRegressor(max_depth=4, n_estimators=150, learning_rate=0.03, subsample=0.8,
                                 colsample_bytree=0.8, min_child_samples=20, reg_lambda=1.0,
                                 n_jobs=-1, random_state=42, verbose=-1)

    edges = [int(ndays * f) for f in (0.40, 0.55, 0.70, 0.85, 1.0)]
    res = {'vol': {'ic': [], 'topq': [], 'botq': []}, 'ret': {'ic': [], 'topq': [], 'botq': []},
           'volnull': [], 'retnull': []}
    rng = np.random.RandomState(0)
    for i in range(3):
        trm = df['di'] < edges[i + 1]; tem = (df['di'] >= edges[i + 1]) & (df['di'] < edges[i + 2])
        if tem.sum() < 1000: continue
        tr, te = df[trm], df[tem]
        mv = mdl().fit(X[tr.index], tr['volT']); mr = mdl().fit(X[tr.index], tr['retT'])
        pv = mv.predict(X[te.index]); pr = mr.predict(X[te.index])
        te = te.copy(); te['pv'] = pv; te['pr'] = pr
        for di, gd in te.groupby('di'):
            if len(gd) < MIN_SYMS: continue
            res['vol']['ic'].append(spearmanr(gd['pv'], gd['volT']).correlation)
            res['ret']['ic'].append(spearmanr(gd['pr'], gd['retT']).correlation)
            res['volnull'].append(spearmanr(rng.permutation(gd['pv'].values), gd['volT']).correlation)
            res['retnull'].append(spearmanr(rng.permutation(gd['pr'].values), gd['retT']).correlation)
            k = max(1, len(gd) // 5)
            vs = gd.sort_values('pv'); res['vol']['botq'].append(vs['volT'].iloc[:k].mean()); res['vol']['topq'].append(vs['volT'].iloc[-k:].mean())
            rs = gd.sort_values('pr'); res['ret']['botq'].append(rs['retT'].iloc[:k].mean()); res['ret']['topq'].append(rs['retT'].iloc[-k:].mean())

    def tstat(a):
        a = np.array([x for x in a if np.isfinite(x)]); return a.mean(), a.mean() / a.std() * np.sqrt(len(a))
    print(f"{'ranking':<26}{'mean rankIC':>12}{'t-stat':>9}{'top-Q real':>12}{'bot-Q real':>12}{'spread':>10}")
    for key, lab, unit in [('vol', 'VOLATILITY (|move| ATR)', 'ATR'), ('ret', 'RETURN (relative strength)', 'ATR')]:
        ic, t = tstat(res[key]['ic']); tq, bq = np.mean(res[key]['topq']), np.mean(res[key]['botq'])
        print(f"{lab:<26}{ic:>+12.3f}{t:>9.1f}{tq:>+10.2f}{unit:<2}{bq:>+10.2f}{unit:<2}{tq-bq:>+9.2f}")
    nv, _ = tstat(res['volnull']); nr, _ = tstat(res['retnull'])
    print(f"{'shuffle null (both)':<26}{(nv+nr)/2:>+12.3f}{'~0':>9}")
    print("\nRead: VOL rankIC >> 0 with high t-stat + top-Q realizes more |move| than bot-Q => forward "
          "vol is cross-sectionally RANKABLE (pick the top basket each day for the convex strategy). "
          "RETURN rankIC ~0 => cross-sectional direction/momentum is still random (consistent with the "
          "per-symbol finding). RETURN rankIC > 0 would be a genuine relative-strength edge worth a look.")


if __name__ == '__main__':
    main()
