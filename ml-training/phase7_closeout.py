#!/usr/bin/env python3
"""
Phase 7 — closeout: end-to-end holdout scorecard.

Puts the whole journey into one before/after on the frozen holdout, crypto,
using the realistic composite execution (50% at TP1, BE-trail, runner to TP2):

  PRODUCTION  : rising-edge goodR>=0.70 + union direction, fixed TP2 = 3.0 ATR
  ENHANCED    : conformal meta gate (Phase 2) + union direction, adaptive TP2 =
                clip(predicted q75, 2, 5) ATR (Phase 1c quantile head)

Archetype x regime gating (7a) is intentionally NOT done offline — the archetype
is an in-app deterministic computation; it belongs in OutcomeTracker live tracking
(documented in PLAN_OUTCOMES.md), not a CSV proxy.

Run:  python3 phase7_closeout.py
"""
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

H = __import__('_harness')
P1 = __import__('phase1_meta')
P1F = __import__('phase1_final')
P2 = __import__('phase2_conformal')
cbt = __import__('composite_band_backtest')

SL_ATR, TP1_ATR = 2.0, 1.5


def composite_ev(frame, idx, dir_col, tp2_fn):
    rs = []
    for _, r in frame.iterrows():
        d = int(r[dir_col])
        if d == 0:
            continue
        sym = r['symbol']
        if sym not in idx or r['atrPercent'] <= 0:
            continue
        entry = r['price']; atrp = entry * r['atrPercent'] / 100.0
        c = idx[sym]; i = np.searchsorted(c['ts'], r['ts_ms'], side='right')
        if i >= len(c['ts']):
            continue
        block = {k: c[k][i:i + cbt.HORIZON] for k in ('high', 'low', 'close')}
        if len(block['high']) == 0:
            continue
        res = cbt.resolve_composite(d, entry, atrp, block, SL_ATR, TP1_ATR, tp2_fn(r))
        if res is not None:
            rs.append(res)
    rs = np.array(rs)
    if len(rs) == 0:
        return dict(n=0)
    return dict(n=len(rs), win=float((rs > 0).mean()*100), ev=float(rs.mean()), totalR=float(rs.sum()))


def main():
    market = 'crypto'
    print(f"\n{'='*86}\nPHASE 7 CLOSEOUT — {market.upper()} end-to-end (composite execution, holdout)\n{'='*86}")
    df, idx = H.load_market(market)
    df = P1.add_labels(df)
    sel, hold, boundary = H.split_holdout(df)
    print(f"  holdout >= {pd.to_datetime(boundary,unit='s').date()}  ({len(hold):,} bars)")

    # WF on selection -> OOF meta -> calibrator -> conformal tau
    val = P1F.wf(sel)
    oof = val[val['tradeDir'] != 0]
    iso = IsotonicRegression(out_of_bounds='clip'); iso.fit(oof['metaRaw'], oof['tbWin'])
    cal = np.minimum(iso.predict(oof['metaRaw']), 0.90)
    tau = P2.find_threshold(cal, oof['tbWin'].values, P2.TARGET[market])

    # final models on all selection
    mq = H.make_model(); mq.fit(sel[H.FEATURES].fillna(0), sel['goodR'])
    trm = sel[sel['tradeDir'] != 0]
    mm = H.make_model(); mm.fit(trm[P1F.META_FEATURES].fillna(0), trm['tbWin'])
    qm = P1F.make_quantile(0.75); qm.fit(sel[H.FEATURES].fillna(0), sel['fwdMaxFavR'])

    hv = hold.copy()
    hv['mlProb'] = mq.predict_proba(hv[H.FEATURES].fillna(0))[:, 1]
    hv['metaProb'] = np.minimum(iso.predict(mm.predict_proba(hv[P1F.META_FEATURES].fillna(0))[:, 1]), 0.90)
    hv['q75'] = qm.predict(hv[H.FEATURES].fillna(0))
    hv = hv.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    hv['prevMl'] = hv.groupby('symbol')['mlProb'].shift(1)

    # PRODUCTION: rising-edge goodR>=0.70 + union, fixed TP2=3.0
    prod = hv[(hv['prevMl'] < 0.70) & (hv['mlProb'] >= 0.70) & (hv['tradeDir'] != 0)]
    P = composite_ev(prod, idx, 'tradeDir', lambda r: 3.0)
    # ENHANCED: conformal meta gate + union, adaptive TP2
    enh = hv[(hv['metaProb'] >= tau) & (hv['tradeDir'] != 0)]
    E = composite_ev(enh, idx, 'tradeDir', lambda r: float(np.clip(r['q75'], 2.0, 5.0)))

    print(f"\n  conformal tau = {tau:.3f}\n")
    print(f"  {'config':<42} {'n':>6} {'win%':>6} {'EV(R)':>8} {'totalR':>9}")
    print("  " + "-"*78)
    print(f"  {'PRODUCTION (rising-edge goodR, fixed TP2=3.0)':<42} {P['n']:>6,} {P['win']:>5.1f}% {P['ev']:>+7.3f} {P['totalR']:>+8.1f}")
    print(f"  {'ENHANCED (conformal meta, adaptive TP2)':<42} {E['n']:>6,} {E['win']:>5.1f}% {E['ev']:>+7.3f} {E['totalR']:>+8.1f}")
    print(f"\n  Per-trade EV: {E['ev']-P['ev']:+.3f}R   Total R: {E['totalR']-P['totalR']:+.1f} ({E['totalR']/max(1,P['totalR']):.2f}x)")
    H.save_result('phase7_closeout', market, dict(prod_ev=P['ev'], prod_n=P['n'], prod_totalR=P['totalR'],
                                                  enh_ev=E['ev'], enh_n=E['n'], enh_totalR=E['totalR'], tau=float(tau)))
    print(f"\nsaved to {H.RESULTS_PATH}")


if __name__ == '__main__':
    main()
