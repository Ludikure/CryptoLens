#!/usr/bin/env python3
"""
Setup-execution backtest: measures REALIZED R per setup across the test set,
not direction-agnostic goodR per bar.

Per-bar metrics (what the auto-FLAT backtest measured) answer "is volatility
favorable?". This script answers the actually-load-bearing question: "if you
take the trade — entry, SL, TP — what's the realized expectancy?"

Setup definition (deterministic stand-in for the LLM's full thesis):
  Direction:  from biasAlignment label
              aligned_bullish → LONG, aligned_bearish → SHORT, else no setup
  Entry:      current bar close (immediate fill assumed)
  SL:         entry ± 1.0 ATR (adverse)
  TP1:        entry ± 1.5 ATR (favorable)
  Horizon:    24h (6 × 4H bars)
  R:R:        1.5:1

Outcome resolution (within 24h window):
  fwdMaxUp24H and fwdMaxDown24H tell us whether each level was touched, but
  not the order. For LONG setups (mirror for SHORT):
    upR  = fwdMaxUp24H  / atrPercent   (favorable excursion in ATR units)
    dnR  = fwdMaxDown24H / atrPercent  (adverse excursion in ATR units)
    only-TP hit (upR >= 1.5, dnR < 1.0):       R = +1.5  (clean win)
    only-SL hit (dnR >= 1.0, upR < 1.5):       R = -1.0  (clean loss)
    both hit (upR >= 1.5 AND dnR >= 1.0):      ambiguous — see assumption
    neither hit (close at end of window):       R = fwdReturn24H / atrPercent

Both-hit assumption defaults to PESSIMISTIC (SL first → R = -1.0). Optimistic
and 50/50 bounds also reported so the result range is visible.

Outputs per bucket:
  - n setups
  - win rate
  - avg R / setup (expected value, the bottom line)
  - cumulative R
  - both-hit %, neither-hit % (diagnostics)

Run:  python3 setup_execution_backtest.py
"""
import glob
import os
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

CSV_DIR = os.path.join(os.path.dirname(__file__), 'csv_exports_v13')
ML_THRESHOLD = 0.65
TRAIN_FRAC = 0.80
SL_ATR = 1.0   # stop distance in ATR units
TP_ATR = 1.5   # target distance in ATR units
ML_QUALITY_TARGET = 1.5  # the goodR_1.5 target the production ML is trained on

# Same 111-feature list as production (calibrate_v13_stocks.py).
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
assert len(FEATURES) == 111


