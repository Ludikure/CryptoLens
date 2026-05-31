#!/usr/bin/env python3
"""
Train a dedicated CRYPTO DIRECTION model (target = sign of fwdReturn24H) and compare
to the raw indicator primitives on the same frozen holdout.

Baselines to beat (direction_accuracy.py, crypto holdout, ML_WIN >= 70%):
  dStoch alone           76% acc @ ~26% of high-ML bars fire
  union (bias∪dStoch)    79% @ ~36%
  bias & dStoch agree    94% @ ~3%

Questions:
  1. Does a 111-feature direction model beat 76% on the high-ML population (it has
     dStoch as a feature, plus everything else)?
  2. At the model's own confidence thresholds, can it reach ~agreement-tier accuracy
     at MORE coverage than the 3% agreement tier?
  3. Does it hold per-regime (2022 bear) and not overfit (selection vs holdout gap)?

Uniform sample weights (no recency) so a bull-heavy corpus doesn't bias it UP.

Run:  python3 crypto_direction_model.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')
rev = __import__('edge_revalidate')
ev = __import__('edge_validation')


def dir_primitives(df):
    a = df['biasAlignment'].values
    bias = np.where(a == 'aligned_bullish', 1, np.where(a == 'aligned_bearish', -1, 0))
    ds = df['dStochCross'].fillna(0).astype(int).values
    conflict = (bias != 0) & (ds != 0) & (bias != ds)
    union = np.where(bias != 0, bias, ds); union = np.where(conflict, 0, union)
    agree = np.where((bias != 0) & (ds != 0) & (bias == ds), bias, 0)
    return {'dStoch': ds, 'union': union, 'agree': agree}


def prim_acc(dirv, up):
    sel = dirv != 0
    n = int(sel.sum())
    return n, (((dirv[sel] > 0) == up[sel]).mean() * 100 if n else 0.0)


def main():
    print("Loading crypto + training quality(goodR) + direction(up) models...")
    df, _ = H.load_market('crypto')
    df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna()].copy()
    df['up'] = (df['fwdReturn24H'] > 0).astype(int)
    sel, hold, b = H.split_holdout(df)

    # quality model → holdout mlProb (for the ML>=0.70 condition)
    mq = H.make_model(); mq.fit(sel[H.FEATURES].fillna(0), sel['goodR'])
    # direction model → holdout P(up)
    md = H.make_model(); md.fit(sel[H.FEATURES].fillna(0), sel['up'])

    hv = hold.copy()
    hv['mlProb'] = mq.predict_proba(hv[H.FEATURES].fillna(0))[:, 1]
    hv['pUp'] = md.predict_proba(hv[H.FEATURES].fillna(0))[:, 1]
    up = hv['up'].values.astype(bool)

    # overfit check: direction model on selection (in-sample) vs holdout
    sel_acc = ((md.predict_proba(sel[H.FEATURES].fillna(0))[:, 1] > 0.5).astype(int) == sel['up']).mean() * 100
    hold_acc = ((hv['pUp'].values > 0.5).astype(int) == up).mean() * 100
    print(f"\n  direction model accuracy: selection(in-sample) {sel_acc:.1f}%  holdout {hold_acc:.1f}%  "
          f"(gap {sel_acc-hold_acc:+.1f} = overfit indicator)")
    print(f"  holdout P(up) base rate: {up.mean()*100:.0f}%")

    # --- indicator baselines on high-ML, for reference ---
    high = hv[hv['mlProb'] >= 0.70].copy()
    uh = high['up'].values.astype(bool)
    print(f"\n  === high-ML (ML>=0.70) population: n={len(high):,} ===")
    print(f"  INDICATOR BASELINES:")
    for name, dirv in dir_primitives(high).items():
        n, a = prim_acc(dirv, uh)
        print(f"    {name:<22} {a:>5.1f}%  @ {n/len(high)*100:>4.0f}% coverage")

    # --- direction MODEL on high-ML, at confidence thresholds ---
    pu = high['pUp'].values
    print(f"\n  DIRECTION MODEL (on the same high-ML bars), by confidence:")
    print(f"    {'rule':<26} {'cover':>6} {'acc':>6}")
    for lo in (0.50, 0.55, 0.60, 0.65, 0.70):
        # confident = pUp >= lo (call UP) OR pUp <= 1-lo (call DOWN)
        callup = pu >= lo
        calldn = pu <= (1 - lo)
        sel_mask = callup | calldn
        if sel_mask.sum() == 0:
            continue
        pred_up = callup[sel_mask]
        correct = (pred_up == uh[sel_mask]).mean() * 100
        print(f"    pUp≥{lo:.2f} or ≤{1-lo:.2f}      {sel_mask.mean()*100:>5.0f}% {correct:>5.1f}%")

    # --- direction model + agreement: does combining help? ---
    prims = dir_primitives(high)
    ag = prims['agree']
    ag_mask = ag != 0
    if ag_mask.sum() > 20:
        # model prediction on the agreement bars
        model_dir = np.where(pu[ag_mask] >= 0.5, 1, -1)
        model_on_agree = ((model_dir > 0) == uh[ag_mask]).mean() * 100
        print(f"\n  on the agreement-tier bars (n={int(ag_mask.sum())}): "
              f"indicator-agree {prim_acc(ag, uh)[1]:.1f}%  |  direction-model {model_on_agree:.1f}%")

    # --- per-regime (does the direction model hold in the bear?) ---
    print(f"\n  === per-regime (direction model, ML>=0.70, multi-fold WF) ===")
    dff = ev.load_features('csv_exports_v11'); dff = dff[dff['fwdReturn24H'].notna()].copy()
    dff['up'] = (dff['fwdReturn24H'] > 0).astype(int)
    # WF: train direction model per fold, eval on fold
    t = dff.sort_values('timestamp')['timestamp'].values
    val = rev.wf_clean(dff)  # gives mlProb per fold (quality) + fold id
    # train a direction model on the same expanding windows
    out = []
    tlo, thi = dff['timestamp'].min(), dff['timestamp'].max(); span = thi - tlo
    dff = dff.sort_values('timestamp').reset_index(drop=True)
    for i in range(5):
        lo = tlo + span*(0.25+i*0.15); hi = tlo + span*(0.25+(i+1)*0.15) if i < 4 else thi+1
        tr = dff[dff['timestamp'] < lo - 14*86400]
        va = dff[(dff['timestamp'] >= lo) & (dff['timestamp'] < hi)].copy()
        if len(tr) < 5000 or len(va) < 200:
            continue
        m = H.make_model(); m.fit(tr[H.FEATURES].fillna(0), tr['up'])
        mqf = H.make_model(); mqf.fit(tr[H.FEATURES].fillna(0), tr['goodR'])
        va['pUp'] = m.predict_proba(va[H.FEATURES].fillna(0))[:, 1]
        va['mlP'] = mqf.predict_proba(va[H.FEATURES].fillna(0))[:, 1]
        hi_va = va[va['mlP'] >= 0.70]
        if len(hi_va) < 50:
            continue
        uvh = hi_va['up'].values.astype(bool)
        acc = ((hi_va['pUp'].values > 0.5).astype(int) == uvh).mean()*100
        d0, d1 = pd.to_datetime(va['timestamp'].min(),unit='s').date(), pd.to_datetime(va['timestamp'].max(),unit='s').date()
        out.append((i+1, d0, d1, len(hi_va), uvh.mean()*100, acc))
    for f, d0, d1, n, upp, acc in out:
        print(f"    f{f} {d0}→{d1}: n={n:>5} P(up)={upp:.0f}% dir-model-acc={acc:.1f}%")


if __name__ == '__main__':
    main()
