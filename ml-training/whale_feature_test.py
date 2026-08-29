#!/usr/bin/env python3
"""Whale-flow feature test: do large-trade ($100k+ futures aggTrade) flow features add
predictive power beyond the existing v11/v12 feature set?

Data:
  - Training bars: csv_exports_v11_fixed/<SYM>.csv (leak-clean regen, 4h bars, 139 cols)
  - Whale flow:    whale_backfill/<SYM>.csv (from scripts/backfill-whale-trades.ts —
                   Binance Vision futures aggTrades, >= $100k notional, 4h UTC buckets)

Leak discipline:
  - Whale buckets are LAGGED ONE FULL BUCKET before joining: the row at timestamp T gets
    the bucket covering [T-4h, T). Under either open-time or close-time candle convention
    that bucket is strictly historical relative to labels measured after T. Conservative
    by design — costs 4h freshness; if signal shows up lagged, tightening is upside.
  - Rolling stats use only past buckets (pandas rolling = trailing window).
  - Walk-forward expanding folds with a 48-bar purge gap (canonical methodology).

Arms (identical LightGBM params to calibrate_v12_crypto_clean.make_crypto_model):
  A. baseline  = the production FEATURES list
  B. +whale    = baseline + 6 whale features

Targets: goodR (fwdMaxFavR >= 1.5, the production target) and tail (fwdMaxFavR >= 4,
the big-move head target — whale flow plausibly relates to outsized moves).

Honest verdict per the graveyard rules: a feature set earns its place only if the OOF
AUC/top-decile improvement is consistent across folds, not just on the mean.
"""
import ast
import os
import re
import sys

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_DIR = os.path.join(HERE, 'csv_exports_v11_fixed')
WHALE_DIR = os.path.join(HERE, 'whale_backfill')
BUCKET_S = 4 * 3600

# ---- pull the production FEATURES list straight from the canonical training script ----
def load_production_features():
    src = open(os.path.join(HERE, 'calibrate_v12_crypto_clean.py')).read()
    m = re.search(r'^FEATURES = (\[.*?\])$', src, re.S | re.M)
    return ast.literal_eval(m.group(1))

FEATURES = load_production_features()

WHALE_FEATURES = ['wImb', 'wImb24h', 'wVolZ', 'wCntZ', 'wImbD6', 'wBuyShareVsWeek']


