"""
Model comparison — test multiple configurations on the same data.
Reports walk-forward accuracy + top-bucket reliability for each.
"""

import json
import os
import numpy as np
import pandas as pd
import xgboost as xgb

try:
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False
    print("WARNING: lightgbm not installed — skipping LightGBM configs")
    print("  Install with: pip3 install lightgbm")

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
    'earningsProximity',
    'shortVolumeRatio', 'shortVolumeZScore',
    'oiPriceInteraction', 'fundingSlope', 'bodyWickRatio',
    'vpDistToPocATR', 'vpAbovePoc', 'vpVAWidth', 'vpInValueArea',
    'vpDistToVAH_ATR', 'vpDistToVAL_ATR',
    'hRsiDelta1', 'hMacdHistDelta1', 'dRsiDelta1',
    'hRsiAccel', 'hMacdAccel', 'dAdxAccel',
    'hourBucket', 'isWeekend',
]

DOWNLOADS = '/Volumes/External/Downloads'

CRYPTO_SYMBOLS = [
    'BTC', 'ETH', 'BCH', 'XRP', 'LTC', 'TRX', 'ETC', 'LINK', 'XLM', 'ADA',
    'XMR', 'DASH', 'ZEC', 'XTZ', 'BNB', 'ATOM', 'ONT', 'IOTA', 'BAT', 'VET',
    'NEO', 'QTUM', 'IOST', 'THETA', 'ALGO', 'ZIL', 'KNC', 'ZRX', 'COMP', 'DOGE',
    'KAVA', 'BAND', 'RLC', 'SNX', 'DOT', 'YFI', 'CRV', 'TRB', 'RUNE', 'SUSHI',
    'EGLD', 'SOL', 'ICX', 'STORJ', 'UNI', 'AVAX', 'ENJ', 'KSM', 'NEAR', 'AAVE',
    'FIL', 'RSR', 'BEL', 'AXS', 'SKL', 'GRT',
    'SAND', 'MANA', 'HBAR', 'MATIC', 'ICP', 'DYDX', 'GALA',
    'IMX', 'GMT', 'APE', 'INJ', 'LDO', 'APT',
    'ARB', 'SUI', 'PENDLE', 'SEI', 'TIA', 'JUP', 'PEPE',
]
STOCK_SYMBOLS = [
    'AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN',
    'CRM', 'NFLX', 'AMD', 'ORCL', 'ADBE', 'INTC', 'CSCO',
    'AVGO', 'QCOM', 'MU', 'AMAT', 'LRCX', 'MRVL',
    'PLTR', 'ROKU', 'SHOP', 'SQ', 'SNAP', 'COIN', 'RBLX',
    'BYND', 'GME',
    'JPM', 'GS', 'MS', 'BAC', 'WFC', 'BLK', 'SCHW',
    'UNH', 'LLY', 'ABBV', 'JNJ', 'PFE', 'MRK', 'TMO',
    'REGN', 'VRTX', 'GILD', 'BIIB',
    'HD', 'MA', 'V', 'DIS', 'NKE', 'SBUX', 'MCD', 'WMT', 'COST',
    'CAT', 'DE', 'X', 'BA',
    'XOM', 'OXY', 'FANG', 'CVX', 'SLB',
    'LMT', 'RTX', 'GD',
    'UNP', 'FDX', 'DAL',
    'T', 'VZ', 'CMCSA',
    'SPG', 'O',
    'SPY', 'QQQ', 'IWM', 'XLE', 'XLF', 'XLK', 'XLV', 'GLD', 'TLT',
]


def load_symbol(symbol, is_crypto):
    suffix = 'USDT' if is_crypto else ''
    path = f'{DOWNLOADS}/{symbol}{suffix}.csv'
    if not os.path.isfile(path):
        return None
    df = pd.read_csv(path)
    if 'fwdMaxFavR' not in df.columns:
        return None
    valid = df[df['fwdMaxFavR'].notna() & df['fwdReturn24H'].notna()].copy()
    valid['goodR'] = (valid['fwdMaxFavR'] >= 1.5).astype(int)
    for feat in FEATURES:
        if feat not in valid.columns:
            if feat == 'takerRatioRaw': default = 1.0
            elif feat == 'longPctRaw': default = 50.0
            else: default = 0.0
            valid[feat] = default
    return valid


def downsample_daily(df):
    df = df.copy()
    df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
    return df.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)


def load_market(symbols, is_crypto):
    parts = []
    for s in symbols:
        d = load_symbol(s, is_crypto)
        if d is None:
            continue
        if 'symbol' not in d.columns:
            d['symbol'] = s
        d = downsample_daily(d)
        parts.append(d)
    if not parts:
        return None
    return pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)


def compute_sample_weights(timestamps):
    now = timestamps.max()
    one_year = now - 365 * 86400
    two_years = now - 2 * 365 * 86400
    w = np.ones(len(timestamps))
    w[timestamps >= two_years] = 2.0
    w[timestamps >= one_year] = 3.0
    return w


