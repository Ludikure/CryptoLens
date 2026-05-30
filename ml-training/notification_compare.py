#!/usr/bin/env python3
"""
Apples-to-apples comparison of the two notification regimes:

  OLD (pre-change):  fire when mlProb rises through 0.70 AND biasAlignment is aligned
  NEW (post-change): same as OLD, AND dStochCross != 0

This is different from the earlier "ML >= 0.65 continuous" backtest. Notifications
fire on a *rising edge* (prev < 0.70, current >= 0.70), and the cooldown prevents
re-firing within 3.5h. At 4H bar resolution the cooldown rarely matters (bars are
4H apart anyway), so this script models the rising edge directly.

Setup direction: from biasAlignment (LONG if aligned_bullish, SHORT if aligned_bearish).
Same SL/TP rules as v3 (1.0/1.5 ATR, 24h horizon).

Run:  python3 notification_compare.py
Pre-requisites: csv_exports_v13/, csv_exports_v11/, stock_candles_4h.csv.gz,
                crypto_candles_4h.csv.gz.
"""
import glob
import os

import numpy as np
import pandas as pd
import xgboost as xgb

ML_RISING_EDGE = 0.70   # the notification threshold the worker uses
SL_ATR, TP_ATR, HORIZON_BARS = 1.0, 1.5, 6
N_FOLDS, PURGE_BARS = 5, 48

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


def load_features(csv_dir, symbol_filter=None):
    files = sorted(glob.glob(os.path.join(csv_dir, '*.csv')))
    if symbol_filter:
        files = [f for f in files if os.path.basename(f).replace('.csv', '') in symbol_filter]
    dfs = [pd.read_csv(f) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[df['fwdMaxFavR'].notna() & (df['atrPercent'].fillna(0) > 0)]
    df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
    for col in ('basisPct', 'basisExtreme'):
        if col not in df.columns: df[col] = 0.0
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


def make_model():
    return xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def wf_predict(df):
    """5-fold WF, attach mlProb to every val bar. Returns concat'd val frames."""
    n = len(df)
    val_dfs = []
    for i in range(N_FOLDS):
        train_end = int(n * (0.25 + i * 0.15))
        val_start = train_end + PURGE_BARS
        val_end = int(n * (0.40 + i * 0.15)) if i < N_FOLDS - 1 else n
        train = df.iloc[:train_end]
        val = df.iloc[val_start:val_end].copy()
        m = make_model()
        m.fit(train[FEATURES].fillna(0), train['goodR'])
        val['mlProb'] = m.predict_proba(val[FEATURES].fillna(0))[:, 1]
        val_dfs.append(val)
    return pd.concat(val_dfs, ignore_index=True)


def find_rising_edges(val_all):
    """For each (symbol, timestamp) sorted chronologically, mark rising edges
    where prev mlProb < ML_RISING_EDGE AND current >= ML_RISING_EDGE."""
    val_all = val_all.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    val_all['prevMl'] = val_all.groupby('symbol')['mlProb'].shift(1)
    val_all['risingEdge'] = (
        (val_all['prevMl'] < ML_RISING_EDGE) &
        (val_all['mlProb'] >= ML_RISING_EDGE)
    )
    return val_all


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
        out.append({'symbol': sym, 'mlProb': row['mlProb'], 'direction': direction,
                    'R': r, 'dStochCross': row['dStochCross'],
                    'biasAlignment': align, 'timestamp': row['timestamp']})
    return pd.DataFrame(out)


def report(label, df, total_universe_bars):
    if len(df) == 0:
        print(f"  {label:<48} n=0")
        return
    n = len(df)
    win = (df['R'] > 0).mean() * 100
    ev = df['R'].mean()
    cum = df['R'].sum()
    sign = '+' if ev >= 0 else ''
    fire_rate = n / total_universe_bars * 100
    print(f"  {label:<48} n={n:>5,}  ({fire_rate:>4.1f}% of bars)  win={win:>4.1f}%  "
          f"EV={sign}{ev:>+5.3f}R  totalR={cum:>+8.1f}")


def run_market(label, csv_dir, candles_path, symbol_filter=None):
    print(f"\n{'='*88}")
    print(f"{label}")
    print(f"{'='*88}")
    print(f"  Loading features + candles...")
    df = load_features(csv_dir, symbol_filter)
    candle_idx = build_candle_index(candles_path, symbol_filter)
    print(f"  bars: {len(df):,}  | symbols: {df['symbol'].nunique()}")
    print(f"  WF training (5 folds)...")
    val_all = wf_predict(df)
    val_all = find_rising_edges(val_all)
    total_universe_bars = len(val_all)
    # Apply the two filters
    rising = val_all[val_all['risingEdge']]
    rising_aligned = rising[rising['biasAlignment'].isin(['aligned_bullish', 'aligned_bearish'])]

    # OLD regime: rising edge + aligned bias (any Stoch state)
    old_universe = rising_aligned
    # NEW regime: also require dStochCross != 0
    new_universe = rising_aligned[rising_aligned['dStochCross'] != 0]

    print(f"\n  Rising edges (ML crosses ↑ through 0.70): {len(rising):,}")
    print(f"  Rising edges + bias aligned:               {len(rising_aligned):,}")
    print(f"  Rising edges + aligned + Stoch fired:      {len(new_universe):,}")

    print(f"\n  Resolving outcomes bar-by-bar...")
    old_results = resolve_setups(old_universe, candle_idx)
    new_results = resolve_setups(new_universe, candle_idx)

    print(f"\n  Filter                                           n      fire%    win%    EV(R)        totalR")
    print(f"  " + "-"*92)
    report("OLD (rising edge + aligned bias)", old_results, total_universe_bars)
    report("NEW (above + Stoch cross fired)",  new_results, total_universe_bars)

    # Direction breakdown
    print(f"\n  By direction:")
    for direction_val, dir_name in [(1, 'LONG'), (-1, 'SHORT')]:
        old_dir = old_results[old_results['direction'] == direction_val]
        new_dir = new_results[new_results['direction'] == direction_val]
        report(f"OLD {dir_name}", old_dir, total_universe_bars)
        report(f"NEW {dir_name}", new_dir, total_universe_bars)

    # Total opportunity cost
    if len(old_results) > 0 and len(new_results) > 0:
        cost_R = old_results['R'].sum() - new_results['R'].sum()
        cost_pct = (cost_R / old_results['R'].sum()) * 100 if old_results['R'].sum() != 0 else 0
        print(f"\n  Stoch gate cost: {cost_R:+.1f}R lost ({cost_pct:.1f}% of OLD's total)")
        print(f"  Per-trade EV change: {new_results['R'].mean() - old_results['R'].mean():+.3f}R")


def main():
    run_market("STOCKS (159 symbols, 2022-2026)",
               '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v13',
               '/Users/bojanmihovilovic/CryptoLens/ml-training/stock_candles_4h.csv.gz')
    run_market("CRYPTO TOP-10 (BTC ETH SOL BNB XRP ADA DOGE AVAX LINK TRX, 2022-2026)",
               '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v11',
               '/Users/bojanmihovilovic/CryptoLens/ml-training/crypto_candles_4h.csv.gz',
               symbol_filter=TOP10_CRYPTO)


if __name__ == '__main__':
    main()
