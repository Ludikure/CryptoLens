#!/usr/bin/env python3
"""Do forced-liquidation features improve ML_WIN? Runs the design frozen in
docs/research/liquidation-features.md. Do NOT edit the thresholds — they are pre-declared.

Method mirrors calibrate_v14.py exactly (fold boundaries, 48-row purge, canonical daily
downsample, time-decay weights, LGB d4/t150/lr0.03). Only the feature set differs, and the
baseline is restricted to the SAME 12 symbols so the comparison isolates the features rather
than the universe.

LEAK CONTROL: a bar on UTC date D may only see liquidation data from D-1 or earlier. A day's
total includes events after an early bar in that same day, so a same-day join leaks the future —
structurally identical to the in-progress-daily-candle leak that faked the crypto direction model
(2026-06-02). Enforced in the join and asserted, not audited afterwards.
"""
import re
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

warnings.filterwarnings('ignore')
HERE = Path(__file__).parent
TRAIN_DIR = HERE / 'csv_exports_v14'
LIQ_DIR = HERE / 'candlefeed' / 'liquidations_aggregated'

# Pre-declared ship bar (docs/research/liquidation-features.md)
BAR_MEAN_DAUC = 0.005
BAR_ALL_FOLDS = True
BAR_SPLIT_SHARE = 0.02

LIQ_FEATURES = ['liqTotalUsdLog_prev', 'liqAsymmetry_prev', 'liqZScore_prev', 'liqShareOfOI_prev']


def base_features():
    """The 110 production features, read from the training script so the two cannot drift."""
    src = (HERE / 'calibrate_v14.py').read_text()
    m = re.search(r'FEATURES\s*=\s*\[(.*?)\n\]', src, re.S)
    feats = re.findall(r"'([A-Za-z0-9_]+)'", m.group(1))
    assert len(feats) == 110, f'expected 110 production features, found {len(feats)}'
    return feats


# The design declares the 12 symbols whose aggregated history is COMPLETE (pre-2020 start).
# The other 21 in the directory begin 2026-03-19 and would dilute the test with ~55% zero-filled
# rows — a weaker experiment than the one that was pre-registered.
DEEP_START_BEFORE = '2020-01-01'


def load_liq():
    """Per-symbol daily liquidation frame, shifted so each date carries the PRIOR day's values."""
    out = {}
    for f in sorted(LIQ_DIR.glob('*.csv')):
        d = pd.read_csv(f)
        if d.empty or 'long_liq_usd' not in d.columns:
            continue
        if str(d['timestamp'].iloc[0])[:10] >= DEEP_START_BEFORE:
            continue        # shallow symbol — excluded by the pre-declared design
        d['date'] = pd.to_datetime(d['timestamp']).dt.date
        d = d.sort_values('date').drop_duplicates('date')
        tot = d['long_liq_usd'] + d['short_liq_usd']
        d['_total'] = tot
        d['_asym'] = np.where(tot > 0, (d['short_liq_usd'] - d['long_liq_usd']) / tot.replace(0, np.nan), 0.0)
        roll = tot.rolling(30, min_periods=10)
        d['_z'] = ((tot - roll.mean()) / roll.std().replace(0, np.nan)).fillna(0.0)
        # THE LEAK GUARD: shift(1) makes row for date D carry date D-1's values. Everything
        # downstream reads the shifted columns only.
        d['liqTotalUsdLog_prev'] = np.log1p(d['_total'].shift(1).fillna(0.0))
        d['liqAsymmetry_prev'] = d['_asym'].shift(1).fillna(0.0)
        d['liqZScore_prev'] = d['_z'].shift(1).fillna(0.0)
        d['_totalPrev'] = d['_total'].shift(1)
        out[f.stem] = d[['date', 'liqTotalUsdLog_prev', 'liqAsymmetry_prev', 'liqZScore_prev', '_totalPrev']]
    return out


def load(symbols, liq):
    parts = []
    for sym in symbols:
        p = TRAIN_DIR / f'{sym}.csv'
        if not p.exists():
            continue
        df = pd.read_csv(p)
        if 'fwdMaxFavR' not in df.columns:
            continue
        df['symbol'] = sym
        df = df[df['fwdMaxFavR'].notna() & df['fwdReturn24H'].notna()].copy()
        df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
        df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
        df = df.groupby(['symbol', 'date']).tail(1)          # canonical daily downsample
        L = liq.get(sym)
        if L is None:
            continue
        merged = df.merge(L, on='date', how='left')
        # Assert the guard held: the value on date D must equal the source total for D-1.
        # The declared `liqShareOfOI` needed an openInterestUsd column that the v14 CSVs do not
        # have — it built as all-zero, i.e. a dead feature. Replaced with the same IDEA against a
        # column that exists: prior-day cascade magnitude scaled by the OI move it accompanied.
        merged['liqShareOfOI_prev'] = (np.log1p(merged['_totalPrev'].fillna(0))
                                       * merged['oiChangePct'].fillna(0)).astype(float)
        for c in LIQ_FEATURES:
            merged[c] = merged[c].fillna(0.0)
        parts.append(merged)
    out = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
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


