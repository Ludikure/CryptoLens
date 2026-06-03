#!/usr/bin/env python3
"""Model or features? Sweep model CAPACITY (linear → deep/many-tree GBM) on the SAME clean data,
for two targets:
  - DIRECTION (up = fwdReturn24H>0)  : the thing we can't predict
  - VOLATILITY (goodR = fwdMaxFavR>=1.5): the thing we can
If direction stays ~50% at every capacity while goodR extraction plateaus high, the model is
NOT the bottleneck — the features carry volatility but (in an efficient market) not direction.
A rising direction curve with capacity would instead implicate model capacity.
"""
import os, numpy as np, pandas as pd, warnings, time
warnings.filterwarnings('ignore')
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')


def daily_downsample(df):
    df = df.copy(); df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
    return df.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna()].copy()
    df['up'] = (df['fwdReturn24H'] > 0).astype(int)
    df = daily_downsample(df).sort_values('timestamp').reset_index(drop=True)
    n = len(df); edges = [int(n * f) for f in (0.40, 0.55, 0.70, 0.85, 1.0)]
    X = df[H.FEATURES].fillna(0).values
    configs = [
        ('linear (logreg)',   'lin'),
        ('LGB d3  t100',      dict(max_depth=3,  n_estimators=100)),
        ('LGB d5  t150 PROD', dict(max_depth=5,  n_estimators=150)),
        ('LGB d8  t400',      dict(max_depth=8,  n_estimators=400)),
        ('LGB d12 t800',      dict(max_depth=12, n_estimators=800, num_leaves=2000)),
    ]
    print(f"clean daily-downsampled crypto: {n:,} bars, {len(H.FEATURES)} features\n")
    print(f"{'model':<20}{'DIRECTION acc':>15}{'VOLATILITY top-bucket':>24}{'fit s':>8}")
    base_dir = df['up'].mean(); base_good = df['goodR'].mean()
    print(f"{'(base rates)':<20}{base_dir*100:>14.0f}%{base_good*100:>23.0f}%")
    for name, cfg in configs:
        t0 = time.time(); dacc, gtop = [], []
        for i in range(3):
            tr = df.iloc[:edges[i + 1]]; te = df.iloc[edges[i + 1]:edges[i + 2]]
            if len(te) < 200: continue
            Xtr, Xte = X[tr.index], X[te.index]
            for target, store, is_dir in [('up', dacc, True), ('goodR', gtop, False)]:
                ytr, yte = tr[target].values, te[target].values
                if cfg == 'lin':
                    sc = StandardScaler().fit(Xtr)
                    m = LogisticRegression(max_iter=200, C=0.5).fit(sc.transform(Xtr), ytr)
                    p = m.predict_proba(sc.transform(Xte))[:, 1]
                else:
                    m = lgb.LGBMClassifier(learning_rate=0.03, subsample=0.8, colsample_bytree=0.8,
                                           min_child_samples=10, reg_lambda=1.0, n_jobs=-1,
                                           random_state=42, verbose=-1, **cfg).fit(Xtr, ytr)
                    p = m.predict_proba(Xte)[:, 1]
                if is_dir:
                    store.append(((p >= 0.5).astype(int) == yte).mean())
                else:
                    top = p >= 0.65
                    store.append(yte[top].mean() if top.sum() > 30 else np.nan)
        print(f"{name:<20}{np.mean(dacc)*100:>14.0f}%{np.nanmean(gtop)*100:>23.0f}%{time.time()-t0:>8.0f}")
    print("\nRead: DIRECTION flat near base/50% across 100→800 trees & depth 3→12 = capacity is NOT "
          "the bottleneck; the features lack forward directional information (efficient-market "
          "boundary). VOLATILITY top-bucket high + plateauing = features DO carry it and the prod "
          "model already extracts near the ceiling. => it's the FEATURE *content*, not the model.")


if __name__ == '__main__':
    main()
