#!/usr/bin/env python3
"""Full feature + model audit on the leak-clean training data.

PRE-DECLARED protocol (run once, report, stop — no iterating until green):
  A. Reproduce the production baseline (canonical folds/weights/purge) — the anchor.
  B. Model grid (bounded): LGB {d3,d4,d5,d6} × {150,300} trees × lr {0.03,0.05} subset,
     XGB cross-checks. Bar to displace production: mean ΔAUC > +0.005 AND positive in
     EVERY fold AND top-decile precision not degraded.
  C. Feature-group ablation: drop each group, measure per-fold ΔAUC.
     LOAD-BEARING if dropping costs > 0.005 mean AUC; DEAD WEIGHT if dropping helps in
     ≥ 2/3 folds.
  D. Dead-feature audit: zero gain importance in all folds + permutation importance
     (last fold's validation) for the top features.
  E. Redundancy: |corr| > 0.9 clusters (informational).

Methodology mirrors calibrate_v12_crypto_clean.py exactly: same fold boundaries
(train_end = n·(0.4+0.15i)), same 48-row purge, same daily downsample, same time-decay
sample weights. Usage: python3 feature_model_audit.py crypto|stocks
"""
import ast
import os
import re
import sys
import json

import numpy as np
import pandas as pd
import lightgbm as lgb
import xgboost as xgb
from sklearn.metrics import roc_auc_score, brier_score_loss

HERE = os.path.dirname(os.path.abspath(__file__))
MARKET = sys.argv[1] if len(sys.argv) > 1 else 'crypto'
TRAIN_DIR = os.path.join(HERE, 'csv_exports_v11_fixed' if MARKET == 'crypto' else 'csv_exports_v13')
CANONICAL = 'calibrate_v12_crypto_clean.py' if MARKET == 'crypto' else 'calibrate_v13_stocks.py'


def load_features():
    src = open(os.path.join(HERE, CANONICAL)).read()
    m = re.search(r'^FEATURES = (\[.*?\])$', src, re.S | re.M)
    return ast.literal_eval(m.group(1))

FEATURES = load_features()

GROUPS = {
    'daily_core':    [f for f in FEATURES if f.startswith('d') and 'Delta' not in f and 'Accel' not in f
                      and f not in ('dayOfWeek', 'distToFiftyTwoHigh', 'derivativesCombined', 'dxyAboveEma20', 'dxyMomentum')],
    'fourh_core':    [f for f in FEATURES if f.startswith('h') and 'Delta' not in f and 'Accel' not in f
                      and f != 'hourBucket'],
    'oneh':          ['eRsi', 'eEmaCross', 'eStochK', 'eMacdHist'],
    'deriv_signals': ['fundingSignal', 'oiSignal', 'takerSignal', 'crowdingSignal', 'derivativesCombined'],
    'deriv_raw':     ['fundingRateRaw', 'oiChangePct', 'takerRatioRaw', 'longPctRaw'],
    'deriv_interact': ['oiPriceInteraction', 'fundingSlope'],
    'macro':         ['vix', 'dxyAboveEma20', 'volScalarML'],
    'candle3':       ['last3Green', 'last3Red', 'last3VolIncreasing', 'bodyWickRatio'],
    'stock_only':    ['obvRising', 'adLineAccumulation', 'fiftyTwoWeekPct', 'distToFiftyTwoHigh',
                      'gapPercent', 'gapFilled', 'gapDirectionAligned', 'relStrengthVsSpy', 'beta',
                      'vixLevelCode', 'isMarketHours', 'earningsProximity', 'shortVolumeRatio',
                      'shortVolumeZScore', 'relStrengthVsSector', 'vixTermStructure', 'dxyMomentum',
                      'iwmSpyRatio'],
    'context_atr':   ['atrPercent', 'atrPercentile'],
    'cross_tf':      ['tfAlignment', 'momentumAlignment', 'structureAlignment'],
    'temporal':      ['dayOfWeek', 'barsSinceRegimeChange', 'regimeCode', 'hourBucket', 'isWeekend'],
    'deltas_6bar':   ['dRsiDelta', 'dAdxDelta', 'hRsiDelta', 'hAdxDelta', 'hMacdHistDelta'],
    'deltas_1bar':   ['hRsiDelta1', 'hMacdHistDelta1', 'dRsiDelta1'],
    'accel':         ['hRsiAccel', 'hMacdAccel', 'dAdxAccel'],
    'sentiment':     ['fearGreedIndex', 'fearGreedZone'],
    'eth_btc':       ['ethBtcRatio', 'ethBtcDelta6'],
    'basis':         ['basisPct', 'basisExtreme'],
    'volume_profile': ['vpDistToPocATR', 'vpAbovePoc', 'vpVAWidth', 'vpInValueArea',
                       'vpDistToVAH_ATR', 'vpDistToVAL_ATR'],
}
GROUPS = {k: [f for f in v if f in FEATURES] for k, v in GROUPS.items()}


