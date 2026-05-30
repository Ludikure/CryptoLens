#!/usr/bin/env python3
"""
Phase 5 — direction enhancements: path / sequence features.

Direction is the ~50/50 weak spot. Point-in-time features miss path SHAPE
(trend cleanliness, exhaustion, compression-then-expansion). Add path features and
ablate on the conformal-gated holdout (same harness as Phase 4):
  efficiencyRatio10 — |net move| / sum|bar moves| over 10 bars (Kaufman; trend cleanliness)
  runLength         — signed count of consecutive same-direction closes
  volRatio          — short vol / long vol (compression vs expansion)
  rangePosition     — where close sits in the trailing 20-bar range [0,1]

Honest prior (plan: high risk): the 111 features already include momentum deltas,
acceleration, and bodyWickRatio, so path features may be redundant. Test + keep
only if they add EV.

Also checks regime-conditional direction: does the dStoch EV vary enough by
regimeCode that per-regime handling helps? (Phase 2 already saw per-regime tau
collapse to global — suggesting regime is captured.)

Run:  python3 phase5_direction.py
"""
import os

import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')
P2 = __import__('phase2_conformal')
P4 = __import__('phase4_context')

PATH = ['efficiencyRatio10', 'runLength', 'volRatio', 'rangePosition']


def compute_path(market):
    m = H.MARKETS[market]
    c = pd.read_csv(os.path.join(os.path.dirname(__file__), m['candles'])).sort_values(['symbol', 'timestamp'])
    close = c.pivot_table(index='timestamp', columns='symbol', values='close')
    diff = close.diff()
    net = (close - close.shift(10)).abs()
    gross = diff.abs().rolling(10, min_periods=5).sum()
    eff = (net / gross.replace(0, np.nan))
    sign = np.sign(diff)
    # signed run length: cumulative consecutive same-sign closes
    runlen = sign.copy()
    for col in runlen.columns:
        s = sign[col].fillna(0).values
        out = np.zeros(len(s)); run = 0; prev = 0
        for i, v in enumerate(s):
            if v != 0 and v == prev:
                run += v
            elif v != 0:
                run = v
            else:
                run = 0
            out[i] = run; prev = v if v != 0 else prev
        runlen[col] = out
    volS = diff.rolling(6, min_periods=3).std()
    volL = diff.rolling(48, min_periods=24).std()
    volRatio = (volS / volL.replace(0, np.nan))
    rmax = close.rolling(20, min_periods=10).max()
    rmin = close.rolling(20, min_periods=10).min()
    rangePos = ((close - rmin) / (rmax - rmin).replace(0, np.nan))

    def melt(dfm, name):
        return dfm.reset_index().melt(id_vars='timestamp', var_name='symbol', value_name=name)
    out = melt(eff, 'efficiencyRatio10')
    for dfm, nm in [(runlen, 'runLength'), (volRatio, 'volRatio'), (rangePos, 'rangePosition')]:
        out = out.merge(melt(dfm, nm), on=['timestamp', 'symbol'])
    return out


def run(market):
    print(f"\n{'='*84}\n{market.upper()} — path/sequence ablation (conformal-gated holdout)\n{'='*84}")
    df, idx = H.load_market(market)
    df = P1.add_labels(df)
    path = compute_path(market)
    df = df.merge(path, on=['timestamp', 'symbol'], how='left')
    for col in PATH:
        df[col] = df[col].fillna(0.0)
    sel, hold, b = H.split_holdout(df)
    print(f"  selection={len(sel):,} holdout={len(hold):,}  path features computed")
    base = H.FEATURES + ['tradeDir']
    target = P2.TARGET[market]
    r0 = P4.holdout_eval(sel, hold, idx, base, target)
    r1 = P4.holdout_eval(sel, hold, idx, base + PATH, target)

    def show(lbl, r):
        if r['n'] == 0:
            print(f"  {lbl:<26} tau={r['tau']}  n=0 (abstains)"); return
        print(f"  {lbl:<26} tau={r['tau']:.3f}  n={r['n']:>6,}  win={r['win']:>4.1f}%  "
              f"EV={r['ev']:>+6.3f}R  totalR={r['totalR']:>+8.1f}")
    show("baseline (111 feats)", r0)
    show("+ path/sequence", r1)
    if r0['n'] and r1['n']:
        print(f"  => path delta: {r1['ev']-r0['ev']:+.3f}R/trade")

    # regime-conditional direction check (crypto): dStoch EV per regimeCode
    if market == 'crypto':
        h = hold[hold['tradeDir'] != 0].copy()
        h['mlProb'] = 0.0
        print("\n  Regime-conditional direction (holdout dStoch EV by regimeCode):")
        for code in sorted(h['regimeCode'].dropna().unique()):
            sub = h[h['regimeCode'] == code]
            R = H._resolve(sub, idx, H.dir_dstoch)
            if len(R):
                print(f"    regime {int(code)}: n={len(R):>6,}  EV={R['R'].mean():>+6.3f}R  win={(R['R']>0).mean()*100:.1f}%")
    H.save_result('phase5_direction', market, dict(baseline_ev=r0.get('ev'), path_ev=r1.get('ev')))


def main():
    for mk in ('crypto', 'stock'):
        run(mk)
    print(f"\nsaved to {H.RESULTS_PATH}")


if __name__ == '__main__':
    main()
