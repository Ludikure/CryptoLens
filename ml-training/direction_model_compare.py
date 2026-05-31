#!/usr/bin/env python3
"""
Can a dedicated DIRECTION model predict STOCK direction (where the raw indicators
are at chance)? Same recipe as the crypto direction model, run on both markets for
a head-to-head. Target = sign(fwdReturn24H). Frozen holdout. Uniform weights.

Reports per market: overfit (selection vs holdout), holdout accuracy overall / at
high ML / by the model's own confidence, indicator baselines at high ML, and a
per-regime WF (does any edge hold in the 2022 bear, or is it overfit noise?).

Run:  python3 direction_model_compare.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')
ev = __import__('edge_validation')


def prims(df):
    a = df['biasAlignment'].values
    bias = np.where(a == 'aligned_bullish', 1, np.where(a == 'aligned_bearish', -1, 0))
    ds = df['dStochCross'].fillna(0).astype(int).values
    conflict = (bias != 0) & (ds != 0) & (bias != ds)
    union = np.where(bias != 0, bias, ds); union = np.where(conflict, 0, union)
    return {'dStoch': ds, 'union': union}


def pacc(dirv, up):
    s = dirv != 0
    return int(s.sum()), (((dirv[s] > 0) == up[s]).mean()*100 if s.sum() else 0.0)


def run(market):
    print(f"\n{'='*80}\n{market.upper()} — direction model vs indicators\n{'='*80}")
    df, _ = H.load_market(market)
    df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna()].copy()
    df['up'] = (df['fwdReturn24H'] > 0).astype(int)
    sel, hold, b = H.split_holdout(df)

    mq = H.make_model(); mq.fit(sel[H.FEATURES].fillna(0), sel['goodR'])
    md = H.make_model(); md.fit(sel[H.FEATURES].fillna(0), sel['up'])
    hv = hold.copy()
    hv['mlProb'] = mq.predict_proba(hv[H.FEATURES].fillna(0))[:, 1]
    hv['pUp'] = md.predict_proba(hv[H.FEATURES].fillna(0))[:, 1]
    up = hv['up'].values.astype(bool)

    sel_acc = ((md.predict_proba(sel[H.FEATURES].fillna(0))[:, 1] > 0.5).astype(int) == sel['up']).mean()*100
    hold_acc = ((hv['pUp'].values > 0.5).astype(int) == up).mean()*100
    print(f"  overfit check: selection {sel_acc:.1f}%  holdout {hold_acc:.1f}%  (gap {sel_acc-hold_acc:+.1f})")
    print(f"  holdout base rate P(up): {up.mean()*100:.0f}%")

    high = hv[hv['mlProb'] >= 0.70].copy()
    if len(high) < 50:
        print("  (too few high-ML bars)"); return
    uh = high['up'].values.astype(bool)
    maj = max(uh.mean()*100, 100 - uh.mean()*100)
    print(f"\n  high-ML (ML>=0.70): n={len(high):,}  P(up)={uh.mean()*100:.0f}%  majority-baseline {maj:.0f}%")
    print(f"  indicator baselines:")
    for name, d in prims(high).items():
        n, a = pacc(d, uh)
        print(f"    {name:<8} {a:.1f}%  ({a-maj:+.1f} vs maj)  @ {n/len(high)*100:.0f}% cover")
    print(f"  DIRECTION MODEL by confidence (on high-ML bars):")
    pu = high['pUp'].values
    for lo in (0.50, 0.55, 0.60, 0.65, 0.70):
        m = (pu >= lo) | (pu <= 1-lo)
        if m.sum() == 0: continue
        a = ((pu[m] >= 0.5) == uh[m]).mean()*100
        print(f"    pUp≥{lo:.2f}/≤{1-lo:.2f}:  {m.mean()*100:>4.0f}% cover  {a:.1f}% acc  ({a-maj:+.1f} vs maj)")

    # per-regime WF
    print(f"  per-regime (direction model, ML>=0.70):")
    dff = ev.load_features(H.MARKETS[market]['csv_dir']); dff = dff[dff['fwdReturn24H'].notna()].copy()
    dff['up'] = (dff['fwdReturn24H'] > 0).astype(int)
    dff = dff.sort_values('timestamp').reset_index(drop=True)
    tlo, thi = dff['timestamp'].min(), dff['timestamp'].max(); span = thi - tlo
    for i in range(5):
        lo = tlo + span*(0.25+i*0.15); hi = tlo + span*(0.25+(i+1)*0.15) if i < 4 else thi+1
        tr = dff[dff['timestamp'] < lo - 14*86400]; va = dff[(dff['timestamp']>=lo)&(dff['timestamp']<hi)].copy()
        if len(tr) < 5000 or len(va) < 200: continue
        m = H.make_model(); m.fit(tr[H.FEATURES].fillna(0), tr['up'])
        mqf = H.make_model(); mqf.fit(tr[H.FEATURES].fillna(0), tr['goodR'])
        va['pUp'] = m.predict_proba(va[H.FEATURES].fillna(0))[:, 1]
        va['mlP'] = mqf.predict_proba(va[H.FEATURES].fillna(0))[:, 1]
        h = va[va['mlP'] >= 0.70]
        if len(h) < 50: continue
        uvh = h['up'].values.astype(bool)
        a = ((h['pUp'].values > 0.5).astype(int) == uvh).mean()*100
        d0, d1 = pd.to_datetime(va['timestamp'].min(),unit='s').date(), pd.to_datetime(va['timestamp'].max(),unit='s').date()
        print(f"    f{i+1} {d0}→{d1}: n={len(h):>5} P(up)={uvh.mean()*100:.0f}% acc={a:.1f}%")


def main():
    run('stock')
    run('crypto')  # reference


if __name__ == '__main__':
    main()