def load_data():
    parts = []
    for f in sorted(os.listdir(TRAIN_DIR)):
        if not f.endswith('.csv'):
            continue
        df = pd.read_csv(os.path.join(TRAIN_DIR, f))
        if 'fwdMaxFavR' not in df.columns:
            continue
        if 'symbol' not in df.columns:
            df['symbol'] = f[:-4]
        df = df[df['fwdMaxFavR'].notna() & df['fwdReturn24H'].notna()].copy()
        df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
        for feat in FEATURES:
            if feat not in df.columns:
                df[feat] = 1.0 if feat == 'takerRatioRaw' else (50.0 if feat == 'longPctRaw' else
                           (60.0 if feat in ('daysToEarnings', 'daysSinceEarnings') else 0.0))
        df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
        df = df.groupby(['symbol', 'date']).tail(1)          # canonical daily downsample
        parts.append(df)
    out = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    print(f'{MARKET}: {len(out)} daily bars, {out.symbol.nunique()} symbols, goodR base {out.goodR.mean():.3f}')
    return out


def weights(ts):
    now = ts.max()
    w = np.ones(len(ts))
    w[ts >= now - 2 * 365 * 86400] = 2.0
    w[ts >= now - 365 * 86400] = 3.0
    return w


def folds(n, n_folds=3, purge=48):
    for i in range(n_folds):
        train_end = int(n * (0.4 + i * 0.15))
        val_start = train_end + purge
        val_end = int(n * (0.55 + i * 0.15)) if i < n_folds - 1 else n
        if val_start < val_end:
            yield i, train_end, val_start, val_end


