#!/usr/bin/env python3
"""
Phase 6 — model architecture: ensemble + per-cluster.

After two feature-side negatives, the remaining lever is the MODEL, not the
inputs. Test on the conformal-gated frozen holdout:
  6a ensemble  — meta-prob = mean of 3 diverse GBMs (depth 4/5/6, different seeds);
                 variance reduction often improves calibration/EV a touch.
  6b per-cluster — split symbols by volatility (atrPercent tercile, fit on
                 selection) and train a meta-model per cluster (BTC != microcap alt).

Keep only what beats the single-GBM baseline (+0.754R crypto holdout).

Run:  python3 phase6_architecture.py
"""
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression

H = __import__('_harness')
P1 = __import__('phase1_meta')
P2 = __import__('phase2_conformal')

META_FEATURES = H.FEATURES + ['tradeDir']
EMBARGO = 14 * 86400


def gbm(depth, seed):
    return xgb.XGBClassifier(max_depth=depth, n_estimators=100, learning_rate=0.03,
                             subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
                             reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=seed)


ENSEMBLE = [(4, 1), (5, 42), (6, 7)]


def ens_fit(X, y):
    return [m.fit(X, y) for m in (gbm(d, s) for d, s in ENSEMBLE)]


def ens_pred(models, X):
    return np.mean([m.predict_proba(X)[:, 1] for m in models], axis=0)


def wf_oof(selection, predict_fn, fit_fn):
    t = selection['timestamp'].values
    t_lo, t_hi = t.min(), t.max()
    span = t_hi - t_lo
    out = []
    for i in range(5):
        lo = t_lo + span * (0.25 + i * 0.15)
        hi = t_lo + span * (0.25 + (i + 1) * 0.15) if i < 4 else t_hi + 1
        train = selection[selection['timestamp'] < lo - EMBARGO]
        val = selection[(selection['timestamp'] >= lo) & (selection['timestamp'] < hi)].copy()
        if len(train) < 5000 or len(val) < 200:
            continue
        trm = train[train['tradeDir'] != 0]
        models = fit_fn(trm[META_FEATURES].fillna(0), trm['tbWin'])
        val['metaRaw'] = predict_fn(models, val[META_FEATURES].fillna(0))
        out.append(val)
    return pd.concat(out, ignore_index=True)


def eval_holdout(selection, holdout, idx, target, fit_fn, predict_fn):
    val = wf_oof(selection, predict_fn, fit_fn)
    oof = val[val['tradeDir'] != 0]
    iso = IsotonicRegression(out_of_bounds='clip'); iso.fit(oof['metaRaw'], oof['tbWin'])
    cal = np.minimum(iso.predict(oof['metaRaw']), 0.90)
    tau = P2.find_threshold(cal, oof['tbWin'].values, target)
    if tau is None:
        return dict(tau=None, n=0, ev=0)
    trm = selection[selection['tradeDir'] != 0]
    models = fit_fn(trm[META_FEATURES].fillna(0), trm['tbWin'])
    hv = holdout[holdout['tradeDir'] != 0].copy()
    hv['metaProb'] = np.minimum(iso.predict(predict_fn(models, hv[META_FEATURES].fillna(0))), 0.90)
    hv['mlProb'] = hv['metaProb']
    R = H._resolve(hv[hv['metaProb'] >= tau], idx, H.dir_union)
    if len(R) == 0:
        return dict(tau=tau, n=0, ev=0)
    return dict(tau=float(tau), n=len(R), win=float((R['R'] > 0).mean()*100),
                ev=float(R['R'].mean()), totalR=float(R['R'].sum()))


def single_fit(X, y):
    return [H.make_model().fit(X, y)]
def single_pred(models, X):
    return models[0].predict_proba(X)[:, 1]


def run(market):
    print(f"\n{'='*84}\n{market.upper()} — architecture (conformal-gated holdout)\n{'='*84}")
    df, idx = H.load_market(market)
    df = P1.add_labels(df)
    sel, hold, b = H.split_holdout(df)
    target = P2.TARGET[market]

    r_single = eval_holdout(sel, hold, idx, target, single_fit, single_pred)
    r_ens = eval_holdout(sel, hold, idx, target, ens_fit, ens_pred)

    def show(lbl, r):
        if r['n'] == 0:
            print(f"  {lbl:<24} tau={r['tau']}  n=0 (abstains)"); return
        print(f"  {lbl:<24} tau={r['tau']:.3f}  n={r['n']:>6,}  win={r['win']:>4.1f}%  "
              f"EV={r['ev']:>+6.3f}R  totalR={r['totalR']:>+8.1f}")
    show("single GBM (baseline)", r_single)
    show("3-GBM ensemble", r_ens)
    if r_single['n'] and r_ens['n']:
        print(f"  => ensemble delta: {r_ens['ev']-r_single['ev']:+.3f}R/trade")

    # 6b per-cluster (crypto): volatility tercile from selection
    if market == 'crypto' and r_single['n']:
        vol = sel.groupby('symbol')['atrPercent'].median()
        q1, q2 = vol.quantile([0.33, 0.66])
        cluster = {s: (0 if v <= q1 else 1 if v <= q2 else 2) for s, v in vol.items()}
        sel2 = sel.copy(); sel2['cl'] = sel2['symbol'].map(cluster).fillna(1)
        hold2 = hold.copy(); hold2['cl'] = hold2['symbol'].map(cluster).fillna(1)
        Rall = []
        for c in (0, 1, 2):
            rc = eval_holdout(sel2[sel2['cl'] == c], hold2[hold2['cl'] == c], idx, target, single_fit, single_pred)
            if rc['n']:
                Rall.append((rc['ev'], rc['n']))
                print(f"  per-cluster {c}: n={rc['n']:>5,} EV={rc['ev']:+.3f}R tau={rc['tau']:.3f}")
        if Rall:
            wev = sum(e * n for e, n in Rall) / sum(n for _, n in Rall)
            print(f"  => per-cluster pooled EV: {wev:+.3f}R/trade (vs single {r_single['ev']:+.3f}R)")
    H.save_result('phase6_architecture', market, dict(single_ev=r_single.get('ev'), ensemble_ev=r_ens.get('ev')))


def main():
    for mk in ('crypto', 'stock'):
        run(mk)
    print(f"\nsaved to {H.RESULTS_PATH}")


if __name__ == '__main__':
    main()