def whale_features(sym):
    """Per-4h-bucket whale features, computed causally then lagged one bucket."""
    path = os.path.join(WHALE_DIR, f'{sym}.csv')
    if not os.path.isfile(path):
        return None
    w = pd.read_csv(path)
    if len(w) < 100:
        return None
    w['ts'] = (w['timestamp'] // 1000).astype(int)
    w = w.sort_values('ts').reset_index(drop=True)
    # Re-grid to a complete 4h index so rolling windows see quiet buckets as zero flow
    # (absent row = no whale prints, not missing data).
    full = pd.DataFrame({'ts': np.arange(w['ts'].min(), w['ts'].max() + 1, BUCKET_S)})
    w = full.merge(w, on='ts', how='left').fillna(0.0)

    b, s = w['large_buy_vol'], w['large_sell_vol']
    tot = b + s
    eps = 1.0
    w['wImb'] = (b - s) / (tot + eps)                                   # last-bucket imbalance
    b6, s6 = b.rolling(6, min_periods=1).sum(), s.rolling(6, min_periods=1).sum()
    w['wImb24h'] = (b6 - s6) / (b6 + s6 + eps)                          # 24h imbalance
    mu = tot.rolling(42, min_periods=12).mean()                        # 7-day activity baseline
    sd = tot.rolling(42, min_periods=12).std()
    w['wVolZ'] = ((tot - mu) / (sd + eps)).clip(-6, 6)                 # whale-volume z-score
    cnt = w['large_buy_count'] + w['large_sell_count']
    cmu = cnt.rolling(42, min_periods=12).mean()
    csd = cnt.rolling(42, min_periods=12).std()
    w['wCntZ'] = ((cnt - cmu) / (csd + 1.0)).clip(-6, 6)               # whale-count z-score
    w['wImbD6'] = w['wImb24h'] - w['wImb24h'].shift(6)                 # imbalance momentum
    bw = b.rolling(42, min_periods=12).sum()
    tw = tot.rolling(42, min_periods=12).sum()
    w['wBuyShareVsWeek'] = (b6 / (b6 + s6 + eps)) - (bw / (tw + eps))  # 24h buy share vs 7d norm

    # LAG ONE BUCKET: row at T joins the bucket covering [T-4h, T).
    out = w[['ts'] + WHALE_FEATURES].copy()
    out['ts'] = out['ts'] + BUCKET_S
    return out


def load_joined():
    frames = []
    for f in sorted(os.listdir(WHALE_DIR)):
        if not f.endswith('.csv'):
            continue
        sym = f[:-4]
        wf = whale_features(sym)
        if wf is None:
            continue
        tpath = os.path.join(TRAIN_DIR, f'{sym}.csv')
        if not os.path.isfile(tpath):
            print(f'  {sym}: no training CSV — skip')
            continue
        t = pd.read_csv(tpath)
        t = t[t['fwdMaxFavR'].notna() & t['fwdReturn24H'].notna()].copy()
        merged = t.merge(wf, left_on='timestamp', right_on='ts', how='inner')
        merged = merged.dropna(subset=WHALE_FEATURES)
        for feat in FEATURES:
            if feat not in merged.columns:
                merged[feat] = 1.0 if feat == 'takerRatioRaw' else (50.0 if feat == 'longPctRaw' else 0.0)
        print(f'  {sym}: {len(merged)} joined bars '
              f'({pd.to_datetime(merged.timestamp.min(), unit="s").date()} → '
              f'{pd.to_datetime(merged.timestamp.max(), unit="s").date()})')
        frames.append(merged)
    if not frames:
        sys.exit('No joined data.')
    df = pd.concat(frames, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
    df['tail4'] = (df['fwdMaxFavR'] >= 4.0).astype(int)
    return df


def make_model():
    return lgb.LGBMClassifier(
        max_depth=4, n_estimators=150, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_samples=10,
        reg_alpha=0.1, reg_lambda=1.0, random_state=42, verbose=-1,
    )


def wf_eval(df, feats, target, n_folds=4, purge=48):
    """Expanding-window walk-forward on TIME (all symbols share fold boundaries).
    Returns per-fold (auc, top-decile precision, base rate)."""
    times = np.sort(df['timestamp'].unique())
    bounds = [times[min(int(len(times) * q), len(times) - 1)] for q in np.linspace(0.4, 1.0, n_folds + 1)]
    bounds[-1] = times[-1] + 1  # last fold includes the final timestamp
    rows = []
    for k in range(n_folds):
        t0, t1 = bounds[k], bounds[k + 1] if k + 1 < len(bounds) else times[-1] + 1
        train = df[df['timestamp'] < t0 - purge * BUCKET_S]
        test = df[(df['timestamp'] >= t0) & (df['timestamp'] < t1)]
        if len(train) < 500 or len(test) < 200 or test[target].nunique() < 2:
            continue
        m = make_model()
        m.fit(train[feats], train[target])
        p = m.predict_proba(test[feats])[:, 1]
        auc = roc_auc_score(test[target], p)
        top = test[target].values[np.argsort(p)[-max(1, len(p) // 10):]]
        rows.append((auc, top.mean(), test[target].mean(), len(test)))
    return rows


def report(tag, base_rows, whale_rows):
    print(f'\n=== {tag} ===')
    print(f'{"fold":<6}{"AUC base":<10}{"AUC +whale":<12}{"Δ AUC":<9}'
          f'{"top10% base":<13}{"top10% +wh":<12}{"base rate":<10}{"n":<7}')
    d_aucs, d_tops = [], []
    for i, (b, w) in enumerate(zip(base_rows, whale_rows)):
        d_auc, d_top = w[0] - b[0], w[1] - b[1]
        d_aucs.append(d_auc); d_tops.append(d_top)
        print(f'{i+1:<6}{b[0]:<10.4f}{w[0]:<12.4f}{d_auc:<+9.4f}'
              f'{b[1]:<13.3f}{w[1]:<12.3f}{b[2]:<10.3f}{b[3]:<7}')
    if d_aucs:
        consistent = all(d > 0 for d in d_aucs)
        print(f'mean Δ AUC {np.mean(d_aucs):+.4f} | mean Δ top-decile {np.mean(d_tops):+.4f} '
              f'| positive in {sum(d > 0 for d in d_aucs)}/{len(d_aucs)} folds'
              f'{"  ← CONSISTENT" if consistent else ""}')


def univariate(df):
    print('\n=== Univariate whale-feature AUC vs targets (0.5 = nothing) ===')
    for f in WHALE_FEATURES:
        try:
            a_g = roc_auc_score(df['goodR'], df[f])
            a_t = roc_auc_score(df['tail4'], df[f])
            print(f'  {f:<18} goodR {a_g:.4f} ({abs(a_g-.5):.4f} from chance) | '
                  f'tail4 {a_t:.4f} ({abs(a_t-.5):.4f})')
        except Exception as e:
            print(f'  {f}: {e}')


def importance(df, target):
    m = make_model()
    feats = FEATURES + WHALE_FEATURES
    m.fit(df[feats], df[target])
    imp = pd.Series(m.booster_.feature_importance('gain'), index=feats).sort_values(ascending=False)
    ranks = {f: int(np.where(imp.index == f)[0][0]) + 1 for f in WHALE_FEATURES}
    share = imp[WHALE_FEATURES].sum() / imp.sum() * 100
    print(f'\n=== Gain importance ({target}, full-fit diagnostic only) ===')
    print(f'  whale share of total gain: {share:.1f}% ({len(WHALE_FEATURES)}/{len(feats)} features = '
          f'{len(WHALE_FEATURES)/len(feats)*100:.1f}% of columns)')
    for f, r in sorted(ranks.items(), key=lambda x: x[1]):
        print(f'  {f:<18} rank {r}/{len(feats)}')


def main():
    print('Loading + joining…')
    df = load_joined()
    print(f'\nTotal: {len(df)} bars, {df.symbol.nunique()} symbols | '
          f'goodR base {df.goodR.mean():.3f} | tail4 base {df.tail4.mean():.3f}')

    univariate(df)

    for target in ('goodR', 'tail4'):
        base = wf_eval(df, FEATURES, target)
        wh = wf_eval(df, FEATURES + WHALE_FEATURES, target)
        report(f'Walk-forward, all 4h bars — target {target}', base, wh)

    # Canonical daily downsample (1 bar/symbol/day) — kills 24h label overlap.
    dd = df.copy()
    dd['date'] = pd.to_datetime(dd['timestamp'], unit='s').dt.date
    dd = dd.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)
    print(f'\nDaily-downsampled: {len(dd)} bars')
    for target in ('goodR', 'tail4'):
        base = wf_eval(dd, FEATURES, target, purge=8)
        wh = wf_eval(dd, FEATURES + WHALE_FEATURES, target, purge=8)
        report(f'Walk-forward, daily downsample — target {target}', base, wh)

    importance(df, 'goodR')
    importance(df, 'tail4')

    print('\nVerdict guide: whale features EARN a place only if Δ AUC > 0 in (nearly) all folds '
          'on BOTH samplings, with top-decile precision not degraded. Otherwise → graveyard.')


if __name__ == '__main__':
    main()
