#!/usr/bin/env python3
"""
Phase 4 — context features: market breadth + weekly trend.

Hypothesis: setups fire better/worse depending on the broad backdrop the current
111 point-in-time features don't capture. Add cross-sectional + higher-TF context:
  breadth50/200  — fraction of the universe above its trailing 50/200-bar (4H) MA
  breadthDelta   — change in breadth over the last 6 bars
  weeklyDist     — price vs its 42-bar (~1wk) MA
  weeklyMom      — 42-bar return

All trailing (no lookahead). Ablation: retrain the meta-model with vs without
context, compare conformal-gated EV/trade on the frozen holdout. Keep only if it
adds EV.

Run:  python3 phase4_context.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')
P2 = __import__('phase2_conformal')

CONTEXT = ['breadth50', 'breadth200', 'breadthDelta', 'weeklyDist', 'weeklyMom']


def compute_context(market):
    """Build (symbol,timestamp)->context from the candle file. Breadth is market-
    wide (one value per timestamp); weekly is per symbol. All trailing."""
    m = H.MARKETS[market]
    import os
    c = pd.read_csv(os.path.join(os.path.dirname(__file__), m['candles']))
    c = c.sort_values(['symbol', 'timestamp'])
    close = c.pivot_table(index='timestamp', columns='symbol', values='close')
    ma50 = close.rolling(50, min_periods=25).mean()
    ma200 = close.rolling(200, min_periods=100).mean()
    breadth50 = (close > ma50).mean(axis=1)
    breadth200 = (close > ma200).mean(axis=1)
    breadth_df = pd.DataFrame({'timestamp': breadth50.index,
                               'breadth50': breadth50.values,
                               'breadth200': breadth200.values})
    breadth_df['breadthDelta'] = breadth_df['breadth50'] - breadth_df['breadth50'].shift(6)
    # weekly per symbol
    wma = close.rolling(42, min_periods=21).mean()
    weeklyDist = (close / wma - 1.0)
    weeklyMom = (close / close.shift(42) - 1.0)
    wk = (weeklyDist.reset_index().melt(id_vars='timestamp', var_name='symbol', value_name='weeklyDist')
          .merge(weeklyMom.reset_index().melt(id_vars='timestamp', var_name='symbol', value_name='weeklyMom'),
                 on=['timestamp', 'symbol']))
    return breadth_df, wk


def merge_ctx(df, breadth_df, wk):
    df = df.merge(breadth_df, on='timestamp', how='left')
    df = df.merge(wk, on=['timestamp', 'symbol'], how='left')
    for col in CONTEXT:
        df[col] = df[col].fillna(0.0)
    return df


def wf_meta(selection, feats):
    """5-fold WF training the meta-model on `feats`; returns OOF metaRaw + tbWin."""
    t = selection['timestamp'].values
    t_lo, t_hi = t.min(), t.max()
    span = t_hi - t_lo
    out = []
    for i in range(5):
        lo = t_lo + span * (0.25 + i * 0.15)
        hi = t_lo + span * (0.25 + (i + 1) * 0.15) if i < 4 else t_hi + 1
        train = selection[selection['timestamp'] < lo - 14 * 86400]
        val = selection[(selection['timestamp'] >= lo) & (selection['timestamp'] < hi)].copy()
        if len(train) < 5000 or len(val) < 200:
            continue
        trm = train[train['tradeDir'] != 0]
        mm = H.make_model(); mm.fit(trm[feats].fillna(0), trm['tbWin'])
        val['metaRaw'] = mm.predict_proba(val[feats].fillna(0))[:, 1]
        out.append(val)
    return pd.concat(out, ignore_index=True)


def holdout_eval(selection, holdout, idx, feats, target):
    from sklearn.isotonic import IsotonicRegression
    val = wf_meta(selection, feats)
    oof = val[val['tradeDir'] != 0]
    iso = IsotonicRegression(out_of_bounds='clip'); iso.fit(oof['metaRaw'], oof['tbWin'])
    cal_prob = np.minimum(iso.predict(oof['metaRaw']), 0.90)
    tau = P2.find_threshold(cal_prob, oof['tbWin'].values, target)
    trm = selection[selection['tradeDir'] != 0]
    mm = H.make_model(); mm.fit(trm[feats].fillna(0), trm['tbWin'])
    hv = holdout[holdout['tradeDir'] != 0].copy()
    raw = mm.predict_proba(hv[feats].fillna(0))[:, 1]
    hv['metaProb'] = np.minimum(iso.predict(raw), 0.90)
    hv['mlProb'] = hv['metaProb']  # _resolve carries this column; not used in resolution
    if tau is None:
        return dict(tau=None, n=0, win=0, ev=0)
    sel = hv[hv['metaProb'] >= tau]
    R = H._resolve(sel, idx, H.dir_union)
    if len(R) == 0:
        return dict(tau=tau, n=0, win=0, ev=0)
    return dict(tau=float(tau), n=len(R), win=float((R['R'] > 0).mean() * 100),
                ev=float(R['R'].mean()), totalR=float(R['R'].sum()))


def run(market):
    print(f"\n{'='*84}\n{market.upper()} — context-feature ablation (conformal-gated holdout)\n{'='*84}")
    df, idx = H.load_market(market)
    df = P1.add_labels(df)
    breadth_df, wk = compute_context(market)
    df = merge_ctx(df, breadth_df, wk)
    sel, hold, b = H.split_holdout(df)
    print(f"  selection={len(sel):,} holdout={len(hold):,}  context computed")
    base = H.FEATURES + ['tradeDir']
    target = P2.TARGET[market]
    r0 = holdout_eval(sel, hold, idx, base, target)
    r1 = holdout_eval(sel, hold, idx, base + CONTEXT, target)
    def show(lbl, r):
        if r['n'] == 0:
            print(f"  {lbl:<26} tau={r['tau']}  n=0 (abstains)"); return
        print(f"  {lbl:<26} tau={r['tau']:.3f}  n={r['n']:>6,}  win={r['win']:>4.1f}%  "
              f"EV={r['ev']:>+6.3f}R  totalR={r['totalR']:>+8.1f}")
    show("baseline (111 feats)", r0)
    show("+ context (breadth+weekly)", r1)
    if r0['n'] and r1['n']:
        print(f"  => context delta: {r1['ev']-r0['ev']:+.3f}R/trade")
    H.save_result('phase4_context', market, dict(baseline_ev=r0.get('ev'), context_ev=r1.get('ev')))


def main():
    for mk in ('crypto', 'stock'):
        run(mk)
    print(f"\nsaved to {H.RESULTS_PATH}")


if __name__ == '__main__':
    main()
