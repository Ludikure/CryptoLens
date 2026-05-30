#!/usr/bin/env python3
"""
Test the user's hypothesis: combine ML quality with RSI extremes to get
direction.
  - RSI oversold + ML high  → LONG (mean-reversion bounce)
  - RSI overbought + ML high → SHORT (mean-reversion fade)

Mean reversion is the canonical directional play on RSI extremes. The
question is whether ML's quality filter improves selectivity on top of it.

Setup definition: independent of biasAlignment.
  Direction: from dRsi value
    dRsi <= LOW_THRESH  → LONG  (oversold → expect bounce)
    dRsi >= HIGH_THRESH → SHORT (overbought → expect fade)
    otherwise           → no setup
  Entry: current close
  SL: 1.0 ATR adverse
  TP: 1.5 ATR favorable
  Horizon: 6 × 4H bars (24h)

Tests:
  - Multiple RSI band thresholds (sweep severity)
  - With and without ML >= 0.65 filter
  - Daily RSI (dRsi) vs 4H RSI (hRsi)
  - Per-fold breakdown — mean reversion is regime-dependent
  - Bias alignment as a tiebreaker (RSI oversold + aligned_bullish → strongest)

Run:  python3 setup_execution_rsi_test.py
Prerequisite: ./stock_candles_4h.csv.gz
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
    print(f"Loading {len(files)} CSVs...")
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


def resolve_rsi_setups(rows, candle_idx, rsi_col, low_thresh, high_thresh):
    """For each row, fire LONG if rsi <= low_thresh, SHORT if rsi >= high_thresh."""
    out = []
    for _, row in rows.iterrows():
        rsi = row[rsi_col]
        if pd.isna(rsi): continue
        if rsi <= low_thresh:
            direction = 1
        elif rsi >= high_thresh:
            direction = -1
        else:
            continue
        sym = row['symbol']
        if sym not in candle_idx: continue
        atr_pct = row['atrPercent']
        if atr_pct <= 0: continue
        entry = row['price']
        atr_price = entry * atr_pct / 100.0
        if direction == 1:
            sl, tp = entry - atr_price * SL_ATR, entry + atr_price * TP_ATR
        else:
            sl, tp = entry + atr_price * SL_ATR, entry - atr_price * TP_ATR
        cdata = candle_idx[sym]
        i = np.searchsorted(cdata['ts'], row['ts_ms'], side='right')
        if i >= len(cdata['ts']): continue
        block = {k: cdata[k][i:i+HORIZON_BARS] for k in ('open','high','low','close')}
        if len(block['high']) == 0: continue
        r = resolve_fill(direction, entry, sl, tp, block)
        if r is None: continue
        out.append({
            'symbol': sym,
            'fold': row['fold'],
            'mlProb': row['mlProb'],
            'rsi': rsi,
            'direction': direction,
            'biasAlignment': row['biasAlignment'],
            'regime': row['regime'],
            'R': r,
        })
    return pd.DataFrame(out)


def make_model():
    return xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def walk_forward(df):
    n = len(df)
    val_dfs = []
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
        val_dfs.append(val)
        print(f"  fold {i+1}: {len(val):,} val rows")
    return pd.concat(val_dfs, ignore_index=True)


def summarize(name, mask, df, indent='  '):
    sub = df[mask]
    n = len(sub)
    if n == 0:
        print(f"{indent}{name:<48} n=0")
        return
    win = (sub['R'] > 0).mean() * 100
    ev = sub['R'].mean()
    cum = sub['R'].sum()
    sign = '+' if ev >= 0 else ''
    print(f"{indent}{name:<48} n={n:>5,}  win={win:>4.1f}%  EV={sign}{ev:>+5.3f}R  cumR={cum:>+7.1f}")


def main():
    df = load_features()
    print(f"\n5-fold WF training to attach mlProb...")
    val_all = walk_forward(df)
    print(f"\nLoading OHLC...")
    candle_idx = build_candle_index(pd.read_csv(CANDLES_PATH))

    # === Test 1: Daily RSI extremes (dRsi) with various thresholds ===
    print(f"\n========== Test 1: Daily RSI extremes (dRsi) ==========")
    print(f"LONG when dRsi <= low_thresh, SHORT when dRsi >= high_thresh\n")

    for low_t, high_t in [(30, 70), (35, 65), (40, 60), (25, 75)]:
        print(f"\n--- dRsi bands: oversold <= {low_t}, overbought >= {high_t} ---")
        results = resolve_rsi_setups(val_all, candle_idx, 'dRsi', low_t, high_t)
        if len(results) == 0:
            print(f"  no setups")
            continue
        long_mask = results['direction'] == 1
        short_mask = results['direction'] == -1
        hi_ml = results['mlProb'] >= ML_THRESHOLD

        print(f"  LONG side (oversold bounce hypothesis):")
        summarize("all oversold bars (no ML filter)", long_mask, results)
        summarize(f"  + ML >= {ML_THRESHOLD}",
                  long_mask & hi_ml, results, indent='    ')
        summarize(f"  + ML >= {ML_THRESHOLD} + aligned_bullish",
                  long_mask & hi_ml & (results['biasAlignment'] == 'aligned_bullish'),
                  results, indent='    ')
        summarize(f"  + ML >= {ML_THRESHOLD} + aligned_bearish (against)",
                  long_mask & hi_ml & (results['biasAlignment'] == 'aligned_bearish'),
                  results, indent='    ')

        print(f"  SHORT side (overbought fade hypothesis):")
        summarize("all overbought bars (no ML filter)", short_mask, results)
        summarize(f"  + ML >= {ML_THRESHOLD}",
                  short_mask & hi_ml, results, indent='    ')
        summarize(f"  + ML >= {ML_THRESHOLD} + aligned_bearish",
                  short_mask & hi_ml & (results['biasAlignment'] == 'aligned_bearish'),
                  results, indent='    ')
        summarize(f"  + ML >= {ML_THRESHOLD} + aligned_bullish (against)",
                  short_mask & hi_ml & (results['biasAlignment'] == 'aligned_bullish'),
                  results, indent='    ')

    # === Test 2: Per-fold breakdown for the most interesting setup ===
    print(f"\n========== Test 2: Per-fold (dRsi <= 30 + ML high → LONG) ==========")
    results = resolve_rsi_setups(val_all, candle_idx, 'dRsi', 30, 70)
    hi_ml = results['mlProb'] >= ML_THRESHOLD
    long_hiML = (results['direction'] == 1) & hi_ml
    print(f"  fold   n    win%    EV(R)         cumR    regime mix")
    for f in range(1, 6):
        sub = results[(results['fold'] == f) & long_hiML]
        n = len(sub)
        if n == 0:
            print(f"  {f}      n=0")
            continue
        win = (sub['R'] > 0).mean() * 100
        ev = sub['R'].mean()
        cum = sub['R'].sum()
        regimes = sub['regime'].value_counts().to_dict()
        regime_str = ', '.join(f"{k[:5]}:{v}" for k, v in sorted(regimes.items())[:3])
        sign = '+' if ev >= 0 else ''
        print(f"  {f}      {n:>3}   {win:>4.1f}%  {sign}{ev:>+5.3f}R   {cum:>+6.1f}    {regime_str}")

    print(f"\n========== Test 3: Per-fold (dRsi >= 70 + ML high → SHORT) ==========")
    short_hiML = (results['direction'] == -1) & hi_ml
    print(f"  fold   n    win%    EV(R)         cumR    regime mix")
    for f in range(1, 6):
        sub = results[(results['fold'] == f) & short_hiML]
        n = len(sub)
        if n == 0:
            print(f"  {f}      n=0")
            continue
        win = (sub['R'] > 0).mean() * 100
        ev = sub['R'].mean()
        cum = sub['R'].sum()
        regimes = sub['regime'].value_counts().to_dict()
        regime_str = ', '.join(f"{k[:5]}:{v}" for k, v in sorted(regimes.items())[:3])
        sign = '+' if ev >= 0 else ''
        print(f"  {f}      {n:>3}   {win:>4.1f}%  {sign}{ev:>+5.3f}R   {cum:>+6.1f}    {regime_str}")

    # === Test 4: Same with hRsi (4H RSI) for shorter-term signal ===
    print(f"\n========== Test 4: 4H RSI (hRsi <= 30 / hRsi >= 70) ==========")
    results_h = resolve_rsi_setups(val_all, candle_idx, 'hRsi', 30, 70)
    if len(results_h) > 0:
        long_h = results_h['direction'] == 1
        short_h = results_h['direction'] == -1
        hi_h = results_h['mlProb'] >= ML_THRESHOLD
        print(f"  LONG (hRsi <= 30):")
        summarize("all (no ML)", long_h, results_h)
        summarize(f"  + ML >= {ML_THRESHOLD}", long_h & hi_h, results_h, indent='    ')
        print(f"  SHORT (hRsi >= 70):")
        summarize("all (no ML)", short_h, results_h)
        summarize(f"  + ML >= {ML_THRESHOLD}", short_h & hi_h, results_h, indent='    ')


if __name__ == '__main__':
    main()