def walk_forward_eval(data, make_model_fn, n_folds=3, purge=48):
    n = len(data)
    oof_probs, oof_y = [], []
    fold_accs = []
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
        fold_accs.append(acc)
        oof_probs.append(p)
        oof_y.append(y_v.values)

    all_p = np.concatenate(oof_probs)
    all_y = np.concatenate(oof_y)
    overall_acc = ((all_p >= 0.5).astype(int) == all_y).mean()

    # Reliability buckets
    buckets = {}
    for lo, hi in [(0.0, 0.3), (0.3, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.85), (0.85, 1.01)]:
        m = (all_p >= lo) & (all_p < hi)
        if m.sum() > 0:
            buckets[f'[{lo:.2f},{hi:.2f})'] = {
                'n': int(m.sum()),
                'actual': float(all_y[m].mean()),
            }

    top_bucket = buckets.get('[0.70,0.85)', {})
    return {
        'overall_acc': overall_acc,
        'fold_accs': fold_accs,
        'oof_samples': len(all_p),
        'top_bucket_n': top_bucket.get('n', 0),
        'top_bucket_actual': top_bucket.get('actual', 0),
        'buckets': buckets,
        'p_max': float(all_p.max()),
        'p_mean': float(all_p.mean()),
    }


# ================================================================
# Model configurations to test
# ================================================================

CONFIGS = {
    'XGB d3 t100 (baseline)': lambda: xgb.XGBClassifier(
        max_depth=3, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42,
    ),
    'XGB d4 t100': lambda: xgb.XGBClassifier(
        max_depth=4, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42,
    ),
    'XGB d4 t150': lambda: xgb.XGBClassifier(
        max_depth=4, n_estimators=150, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42,
    ),
    'XGB d5 t100': lambda: xgb.XGBClassifier(
        max_depth=5, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42,
    ),
    'XGB d3 t200': lambda: xgb.XGBClassifier(
        max_depth=3, n_estimators=200, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42,
    ),
    'XGB d3 t100 lr0.05': lambda: xgb.XGBClassifier(
        max_depth=3, n_estimators=100, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42,
    ),
    'XGB d4 t200 lr0.02': lambda: xgb.XGBClassifier(
        max_depth=4, n_estimators=200, learning_rate=0.02,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.2, reg_lambda=2.0, eval_metric='logloss', random_state=42,
    ),
}

if HAS_LGB:
    CONFIGS['LGB d3 t100'] = lambda: lgb.LGBMClassifier(
        max_depth=3, n_estimators=100, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_samples=10,
        reg_alpha=0.1, reg_lambda=1.0, random_state=42, verbose=-1,
    )
    CONFIGS['LGB d4 t150'] = lambda: lgb.LGBMClassifier(
        max_depth=4, n_estimators=150, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_samples=10,
        reg_alpha=0.1, reg_lambda=1.0, random_state=42, verbose=-1,
    )
    CONFIGS['LGB d5 t200'] = lambda: lgb.LGBMClassifier(
        max_depth=5, n_estimators=200, learning_rate=0.02,
        subsample=0.8, colsample_bytree=0.8, min_child_samples=10,
        reg_alpha=0.2, reg_lambda=2.0, random_state=42, verbose=-1,
    )


if __name__ == '__main__':
    print("Loading data...")
    crypto_data = load_market(CRYPTO_SYMBOLS, True)
    stock_data = load_market(STOCK_SYMBOLS, False)
    print(f"  Crypto: {len(crypto_data)} bars")
    print(f"  Stocks: {len(stock_data)} bars")

    results = {}
    for name, make_fn in CONFIGS.items():
        print(f"\n{'='*60}")
        print(f"  {name}")
        print(f"{'='*60}")

        print(f"  Crypto...")
        cr = walk_forward_eval(crypto_data, make_fn)
        print(f"    WF acc: {cr['overall_acc']*100:.1f}%  "
              f"folds: {', '.join(f'{a*100:.1f}%' for a in cr['fold_accs'])}  "
              f"top[0.70,0.85): n={cr['top_bucket_n']}, actual={cr['top_bucket_actual']*100:.1f}%")

        print(f"  Stocks...")
        sr = walk_forward_eval(stock_data, make_fn)
        print(f"    WF acc: {sr['overall_acc']*100:.1f}%  "
              f"folds: {', '.join(f'{a*100:.1f}%' for a in sr['fold_accs'])}  "
              f"top[0.70,0.85): n={sr['top_bucket_n']}, actual={sr['top_bucket_actual']*100:.1f}%")

        results[name] = {'crypto': cr, 'stock': sr}

    # Summary table
    print(f"\n\n{'='*90}")
    print(f"{'SUMMARY':^90}")
    print(f"{'='*90}")
    print(f"{'Config':<25s} {'Crypto WF%':>10s} {'Top n':>6s} {'Top%':>6s}  {'Stock WF%':>10s} {'Top n':>6s} {'Top%':>6s}")
    print(f"{'-'*90}")
    for name in CONFIGS:
        r = results[name]
        cr, sr = r['crypto'], r['stock']
        print(f"{name:<25s} "
              f"{cr['overall_acc']*100:9.1f}% {cr['top_bucket_n']:6d} {cr['top_bucket_actual']*100:5.1f}%  "
              f"{sr['overall_acc']*100:9.1f}% {sr['top_bucket_n']:6d} {sr['top_bucket_actual']*100:5.1f}%")

    # Save results
    with open('/Users/bojanmihovilovic/CryptoLens/ml-training/comparison_results.json', 'w') as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\nResults saved to ml-training/comparison_results.json")
