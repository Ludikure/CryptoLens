#!/usr/bin/env python3
"""
Phase 1 finisher — completes the experimental case:
  1. Isotonic-CALIBRATE the meta head (fixes the stock probability compression).
  2. QUANTILE head (1c): predict fwdMaxFavR p50/p75/p90 → adaptive TP2; compare
     to the fixed crypto runner (3.0 ATR) via composite execution.
  3. FROZEN-HOLDOUT EXAM: train on all selection, evaluate the calibrated meta
     gate on the never-seen holdout vs the goodR baseline. The honest verdict.

Calibration is fit on selection OUT-OF-FOLD predictions (production methodology),
then frozen and applied to the holdout. No holdout leakage.

Run:  python3 phase1_final.py
"""
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression

H = __import__('_harness')
cbt = __import__('composite_band_backtest')
P1 = __import__('phase1_meta')

FEATURES = H.FEATURES
META_FEATURES = FEATURES + ['tradeDir']
EMBARGO = 14 * 86400
META_CAP = 0.90
SL_ATR, TP1_ATR = 2.0, 1.5   # crypto composite config (matches shipped)


def make_quantile(alpha):
    return xgb.XGBRegressor(objective='reg:quantileerror', quantile_alpha=alpha,
                            max_depth=5, n_estimators=100, learning_rate=0.03,
                            subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
                            reg_alpha=0.1, reg_lambda=1.0, random_state=42)


def wf(selection, want_quantile=False):
    """5-fold clean WF on selection. Returns val with mlProb, metaRaw, (q75)."""
    t = selection['timestamp'].values
    t_lo, t_hi = t.min(), t.max()
    span = t_hi - t_lo
    out = []
    for i in range(5):
        lo = t_lo + span * (0.25 + i * 0.15)
        hi = t_lo + span * (0.25 + (i + 1) * 0.15) if i < 4 else t_hi + 1
        train = selection[selection['timestamp'] < lo - EMBARGO]
        val = selection[(selection['timestamp'] >= lo) & (selection['timestamp'] < hi)].copy()
        if len(train) < 5000 or len(val) < 200:
            continue
        mq = H.make_model(); mq.fit(train[FEATURES].fillna(0), train['goodR'])
        val['mlProb'] = mq.predict_proba(val[FEATURES].fillna(0))[:, 1]
        trm = train[train['tradeDir'] != 0]
        mm = H.make_model(); mm.fit(trm[META_FEATURES].fillna(0), trm['tbWin'])
        val['metaRaw'] = mm.predict_proba(val[META_FEATURES].fillna(0))[:, 1]
        if want_quantile:
            qm = make_quantile(0.75); qm.fit(train[FEATURES].fillna(0), train['fwdMaxFavR'])
            val['q75'] = qm.predict(val[FEATURES].fillna(0))
        out.append(val)
    val = pd.concat(out, ignore_index=True).sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    return val


def fit_cal(raw, y):
    iso = IsotonicRegression(out_of_bounds='clip'); iso.fit(raw, y)
    return iso


def apply_cal(iso, raw):
    return np.minimum(iso.predict(raw), META_CAP)


def scen(val, idx, label):
    """A/B/C scenarios using CALIBRATED metaProb already on val."""
    val = val.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    val['prevMl'] = val.groupby('symbol')['mlProb'].shift(1)
    val['prevMeta'] = val.groupby('symbol')['metaProb'].shift(1)
    re = val[(val['prevMl'] < 0.70) & (val['mlProb'] >= 0.70) & (val['tradeDir'] != 0)]
    A = P1._ev(H._resolve(re, idx, H.dir_union))
    print(f"  [{label}] A baseline goodR : n={A['n']:>6,} win={A['win']:>4.1f}% EV={A['ev']:>+6.3f}R totalR={A['totalR']:>+9.1f}")
    for t in (0.55, 0.60, 0.65):
        B = P1._ev(H._resolve(re[re['metaProb'] >= t], idx, H.dir_union))
        cm = (val['prevMeta'] < t) & (val['metaProb'] >= t) & (val['tradeDir'] != 0)
        C = P1._ev(H._resolve(val[cm], idx, H.dir_union))
        print(f"  [{label}] meta@{t}      : filter n={B['n']:>6,} EV={B['ev']:>+6.3f}R totR={B['totalR']:>+8.1f}"
              f"  | primary n={C['n']:>6,} EV={C['ev']:>+6.3f}R totR={C['totalR']:>+8.1f}")
    return A


