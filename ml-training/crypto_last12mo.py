#!/usr/bin/env python3
"""
Crypto setup-execution backtest restricted to the LAST 12 MONTHS of data
(approximately 2025-05 → 2026-05). Trains the ML quality model on data BEFORE
the 12-month window (clean OOF) and resolves setups within the window using
bar-by-bar OHLC.

Why this cut: 5-fold WF aggregate covers 2022-2026 and produced +0.777R EV.
The recent regime might be different (current bull, post-rate-cuts macro).
This script answers "what would the strategy have done in the most recent
12 months of crypto?" — the most regime-relevant data for go-forward expectations.

Run:  python3 crypto_last12mo.py
"""
import glob
import os
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

CSV_DIR = os.path.join(os.path.dirname(__file__), 'csv_exports_v11')
CANDLES_PATH = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')
ML_THRESHOLD = 0.65
SL_ATR, TP_ATR, HORIZON_BARS = 1.0, 1.5, 6
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
    dfs = [pd.read_csv(f) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[df['fwdMaxFavR'].notna() & (df['atrPercent'].fillna(0) > 0)]
    df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
    for col in ('basisPct', 'basisExtreme'):
        if col not in df.columns: df[col] = 0.0
    df = df.sort_values('timestamp').reset_index(drop=True)
    df['ts_ms'] = df['timestamp'] * 1000
    return df


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


def resolve_setups(rows, candle_idx):
    out = []
    for _, row in rows.iterrows():
        sym = row['symbol']
        if sym not in candle_idx: continue
        atr_pct = row['atrPercent']
        if atr_pct <= 0: continue
        entry = row['price']
        atr_price = entry * atr_pct / 100.0
        align = row['biasAlignment']
        if align == 'aligned_bullish':
            direction, sl, tp = 1, entry - atr_price * SL_ATR, entry + atr_price * TP_ATR
        elif align == 'aligned_bearish':
            direction, sl, tp = -1, entry + atr_price * SL_ATR, entry - atr_price * TP_ATR
        else:
            continue
        cdata = candle_idx[sym]
        i = np.searchsorted(cdata['ts'], row['ts_ms'], side='right')
        if i >= len(cdata['ts']): continue
        block = {k: cdata[k][i:i+HORIZON_BARS] for k in ('open','high','low','close')}
        if len(block['high']) == 0: continue
        r = resolve_fill(direction, entry, sl, tp, block)
        if r is None: continue
        out.append({'symbol': sym, 'mlProb': row['mlProb'], 'biasAlignment': align,
                    'regime': row['regime'], 'direction': direction, 'R': r,
                    'dStochCross': row['dStochCross'], 'timestamp': row['timestamp']})
    return pd.DataFrame(out)


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
    print(f"  {name:<54} n={n:>5,}  win={win:>4.1f}%  EV={sign}{ev:>+5.3f}R  cumR={cum:>+8.1f}")


def main():
    print("Loading crypto features + candles...")
    df = load_features()
    candles = pd.read_csv(CANDLES_PATH)
    candle_idx = build_candle_index(candles)
    print(f"  bars: {len(df):,}  |  span: {pd.to_datetime(df['timestamp'].min(), unit='s').date()} → {pd.to_datetime(df['timestamp'].max(), unit='s').date()}")

    # Define the 12-month window: last 365 days of data
    last_ts = df['timestamp'].max()
    cutoff_ts = last_ts - 365 * 86400
    train_df = df[df['timestamp'] < cutoff_ts]
    val_df = df[df['timestamp'] >= cutoff_ts].copy()
    print(f"\nLast-12-months window: "
          f"{pd.to_datetime(cutoff_ts, unit='s').date()} → {pd.to_datetime(last_ts, unit='s').date()}")
    print(f"  Train (pre-window):  {len(train_df):,} bars")
    print(f"  Val (the 12 months): {len(val_df):,} bars")

    # Train ML on PRE-window data only (clean OOF for the 12-month window).
    print(f"\n  Training XGBoost (quality target = goodR_1.5) on pre-window data...")
    model = xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42,
    )
    model.fit(train_df[FEATURES].fillna(0), train_df['goodR'])
    val_df['mlProb'] = model.predict_proba(val_df[FEATURES].fillna(0))[:, 1]
    print(f"  test ML_WIN: mean={val_df['mlProb'].mean():.3f}  p90={val_df['mlProb'].quantile(0.9):.3f}  max={val_df['mlProb'].max():.3f}")

    # Resolve setups bar-by-bar
    print(f"\n  Resolving setups bar-by-bar...")
    results = resolve_setups(val_df, candle_idx)
    print(f"  resolved {len(results):,} aligned setups in the 12-month window")

    hi_ml = results['mlProb'] >= ML_THRESHOLD
    long_mask = (results['direction'] == 1)
    short_mask = (results['direction'] == -1)

    print(f"\n=== CRYPTO last 12 months ({len(results):,} setups) ===")
    print(f"  bucket                                                 n      win%    EV(R)         cumR")
    print(f"  " + "-"*84)
    report_bucket("aligned_bullish — all (no ML filter)", long_mask, results)
    report_bucket(f"aligned_bullish + ML >= {ML_THRESHOLD}",
                  long_mask & hi_ml, results)
    print()
    report_bucket("aligned_bearish — all (no ML filter)", short_mask, results)
    report_bucket(f"aligned_bearish + ML >= {ML_THRESHOLD}",
                  short_mask & hi_ml, results)
    print()
    # StochCross direction
    stoch_long = (results['dStochCross'] == 1) & long_mask
    stoch_short = (results['dStochCross'] == -1) & short_mask
    report_bucket("dStochCross +1 LONG (on aligned_bullish bars)",
                  stoch_long, results)
    report_bucket(f"  + ML >= {ML_THRESHOLD}",
                  stoch_long & hi_ml, results)
    report_bucket("dStochCross -1 SHORT (on aligned_bearish bars)",
                  stoch_short, results)
    report_bucket(f"  + ML >= {ML_THRESHOLD}",
                  stoch_short & hi_ml, results)

    # Regime breakdown
    print(f"\n=== Aggregate by regime (LONG, ML >= {ML_THRESHOLD}) ===")
    for regime in ['TRENDING', 'RANGING', 'TRANSITIONING']:
        report_bucket(f"  + {regime}",
                      long_mask & hi_ml & (results['regime'] == regime), results)
    print(f"\n=== Aggregate by regime (SHORT, ML >= {ML_THRESHOLD}) ===")
    for regime in ['TRENDING', 'RANGING', 'TRANSITIONING']:
        report_bucket(f"  + {regime}",
                      short_mask & hi_ml & (results['regime'] == regime), results)

    # Monthly EV walk — see how stable the edge is across months
    results['month'] = pd.to_datetime(results['timestamp'], unit='s').dt.to_period('M')
    print(f"\n=== Monthly EV (aligned_bullish + ML >= {ML_THRESHOLD}, LONG) ===")
    print(f"  month         n     win%    EV(R)       cumR")
    for m, sub in results[long_mask & hi_ml].groupby('month'):
        n = len(sub)
        if n == 0: continue
        win = (sub['R'] > 0).mean() * 100
        ev = sub['R'].mean()
        cum = sub['R'].sum()
        sign = '+' if ev >= 0 else ''
        print(f"  {m}    {n:>4}   {win:>4.1f}%   {sign}{ev:>+5.3f}R    {cum:>+6.1f}")

    print(f"\n=== Monthly EV (aligned_bearish + ML >= {ML_THRESHOLD}, SHORT) ===")
    for m, sub in results[short_mask & hi_ml].groupby('month'):
        n = len(sub)
        if n == 0: continue
        win = (sub['R'] > 0).mean() * 100
        ev = sub['R'].mean()
        cum = sub['R'].sum()
        sign = '+' if ev >= 0 else ''
        print(f"  {m}    {n:>4}   {win:>4.1f}%   {sign}{ev:>+5.3f}R    {cum:>+6.1f}")


if __name__ == '__main__':
    main()
