#!/usr/bin/env python3
"""
Setup-execution backtest v3 — 5-fold walk-forward across 2022-2026.

v2 ran a single 80/20 chronological split (test = 2025-03 → 2026-05). That's
bull-only and only one year, so the EV(LONG) > 0 and EV(SHORT, ML-filtered) > 0
findings could be regime-specific artifacts. v3 runs 5 expanding-window folds
covering the bear → recovery → bull arc and reports per-fold + aggregate.

Fold structure (matches calibrate_direction_stocks.py's recipe):
  fold 1: train 0→25%, val 25→40%   (≈ 2022 bear)
  fold 2: train 0→40%, val 40→55%   (≈ 2022-12 → 2023-10 recovery)
  fold 3: train 0→55%, val 55→70%   (≈ 2023-10 → 2024-08 early bull)
  fold 4: train 0→70%, val 70→85%   (≈ 2024-08 → 2025-07 bull)
  fold 5: train 0→85%, val 85→100%  (≈ 2025-07 → 2026-05 bull)

Setup definition + bar-by-bar fill resolution: identical to v2.

Run:  python3 setup_execution_backtest_v3.py
Prerequisite: ./stock_candles_4h.csv.gz spanning 2022→2026 (see fetch_stock_candles.py).
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
PURGE_BARS = 48  # gap between train and val to prevent target leakage

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
    if not files:
        sys.exit(f"No CSVs in {CSV_DIR}")
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
    print(f"  feature bars: {len(df):,}  | symbols: {df['symbol'].nunique()}  | "
          f"{pd.to_datetime(df['timestamp'].min(), unit='s').date()} → "
          f"{pd.to_datetime(df['timestamp'].max(), unit='s').date()}")
    return df


def load_candles():
    if not os.path.exists(CANDLES_PATH):
        sys.exit(f"Missing {CANDLES_PATH} — run fetch_stock_candles.py first.")
    print(f"Loading 4H OHLC from {os.path.basename(CANDLES_PATH)}...")
    c = pd.read_csv(CANDLES_PATH)
    print(f"  OHLC rows: {len(c):,}  | symbols: {c['symbol'].nunique()}  | "
          f"{pd.to_datetime(c['timestamp'].min(), unit='ms').date()} → "
          f"{pd.to_datetime(c['timestamp'].max(), unit='ms').date()}")
    return c


def build_candle_index(candles):
    idx = {}
    for sym, group in candles.groupby('symbol'):
        g = group.sort_values('timestamp').reset_index(drop=True)
        idx[sym] = {
            'ts': g['timestamp'].values,
            'open': g['open'].values,
            'high': g['high'].values,
            'low': g['low'].values,
            'close': g['close'].values,
        }
    return idx


def resolve_fill(direction, entry, sl, tp, candle_block):
    highs = candle_block['high']
    lows = candle_block['low']
    opens = candle_block['open']
    closes = candle_block['close']
    n = min(HORIZON_BARS, len(highs))
    for i in range(n):
        if direction == 1:
            sl_hit = lows[i] <= sl
            tp_hit = highs[i] >= tp
        else:
            sl_hit = highs[i] >= sl
            tp_hit = lows[i] <= tp
        if sl_hit and tp_hit:
            bar_closed_up = closes[i] >= opens[i]
            hit = ('tp' if bar_closed_up else 'sl') if direction == 1 \
                else ('tp' if not bar_closed_up else 'sl')
            return (TP_ATR if hit == 'tp' else -SL_ATR), i, 1
        if tp_hit:
            return TP_ATR, i, 0
        if sl_hit:
            return -SL_ATR, i, 0
    if n == 0:
        return None, -1, 0
    last_close = closes[n - 1]
    move = (last_close - entry) * direction
    atr_unit = (tp - entry) / TP_ATR if direction == 1 else (entry - tp) / TP_ATR
    return float(np.clip(move / atr_unit, -SL_ATR, TP_ATR)), n - 1, 0


def replay_setups_for_rows(rows, candle_idx):
    """Bar-by-bar resolve every aligned setup row. Returns list of dicts."""
    out = []
    for _, row in rows.iterrows():
        sym = row['symbol']
        if sym not in candle_idx:
            continue
        atr_pct = row['atrPercent']
        if atr_pct <= 0:
            continue
        entry = row['price']
        atr_price = entry * atr_pct / 100.0
        align = row['biasAlignment']
        if align == 'aligned_bullish':
            direction = 1
            sl = entry - atr_price * SL_ATR
            tp = entry + atr_price * TP_ATR
        elif align == 'aligned_bearish':
            direction = -1
            sl = entry + atr_price * SL_ATR
            tp = entry - atr_price * TP_ATR
        else:
            continue
        cdata = candle_idx[sym]
        i = np.searchsorted(cdata['ts'], row['ts_ms'], side='right')
        if i >= len(cdata['ts']):
            continue
        block = {
            'open': cdata['open'][i:i + HORIZON_BARS],
            'high': cdata['high'][i:i + HORIZON_BARS],
            'low': cdata['low'][i:i + HORIZON_BARS],
            'close': cdata['close'][i:i + HORIZON_BARS],
        }
        if len(block['high']) == 0:
            continue
        r, exit_bar, both = resolve_fill(direction, entry, sl, tp, block)
        if r is None:
            continue
        out.append({
            'symbol': sym,
            'timestamp': row['timestamp'],
            'biasAlignment': align,
            'regime': row['regime'],
            'mlProb': row.get('mlProb', np.nan),
            'direction': direction,
            'R': r,
            'fold': row.get('fold', 0),
        })
    return out


def make_model():
    return xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def walk_forward(df, candle_idx):
    """5-fold expanding-window WF. Train ML quality model per fold, attach
    mlProb to validation rows, then resolve setups bar-by-bar."""
    n = len(df)
    all_results = []
    fold_meta = []
    for i in range(N_FOLDS):
        train_end = int(n * (0.25 + i * 0.15))
        val_start = train_end + PURGE_BARS
        val_end = int(n * (0.40 + i * 0.15)) if i < N_FOLDS - 1 else n
        if val_start >= val_end:
            continue
        train = df.iloc[:train_end]
        val = df.iloc[val_start:val_end].copy()
        val['fold'] = i + 1

        # Train ML quality model on train portion.
        m = make_model()
        m.fit(train[FEATURES].fillna(0), train['goodR'])
        val['mlProb'] = m.predict_proba(val[FEATURES].fillna(0))[:, 1]

        val_start_dt = pd.to_datetime(val['timestamp'].iloc[0], unit='s').date()
        val_end_dt = pd.to_datetime(val['timestamp'].iloc[-1], unit='s').date()
        print(f"\nFold {i+1}: train={len(train):,}  val={len(val):,}  "
              f"({val_start_dt} → {val_end_dt})")
        print(f"  resolving setups bar-by-bar...")
        fold_results = replay_setups_for_rows(val, candle_idx)
        print(f"  resolved {len(fold_results):,} aligned setups")
        all_results.extend(fold_results)
        fold_meta.append((i + 1, val_start_dt, val_end_dt, len(fold_results)))

    return pd.DataFrame(all_results), fold_meta


def report_bucket(name, mask, df):
    sub = df[mask]
    n = len(sub)
    if n == 0:
        print(f"  {name:<54} n=0")
        return
    win = (sub['R'] > 0).mean() * 100
    ev = sub['R'].mean()
    cum = sub['R'].sum()
    sign = '+' if ev >= 0 else ''
    print(f"  {name:<54} n={n:>6}  win={win:>4.1f}%  EV={sign}{ev:>+5.3f}R  cumR={cum:>+8.1f}")


def per_fold_table(df, mask, label):
    """Per-fold breakdown for a specific bucket — shows how the EV evolves
    across the bear → bull arc."""
    print(f"\n  {label}:")
    print(f"  fold  n        win%    EV(R)         cumR")
    print(f"  " + "-"*48)
    for fi in sorted(df['fold'].unique()):
        sub = df[mask & (df['fold'] == fi)]
        n = len(sub)
        if n == 0:
            print(f"  {fi}     n=0")
            continue
        win = (sub['R'] > 0).mean() * 100
        ev = sub['R'].mean()
        cum = sub['R'].sum()
        sign = '+' if ev >= 0 else ''
        print(f"  {fi}     {n:>6}   {win:>4.1f}%  {sign}{ev:>+5.3f}R   {cum:>+7.1f}")


def main():
    df = load_features()
    candles = load_candles()
    candle_idx = build_candle_index(candles)
    print(f"\n5-fold walk-forward setup execution backtest:")
    results, fold_meta = walk_forward(df, candle_idx)

    print(f"\n=== Fold coverage ===")
    for fi, start_dt, end_dt, n_setups in fold_meta:
        print(f"  fold {fi}: {start_dt} → {end_dt}  setups resolved: {n_setups:,}")
    print(f"  total: {len(results):,} setups across 5 folds")

    hi_ml = results['mlProb'] >= ML_THRESHOLD

    # --- Aggregate (all folds combined) ---
    print(f"\n=== AGGREGATE across all folds ({len(results):,} setups, 2022-01 → 2026-05) ===")
    print(f"  bucket{' '*48} n      win%    EV(R)         cumR")
    print(f"  " + "-"*84)
    long_mask = (results['direction'] == 1)
    short_mask = (results['direction'] == -1)
    report_bucket("aligned_bullish — all",
                  long_mask, results)
    report_bucket(f"aligned_bullish + ML >= {ML_THRESHOLD}",
                  long_mask & hi_ml, results)
    report_bucket("aligned_bearish — all",
                  short_mask, results)
    report_bucket(f"aligned_bearish + ML >= {ML_THRESHOLD}",
                  short_mask & hi_ml, results)

    # --- Per-fold for each key bucket ---
    per_fold_table(results, long_mask, "aligned_bullish — all (per fold)")
    per_fold_table(results, long_mask & hi_ml, f"aligned_bullish + ML >= {ML_THRESHOLD} (per fold)")
    per_fold_table(results, short_mask, "aligned_bearish — all (per fold)")
    per_fold_table(results, short_mask & hi_ml, f"aligned_bearish + ML >= {ML_THRESHOLD} (per fold)")

    # --- Regime breakdown (aggregate) ---
    print(f"\n=== Aggregate by regime (long, ML >= {ML_THRESHOLD}) ===")
    print(f"  bucket{' '*48} n      win%    EV(R)         cumR")
    print(f"  " + "-"*84)
    for regime in ['TRENDING', 'RANGING', 'TRANSITIONING']:
        report_bucket(f"  + {regime}",
                      long_mask & hi_ml & (results['regime'] == regime), results)
    print(f"\n=== Aggregate by regime (short, ML >= {ML_THRESHOLD}) ===")
    for regime in ['TRENDING', 'RANGING', 'TRANSITIONING']:
        report_bucket(f"  + {regime}",
                      short_mask & hi_ml & (results['regime'] == regime), results)


if __name__ == '__main__':
    main()