def quantile_adaptive_tp2(val, idx):
    """Crypto only: for meta-selected trades, set TP2 = clip(q75, 2.0, 5.0) and
    run composite execution; compare blended EV to fixed TP2 = 3.0 ATR."""
    val = val.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    val['prevMeta'] = val.groupby('symbol')['metaProb'].shift(1)
    sel = val[(val['prevMeta'] < 0.60) & (val['metaProb'] >= 0.60) & (val['tradeDir'] != 0)]
    fixed, adaptive = [], []
    for _, r in sel.iterrows():
        d = int(r['tradeDir']); sym = r['symbol']
        if sym not in idx or r['atrPercent'] <= 0:
            continue
        entry = r['price']; atrp = entry * r['atrPercent'] / 100.0
        c = idx[sym]; i = np.searchsorted(c['ts'], r['ts_ms'], side='right')
        if i >= len(c['ts']):
            continue
        block = {k: c[k][i:i + cbt.HORIZON] for k in ('high', 'low', 'close')}
        if len(block['high']) == 0:
            continue
        rf = cbt.resolve_composite(d, entry, atrp, block, SL_ATR, TP1_ATR, 3.0)
        tp2 = float(np.clip(r['q75'], 2.0, 5.0))
        ra = cbt.resolve_composite(d, entry, atrp, block, SL_ATR, TP1_ATR, tp2)
        if rf is not None: fixed.append(rf)
        if ra is not None: adaptive.append(ra)
    print(f"\n  Quantile adaptive TP2 (crypto, meta@0.60, n={len(fixed):,}):")
    print(f"    fixed TP2=3.0 ATR : blended EV {np.mean(fixed):+.4f}R")
    print(f"    adaptive TP2=q75  : blended EV {np.mean(adaptive):+.4f}R  "
          f"({np.mean(adaptive)-np.mean(fixed):+.4f}R, median TP2={np.median(np.clip(sel['q75'],2,5)):.2f} ATR)")


def run(market):
    print(f"\n{'='*86}\n{market.upper()}\n{'='*86}")
    df, idx = H.load_market(market)
    df = P1.add_labels(df)
    selection, holdout, boundary = H.split_holdout(df)
    holdout = P1.add_labels(holdout)
    print(f"  selection={len(selection):,}  holdout={len(holdout):,} (>= {pd.to_datetime(boundary,unit='s').date()})")

    # WF on selection → OOF raw meta preds → fit calibrator
    val = wf(selection, want_quantile=(market == 'crypto'))
    oof = val[val['tradeDir'] != 0]
    iso = fit_cal(oof['metaRaw'].values, oof['tbWin'].values)
    val['metaProb'] = apply_cal(iso, val['metaRaw'].values)
    print("\n  -- SELECTION (calibrated meta) --")
    scen(val, idx, 'sel')
    if market == 'crypto':
        quantile_adaptive_tp2(val, idx)

    # HOLDOUT EXAM: train on ALL selection, freeze calibrator, evaluate on holdout
    mq = H.make_model(); mq.fit(selection[FEATURES].fillna(0), selection['goodR'])
    trm = selection[selection['tradeDir'] != 0]
    mm = H.make_model(); mm.fit(trm[META_FEATURES].fillna(0), trm['tbWin'])
    hv = holdout.copy()
    hv['mlProb'] = mq.predict_proba(hv[FEATURES].fillna(0))[:, 1]
    hv['metaRaw'] = mm.predict_proba(hv[META_FEATURES].fillna(0))[:, 1]
    hv['metaProb'] = apply_cal(iso, hv['metaRaw'].values)
    print("\n  -- HOLDOUT EXAM (never-seen, calibrator frozen on selection) --")
    A = scen(hv, idx, 'HOLDOUT')
    H.save_result('phase1_final', market, dict(holdout_baseline_ev=A['ev'], holdout_baseline_n=A['n']))


def main():
    for mk in ('stock', 'crypto'):
        run(mk)
    print(f"\nsaved to {H.RESULTS_PATH}")


if __name__ == '__main__':
    main()
