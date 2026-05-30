#!/usr/bin/env python3
"""
Phase 2 — conformal abstention.

Phase 1 showed thresholding the calibrated meta-prob works; Phase 2 makes the
threshold *principled*: pick the smallest cutoff such that the selected set's
win-rate clears a target with a finite-sample lower-confidence guarantee
(Wilson 90% LB) — i.e. selective risk control. Adds regime-conditional cutoffs
and validates on the frozen holdout that the guarantee actually holds.

Output per market: global + per-regime conformal thresholds (the `conformal`
block for the model JSON), and the holdout scorecard of the abstaining gate vs
the trade-everything baseline.

Run:  python3 phase2_conformal.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')
P1F = __import__('phase1_final')

# Target tradeable-win rate on the SELECTED set (well above the 0.40 breakeven of
# 1.5/1.0 R:R). Per market because stock setups are structurally weaker.
TARGET = {'crypto': 0.60, 'stock': 0.50}
Z90 = 1.2816  # one-sided 90%


def wilson_lb(k, n, z=Z90):
    if n == 0:
        return 0.0
    p = k / n
    d = 1 + z * z / n
    centre = p + z * z / (2 * n)
    half = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre - half) / d


def find_threshold(prob, win, target, min_n=100):
    """Smallest tau s.t. Wilson-LB of win-rate among {prob >= tau} >= target."""
    order = np.argsort(prob)
    prob_s, win_s = prob[order], win[order]
    best = None
    for tau in np.unique(np.round(prob_s, 3)):
        sel = prob >= tau
        n = int(sel.sum())
        if n < min_n:
            continue
        lb = wilson_lb(int(win[sel].sum()), n)
        if lb >= target:
            best = float(tau)
            break
    return best


def calibrated_frames(market):
    """Selection OOF + holdout, both with calibrated metaProb + tbWin + regimeCode."""
    df, idx = H.load_market(market)
    df = P1.add_labels(df)
    sel, hold, boundary = H.split_holdout(df)
    hold = P1.add_labels(hold)
    val = P1F.wf(sel)
    oof = val[val['tradeDir'] != 0]
    iso = P1F.fit_cal(oof['metaRaw'].values, oof['tbWin'].values)
    val['metaProb'] = P1F.apply_cal(iso, val['metaRaw'].values)
    # final models on all selection → holdout
    mq = H.make_model(); mq.fit(sel[H.FEATURES].fillna(0), sel['goodR'])
    trm = sel[sel['tradeDir'] != 0]
    mm = H.make_model(); mm.fit(trm[P1F.META_FEATURES].fillna(0), trm['tbWin'])
    hv = hold.copy()
    hv['mlProb'] = mq.predict_proba(hv[H.FEATURES].fillna(0))[:, 1]
    hv['metaRaw'] = mm.predict_proba(hv[P1F.META_FEATURES].fillna(0))[:, 1]
    hv['metaProb'] = P1F.apply_cal(iso, hv['metaRaw'].values)
    return val, hv, idx, boundary


def report_gate(name, frame, idx, tau, tau_regime):
    """Apply abstention (global tau, then regime-conditional) and resolve EV."""
    f = frame[frame['tradeDir'] != 0].copy()
    # global
    g = f[f['metaProb'] >= tau]
    Rg = H._resolve(g, idx, H.dir_union)
    # regime-conditional
    keep = np.zeros(len(f), dtype=bool)
    rc = f['regimeCode'].fillna(-1).values
    mp = f['metaProb'].values
    for code, t in tau_regime.items():
        if t is None:
            continue
        keep |= (rc == code) & (mp >= t)
    Rr = H._resolve(f[keep], idx, H.dir_union)
    base = H._resolve(f, idx, H.dir_union)
    def line(lbl, R, n_all):
        if len(R) == 0:
            print(f"    {lbl:<26} n=0 (full abstention)"); return
        print(f"    {lbl:<26} n={len(R):>6,} ({len(R)/max(1,n_all)*100:>4.1f}% traded)  "
              f"win={(R['R']>0).mean()*100:>4.1f}%  EV={R['R'].mean():>+6.3f}R  totalR={R['R'].sum():>+8.1f}")
    n_all = len(f)
    print(f"  [{name}]")
    line("trade-all (no abstain)", base, n_all)
    line(f"global tau={tau}", Rg, n_all)
    line("regime-conditional tau", Rr, n_all)


def run(market):
    print(f"\n{'='*88}\n{market.upper()}  (target win-rate >= {TARGET[market]}, Wilson 90% LB)\n{'='*88}")
    val, hv, idx, boundary = calibrated_frames(market)
    cal = val[val['tradeDir'] != 0]
    tau = find_threshold(cal['metaProb'].values, cal['tbWin'].values, TARGET[market])
    tau_regime = {}
    for code in sorted(cal['regimeCode'].dropna().unique()):
        sub = cal[cal['regimeCode'] == code]
        tau_regime[int(code)] = find_threshold(sub['metaProb'].values, sub['tbWin'].values, TARGET[market])
    print(f"  conformal thresholds (fit on selection OOF):  global tau={tau}  "
          f"per-regime={ {k: (round(v,3) if v else None) for k,v in tau_regime.items()} }")
    print(f"\n  -- HOLDOUT EXAM (>= {pd.to_datetime(boundary,unit='s').date()}) --")
    report_gate('holdout', hv, idx, tau if tau else 1.01, tau_regime)
    H.save_result('phase2_conformal', market, dict(
        target=TARGET[market], global_tau=tau,
        per_regime_tau={str(k): v for k, v in tau_regime.items()}))


def main():
    for mk in ('crypto', 'stock'):
        run(mk)
    print(f"\nsaved to {H.RESULTS_PATH}")


if __name__ == '__main__':
    main()
