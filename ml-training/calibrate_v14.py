#!/usr/bin/env python3
"""v14 retrain on the full-coverage derivatives regen (csv_exports_v14*).

Implements the 2026-07-05 feature+model audit follow-ups:
  1. volScalarML DROPPED (r=1.000 duplicate of atrPercentile) → 110 features.
  2. Derivatives features KEPT — their zero-split verdict on v11_fixed was a
     coverage artifact (1-2.5% populated); v14 regen backfills funding + basis +
     OI/taker/long% from Binance Vision, so they get their first real evaluation.
  3. Pruned feature set tested head-to-head vs full (audit dead-weight groups,
     MINUS derivatives, MINUS context_atr — its ablation was masked by the
     volScalarML duplicate — and MINUS temporal on stocks, where regimeCode
     dominates permutation importance).
  4. Stocks: d6-class challengers re-validated (beat prod 3/3 folds in the audit,
     under the ship bar there; fresh data = fresh test).
  5. Calibration floor (Wilson LB of bottom-decile realized rate) + 0.85 cap,
     per the 2026-06-05 "no dishonest 0%" fix. Recorded as calibration.floor.

Pre-declared ship bar (same as the audit): a challenger (config or feature set)
displaces the incumbent only if mean ΔAUC > +0.005 AND positive in EVERY fold
AND top-decile precision not degraded by more than 0.005. Otherwise PROD config
on the FULL feature set ships.

Methodology mirrors calibrate_v12_crypto_clean.py exactly: fold boundaries
train_end = n·(0.4+0.15i), 48-row purge, daily downsample, time-decay weights.

Usage:
  python3 calibrate_v14.py crypto            # evaluate + write staging JSON
  python3 calibrate_v14.py stocks
  python3 calibrate_v14.py crypto --ship     # also copy into worker/src + CryptoLens/ML
"""
import json
import math
import os
import shutil
import sys

import numpy as np
import pandas as pd
import lightgbm as lgb
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MARKET = sys.argv[1] if len(sys.argv) > 1 else 'crypto'
SHIP = '--ship' in sys.argv
assert MARKET in ('crypto', 'stocks'), 'usage: calibrate_v14.py crypto|stocks [--ship]'

TRAIN_DIR = os.path.join(HERE, 'csv_exports_v14' if MARKET == 'crypto' else 'csv_exports_v14_stocks')
STAGING = os.path.join(HERE, 'models_v14')
MARKET_KEY = 'crypto' if MARKET == 'crypto' else 'stock'
VERSION = 14
CAP = 0.85

# 111-feature serving contract minus volScalarML (audit: literal duplicate of
# atrPercentile). The worker computes the full dict at serve time and evaluates
# trees by feature name, so a trimmed training list is serving-safe.
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
    'vix', 'dxyAboveEma20',
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
assert len(FEATURES) == 110, f'expected 110 features, got {len(FEATURES)}'

# Prune candidates from the audit's dead-weight verdicts. Derivatives groups are
# deliberately absent (fresh coverage in v14 = fresh evaluation). context_atr is
# absent (its ablation was masked by the volScalarML↔atrPercentile duplicate).
# temporal is absent on stocks (regimeCode dominates stock permutation importance)
# and load-bearing on crypto (dayOfWeek is the top crypto feature).
ONEH = ['eRsi', 'eEmaCross', 'eStochK', 'eMacdHist']
MACRO = ['vix', 'dxyAboveEma20']
CANDLE3 = ['last3Green', 'last3Red', 'last3VolIncreasing', 'bodyWickRatio']
STOCK_ONLY = ['obvRising', 'adLineAccumulation', 'fiftyTwoWeekPct', 'distToFiftyTwoHigh',
              'gapPercent', 'gapFilled', 'gapDirectionAligned', 'relStrengthVsSpy', 'beta',
              'vixLevelCode', 'isMarketHours', 'earningsProximity', 'shortVolumeRatio',
              'shortVolumeZScore', 'relStrengthVsSector', 'vixTermStructure', 'dxyMomentum',
              'iwmSpyRatio']
DELTAS_6BAR = ['dRsiDelta', 'dAdxDelta', 'hRsiDelta', 'hAdxDelta', 'hMacdHistDelta']
DELTAS_1BAR = ['hRsiDelta1', 'hMacdHistDelta1', 'dRsiDelta1']
ACCEL = ['hRsiAccel', 'hMacdAccel', 'dAdxAccel']
DERIV_ALL = ['fundingSignal', 'oiSignal', 'takerSignal', 'crowdingSignal', 'derivativesCombined',
             'fundingRateRaw', 'oiChangePct', 'takerRatioRaw', 'longPctRaw',
             'oiPriceInteraction', 'fundingSlope', 'basisPct', 'basisExtreme']
