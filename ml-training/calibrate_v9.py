"""
v9 isotonic calibration — fits on out-of-fold predictions from walk-forward CV.

Outputs:
  - Embeds 'calibration' block into marketscope-worker/src/ml-model-{crypto,stock}.json
  - Writes CryptoLens/ML/{crypto,stock}_calibration.json (iOS bundle)
  - Caps calibrated probability at 0.85 by clipping isotonic y values.

Hyperparams match v9 (commit c0dcd18): depth=3, 100 trees, lr=0.03, strong reg.
"""

import json
import os
import shutil
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression

# ---------------------------------------------------------------
# Feature list — must match worker scoring-full.ts + Swift MLFeatures (105)
# ---------------------------------------------------------------
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
    'atrPercent', 'atrPercentile', 'dailyScore', 'fourHScore',
    'tfAlignment', 'momentumAlignment', 'structureAlignment', 'scoreSum', 'scoreDivergence',
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
]
assert len(FEATURES) == 105, f"expected 105 features, got {len(FEATURES)}"

DOWNLOADS = '/Users/bojanmihovilovic/Downloads'
REPO = '/Users/bojanmihovilovic/CryptoLens'
WORKER = f'{REPO}/marketscope-worker/src'
IOS_ML = f'{REPO}/CryptoLens/ML'

CRYPTO_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA',
                  'LINK', 'AVAX', 'DOT', 'NEAR']
STOCK_SYMBOLS = ['AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN',
                 'JPM', 'UNH', 'HD', 'MA', 'ABBV', 'V', 'AMD', 'NFLX',
                 'BA', 'XOM', 'CRM', 'LLY', 'DIS']

CAP = 0.85  # ceiling on calibrated probability


def load_symbol(symbol, is_crypto):
    suffix = 'USDT' if is_crypto else ''
    path = f'{DOWNLOADS}/{symbol}{suffix}.csv'
    if not os.path.isfile(path):
        print(f"  MISSING: {path}")
        return None
    df = pd.read_csv(path)
    if 'symbol' not in df.columns:
        df['symbol'] = symbol
    if 'fwdMaxFavR' not in df.columns:
        print(f"  WARNING: {symbol} missing fwdMaxFavR")
        return None
    valid = df[df['fwdMaxFavR'].notna() & df['fwdReturn24H'].notna()].copy()
    valid['goodR'] = (valid['fwdMaxFavR'] >= 1.5).astype(int)
    for feat in FEATURES:
        if feat not in valid.columns:
            default = 1.0 if feat == 'takerRatioRaw' else 50.0 if feat == 'longPctRaw' else 0.0
            valid[feat] = default
    return valid


def downsample_daily(df):
    df = df.copy()
    df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
    return df.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)


def load_market(symbols, is_crypto, label):
    print(f"\n--- Loading {label} ---")
    parts = []
    for s in symbols:
        d = load_symbol(s, is_crypto)
        if d is None:
            continue
        d = downsample_daily(d)
        parts.append(d)
        print(f"  {s}: {len(d)} bars, goodR={d['goodR'].mean()*100:.1f}%")
    if not parts:
        return None
    out = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    print(f"  total: {len(out)} bars, goodR={out['goodR'].mean()*100:.1f}%")
    return out


def compute_sample_weights(timestamps):
    now = timestamps.max()
    one_year = now - 365 * 86400
    two_years = now - 2 * 365 * 86400
    w = np.ones(len(timestamps))
    w[timestamps >= two_years] = 2.0
    w[timestamps >= one_year] = 3.0
    return w


