#!/usr/bin/env python3
"""
Train a STOCK DIRECTION model.

Same recipe as calibrate_v13_stocks.py (the production quality model), but with
target = sign(fwdReturn24H > 0) instead of goodR_1.5. This asks the model the
question the production ML refuses to ask: "does price close higher 24h later?"

Pipeline (mirrors production for apples-to-apples comparison):
  - Daily-downsample to one bar per (symbol, date)
  - 3-fold walk-forward CV, purge 48 bars
  - Time-decay sample weighting (last year 3x, last 2 years 2x)
  - Out-of-fold predictions captured for honest calibration fit
  - Isotonic regression to map raw → calibrated probability
  - Reliability buckets show predicted vs actual

Output:
  - Calibrated reliability table
  - Confidence-conditional accuracy (how much of the bar population is
    actually classifiable, vs the unclassifiable rest)
  - A decision: ship-ready or not?

Run:  python3 calibrate_direction_stocks.py
Source CSVs: ml-training/csv_exports_v13/ (same as production v13 training set).
"""
import glob
import os
import sys

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression

CSV_DIR = os.path.join(os.path.dirname(__file__), 'csv_exports_v13')
CAP = 0.75  # cap on calibrated probability — lower than ML_WIN's 0.85 because
            # direction is harder to predict; clip overconfident leaves.

# Feature list verbatim from calibrate_v13_stocks.py.
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
    print(f"Loading {len(files)} stock CSVs from {CSV_DIR}...")
    parts = []
    for f in files:
        df = pd.read_csv(f)
        if 'fwdReturn24H' not in df.columns:
            continue
        df = df[df['fwdReturn24H'].notna()].copy()
        # Fill crypto-only features with zeros (same as production training).
        for col in ('basisPct', 'basisExtreme'):
            if col not in df.columns:
                df[col] = 0.0
        parts.append(df)
    df = pd.concat(parts, ignore_index=True)
    # Daily downsample — last 4H bar per (symbol, date) — matches production
    # recipe to avoid 6x duplicate-ish bars per symbol per day.
    df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
    df = df.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)
    df['y'] = (df['fwdReturn24H'] > 0).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)
    base = df['y'].mean()
    print(f"  bars after downsample: {len(df):,}  | symbols: {df['symbol'].nunique()}  | "
          f"P(up) baseline: {base*100:.1f}%")
    return df


USE_RECENCY_WEIGHTS = False  # production quality model uses True; for direction
                              # the recency bias makes the model lean UP because the
                              # most recent year is always closest to "current regime"
                              # which (in this corpus) is bull. See verdict for findings.


def compute_sample_weights(timestamps):
    """Production quality model weights last-year 3x and year-2 2x. For direction
    prediction this biases the model UP, because the recent year is bull-dominated.
    Uniform weighting lets bear-period bars influence training equally."""
    if not USE_RECENCY_WEIGHTS:
        return np.ones(len(timestamps))
    now = timestamps.max()
    one_year = now - 365 * 86400
    two_years = now - 2 * 365 * 86400
    w = np.ones(len(timestamps))
    w[timestamps >= two_years] = 2.0
    w[timestamps >= one_year] = 3.0
    return w


def make_model():
    return xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def walk_forward_oof(data, n_folds=5, purge=48):
    """Walk-forward CV starting from the 25% chronological point so the earliest
    OOF fold lands on ~mid-2022. Returns OOF predictions, OOF y, fold-index per
    sample (so we can slice reliability by regime), fold metadata, and a final
    model trained on ALL data for export."""
    n = len(data)
    oof_p, oof_y, oof_fold = [], [], []
    fold_meta = []  # list of (fold_idx, start_date, end_date, n_val, val_p_up)
    print(f"  Walk-forward expansion: {n_folds} folds, val window ≈ 15% of corpus each.\n")
    for i in range(n_folds):
        train_end = int(n * (0.25 + i * 0.15))
        val_start = train_end + purge
        val_end = int(n * (0.40 + i * 0.15)) if i < n_folds - 1 else n
        if val_start >= val_end:
            continue
        train = data.iloc[:train_end]
        val = data.iloc[val_start:val_end]
        X_t, y_t = train[FEATURES].fillna(0), train['y']
        X_v, y_v = val[FEATURES].fillna(0), val['y']
        w_t = compute_sample_weights(train['timestamp'].values)
        m = make_model()
        m.fit(X_t, y_t, sample_weight=w_t)
        p = m.predict_proba(X_v)[:, 1]
        acc = ((p >= 0.5).astype(int) == y_v.values).mean()
        val_actual_up = y_v.mean()
        val_start_dt = pd.to_datetime(val['timestamp'].iloc[0], unit='s').date()
        val_end_dt = pd.to_datetime(val['timestamp'].iloc[-1], unit='s').date()
        print(f"    fold {i+1}: train={len(train):>6,}  val={len(val):>6,}  "
              f"({val_start_dt} → {val_end_dt})")
        print(f"             val P(up)={val_actual_up*100:>4.1f}%  acc={acc*100:.1f}%  "
              f"p_mean={p.mean():.3f}  p_min={p.min():.3f}  p_max={p.max():.3f}")
        oof_p.append(p)
        oof_y.append(y_v.values)
        oof_fold.append(np.full(len(p), i + 1))
        fold_meta.append((i + 1, val_start_dt, val_end_dt, len(p), val_actual_up))
    # Final model trained on ALL data — what would ship to production.
    X_all, y_all = data[FEATURES].fillna(0), data['y']
    w_all = compute_sample_weights(data['timestamp'].values)
    final_model = make_model()
    final_model.fit(X_all, y_all, sample_weight=w_all)
    return (np.concatenate(oof_p), np.concatenate(oof_y),
            np.concatenate(oof_fold), fold_meta, final_model)


