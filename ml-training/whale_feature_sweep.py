#!/usr/bin/env python3
"""Bounded robustness sweep for the whale-feature hypothesis (follow-up to
whale_feature_test.py after its rejection verdict).

PRE-DECLARED variants — run once, report, stop. Same folds, same pass bar
(consistent positive Δ AUC across folds). No iterating until green.

  V1  alt windows      — activity z at 2d / 30d baselines; imbalance at 8h / 48h
  V2  interactions     — whale activity × volatility context (atrPercentile,
                         dVolumeRatio, dAdx): "whale spike in quiet tape" etc.
  V3  model cross-check— XGBoost d5/100 (the stock recipe) on the original 6
  V4  slow target      — fwdMaxFavR72H >= 2.5 (whale accumulation might act slower)
  V5  standalone       — whale features ALONE (any absolute signal at all?)
"""
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import roc_auc_score

import whale_feature_test as base  # reuse loader, folds, model, FEATURES

BUCKET_S = base.BUCKET_S


def add_variant_features(df_sym):
    """V1 + V2 features per symbol frame (already has whale cols joined, causally lagged)."""
    g = df_sym.sort_values('timestamp')
    return g


def build():
    df = base.load_joined()
    # V1: re-derive alt-window features from the raw joined whale columns is not possible
    # (load_joined keeps only the engineered features), so recompute per symbol from the
    # backfill CSVs with alternate windows, same one-bucket lag.
    import os
    alt_frames = []
    for sym in df['symbol'].unique():
        w = pd.read_csv(os.path.join(base.WHALE_DIR, f'{sym}.csv'))
        w['ts'] = (w['timestamp'] // 1000).astype(int)
        w = w.sort_values('ts').reset_index(drop=True)
        full = pd.DataFrame({'ts': np.arange(w['ts'].min(), w['ts'].max() + 1, BUCKET_S)})
        w = full.merge(w, on='ts', how='left').fillna(0.0)
        b, s = w['large_buy_vol'], w['large_sell_vol']
        tot = b + s
        cnt = w['large_buy_count'] + w['large_sell_count']
        eps = 1.0
        for name, win in (('2d', 12), ('30d', 180)):
            mu, sd = tot.rolling(win, min_periods=6).mean(), tot.rolling(win, min_periods=6).std()
            w[f'wVolZ_{name}'] = ((tot - mu) / (sd + eps)).clip(-6, 6)
            cmu, csd = cnt.rolling(win, min_periods=6).mean(), cnt.rolling(win, min_periods=6).std()
            w[f'wCntZ_{name}'] = ((cnt - cmu) / (csd + 1.0)).clip(-6, 6)
        for name, win in (('8h', 2), ('48h', 12)):
            bw, sw = b.rolling(win, min_periods=1).sum(), s.rolling(win, min_periods=1).sum()
            w[f'wImb_{name}'] = (bw - sw) / (bw + sw + eps)
        cols = [c for c in w.columns if c.startswith('wVolZ_') or c.startswith('wCntZ_') or c.startswith('wImb_')]
        out = w[['ts'] + cols].copy()
        out['ts'] = out['ts'] + BUCKET_S  # same conservative one-bucket lag
        out['symbol'] = sym
        alt_frames.append(out)
    alts = pd.concat(alt_frames, ignore_index=True)
    df = df.merge(alts, left_on=['symbol', 'timestamp'], right_on=['symbol', 'ts'], how='left')
    V1 = [c for c in df.columns if c.startswith(('wVolZ_', 'wCntZ_', 'wImb_'))]
    df = df.dropna(subset=V1).reset_index(drop=True)

    # V2 interactions (whale activity × existing context)
    df['wx_volz_atrp'] = df['wVolZ'] * df['atrPercentile']
    df['wx_volz_dvol'] = df['wVolZ'] * df['dVolumeRatio']
    df['wx_cntz_dadx'] = df['wCntZ'] * df['dAdx'] / 100.0
    V2 = ['wx_volz_atrp', 'wx_volz_dvol', 'wx_cntz_dadx']

    # V4 slow target
    df['tail72'] = (df['fwdMaxFavR72H'] >= 2.5).astype(int)
    return df, V1, V2


def make_xgb():
    return xgb.XGBClassifier(max_depth=5, n_estimators=100, learning_rate=0.03,
                             subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
                             reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42)


def wf(df, feats, target, model_fn=base.make_model, n_folds=4, purge=48):
    times = np.sort(df['timestamp'].unique())
    bounds = [times[min(int(len(times) * q), len(times) - 1)] for q in np.linspace(0.4, 1.0, n_folds + 1)]
    bounds[-1] = times[-1] + 1
    out = []
    for k in range(n_folds):
        t0, t1 = bounds[k], bounds[k + 1]
        train = df[df['timestamp'] < t0 - purge * BUCKET_S]
        test = df[(df['timestamp'] >= t0) & (df['timestamp'] < t1)]
        if len(train) < 500 or len(test) < 200 or test[target].nunique() < 2:
            continue
        m = model_fn()
        m.fit(train[feats], train[target])
        p = m.predict_proba(test[feats])[:, 1]
        out.append(roc_auc_score(test[target], p))
    return out


def ab(df, extra, target, label, model_fn=base.make_model):
    a = wf(df, base.FEATURES, target, model_fn)
    b = wf(df, base.FEATURES + extra, target, model_fn)
    d = [y - x for x, y in zip(a, b)]
    print(f'{label:<46} Δ per fold: {" ".join(f"{x:+.4f}" for x in d)}  '
          f'mean {np.mean(d):+.4f}  positive {sum(x>0 for x in d)}/{len(d)}')
    return d


def main():
    df, V1, V2 = build()
    print(f'\n{len(df)} bars, {df.symbol.nunique()} symbols\n')
    W6 = base.WHALE_FEATURES

    print('--- goodR ---')
    ab(df, W6, 'goodR', 'V0 original 6 (reference)')
    ab(df, V1, 'goodR', 'V1 alt windows (2d/30d z, 8h/48h imb)')
    ab(df, V2, 'goodR', 'V2 interactions (whale × atrP/dVol/dAdx)')
    ab(df, W6, 'goodR', 'V3 XGBoost cross-check, original 6', make_xgb)
    print('--- tail4 ---')
    ab(df, W6, 'tail4', 'V0 original 6 (reference)')
    ab(df, V1, 'tail4', 'V1 alt windows')
    ab(df, V2, 'tail4', 'V2 interactions')
    ab(df, W6, 'tail4', 'V3 XGBoost cross-check', make_xgb)
    print('--- tail72 (V4 slow target, fwdMaxFavR72H >= 2.5) ---')
    ab(df, W6, 'tail72', 'V4 original 6')
    ab(df, V1, 'tail72', 'V4 + alt windows')

    print('--- V5 whale features ALONE (absolute signal; 0.5 = none) ---')
    for target in ('goodR', 'tail4', 'tail72'):
        aucs = wf(df, W6 + V1 + V2, target)
        print(f'  standalone all-whale vs {target:<7} AUC/fold: {" ".join(f"{x:.4f}" for x in aucs)}  mean {np.mean(aucs):.4f}')

    print('\nPass bar (pre-declared): a variant earns further work only with consistent '
          'positive Δ across folds. Anything else → the rejection stands.')


if __name__ == '__main__':
    main()
