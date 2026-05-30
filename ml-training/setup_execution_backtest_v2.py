#!/usr/bin/env python3
"""
Setup-execution backtest v2 — bar-by-bar fill resolution from real 4H OHLC.

v1 used the 24h summary statistics (fwdMaxUp24H / fwdMaxDown24H), which can't
tell whether TP or SL came first when both levels were touched within the
window. v2 walks the forward bars one at a time using high/low/open/close
from D1's candles archive (fetched via fetch_stock_candles.py), so the fill
order is resolved deterministically — no pessimistic/optimistic bound.

Same setup definition as v1:
  direction:  aligned_bullish → LONG, aligned_bearish → SHORT, else skip
  entry:      current bar's close
  SL:         entry ± 1.0 ATR (adverse)
  TP:         entry ± 1.5 ATR (favorable)
  horizon:    6 forward 4H bars (24h)

Per-bar resolution rules:
  For LONG (mirror for SHORT):
    bar.low  <= SL  → exit at SL, R = -1.0
    bar.high >= TP  → exit at TP, R = +1.5
    both in same bar → use bar.open direction:
      if bar closed up (close >= open): assume price went up first → TP hit
      if bar closed down: assume price went down first → SL hit
      This is a heuristic; intra-bar tick data would resolve cleanly.
  After all 6 bars: close position at last bar's close. R = (exit - entry) / ATR.

Run:  python3 setup_execution_backtest_v2.py
Prerequisite:  ./stock_candles_4h.csv.gz (run fetch_stock_candles.py first).
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
TRAIN_FRAC = 0.80
SL_ATR = 1.0
TP_ATR = 1.5
HORIZON_BARS = 6  # 24h at 4H bars

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
    # The features CSV timestamps are in seconds; OHLC parquet is in ms.
    df['ts_ms'] = df['timestamp'] * 1000
    print(f"  feature bars: {len(df):,}  | symbols: {df['symbol'].nunique()}")
    return df


def load_candles():
    if not os.path.exists(CANDLES_PATH):
        sys.exit(f"Missing {CANDLES_PATH} — run fetch_stock_candles.py first.")
    print(f"Loading 4H OHLC from {os.path.basename(CANDLES_PATH)}...")
    c = pd.read_csv(CANDLES_PATH)
    print(f"  OHLC rows: {len(c):,}  | symbols: {c['symbol'].nunique()}")
    return c


def train_and_predict(df):
    cut = int(len(df) * TRAIN_FRAC)
    train = df.iloc[:cut]
    test = df.iloc[cut:].copy()
    print(f"\nChronological split: train={len(train):,} | test={len(test):,}")
    print(f"  test period: {pd.to_datetime(test['timestamp'].iloc[0], unit='s')}"
          f" → {pd.to_datetime(test['timestamp'].iloc[-1], unit='s')}")
    model = xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )
    print(f"  fitting XGBoost on quality target (goodR_1.5)...")
    model.fit(train[FEATURES].fillna(0), train['goodR'])
    test['mlProb'] = model.predict_proba(test[FEATURES].fillna(0))[:, 1]
    return test


def build_candle_index(candles):
    """Build {symbol: numpy array sorted by timestamp} of OHLC for fast lookup."""
    print(f"Indexing candles for bar-by-bar lookup...")
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
    """Walk forward up to HORIZON_BARS bars; return (realized_R, exit_bar, both_hit_flag).
    candle_block is a slice of the candle index arrays.
    direction = +1 for LONG, -1 for SHORT.
    For LONG: SL = entry - SL_atr_price (below entry); TP = entry + TP_atr_price (above).
    For SHORT: SL = entry + SL_atr_price (above entry); TP = entry - TP_atr_price (below).
    R returned in ATR-multiple units."""
    highs = candle_block['high']
    lows = candle_block['low']
    opens = candle_block['open']
    closes = candle_block['close']
    n = min(HORIZON_BARS, len(highs))
    for i in range(n):
        if direction == 1:  # LONG
            sl_hit_this_bar = lows[i] <= sl
            tp_hit_this_bar = highs[i] >= tp
        else:  # SHORT
            sl_hit_this_bar = highs[i] >= sl
            tp_hit_this_bar = lows[i] <= tp
        if sl_hit_this_bar and tp_hit_this_bar:
            # Both in same bar — use the bar's directional close as a tiebreaker.
            # If the bar closed in the trade's favor, assume TP came first.
            # Otherwise assume SL came first.
            bar_closed_up = closes[i] >= opens[i]
            if direction == 1:
                hit = 'tp' if bar_closed_up else 'sl'
            else:
                hit = 'tp' if not bar_closed_up else 'sl'
            return (TP_ATR if hit == 'tp' else -SL_ATR), i, 1
        if tp_hit_this_bar:
            return TP_ATR, i, 0
        if sl_hit_this_bar:
            return -SL_ATR, i, 0
    # Neither — close at last bar's close. R is the move in ATR units.
    if n == 0:
        return 0.0, -1, 0  # no candles available — skip
    last_close = closes[n - 1]
    move = (last_close - entry) * direction
    # Move-to-R conversion: caller passes ATR-normalized SL/TP, so move/(entry*atr_pct/100)
    # gives ATR multiples. Easier: clip to [-SL_ATR, TP_ATR] band (we wouldn't have
    # exceeded those, otherwise the loop would have triggered earlier).
    return np.clip(move / ((tp - entry) / TP_ATR if direction == 1 else (entry - tp) / TP_ATR),
                   -SL_ATR, TP_ATR), n - 1, 0


def replay_setups(test, candle_idx):
    """For each test row, define a setup and resolve its fill via bar-by-bar walk."""
    results = []
    no_candle = 0
    for _, row in test.iterrows():
        sym = row['symbol']
        if sym not in candle_idx:
            no_candle += 1
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
            continue  # only resolve aligned setups for now

        # Locate the FIRST candle whose timestamp is strictly after this bar's timestamp.
        cdata = candle_idx[sym]
        ts_ms = row['ts_ms']
        i = np.searchsorted(cdata['ts'], ts_ms, side='right')
        if i >= len(cdata['ts']):
            no_candle += 1
            continue
        block = {
            'ts': cdata['ts'][i:i + HORIZON_BARS],
            'open': cdata['open'][i:i + HORIZON_BARS],
            'high': cdata['high'][i:i + HORIZON_BARS],
            'low': cdata['low'][i:i + HORIZON_BARS],
            'close': cdata['close'][i:i + HORIZON_BARS],
        }
        if len(block['ts']) == 0:
            no_candle += 1
            continue

        r, exit_bar, both_hit = resolve_fill(direction, entry, sl, tp, block)
        results.append({
            'symbol': sym,
            'timestamp': row['timestamp'],
            'biasAlignment': align,
            'regime': row['regime'],
            'mlProb': row['mlProb'],
            'direction': direction,
            'R': r,
            'exit_bar': exit_bar,
            'both_hit_in_bar': both_hit,
            'mixed_bullish': (row['dailyBias'] in ('Neutral', 'Bearish', 'Strong Bearish')
                              and row['fourHBias'] in ('Bullish', 'Strong Bullish')
                              and row['oneHBias'] in ('Bullish', 'Strong Bullish')),
        })
    print(f"\n  resolved {len(results):,} setups  ({no_candle} skipped — no candles available)")
    return pd.DataFrame(results)


def report_bucket(name, mask, df):
    sub = df[mask]
    n = len(sub)
    if n == 0:
        print(f"  {name:<54} n=0")
        return
    win_rate = (sub['R'] > 0).mean()
    ev = sub['R'].mean()
    cum_r = sub['R'].sum()
    # Diagnostics: time-to-fill distribution + both-hit %
    avg_exit = sub['exit_bar'].mean()
    both_pct = sub['both_hit_in_bar'].mean() * 100
    sign = '+' if ev >= 0 else ''
    print(f"  {name:<54} n={n:>5}  win={win_rate*100:>4.1f}%  EV={sign}{ev:>+5.3f}R  "
          f"cumR={cum_r:>+7.1f}  bothBar={both_pct:>4.1f}%  avgExit={avg_exit:.1f}b")


def main():
    df = load_features()
    candles = load_candles()
    test = train_and_predict(df)
    candle_idx = build_candle_index(candles)
    results = replay_setups(test, candle_idx)

    print(f"\n=== Setup execution backtest v2 (bar-by-bar fill resolution) ===")
    print(f"SL=1.0 ATR, TP=1.5 ATR, horizon=6 4H bars (24h)")
    print(f"both-hit-in-bar: bar's close direction used as tiebreaker.\n")

    hi_ml = results['mlProb'] >= ML_THRESHOLD

    print(f"  === LONG setups (aligned_bullish, n={(results['direction']==1).sum():,}) ===")
    print(f"  bucket{' '*48} n      win%    EV(R)        cumR    bothBar  avgExit")
    print(f"  " + "-"*96)
    long_mask = (results['direction'] == 1)
    report_bucket("aligned_bullish — all",
                  long_mask, results)
    report_bucket(f"aligned_bullish + ML >= {ML_THRESHOLD}",
                  long_mask & hi_ml, results)
    report_bucket(f"  + TRENDING regime",
                  long_mask & hi_ml & (results['regime'] == 'TRENDING'), results)
    report_bucket(f"  + RANGING regime",
                  long_mask & hi_ml & (results['regime'] == 'RANGING'), results)
    report_bucket(f"  + TRANSITIONING regime",
                  long_mask & hi_ml & (results['regime'] == 'TRANSITIONING'), results)

    print(f"\n  === SHORT setups (aligned_bearish, n={(results['direction']==-1).sum():,}) ===")
    print(f"  bucket{' '*48} n      win%    EV(R)        cumR    bothBar  avgExit")
    print(f"  " + "-"*96)
    short_mask = (results['direction'] == -1)
    report_bucket("aligned_bearish — all",
                  short_mask, results)
    report_bucket(f"aligned_bearish + ML >= {ML_THRESHOLD}",
                  short_mask & hi_ml, results)
    report_bucket(f"  + TRENDING regime",
                  short_mask & hi_ml & (results['regime'] == 'TRENDING'), results)

    print(f"\n  === Aggregate diagnostics ===")
    print(f"  total setups resolved:          {len(results):,}")
    print(f"  setups with both hit in 1 bar:  {results['both_hit_in_bar'].sum():,} "
          f"({results['both_hit_in_bar'].mean()*100:.1f}%)")
    print(f"  avg time to exit:               {results['exit_bar'].mean():.2f} 4H bars")
    print(f"  setups exiting at horizon end:  {(results['exit_bar'] == HORIZON_BARS - 1).sum():,} "
          f"({(results['exit_bar'] == HORIZON_BARS - 1).mean()*100:.1f}%)")


if __name__ == '__main__':
    main()
