#!/usr/bin/env python3
"""Compare feature values of fold-5 worst losers vs best winners. The hypothesis
that 'losers are stretched names with high 52w/RSI/last3Green' didn't pan out
in the v4 backtest — the stretched filter didn't catch the losers. This script
shows the actual feature differences to figure out what DOES distinguish them.
"""
import glob
import os
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

CSV_DIR = '/Users/bojanmihovilovic/CryptoLens/ml-training/csv_exports_v13'

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


def main():
    files = sorted(glob.glob(f'{CSV_DIR}/*.csv'))
    print(f"Loading {len(files)} CSVs...")
    dfs = [pd.read_csv(f) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    df = df[df['fwdMaxFavR'].notna() & (df['atrPercent'].fillna(0) > 0)]
    df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
    for col in ('basisPct', 'basisExtreme'):
        if col not in df.columns: df[col] = 0.0
    df = df.sort_values('timestamp').reset_index(drop=True)

    n = len(df)
    train_end = int(n * 0.85)
    val_start = train_end + 48
    val_end = n
    train = df.iloc[:train_end]
    val = df.iloc[val_start:val_end].copy()
    print(f"  fold-5 train: {len(train):,}  val: {len(val):,}")

    model = xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )
    print("training fold-5 ML quality model...")
    model.fit(train[FEATURES].fillna(0), train['goodR'])
    val['mlProb'] = model.predict_proba(val[FEATURES].fillna(0))[:, 1]

    mask = (val['biasAlignment'] == 'aligned_bullish') & (val['mlProb'] >= 0.65)
    high_ml = val[mask].copy()
    print(f"\nfold-5 aligned_bullish + ML>=0.65: n={len(high_ml)}")

    losers = ['MRK','MCD','BA','META','NVDA','TGT','PLTR','ITW','TEAM','SLB']
    winners = ['AAPL','PLD','EQIX','XLY','REGN','MRVL','LLY','HYG','XLV','AMGN']

    l = high_ml[high_ml['symbol'].isin(losers)]
    w = high_ml[high_ml['symbol'].isin(winners)]
    print(f"  losers (n={len(l)}) vs winners (n={len(w)}):\n")

    cols = ['dRsi','hRsi','eRsi','dAdx','dMacdHist',
            'fiftyTwoWeekPct','distToFiftyTwoHigh',
            'dRsiDelta','last3Green','last3Red','last3VolIncreasing',
            'atrPercent','atrPercentile',
            'gapPercent','relStrengthVsSpy','beta',
            'vix','vixLevelCode','dxyAboveEma20','dxyMomentum','iwmSpyRatio',
            'earningsProximity','vixTermStructure',
            'dStackBull','dStackBear','dEmaCross','hEmaCross',
            'regimeCode','tfAlignment','momentumAlignment',
            'dBBPercentB','dBBSqueeze','dVolumeRatio',
            'vpDistToPocATR','vpDistToVAH_ATR','vpDistToVAL_ATR',
            'dAboveVwap','hAboveVwap',
            'shortVolumeRatio','shortVolumeZScore',
            'oiPriceInteraction','bodyWickRatio',
            'relStrengthVsSector']
    print(f"  {'feature':<28} losers   winners    diff")
    print(f"  " + "-"*60)
    rows = []
    for c in cols:
        if c not in high_ml.columns: continue
        lv = l[c].mean()
        wv = w[c].mean()
        diff = lv - wv
        rows.append((c, lv, wv, diff))
    # Sort by abs diff to surface biggest contrasts
    rows.sort(key=lambda x: -abs(x[3]) if not pd.isna(x[3]) else 0)
    for c, lv, wv, diff in rows[:25]:
        bar = '←L' if diff > 0 else 'W→'
        print(f"  {c:<28} {lv:>7.2f}   {wv:>7.2f}    {diff:>+7.2f}  {bar}")


if __name__ == '__main__':
    main()