def make_model():
    # v9 hyperparams from c0dcd18: depth=3, 100 trees, lr=0.03, strong reg
    return xgb.XGBClassifier(
        max_depth=3, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def walk_forward_oof(data, n_folds=3, purge=48):
    """Return (oof_probs, y_true) — out-of-fold predictions across folds."""
    n = len(data)
    oof_probs = []
    oof_y = []
    for i in range(n_folds):
        train_end = int(n * (0.4 + i * 0.15))
        val_start = train_end + purge
        val_end = int(n * (0.55 + i * 0.15)) if i < n_folds - 1 else n
        if val_start >= val_end:
            continue
        train = data.iloc[:train_end]
        val = data.iloc[val_start:val_end]
        X_t, y_t = train[FEATURES].fillna(0), train['goodR']
        X_v, y_v = val[FEATURES].fillna(0), val['goodR']
        w_t = compute_sample_weights(train['timestamp'].values)
        m = make_model()
        m.fit(X_t, y_t, sample_weight=w_t, verbose=0)
        p = m.predict_proba(X_v)[:, 1]
        acc = ((p >= 0.5).astype(int) == y_v.values).mean()
        print(f"    fold {i+1}: train={len(train)}, val={len(val)}, acc={acc*100:.1f}%, "
              f"p_mean={p.mean():.3f}, p_max={p.max():.3f}")
        oof_probs.append(p)
        oof_y.append(y_v.values)
    return np.concatenate(oof_probs), np.concatenate(oof_y)


def fit_calibration(probs, y_true):
    """Fit isotonic regression mapping raw probability -> empirical win rate.
    Returns (x_breakpoints, y_breakpoints) — the step function from sklearn's IsotonicRegression."""
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(probs, y_true)
    # Extract the unique step points
    x = iso.X_thresholds_
    y = iso.y_thresholds_
    # Cap output at CAP
    y = np.minimum(y, CAP)
    return x.tolist(), y.tolist()


def diagnose(name, raw, y_true, x, y):
    """Show how raw probabilities get mapped, and the mapped distribution."""
    print(f"\n  {name} calibration breakpoints (raw -> calibrated):")
    for xi, yi in zip(x, y):
        print(f"    {xi:.4f} -> {yi:.4f}")

    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(raw, y_true)
    mapped = np.minimum(iso.predict(raw), CAP)

    print(f"\n  {name} raw distribution:    mean={raw.mean():.3f} median={np.median(raw):.3f} "
          f"p90={np.percentile(raw, 90):.3f} max={raw.max():.3f}")
    print(f"  {name} mapped distribution: mean={mapped.mean():.3f} median={np.median(mapped):.3f} "
          f"p90={np.percentile(mapped, 90):.3f} max={mapped.max():.3f}")
    print(f"  {name} actual goodR rate:   {y_true.mean()*100:.1f}%")

    # Reliability buckets
    print(f"  reliability check (mapped prob bucket -> actual win rate):")
    for lo, hi in [(0.0, 0.3), (0.3, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.85)]:
        m = (mapped >= lo) & (mapped < hi)
        if m.sum() > 0:
            print(f"    [{lo:.2f}, {hi:.2f}): n={m.sum():5d}, actual={y_true[m].mean()*100:.1f}%")


def update_worker_model(market, x, y):
    path = f'{WORKER}/ml-model-{market}.json'
    with open(path) as f:
        m = json.load(f)
    m['calibration'] = {'x': x, 'y': y, 'cap': CAP, 'method': 'isotonic'}
    with open(path, 'w') as f:
        json.dump(m, f)
    print(f"  wrote calibration into {path} ({len(x)} breakpoints)")


def write_ios_calibration(market, x, y):
    path = f'{IOS_ML}/{market}_calibration.json'
    with open(path, 'w') as f:
        json.dump({'x': x, 'y': y, 'cap': CAP}, f)
    print(f"  wrote {path}")


def calibrate_market(symbols, is_crypto, label, market_key):
    data = load_market(symbols, is_crypto, label)
    if data is None:
        print(f"!! no data for {label}")
        return
    print(f"\n  walk-forward CV (capturing out-of-fold predictions):")
    probs, y = walk_forward_oof(data)
    print(f"  total OOF samples: {len(probs)}")
    x_cal, y_cal = fit_calibration(probs, y)
    diagnose(label, probs, y, x_cal, y_cal)
    update_worker_model(market_key, x_cal, y_cal)
    write_ios_calibration(market_key, x_cal, y_cal)


if __name__ == '__main__':
    print("=" * 60)
    print("v9 ISOTONIC CALIBRATION — refit on out-of-fold predictions")
    print("=" * 60)

    print("\n\n##### CRYPTO #####")
    calibrate_market(CRYPTO_SYMBOLS, True, "Crypto (10 symbols)", "crypto")

    print("\n\n##### STOCKS #####")
    calibrate_market(STOCK_SYMBOLS, False, "Stocks (20 symbols)", "stock")

    print("\n" + "=" * 60)
    print("DONE")
    print("=" * 60)
