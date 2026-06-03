#!/usr/bin/env python3
"""Homemade liquidation-heatmap test on the Coinglass OI data (~6mo, 4H, 24 majors).
Reconstruct a crude Model-1 (high-leverage) cluster map from trailing OI buildup, compute
cluster ASYMMETRY (long-liq fuel below vs short-liq fuel above current price), then test:
  DIRECTION  : does asym predict next move? (magnet: long-fuel-below>short → price flushes DOWN)
  REACHABILITY: does price TOUCH the cluster side more than the other? (excursion, vs ±1 ATR)
Frozen holdout (last 30% by time). Crude single-regime first cut — read accordingly.
"""
import os, glob, numpy as np, pandas as pd
L = 25.0          # leverage tier (Model-1 high lev) -> liq distance 1/L = 4%
W = 42            # trailing OI-buildup window (bars, ~7 days)
BAND = 0.08       # consider liq levels within ±8% of current price
K = 6             # forward horizon (24h)
ATRW = 14
DATA = os.path.join(os.path.dirname(__file__), 'cg_data')

recs = []
for f in sorted(glob.glob(f'{DATA}/*.csv')):
    d = pd.read_csv(f)
    if len(d) < W + K + ATRW + 10: continue
    px = d['price'].values.astype(float); oi = d['oi'].values.astype(float); t = d['time'].values
    ret = np.diff(px, prepend=px[0]) / px
    atrp = pd.Series(np.abs(ret)).rolling(ATRW).mean().values   # ATR as % of price
    dOI = np.maximum(0.0, np.diff(oi, prepend=oi[0]))
    n = len(px)
    for i in range(W, n - K):
        Pt = px[i]; a = atrp[i]
        if not (a > 0): continue
        lo = Pt * (1 - BAND); hi = Pt * (1 + BAND)
        lfb = sfa = 0.0
        for j in range(i - W, i):
            if dOI[j] <= 0: continue
            Pj = px[j]; LL = Pj * (1 - 1 / L); SL = Pj * (1 + 1 / L)
            if lo <= LL < Pt: lfb += 0.5 * dOI[j]     # long-liq fuel below current
            if Pt < SL <= hi: sfa += 0.5 * dOI[j]     # short-liq fuel above current
        tot = lfb + sfa
        if tot <= 0: continue
        asym = (lfb - sfa) / tot                       # >0: long-fuel below dominates -> DOWN magnet
        fwd = px[i + K] / Pt - 1
        win = px[i + 1:i + 1 + K]
        up_exc = (win.max() / Pt - 1) / a              # forward up excursion in ATR
        dn_exc = (1 - win.min() / Pt) / a              # forward down excursion in ATR
        recs.append((t[i], asym, fwd, up_exc, dn_exc))

r = pd.DataFrame(recs, columns=['time', 'asym', 'fwd', 'up', 'dn'])
cut = r['time'].quantile(0.70)
tr, ho = r[r['time'] < cut], r[r['time'] >= cut]
print(f"reconstructed cluster signals: {len(r):,} bars  (train {len(tr):,} / holdout {len(ho):,})")
print(f"asym distribution: {r['asym'].describe()[['mean','std','min','max']].to_dict()}\n")

BK = [('short-fuel-above (asym<-0.3)', lambda d: d['asym'] < -0.3),
      ('neutral (|asym|<0.3)',          lambda d: d['asym'].abs() < 0.3),
      ('long-fuel-below  (asym>+0.3)',  lambda d: d['asym'] > 0.3)]

def rpt(d, lab):
    print(f"=== {lab} (n={len(d):,}) ===  magnet: long-fuel-below -> P(up) LOW & reach-down>up")
    for name, f in BK:
        b = d[f(d)]
        if len(b) < 50: continue
        pup = (b['fwd'] > 0).mean() * 100
        z = (pup/100 - 0.5) / np.sqrt(0.25 / len(b))
        rd = (b['dn'] >= 1).mean() * 100; ru = (b['up'] >= 1).mean() * 100
        print(f"  {name:<30} n={len(b):>5}  P(up)={pup:>4.0f}% (z={z:>+4.1f})  reach-dn={rd:>4.0f}% reach-up={ru:>4.0f}% (d-u={rd-ru:>+4.0f})")

rpt(tr, 'TRAIN'); print(); rpt(ho, 'HOLDOUT (frozen)')
print("\nRead: magnet/cascade real if long-fuel-below -> P(up)<50 & reach-down>reach-up, short-fuel-"
      "above -> opposite, monotonic, AND holding on HOLDOUT. Single-regime ~6mo data, so treat a "
      "positive cautiously; a clean null is the more reliable conclusion.")
