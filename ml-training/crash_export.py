#!/usr/bin/env python3
"""Export the CRASH model -- the one signal in this project that survived everything thrown at it.

Target, frozen from T2/T8: y_crash = P(price falls >= 10% below the current level at any point in
the next 10 days). It never predicts direction, only whether drawdown risk is elevated.

WHY THIS ONE IS WORTH SHIPPING (docs/research/crash-overlay.md, T8-T17):
  - cuts BTC max drawdown from -76.6% to -40.4%, Calmar 1.74 vs 0.48;
  - beats shuffled, lagged, realised-vol and 200D-MA controls;
  - REPLICATES leave-one-symbol-out on ETH/SOL/XRP with placebos collapsing to ~0.05, so it is not
    one correlated bet counted four times -- 9 of 15 crash clusters are asset-specific.

AND ITS LIMITS, WHICH SHIP WITH IT:
  - protection is EPISODIC: absent through five 20-28% drawdowns in 2023-25;
  - value is ANTICIPATORY, living in a 20-30 day lead that any confirmation filter destroys;
  - ~35x/year turnover is STRUCTURAL: four separate attempts to make it cheaper each removed the
    benefit in proportion.

So it is a RISK GAUGE for sizing and warning, never an entry signal. `crash-risk.ts` already refuses
an exposure floor (T15) and a confirmation filter (T12) for exactly these reasons.
"""
import json, os
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

CRASH_BARS = 60          # 10 days at the 4h cadence
CRASH_PCT = -0.10
PURGE = 72               # > the 60-bar label horizon; T8 recorded a leak when this was too small
CAP, FLOOR = 0.90, 0.005
MIN_BUCKET_N = 500
VERSION = 1
OUT = '../marketscope-worker/src/ml-model-crash-crypto.json'
PARAMS = dict(objective='binary', max_depth=4, n_estimators=150, learning_rate=0.05,
              num_leaves=15, verbose=-1, n_jobs=-1)


def lgb_node(node, names, ctr):
    nid = ctr[0]; ctr[0] += 1
    if 'leaf_value' in node:
        return {'nodeid': nid, 'leaf': node['leaf_value']}
    l = lgb_node(node['left_child'], names, ctr)
    r = lgb_node(node['right_child'], names, ctr)
    return {'nodeid': nid, 'split': names[node['split_feature']],
            'split_condition': node['threshold'], 'yes': l['nodeid'], 'no': r['nodeid'],
            'missing': l['nodeid'], 'children': [l, r]}


