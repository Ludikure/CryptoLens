#!/usr/bin/env python3
"""
Phase 0 — experiment harness + frozen holdout + standardized scorecard.

Every later phase imports from here so experiments are compared apples-to-apples
against the v11/v13 baseline on the SAME clean split, and the frozen holdout is
never touched during model selection. See ML_ENHANCEMENTS_PLAN.md.

Public API:
    load_market(market)                       -> (df, candle_idx)
    split_holdout(df)                         -> (selection_df, holdout_df, boundary_ts)
    wf_selection(selection_df)                -> val frame with mlProb + prevMl (clean WF)
    scorecard(val_frame, candle_idx, ...)     -> dict (the standard metric bundle)
    save_result(name, market, sc)             -> append to phase_results.json

Selection rule (non-negotiable): only `selection_df` may feed model fitting or
hyperparameter/threshold choices. `holdout_df` is run ONCE at the end of a phase.

Run directly to (re)establish the baseline scorecard + sanity-check the harness:
    python3 _harness.py
"""
import json
import os

import numpy as np
import pandas as pd

ev = __import__('edge_validation')
rev = __import__('edge_revalidate')

FEATURES = ev.FEATURES
load_features = ev.load_features
build_candle_index = ev.build_candle_index
make_model = ev.make_model
resolve_fill = ev.resolve_fill
dir_union = rev.dir_union
dir_dstoch = rev.dir_dstoch
dir_bias = rev.dir_bias

HOLDOUT_MONTHS = 6
ML_RISING = 0.70
SL_ATR, TP_ATR, HORIZON = 1.0, 1.5, 6
RESULTS_PATH = os.path.join(os.path.dirname(__file__), 'phase_results.json')

MARKETS = {
    'crypto': dict(csv_dir='csv_exports_v11', candles='crypto_candles_4h.csv.gz', sym=None),
    'stock':  dict(csv_dir='csv_exports_v13', candles='stock_candles_4h.csv.gz', sym=None),
}


def load_market(market):
    m = MARKETS[market]
    base = os.path.dirname(__file__)
    df = load_features(os.path.join(base, m['csv_dir']), m['sym'])
    idx = build_candle_index(os.path.join(base, m['candles']), m['sym'])
    return df, idx


def split_holdout(df):
    """Reserve the most recent HOLDOUT_MONTHS as a frozen holdout. Only the
    returned `selection` frame may ever inform model/threshold choices."""
    t_hi = df['timestamp'].max()
    boundary = t_hi - HOLDOUT_MONTHS * 30.44 * 86400
    selection = df[df['timestamp'] < boundary].copy()
    holdout = df[df['timestamp'] >= boundary].copy()
    return selection, holdout, boundary


def wf_selection(selection_df):
    """Clean multi-fold WF (timestamp split + time embargo, folds span the 2022
    bear) on SELECTION data only. Returns val frame with mlProb + prevMl."""
    val = rev.wf_clean(selection_df)
    val = val.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    val['prevMl'] = val.groupby('symbol')['mlProb'].shift(1)
    return val


def _resolve(rising, idx, dir_fn, sl=SL_ATR, tp=TP_ATR):
    rows = []
    for _, r in rising.iterrows():
        d = dir_fn(r)
        if d == 0:
            continue
        sym = r['symbol']
        if sym not in idx:
            continue
        ap = r['atrPercent']
        if ap <= 0:
            continue
        entry = r['price']
        atrp = entry * ap / 100.0
        if d == 1:
            slp, tpp = entry - atrp * sl, entry + atrp * tp
        else:
            slp, tpp = entry + atrp * sl, entry - atrp * tp
        c = idx[sym]
        i = np.searchsorted(c['ts'], r['ts_ms'], side='right')
        if i >= len(c['ts']):
            continue
        block = {k: c[k][i:i + HORIZON] for k in ('open', 'high', 'low', 'close')}
        if len(block['high']) == 0:
            continue
        res = resolve_fill(d, entry, slp, tpp, block, sl, tp)
        if res is None:
            continue
        rows.append({'symbol': sym, 'direction': d, 'R': res, 'timestamp': r['timestamp'],
                     'mlProb': r['mlProb'], 'goodR': int(r['goodR'])})
    return pd.DataFrame(rows)


