#!/usr/bin/env python3
"""Corrected homemade-heatmap test. Cluster fuel with FIXED symmetric geometry + positioning
weighting (long-liq fuel below weighted by long%, short-liq fuel above by short%):
  DOWN_fuel = long-OI whose liq level Pj(1-1/L) sits just BELOW current price
  UP_fuel   = short-OI whose liq level Pj(1+1/L) sits just ABOVE current price
  asym = (DOWN-UP)/(DOWN+UP)   >0 => long-liq below dominates => magnet predicts DOWN.
KEY: control for MOMENTUM (return over the window). Does asym predict forward direction BEYOND
recent price action? corr(asym, fwd) raw vs momentum-residualized, on a frozen holdout.
"""
import os, glob, numpy as np, pandas as pd
from scipy.stats import pearsonr
L = 25.0; D = 1.0 / L; W = 42; K = 6; ATRW = 14
DATA = os.path.join(os.path.dirname(__file__), 'cg_data')

rec = []
for f in sorted(glob.glob(f'{DATA}/*.csv')):
    d = pd.read_csv(f)
    if len(d) < W + K + ATRW + 10 or 'long_pct' not in d: continue
    px = d['price'].values.astype(float); oi = d['oi'].values.astype(float)
    lp = d['long_pct'].values.astype(float) / 100.0; t = d['time'].values
    ret = np.diff(px, prepend=px[0]) / px
    atrp = pd.Series(np.abs(ret)).rolling(ATRW).mean().values
    dOI = np.maximum(0.0, np.diff(oi, prepend=oi[0]))
    n = len(px)
    for i in range(W, n - K):
        Pt = px[i]; a = atrp[i]
        if not (a > 0): continue
        down = up = 0.0
        for j in range(i - W, i):
            if dOI[j] <= 0: continue
            Pj = px[j]; LL = Pj * (1 - D); SL = Pj * (1 + D)
            if Pt * (1 - D) < LL < Pt: down += dOI[j] * lp[j]          # long-liq below, long-weighted
            if Pt < SL < Pt * (1 + D): up += dOI[j] * (1 - lp[j])       # short-liq above, short-weighted
        tot = down + up
        if tot <= 0: continue
        asym = (down - up) / tot
        mom = Pt / px[i - W] - 1.0                                       # momentum over window
        fwd = px[i + K] / Pt - 1.0
        win = px[i + 1:i + 1 + K]
        rec.append((t[i], asym, mom, fwd, (win.max()/Pt-1)/a, (1-win.min()/Pt)/a))

r = pd.DataFrame(rec, columns=['time', 'asym', 'mom', 'fwd', 'up', 'dn'])
cut = r['time'].quantile(0.70); tr, ho = r[r['time'] < cut], r[r['time'] >= cut]
print(f"signals: {len(r):,} (train {len(tr):,}/holdout {len(ho):,})")
print(f"corr(asym, momentum) = {pearsonr(r['asym'], r['mom'])[0]:+.3f}  (how confounded asym is with momentum)\n")
print("magnet predicts corr(asym, fwd) < 0 (more long-liq-below => price flushes down)\n")

# fit fwd ~ momentum on TRAIN, residualize, test asym's leftover power on HOLDOUT
b1, b0 = np.polyfit(tr['mom'], tr['fwd'], 1)
for name, d in [('TRAIN', tr), ('HOLDOUT', ho)]:
    resid = d['fwd'] - (b0 + b1 * d['mom'])
    craw = pearsonr(d['asym'], d['fwd']); cres = pearsonr(d['asym'], resid)
    q = d['asym'].quantile([1/3, 2/3]).values
    lo = d[d['asym'] <= q[0]]['fwd'].mean() * 100; hi = d[d['asym'] >= q[1]]['fwd'].mean() * 100
    print(f"{name:<8} corr(asym,fwd) raw={craw[0]:+.3f} (p={craw[1]:.2f}) | "
          f"momentum-residualized={cres[0]:+.3f} (p={cres[1]:.2f}) | "
          f"fwd%: low-asym {lo:+.2f}  high-asym {hi:+.2f}  spread {hi-lo:+.2f}")
# reachability (magnet): when down-fuel dominates, does price TOUCH the downside more than up?
print("\n--- reachability (magnet touch test), HOLDOUT ---")
q = ho['asym'].quantile([1/3, 2/3]).values
for name, b in [('down-fuel heavy (top asym)', ho[ho['asym'] >= q[1]]),
                ('up-fuel heavy (bottom asym)', ho[ho['asym'] <= q[0]])]:
    rd = (b['dn'] >= 1).mean()*100; ru = (b['up'] >= 1).mean()*100
    print(f"  {name:<28} n={len(b):>5}  reach-down={rd:>4.0f}%  reach-up={ru:>4.0f}%  (d-u={rd-ru:>+4.0f})")
print("  magnet: down-fuel-heavy -> reach-down>up; up-fuel-heavy -> reach-up>down.")
print("\nRead: magnet adds real signal only if the MOMENTUM-RESIDUALIZED corr is clearly negative "
      "AND holds on HOLDOUT. If residualized corr ~0 (or flips), the heatmap predicts nothing beyond "
      "momentum — i.e., it's repackaged momentum + positioning, both already dead.")