def report_feature_importance(model, top_n=15):
    """Top-N features by importance gain. If high-conviction predictions are
    driven by features the LLM doesn't already consume (volume profile, cross-asset,
    derivatives interactions), the direction model adds real signal. If they're
    dominated by EMA stack / structure flags, it's redundant with bias alignment."""
    importances = list(zip(FEATURES, model.feature_importances_))
    importances.sort(key=lambda x: x[1], reverse=True)
    print(f"\n  Top-{top_n} features by importance (gain):")
    for name, score in importances[:top_n]:
        bar = '█' * int(score * 200)
        print(f"    {name:<28} {score:.4f}  {bar}")


def report_per_fold_reliability(raw, y, fold, fold_meta, iso, thresholds=(0.60, 0.65, 0.70)):
    """High-confidence accuracy per fold. If the +12pp lift at prob>=0.60 is
    bull-only, slicing fold 1 (2022 bear) should show it collapsing. If it
    holds in fold 1 too, the signal is regime-robust."""
    mapped = np.minimum(iso.predict(raw), CAP)
    print(f"\n  Per-fold high-confidence accuracy (does the tail edge hold in bear?):")
    print(f"  fold  period                     val_P(up)   prob >= 0.60       prob >= 0.65       prob >= 0.70")
    print(f"  " + "-"*108)
    for fi, start_dt, end_dt, n_val, p_up in fold_meta:
        m_fold = (fold == fi)
        sub_mapped = mapped[m_fold]
        sub_y = y[m_fold]
        parts = []
        for t in thresholds:
            sel = sub_mapped >= t
            n = int(sel.sum())
            if n == 0:
                parts.append(f"{'n=0':>17}")
            else:
                hit = sub_y[sel].mean() * 100
                parts.append(f"n={n:>4}  {hit:>4.1f}%")
        period = f"{start_dt} → {end_dt}"
        print(f"  {fi}     {period:<28} {p_up*100:>5.1f}%     " + "    ".join(parts))


def fit_calibration(probs, y_true):
    """Isotonic step function from raw → empirical UP rate, capped at CAP."""
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(probs, y_true)
    x = iso.X_thresholds_
    y = iso.y_thresholds_
    y = np.minimum(y, CAP)
    return x.tolist(), y.tolist(), iso


def reliability_table(raw, y_true, iso):
    """Show predicted-vs-actual per probability bucket. The critical sanity
    check before shipping: does prob=0.6 actually mean ~60% UP rate?"""
    mapped = np.minimum(iso.predict(raw), CAP)
    print(f"\n  Raw OOF distribution:    mean={raw.mean():.3f}  p90={np.percentile(raw, 90):.3f}  max={raw.max():.3f}")
    print(f"  Mapped (calibrated):     mean={mapped.mean():.3f}  p90={np.percentile(mapped, 90):.3f}  max={mapped.max():.3f}")
    print(f"  Population baseline P(up): {y_true.mean()*100:.1f}%")
    print(f"\n  Reliability check (calibrated prob bucket → actual UP rate):")
    print(f"  {'bucket':<14}  {'n':>7}  {'actual %':>9}  {'(target %)':<12}")
    print(f"  " + "-"*48)
    for lo, hi in [(0.0, 0.30), (0.30, 0.40), (0.40, 0.45), (0.45, 0.50),
                   (0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 0.75)]:
        m = (mapped >= lo) & (mapped < hi)
        n = int(m.sum())
        if n == 0:
            print(f"  [{lo:.2f}, {hi:.2f})  {'-':>7}  {'-':>9}  ({(lo+hi)/2*100:.0f}%)")
            continue
        actual = y_true[m].mean() * 100
        mid_pct = (lo + hi) / 2 * 100
        print(f"  [{lo:.2f}, {hi:.2f})  {n:>7,}  {actual:>8.1f}%  ({mid_pct:.0f}%)")
    return mapped


