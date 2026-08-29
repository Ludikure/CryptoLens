#!/usr/bin/env python3
"""H1 — is a LONGER-horizon move more predictable than a 24h one?
Design frozen in docs/research/five-hypotheses.md. Production config, inherited not tuned.
Also emits out-of-fold predictions for the 24h control, which H4 consumes.
"""
import numpy as np, pandas as pd, lightgbm as lgb, pickle
from pathlib import Path
from sklearn.metrics import roc_auc_score

BARS = {'24h': 6, '7d': 42, '30d': 180}          # v14 rows are 4H bars
K = {'24h': 1.5, '7d': 1.5*np.sqrt(7), '30d': 1.5*np.sqrt(30)}
DROP_PREFIX = ('fwd',)
DROP = {'symbol','timestamp','price','regime','emaRegime'}


def build():
    frames = []
    for f in sorted(Path('csv_exports_v14').glob('*.csv')):
        d = pd.read_csv(f, low_memory=False)
        if len(d) < 400 or 'atrPercent' not in d: continue
        d = d.sort_values('timestamp').reset_index(drop=True)
        atr = (d['atrPercent'] / 100.0 * d['price']).replace(0, np.nan)
        for name, n in BARS.items():
            # direction-agnostic max favorable excursion over the next n bars, from closes
            fwd_max = d['price'][::-1].rolling(n, min_periods=1).max()[::-1].shift(-1)
            fwd_min = d['price'][::-1].rolling(n, min_periods=1).min()[::-1].shift(-1)
            fav = np.maximum(fwd_max - d['price'], d['price'] - fwd_min) / atr
            d[f'y_{name}'] = (fav >= K[name]).astype(float)
            d.loc[fav.isna(), f'y_{name}'] = np.nan
        d['sym'] = f.stem
        frames.append(d)
    a = pd.concat(frames, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    feats = [c for c in a.columns
             if c not in DROP and c != 'sym' and not c.startswith(DROP_PREFIX)
             and not c.startswith('y_') and pd.api.types.is_numeric_dtype(a[c])]
    return a, feats


def walk(a, feats, target, purge=48, save_oof=None):
    d = a.dropna(subset=[target]).reset_index(drop=True)
    n = len(d); aucs = []; oof = {}
    for i in range(3):
        tr_end = int(n * (0.4 + 0.2 * i))
        te_end = int(n * (0.6 + 0.2 * i))
        tr = d.iloc[:max(0, tr_end - purge)]
        te = d.iloc[tr_end:te_end]
        if len(tr) < 5000 or len(te) < 1000: continue
        m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.05,
                               num_leaves=15, verbose=-1, n_jobs=-1)
        m.fit(tr[feats], tr[target])
        p = m.predict_proba(te[feats])[:, 1]
        aucs.append(roc_auc_score(te[target], p))
        if save_oof is not None:
            oof.update({idx: v for idx, v in zip(te.index, p)})
    if save_oof is not None and oof:
        s = pd.Series(oof)
        out = d.loc[s.index, ['sym', 'timestamp', 'price', 'atrPercent']].copy()
        out['p'] = s.values
        out.to_csv(save_oof, index=False)
    return aucs


def main():
    a, feats = build()
    print(f'{len(a):,} bars, {len(feats)} features, {a.sym.nunique()} symbols\n')
    print(f"{'horizon':<9}{'threshold':>11}{'base rate':>11}   folds                    mean")
    res = {}
    for name in BARS:
        t = f'y_{name}'
        base = a[t].mean()
        oof = 'oof_24h.csv' if name == '24h' else None
        aucs = walk(a, feats, t, save_oof=oof)
        res[name] = aucs
        fs = '  '.join(f'{x:.3f}' for x in aucs)
        print(f"{name:<9}{K[name]:>10.2f}A{base*100:>10.1f}%   {fs:<25}{np.mean(aucs):.4f}")
    ctrl = res['24h']
    print('\n--- SHIP BAR: >+0.02 vs the 24h control in ALL folds ---')
    for name in ('7d', '30d'):
        d = [x - c for x, c in zip(res[name], ctrl)]
        ok = all(x > 0.02 for x in d)
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: deltas {'  '.join(f'{x:+.4f}' for x in d)}")


if __name__ == '__main__':
    main()
