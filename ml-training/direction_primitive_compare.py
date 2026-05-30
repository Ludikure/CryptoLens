#!/usr/bin/env python3
"""
Apples-to-apples: which direction primitive performs best as a filter
on top of rising-edge ML cross through 0.70?

All filters use:
  - Same ML quality threshold (rising edge through 0.70)
  - Same SL/TP (1.0/1.5 ATR)
  - Same 24h horizon
  - Same bar-by-bar fill resolution
Only the direction-defining filter changes:

  B   bias-aligned:   trade in biasAlignment direction
                      (aligned_bullish→LONG, aligned_bearish→SHORT)
                      [current production behavior]

  C   Stoch-aligned:  trade in dStochCross direction
                      (+1→LONG, -1→SHORT)
                      [potential simpler alternative]

  D   Union:          take whichever direction fires;
                      if both fire AND agree → take it;
                      if both fire AND disagree → skip (conflict);
                      if only one fires → take that direction

If C beats B, the bias scoring system can probably be simplified to just Stoch.
If B beats C, bias is the right primitive — Stoch is redundant for direction.
If D beats both, the union widens the net usefully.

Run:  python3 direction_primitive_compare.py
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


def bias_direction(row):
    """+1 for aligned_bullish, -1 for aligned_bearish, 0 otherwise."""
    a = row['biasAlignment']
    if a == 'aligned_bullish': return 1
    if a == 'aligned_bearish': return -1
    return 0


def stoch_direction(row):
    """+1 for bullish Stoch cross, -1 for bearish, 0 if no cross."""
    s = row['dStochCross']
    if s == 1: return 1
    if s == -1: return -1
    return 0


def resolve_setup(row, candle_idx, direction):
    """Bar-by-bar resolve for a given direction. Returns R or None."""
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


def run_filter(rising_edges, candle_idx, direction_fn, name):
    """Apply direction_fn to each rising-edge bar; return list of R results."""
    rows = []
    for _, row in rising_edges.iterrows():
        d = direction_fn(row)
        if d == 0: continue
        r = resolve_setup(row, candle_idx, d)
        if r is None: continue
        rows.append({'symbol': row['symbol'], 'direction': d, 'R': r,
                     'mlProb': row['mlProb'], 'biasAlignment': row['biasAlignment'],
                     'dStochCross': row['dStochCross']})
    return pd.DataFrame(rows)


def run_filter_union(rising_edges, candle_idx):
    """Union: take bias direction if it fires; else Stoch direction; if both
    fire and disagree, skip; if both agree, take it. Returns same shape df."""
    rows = []
    for _, row in rising_edges.iterrows():
        b = bias_direction(row)
        s = stoch_direction(row)
        # Conflict: both fire, opposite directions → skip
        if b != 0 and s != 0 and b != s: continue
        # At least one fires → use whichever is non-zero (or either if both agree)
        d = b if b != 0 else s
        if d == 0: continue
        r = resolve_setup(row, candle_idx, d)
        if r is None: continue
        rows.append({'symbol': row['symbol'], 'direction': d, 'R': r,
                     'mlProb': row['mlProb'], 'biasAlignment': row['biasAlignment'],
                     'dStochCross': row['dStochCross']})
    return pd.DataFrame(rows)


def report(label, df):
    n = len(df)
    if n == 0:
        print(f"  {label:<46} n=    0")
        return
    win = (df['R'] > 0).mean() * 100
    ev = df['R'].mean()
    cum = df['R'].sum()
    n_long = (df['direction'] == 1).sum()
    n_short = (df['direction'] == -1).sum()
    sign = '+' if ev >= 0 else ''
    print(f"  {label:<46} n={n:>5,}  L={n_long:>4}/S={n_short:>4}  win={win:>4.1f}%  "
          f"EV={sign}{ev:>+5.3f}R  totalR={cum:>+8.1f}")


def run_market(label, csv_dir, candles_path, symbol_filter=None):
    print(f"\n{'='*96}")
    print(f"{label}")
    print(f"{'='*96}")
    print(f"  Loading + training...")
    df = load_features(csv_dir, symbol_filter)
    candle_idx = build_candle_index(candles_path, symbol_filter)
    print(f"  bars: {len(df):,}  | symbols: {df['symbol'].nunique()}")
    val_all = wf_predict(df)
    val_all = find_rising_edges(val_all)
    rising = val_all[val_all['risingEdge']].copy()
    print(f"  rising-edge ML events: {len(rising):,}")

    # Filter B: bias direction
    print(f"\n  Resolving setups...")
    B = run_filter(rising, candle_idx, bias_direction, "B")
    # Filter C: Stoch direction
    C = run_filter(rising, candle_idx, stoch_direction, "C")
    # Filter D: Union (bias-or-Stoch, skip conflicts)
    D = run_filter_union(rising, candle_idx)
    # Filter E (the previously rejected): bias AND Stoch agreeing
    def bias_and_stoch_agree(row):
        b = bias_direction(row); s = stoch_direction(row)
        if b != 0 and s != 0 and b == s: return b
        return 0
    E = run_filter(rising, candle_idx, bias_and_stoch_agree, "E")

    print(f"\n  Filter                                         n      L/S        win%     EV(R)       totalR")
    print(f"  " + "-"*96)
    report("B  bias-aligned only (current production)", B)
    report("C  Stoch cross only (proposed alternative)", C)
    report("D  union: bias OR Stoch (skip conflicts)", D)
    report("E  intersection: bias AND Stoch agree", E)

    # Subtests: how much overlap exists between bias and Stoch?
    bias_fires = rising['biasAlignment'].isin(['aligned_bullish', 'aligned_bearish'])
    stoch_fires = rising['dStochCross'] != 0
    both_fire = bias_fires & stoch_fires
    only_bias = bias_fires & ~stoch_fires
    only_stoch = ~bias_fires & stoch_fires
    # Agreement among bars where both fire:
    both_df = rising[both_fire]
    if len(both_df) > 0:
        bd = both_df['biasAlignment'].map({'aligned_bullish': 1, 'aligned_bearish': -1})
        sd = both_df['dStochCross']
        agree = (bd == sd).sum()
        disagree = (bd != sd).sum()
    else:
        agree = disagree = 0
    print(f"\n  Overlap diagnostics on rising-edge bars (n={len(rising)}):")
    print(f"    bias fires:      {bias_fires.sum():>5,}  ({bias_fires.sum()/len(rising)*100:.1f}%)")
    print(f"    Stoch fires:     {stoch_fires.sum():>5,}  ({stoch_fires.sum()/len(rising)*100:.1f}%)")
    print(f"    Both fire:       {both_fire.sum():>5,}  ({both_fire.sum()/len(rising)*100:.1f}%)")
    print(f"      ...agree:      {agree:>5,}  ({agree/max(1,both_fire.sum())*100:.1f}% of both-fire)")
    print(f"      ...disagree:   {disagree:>5,}  ({disagree/max(1,both_fire.sum())*100:.1f}% of both-fire)")
    print(f"    Only bias:       {only_bias.sum():>5,}")
    print(f"    Only Stoch:      {only_stoch.sum():>5,}")


def main():
    run_market("STOCKS (159 symbols, 2022-2026)",
               '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v13',
               '/Users/bojanmihovilovic/CryptoLens/ml-training/stock_candles_4h.csv.gz')
    run_market("CRYPTO TOP-10 (BTC/ETH/SOL/BNB/XRP/ADA/DOGE/AVAX/LINK/TRX, 2022-2026)",
               '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v11',
               '/Users/bojanmihovilovic/CryptoLens/ml-training/crypto_candles_4h.csv.gz',
               symbol_filter=TOP10_CRYPTO)


if __name__ == '__main__':
    main()
