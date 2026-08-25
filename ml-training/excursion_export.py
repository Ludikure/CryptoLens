#!/usr/bin/env python3
"""Train the shippable excursion model and export it in the worker's tree-JSON format.

Two decisions that keep this honest:

1. FEATURES ARE RESTRICTED TO THE LIVE SERVING CONTRACT. The research model used every numeric
   column, which included `price` -- a scale/identity variable that the live feature builder does not
   emit and that would let the model learn "BTC is not DOGE" rather than anything about the tape.
   The feature list is intersected with the shipped model's own list, so anything served is
   reproducible live by construction.

2. ONLY THE PRIMARY TARGET (5R) IS MODELLED PER SIDE. The rest of the curve scales the MEASURED base
   curve by the model's ratio at 5R. That is one stated assumption -- shape is shared, level is
   predicted -- replacing the previous extrapolation toward a random-walk benchmark the data sits
   ~10pp below at every R. Training 12 separate models would remove even that assumption; it is a
   follow-up, not a blocker.
"""
import json, os
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

R_GRID = [1.0, 1.5, 2.0, 3.0, 5.0, 8.0]
PRIMARY_R = 5.0
PURGE = 24
CAP, FLOOR = 0.60, 0.005
MIN_BUCKET_N = 500        # minimum holdout support before a calibrated rate is believed
VERSION = 1
OUT = '../marketscope-worker/src/ml-model-excursion-crypto.json'
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)


def lgb_node(node, names, ctr):
    nid = ctr[0]; ctr[0] += 1
    if 'leaf_value' in node:
        return {'nodeid': nid, 'leaf': node['leaf_value']}
    left = lgb_node(node['left_child'], names, ctr)
    right = lgb_node(node['right_child'], names, ctr)
    return {'nodeid': nid, 'split': names[node['split_feature']],
            'split_condition': node['threshold'], 'yes': left['nodeid'], 'no': right['nodeid'],
            'missing': left['nodeid'], 'children': [left, right]}


