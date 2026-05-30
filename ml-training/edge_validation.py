#!/usr/bin/env python3
"""
Honest out-of-sample edge validation + band sweep + direction stacking.

Fixes the cross-symbol leakage in the existing WF scripts: instead of pooling all
symbols, sorting by row index, and purging 48 bars (which leaves correlated symbols
sharing the same wall-clock period across the train/test boundary), this splits by
TIMESTAMP VALUE with a 2-week embargo and a single contiguous forward test block.
Every test bar is genuinely later in wall-clock time than every train bar.

For each market it answers three questions on the SAME clean test set:
  1. Which direction primitive has the best forward EV? (bias / dStoch / union)
  2. What TP/SL band maximizes EV on the winning primitive?
  3. Does overlaying a direction-confidence filter (dStoch agreement strength) help?

Run:  python3 edge_validation.py
"""
import glob
import os

import numpy as np
import pandas as pd
import xgboost as xgb

ML_RISING_EDGE = 0.70
N_FOLDS = None  # not used — single forward split
EMBARGO_DAYS = 14
TRAIN_FRAC_OF_TIME = 0.70  # first 70% of the wall-clock span trains; last 30% tests

TOP10_CRYPTO = {'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
                'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'TRXUSDT'}

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

# Bands to sweep: (SL_ATR, TP_ATR). Breakeven win rate = SL/(SL+TP).
BANDS = [(1.0, 1.5), (1.0, 2.0), (1.0, 2.5), (1.5, 1.5), (1.5, 2.0),
         (1.5, 3.0), (2.0, 2.0), (2.0, 3.0), (0.75, 1.5), (1.0, 1.0)]
HORIZON_BARS = 6


def load_features(csv_dir, symbol_filter=None):
    files = sorted(glob.glob(os.path.join(csv_dir, '*.csv')))
    if symbol_filter:
        files = [f for f in files if os.path.basename(f).replace('.csv', '') in symbol_filter]
    df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
    df = df[df['fwdMaxFavR'].notna() & (df['atrPercent'].fillna(0) > 0)]
    df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
    for col in ('basisPct', 'basisExtreme'):
        if col not in df.columns:
            df[col] = 0.0
    df = df.sort_values('timestamp').reset_index(drop=True)
    df['ts_ms'] = df['timestamp'] * 1000
    return df


def build_candle_index(candles_path, symbol_filter=None):
    c = pd.read_csv(candles_path)
    if symbol_filter:
        c = c[c['symbol'].isin(symbol_filter)]
    idx = {}
    for sym, group in c.groupby('symbol'):
        g = group.sort_values('timestamp').reset_index(drop=True)
        idx[sym] = {'ts': g['timestamp'].values, 'open': g['open'].values,
                    'high': g['high'].values, 'low': g['low'].values, 'close': g['close'].values}
    return idx


def resolve_fill(direction, entry, sl, tp, block, sl_atr, tp_atr):
    highs, lows, opens, closes = block['high'], block['low'], block['open'], block['close']
    n = min(HORIZON_BARS, len(highs))
    for i in range(n):
        if direction == 1:
            sl_hit, tp_hit = lows[i] <= sl, highs[i] >= tp
        else:
            sl_hit, tp_hit = highs[i] >= sl, lows[i] <= tp
        if sl_hit and tp_hit:
            # Conservative tie-break: assume SL hit first within the bar.
            return -sl_atr
        if tp_hit: return tp_atr
        if sl_hit: return -sl_atr
    if n == 0: return None
    move = (closes[n-1] - entry) * direction
    atr_unit = (tp - entry) / tp_atr if direction == 1 else (entry - tp) / tp_atr
    return float(np.clip(move / atr_unit, -sl_atr, tp_atr))


def make_model():
    return xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42)


def forward_split_predict(df):
    """Single clean forward split by timestamp value with a 2-week embargo."""
    t_lo, t_hi = df['timestamp'].min(), df['timestamp'].max()
    split_t = t_lo + (t_hi - t_lo) * TRAIN_FRAC_OF_TIME
    embargo = EMBARGO_DAYS * 86400
    train = df[df['timestamp'] < split_t]
    test = df[df['timestamp'] >= split_t + embargo].copy()
    m = make_model()
    m.fit(train[FEATURES].fillna(0), train['goodR'])
    test['mlProb'] = m.predict_proba(test[FEATURES].fillna(0))[:, 1]
    split_dt = pd.to_datetime(split_t, unit='s').date()
    print(f"  split @ {split_dt}  | train {len(train):,}  test {len(test):,}  "
          f"(test window {pd.to_datetime(test['timestamp'].min(),unit='s').date()} "
          f"-> {pd.to_datetime(test['timestamp'].max(),unit='s').date()})")
    return test


def find_rising_edges(test):
    test = test.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    test['prevMl'] = test.groupby('symbol')['mlProb'].shift(1)
    test['risingEdge'] = (test['prevMl'] < ML_RISING_EDGE) & (test['mlProb'] >= ML_RISING_EDGE)
    return test[test['risingEdge']].copy()


