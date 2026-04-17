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
]
assert len(FEATURES) == 107, f"expected 107 features, got {len(FEATURES)}"

DOWNLOADS = '/Volumes/External/Downloads'
REPO = '/Users/bojanmihovilovic/CryptoLens'
WORKER = f'{REPO}/marketscope-worker/src'
IOS_ML = f'{REPO}/CryptoLens/ML'
ML_TRAINING = f'{REPO}/ml-training'

CRYPTO_SYMBOLS = [
    # Pre-2021
    'BTC', 'ETH', 'BCH', 'XRP', 'LTC', 'TRX', 'ETC', 'LINK', 'XLM', 'ADA',
    'XMR', 'DASH', 'ZEC', 'XTZ', 'BNB', 'ATOM', 'ONT', 'IOTA', 'BAT', 'VET',
    'NEO', 'QTUM', 'IOST', 'THETA', 'ALGO', 'ZIL', 'KNC', 'ZRX', 'COMP', 'DOGE',
    'KAVA', 'BAND', 'RLC', 'SNX', 'DOT', 'YFI', 'CRV', 'TRB', 'RUNE', 'SUSHI',
    'EGLD', 'SOL', 'ICX', 'STORJ', 'UNI', 'AVAX', 'ENJ', 'KSM', 'NEAR', 'AAVE',
    'FIL', 'RSR', 'BEL', 'AXS', 'SKL', 'GRT',
    # Post-2021
    'SAND', 'MANA', 'HBAR', 'MATIC', 'ICP', 'DYDX', 'GALA',
    'IMX', 'GMT', 'APE', 'INJ', 'LDO', 'APT',
    'ARB', 'SUI', 'PENDLE', 'SEI', 'TIA', 'JUP', 'PEPE',
]
STOCK_SYMBOLS = [
    # Mega-cap tech
    'AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN',
    'CRM', 'NFLX', 'AMD', 'ORCL', 'ADBE', 'INTC', 'CSCO',
    # Semiconductors
    'AVGO', 'QCOM', 'MU', 'AMAT', 'LRCX', 'MRVL',
    # High-beta growth
    'PLTR', 'ROKU', 'SHOP', 'SQ', 'SNAP', 'COIN', 'RBLX',
    # High short-interest / meme
    'BYND', 'GME',
    # Financials
    'JPM', 'GS', 'MS', 'BAC', 'WFC', 'BLK', 'SCHW',
    # Healthcare / pharma
    'UNH', 'LLY', 'ABBV', 'JNJ', 'PFE', 'MRK', 'TMO',
    # Biotech
    'REGN', 'VRTX', 'GILD', 'BIIB',
    # Consumer
    'HD', 'MA', 'V', 'DIS', 'NKE', 'SBUX', 'MCD', 'WMT', 'COST',
    # Cyclicals
    'CAT', 'DE', 'X', 'BA',
    # Energy
    'XOM', 'OXY', 'FANG', 'CVX', 'SLB',
    # Defense / aerospace
    'LMT', 'RTX', 'GD',
    # Transport
    'UNP', 'FDX', 'DAL',
    # Telecom / media
    'T', 'VZ', 'CMCSA',
    # REITs
    'SPG', 'O',
    # ETFs
    'SPY', 'QQQ', 'IWM', 'XLE', 'XLF', 'XLK', 'XLV', 'GLD', 'TLT',
]

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
            # Default values for features missing from older CSV exports
            if feat == 'takerRatioRaw':
                default = 1.0
            elif feat == 'longPctRaw':
                default = 50.0
            elif feat in ('daysToEarnings', 'daysSinceEarnings'):
                default = 60.0  # "no earnings within 60 days" is the safe neutral
            else:
                default = 0.0
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
    """Return (oof_probs, y_true, final_model) — OOF predictions for calibration fit,
    plus a final model trained on ALL data for export to production."""
    n = len(data)
    oof_probs, oof_y = [], []
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
    # Train final model on ALL data for production export
    X_all, y_all = data[FEATURES].fillna(0), data['goodR']
    w_all = compute_sample_weights(data['timestamp'].values)
    final_model = make_model()
    final_model.fit(X_all, y_all, sample_weight=w_all, verbose=0)
    return np.concatenate(oof_probs), np.concatenate(oof_y), final_model


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


def export_worker_model(market, model, n_samples, x_cal, y_cal):
    """Export XGBoost trees + calibration block to worker JSON."""
    booster = model.get_booster()
    trees = [json.loads(t) for t in booster.get_dump(dump_format='json')]
    path = f'{WORKER}/ml-model-{market}.json'
    try:
        with open(path) as f:
            existing = json.load(f)
        base_score = existing.get('base_score', 0.5)
    except Exception:
        base_score = 0.5
    m = {
        'features': FEATURES,
        'trees': trees,
        'base_score': base_score,
        'version': 9,
        'market': market,
        'n_features': len(FEATURES),
        'n_trees': len(trees),
        'n_samples': n_samples,
        'model_type': 'classifier',
        'target': 'goodR',
        'calibration': {'x': x_cal, 'y': y_cal, 'cap': CAP, 'method': 'isotonic'},
        'description': f'v9 {market} — goodR = fwdMaxFavR>=1.5, {n_samples} bars',
    }
    with open(path, 'w') as f:
        json.dump(m, f)
    print(f"  wrote {path} ({len(trees)} trees, {len(x_cal)} cal breakpoints)")


def export_ios_model(market, model, x_cal, y_cal):
    """Export CoreML .mlmodel for iOS bundle + sidecar calibration JSON."""
    cal_path = f'{IOS_ML}/{market}_calibration.json'
    with open(cal_path, 'w') as f:
        json.dump({'x': x_cal, 'y': y_cal, 'cap': CAP}, f)
    print(f"  wrote {cal_path}")
    try:
        import coremltools as ct
        import shutil
        coreml = ct.converters.xgboost.convert(model, feature_names=FEATURES, mode='classifier')
        coreml.short_description = f'MarketScope v9 {market} goodR'
        training_path = f'{ML_TRAINING}/MarketScoreML_{market}.mlmodel'
        coreml.save(training_path)
        ios_path = f'{IOS_ML}/MarketScoreML_{market}.mlmodel'
        shutil.copy2(training_path, ios_path)
        print(f"  wrote {ios_path}")
    except Exception as e:
        print(f"  CoreML export FAILED: {e}")


def calibrate_market(symbols, is_crypto, label, market_key):
    data = load_market(symbols, is_crypto, label)
    if data is None:
        print(f"!! no data for {label}")
        return
    print(f"\n  walk-forward CV (capturing out-of-fold predictions):")
    probs, y, final_model = walk_forward_oof(data)
    print(f"  total OOF samples: {len(probs)}")
    x_cal, y_cal = fit_calibration(probs, y)
    diagnose(label, probs, y, x_cal, y_cal)
    export_worker_model(market_key, final_model, len(data), x_cal, y_cal)
    export_ios_model(market_key, final_model, x_cal, y_cal)


if __name__ == '__main__':
    print("=" * 60)
    print("v9 ISOTONIC CALIBRATION — refit on out-of-fold predictions")
    print("=" * 60)

    print("\n\n##### CRYPTO #####")
    calibrate_market(CRYPTO_SYMBOLS, True, "Crypto (10 symbols)", "crypto")

    print("\n\n##### STOCKS #####")
    calibrate_market(STOCK_SYMBOLS, False, "Stocks (82 symbols)", "stock")

    print("\n" + "=" * 60)
    print("DONE")
    print("=" * 60)