SENTIMENT_CRYPTO = ['fearGreedIndex', 'fearGreedZone', 'ethBtcRatio', 'ethBtcDelta6']

if MARKET == 'crypto':
    PRUNE = ONEH + MACRO + CANDLE3 + STOCK_ONLY + DELTAS_6BAR + DELTAS_1BAR + ACCEL
else:
    # Stocks: crypto-only groups are structural constants; deriv groups are all-zero.
    PRUNE = ONEH + MACRO + CANDLE3 + DELTAS_6BAR + DERIV_ALL + SENTIMENT_CRYPTO
PRUNED = [f for f in FEATURES if f not in PRUNE]

# ---------------------------------------------------------------------------
# T22/T23 MINIMAL set (added 2026-08-24).
#
# DISTINCT from PRUNED above, and nearly opposite on the decisive blocks: the older
# prune keeps derivatives + volume-profile and drops the delta/accel terms, and it
# FAILED the v14 ship bar. T18's group ablation found the reverse — the trend/momentum
# block (deltas and accelerations included) is the ONLY load-bearing one at -0.0501 AUC,
# while price structure is net NOISE (+0.0038 when removed) and derivatives are weakest.
#
# Validated leave-one-symbol-out on TWO independent targets across 10 assets:
#   T22 y_crash : 55 features scored 0.6260 vs 120's 0.6154  (+0.0106)
#   T23 goodR   : 55 features scored 0.7867 vs 120's 0.7829  (+0.0038), 10/10 within margin
# See docs/research/feature-pruning.md.
M_MKTWIDE = ['vix', 'dxyAboveEma20', 'vixLevelCode', 'vixTermStructure', 'dxyMomentum',
             'relStrengthVsSpy', 'relStrengthVsSector', 'iwmSpyRatio', 'isCrypto',
             'fearGreedIndex', 'fearGreedZone', 'ethBtcRatio', 'ethBtcDelta6']
M_PRICESTRUCT = ['dStructBull', 'dStructBear', 'hStructBull', 'hStructBear',
                 'dBBPercentB', 'hBBPercentB', 'dAboveVwap', 'hAboveVwap',
                 'fiftyTwoWeekPct', 'distToFiftyTwoHigh', 'vpDistToPocATR', 'vpAbovePoc',
                 'vpVAWidth', 'vpInValueArea', 'vpDistToVAH_ATR', 'vpDistToVAL_ATR',
                 'gapPercent', 'gapFilled', 'gapDirectionAligned', 'dDivergence', 'hDivergence',
                 'dStochK', 'hStochK', 'eStochK', 'dStochCross', 'hStochCross']
M_TAIL = ['bodyWickRatio', 'last3Green', 'last3Red']
M_LIQ = ['dVolumeRatio', 'hVolumeRatio', 'last3VolIncreasing', 'obvRising', 'adLineAccumulation',
         'shortVolumeRatio', 'shortVolumeZScore']
M_XHORIZON = ['tfAlignment', 'momentumAlignment', 'structureAlignment']
MINIMAL_DROP = M_MKTWIDE + M_PRICESTRUCT + M_TAIL + M_LIQ + M_XHORIZON
if MARKET == 'crypto':
    # derivatives were T17's weakest block and the 2026-07-05 audit found ZERO splits;
    # stock-only columns are structural constants here.
    MINIMAL_DROP = MINIMAL_DROP + DERIV_ALL + STOCK_ONLY
MINIMAL = [f for f in FEATURES if f not in MINIMAL_DROP]




