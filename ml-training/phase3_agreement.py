#!/usr/bin/env python3
"""
Phase 3 (offline-validatable core) — direction agreement / self-consistency.

The LLM self-consistency idea = run the directional thesis N times and only act
when they agree. Its measurable essence: does requiring INDEPENDENT direction
signals to agree improve precision on top of the conformal meta gate? This also
quantifies the "priority alert tier" (bias + Stoch + MACD all agree) the docs
flagged as untested.

On the frozen holdout, starting from the Phase 2 conformal-confident set, layer
agreement filters and measure EV/trade, win%, coverage. If agreement adds
precision beyond what the meta head already captures, the LLM self-consistency
pass is worth building; if it's redundant, the meta head already does the job.

The LLM-specific pieces (multi-sample thesis, adversarial critic) can only be
validated live (A/B via OutcomeTracker) — designed in PHASE3_RESULTS.md, not
shipped blind.

Run:  python3 phase3_agreement.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P2 = __import__('phase2_conformal')


def dirs(f):
    a = f['biasAlignment'].values
    biasDir = np.where(a == 'aligned_bullish', 1, np.where(a == 'aligned_bearish', -1, 0))
    dStoch = f['dStochCross'].fillna(0).values
    hStoch = f['hStochCross'].fillna(0).values
    dMacd = f['dMacdCross'].fillna(0).values
    return biasDir, dStoch.astype(int), hStoch.astype(int), dMacd.astype(int)


def ev(R):
    if len(R) == 0:
        return None
    return dict(n=len(R), win=(R['R'] > 0).mean() * 100, ev=R['R'].mean(), totalR=R['R'].sum())


def line(lbl, R, n_base):
    e = ev(R)
    if e is None:
        print(f"    {lbl:<34} n=0"); return
    print(f"    {lbl:<34} n={e['n']:>6,} ({e['n']/max(1,n_base)*100:>4.1f}% of confident)  "
          f"win={e['win']:>4.1f}%  EV={e['ev']:>+6.3f}R  totalR={e['totalR']:>+8.1f}")


def run(market='crypto'):
    print(f"\n{'='*86}\n{market.upper()} — agreement on top of conformal meta gate (holdout)\n{'='*86}")
    val, hv, idx, boundary = P2.calibrated_frames(market)
    cal = val[val['tradeDir'] != 0]
    tau = P2.find_threshold(cal['metaProb'].values, cal['tbWin'].values, P2.TARGET[market])
    if tau is None:
        print(f"  no conformal threshold for {market} (abstains) — agreement N/A"); return
    conf = hv[(hv['tradeDir'] != 0) & (hv['metaProb'] >= tau)].copy()
    biasDir, dStoch, hStoch, dMacd = dirs(conf)
    td = conf['tradeDir'].values
    n_base = len(conf)
    print(f"  conformal-confident holdout set: n={n_base:,} (tau={tau:.3f})\n")

    base = H._resolve(conf, idx, H.dir_union)
    line("conformal only (Phase 2)", base, n_base)

    # bias & dStoch agree (both fire, same direction)
    m = (biasDir != 0) & (dStoch != 0) & (biasDir == dStoch)
    line("+ bias & dStoch agree", H._resolve(conf[m], idx, H.dir_union), n_base)

    # dStoch & hStoch agree (multi-timeframe stoch)
    m = (dStoch != 0) & (hStoch != 0) & (dStoch == hStoch)
    line("+ dStoch & hStoch agree (MTF)", H._resolve(conf[m], idx, H.dir_union), n_base)

    # triple: bias & dStoch & dMacd all agree (the 'priority alert tier')
    m = (biasDir != 0) & (dStoch != 0) & (dMacd != 0) & (biasDir == dStoch) & (dStoch == dMacd)
    line("+ triple agree (bias+dStoch+dMacd)", H._resolve(conf[m], idx, H.dir_union), n_base)

    H.save_result('phase3_agreement', market, dict(conformal_tau=tau, confident_n=int(n_base)))


def main():
    run('crypto')
    print(f"\nsaved to {H.RESULTS_PATH}")


if __name__ == '__main__':
    main()
