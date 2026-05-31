#!/usr/bin/env python3
"""
Conditional on HIGH ML (a >=1.5 ATR move is likely), how well do indicators predict
DIRECTION? Directional accuracy = P(indicator's direction == sign of the actual 24h
return), measured among high-ML bars on the frozen holdout. Baseline = 50%.

Also: does directional accuracy RISE with ML? (The system's thesis is that ML predicts
move SIZE, not direction — so accuracy should be ~flat across ML levels.)

Run:  python3 direction_accuracy.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')


def primitives(df):
    a = df['biasAlignment'].values
    bias = np.where(a == 'aligned_bullish', 1, np.where(a == 'aligned_bearish', -1, 0))
    dstoch = df['dStochCross'].fillna(0).astype(int).values
    hstoch = df['hStochCross'].fillna(0).astype(int).values
    dmacd = df['dMacdCross'].fillna(0).astype(int).values
    demacross = np.sign(df['dEmaCross'].fillna(0).values).astype(int)
    conflict = (bias != 0) & (dstoch != 0) & (bias != dstoch)
    union = np.where(bias != 0, bias, dstoch); union = np.where(conflict, 0, union)
    agree = np.where((bias != 0) & (dstoch != 0) & (bias == dstoch), bias, 0)
    return {'bias': bias, 'dStoch': dstoch, 'hStoch': hstoch, 'dMACD': dmacd,
            'dEMAcross': demacross, 'union(bias∪dStoch)': union, 'bias&dStoch agree': agree}


def acc(dirv, up, mask):
    sel = mask & (dirv != 0)
    n = int(sel.sum())
    if n == 0:
        return 0, 0.0
    correct = ((dirv[sel] > 0) == up[sel]).mean() * 100
    return n, correct


def run(market):
    print(f"\n{'='*82}\n{market.upper()} — directional accuracy of indicators (holdout)\n{'='*82}")
    df, _ = H.load_market(market)
    df = P1.add_labels(df)
    sel, hold, b = H.split_holdout(df)
    mq = H.make_model(); mq.fit(sel[H.FEATURES].fillna(0), sel['goodR'])
    hv = hold.copy()
    hv['mlProb'] = mq.predict_proba(hv[H.FEATURES].fillna(0))[:, 1]
    hv = hv[hv['fwdReturn24H'].notna()].reset_index(drop=True)
    up = (hv['fwdReturn24H'].values > 0)
    prims = primitives(hv)
    ml = hv['mlProb'].values

    base_up = up.mean() * 100
    print(f"  holdout bars: {len(hv):,}  | unconditional P(up 24h): {base_up:.1f}%\n")

    for label, sub in [('ALL bars', ml > -1), ('ML >= 0.60', ml >= 0.60),
                       ('ML >= 0.70 (high)', ml >= 0.70), ('ML >= 0.80 (very high)', ml >= 0.80)]:
        n_sub = int(sub.sum())
        up_sub = up[sub].mean() * 100
        majority = max(up_sub, 100 - up_sub)  # "always predict the dominant side" baseline
        print(f"  --- {label}  (n={n_sub:,}, {sub.mean()*100:.0f}% of holdout) | "
              f"P(up)={up_sub:.0f}% → majority-baseline {majority:.0f}% ---")
        print(f"    {'primitive':<22} {'fires%':>7} {'dir-acc':>8}  vs50%  vs-majority")
        for name, dirv in prims.items():
            n, a = acc(dirv, up, sub)
            fires = n / max(1, n_sub) * 100
            print(f"    {name:<22} {fires:>6.0f}% {a:>7.1f}%  {a-50:>+4.0f}  {a-majority:>+6.1f}")
        print()


def main():
    for mk in ('crypto', 'stock'):
        run(mk)


if __name__ == '__main__':
    main()