def wf_metrics(data, feats, model_fn, collect_models=False):
    """Per-fold (auc, top-decile precision, brier); optionally fold models for importance."""
    out, models = [], []
    for i, te, vs, ve in folds(len(data)):
        tr, va = data.iloc[:te], data.iloc[vs:ve]
        m = model_fn()
        m.fit(tr[feats].fillna(0), tr['goodR'], sample_weight=weights(tr['timestamp'].values))
        p = m.predict_proba(va[feats].fillna(0))[:, 1]
        y = va['goodR'].values
        top = y[np.argsort(p)[-max(1, len(p) // 10):]]
        out.append((roc_auc_score(y, p), top.mean(), brier_score_loss(y, p)))
        if collect_models:
            models.append((m, vs, ve))
    return (out, models) if collect_models else out


def mk_lgb(depth=4, trees=150, lr=0.03):
    return lambda: lgb.LGBMClassifier(max_depth=depth, n_estimators=trees, learning_rate=lr,
                                      subsample=0.8, colsample_bytree=0.8, min_child_samples=10,
                                      reg_alpha=0.1, reg_lambda=1.0, random_state=42, verbose=-1)


def mk_xgb(depth=5, trees=100, lr=0.03):
    return lambda: xgb.XGBClassifier(max_depth=depth, n_estimators=trees, learning_rate=lr,
                                     subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
                                     reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42)


PROD = mk_lgb(4, 150, 0.03) if MARKET == 'crypto' else mk_xgb(5, 100, 0.03)

GRID = [
    ('PROD ' + ('LGB d4 t150 lr.03' if MARKET == 'crypto' else 'XGB d5 t100 lr.03'), PROD),
    ('LGB d3 t150 lr.03', mk_lgb(3, 150)), ('LGB d3 t300 lr.03', mk_lgb(3, 300)),
    ('LGB d4 t300 lr.03', mk_lgb(4, 300)), ('LGB d4 t150 lr.05', mk_lgb(4, 150, 0.05)),
    ('LGB d5 t150 lr.03', mk_lgb(5, 150)), ('LGB d5 t300 lr.03', mk_lgb(5, 300)),
    ('LGB d6 t200 lr.03', mk_lgb(6, 200)),
    ('XGB d4 t150 lr.03', mk_xgb(4, 150)), ('XGB d5 t100 lr.03', mk_xgb(5, 100)),
    ('XGB d6 t200 lr.03', mk_xgb(6, 200)),
]


def fmt(rows):
    aucs = [r[0] for r in rows]
    tops = [r[1] for r in rows]
    return (f'AUC {" ".join(f"{a:.4f}" for a in aucs)} (mean {np.mean(aucs):.4f}) | '
            f'top10% {" ".join(f"{t:.3f}" for t in tops)} (mean {np.mean(tops):.3f}) | '
            f'Brier {np.mean([r[2] for r in rows]):.4f}')


def main():
    data = load_data()
    results = {}

    print('\n================ A. BASELINE (production config) ================')
    base, base_models = wf_metrics(data, FEATURES, PROD, collect_models=True)
    print('  ' + fmt(base))
    base_auc = np.mean([r[0] for r in base])
    results['baseline'] = base

    print('\n================ B. MODEL GRID ================')
    for name, fn in GRID:
        rows = wf_metrics(data, FEATURES, fn)
        d = np.mean([r[0] for r in rows]) - base_auc
        per_fold_pos = sum(1 for r, b in zip(rows, base) if r[0] > b[0])
        beats = d > 0.005 and per_fold_pos == len(rows) and np.mean([r[1] for r in rows]) >= np.mean([r[1] for r in base]) - 0.005
        print(f'  {name:<24} {fmt(rows)}  Δ{d:+.4f} folds>{per_fold_pos}/{len(rows)}'
              f'{"  ★ BEATS PROD BAR" if beats else ""}')
        results[name] = rows

    print('\n================ C. FEATURE-GROUP ABLATION (drop group, prod config) ================')
    for gname, gfeats in GROUPS.items():
        if not gfeats:
            continue
        keep = [f for f in FEATURES if f not in gfeats]
        rows = wf_metrics(data, keep, PROD)
        deltas = [r[0] - b[0] for r, b in zip(rows, base)]
        verdict = ('LOAD-BEARING' if np.mean(deltas) < -0.005 else
                   ('DEAD WEIGHT?' if sum(d > 0 for d in deltas) >= 2 else 'neutral'))
        print(f'  -{gname:<16} ({len(gfeats):>2} feats) ΔAUC/fold: {" ".join(f"{d:+.4f}" for d in deltas)} '
              f'mean {np.mean(deltas):+.4f}  → {verdict}')

    print('\n================ D. DEAD FEATURES + PERMUTATION (last fold) ================')
    gains = pd.DataFrame(index=FEATURES)
    for k, (m, vs, ve) in enumerate(base_models):
        booster = m.booster_ if hasattr(m, 'booster_') else None
        if booster is not None:
            gains[f'f{k}'] = pd.Series(booster.feature_importance('gain'), index=FEATURES)
    if not gains.empty:
        dead = gains[(gains == 0).all(axis=1)].index.tolist()
        print(f'  zero gain in ALL folds ({len(dead)}): {dead}')
        near = gains[(gains.sum(axis=1) / gains.sum().sum()) < 0.0005].index.tolist()
        print(f'  <0.05% of total gain ({len(near)}): {sorted(set(near) - set(dead))}')

    m, vs, ve = base_models[-1]
    va = data.iloc[vs:ve]
    Xv, yv = va[FEATURES].fillna(0), va['goodR'].values
    p0 = roc_auc_score(yv, m.predict_proba(Xv)[:, 1])
    rng = np.random.default_rng(42)
    perm = {}
    for f in FEATURES:
        drops = []
        for _ in range(3):
            Xp = Xv.copy()
            Xp[f] = rng.permutation(Xp[f].values)
            drops.append(p0 - roc_auc_score(yv, m.predict_proba(Xp)[:, 1]))
        perm[f] = np.mean(drops)
    top = sorted(perm.items(), key=lambda x: -x[1])[:15]
    print('  top-15 permutation importance (AUC drop, last fold):')
    for f, v in top:
        print(f'    {f:<24} {v:+.4f}')
    harmful = [f for f, v in perm.items() if v < -0.001]
    print(f'  permutation-NEGATIVE (shuffling HELPS ≥0.001; overfit-suspect): {sorted(harmful)}')

    print('\n================ E. REDUNDANCY (|corr| > 0.9) ================')
    corr = data[FEATURES].fillna(0).corr().abs()
    seen = set()
    for i, a in enumerate(FEATURES):
        for b in FEATURES[i + 1:]:
            if corr.loc[a, b] > 0.9 and (a, b) not in seen:
                seen.add((a, b))
                print(f'  {a} ↔ {b}  r={corr.loc[a, b]:.3f}')

    json.dump({k: v for k, v in results.items()},
              open(os.path.join(HERE, f'audit_{MARKET}_results.json'), 'w'), default=float)
    print(f'\nSaved audit_{MARKET}_results.json. '
          'Bars: model change needs ΔAUC>+0.005 in ALL folds; group is load-bearing at −0.005.')


if __name__ == '__main__':
    main()