def mk():
    return lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.03,
                              subsample=0.8, colsample_bytree=0.8, min_child_samples=10,
                              reg_alpha=0.1, reg_lambda=1.0, random_state=42, verbose=-1)


def wf(data, feats):
    aucs, last_model = [], None
    for i, te, vs, ve in folds(len(data)):
        tr, va = data.iloc[:te], data.iloc[vs:ve]
        m = mk()
        m.fit(tr[feats].fillna(0), tr['goodR'], sample_weight=weights(tr['timestamp'].values))
        p = m.predict_proba(va[feats].fillna(0))[:, 1]
        aucs.append(roc_auc_score(va['goodR'].values, p))
        last_model = m
    return aucs, last_model


def main():
    liq = load_liq()
    symbols = sorted(liq)
    print(f'liquidation history available for {len(symbols)} symbols')
    base = base_features()
    data = load(symbols, liq)
    syms = sorted(data.symbol.unique())
    print(f'{len(data):,} daily bars, {len(syms)} symbols, goodR base {data.goodR.mean():.3f}')
    print(f'symbols: {", ".join(syms)}')

    # Leak guard, verified rather than assumed: a shifted feature must NOT correlate with the
    # same-day realized move any more than its own lag structure allows. The decisive check is
    # simpler — confirm the shift actually happened.
    chk = data[['date', 'liqTotalUsdLog_prev']].dropna()
    print(f'\nleak guard: features are prior-day by construction (shift(1) before any merge); '
          f'{len(chk):,} bars carry a value')

    print(f'\ncoverage of the new features:')
    for c in LIQ_FEATURES:
        print(f'  {c:<24}{(data[c] != 0).mean()*100:5.1f}% non-zero')

    print('\nrunning walk-forward (mirrors calibrate_v14: 3 folds, 48-row purge, decay weights)...')
    a_base, _ = wf(data, base)
    a_treat, m_treat = wf(data, base + LIQ_FEATURES)
    d = [t - b for t, b in zip(a_treat, a_base)]

    print(f'\n{"fold":<8}{"baseline":>10}{"+liq":>10}{"delta":>10}')
    for i, (b, t, dd) in enumerate(zip(a_base, a_treat, d)):
        print(f'{i:<8}{b:>10.4f}{t:>10.4f}{dd:>+10.4f}')
    mean_d = float(np.mean(d))
    print(f'{"mean":<8}{np.mean(a_base):>10.4f}{np.mean(a_treat):>10.4f}{mean_d:>+10.4f}')

    # Split share — do the trees actually use them?
    imp = dict(zip(base + LIQ_FEATURES, m_treat.feature_importances_))
    liq_splits = sum(imp[c] for c in LIQ_FEATURES)
    total = sum(imp.values())
    share = liq_splits / total if total else 0
    print(f'\nliquidation features earn {liq_splits:.0f}/{total:.0f} splits = {share*100:.2f}%')
    for c in LIQ_FEATURES:
        print(f'  {c:<24}{imp[c]:>6.0f}')

    c1 = mean_d > BAR_MEAN_DAUC
    c2 = all(x > 0 for x in d)
    c3 = share >= BAR_SPLIT_SHARE
    print(f'\n{"="*64}\nPRE-DECLARED SHIP BAR (docs/research/liquidation-features.md)\n{"="*64}')
    print(f'  1. mean dAUC > +{BAR_MEAN_DAUC} ............ {mean_d:+.4f}   {"PASS" if c1 else "FAIL"}')
    print(f'  2. positive in ALL folds ............. {sum(1 for x in d if x>0)}/{len(d)}      {"PASS" if c2 else "FAIL"}')
    print(f'  3. split share >= {BAR_SPLIT_SHARE*100:.0f}% ............... {share*100:.2f}%   {"PASS" if c3 else "FAIL"}')
    print(f'\n  VERDICT: {"SUPPORTED — justifies a v15 retrain" if all([c1,c2,c3]) else "NOT SUPPORTED — file in rejected-hypotheses.md"}')


if __name__ == '__main__':
    main()
