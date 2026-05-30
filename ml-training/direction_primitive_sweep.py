#!/usr/bin/env python3
"""
Sweep every reasonable direction primitive against the rising-edge ML notification
path. Same methodology as direction_primitive_compare.py — only the direction
filter changes.

Candidate primitives tested:
  bias-aligned                (current production)
  dStochCross                 (winner so far — daily Stochastic RSI crossover)
  hStochCross                 (4H Stoch crossover)
  dStochCross AND hStochCross both agree
  dMacdCross                  (daily MACD signal-line crossover)
  hMacdCross                  (4H MACD crossover)
  dEmaCross                   (daily EMA crossover)
  hEmaCross                   (4H EMA crossover)
  dStack                      (dStackBull/dStackBear → directional)
  dDivergence                 (daily RSI divergence — contrarian)
  union of momentum signals   (any of dStochCross OR dMacdCross OR dEmaCross)
  union of all                (any directional indicator fires)

Each: rising-edge ML through 0.70 → take trade in indicator's direction →
resolve bar-by-bar with 1.0 ATR SL, 1.5 ATR TP, 24h horizon.

Run:  python3 direction_primitive_sweep.py
"""
import glob
import os

import numpy as np
import pandas as pd
import xgboost as xgb

ML_RISING_EDGE = 0.70
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
    val_all = val_all.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    val_all['prevMl'] = val_all.groupby('symbol')['mlProb'].shift(1)
    val_all['risingEdge'] = (
        (val_all['prevMl'] < ML_RISING_EDGE) &
        (val_all['mlProb'] >= ML_RISING_EDGE)
    )
    return val_all


# ─── Direction primitives ─────────────────────────────────────────────────

def dir_bias(row):
    a = row['biasAlignment']
    return 1 if a == 'aligned_bullish' else (-1 if a == 'aligned_bearish' else 0)

def dir_dStoch(row):
    s = row['dStochCross']
    return 1 if s == 1 else (-1 if s == -1 else 0)

def dir_hStoch(row):
    s = row['hStochCross']
    return 1 if s == 1 else (-1 if s == -1 else 0)

def dir_dh_stoch_agree(row):
    d, h = row['dStochCross'], row['hStochCross']
    if d != 0 and h != 0 and d == h: return int(d)
    return 0

def dir_dMacd(row):
    m = row['dMacdCross']
    return 1 if m == 1 else (-1 if m == -1 else 0)

def dir_hMacd(row):
    m = row['hMacdCross']
    return 1 if m == 1 else (-1 if m == -1 else 0)

def dir_dEma(row):
    e = row['dEmaCross']
    return 1 if e == 1 else (-1 if e == -1 else 0)

def dir_hEma(row):
    e = row['hEmaCross']
    return 1 if e == 1 else (-1 if e == -1 else 0)

def dir_dStack(row):
    if row['dStackBull'] == 1 and row['dStackBear'] == 0: return 1
    if row['dStackBear'] == 1 and row['dStackBull'] == 0: return -1
    return 0

def dir_dDivergence(row):
    d = row['dDivergence']
    return 1 if d == 1 else (-1 if d == -1 else 0)

def dir_momentum_union(row):
    """Any of dStochCross, dMacdCross, dEmaCross fires. Pick majority; skip if
    they disagree."""
    signals = [row['dStochCross'], row['dMacdCross'], row['dEmaCross']]
    nonzero = [s for s in signals if s != 0]
    if not nonzero: return 0
    s = sum(nonzero)
    if s > 0: return 1
    if s < 0: return -1
    return 0  # exact tie, skip

def dir_bias_or_dStoch(row):
    """Union: bias OR Stoch. Skip on conflict."""
    b = dir_bias(row); s = dir_dStoch(row)
    if b != 0 and s != 0 and b != s: return 0  # conflict
    return b if b != 0 else s


# ─── Resolution + reporting ───────────────────────────────────────────────

