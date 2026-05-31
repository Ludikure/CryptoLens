#!/usr/bin/env python3
"""
Leakage audit for the crypto direction model. Three independent kill-tests:

  1. CORRELATION SCAN — per-feature corr with the target `up` on the holdout.
     A feature that secretly encodes the future would show |corr| ~0.9+.
     Legitimate momentum features sit ~0.05-0.25.

  2. LABEL-SHIFT DECAY — train on features at bar T, but predict the direction
     of the return k bars in the FUTURE (T+k). If the model rides real momentum,
     accuracy must DECAY toward 50% as k grows (you can't see that far). A leak
     (a feature containing the answer) would NOT decay gracefully.

  3. SHUFFLE NULL — shuffle the target within the holdout. Any accuracy above
     ~50% here is pure memorization artifact; it must collapse to chance.

Run:  python3 direction_leak_audit.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')


def main():
    df, _ = H.load_market('crypto')
    df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna()].copy()
    df['up'] = (df['fwdReturn24H'] > 0).astype(int)
    df = df.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    sel, hold, _ = H.split_holdout(df)

    # ---- TEST 1: correlation scan ---------------------------------------
    print("="*72)
    print("TEST 1 — per-feature |corr| with target `up` (holdout)")
    print("  leak signature: |corr| > 0.5 ; momentum features ~0.05-0.25")
    print("="*72)
    cors = []
    for f in H.FEATURES:
        x = hold[f].astype(float)
        if x.nunique() < 2:
            continue
        c = np.corrcoef(x.fillna(x.median()), hold['up'])[0, 1]
        cors.append((abs(c), c, f))
    cors.sort(reverse=True)
    print("  top 12 absolute correlates:")
    for ac, c, f in cors[:12]:
        flag = "  <-- SUSPICIOUS" if ac > 0.5 else ""
        print(f"    {f:<28} {c:+.3f}{flag}")
    print(f"  max |corr| across all 111 features: {cors[0][0]:.3f}")

    # ---- TEST 2: label-shift decay --------------------------------------
    print("\n" + "="*72)
    print("TEST 2 — label-shift decay (train@T, predict direction of T+k return)")
    print("  real momentum -> accuracy decays toward 50% as k grows")
    print("="*72)
    # build shifted targets per symbol (shift the forward-return label backwards
    # so row T carries the return that originally belonged to row T+k)
    for k in (0, 1, 2, 3, 6):
        s2 = sel.copy()
        h2 = hold.copy()
        if k > 0:
            s2['shifted'] = s2.groupby('symbol')['fwdReturn24H'].shift(-k)
            h2['shifted'] = h2.groupby('symbol')['fwdReturn24H'].shift(-k)
        else:
            s2['shifted'] = s2['fwdReturn24H']
            h2['shifted'] = h2['fwdReturn24H']
        s2 = s2[s2['shifted'].notna()]
        h2 = h2[h2['shifted'].notna()]
        s2['y'] = (s2['shifted'] > 0).astype(int)
        h2['y'] = (h2['shifted'] > 0).astype(int)
        m = H.make_model(); m.fit(s2[H.FEATURES].fillna(0), s2['y'])
        # quality gate refit so we evaluate on the same ML>=0.70 regime
        mq = H.make_model(); mq.fit(s2[H.FEATURES].fillna(0), s2['goodR'])
        h2 = h2.assign(pUp=m.predict_proba(h2[H.FEATURES].fillna(0))[:, 1],
                       mlP=mq.predict_proba(h2[H.FEATURES].fillna(0))[:, 1])
        hi = h2[h2['mlP'] >= 0.70]
        acc = ((hi['pUp'] > 0.5).astype(int) == hi['y']).mean()*100
        conf = hi[(hi['pUp'] >= 0.70) | (hi['pUp'] <= 0.30)]
        accc = ((conf['pUp'] > 0.5).astype(int) == conf['y']).mean()*100 if len(conf) else float('nan')
        print(f"  k={k} bars ({k*4}h ahead): acc@ML≥.70 = {acc:.1f}%   "
              f"acc@pUp≥.70 = {accc:.1f}% (n={len(conf)})")

    # ---- TEST 3: shuffle null -------------------------------------------
    print("\n" + "="*72)
    print("TEST 3 — shuffled-target null (must collapse to ~50%)")
    print("="*72)
    rng = np.random.RandomState(0)
    s3 = sel.copy()
    s3['yshuf'] = rng.permutation(s3['up'].values)
    m = H.make_model(); m.fit(s3[H.FEATURES].fillna(0), s3['yshuf'])
    mq = H.make_model(); mq.fit(sel[H.FEATURES].fillna(0), sel['goodR'])
    h3 = hold.assign(pUp=m.predict_proba(hold[H.FEATURES].fillna(0))[:, 1],
                     mlP=mq.predict_proba(hold[H.FEATURES].fillna(0))[:, 1])
    hi = h3[h3['mlP'] >= 0.70]
    acc = ((hi['pUp'] > 0.5).astype(int) == hi['up']).mean()*100
    print(f"  shuffled-target acc@ML≥.70 = {acc:.1f}%  (real model was 79.7%)")


if __name__ == '__main__':
    main()
