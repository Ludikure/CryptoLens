#!/usr/bin/env python3
"""
Why does the ML filter help longs in folds 1-4 (+0.04 to +0.36R) but turn
negative in fold 5 (-0.069R)? Four diagnostics:

1. Per-fold feature importance — does the model key on different features?
2. ML calibration drift — at prob>=0.65, does actual goodR rate match across folds?
3. Symbol concentration in fold-5 high-ML bucket — clustered in a few names?
4. Per-symbol contribution to fold-5 EV — which names are dragging it negative?

Run:  python3 fold5_investigation.py
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

# Same 111-feature list as the production model (verbatim from
# calibrate_v13_stocks.py — kept in sync manually).
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


def resolve_setups(rows, candle_idx, only_long=True):
    out = []
    for _, row in rows.iterrows():
        align = row['biasAlignment']
        if only_long and align != 'aligned_bullish': continue
        if align not in ('aligned_bullish', 'aligned_bearish'): continue
        sym = row['symbol']
        if sym not in candle_idx: continue
        atr_pct = row['atrPercent']
        if atr_pct <= 0: continue
        entry = row['price']
        atr_price = entry * atr_pct / 100.0
        if align == 'aligned_bullish':
            direction, sl, tp = 1, entry - atr_price, entry + atr_price * TP_ATR
        else:
            direction, sl, tp = -1, entry + atr_price, entry - atr_price * TP_ATR
        cdata = candle_idx[sym]
        i = np.searchsorted(cdata['ts'], row['ts_ms'], side='right')
        if i >= len(cdata['ts']): continue
        block = {k: cdata[k][i:i+HORIZON_BARS] for k in ('open','high','low','close')}
        if len(block['high']) == 0: continue
        r = resolve_fill(direction, entry, sl, tp, block)
        if r is None: continue
        out.append({'symbol': sym, 'mlProb': row['mlProb'], 'R': r, 'goodR_actual': row['goodR']})
    return pd.DataFrame(out)


def make_model():
    return xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def main():
    df = load_features()
    print(f"  feature bars: {len(df):,}")
    candle_idx = build_candle_index(load_candles())

    n = len(df)
    fold_models = []
    fold_results = {}

    print(f"\n--- Per-fold ML training + setup resolution ---")
    for i in range(N_FOLDS):
        train_end = int(n * (0.25 + i * 0.15))
        val_start = train_end + PURGE_BARS
        val_end = int(n * (0.40 + i * 0.15)) if i < N_FOLDS - 1 else n
        train = df.iloc[:train_end]
        val = df.iloc[val_start:val_end].copy()
        m = make_model()
        m.fit(train[FEATURES].fillna(0), train['goodR'])
        val['mlProb'] = m.predict_proba(val[FEATURES].fillna(0))[:, 1]
        fold_models.append((i + 1, m, val))
        # Resolve aligned_bullish setups only.
        results = resolve_setups(val, candle_idx, only_long=True)
        fold_results[i + 1] = results
        val_start_dt = pd.to_datetime(val['timestamp'].iloc[0], unit='s').date()
        val_end_dt = pd.to_datetime(val['timestamp'].iloc[-1], unit='s').date()
        print(f"  fold {i+1} ({val_start_dt} → {val_end_dt}): "
              f"{len(results):,} aligned_bullish setups resolved")

    # ─── Diagnostic 1: per-fold feature importance ───
    print(f"\n=== 1. Top-15 features by importance, per fold ===")
    # Build a table of feature → fold_importances
    fi_table = {}
    for fold_idx, m, _ in fold_models:
        importances = list(zip(FEATURES, m.feature_importances_))
        importances.sort(key=lambda x: x[1], reverse=True)
        for rank, (name, score) in enumerate(importances[:15], 1):
            fi_table.setdefault(name, {})[fold_idx] = (rank, score)
    # Show features that appear in top-15 of any fold
    print(f"  {'feature':<28} fold1   fold2   fold3   fold4   fold5")
    print(f"  " + "-"*68)
    # Sort by sum of importances across folds where it appeared
    feats_sorted = sorted(fi_table.items(),
                          key=lambda kv: -sum(v[1] for v in kv[1].values()))
    for name, by_fold in feats_sorted[:25]:
        parts = []
        for f in range(1, 6):
            if f in by_fold:
                rank, score = by_fold[f]
                parts.append(f"#{rank:<2} {score:.3f}")
            else:
                parts.append(f"  -    -  ")
        print(f"  {name:<28} {parts[0]:<7} {parts[1]:<7} {parts[2]:<7} {parts[3]:<7} {parts[4]}")

    # ─── Diagnostic 2: ML calibration drift across folds ───
    print(f"\n=== 2. ML calibration drift (does prob>=0.65 still mean ~goodR>=0.65?) ===")
    print(f"  fold   n at prob>=0.65   actual goodR rate   actual long EV(R)")
    print(f"  " + "-"*72)
    for f, results in fold_results.items():
        hi = results[results['mlProb'] >= ML_THRESHOLD]
        n_hi = len(hi)
        if n_hi == 0:
            print(f"  {f}      n=0")
            continue
        actual_goodR = hi['goodR_actual'].mean() * 100
        ev = hi['R'].mean()
        sign = '+' if ev >= 0 else ''
        print(f"  {f}      n={n_hi:<5,}            {actual_goodR:>5.1f}%              EV={sign}{ev:>+5.3f}R")

    # ─── Diagnostic 3: Symbol concentration in fold-5 high-ML bucket ───
    f5 = fold_results[5]
    f5_hi = f5[f5['mlProb'] >= ML_THRESHOLD]
    print(f"\n=== 3. Symbol concentration in fold-5 aligned_bullish + ML>=0.65 (n={len(f5_hi)}) ===")
    top_syms = f5_hi['symbol'].value_counts().head(15)
    total = len(f5_hi)
    print(f"  symbol      count    % of fold5 high-ML")
    for sym, cnt in top_syms.items():
        pct = cnt / total * 100
        bar = '█' * int(pct)
        print(f"  {sym:<10}  {cnt:>4}    {pct:>5.1f}%  {bar}")
    n_unique = f5_hi['symbol'].nunique()
    print(f"  unique symbols: {n_unique} of 159 in universe")

    # Compare against fold 3 (best fold)
    f3 = fold_results[3]
    f3_hi = f3[f3['mlProb'] >= ML_THRESHOLD]
    print(f"\n  For comparison, fold-3 high-ML (n={len(f3_hi)}):")
    print(f"  unique symbols: {f3_hi['symbol'].nunique()} of 159")
    print(f"  top 5: {', '.join(f'{s}({c})' for s, c in f3_hi['symbol'].value_counts().head(5).items())}")

    # ─── Diagnostic 4: per-symbol contribution to fold-5 losses ───
    print(f"\n=== 4. Per-symbol R contribution in fold-5 aligned_bullish + ML>=0.65 ===")
    sym_summary = f5_hi.groupby('symbol').agg(
        n=('R', 'count'),
        win_rate=('R', lambda x: (x > 0).mean() * 100),
        ev=('R', 'mean'),
        cumR=('R', 'sum'),
    ).reset_index()
    # Top 10 contributors (best + worst)
    sym_summary_pos = sym_summary[sym_summary['n'] >= 5].sort_values('cumR', ascending=False)
    print(f"\n  WORST 10 by cumR (drag on fold-5 EV):")
    print(f"  symbol      n     win%    EV(R)     cumR")
    for _, row in sym_summary_pos.tail(10).iterrows():
        print(f"  {row['symbol']:<10}  {int(row['n']):>3}   {row['win_rate']:>4.1f}%  "
              f"{row['ev']:>+6.3f}R   {row['cumR']:>+6.1f}")
    print(f"\n  BEST 10 by cumR:")
    print(f"  symbol      n     win%    EV(R)     cumR")
    for _, row in sym_summary_pos.head(10).iterrows():
        print(f"  {row['symbol']:<10}  {int(row['n']):>3}   {row['win_rate']:>4.1f}%  "
              f"{row['ev']:>+6.3f}R   {row['cumR']:>+6.1f}")


if __name__ == '__main__':
    main()
