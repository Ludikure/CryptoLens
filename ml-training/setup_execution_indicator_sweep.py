#!/usr/bin/env python3
"""
Multi-indicator sweep: test every classical TA signal we have for directional
edge, with and without the ML quality filter.

Three categories of hypothesis:

  MEAN-REVERSION (extreme reading → opposite direction):
    - dRsi  oversold/overbought
    - dStochK  oversold/overbought
    - dBBPercentB  at/below lower band / at/above upper band
    - vpDistToVAL_ATR  near value-area-low → LONG (support)
    - vpDistToVAH_ATR  near value-area-high → SHORT (resistance)

  CONTINUATION (signal direction = trade direction):
    - dMacdCross  +1 → LONG, -1 → SHORT
    - dEmaCross   +1 → LONG, -1 → SHORT
    - dStochCross +1 → LONG, -1 → SHORT
    - dAdxBullish + high dAdx (strong trending up) → LONG
    - dAboveVwap  +1 → LONG (above), 0 → SHORT (below)

  DIVERGENCE:
    - dDivergence  positive → LONG (bullish div), negative → SHORT (bearish div)

For each: report n / win% / EV / cumR, with and without ML >= 0.65 gate,
plus aggregate across the 5-fold WF (2022-2026).

Setup math identical to v3: SL = 1.0 ATR, TP = 1.5 ATR, 24h horizon,
bar-by-bar fill from D1 candles.

Run:  python3 setup_execution_indicator_sweep.py
Prerequisite: ./stock_candles_4h.csv.gz
"""
import glob
import os
from typing import Callable

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


def load_data_and_train():
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
    n = len(df)
    print(f"  bars: {n:,}  | symbols: {df['symbol'].nunique()}")

    print(f"\n5-fold WF training to attach mlProb to every val bar...")
    val_dfs = []
    for i in range(N_FOLDS):
        train_end = int(n * (0.25 + i * 0.15))
        val_start = train_end + PURGE_BARS
        val_end = int(n * (0.40 + i * 0.15)) if i < N_FOLDS - 1 else n
        train = df.iloc[:train_end]
        val = df.iloc[val_start:val_end].copy()
        val['fold'] = i + 1
        m = xgb.XGBClassifier(
            max_depth=5, n_estimators=100, learning_rate=0.03,
            subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
            reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42,
        )
        m.fit(train[FEATURES].fillna(0), train['goodR'])
        val['mlProb'] = m.predict_proba(val[FEATURES].fillna(0))[:, 1]
        val_dfs.append(val)
        print(f"  fold {i+1}: {len(val):,} val rows")
    return pd.concat(val_dfs, ignore_index=True)


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


def resolve_with_signal(val_all, candle_idx, signal_fn: Callable):
    """signal_fn takes a row and returns +1 (LONG), -1 (SHORT), or 0 (skip)."""
    out = []
    for _, row in val_all.iterrows():
        direction = signal_fn(row)
        if direction == 0: continue
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
        out.append({'symbol': sym, 'fold': row['fold'], 'mlProb': row['mlProb'],
                    'direction': direction, 'R': r,
                    'biasAlignment': row['biasAlignment'], 'regime': row['regime']})
    return pd.DataFrame(out)


def report(name, results, ml_thresh=ML_THRESHOLD):
    """One row per indicator: aggregate stats + with-ML-filter stats."""
    if len(results) == 0:
        print(f"  {name:<48} no signals fired")
        return
    n_all = len(results)
    win_all = (results['R'] > 0).mean() * 100
    ev_all = results['R'].mean()
    cum_all = results['R'].sum()
    hi_ml = results[results['mlProb'] >= ml_thresh]
    n_ml = len(hi_ml)
    if n_ml == 0:
        ml_part = "  (no high-ML)"
    else:
        win_ml = (hi_ml['R'] > 0).mean() * 100
        ev_ml = hi_ml['R'].mean()
        cum_ml = hi_ml['R'].sum()
        sign_ml = '+' if ev_ml >= 0 else ''
        ml_part = f"  +ML: n={n_ml:>4,} win={win_ml:>4.1f}% EV={sign_ml}{ev_ml:>+5.3f}R cumR={cum_ml:>+7.1f}"
    sign_all = '+' if ev_all >= 0 else ''
    print(f"  {name:<48} n={n_all:>6,} win={win_all:>4.1f}% EV={sign_all}{ev_all:>+5.3f}R cumR={cum_all:>+8.1f}{ml_part}")


