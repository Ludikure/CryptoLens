#!/usr/bin/env python3
"""Reframe test (target REACHABILITY, not direction): does funding crowding predict that the
crowded-side TARGET gets *reached* (touched) more often? Magnet/cascade proxy:
  crowded LONG  (high +funding) -> long-liq cluster BELOW -> price should REACH a downside target
  crowded SHORT (deep -funding) -> short cluster ABOVE     -> price should REACH an upside target
Metric per funding bucket: P(reach -D ATR) and P(reach +D ATR) within 24h, and the asymmetry.
This is DIFFERENT from the direction test (which asked P(up)): here we ask which TARGET gets touched.
Per-symbol funding z (TRAIN stats), train + frozen holdout. A real signal = the crowded-side
reach-rate is elevated AND the asymmetry holds out-of-sample.
"""
import numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
ev = __import__('edge_validation'); P1 = __import__('phase1_meta')
DS = [1.0, 1.5, 2.0]   # target distances in ATR

df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
df = df[(df['fundingRateRaw'].fillna(0) != 0) & df['fwdMaxUp24H'].notna() & df['fwdMaxDown24H'].notna()].copy()
df = df.sort_values('timestamp').reset_index(drop=True)
cut = df['timestamp'].quantile(0.70)
train, hold = df[df['timestamp'] < cut].copy(), df[df['timestamp'] >= cut].copy()
stats = train.groupby('symbol')['fundingRateRaw'].agg(['mean', 'std']).replace(0, np.nan)
def z(d):
    m = d['symbol'].map(stats['mean']); s = d['symbol'].map(stats['std'])
    return ((d['fundingRateRaw'] - m) / s).replace([np.inf, -np.inf], np.nan)
train['fz'] = z(train); hold['fz'] = z(hold)
train, hold = train.dropna(subset=['fz']), hold.dropna(subset=['fz'])

BUCKETS = [('crowded SHORT (fz<-1.5)', lambda d: d['fz'] < -1.5),
           ('neutral (-0.5..0.5)',     lambda d: d['fz'].abs() < 0.5),
           ('crowded LONG (fz>1.5)',   lambda d: d['fz'] >= 1.5)]
print(f"funding bars {len(df):,} | reachability test: P(price TOUCHES ±D ATR in 24h)\n"
      f"MAGNET predicts: crowded LONG -> reach-DOWN > reach-UP (asym>0); crowded SHORT -> asym<0\n")


def report(d, label):
    print(f"=== {label} (n={len(d):,}) ===")
    for D in DS:
        print(f"  target ±{D} ATR:")
        for name, f in BUCKETS:
            b = d[f(d)]
            if len(b) < 100: continue
            rd = (b['fwdMaxDown24H'] >= D).mean() * 100
            ru = (b['fwdMaxUp24H'] >= D).mean() * 100
            print(f"    {name:<26} reach-down={rd:>5.1f}%  reach-up={ru:>5.1f}%  asym(d-u)={rd-ru:>+5.1f}pp")


report(train, 'TRAIN')
print()
report(hold, 'HOLDOUT (frozen)')
print("\nRead: a real magnet-reachability signal = crowded-LONG asym clearly POSITIVE (downside "
      "target touched more) and crowded-SHORT clearly NEGATIVE, monotonic, AND holding on HOLDOUT. "
      "If asym ~0 or flips out-of-sample, funding doesn't predict reachability either (and we'd be "
      "leaning on the heatmap's SPATIAL info, which funding lacks).")