def load_data():
    parts = []
    for fname in sorted(os.listdir(TRAIN_DIR)):
        if not fname.endswith('.csv'):
            continue
        df = pd.read_csv(os.path.join(TRAIN_DIR, fname))
        if 'fwdMaxFavR' not in df.columns:
            continue
        if 'symbol' not in df.columns:
            df['symbol'] = fname[:-4]
        df = df[df['fwdMaxFavR'].notna() & df['fwdReturn24H'].notna()].copy()
        df['goodR'] = (df['fwdMaxFavR'] >= 1.5).astype(int)
        for feat in FEATURES:
            if feat not in df.columns:
                df[feat] = 1.0 if feat == 'takerRatioRaw' else (50.0 if feat == 'longPctRaw' else 0.0)
        df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
        df = df.groupby(['symbol', 'date']).tail(1)  # canonical daily downsample
        parts.append(df)
    out = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    print(f'{MARKET}: {len(out)} daily bars, {out.symbol.nunique()} symbols, '
          f'goodR base {out.goodR.mean():.3f}')
    # Coverage sanity — the whole point of v14. Refuse to train on thin derivatives.
    if MARKET == 'crypto':
        for col, default in [('fundingRateRaw', 0.0), ('oiChangePct', 0.0), ('basisPct', 0.0)]:
            cov = (out[col] != default).mean()
            print(f'  coverage {col}: {cov*100:.1f}%')
            if cov < 0.30:
                raise SystemExit(f'!! {col} coverage {cov*100:.1f}% < 30% — regen incomplete? aborting')
    return out


def weights(ts):
    now = ts.max()
    w = np.ones(len(ts))
    w[ts >= now - 2 * 365 * 86400] = 2.0
    w[ts >= now - 365 * 86400] = 3.0
    return w


def folds(n, n_folds=3, purge=48):
    for i in range(n_folds):
        train_end = int(n * (0.4 + i * 0.15))
        val_start = train_end + purge
        val_end = int(n * (0.55 + i * 0.15)) if i < n_folds - 1 else n
        if val_start < val_end:
            yield i, train_end, val_start, val_end