def main():
    serving = json.load(open('../marketscope-worker/src/ml-model-crypto.json'))['features']
    keep = set(serving)

    frames = []
    for f in sorted(os.listdir('csv_exports_v14')):
        if not f.endswith('.csv'):
            continue
        d = pd.read_csv(f'csv_exports_v14/{f}', low_memory=False).sort_values('timestamp')
        d = d.reset_index(drop=True)
        # Worst forward drawdown over the next 10 days, from THIS bar's price.
        fmin = d['price'][::-1].rolling(CRASH_BARS, min_periods=1).min()[::-1].shift(-1)
        d['y_crash'] = ((fmin / d['price'] - 1) <= CRASH_PCT).astype(float)
        d.loc[fmin.isna(), 'y_crash'] = np.nan
        d['sym'] = f[:-4]
        frames.append(d)
    a = pd.concat(frames, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    a = a.dropna(subset=['y_crash']).reset_index(drop=True)

    feats = [c for c in a.columns if c in keep and pd.api.types.is_numeric_dtype(a[c])]
    print(f'{len(a):,} bars, {a.sym.nunique()} symbols, {len(feats)} serving features')
    print(f'base rate: {a.y_crash.mean()*100:.1f}% of bars precede a >=10% drawdown within 10 days')

    # Walk-forward for an honest AUC and for the calibration sample.
    n = len(a); aucs = []; hold_p = []; hold_y = []
    for i in range(3):
        tr_end, te_end = int(n * (0.4 + 0.2 * i)), int(n * (0.6 + 0.2 * i))
        tr, te = a.iloc[:max(0, tr_end - PURGE)], a.iloc[tr_end:te_end]
        if len(tr) < 5000 or len(te) < 1000:
            continue
        m = lgb.LGBMClassifier(**PARAMS).fit(tr[feats], tr['y_crash'])
        p = m.predict_proba(te[feats])[:, 1]
        aucs.append(roc_auc_score(te['y_crash'], p))
        hold_p.append(p); hold_y.append(te['y_crash'].to_numpy())
    print(f'walk-forward AUC: {"  ".join(f"{x:.4f}" for x in aucs)}   mean {np.mean(aucs):.4f}')

    hp, hy = np.concatenate(hold_p), np.concatenate(hold_y)
    iso = IsotonicRegression(out_of_bounds='clip').fit(hp, hy)
    xs = np.linspace(hp.min(), hp.max(), 60)
    ys = np.maximum.accumulate(np.clip(iso.predict(xs), FLOOR, CAP))

    # Supported ceiling, same discipline as the excursion export: isotonic's extreme tail can rest
    # on a handful of points, and a crash probability that overstates its top end would cut position
    # size to zero on thin evidence.
    order = np.argsort(hp); yv = hy[order]
    chunks = [yv[i:i + MIN_BUCKET_N] for i in range(0, len(yv), MIN_BUCKET_N)]
    ceiling = float(min(CAP, max((c.mean() for c in chunks if len(c) >= MIN_BUCKET_N), default=CAP)))
    ys = np.minimum(ys, ceiling)
    print(f'calibrated range [{ys.min():.4f}, {ys.max():.4f}], supported ceiling {ceiling:.4f} '
          f'({ceiling/a.y_crash.mean():.1f}x base)')

    # Reliability, printed so the shipped curve is inspectable rather than asserted.
    b = pd.DataFrame({'p': np.clip(np.interp(hp, xs, ys), 0, 1), 'y': hy})
    b['bucket'] = pd.cut(b.p, [0, .1, .2, .3, .5, 1.0])
    print('  calibrated bucket -> realised crash rate:')
    for k, g in b.groupby('bucket', observed=True):
        print(f'    {str(k):>12}  n={len(g):>7,}  realised {g.y.mean()*100:>5.1f}%')

    # Final model on everything, columns renamed to the serving contract BEFORE fitting -- LightGBM
    # bakes its own feature_names into the dump, and a mismatch makes every live lookup miss and
    # return a constant, silently. That defect was caught in the excursion export the same day.
    X = a[feats].copy(); X.columns = feats
    final = lgb.LGBMClassifier(**PARAMS).fit(X, a['y_crash'])
    dump = final.booster_.dump_model()
    names = dump.get('feature_names', feats)
    assert set(names) <= keep, 'tree split names must all be serving features'
    trees = [lgb_node(t['tree_structure'], names, [0]) for t in dump['tree_info']]

    out = {
        'features': feats,
        'trees': trees,
        'version': VERSION,
        'market': 'crypto',
        'engine': 'lightgbm',
        'model_type': 'classifier',
        'target': f'y_crash: price falls >= {abs(CRASH_PCT):.0%} below this level within '
                  f'{CRASH_BARS//6} days',
        'horizonDays': CRASH_BARS // 6,
        'baseRate': float(a.y_crash.mean()),
        'walkForwardAuc': [float(x) for x in aucs],
        'calibration': {'x': [float(v) for v in xs], 'y': [float(v) for v in ys],
                        'cap': CAP, 'floor': FLOOR, 'method': 'isotonic'},
        'supportedCeiling': ceiling,
        'n_samples': int(len(a)),
        'symbols': int(a.sym.nunique()),
        'description': (
            'Crash/drawdown-risk model v1. The one signal that survived every control: cuts BTC max '
            'drawdown -76.6% -> -40.4% (Calmar 1.74 vs 0.48), beats shuffled/lagged/realised-vol/200D '
            'controls, and REPLICATES leave-one-symbol-out on ETH/SOL/XRP with placebos at ~0.05. '
            'LIMITS SHIP WITH IT: protection is EPISODIC (absent through five 20-28% drawdowns in '
            '2023-25), value is ANTICIPATORY (20-30 day lead that confirmation destroys), and ~35x/yr '
            'turnover is STRUCTURAL. A RISK GAUGE for sizing and warning, never an entry signal. '
            'See docs/research/crash-overlay.md.'),
    }
    with open(OUT, 'w') as f:
        json.dump(out, f)
    print(f'\nwrote {OUT} ({os.path.getsize(OUT)/1024:.0f} KB)')


if __name__ == '__main__':
    main()
