#!/usr/bin/env python3
"""Can anything predict the NET PAYOFF of a trade, rather than whether price moved? (2026-08-26)

Every model in this project targets `goodR` — did price move >= 1.5 ATR favourably, ignoring
ordering. That is a VOLATILITY question. The thing that decides money is different: did the target
arrive BEFORE the stop, net of fees, on the side actually taken. Nothing has ever been fitted to it.

PRE-DECLARED, before running:
  target   sign(oppR) per SIDE — profitable vs not, at the app's geometry, after fees
  features the shipped 110, read from the model JSON so they cannot drift
  folds    3 expanding walk-forward windows, 48-bar purge — the production convention
  BAR      out-of-sample AUC >= 0.55 in ALL THREE folds, per side. This is the same bar the
           project applies to any challenger model.

  If AUC sits at ~0.50, the answer is that payoff is not predictable from these features and the
  question is CLOSED — which is a result, not a failure.

  If it clears, the top features must ALSO be stable across folds before anything is built on it.
  An unstable importance ranking at AUC 0.56 is noise that happened to sort.
"""
import glob, json, os
import numpy as np, pandas as pd, lightgbm as lgb
from sklearn.metrics import roc_auc_score

FEATS = json.load(open('../marketscope-worker/src/ml-model-crypto.json'))['features']
PURGE, N_FOLDS, BAR = 48, 3, 0.55


def folds(n):
    for i in range(N_FOLDS):
        te = int(n * (0.4 + i * 0.15)); vs = te + PURGE
        ve = int(n * (0.55 + i * 0.15)) if i < N_FOLDS - 1 else n
        if vs < ve: yield i, te, vs, ve


def main():
    rows = pd.read_pickle('level_entry_rows.pkl.gz')
    env = pd.concat([pd.read_csv(f) for f in glob.glob('envelope_exports_ml/*.csv')],
                    ignore_index=True)[['symbol', 'timestamp', 'alignedDirection']]
    fe = pd.concat([pd.read_csv(f, low_memory=False).assign(symbol=os.path.basename(f)[:-4])
                    for f in sorted(glob.glob('csv_exports_v14/*.csv'))], ignore_index=True)
    d = rows.merge(env, on=['symbol', 'timestamp']).merge(fe, on=['symbol', 'timestamp'],
                                                          suffixes=('', '_f'))
    d = d.sort_values('timestamp').reset_index(drop=True)
    print(f'{len(d):,} rows, {len(FEATS)} features\n')

    for side in ('LONG', 'SHORT'):
        sub = d[d.alignedDirection == side].reset_index(drop=True)
        col = f'd0.0_{side}_oppR'
        sub = sub[np.isfinite(sub[col])].reset_index(drop=True)
        y = (sub[col] > 0).astype(int).to_numpy()
        X = sub[FEATS].fillna(0)
        print(f'=== {side}  n={len(sub):,}  profitable share {y.mean():.3f} ===')
        aucs, imps = [], []
        for i, te, vs, ve in folds(len(sub)):
            m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.03,
                                   num_leaves=15, verbose=-1, n_jobs=-1)
            m.fit(X.iloc[:te], y[:te])
            p = m.predict_proba(X.iloc[vs:ve])[:, 1]
            a = roc_auc_score(y[vs:ve], p) if len(set(y[vs:ve])) > 1 else float('nan')
            aucs.append(a)
            imps.append(pd.Series(m.feature_importances_, index=FEATS))
            print(f'  fold {i}: train {te:,}  val {ve-vs:,}  AUC {a:.4f}')
        ok = all(a >= BAR for a in aucs if np.isfinite(a))
        print(f'  mean AUC {np.nanmean(aucs):.4f}   BAR {BAR} in all folds: '
              f'{"PASS" if ok else "FAIL"}')
        top = pd.concat(imps, axis=1)
        top['rank_spread'] = top.rank(ascending=False).max(1) - top.rank(ascending=False).min(1)
        t = top.assign(mean=top[[0, 1, 2]].mean(1)).nlargest(8, 'mean')
        print('  top features by mean importance (rank_spread = instability across folds):')
        for name, r in t.iterrows():
            print(f'    {name:<24} mean {r["mean"]:>7.1f}   rank spread {r["rank_spread"]:>5.0f}')
        print()


if __name__ == '__main__':
    main()