def resolve_setup(row, candle_idx, direction):
    if direction == 0: return None
    sym = row['symbol']
    if sym not in candle_idx: return None
    atr_pct = row['atrPercent']
    if atr_pct <= 0: return None
    entry = row['price']
    atr_price = entry * atr_pct / 100.0
    if direction == 1:
        sl, tp = entry - atr_price * SL_ATR, entry + atr_price * TP_ATR
    else:
        sl, tp = entry + atr_price * SL_ATR, entry - atr_price * TP_ATR
    cdata = candle_idx[sym]
    i = np.searchsorted(cdata['ts'], row['ts_ms'], side='right')
    if i >= len(cdata['ts']): return None
    block = {k: cdata[k][i:i+HORIZON_BARS] for k in ('open','high','low','close')}
    if len(block['high']) == 0: return None
    return resolve_fill(direction, entry, sl, tp, block)


def run_filter(rising, candle_idx, fn):
    rows = []
    for _, row in rising.iterrows():
        d = fn(row)
        if d == 0: continue
        r = resolve_setup(row, candle_idx, d)
        if r is None: continue
        rows.append({'symbol': row['symbol'], 'direction': d, 'R': r})
    return pd.DataFrame(rows)


def report(label, df):
    n = len(df)
    if n == 0:
        print(f"  {label:<48} n=    0")
        return
    win = (df['R'] > 0).mean() * 100
    ev = df['R'].mean()
    cum = df['R'].sum()
    n_long = (df['direction'] == 1).sum()
    n_short = (df['direction'] == -1).sum()
    sign = '+' if ev >= 0 else ''
    print(f"  {label:<48} n={n:>5,}  L={n_long:>4}/S={n_short:>4}  win={win:>4.1f}%  "
          f"EV={sign}{ev:>+5.3f}R  totalR={cum:>+8.1f}")


def run_market(label, csv_dir, candles_path, symbol_filter=None):
    print(f"\n{'='*100}")
    print(f"{label}")
    print(f"{'='*100}")
    print(f"  Loading + training...")
    df = load_features(csv_dir, symbol_filter)
    candle_idx = build_candle_index(candles_path, symbol_filter)
    print(f"  bars: {len(df):,}  | symbols: {df['symbol'].nunique()}")
    val_all = wf_predict(df)
    val_all = find_rising_edges(val_all)
    rising = val_all[val_all['risingEdge']].copy()
    print(f"  rising-edge ML events: {len(rising):,}")
    print(f"\n  Resolving setups for each primitive...")

    primitives = [
        ('bias-aligned (CURRENT PRODUCTION)',       dir_bias),
        ('dStochCross  (daily Stoch)',              dir_dStoch),
        ('hStochCross  (4H Stoch)',                 dir_hStoch),
        ('dStoch AND hStoch agree',                 dir_dh_stoch_agree),
        ('dMacdCross   (daily MACD signal-line)',   dir_dMacd),
        ('hMacdCross   (4H MACD)',                  dir_hMacd),
        ('dEmaCross    (daily EMA crossover)',      dir_dEma),
        ('hEmaCross    (4H EMA crossover)',         dir_hEma),
        ('dStack       (bull/bear EMA stack)',      dir_dStack),
        ('dDivergence  (daily RSI divergence)',     dir_dDivergence),
        ('momentum union (Stoch OR Macd OR Ema)',   dir_momentum_union),
        ('bias OR dStoch (union, prior winner)',    dir_bias_or_dStoch),
    ]

    print(f"\n  Filter                                           n      L/S        win%    EV(R)        totalR")
    print(f"  " + "-"*100)
    for name, fn in primitives:
        results = run_filter(rising, candle_idx, fn)
        report(name, results)


def main():
    run_market("STOCKS (159 symbols, 2022-2026)",
               '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v13',
               '/Users/bojanmihovilovic/CryptoLens/ml-training/stock_candles_4h.csv.gz')
    run_market("CRYPTO TOP-10 (BTC/ETH/SOL/BNB/XRP/ADA/DOGE/AVAX/LINK/TRX)",
               '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v11',
               '/Users/bojanmihovilovic/CryptoLens/ml-training/crypto_candles_4h.csv.gz',
               symbol_filter=TOP10_CRYPTO)


if __name__ == '__main__':
    main()
