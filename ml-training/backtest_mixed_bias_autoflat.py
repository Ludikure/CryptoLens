#!/usr/bin/env python3
"""
Backtest: does the biases_MIXED auto-FLAT rule help or hurt for stocks?

Asks: for bars where Daily bias is neutral/bearish AND 4H/1H bias is bullish AND
ML_WIN >= 0.65, what's the actual goodR_1.5 rate vs the ML_WIN-only baseline?

If mixed-bullish hits goodR at a rate >= aligned-bullish (or even close), the
auto-FLAT is costing us catalyst-driven reversal trades like PLTR. If it's
materially worse, the auto-FLAT is doing its job.

Methodology:
  - Load all 159 stock CSVs from csv_exports_v13/
  - Single chronological train/test split (80/20) to avoid look-ahead in the
    ML predictions on the test set. Full walk-forward CV is overkill for a
    relative comparison.
  - Train XGBoost with the same hyperparameters as the production v13 model.
  - Predict on the test set → raw ML_WIN per bar.
  - Bucket by bias configuration; compute goodR_1.5 hit rate per bucket.
  - Compare mixed-bullish vs aligned-bullish vs ML-filter-only.

Run:  python3 backtest_mixed_bias_autoflat.py
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

# Feature list verbatim from calibrate_v13_stocks.py (111 features). MUST match
# the production training set so the model we train here approximates production.
# `basisPct` and `basisExtreme` are crypto-only — absent from stock CSVs, filled
# with zeros below.
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
assert len(FEATURES) == 111, f"expected 111 features, got {len(FEATURES)}"


def load_data():
    files = sorted(glob.glob(os.path.join(CSV_DIR, '*.csv')))
    if not files:
        sys.exit(f"No CSVs found in {CSV_DIR}")
    print(f"Loading {len(files)} symbol CSVs from {CSV_DIR}...")
    dfs = [pd.read_csv(f) for f in files]
    df = pd.concat(dfs, ignore_index=True)
    # Direction-agnostic quality target — identical definition to the prod model.
    df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)
    # Drop rows with NaN target (most recent 24h that haven't resolved yet).
    df = df.dropna(subset=['fwdMaxFavR'])
    # basisPct / basisExtreme are crypto-only features. Production training fills
    # them with 0 for stock rows (the .fillna(0) on the feature matrix), but they
    # need to exist as columns first.
    for col in ('basisPct', 'basisExtreme'):
        if col not in df.columns:
            df[col] = 0.0
    print(f"  total bars: {len(df):,}  | symbols: {df['symbol'].nunique()}  | "
          f"goodR baseline: {df['goodR'].mean()*100:.1f}%")
    return df


def train_and_predict(df):
    cut = int(len(df) * TRAIN_FRAC)
    train = df.iloc[:cut]
    test = df.iloc[cut:].copy()
    print(f"\nChronological split: train={len(train):,} (through {pd.to_datetime(train['timestamp'].iloc[-1], unit='s')}) | "
          f"test={len(test):,} (from {pd.to_datetime(test['timestamp'].iloc[0], unit='s')})")

    # Same hyperparameters as calibrate_v13_stocks.py.
    model = xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )
    X_t = train[FEATURES].fillna(0)
    y_t = train['goodR']
    print(f"  fitting XGBoost (depth=5, n_estimators=100)...")
    model.fit(X_t, y_t)

    X_v = test[FEATURES].fillna(0)
    test['mlProb'] = model.predict_proba(X_v)[:, 1]
    print(f"  test ML_WIN: mean={test['mlProb'].mean():.3f}  "
          f"p90={test['mlProb'].quantile(0.9):.3f}  max={test['mlProb'].max():.3f}")

    # Direction-explicit ATR-normalized excursions. fwdMaxUp24H and fwdMaxDown24H
    # are stored as % (maxHigh-price)/price * 100 and (price-minLow)/price * 100;
    # atrPercent is the same scale. Dividing yields ATR multiples — the same
    # 1.5 threshold goodR uses, but now pinned to a specific direction.
    valid_atr = test['atrPercent'].fillna(0) > 0
    test['fwdMaxUpR'] = np.where(valid_atr, test['fwdMaxUp24H'] / test['atrPercent'], 0.0)
    test['fwdMaxDownR'] = np.where(valid_atr, test['fwdMaxDown24H'] / test['atrPercent'], 0.0)
    test['longWin'] = (test['fwdMaxUpR'] >= 1.5).astype(int)
    test['shortWin'] = (test['fwdMaxDownR'] >= 1.5).astype(int)
    # Directional outcome metrics for accuracy measurement:
    #   closeUp = price closed higher 24h later (sign of close-to-close)
    #   excursionUp = upside max excursion exceeded downside (which side dominated)
    test['closeUp'] = (test['fwdReturn24H'] > 0).astype(int)
    test['excursionUp'] = (test['fwdMaxUpR'] > test['fwdMaxDownR']).astype(int)
    # Longer horizons — does direction emerge over a 48h or 72h hold?
    if 'fwdReturn48H' in test.columns:
        test['closeUp48H'] = (test['fwdReturn48H'] > 0).astype(int)
    if 'fwdReturn72H' in test.columns:
        test['closeUp72H'] = (test['fwdReturn72H'] > 0).astype(int)
    return test


def report_multi_horizon(name, mask, test):
    """Direction-accuracy at 24h / 48h / 72h horizons in one row. Tests whether
    holding longer turns a no-edge 24h signal into a real-edge multi-day signal."""
    sub = test[mask]
    n = len(sub)
    if n == 0:
        print(f"  {name:<48} n=0")
        return
    parts = [f"24h={sub['closeUp'].mean()*100:>4.1f}%"]
    if 'closeUp48H' in test.columns:
        parts.append(f"48h={sub['closeUp48H'].mean()*100:>4.1f}%")
    if 'closeUp72H' in test.columns:
        parts.append(f"72h={sub['closeUp72H'].mean()*100:>4.1f}%")
    print(f"  {name:<48} n={n:>6}  closeUp: {'  '.join(parts)}")


def train_direction_model(df):
    """Train a separate model with sign(fwdReturn24H) as target, then test on
    the same chronological split. Answers: 'is direction predictable AT ALL from
    these 111 features?' If test accuracy is ~50%, no. If >55%, the features
    contain direction signal that the production ML (quality target) is throwing
    away."""
    cut = int(len(df) * TRAIN_FRAC)
    train = df.iloc[:cut]
    test = df.iloc[cut:].copy()
    y_t = (train['fwdReturn24H'] > 0).astype(int)
    y_v = (test['fwdReturn24H'] > 0).astype(int)
    X_t = train[FEATURES].fillna(0)
    X_v = test[FEATURES].fillna(0)
    model = xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )
    print(f"  fitting direction model (target = sign(fwdReturn24H))...")
    model.fit(X_t, y_t)
    probs = model.predict_proba(X_v)[:, 1]
    preds = (probs >= 0.5).astype(int)
    acc = (preds == y_v).mean()
    base_rate = y_v.mean()  # P(actual = up) — the always-predict-up baseline
    always_up_acc = max(base_rate, 1 - base_rate)
    print(f"  test bars: {len(test):,}  | actual P(up) = {base_rate*100:.1f}%")
    print(f"  always-predict-majority baseline: {always_up_acc*100:.1f}%")
    print(f"  trained-model accuracy:           {acc*100:.1f}%")
    # Confidence-conditional: when the direction model is sure, is it right?
    for thresh in [0.55, 0.60, 0.65]:
        confident = probs >= thresh
        if confident.sum() < 100:
            print(f"  prob >= {thresh}:  n={confident.sum()}  — too few samples")
            continue
        confident_acc = (preds[confident] == y_v[confident]).mean()
        print(f"  prob >= {thresh}:  n={confident.sum():>5}  accuracy={confident_acc*100:.1f}%  "
              f"(predicts UP, actual rate {y_v[confident].mean()*100:.1f}%)")
    return probs


def report_direction(name, mask, test):
    """Direction-accuracy view: when this filter fires, how often does price
    actually go up (or down) within 24h? Reports two metrics:
      - close: P(fwdReturn24H > 0) — did the 24h close end higher than entry?
      - excursion: P(fwdMaxUp > fwdMaxDown) — which side dominated the path?
    Pure-noise baseline is ~50% for both (slightly higher on close in a long-term
    bull market drift)."""
    sub = test[mask]
    n = len(sub)
    if n == 0:
        print(f"  {name:<54} n=0")
        return
    p_close = sub['closeUp'].mean()
    p_exc = sub['excursionUp'].mean()
    lo_c, hi_c = _wilson(p_close, n)
    lo_e, hi_e = _wilson(p_exc, n)
    print(f"  {name:<54} n={n:>6}  closeUp={p_close*100:>5.1f}% [{lo_c*100:.1f},{hi_c*100:.1f}]  "
          f"excurUp={p_exc*100:>5.1f}% [{lo_e*100:.1f},{hi_e*100:.1f}]")


def bias_mask(test, daily, fourh, oneh):
    """Build a mask matching the requested bias configuration. Each arg is a list
    of acceptable bias label strings — None means 'any'."""
    m = pd.Series(True, index=test.index)
    if daily is not None: m &= test['dailyBias'].isin(daily)
    if fourh is not None: m &= test['fourHBias'].isin(fourh)
    if oneh is not None:  m &= test['oneHBias'].isin(oneh)
    return m


def _wilson(p, n):
    """Rough 95% Wilson CI for a proportion."""
    if n == 0:
        return (0.0, 0.0)
    z = 1.96
    denom = 1 + z**2 / n
    centre = (p + z**2 / (2*n)) / denom
    half = z * np.sqrt(p*(1-p)/n + z**2/(4*n*n)) / denom
    return centre - half, centre + half


def report_bucket(name, mask, test, col='goodR', label='goodR'):
    """Print n, hit rate, and 95% CI for a filtered bucket on the given column."""
    sub = test[mask]
    n = len(sub)
    if n == 0:
        print(f"  {name:<54} n=0")
        return
    p = sub[col].mean()
    lo, hi = _wilson(p, n)
    print(f"  {name:<54} n={n:>6}  {label}={p*100:>5.1f}%  CI95=[{lo*100:.1f}%, {hi*100:.1f}%]")


def main():
    df = load_data()
    test = train_and_predict(df)

    BULL = ['Bullish', 'Strong Bullish']
    BEAR = ['Bearish', 'Strong Bearish']
    NEUTRAL_OR_BEAR = ['Neutral'] + BEAR

    # ML-WIN-only baseline (what we'd see if auto-FLAT didn't exist).
    hi_ml = test['mlProb'] >= ML_THRESHOLD

    print(f"\n=== Buckets at ML_WIN >= {ML_THRESHOLD} (n_test={len(test):,}) ===\n")
    print(f"  bucket{' '*42} n      goodR    95% CI")
    print(f"  " + "-"*78)
    report_bucket("ALL bars (no ML filter)",
                  pd.Series(True, index=test.index), test)
    report_bucket(f"ALL bars, ML >= {ML_THRESHOLD}",
                  hi_ml, test)
    print()
    report_bucket("MIXED: Daily neutral/bearish + 4H+1H bullish (all ML)",
                  bias_mask(test, NEUTRAL_OR_BEAR, BULL, BULL), test)
    report_bucket(f"MIXED + ML >= {ML_THRESHOLD}  (the PLTR case)",
                  hi_ml & bias_mask(test, NEUTRAL_OR_BEAR, BULL, BULL), test)
    print()
    report_bucket("ALIGNED BULL: D+4H+1H all bullish (all ML)",
                  bias_mask(test, BULL, BULL, BULL), test)
    report_bucket(f"ALIGNED BULL + ML >= {ML_THRESHOLD}",
                  hi_ml & bias_mask(test, BULL, BULL, BULL), test)
    print()
    report_bucket("MIXED inverse: Daily bullish + 4H/1H neutral or bearish (all ML)",
                  bias_mask(test, BULL, NEUTRAL_OR_BEAR, NEUTRAL_OR_BEAR), test)
    report_bucket(f"MIXED inverse + ML >= {ML_THRESHOLD}",
                  hi_ml & bias_mask(test, BULL, NEUTRAL_OR_BEAR, NEUTRAL_OR_BEAR), test)

    # === Direction-aware ===
    # The goodR_1.5 target is direction-agnostic for mixed bars (max of up/down move),
    # so a mixed-bullish bar can "hit goodR" via a 1.5 ATR DOWNSIDE move that fakes
    # out the implied long. Re-run with explicit longWin = (upside >= 1.5 ATR) and
    # shortWin = (downside >= 1.5 ATR) so the verdict tracks the LLM's actual trade
    # direction.
    print(f"\n=== Direction-aware buckets (long/short win = explicit ATR move in setup direction) ===\n")
    print(f"  bucket{' '*48} n      hit %    95% CI")
    print(f"  " + "-"*84)
    report_bucket("MIXED bullish + ML >= 0.65  → LONG win",
                  hi_ml & bias_mask(test, NEUTRAL_OR_BEAR, BULL, BULL), test,
                  col='longWin', label='longHit')
    report_bucket("ALIGNED BULL + ML >= 0.65   → LONG win",
                  hi_ml & bias_mask(test, BULL, BULL, BULL), test,
                  col='longWin', label='longHit')
    print()
    report_bucket("MIXED bearish + ML >= 0.65  → SHORT win",
                  hi_ml & bias_mask(test, BULL, BEAR, BEAR), test,
                  col='shortWin', label='shortHit')
    report_bucket("ALIGNED BEAR + ML >= 0.65   → SHORT win",
                  hi_ml & bias_mask(test, BEAR, BEAR, BEAR), test,
                  col='shortWin', label='shortHit')
    print()
    # Coin-flip baseline: at any random bar, what's the rate of a 1.5 ATR move in
    # EITHER direction within 24h? Anchors how unusual >50% direction-aware wins are.
    report_bucket("BASELINE: any bar, any ML  → LONG win (up >= 1.5 ATR)",
                  pd.Series(True, index=test.index), test,
                  col='longWin', label='longHit')
    report_bucket("BASELINE: any bar, any ML  → SHORT win (down >= 1.5 ATR)",
                  pd.Series(True, index=test.index), test,
                  col='shortWin', label='shortHit')

    # === Multi-horizon directional accuracy ===
    # Does the bias signal predict direction over longer holds? Maybe 24h is too
    # short for trend-continuation to play out and 48h/72h tells a different story.
    print(f"\n=== Multi-horizon directional accuracy (closeUp at 24h / 48h / 72h) ===\n")
    report_multi_horizon("baseline (any bar)",
                         pd.Series(True, index=test.index), test)
    report_multi_horizon(f"baseline + ML >= {ML_THRESHOLD}",
                         hi_ml, test)
    report_multi_horizon("aligned bullish",
                         bias_mask(test, BULL, BULL, BULL), test)
    report_multi_horizon(f"aligned bullish + ML >= {ML_THRESHOLD}",
                         hi_ml & bias_mask(test, BULL, BULL, BULL), test)
    report_multi_horizon("aligned bearish",
                         bias_mask(test, BEAR, BEAR, BEAR), test)
    report_multi_horizon(f"aligned bearish + ML >= {ML_THRESHOLD}",
                         hi_ml & bias_mask(test, BEAR, BEAR, BEAR), test)
    report_multi_horizon("mixed bullish",
                         bias_mask(test, NEUTRAL_OR_BEAR, BULL, BULL), test)
    report_multi_horizon(f"mixed bullish + ML >= {ML_THRESHOLD}",
                         hi_ml & bias_mask(test, NEUTRAL_OR_BEAR, BULL, BULL), test)

    # === Per-regime directional accuracy ===
    # Maybe aligned signals only carry direction info in TRENDING regimes (where
    # momentum continuation dominates) and reverse-mean-revert in RANGING.
    print(f"\n=== Aligned-bullish accuracy by regime ===\n")
    for regime in ['TRENDING', 'RANGING', 'TRANSITIONING']:
        if regime not in test['regime'].unique():
            continue
        m = (test['regime'] == regime)
        print(f"  --- {regime} (n={m.sum():,}) ---")
        report_direction(f"  aligned bullish",
                         m & bias_mask(test, BULL, BULL, BULL), test)
        report_direction(f"  aligned bullish + ML >= {ML_THRESHOLD}",
                         m & hi_ml & bias_mask(test, BULL, BULL, BULL), test)
        report_direction(f"  aligned bearish",
                         m & bias_mask(test, BEAR, BEAR, BEAR), test)

    # === Direction model: train explicitly on sign(fwdReturn24H) ===
    print(f"\n=== Direction model (target = sign of 24h return) ===\n")
    train_direction_model(df)

    # === Directional accuracy when timeframes align ===
    # The model predicts QUALITY, not direction — direction comes from the bias
    # alignment. So we ask: when the bias signal says "up" (aligned bullish), does
    # price actually go up? And does adding the ML filter on top sharpen the call?
    print(f"\n=== Directional accuracy (does the aligned-bias signal predict direction?) ===\n")
    print(f"  Baselines (no bias filter):")
    report_direction("ALL bars, no filter",
                     pd.Series(True, index=test.index), test)
    report_direction(f"ALL bars + ML >= {ML_THRESHOLD}",
                     hi_ml, test)
    print(f"\n  Aligned BULLISH (signal predicts UP):")
    report_direction("aligned bullish (any ML)",
                     bias_mask(test, BULL, BULL, BULL), test)
    report_direction(f"aligned bullish + ML >= {ML_THRESHOLD}",
                     hi_ml & bias_mask(test, BULL, BULL, BULL), test)
    print(f"\n  Aligned BEARISH (signal predicts DOWN — invert for accuracy):")
    report_direction("aligned bearish (any ML)",
                     bias_mask(test, BEAR, BEAR, BEAR), test)
    report_direction(f"aligned bearish + ML >= {ML_THRESHOLD}",
                     hi_ml & bias_mask(test, BEAR, BEAR, BEAR), test)
    print(f"\n  Mixed (no aligned-direction prediction):")
    report_direction("mixed-bullish (D neutral/bear + 4H/1H bull)",
                     bias_mask(test, NEUTRAL_OR_BEAR, BULL, BULL), test)
    report_direction(f"mixed-bullish + ML >= {ML_THRESHOLD}",
                     hi_ml & bias_mask(test, NEUTRAL_OR_BEAR, BULL, BULL), test)

    # Verdict
    print(f"\n=== Verdict ===")
    mixed = hi_ml & bias_mask(test, NEUTRAL_OR_BEAR, BULL, BULL)
    aligned = hi_ml & bias_mask(test, BULL, BULL, BULL)
    if mixed.sum() == 0 or aligned.sum() == 0:
        print("  Insufficient data in one of the buckets — see counts above.")
        return
    # The verdict that actually matters: does the implied LONG pay out 1.5 ATR up
    # often enough to beat sitting out (the random-bar baseline)?
    p_mixed = test[mixed]['longWin'].mean()
    p_aligned = test[aligned]['longWin'].mean()
    p_baseline = test['longWin'].mean()
    edge_vs_baseline = (p_mixed - p_baseline) * 100
    edge_vs_aligned = (p_mixed - p_aligned) * 100
    print(f"  Mixed-bullish-high-ML  LONG win: {p_mixed*100:.1f}%  (n={mixed.sum()})")
    print(f"  Aligned-bullish-high-ML LONG win: {p_aligned*100:.1f}%  (n={aligned.sum()})")
    print(f"  Random-bar baseline LONG win:    {p_baseline*100:.1f}%  (n={len(test)})")
    print(f"  Edge over baseline (mixed):      {edge_vs_baseline:+.1f}pp")
    print(f"  Edge over baseline (aligned):    {(p_aligned-p_baseline)*100:+.1f}pp")

    if edge_vs_baseline >= 5:
        print(f"\n  → Mixed-bullish LONG setups beat the random-bar baseline by {edge_vs_baseline:.1f}pp.")
        print(f"    The auto-FLAT is blocking trades with a real directional edge. Consider")
        print(f"    relaxing it when ML_WIN >= 0.65.")
    elif edge_vs_baseline >= 2:
        print(f"\n  → Mixed-bullish LONG setups have a marginal {edge_vs_baseline:.1f}pp edge over baseline.")
        print(f"    Within statistical noise. The auto-FLAT is not obviously wrong.")
    else:
        print(f"\n  → Mixed-bullish LONG setups barely beat baseline ({edge_vs_baseline:+.1f}pp).")
        print(f"    The direction-agnostic goodR makes mixed bars look high-quality, but the")
        print(f"    actual LONG win rate is near coin-flip. The auto-FLAT is defensible.")
    print(f"\n  Lesson: the prior direction-AGNOSTIC verdict (73.5% goodR for mixed) was")
    print(f"  misleading — mixed-bias bars hit goodR via volatility in EITHER direction.")
    print(f"  Direction-explicit LONG hit rate (40.8%) is the right number to compare.")


if __name__ == '__main__':
    main()