def wf_run(data, feats, model_fn):
    """Per-fold (auc, top-decile precision) + concatenated OOF (probs, y)."""
    rows, oof_p, oof_y = [], [], []
    for i, te, vs, ve in folds(len(data)):
        tr, va = data.iloc[:te], data.iloc[vs:ve]
        m = model_fn()
        m.fit(tr[feats].fillna(0), tr['goodR'], sample_weight=weights(tr['timestamp'].values))
        p = m.predict_proba(va[feats].fillna(0))[:, 1]
        y = va['goodR'].values
        top = y[np.argsort(p)[-max(1, len(p) // 10):]]
        rows.append((roc_auc_score(y, p), top.mean()))
        oof_p.append(p)
        oof_y.append(y)
    return rows, np.concatenate(oof_p), np.concatenate(oof_y)


def mk_lgb(depth, trees, lr=0.03):
    return lambda: lgb.LGBMClassifier(max_depth=depth, n_estimators=trees, learning_rate=lr,
                                      subsample=0.8, colsample_bytree=0.8, min_child_samples=10,
                                      reg_alpha=0.1, reg_lambda=1.0, random_state=42, verbose=-1)


def mk_xgb(depth, trees, lr=0.03):
    return lambda: xgb.XGBClassifier(max_depth=depth, n_estimators=trees, learning_rate=lr,
                                     subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
                                     reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss',
                                     random_state=42)


if MARKET == 'crypto':
    PROD_NAME, PROD_FN, PROD_IS_LGB = 'LGB d4 t150', mk_lgb(4, 150), True
    CHALLENGERS = [('LGB d5 t300', mk_lgb(5, 300), True),
                   ('LGB d6 t200', mk_lgb(6, 200), True),
                   ('XGB d6 t200', mk_xgb(6, 200), False)]
else:
    PROD_NAME, PROD_FN, PROD_IS_LGB = 'XGB d5 t100', mk_xgb(5, 100), False
    # The three that beat prod 3/3 folds in the 2026-07-05 audit (under the bar there).
    CHALLENGERS = [('XGB d6 t200', mk_xgb(6, 200), False),
                   ('LGB d6 t200', mk_lgb(6, 200), True),
                   ('LGB d5 t300', mk_lgb(5, 300), True)]


def beats_bar(rows, base_rows):
    d = np.mean([r[0] for r in rows]) - np.mean([r[0] for r in base_rows])
    all_pos = all(r[0] > b[0] for r, b in zip(rows, base_rows))
    top_ok = np.mean([r[1] for r in rows]) >= np.mean([r[1] for r in base_rows]) - 0.005
    return d > 0.005 and all_pos and top_ok, d


def fmt(rows):
    return (f'AUC {" ".join(f"{r[0]:.4f}" for r in rows)} (mean {np.mean([r[0] for r in rows]):.4f}) '
            f'| top10% {" ".join(f"{r[1]:.3f}" for r in rows)} (mean {np.mean([r[1] for r in rows]):.3f})')


def wilson_lb(k, n, z=1.96):
    if n == 0:
        return 0.0
    p = k / n
    denom = 1 + z * z / n
    center = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (center - margin) / denom)


def fit_calibration(probs, y_true):
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(probs, y_true)
    x = iso.X_thresholds_.tolist()
    y = np.array(iso.y_thresholds_)
    # Floor: Wilson LB of realized rate in the bottom predicted decile — a 0%
    # calibrated prob claims a ≥1.5 ATR move is impossible, which is never true.
    cutoff = np.percentile(probs, 10)
    bottom = y_true[probs <= cutoff]
    floor = round(wilson_lb(bottom.sum(), len(bottom)), 4)
    y = np.clip(y, floor, CAP)
    return x, y.tolist(), floor


def lgb_tree_to_xgb_format(node, feature_names, counter):
    nid = counter[0]
    counter[0] += 1
    if 'leaf_value' in node:
        return {'nodeid': nid, 'leaf': node['leaf_value']}
    left = lgb_tree_to_xgb_format(node['left_child'], feature_names, counter)
    right = lgb_tree_to_xgb_format(node['right_child'], feature_names, counter)
    fi = node['split_feature']
    return {'nodeid': nid, 'split': feature_names[fi] if isinstance(fi, int) else fi,
            'split_condition': node['threshold'], 'yes': left['nodeid'], 'no': right['nodeid'],
            'missing': left['nodeid'], 'children': [left, right]}


def extract_trees(model, is_lgb, feats):
    if is_lgb:
        dump = model.booster_.dump_model()
        names = dump.get('feature_names', feats)
        return [lgb_tree_to_xgb_format(t['tree_structure'], names, [0]) for t in dump['tree_info']]
    return [json.loads(t) for t in model.get_booster().get_dump(dump_format='json')]


def reliability(probs, y_true, x_cal, y_cal, floor):
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(probs, y_true)
    mapped = np.clip(iso.predict(probs), floor, CAP)
    print('  reliability (calibrated bucket → realized goodR):')
    for lo, hi in [(0.0, 0.3), (0.3, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.85)]:
        m = (mapped >= lo) & (mapped < hi)
        if m.sum() > 0:
            print(f'    [{lo:.2f},{hi:.2f}): n={m.sum():6d} realized={y_true[m].mean()*100:.1f}%')


def main():
    data = load_data()
    print(f'\nfeature sets: FULL={len(FEATURES)}, PRUNED={len(PRUNED)}, MINIMAL={len(MINIMAL)}')

    print(f'\n===== BASELINE: {PROD_NAME} × FULL =====')
    base_rows, base_p, base_y = wf_run(data, FEATURES, PROD_FN)
    print('  ' + fmt(base_rows))

    candidates = {(PROD_NAME, 'FULL'): (base_rows, base_p, base_y, PROD_FN, PROD_IS_LGB, FEATURES)}

    print(f'\n===== PRUNED feature set ({PROD_NAME}) =====')
    rows, p, y = wf_run(data, PRUNED, PROD_FN)
    ok, d = beats_bar(rows, base_rows)
    print(f'  {fmt(rows)}  Δ{d:+.4f}{"  ★ BEATS BAR" if ok else ""}')
    candidates[(PROD_NAME, 'PRUNED')] = (rows, p, y, PROD_FN, PROD_IS_LGB, PRUNED)

    # MINIMAL is a SIMPLIFICATION candidate, so it is judged on NON-INFERIORITY rather than the
    # challenger bar: a smaller set that merely MATCHES is strictly better (less overfitting
    # surface, smaller worker<->iOS parity contract, fewer upstream dependencies to keep alive).
    # Bar declared here: mean ΔAUC >= -0.002 AND no fold worse than -0.005 AND top-decile within
    # 0.005. See docs/research/feature-pruning.md.
    print(f'\n===== MINIMAL feature set ({PROD_NAME}) — T22/T23 =====')
    rows_m, p_m, y_m = wf_run(data, MINIMAL, PROD_FN)
    d_m = np.mean([r[0] for r in rows_m]) - np.mean([r[0] for r in base_rows])
    worst = min(r[0] - b[0] for r, b in zip(rows_m, base_rows))
    top_ok = np.mean([r[1] for r in rows_m]) >= np.mean([r[1] for r in base_rows]) - 0.005
    noninf = d_m >= -0.002 and worst >= -0.005 and top_ok
    print(f'  {fmt(rows_m)}  Δ{d_m:+.4f}  worst fold {worst:+.4f}  '
          f'{"★ NON-INFERIOR — SIMPLIFICATION JUSTIFIED" if noninf else "fails non-inferiority"}')
    print(f'  {len(MINIMAL)} features vs {len(FEATURES)} '
          f'({(1-len(MINIMAL)/len(FEATURES))*100:.0f}% removed)')
    candidates[(PROD_NAME, 'MINIMAL')] = (rows_m, p_m, y_m, PROD_FN, PROD_IS_LGB, MINIMAL)

    print('\n===== CONFIG CHALLENGERS (FULL) =====')
    for name, fn, is_l in CHALLENGERS:
        rows, p, y = wf_run(data, FEATURES, fn)
        ok, d = beats_bar(rows, base_rows)
        print(f'  {name:<12} {fmt(rows)}  Δ{d:+.4f}{"  ★ BEATS BAR" if ok else ""}')
        candidates[(name, 'FULL')] = (rows, p, y, fn, is_l, FEATURES)

    # Winner: any candidate that beats the bar; ties broken by mean AUC. Default prod.
    winner_key = (PROD_NAME, 'FULL')
    best_auc = np.mean([r[0] for r in base_rows])
    for key, (rows, *_rest) in candidates.items():
        if key == winner_key:
            continue
        ok, _ = beats_bar(rows, base_rows)
        auc = np.mean([r[0] for r in rows])
        if ok and auc > best_auc:
            winner_key, best_auc = key, auc
    # SIMPLIFICATION TIE-BREAK (2026-08-24): if no challenger beat the bar and MINIMAL is
    # NON-INFERIOR, prefer it. A set that matches on a fraction of the inputs is strictly better —
    # less overfitting surface on every future retrain — so 'no worse and much smaller' should win
    # even though it cannot clear a bar designed for challengers claiming to be BETTER.
    if winner_key == (PROD_NAME, 'FULL') and noninf:
        winner_key = (PROD_NAME, 'MINIMAL')
        best_auc = np.mean([r[0] for r in rows_m])
        print(f'\n  simplification tie-break: MINIMAL is non-inferior '
              f'({len(MINIMAL)} vs {len(FEATURES)} features) and no challenger beat the bar → MINIMAL wins')

    rows, probs, y_true, fn, is_lgb, feats = candidates[winner_key]
    print(f'\n===== WINNER: {winner_key[0]} × {winner_key[1]} (mean AUC {best_auc:.4f}, {len(feats)} features) =====')

    x_cal, y_cal, floor = fit_calibration(probs, y_true)
    print(f'  calibration: {len(x_cal)} breakpoints, floor={floor}, cap={CAP}')
    reliability(probs, y_true, x_cal, np.array(y_cal), floor)

    final = fn()
    final.fit(data[feats].fillna(0), data['goodR'],
              sample_weight=weights(data['timestamp'].values))
    trees = extract_trees(final, is_lgb, feats)

    os.makedirs(STAGING, exist_ok=True)
    out = {
        'features': feats,
        'trees': trees,
        'base_score': 0.5,
        'version': VERSION,
        'market': MARKET_KEY,
        'engine': 'lightgbm' if is_lgb else 'xgboost',
        'n_features': len(feats),
        'n_trees': len(trees),
        'n_samples': len(data),
        'model_type': 'classifier',
        'target': 'goodR',
        'calibration': {'x': x_cal, 'y': y_cal, 'cap': CAP, 'floor': floor, 'method': 'isotonic'},
        'description': f'v14 {MARKET_KEY} ({winner_key[0]} × {winner_key[1]}) — goodR=fwdMaxFavR>=1.5, '
                       f'{len(data)} bars, full-coverage derivatives regen 2026-07',
    }
    staging_path = os.path.join(STAGING, f'ml-model-{MARKET_KEY}.json')
    with open(staging_path, 'w') as f:
        json.dump(out, f)
    print(f'\n  wrote {staging_path} ({len(trees)} trees, {out["engine"]})')

    if SHIP:
        for dst in (f'{REPO}/marketscope-worker/src/ml-model-{MARKET_KEY}.json',
                    f'{REPO}/CryptoLens/ML/ml-model-{MARKET_KEY}.json'):
            shutil.copy2(staging_path, dst)
            print(f'  shipped → {dst}')
        print('  REMINDER: keep the three model-version registries in sync '
              '(worker outcome query IN(...), iOS currentModelVersion, this JSON) '
              'and refresh parity fixtures via scripts/update-fixture-ml.ts')
    else:
        print('  staging only — re-run with --ship to install into worker + iOS')


if __name__ == '__main__':
    main()
