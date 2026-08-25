#!/usr/bin/env python3
"""Is the excursion model SELECTING ASSETS, or is it TIMING THE MARKET?

Feature importance says the top five splits are ethBtcRatio, dxyMomentum, vixTermStructure, vix and
fearGreedIndex -- every one of which is MARKET-WIDE, identical across all 24 symbols at a given
timestamp. A model built mostly on those cannot be ranking assets against each other; it is reading
one shared state and applying it everywhere.

That invalidates the earlier Control 3. It pooled its deciles across symbols AND time, so its
"top decile" was largely "the worst days" -- market timing wearing cross-sectional clothes. The same
class of error as the T3 non-independence mistake, where 34,821 rows turned out to be 684 real
observations because the feature was market-wide.

THREE TESTS THAT SEPARATE THE TWO:

  A. WITHIN-TIMESTAMP long-short. Rank assets against each other at EACH timestamp and trade top
     minus bottom. Market-wide state is identical for both legs, so it cancels exactly. Whatever
     survives is genuine asset selection.
  B. MARKET-WIDE ONLY vs ASSET-SPECIFIC ONLY. Train on each block alone and compare both AUC axes.
  C. EFFECTIVE SAMPLE SIZE. If the signal is market-wide, n is the number of TIMESTAMPS, not rows.
"""
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

R, PURGE, FEE = 5.0, 24, 0.171
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)

# Identical for every symbol at a timestamp: macro, cross-asset, sentiment and calendar.
MARKET_WIDE_KEYS = ('vix', 'dxy', 'feargreed', 'ethbtc', 'spy', 'iwm', 'dayofweek',
                    'isweekend', 'hourbucket', 'volscalar')


def is_market_wide(col: str, df: pd.DataFrame) -> bool:
    """Confirmed empirically, not by name: does it vary across symbols within a timestamp?"""
    s = df.groupby('timestamp')[col].nunique()
    return float(s.mean()) < 1.05


def main():
    df = (pd.read_pickle('excursion_dataset.pkl.gz')
            .merge(pd.read_pickle('excursion_payoff_rows.pkl.gz'), on=['symbol', 'timestamp'])
            .sort_values('timestamp').reset_index(drop=True))
    feats = [c for c in df.columns if c.startswith('f_') and c != 'f_timestamp'
             and not c.startswith(('f_fwd', 'f_trade')) and pd.api.types.is_numeric_dtype(df[c])]
    df['fee_r'] = FEE / df['f_atrPercent'].clip(lower=0.05)

    # Classify features by measured behaviour on a sample of well-populated timestamps.
    samp = df[df.timestamp.isin(df.timestamp.value_counts().head(2000).index)]
    mw = [c for c in feats if is_market_wide(c, samp)]
    asf = [c for c in feats if c not in mw]
    print(f'{len(feats)} features: {len(mw)} MARKET-WIDE (identical across symbols), '
          f'{len(asf)} asset-specific')
    print(f'  market-wide includes: {", ".join(c[2:] for c in mw[:10])}\n')

    y = f'hit_SHORT_{R:g}R'
    rc = f'r_SHORT_{R:g}R'
    uniq = np.unique(df.timestamp.values)
    cut, pg = uniq[int(len(uniq) * .70)], uniq[min(int(len(uniq) * .70) + PURGE, len(uniq) - 1)]
    trn, tst = df[df.timestamp <= cut], df[df.timestamp > pg].copy()

    # ---------- B: which block carries the signal? ----------
    print('TEST B -- train on each feature block alone')
    print(f'{"feature block":>20}{"per-symbol AUC":>17}{"within-ts AUC":>16}')
    scores = {}
    for name, cols in (('all', feats), ('market-wide only', mw), ('asset-specific only', asf)):
        m = lgb.LGBMClassifier(**PARAMS).fit(trn[cols], trn[y])
        s = m.predict_proba(tst[cols])[:, 1]
        scores[name] = s
        t = tst.assign(sc=s)
        per = np.mean([roc_auc_score(g[y], g.sc) for _, g in t.groupby('symbol') if g[y].nunique() == 2])
        xs = [roc_auc_score(g[y], g.sc) for _, g in t.groupby('timestamp')
              if len(g) >= 5 and g[y].nunique() == 2]
        print(f'{name:>20}{per:>17.4f}{np.mean(xs):>16.4f}')
    tst['score'] = scores['all']

    # ---------- A: within-timestamp long-short ----------
    print('\nTEST A -- within-timestamp long/short (market-wide state cancels between the legs)')
    g = tst.groupby('timestamp')
    tst['rank'] = g['score'].rank(pct=True)
    n_per_ts = g.size()
    ok_ts = n_per_ts[n_per_ts >= 8].index
    w = tst[tst.timestamp.isin(ok_ts)]
    top = w[w['rank'] >= 0.80]
    bot = w[w['rank'] <= 0.20]
    # Short the top-ranked, and take the OPPOSITE side of the bottom-ranked, so the market leg nets out.
    ls = top[rc].mean() - bot[rc].mean()
    print(f'  timestamps with >= 8 assets: {len(ok_ts):,}')
    print(f'  short top-20%   {top[rc].mean():+.4f}R gross   (n={len(top):,})')
    print(f'  short bottom-20%{bot[rc].mean():+.4f}R gross   (n={len(bot):,})')
    print(f'  SPREAD (pure asset selection, market cancels): {ls:+.4f}R')
    print(f'  vs the earlier POOLED spread which mixed in timing: +0.4427R')

    # Per-timestamp spread, so the sign can be counted rather than averaged.
    sp = []
    for ts, gg in w.groupby('timestamp'):
        t20, b20 = gg[gg['rank'] >= 0.80], gg[gg['rank'] <= 0.20]
        if len(t20) and len(b20):
            sp.append(t20[rc].mean() - b20[rc].mean())
    sp = np.array(sp)
    print(f'  per-timestamp spread: mean {sp.mean():+.4f}R  median {np.median(sp):+.4f}R  '
          f'{(sp > 0).mean():.1%} positive  (n={len(sp):,})')

    # ---------- C: effective sample size ----------
    print('\nTEST C -- effective sample size')
    print(f'  rows in holdout           {len(tst):,}')
    print(f'  distinct timestamps       {tst.timestamp.nunique():,}')
    print(f'  ratio                     {len(tst)/tst.timestamp.nunique():.1f} rows per timestamp')
    print(f'  -> a market-wide signal has n = timestamps, so any p-value computed on rows is '
          f'overstated by ~sqrt({len(tst)/tst.timestamp.nunique():.0f}) = '
          f'{np.sqrt(len(tst)/tst.timestamp.nunique()):.1f}x')


if __name__ == '__main__':
    main()