def main():
    df = pd.read_pickle('excursion_dataset.pkl.gz').sort_values('timestamp').reset_index(drop=True)

    # Exactly the features the live worker can produce.
    serving = set(json.load(open('../marketscope-worker/src/ml-model-crypto.json'))['features'])
    feats = [c for c in df.columns
             if c.startswith('f_') and c[2:] in serving and pd.api.types.is_numeric_dtype(df[c])]
    names = [c[2:] for c in feats]
    print(f'{len(feats)} of {len(serving)} serving features usable '
          f'(dropped non-serving/non-numeric, incl. price)')

    # Measured base curve -- the shape the level is scaled against.
    base = {}
    for side in ('LONG', 'SHORT'):
        base[side] = {R: float(df[f'hit_{side}_{R:g}R'].mean()) for R in R_GRID}
        print(f'  {side} base: ' + '  '.join(f'{R:g}R={base[side][R]:.4f}' for R in R_GRID))

    uniq = np.unique(df.timestamp.values)
    cut = uniq[int(len(uniq) * 0.70)]
    pg = uniq[min(int(len(uniq) * 0.70) + PURGE, len(uniq) - 1)]
    trn, tst = df[df.timestamp <= cut], df[df.timestamp > pg]

    heads = {}
    for side in ('LONG', 'SHORT'):
        y = f'hit_{side}_{PRIMARY_R:g}R'

        # Held-out predictions drive the calibration, so the mapping is not fit on training fit.
        m_cv = lgb.LGBMClassifier(**PARAMS).fit(trn[feats], trn[y])
        p_hold = m_cv.predict_proba(tst[feats])[:, 1]
        auc = roc_auc_score(tst[y], p_hold)

        iso = IsotonicRegression(out_of_bounds='clip').fit(p_hold, tst[y])
        xs = np.linspace(p_hold.min(), p_hold.max(), 60)
        ys = np.clip(iso.predict(xs), FLOOR, CAP)
        ys = np.maximum.accumulate(ys)                      # monotone after clipping

        # SUPPORTED CEILING. Isotonic's extreme tail can rest on a handful of points: the first
        # export put LONG's top grid point at 0.60 -- 9x its 0.066 base rate, from ONE bucket of 60,
        # which would have produced a +3R expected value. Cap at the highest rate actually realised
        # by a bucket with real support, mirroring calibration.ts's CAL_MIN_BUCKET_N discipline.
        order = np.argsort(p_hold)
        yv = tst[y].to_numpy()[order]
        chunks = [yv[i:i + MIN_BUCKET_N] for i in range(0, len(yv), MIN_BUCKET_N)]
        supported = max((c.mean() for c in chunks if len(c) >= MIN_BUCKET_N), default=CAP)
        ceiling = float(min(CAP, supported))
        n_clipped = int((ys > ceiling).sum())
        ys = np.minimum(ys, ceiling)

        # Final model on ALL data, matching how the production scripts ship.
        #
        # Columns are RENAMED to the serving names before fitting. LightGBM records its own
        # feature_names in the dump and they override anything passed in, so fitting on `f_`-prefixed
        # columns bakes `f_`-prefixed splits into the trees. At serve time every lookup would then
        # miss and default to 0 -- the model returns a CONSTANT, silently, with no error anywhere.
        # Caught only because three very different feature dicts produced identical probabilities.
        train_x = df[feats].copy()
        train_x.columns = names
        final = lgb.LGBMClassifier(**PARAMS).fit(train_x, df[y])
        dump = final.booster_.dump_model()
        dnames = dump.get('feature_names', names)
        assert not any(n.startswith('f_') for n in dnames), \
            f'tree split names must match the serving contract, got {dnames[:3]}'
        trees = [lgb_node(t['tree_structure'], dnames, [0]) for t in dump['tree_info']]

        heads[side.lower()] = {
            'trees': trees,
            'calibration': {'x': [float(v) for v in xs], 'y': [float(v) for v in ys],
                            'cap': CAP, 'floor': FLOOR, 'method': 'isotonic'},
            'baseCurve': {f'{R:g}': base[side][R] for R in R_GRID},
            'holdoutAuc': float(auc),
            'supportedCeiling': ceiling,
        }
        print(f'  {side}: holdout AUC {auc:.4f}, {len(trees)} trees, '
              f'calibrated [{ys.min():.4f}, {ys.max():.4f}]  '
              f'supported ceiling {ceiling:.4f} ({ceiling/base[side][PRIMARY_R]:.1f}x base, '
              f'clipped {n_clipped}/60 pts)')

    out = {
        'features': names,
        'version': VERSION,
        'market': 'crypto',
        'engine': 'lightgbm',
        'model_type': 'classifier',
        'target': f'barrier: reach +{PRIMARY_R:g}R before -1R within 72h '
                  f'(stop = 1.0 ATR, conservative intra-bar convention)',
        'primaryR': PRIMARY_R,
        'rGrid': R_GRID,
        'n_features': len(names),
        'n_samples': int(len(df)),
        'symbols': int(df.symbol.nunique()),
        'heads': heads,
        'description': (
            'Excursion/barrier model v1. MEASURED, not extrapolated: base rates sit ~10pp BELOW the '
            'driftless random-walk benchmark 1/(1+R) at every R because a 72h horizon truncates. '
            'Level is predicted at 5R per side; other R values scale the measured base curve. '
            'Cross-sectional AUC ~0.62 is genuine asset selection (market-wide features alone score '
            'exactly 0.5000 within a timestamp). Tradeable within-timestamp spread is +0.109R gross, '
            'median 0.000R, positive in only 34% of timestamps -- thin and outlier-driven. '
            'Profitability is REGIME-DEPENDENT: 1 of 5 rising-market periods profitable, '
            'corr(EV, BTC return) = -0.509. See docs/research/excursion-model.md.'),
    }
    with open(OUT, 'w') as f:
        json.dump(out, f)
    print(f'\nwrote {OUT} ({os.path.getsize(OUT)/1024:.0f} KB)')


if __name__ == '__main__':
    main()