def _buckets(val):
    """Calibration of the quality head: predicted ML bucket -> actual goodR rate."""
    out = {}
    for lo, hi in [(0.0, 0.30), (0.30, 0.50), (0.50, 0.60), (0.60, 0.70), (0.70, 0.85), (0.85, 1.01)]:
        m = (val['mlProb'] >= lo) & (val['mlProb'] < hi)
        n = int(m.sum())
        out[f'[{lo:.2f},{hi:.2f})'] = dict(n=n, actual=(float(val.loc[m, 'goodR'].mean()) if n else None))
    return out


def scorecard(val, idx, dir_fn=dir_union, label='exp'):
    """THE standard metric bundle. `val` must have mlProb + prevMl + goodR.
    Headline = EV/trade (R) on rising-edge ML through 0.70 in `dir_fn` direction,
    plus per-bucket precision, coverage, and per-quarter (regime) EV."""
    rising = val[(val['prevMl'] < ML_RISING) & (val['mlProb'] >= ML_RISING)].copy()
    res = _resolve(rising, idx, dir_fn)
    n = len(res)
    sc = dict(label=label, n=int(n),
              win=float((res['R'] > 0).mean() * 100) if n else 0.0,
              ev=float(res['R'].mean()) if n else 0.0,
              totalR=float(res['R'].sum()) if n else 0.0,
              coverage_pct=float(n / max(1, len(val)) * 100),
              buckets=_buckets(val))
    if n:
        res = res.copy()
        res['q'] = pd.to_datetime(res['timestamp'], unit='s').dt.to_period('Q').astype(str)
        sc['per_quarter'] = {q: dict(n=int(len(g)), ev=float(g['R'].mean()))
                             for q, g in res.groupby('q')}
    return sc


def save_result(name, market, sc):
    data = {}
    if os.path.exists(RESULTS_PATH):
        data = json.load(open(RESULTS_PATH))
    data.setdefault(name, {})[market] = sc
    json.dump(data, open(RESULTS_PATH, 'w'), indent=2)


def run_baseline():
    """Establish the v11/v13 baseline scorecard on SELECTION data (holdout reserved)
    and sanity-check that the harness reproduces the known direction-primitive edge."""
    for market in ('stock', 'crypto'):
        df, idx = load_market(market)
        selection, holdout, boundary = split_holdout(df)
        b_dt = pd.to_datetime(boundary, unit='s').date()
        print(f"\n{'='*78}\n{market.upper()}  bars={len(df):,}  "
              f"selection={len(selection):,}  holdout={len(holdout):,} (>= {b_dt})\n{'='*78}")
        val = wf_selection(selection)
        for dname, dfn in [('union', dir_union), ('dStoch', dir_dstoch), ('bias', dir_bias)]:
            sc = scorecard(val, idx, dfn, label=f'baseline-{dname}')
            print(f"  {dname:<7} n={sc['n']:>6,}  win={sc['win']:>4.1f}%  "
                  f"EV={sc['ev']:>+6.3f}R  totalR={sc['totalR']:>+9.1f}  cov={sc['coverage_pct']:.1f}%")
            if dname == 'union':
                save_result('baseline', market, sc)
        top = val['mlProb'].between(0.70, 0.85)
        print(f"  quality top-bucket [0.70,0.85): n={int(top.sum()):,}  "
              f"actual goodR={val.loc[top,'goodR'].mean()*100:.1f}%  (calibration check)")


if __name__ == '__main__':
    run_baseline()
    print(f"\nbaseline scorecard saved to {RESULTS_PATH}")
