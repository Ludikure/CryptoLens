#!/usr/bin/env python3
"""
Setup-execution backtest v4 — adds a stretched-name exclusion filter on top
of v3's 5-fold WF.

Hypothesis (from fold5_investigation.py): fold-5's negative ML-filtered EV
is driven by a cluster of stretched mega-caps (MRK, MCD, BA, META, NVDA,
TGT, PLTR, ITW, TEAM, SLB) where the model misreads late-bull exhaustion
as continuation. A simple exclusion rule using features already in the CSV
should remove most of those losses without touching winners.

Filter variants tested:
  - baseline:    no stretched filter
  - 52w>=95:     skip if price >= 95th pct of 52-week range
  - dRsi>=70:    skip if daily RSI >= 70
  - last3=3:     skip if last 3 candles all closed green
  - 52w + RSI:   both 52w>=95 AND dRsi>=70
  - all three:   52w>=95 AND dRsi>=70 AND last3Green>=2 (cheap intervention)
  - all strict:  52w>=95 AND dRsi>=70 AND last3Green==3 (original hypothesis)

For each variant: aggregate + per-fold EV, plus per-symbol effect on fold-5
to confirm the filter removes the right names.

Run:  python3 setup_execution_backtest_v4.py
Prerequisite: ./stock_candles_4h.csv.gz (run fetch_stock_candles.py first).
"""
import glob
import os
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

CSV_DIR = os.path.join(os.path.dirname(__file__), 'csv_exports_v13')
CANDLES_PATH = os.path.join(os.path.dirname(__file__), 'stock_candles_4h.csv.gz')
ML_THRESHOLD = 0.65
SL_ATR = 1.0
TP_ATR = 1.5
HORIZON_BARS = 6
N_FOLDS = 5
PURGE_BARS = 48

FEATURES = [
    'dRsi', 'dMacdHist', 'dAdx', 'dAdxBullish',
    'dEmaCross', 'dStackBull', 'dStackBear', 'dStructBull', 'dStructBear',
    'dStochK', 'dStochCross', 'dMacdCross', 'dDivergence', 'dEma20Rising',
    'dBBPercentB', 'dBBSqueeze', 'dBBBandwidth', 'dVolumeRatio', 'dAboveVwap',
    'hRsi', 'hMacdHist', 'hAdx', 'hAdxBullish',
    'hEmaCross', 'hStackBull', 'hStackBear', 'hStructBull', 'hStructBear',
    'hStochK', 'hStochCross', 'hMacdCross', 'hDivergence', 'hEma20Rising',
    'hBBPercentB', 'hBBSqueeze', 'hBBBandwidth', 'hVolumeRatio', 'hAboveVwap',
    'eRsi', 'eEmaCross', 'eStochK', 'eMacdHist',
    'fundingSignal', 'oiSignal', 'takerSignal', 'crowdingSignal', 'derivativesCombined',
    'fundingRateRaw', 'oiChangePct', 'takerRatioRaw', 'longPctRaw',
    'vix', 'dxyAboveEma20', 'volScalarML',
    'last3Green', 'last3Red', 'last3VolIncreasing',
    'obvRising', 'adLineAccumulation',
    'atrPercent', 'atrPercentile',
    'tfAlignment', 'momentumAlignment', 'structureAlignment',
    'dayOfWeek', 'barsSinceRegimeChange', 'regimeCode',
    'dRsiDelta', 'dAdxDelta', 'hRsiDelta', 'hAdxDelta', 'hMacdHistDelta',
    'fearGreedIndex', 'fearGreedZone',
    'ethBtcRatio', 'ethBtcDelta6',
    'basisPct', 'basisExtreme',
    'fiftyTwoWeekPct', 'distToFiftyTwoHigh',
    'gapPercent', 'gapFilled', 'gapDirectionAligned',
    'relStrengthVsSpy', 'beta', 'vixLevelCode', 'isMarketHours',
    'vpDistToPocATR', 'vpAbovePoc', 'vpVAWidth', 'vpInValueArea',
    'vpDistToVAH_ATR', 'vpDistToVAL_ATR',
    'hRsiDelta1', 'hMacdHistDelta1', 'dRsiDelta1',
    'hRsiAccel', 'hMacdAccel', 'dAdxAccel',
    'hourBucket', 'isWeekend',
    'earningsProximity',
    'shortVolumeRatio', 'shortVolumeZScore',
    'oiPriceInteraction', 'fundingSlope', 'bodyWickRatio',
    'relStrengthVsSector', 'vixTermStructure', 'dxyMomentum', 'iwmSpyRatio',
]


