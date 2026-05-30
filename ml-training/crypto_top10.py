#!/usr/bin/env python3
"""
Crypto setup-execution backtest restricted to the TOP 10 most-liquid symbols:
BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK, TRX.

Why this restriction: the full 75-symbol crypto backtest produced +0.842R EV
that looks too good to be true. A major suspected inflator is survivorship +
execution unrealities on the long tail of illiquid alts. Top-10 cryptos have:
  - Negligible delist/zero risk over the test period
  - Tight bid-ask spreads (1-5 bps)
  - Deep order books (real fills near posted prices)
  - Consistent exchange uptime
  - Funding rates that don't spike to extreme levels

If the +0.842R survives the restriction to just these 10, the edge is real.
If it collapses to +0.10-0.20R, the prior result was mostly survivorship/altcoin
artifacts.

Reports both full WF (2022-2026) and last-12-months for comparison.

Run:  python3 crypto_top10.py
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
N_FOLDS = 5

TOP10 = {'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
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


def load_features():
    files = sorted(glob.glob(os.path.join(CSV_DIR, '*.csv')))
    # Restrict to TOP10 ONLY
    files = [f for f in files if os.path.basename(f).replace('.csv', '') in TOP10]
    print(f"Loading {len(files)} top-10 crypto CSVs: {sorted(TOP10)}")
    dfs = [pd.read_csv(f) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[df['fwdMaxFavR'].notna() & (df['atrPercent'].fillna(0) > 0)]
    df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
    for col in ('basisPct', 'basisExtreme'):
        if col not in df.columns: df[col] = 0.0
    df = df.sort_values('timestamp').reset_index(drop=True)
    df['ts_ms'] = df['timestamp'] * 1000
    print(f"  total bars: {len(df):,}  | symbols: {df['symbol'].nunique()}")
    return df


def build_candle_index(candles):
    candles = candles[candles['symbol'].isin(TOP10)]
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
                    'dStochCross': row['dStochCross'], 'timestamp': row['timestamp'],
                    'fold': row.get('fold', 0)})
    return pd.DataFrame(out)


def make_model():
    return xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def walk_forward_5fold(df, candle_idx):
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
        results = resolve_setups(val, candle_idx)
        all_results.append(results)
    return pd.concat(all_results, ignore_index=True)


def last_12mo(df, candle_idx):
    last_ts = df['timestamp'].max()
    cutoff_ts = last_ts - 365 * 86400
    train_df = df[df['timestamp'] < cutoff_ts]
    val_df = df[df['timestamp'] >= cutoff_ts].copy()
    m = make_model()
    m.fit(train_df[FEATURES].fillna(0), train_df['goodR'])
    val_df['mlProb'] = m.predict_proba(val_df[FEATURES].fillna(0))[:, 1]
    val_df['fold'] = 99
    return resolve_setups(val_df, candle_idx)


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
    print(f"  {name:<54} n={n:>5,}  win={win:>4.1f}%  EV={sign}{ev:>+5.3f}R  cumR={cum:>+7.1f}")


def per_symbol_breakdown(results, label):
    print(f"\n  {label} — per symbol:")
    print(f"  symbol     n      win%    EV(R)       cumR")
    for sym in sorted(results['symbol'].unique()):
        sub = results[results['symbol'] == sym]
        n = len(sub)
        if n == 0: continue
        win = (sub['R'] > 0).mean() * 100
        ev = sub['R'].mean()
        cum = sub['R'].sum()
        sign = '+' if ev >= 0 else ''
        print(f"  {sym:<10} {n:>4}    {win:>4.1f}%   {sign}{ev:>+5.3f}R    {cum:>+6.1f}")


def main():
    df = load_features()
    candles = pd.read_csv(CANDLES_PATH)
    candle_idx = build_candle_index(candles)
    print(f"  candle index built for {len(candle_idx)} symbols")

    # =========================================
    # Test A: Full 5-fold WF (2022-2026)
    # =========================================
    print(f"\n{'='*70}")
    print(f"TEST A: 5-fold WF (2022-2026), TOP-10 ONLY")
    print(f"{'='*70}")
    results = walk_forward_5fold(df, candle_idx)
    print(f"\n  resolved {len(results):,} aligned setups across 5 folds")

    hi_ml = results['mlProb'] >= ML_THRESHOLD
    long_mask = (results['direction'] == 1)
    short_mask = (results['direction'] == -1)

    print(f"\n  bucket                                                 n      win%    EV(R)         cumR")
    print(f"  " + "-"*84)
    report_bucket("aligned_bullish — all (no ML filter)", long_mask, results)
    report_bucket(f"aligned_bullish + ML >= {ML_THRESHOLD}",
                  long_mask & hi_ml, results)
    report_bucket("aligned_bearish — all (no ML filter)", short_mask, results)
    report_bucket(f"aligned_bearish + ML >= {ML_THRESHOLD}",
                  short_mask & hi_ml, results)

    # Per-symbol breakdown for the LONG ML+ bucket
    per_symbol_breakdown(results[long_mask & hi_ml], "aligned_bullish + ML >= 0.65 (LONG)")
    per_symbol_breakdown(results[short_mask & hi_ml], "aligned_bearish + ML >= 0.65 (SHORT)")

    # =========================================
    # Test B: Last 12 months only
    # =========================================
    print(f"\n{'='*70}")
    print(f"TEST B: Last 12 months (May 2025 → May 2026), TOP-10 ONLY")
    print(f"{'='*70}")
    results12 = last_12mo(df, candle_idx)
    print(f"\n  resolved {len(results12):,} aligned setups in last 12 months")

    hi_ml12 = results12['mlProb'] >= ML_THRESHOLD
    long_mask12 = (results12['direction'] == 1)
    short_mask12 = (results12['direction'] == -1)

    print(f"\n  bucket                                                 n      win%    EV(R)         cumR")
    print(f"  " + "-"*84)
    report_bucket("aligned_bullish — all (no ML filter)", long_mask12, results12)
    report_bucket(f"aligned_bullish + ML >= {ML_THRESHOLD}",
                  long_mask12 & hi_ml12, results12)
    report_bucket("aligned_bearish — all (no ML filter)", short_mask12, results12)
    report_bucket(f"aligned_bearish + ML >= {ML_THRESHOLD}",
                  short_mask12 & hi_ml12, results12)

    per_symbol_breakdown(results12[long_mask12 & hi_ml12], "Last 12mo: aligned_bullish + ML >= 0.65")
    per_symbol_breakdown(results12[short_mask12 & hi_ml12], "Last 12mo: aligned_bearish + ML >= 0.65")

    # =========================================
    # Side-by-side comparison
    # =========================================
    print(f"\n{'='*70}")
    print(f"COMPARISON: Full universe (75) vs Top-10 only")
    print(f"{'='*70}")
    print(f"  bucket                                full universe    top-10 only")
    print(f"  " + "-"*72)
    # Re-fetch the prior 75-symbol numbers for comparison from comments
    print(f"  aligned_bullish + ML (5-fold)         +0.777R / n=8723   "
          f"{'+' if results[long_mask & hi_ml]['R'].mean() >= 0 else ''}{results[long_mask & hi_ml]['R'].mean():.3f}R / n={(long_mask & hi_ml).sum()}")
    print(f"  aligned_bearish + ML (5-fold)         +0.952R / n=7395   "
          f"{'+' if results[short_mask & hi_ml]['R'].mean() >= 0 else ''}{results[short_mask & hi_ml]['R'].mean():.3f}R / n={(short_mask & hi_ml).sum()}")
    print(f"  aligned_bullish + ML (last 12mo)      +0.842R / n=1512   "
          f"{'+' if results12[long_mask12 & hi_ml12]['R'].mean() >= 0 else ''}{results12[long_mask12 & hi_ml12]['R'].mean():.3f}R / n={(long_mask12 & hi_ml12).sum()}")
    print(f"  aligned_bearish + ML (last 12mo)      +0.881R / n=2522   "
          f"{'+' if results12[short_mask12 & hi_ml12]['R'].mean() >= 0 else ''}{results12[short_mask12 & hi_ml12]['R'].mean():.3f}R / n={(short_mask12 & hi_ml12).sum()}")


if __name__ == '__main__':
    main()
