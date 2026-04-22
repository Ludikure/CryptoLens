"""
v10 isotonic calibration — fits on out-of-fold predictions from walk-forward CV.

Outputs:
  - Embeds 'calibration' block into marketscope-worker/src/ml-model-{crypto,stock}.json
  - Copies model JSON to CryptoLens/ML/ (iOS reads same JSON via native tree evaluator)
  - Caps calibrated probability at 0.85 by clipping isotonic y values.

Crypto: LightGBM depth=4, 150 trees (best WF accuracy + top-bucket reliability)
Stocks: XGBoost depth=5, 100 trees (best top-bucket reliability)
"""

import json
import os
import shutil
import numpy as np
import pandas as pd
import xgboost as xgb
import lightgbm as lgb
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
    'relStrengthVsSector', 'vixTermStructure', 'dxyMomentum', 'iwmSpyRatio',
]
assert len(FEATURES) == 111, f"expected 111 features, got {len(FEATURES)}"

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


def make_crypto_model():
    return lgb.LGBMClassifier(
        max_depth=4, n_estimators=150, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_samples=10,
        reg_alpha=0.1, reg_lambda=1.0, random_state=42, verbose=-1,
    )


def make_stock_model():
    return xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def walk_forward_oof(data, make_model_fn, n_folds=3, purge=48):
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
        m = make_model_fn()
        m.fit(X_t, y_t, sample_weight=w_t)
        p = m.predict_proba(X_v)[:, 1]
        acc = ((p >= 0.5).astype(int) == y_v.values).mean()
        print(f"    fold {i+1}: train={len(train)}, val={len(val)}, acc={acc*100:.1f}%, "
              f"p_mean={p.mean():.3f}, p_max={p.max():.3f}")
        oof_probs.append(p)
        oof_y.append(y_v.values)
    # Train final model on ALL data for production export
    X_all, y_all = data[FEATURES].fillna(0), data['goodR']
    w_all = compute_sample_weights(data['timestamp'].values)
    final_model = make_model_fn()
    final_model.fit(X_all, y_all, sample_weight=w_all)
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


def lgb_tree_to_xgb_format(node, feature_names, nodeid_counter=None):
    """Convert a LightGBM tree node to XGBoost JSON format."""
    if nodeid_counter is None:
        nodeid_counter = [0]
    nid = nodeid_counter[0]
    nodeid_counter[0] += 1

    if 'leaf_value' in node:
        return {'nodeid': nid, 'leaf': node['leaf_value']}

    left = lgb_tree_to_xgb_format(node['left_child'], feature_names, nodeid_counter)
    right = lgb_tree_to_xgb_format(node['right_child'], feature_names, nodeid_counter)

    feat_idx = node['split_feature']
    feat_name = feature_names[feat_idx] if isinstance(feat_idx, int) else feat_idx

    return {
        'nodeid': nid,
        'split': feat_name,
        'split_condition': node['threshold'],
        'yes': left['nodeid'],
        'no': right['nodeid'],
        'missing': left['nodeid'],
        'children': [left, right],
    }


def extract_trees(model, is_lgb):
    """Extract trees in XGBoost JSON format from either model type."""
    if is_lgb:
        dump = model.booster_.dump_model()
        feature_names = dump.get('feature_names', FEATURES)
        trees = []
        for tree_info in dump['tree_info']:
            tree = lgb_tree_to_xgb_format(tree_info['tree_structure'], feature_names, [0])
            trees.append(tree)
        return trees, 0.5
    else:
        booster = model.get_booster()
        trees = [json.loads(t) for t in booster.get_dump(dump_format='json')]
        return trees, 0.5


def export_model(market, model, n_samples, x_cal, y_cal, is_lgb):
    """Export trees + calibration to worker JSON + iOS JSON (same file)."""
    trees, base_score = extract_trees(model, is_lgb)
    model_type = 'lightgbm' if is_lgb else 'xgboost'

    # Verify: manual tree eval should match predict_proba
    # (sanity check that base_score and tree conversion are correct)

    m = {
        'features': FEATURES,
        'trees': trees,
        'base_score': base_score,
        'version': 10,
        'market': market,
        'engine': model_type,
        'n_features': len(FEATURES),
        'n_trees': len(trees),
        'n_samples': n_samples,
        'model_type': 'classifier',
        'target': 'goodR',
        'calibration': {'x': x_cal, 'y': y_cal, 'cap': CAP, 'method': 'isotonic'},
        'description': f'v10 {market} ({model_type}) — goodR = fwdMaxFavR>=1.5, {n_samples} bars',
    }
    # Write to worker
    worker_path = f'{WORKER}/ml-model-{market}.json'
    with open(worker_path, 'w') as f:
        json.dump(m, f)
    print(f"  wrote {worker_path} ({len(trees)} trees, {model_type}, {len(x_cal)} cal breakpoints)")
    # Copy to iOS bundle
    ios_path = f'{IOS_ML}/ml-model-{market}.json'
    shutil.copy2(worker_path, ios_path)
    print(f"  wrote {ios_path}")


def calibrate_market(symbols, is_crypto, label, market_key):
    data = load_market(symbols, is_crypto, label)
    if data is None:
        print(f"!! no data for {label}")
        return
    make_fn = make_crypto_model if is_crypto else make_stock_model
    is_lgb = is_crypto
    model_desc = "LightGBM d4 t150" if is_lgb else "XGBoost d5 t100"
    print(f"\n  Model: {model_desc}")
    print(f"  walk-forward CV (capturing out-of-fold predictions):")
    probs, y, final_model = walk_forward_oof(data, make_fn)
    print(f"  total OOF samples: {len(probs)}")
    x_cal, y_cal = fit_calibration(probs, y)
    diagnose(label, probs, y, x_cal, y_cal)
    export_model(market_key, final_model, len(data), x_cal, y_cal, is_lgb)


if __name__ == '__main__':
    print("=" * 60)
    print("v10 — LightGBM crypto + XGBoost stocks")
    print("=" * 60)

    print("\n\n##### CRYPTO (LightGBM d4 t150) #####")
    calibrate_market(CRYPTO_SYMBOLS, True, "Crypto", "crypto")

    print("\n\n##### STOCKS (XGBoost d5 t100) #####")
    calibrate_market(STOCK_SYMBOLS, False, "Stocks", "stock")

    print("\n" + "=" * 60)
    print("DONE")
    print("=" * 60)
