"""
v10 signed quality models.

Trains four XGBoost classifiers:
  - crypto_long:  P(fwdMaxUp24H   >= 1.5 ATR within 24h | features)
  - crypto_short: P(fwdMaxDown24H >= 1.5 ATR within 24h | features)
  - stock_long:   same, stocks
  - stock_short:  same, stocks

Same 105 features, same hyperparams, same walk-forward CV, same isotonic calibration
as calibrate_v9.py. Exports four .mlmodel files + four calibration JSONs.

Target math: fwdMaxUp24H and fwdMaxDown24H are in percent-of-price units.
atrPercent is 4H ATR as percent-of-price. So fwdMaxUp24H / atrPercent gives the
up-move magnitude in ATR multiples. Threshold at 1.5 matches v9's goodR spec.
"""

import json
import os
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression

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
assert len(FEATURES) == 105

DOWNLOADS = '/Users/bojanmihovilovic/Downloads'
REPO = '/Users/bojanmihovilovic/CryptoLens'
WORKER = f'{REPO}/marketscope-worker/src'
IOS_ML = f'{REPO}/CryptoLens/ML'
ML_TRAINING = f'{REPO}/ml-training'

CRYPTO_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA',
                  'LINK', 'AVAX', 'DOT', 'NEAR']
STOCK_SYMBOLS = ['AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN',
                 'JPM', 'UNH', 'HD', 'MA', 'ABBV', 'V', 'AMD', 'NFLX',
                 'BA', 'XOM', 'CRM', 'LLY', 'DIS']

CAP = 0.85
ATR_MULTIPLE = 1.5


def load_symbol(symbol, is_crypto):
    suffix = 'USDT' if is_crypto else ''
    path = f'{DOWNLOADS}/{symbol}{suffix}.csv'
    if not os.path.isfile(path):
        print(f"  MISSING: {path}")
        return None
    df = pd.read_csv(path)
    df['symbol'] = df.get('symbol', symbol)
    if 'fwdMaxUp24H' not in df or 'fwdMaxDown24H' not in df or 'atrPercent' not in df:
        print(f"  WARNING: {symbol} missing required columns")
        return None
    valid = df[df['fwdMaxUp24H'].notna() & df['fwdMaxDown24H'].notna() & df['atrPercent'].notna()].copy()
    # Signed targets: up-move / down-move magnitude in ATR multiples
    atr_pct = valid['atrPercent'].replace(0, np.nan)
    valid['goodR_long']  = ((valid['fwdMaxUp24H']   / atr_pct) >= ATR_MULTIPLE).astype(int)
    valid['goodR_short'] = ((valid['fwdMaxDown24H'] / atr_pct) >= ATR_MULTIPLE).astype(int)
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
        print(f"  {s}: {len(d)} bars  long={d['goodR_long'].mean()*100:.1f}%  short={d['goodR_short'].mean()*100:.1f}%")
    if not parts:
        return None
    out = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    print(f"  TOTAL: {len(out)} bars  long={out['goodR_long'].mean()*100:.1f}%  short={out['goodR_short'].mean()*100:.1f}%")
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
    # Same hyperparams as v9
    return xgb.XGBClassifier(
        max_depth=3, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0,
        eval_metric='logloss', random_state=42,
    )


def walk_forward_oof(data, target_col, n_folds=3, purge=48):
    """Return (oof_probs, y_true, folds_info). Also returns the final model trained on all data."""
    n = len(data)
    oof_probs = []
    oof_y = []
    folds_info = []
    for i in range(n_folds):
        train_end = int(n * (0.4 + i * 0.15))
        val_start = train_end + purge
        val_end = int(n * (0.55 + i * 0.15)) if i < n_folds - 1 else n
        if val_start >= val_end:
            continue
        train = data.iloc[:train_end]
        val = data.iloc[val_start:val_end]
        X_t, y_t = train[FEATURES].fillna(0), train[target_col]
        X_v, y_v = val[FEATURES].fillna(0), val[target_col]
        w_t = compute_sample_weights(train['timestamp'].values)
        m = make_model()
        m.fit(X_t, y_t, sample_weight=w_t, verbose=0)
        p = m.predict_proba(X_v)[:, 1]
        acc = ((p >= 0.5).astype(int) == y_v.values).mean()
        base = y_v.mean()
        folds_info.append((i + 1, len(train), len(val), acc, base))
        print(f"    fold {i+1}: n_train={len(train)} n_val={len(val)} acc={acc*100:.1f}% "
              f"base={base*100:.1f}% p_mean={p.mean():.3f} p_max={p.max():.3f}")
        oof_probs.append(p)
        oof_y.append(y_v.values)

    # Train a FINAL model on all data for export
    X_all, y_all = data[FEATURES].fillna(0), data[target_col]
    w_all = compute_sample_weights(data['timestamp'].values)
    final_model = make_model()
    final_model.fit(X_all, y_all, sample_weight=w_all, verbose=0)

    return np.concatenate(oof_probs), np.concatenate(oof_y), folds_info, final_model