def load_features():
    files = sorted(glob.glob(os.path.join(CSV_DIR, '*.csv')))
    print(f"Loading {len(files)} stock feature CSVs...")
    dfs = [pd.read_csv(f) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[df['fwdMaxFavR'].notna() & (df['atrPercent'].fillna(0) > 0)]
    df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
    for col in ('basisPct', 'basisExtreme'):
        if col not in df.columns:
            df[col] = 0.0
    df = df.sort_values('timestamp').reset_index(drop=True)
    df['ts_ms'] = df['timestamp'] * 1000
    return df


def load_candles():
    return pd.read_csv(CANDLES_PATH)


def build_candle_index(candles):
    idx = {}
    for sym, group in candles.groupby('symbol'):
        g = group.sort_values('timestamp').reset_index(drop=True)
        idx[sym] = {
            'ts': g['timestamp'].values,
            'open': g['open'].values, 'high': g['high'].values,
            'low': g['low'].values,   'close': g['close'].values,
        }
    return idx


def resolve_fill(direction, entry, sl, tp, block):
    highs, lows, opens, closes = block['high'], block['low'], block['open'], block['close']
    n = min(HORIZON_BARS, len(highs))
    for i in range(n):
        if direction == 1:
            sl_hit, tp_hit = lows[i] <= sl, highs[i] >= tp
        else:
            sl_hit, tp_hit = highs[i] >= sl, lows[i] <= tp
        if sl_hit and tp_hit:
            up = closes[i] >= opens[i]
            hit = ('tp' if up else 'sl') if direction == 1 else ('tp' if not up else 'sl')
            return TP_ATR if hit == 'tp' else -SL_ATR
        if tp_hit: return TP_ATR
        if sl_hit: return -SL_ATR
    if n == 0: return None
    move = (closes[n-1] - entry) * direction
    atr_unit = (tp - entry) / TP_ATR if direction == 1 else (entry - tp) / TP_ATR
    return float(np.clip(move / atr_unit, -SL_ATR, TP_ATR))


def resolve_aligned_bullish(rows, candle_idx):
    """Bar-by-bar resolve every aligned_bullish row in `rows`, returning a
    DataFrame with R + the input feature columns preserved (so we can apply
    post-hoc filters without re-resolving)."""
    out = []
    for _, row in rows.iterrows():
        if row['biasAlignment'] != 'aligned_bullish': continue
        sym = row['symbol']
        if sym not in candle_idx: continue
        atr_pct = row['atrPercent']
        if atr_pct <= 0: continue
        entry = row['price']
        atr_price = entry * atr_pct / 100.0
        sl, tp = entry - atr_price * SL_ATR, entry + atr_price * TP_ATR
        cdata = candle_idx[sym]
        i = np.searchsorted(cdata['ts'], row['ts_ms'], side='right')
        if i >= len(cdata['ts']): continue
        block = {k: cdata[k][i:i+HORIZON_BARS] for k in ('open','high','low','close')}
        if len(block['high']) == 0: continue
        r = resolve_fill(1, entry, sl, tp, block)
        if r is None: continue
        out.append({
            'symbol': sym,
            'fold': row['fold'],
            'mlProb': row['mlProb'],
            'R': r,
            # Filter inputs — keep both the stretched-hypothesis features
            # (didn't pan out) and the confirmation-hypothesis features.
            'fiftyTwoWeekPct': row['fiftyTwoWeekPct'],
            'dRsi': row['dRsi'],
            'last3Green': row['last3Green'],
            'relStrengthVsSpy': row['relStrengthVsSpy'],
            'dRsiDelta': row['dRsiDelta'],
            'atrPercentile': row['atrPercentile'],
        })
    return pd.DataFrame(out)


def make_model():
    return xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def walk_forward(df, candle_idx):
    n = len(df)
    all_results = []
    for i in range(N_FOLDS):
        train_end = int(n * (0.25 + i * 0.15))
        val_start = train_end + PURGE_BARS
        val_end = int(n * (0.40 + i * 0.15)) if i < N_FOLDS - 1 else n
        train = df.iloc[:train_end]
        val = df.iloc[val_start:val_end].copy()
        val['fold'] = i + 1
        m = make_model()
        m.fit(train[FEATURES].fillna(0), train['goodR'])
        val['mlProb'] = m.predict_proba(val[FEATURES].fillna(0))[:, 1]
        print(f"  fold {i+1}: resolving setups...")
        fold_r = resolve_aligned_bullish(val, candle_idx)
        all_results.append(fold_r)
    return pd.concat(all_results, ignore_index=True)


def summarize(name, mask, df):
    sub = df[mask]
    n = len(sub)
    if n == 0:
        return f"  {name:<36} n=     0   skipped"
    win = (sub['R'] > 0).mean() * 100
    ev = sub['R'].mean()
    cum = sub['R'].sum()
    sign = '+' if ev >= 0 else ''
    return (f"  {name:<36} n={n:>6,}  win={win:>4.1f}%  "
            f"EV={sign}{ev:>+5.3f}R  cumR={cum:>+7.1f}")


def main():
    df = load_features()
    candles = load_candles()
    candle_idx = build_candle_index(candles)
    print(f"\n5-fold WF, resolving aligned_bullish setups...")
    results = walk_forward(df, candle_idx)
    print(f"\n  resolved: {len(results):,} aligned_bullish setups across 5 folds")

    hi_ml = results['mlProb'] >= ML_THRESHOLD

    # Each filter is a boolean mask of bars to KEEP (i.e., the filter rejects
    # when the stretched conditions are met).
    # Filters mask in `True = keep`. The "stretched" hypothesis (high 52w/RSI)
    # didn't catch fold-5 losers — both losers and winners had median 52w/RSI.
    # Revised hypothesis (from fold5_feature_diagnostic.py): losers lack momentum
    # confirmation. Require relStrengthVsSpy and dRsiDelta to be positive.
    filters = {
        'baseline (no filter)':       pd.Series(True, index=results.index),
        'relStrSpy>=0':               results['relStrengthVsSpy'] >= 0,
        'relStrSpy>=1':               results['relStrengthVsSpy'] >= 1,
        'dRsiDelta>=1':               results['dRsiDelta'] >= 1,
        'atrPctl>=25':                results['atrPercentile'] >= 25,
        'relStrSpy>=1 AND dRsiDelta>=1':
            (results['relStrengthVsSpy'] >= 1) & (results['dRsiDelta'] >= 1),
        'relStrSpy>=1 AND atrPctl>=25':
            (results['relStrengthVsSpy'] >= 1) & (results['atrPercentile'] >= 25),
        'all 3 confirmations':
            (results['relStrengthVsSpy'] >= 1) & (results['dRsiDelta'] >= 1) & (results['atrPercentile'] >= 25),
        # Loosen thresholds — maybe strict >=1 is too restrictive
        'relStrSpy>=0.5 AND dRsiDelta>=0.5':
            (results['relStrengthVsSpy'] >= 0.5) & (results['dRsiDelta'] >= 0.5),
    }

    # --- Aggregate across all folds, ML>=0.65 only ---
    print(f"\n=== Aggregate (all folds, aligned_bullish + ML >= {ML_THRESHOLD}) ===")
    print(f"  filter                              n      win%    EV(R)         cumR")
    print(f"  " + "-"*72)
    for name, keep_mask in filters.items():
        print(summarize(name, hi_ml & keep_mask, results))

    # --- Per-fold breakdown for the top candidates ---
    candidates_to_breakdown = [
        'baseline (no filter)',
        'relStrSpy>=1',
        'dRsiDelta>=1',
        'atrPctl>=25',
        'relStrSpy>=1 AND dRsiDelta>=1',
        'all 3 confirmations',
        'relStrSpy>=0.5 AND dRsiDelta>=0.5',
    ]
    print(f"\n=== Per-fold breakdown (aligned_bullish + ML >= {ML_THRESHOLD}) ===")
    print(f"  filter                                   fold1     fold2     fold3     fold4     fold5")
    print(f"  " + "-"*102)
    for name in candidates_to_breakdown:
        keep = filters[name]
        parts = []
        for f in range(1, 6):
            sub = results[(results['fold'] == f) & hi_ml & keep]
            if len(sub) == 0:
                parts.append("    n=0   ")
                continue
            ev = sub['R'].mean()
            sign = '+' if ev >= 0 else ''
            parts.append(f"n={len(sub):>4} {sign}{ev:>+5.3f}")
        print(f"  {name:<40} " + "  ".join(parts))

    # --- Fold-5 per-symbol diff: what got filtered? ---
    strict_filter = filters['relStrSpy>=1 AND dRsiDelta>=1']
    f5_all = results[(results['fold'] == 5) & hi_ml]
    f5_kept = results[(results['fold'] == 5) & hi_ml & strict_filter]
    f5_removed = results[(results['fold'] == 5) & hi_ml & ~strict_filter]
    print(f"\n=== Fold-5 effect of 'relStrSpy>=1 AND dRsiDelta>=1' filter ===")
    print(f"  before filter: n={len(f5_all)}   EV={f5_all['R'].mean():+.3f}R   cumR={f5_all['R'].sum():+.1f}")
    print(f"  after filter:  n={len(f5_kept)}   EV={f5_kept['R'].mean():+.3f}R   cumR={f5_kept['R'].sum():+.1f}")
    print(f"  removed:       n={len(f5_removed)}   EV={f5_removed['R'].mean():+.3f}R   cumR={f5_removed['R'].sum():+.1f}")
    if len(f5_removed) > 0:
        sym_removed = f5_removed['symbol'].value_counts().head(15)
        print(f"\n  Top symbols removed by the filter (the stretched bucket):")
        for sym, cnt in sym_removed.items():
            sub = f5_removed[f5_removed['symbol'] == sym]
            ev = sub['R'].mean()
            sign = '+' if ev >= 0 else ''
            print(f"    {sym:<10} count={cnt:>2}   EV={sign}{ev:>+5.3f}R   cumR={sub['R'].sum():>+5.1f}")


if __name__ == '__main__':
    main()