def main():
    df = load_data()
    print(f"\nWalk-forward CV:")
    raw_oof, y_oof, fold_oof, fold_meta, final_model = walk_forward_oof(df)
    print(f"  total OOF samples: {len(raw_oof):,}")

    overall_acc = ((raw_oof >= 0.5).astype(int) == y_oof).mean()
    baseline_acc = max(y_oof.mean(), 1 - y_oof.mean())
    print(f"\n  raw OOF accuracy:               {overall_acc*100:.1f}%")
    print(f"  always-predict-majority baseline: {baseline_acc*100:.1f}%")
    print(f"  edge over majority baseline:    {(overall_acc - baseline_acc)*100:+.1f}pp")

    x_cal, y_cal, iso = fit_calibration(raw_oof, y_oof)
    print(f"\n  Calibration breakpoints (first 10):")
    for xi, yi in list(zip(x_cal, y_cal))[:10]:
        print(f"    raw={xi:.4f}  →  calibrated={yi:.4f}")
    print(f"  (total breakpoints: {len(x_cal)})")

    mapped = reliability_table(raw_oof, y_oof, iso)

    # Per-fold reliability — does the tail edge hold in the 2022 bear, or only
    # in bull folds? Critical for deciding whether to ship this model broadly.
    report_per_fold_reliability(raw_oof, y_oof, fold_oof, fold_meta, iso)

    # Feature importance — what drives the model's high-conviction calls?
    report_feature_importance(final_model)

    # Confidence-conditional: how many bars cross each calibrated threshold
    # and what's the actual UP rate among those.
    print(f"\n  Confidence-conditional usefulness:")
    print(f"  threshold   covered   actual UP   lift vs baseline")
    for t in [0.55, 0.58, 0.60, 0.62, 0.65, 0.70]:
        m = (mapped >= t)
        n = int(m.sum())
        if n < 100:
            print(f"  >= {t:.2f}    n={n:<7,}  (sample too small)")
            continue
        actual = y_oof[m].mean() * 100
        coverage = n / len(mapped) * 100
        lift = actual - baseline_acc * 100
        print(f"  >= {t:.2f}    n={n:<6,} ({coverage:>4.1f}%)   {actual:>5.1f}%        {lift:+.1f}pp")

    # Verdict
    print(f"\n=== Verdict ===")
    # The threshold that matters: how often we can give the LLM a high-confidence
    # directional call and have it be right.
    t60_mask = (mapped >= 0.60)
    t60_n = int(t60_mask.sum())
    t60_actual = y_oof[t60_mask].mean() * 100 if t60_n > 0 else 0
    t60_coverage = t60_n / len(mapped) * 100
    if t60_n > 100 and t60_actual >= 58:
        print(f"  Model exposes a ship-worthy edge.")
        print(f"  At calibrated prob >= 0.60, the model covers {t60_coverage:.1f}% of bars")
        print(f"  ({t60_n:,} of {len(mapped):,}) and predicts UP correctly {t60_actual:.1f}% of the time")
        print(f"  vs {baseline_acc*100:.1f}% majority baseline (+{t60_actual-baseline_acc*100:.1f}pp).")
        print(f"\n  Recommend: ship as ML_DIRECTION alongside ML_WIN. Surface in the")
        print(f"  prompt as 'directional model favors UP/DOWN' when prob >= 0.60, and")
        print(f"  'directional signal unclear' otherwise. The LLM gets a real edge in")
        print(f"  the {t60_coverage:.0f}% of bars where the model is confident, and falls")
        print(f"  back to structural reasoning on the rest.")
    elif t60_n > 100:
        print(f"  Model has an edge but it's marginal — at prob >= 0.60 the actual")
        print(f"  UP rate is {t60_actual:.1f}% vs {baseline_acc*100:.1f}% baseline.")
        print(f"  Coverage is {t60_coverage:.1f}%. Worth shipping only if the LLM's")
        print(f"  current direction heuristic is materially worse.")
    else:
        print(f"  Model fails to identify enough high-confidence bars to be useful.")
        print(f"  Direction in stocks at the 24h horizon may not be reliably extractable")
        print(f"  from these features. Worth re-trying with different features or")
        print(f"  longer horizons before shipping.")


if __name__ == '__main__':
    main()