def fit_calibration(probs, y_true):
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(probs, y_true)
    x = iso.X_thresholds_.tolist()
    y = np.minimum(iso.y_thresholds_, CAP).tolist()
    return x, y


def diagnose(name, raw, y_true):
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(raw, y_true)
    mapped = np.minimum(iso.predict(raw), CAP)
    print(f"\n  {name} raw:    mean={raw.mean():.3f} p90={np.percentile(raw, 90):.3f} max={raw.max():.3f}")
    print(f"  {name} mapped: mean={mapped.mean():.3f} p90={np.percentile(mapped, 90):.3f} max={mapped.max():.3f}")
    print(f"  {name} actual base rate: {y_true.mean()*100:.1f}%")
    print(f"  reliability (mapped bucket → actual rate):")
    for lo, hi in [(0.0, 0.3), (0.3, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.85)]:
        m = (mapped >= lo) & (mapped < hi)
        if m.sum() > 0:
            print(f"    [{lo:.2f}, {hi:.2f}): n={m.sum():5d}, actual={y_true[m].mean()*100:.1f}%")


def export_model_bundle(model, market, side, x_cal, y_cal):
    """Export CoreML + worker JSON, each with calibration embedded."""
    # JSON (for worker)
    booster = model.get_booster()
    trees = [json.loads(t) for t in booster.get_dump(dump_format='json')]
    try:
        base_score = float(booster.get_booster_info().get('base_score', 0.5))
    except Exception:
        base_score = 0.5
    json_obj = {
        'features': FEATURES,
        'trees': trees,
        'base_score': base_score,
        'version': 10,
        'market': market,
        'side': side,  # 'long' or 'short'
        'n_features': len(FEATURES),
        'n_trees': len(trees),
        'model_type': 'classifier',
        'target': f'goodR_{side}',
        'calibration': {'x': x_cal, 'y': y_cal, 'cap': CAP, 'method': 'isotonic'},
        'description': f'v10 signed {market} {side} — goodR_{side} = fwdMax{side.capitalize()}24H/atrPercent >= 1.5',
    }
    worker_path = f'{WORKER}/ml-model-{market}-{side}.json'
    with open(worker_path, 'w') as f:
        json.dump(json_obj, f)
    print(f"  wrote {worker_path}")

    # CoreML (for iOS)
    try:
        import coremltools as ct
        coreml = ct.converters.xgboost.convert(model, feature_names=FEATURES, mode='classifier')
        coreml.short_description = f'MarketScope v10 signed {market} {side} ({len(trees)} trees)'
        coreml_path = f'{ML_TRAINING}/MarketScoreML_{market}_{side}.mlmodel'
        coreml.save(coreml_path)
        # Copy to iOS bundle
        import shutil
        ios_path = f'{IOS_ML}/MarketScoreML_{market}_{side}.mlmodel'
        shutil.copy2(coreml_path, ios_path)
        print(f"  wrote {ios_path}")
    except Exception as e:
        print(f"  CoreML export failed: {e}")

    # iOS calibration JSON (sidecar for the CoreML model)
    cal_path = f'{IOS_ML}/{market}_{side}_calibration.json'
    with open(cal_path, 'w') as f:
        json.dump({'x': x_cal, 'y': y_cal, 'cap': CAP}, f)
    print(f"  wrote {cal_path}")


def train_market(symbols, is_crypto, market_label, market_key):
    data = load_market(symbols, is_crypto, market_label)
    if data is None:
        return
    for side in ['long', 'short']:
        target = f'goodR_{side}'
        print(f"\n  === {market_label} {side.upper()} ({target}) ===")
        print(f"  walk-forward CV:")
        probs, y, folds, final_model = walk_forward_oof(data, target)
        wf_mean = np.mean([f[3] for f in folds])
        base_mean = np.mean([f[4] for f in folds])
        print(f"  walk-forward mean: {wf_mean*100:.1f}% (base {base_mean*100:.1f}%, lift +{(wf_mean-base_mean)*100:.1f}pp)")
        x_cal, y_cal = fit_calibration(probs, y)
        diagnose(f"{market_label} {side}", probs, y)
        export_model_bundle(final_model, market_key, side, x_cal, y_cal)


if __name__ == '__main__':
    print("=" * 64)
    print("v10 SIGNED QUALITY MODELS")
    print("=" * 64)
    print("\n##### CRYPTO #####")
    train_market(CRYPTO_SYMBOLS, True, "Crypto", "crypto")
    print("\n##### STOCKS #####")
    train_market(STOCK_SYMBOLS, False, "Stocks", "stock")
    print("\n" + "=" * 64)
    print("DONE — v10 signed models exported")
    print("Next: wire up iOS MLScoring + worker ml-predict to run both models")
    print("=" * 64)