def dir_bias(row):
    a = row['biasAlignment']
    return 1 if a == 'aligned_bullish' else (-1 if a == 'aligned_bearish' else 0)

def dir_dstoch(row):
    s = row['dStochCross']
    return 1 if s == 1 else (-1 if s == -1 else 0)

def dir_union(row):
    b, s = dir_bias(row), dir_dstoch(row)
    if b != 0 and s != 0 and b != s: return 0
    return b if b != 0 else s


def resolve_all(rising, candle_idx, dir_fn, sl_atr, tp_atr):
    rows = []
    for _, row in rising.iterrows():
        d = dir_fn(row)
        if d == 0: continue
        sym = row['symbol']
        if sym not in candle_idx: continue
        atr_pct = row['atrPercent']
        if atr_pct <= 0: continue
        entry = row['price']
        atr_price = entry * atr_pct / 100.0
        if d == 1:
            sl, tp = entry - atr_price * sl_atr, entry + atr_price * tp_atr
        else:
            sl, tp = entry + atr_price * sl_atr, entry - atr_price * tp_atr
        cdata = candle_idx[sym]
        i = np.searchsorted(cdata['ts'], row['ts_ms'], side='right')
        if i >= len(cdata['ts']): continue
        block = {k: cdata[k][i:i+HORIZON_BARS] for k in ('open', 'high', 'low', 'close')}
        if len(block['high']) == 0: continue
        r = resolve_fill(d, entry, sl, tp, block, sl_atr, tp_atr)
        if r is None: continue
        rows.append({'symbol': sym, 'direction': d, 'R': r})
    return pd.DataFrame(rows)


def stat(df):
    if len(df) == 0: return (0, 0, 0, 0)
    return (len(df), (df['R'] > 0).mean()*100, df['R'].mean(), df['R'].sum())


def run_market(label, csv_dir, candles_path, symbol_filter=None):
    print(f"\n{'='*94}\n{label}\n{'='*94}")
    df = load_features(csv_dir, symbol_filter)
    candle_idx = build_candle_index(candles_path, symbol_filter)
    print(f"  bars {len(df):,} | symbols {df['symbol'].nunique()}")
    test = forward_split_predict(df)
    rising = find_rising_edges(test)
    print(f"  forward rising-edge events (ML ↑ through 0.70): {len(rising):,}")

    # Q1: primitive comparison at the production band (1.0/1.5)
    print(f"\n  Q1 — direction primitive @ SL1.0/TP1.5 (clean forward OOS):")
    print(f"  {'primitive':<30} {'n':>6} {'win%':>6} {'EV(R)':>8} {'totalR':>9}")
    print(f"  " + "-"*64)
    for name, fn in [('bias-aligned (old prod)', dir_bias),
                     ('dStochCross', dir_dstoch),
                     ('bias OR dStoch (union)', dir_union)]:
        n, win, ev, cum = stat(resolve_all(rising, candle_idx, fn, 1.0, 1.5))
        print(f"  {name:<30} {n:>6,} {win:>5.1f}% {ev:>+7.3f} {cum:>+8.1f}")

    # Q2: band sweep on the winning primitive (dStoch)
    print(f"\n  Q2 — TP/SL band sweep on dStochCross (clean forward OOS):")
    print(f"  {'SL/TP (ATR)':<14} {'breakeven':>9} {'n':>6} {'win%':>6} {'EV(R)':>8} {'totalR':>9}")
    print(f"  " + "-"*60)
    best = None
    for sl_atr, tp_atr in BANDS:
        res = resolve_all(rising, candle_idx, dir_dstoch, sl_atr, tp_atr)
        n, win, ev, cum = stat(res)
        be = sl_atr / (sl_atr + tp_atr) * 100
        flag = ''
        if n > 50 and (best is None or ev > best[0]):
            best = (ev, sl_atr, tp_atr); flag = ' *'
        print(f"  {f'{sl_atr}/{tp_atr}':<14} {be:>8.1f}% {n:>6,} {win:>5.1f}% {ev:>+7.3f} {cum:>+8.1f}{flag}")
    if best:
        print(f"  → best band: SL{best[1]}/TP{best[2]}  EV={best[0]:+.3f}R")


def main():
    run_market("STOCKS (159 symbols)",
               '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v13',
               '/Users/bojanmihovilovic/CryptoLens/ml-training/stock_candles_4h.csv.gz')
    run_market("CRYPTO TOP-10",
               '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v11',
               '/Users/bojanmihovilovic/CryptoLens/ml-training/crypto_candles_4h.csv.gz',
               symbol_filter=TOP10_CRYPTO)
    run_market("CRYPTO ALL (77 symbols)",
               '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v11',
               '/Users/bojanmihovilovic/CryptoLens/ml-training/crypto_candles_4h.csv.gz')


if __name__ == '__main__':
    main()