def main():
    val_all = load_data_and_train()
    print(f"\nLoading OHLC...")
    candle_idx = build_candle_index(pd.read_csv(CANDLES_PATH))

    # === MEAN-REVERSION INDICATORS ===
    print(f"\n========== MEAN-REVERSION (extreme reading → opposite direction) ==========")
    print(f"  format: indicator name → n / win% / EV / cumR  |  +ML: same stats with ML>=0.65\n")

    indicators_meanrev = {
        "dRsi <=30 LONG / >=70 SHORT":
            lambda r: 1 if r['dRsi'] <= 30 else (-1 if r['dRsi'] >= 70 else 0),
        "dRsi <=25 LONG / >=75 SHORT":
            lambda r: 1 if r['dRsi'] <= 25 else (-1 if r['dRsi'] >= 75 else 0),
        "dStochK <=20 LONG / >=80 SHORT":
            lambda r: 1 if r['dStochK'] <= 20 else (-1 if r['dStochK'] >= 80 else 0),
        "hStochK <=20 LONG / >=80 SHORT":
            lambda r: 1 if r['hStochK'] <= 20 else (-1 if r['hStochK'] >= 80 else 0),
        "dBBPercentB <=0.1 LONG / >=0.9 SHORT":
            lambda r: 1 if r['dBBPercentB'] <= 0.1 else (-1 if r['dBBPercentB'] >= 0.9 else 0),
        "hBBPercentB <=0.1 LONG / >=0.9 SHORT":
            lambda r: 1 if r['hBBPercentB'] <= 0.1 else (-1 if r['hBBPercentB'] >= 0.9 else 0),
        "vpDistToVAL<=0.3 LONG / vpDistToVAH<=0.3 SHORT (S/R proximity)":
            lambda r: (1 if r['vpDistToVAL_ATR'] <= 0.3 else
                       (-1 if r['vpDistToVAH_ATR'] <= 0.3 else 0)),
    }
    for name, fn in indicators_meanrev.items():
        results = resolve_with_signal(val_all, candle_idx, fn)
        report(name, results)

    # === CONTINUATION INDICATORS ===
    print(f"\n========== CONTINUATION (signal direction = trade direction) ==========\n")

    indicators_continuation = {
        "dMacdCross +1 LONG / -1 SHORT":
            lambda r: 1 if r['dMacdCross'] == 1 else (-1 if r['dMacdCross'] == -1 else 0),
        "dEmaCross +1 LONG / -1 SHORT":
            lambda r: 1 if r['dEmaCross'] == 1 else (-1 if r['dEmaCross'] == -1 else 0),
        "hEmaCross +1 LONG / -1 SHORT":
            lambda r: 1 if r['hEmaCross'] == 1 else (-1 if r['hEmaCross'] == -1 else 0),
        "dStochCross +1 LONG / -1 SHORT":
            lambda r: 1 if r['dStochCross'] == 1 else (-1 if r['dStochCross'] == -1 else 0),
        "dStackBull LONG / dStackBear SHORT":
            lambda r: (1 if r['dStackBull'] == 1 else (-1 if r['dStackBear'] == 1 else 0)),
        "dAboveVwap=1 LONG / =0 SHORT":
            lambda r: 1 if r['dAboveVwap'] == 1 else -1,
        "dAdx>25 + dAdxBullish=1 → LONG (strong trend)":
            lambda r: 1 if (r['dAdx'] > 25 and r['dAdxBullish'] == 1) else
                      (-1 if (r['dAdx'] > 25 and r['dAdxBullish'] == 0 and r['dStackBear'] == 1) else 0),
    }
    for name, fn in indicators_continuation.items():
        results = resolve_with_signal(val_all, candle_idx, fn)
        report(name, results)

    # === DIVERGENCE ===
    print(f"\n========== DIVERGENCE (bullish div LONG / bearish div SHORT) ==========\n")
    indicators_div = {
        "dDivergence +1 LONG / -1 SHORT":
            lambda r: 1 if r['dDivergence'] == 1 else (-1 if r['dDivergence'] == -1 else 0),
        "hDivergence +1 LONG / -1 SHORT":
            lambda r: 1 if r['hDivergence'] == 1 else (-1 if r['hDivergence'] == -1 else 0),
    }
    for name, fn in indicators_div.items():
        results = resolve_with_signal(val_all, candle_idx, fn)
        report(name, results)

    # === COMBINED — multi-indicator confirmations ===
    print(f"\n========== COMBINED CONFIRMATIONS ==========\n")
    indicators_combined = {
        "RSI+Stoch+BB triple oversold LONG / triple overbought SHORT":
            lambda r: (1 if (r['dRsi'] <= 35 and r['dStochK'] <= 25 and r['dBBPercentB'] <= 0.15) else
                       (-1 if (r['dRsi'] >= 65 and r['dStochK'] >= 75 and r['dBBPercentB'] >= 0.85) else 0)),
        "MACD+EMA cross both bullish LONG / both bearish SHORT":
            lambda r: (1 if (r['dMacdCross'] == 1 and r['dEmaCross'] == 1) else
                       (-1 if (r['dMacdCross'] == -1 and r['dEmaCross'] == -1) else 0)),
        "Div + RSI agreement (bullDiv+oversold LONG / bearDiv+overbought SHORT)":
            lambda r: (1 if (r['dDivergence'] == 1 and r['dRsi'] <= 40) else
                       (-1 if (r['dDivergence'] == -1 and r['dRsi'] >= 60) else 0)),
    }
    for name, fn in indicators_combined.items():
        results = resolve_with_signal(val_all, candle_idx, fn)
        report(name, results)


if __name__ == '__main__':
    main()