def load_data():
    files = sorted(glob.glob(os.path.join(CSV_DIR, '*.csv')))
    if not files:
        sys.exit(f"No CSVs in {CSV_DIR}")
    print(f"Loading {len(files)} stock CSVs...")
    dfs = [pd.read_csv(f) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    # Drop rows with NaN target. atrPercent must be > 0 to convert percent
    # excursions to ATR multiples.
    df = df[df['fwdMaxFavR'].notna() & (df['atrPercent'].fillna(0) > 0)]
    df['goodR'] = (df['fwdMaxFavR'] >= ML_QUALITY_TARGET).astype(int)
    for col in ('basisPct', 'basisExtreme'):
        if col not in df.columns:
            df[col] = 0.0
    df = df.sort_values('timestamp').reset_index(drop=True)
    print(f"  total bars: {len(df):,}  | symbols: {df['symbol'].nunique()}")
    return df


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
    print(f"  fitting XGBoost on quality target (goodR_{ML_QUALITY_TARGET})...")
    model.fit(train[FEATURES].fillna(0), train['goodR'])
    test['mlProb'] = model.predict_proba(test[FEATURES].fillna(0))[:, 1]
    return test


def compute_outcomes(test):
    """Per-bar setup outcome under our deterministic setup rules. Computes
    realized R for LONG and SHORT separately (only one is used per row,
    depending on bias direction)."""
    upR = test['fwdMaxUp24H'] / test['atrPercent']    # favorable excursion ATR (long view)
    dnR = test['fwdMaxDown24H'] / test['atrPercent']  # adverse excursion ATR (long view)
    # Close-to-close R if neither level is touched.
    fwdR = test['fwdReturn24H'] / test['atrPercent']

    # LONG outcomes
    long_only_tp = (upR >= TP_ATR) & (dnR < SL_ATR)
    long_only_sl = (dnR >= SL_ATR) & (upR < TP_ATR)
    long_both = (upR >= TP_ATR) & (dnR >= SL_ATR)
    long_neither = ~(long_only_tp | long_only_sl | long_both)
    # SHORT outcomes (mirror)
    short_only_tp = (dnR >= TP_ATR) & (upR < SL_ATR)
    short_only_sl = (upR >= SL_ATR) & (dnR < TP_ATR)
    short_both = (dnR >= TP_ATR) & (upR >= SL_ATR)
    short_neither = ~(short_only_tp | short_only_sl | short_both)

    # Pessimistic both-hit assumption (SL first → R = -SL_ATR).
    test = test.copy()
    test['long_R_pess'] = np.where(long_only_tp, TP_ATR,
                          np.where(long_only_sl, -SL_ATR,
                          np.where(long_both, -SL_ATR,
                          np.clip(fwdR, -SL_ATR, TP_ATR))))  # neither case clipped to band
    test['long_R_opt'] = np.where(long_only_tp, TP_ATR,
                          np.where(long_only_sl, -SL_ATR,
                          np.where(long_both, TP_ATR,
                          np.clip(fwdR, -SL_ATR, TP_ATR))))
    test['short_R_pess'] = np.where(short_only_tp, TP_ATR,
                           np.where(short_only_sl, -SL_ATR,
                           np.where(short_both, -SL_ATR,
                           np.clip(-fwdR, -SL_ATR, TP_ATR))))
    test['short_R_opt'] = np.where(short_only_tp, TP_ATR,
                          np.where(short_only_sl, -SL_ATR,
                          np.where(short_both, TP_ATR,
                          np.clip(-fwdR, -SL_ATR, TP_ATR))))
    # Diagnostic flags for the report
    test['long_both_hit'] = long_both.astype(int)
    test['short_both_hit'] = short_both.astype(int)
    test['long_neither_hit'] = long_neither.astype(int)
    test['short_neither_hit'] = short_neither.astype(int)
    return test


def report_bucket(name, mask, test, direction='long'):
    sub = test[mask]
    n = len(sub)
    if n == 0:
        print(f"  {name:<54} n=0")
        return
    r_pess = sub[f'{direction}_R_pess']
    r_opt = sub[f'{direction}_R_opt']
    win_rate = (r_pess > 0).mean()  # pessimistic win rate
    ev_pess = r_pess.mean()
    ev_opt = r_opt.mean()
    cum_pess = r_pess.sum()
    both_pct = sub[f'{direction}_both_hit'].mean() * 100
    neither_pct = sub[f'{direction}_neither_hit'].mean() * 100
    sign = '+' if ev_pess >= 0 else ''
    print(f"  {name:<54} n={n:>5}  win={win_rate*100:>4.1f}%  "
          f"EV(pess)={sign}{ev_pess:>+5.3f}R  EV(opt)={ev_opt:>+5.3f}R  "
          f"cumR={cum_pess:>+7.1f}  both={both_pct:>4.1f}%  none={neither_pct:>4.1f}%")


def main():
    df = load_data()
    test = train_and_predict(df)
    test = compute_outcomes(test)

    print(f"\n=== Setup execution backtest (SL=1.0 ATR, TP=1.5 ATR, 24h horizon) ===")
    print(f"Pessimistic = SL hit first on both-hit ambiguity (lower bound).")
    print(f"Optimistic  = TP hit first on both-hit ambiguity (upper bound).")
    print(f"win% measured on pessimistic R.\n")

    hi_ml = test['mlProb'] >= ML_THRESHOLD

    # --- LONG buckets ---
    print(f"\n  === LONG setups (taken on aligned_bullish + variants) ===")
    print(f"  bucket{' '*48} n      win%    EV(R)            cumR    both%  none%")
    print(f"  " + "-"*96)
    al_bull = test['biasAlignment'] == 'aligned_bullish'
    report_bucket("aligned_bullish — all (baseline LONG filter)",
                  al_bull, test, 'long')
    report_bucket(f"aligned_bullish + ML >= {ML_THRESHOLD}",
                  al_bull & hi_ml, test, 'long')
    report_bucket(f"aligned_bullish + ML >= {ML_THRESHOLD} + TRENDING",
                  al_bull & hi_ml & (test['regime'] == 'TRENDING'), test, 'long')
    report_bucket(f"aligned_bullish + ML >= {ML_THRESHOLD} + RANGING",
                  al_bull & hi_ml & (test['regime'] == 'RANGING'), test, 'long')
    report_bucket(f"aligned_bullish + ML >= {ML_THRESHOLD} + TRANSITIONING",
                  al_bull & hi_ml & (test['regime'] == 'TRANSITIONING'), test, 'long')
    print()
    # Counterfactual: take a LONG without the bias filter. Does dropping the
    # alignment requirement help or hurt expectancy?
    report_bucket(f"ANY bar + ML >= {ML_THRESHOLD} (LONG, no bias filter)",
                  hi_ml, test, 'long')
    print()
    # The auto-FLAT-blocked bucket: PLTR-style setups currently refused
    mixed_bull = (test['dailyBias'].isin(['Neutral', 'Bearish', 'Strong Bearish'])
                  & test['fourHBias'].isin(['Bullish', 'Strong Bullish'])
                  & test['oneHBias'].isin(['Bullish', 'Strong Bullish']))
    report_bucket(f"mixed_bullish + ML >= {ML_THRESHOLD} (LONG — the PLTR case)",
                  mixed_bull & hi_ml, test, 'long')

    # --- SHORT buckets ---
    print(f"\n  === SHORT setups (taken on aligned_bearish + variants) ===")
    print(f"  bucket{' '*48} n      win%    EV(R)            cumR    both%  none%")
    print(f"  " + "-"*96)
    al_bear = test['biasAlignment'] == 'aligned_bearish'
    report_bucket("aligned_bearish — all (baseline SHORT filter)",
                  al_bear, test, 'short')
    report_bucket(f"aligned_bearish + ML >= {ML_THRESHOLD}",
                  al_bear & hi_ml, test, 'short')
    report_bucket(f"aligned_bearish + ML >= {ML_THRESHOLD} + TRENDING",
                  al_bear & hi_ml & (test['regime'] == 'TRENDING'), test, 'short')

    # === Summary ===
    print(f"\n=== Summary ===")
    print(f"Pessimistic EV is the conservative bound (assumes SL hits before TP")
    print(f"when both levels are touched). Optimistic is the upper bound. The")
    print(f"truth is somewhere between — and depends on intra-bar order, which")
    print(f"the CSV summary statistics can't recover. For a clean answer, the")
    print(f"next step is reading raw 4H OHLC and resolving fills bar-by-bar.\n")
    print(f"Key question: does any filter combination yield a positive EV(pess)?")
    print(f"If yes, that filter combination has demonstrable trade-level edge.")
    print(f"If all combinations are negative even at the optimistic bound, the")
    print(f"R:R = 1.5 with these filters is structurally unprofitable.")


if __name__ == '__main__':
    main()
