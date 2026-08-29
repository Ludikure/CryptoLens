#!/usr/bin/env python3
"""Does CROSS-SECTIONAL top-k selection beat threshold gating? (2026-08-26)

Everything measured today says this system cannot TIME an entry: ML_WIN scores ~0.50 within a
timestamp on both sides, the full 110-feature model scores 0.4993 on LONG payoff, every entry delay
is worse than acting at the signal, and direction has been a coin flip since the 2026-06-02
retraction.

Cross-sectional selection sidesteps that question. It does not ask "is now a good time" — it asks
"given that I will hold something, which one". The excursion retrain scored 0.6220 cross-sectionally
on SHORT, where ML_WIN scores 0.50, so the axis is at least plausibly informative.

PRE-DECLARED, before running:
  method   walk-forward payoff model (target = sign of net R, per side, production 110 features,
           3 expanding folds, 48-bar purge). Within each validation timestamp, rank the symbols by
           the OOS score and take the top k.
  controls RANDOM top-k at the same exposure — the control that matters, because taking k of ~20
           symbols is itself a change in exposure and would flatter any ranking. Plus the ML >= 0.55
           threshold gate and trade-everything.
  BAR      top-k must beat BOTH random-k AND the threshold gate, on the same rows, with the
           block-bootstrap CI of (top-k minus random-k) excluding zero.

  If top-k only beats trade-everything, that is an exposure effect and NOT support — the same
  abstention artifact C1 found in the entry-discipline result.
"""
import glob, json, os
import numpy as np, pandas as pd, lightgbm as lgb
from _report import moving_block_bootstrap

FEATS = json.load(open('../marketscope-worker/src/ml-model-crypto.json'))['features']
KS = [1, 2, 3, 5]
PURGE, N_FOLDS = 48, 3


def folds(n):
    for i in range(N_FOLDS):
        te = int(n * (0.4 + i * 0.15)); vs = te + PURGE
        ve = int(n * (0.55 + i * 0.15)) if i < N_FOLDS - 1 else n
        if vs < ve: yield te, vs, ve


def main():
    rows = pd.read_pickle('level_entry_rows.pkl.gz')
    env = pd.concat([pd.read_csv(f) for f in glob.glob('envelope_exports_ml/*.csv')],
                    ignore_index=True)[['symbol', 'timestamp', 'alignedDirection']]
    oof = pd.read_csv('phase2_oof_crypto.csv')[['symbol', 'timestamp', 'p']]
    fe = pd.concat([pd.read_csv(f, low_memory=False).assign(symbol=os.path.basename(f)[:-4])
                    for f in sorted(glob.glob('csv_exports_v14/*.csv'))], ignore_index=True)
    d = rows.merge(env, on=['symbol', 'timestamp']).merge(oof, on=['symbol', 'timestamp']) \
            .merge(fe, on=['symbol', 'timestamp'], suffixes=('', '_f')).sort_values('timestamp').reset_index(drop=True)
    rng = np.random.default_rng(3)

    for side in ('SHORT', 'LONG'):
        sub = d[d.alignedDirection == side].reset_index(drop=True)
        col = f'd0.0_{side}_oppR'
        sub = sub[np.isfinite(sub[col])].reset_index(drop=True)
        y = (sub[col] > 0).astype(int).to_numpy()
        X = sub[FEATS].fillna(0)
        score = np.full(len(sub), np.nan)
        for te, vs, ve in folds(len(sub)):
            m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.03,
                                   num_leaves=15, verbose=-1, n_jobs=-1)
            m.fit(X.iloc[:te], y[:te])
            score[vs:ve] = m.predict_proba(X.iloc[vs:ve])[:, 1]
        v = sub[np.isfinite(score)].copy(); v['score'] = score[np.isfinite(score)]
        print(f'\n=== {side}   {len(v):,} OOS rows, {v.timestamp.nunique():,} timestamps, '
              f'median {v.groupby("timestamp").size().median():.0f} symbols/timestamp ===')
        print(f'{"arm":>16}{"exposure":>10}{"mean R":>10}{"vs random":>11}{"95% CI of diff":>22}')
        print(f'{"trade everything":>16}{1.0:>10.2f}{v[col].mean():>+10.4f}')
        gate = v[v.p >= 0.55]
        print(f'{"ML >= 0.55":>16}{len(gate)/len(v):>10.2f}{gate[col].mean():>+10.4f}')
        g = v.groupby('timestamp', sort=False)
        for k in KS:
            top = g.apply(lambda x: x.nlargest(min(k, len(x)), 'score'), include_groups=False)
            rnd = g.apply(lambda x: x.sample(min(k, len(x)), random_state=int(x.name) % 10000),
                          include_groups=False)
            tr, rr = top[col].to_numpy(float), rnd[col].to_numpy(float)
            n = min(len(tr), len(rr))
            diff = tr[:n] - rr[:n]
            ci = moving_block_bootstrap(diff, 18)
            print(f'{f"top-{k}":>16}{len(top)/len(v):>10.2f}{np.nanmean(tr):>+10.4f}'
                  f'{np.nanmean(tr)-np.nanmean(rr):>+11.4f}{f"[{ci[0]:+.4f},{ci[1]:+.4f}]":>22}')


if __name__ == '__main__':
    main()
