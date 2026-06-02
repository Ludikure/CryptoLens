#!/usr/bin/env python3
"""
Multi-period robustness test for the crypto DIRECTION model.

The 94.7% headline came from ONE frozen 6-month holdout (the most recent window). A single
window can't tell "real edge" from "lucky regime." This slides several non-overlapping test
windows across the WHOLE history; for each, train quality+direction on everything before it
(14-day purge) and report the confident-direction accuracy (pUp>=0.70/<=0.30 on ML>=0.70 bars)
— the exact live dual-gate cohort. If 94.7% is real, it should hold in most windows. If it's a
favorable-regime artifact, it'll swing wildly window to window.

Run:  python3 direction_multiperiod.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')

PURGE = 14 * 86400          # 14-day gap between train end and test start
N_WINDOWS = 6               # non-overlapping test windows across the timeline
MIN_TRAIN = 8000            # need enough history before a window to train


def confident_acc(pUp, up, lo=0.70):
    """Accuracy + coverage on the dual-gate confident subset (pUp>=lo or <=1-lo)."""
    callup = pUp >= lo
    calldn = pUp <= (1 - lo)
    sel = callup | calldn
    n = int(sel.sum())
    if n == 0:
        return 0, 0.0, 0.0
    acc = ((callup[sel]) == up[sel]).mean() * 100
    return n, sel.mean() * 100, acc


def main():
    print("Loading crypto features...")
    df, _ = H.load_market('crypto')
    df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna()].copy()
    df['up'] = (df['fwdReturn24H'] > 0).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)

    tlo, thi = df['timestamp'].min(), df['timestamp'].max()
    # Start windows at 35% of the timeline (leave a real training base), tile to the end.
    start = tlo + (thi - tlo) * 0.35
    edges = np.linspace(start, thi, N_WINDOWS + 1)

    print(f"  rows={len(df):,}  span {pd.to_datetime(tlo,unit='s').date()} → {pd.to_datetime(thi,unit='s').date()}")
    print(f"  base rate P(up) overall: {df['up'].mean()*100:.1f}%\n")
    print(f"  {'window':<25} {'test N':>7} {'baseUp':>7} {'fullAcc':>8} {'gate cov':>9} {'gate N':>7} {'gateAcc':>8}")
    print("  " + "-" * 78)

    rows = []
    for i in range(N_WINDOWS):
        wlo, whi = edges[i], edges[i + 1]
        tr = df[df['timestamp'] < wlo - PURGE]
        te = df[(df['timestamp'] >= wlo) & (df['timestamp'] < whi)].copy()
        if len(tr) < MIN_TRAIN or len(te) < 200:
            continue
        mq = H.make_model(); mq.fit(tr[H.FEATURES].fillna(0), tr['goodR'])
        md = H.make_model(); md.fit(tr[H.FEATURES].fillna(0), tr['up'])
        te['mlP'] = mq.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        te['pUp'] = md.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        hi = te[te['mlP'] >= 0.70]
        if len(hi) < 50:
            continue
        up = hi['up'].values.astype(bool)
        fullAcc = ((hi['pUp'].values > 0.5).astype(int) == up).mean() * 100
        gN, gCov, gAcc = confident_acc(hi['pUp'].values, up)
        d0 = pd.to_datetime(wlo, unit='s').date(); d1 = pd.to_datetime(whi, unit='s').date()
        label = f"{d0}→{d1}"
        print(f"  {label:<25} {len(hi):>7,} {up.mean()*100:>6.0f}% {fullAcc:>7.1f}% {gCov:>8.0f}% {gN:>7,} {gAcc:>7.1f}%")
        rows.append(gAcc)

    if rows:
        a = np.array(rows)
        print("  " + "-" * 78)
        print(f"\n  CONFIDENT-GATE (pUp>=0.70/<=0.30 on ML>=0.70) accuracy across {len(a)} windows:")
        print(f"    mean {a.mean():.1f}%  median {np.median(a):.1f}%  min {a.min():.1f}%  max {a.max():.1f}%  std {a.std():.1f}")
        print(f"    windows >= 70%: {(a>=70).sum()}/{len(a)}   |   the single-holdout headline was 94.7%")


if __name__ == '__main__':
    main()
