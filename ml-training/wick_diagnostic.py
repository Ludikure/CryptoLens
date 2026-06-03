#!/usr/bin/env python3
"""Does high ML_WIN get 'wicked out before the move'? Bucket clean bars by ML_WIN and
measure normalized 24h excursions (in ATR units, the stop's unit):
  dnN = max adverse excursion for a LONG (= max down move / ATR)  -> long stopped if >=1
  upN = max adverse excursion for a SHORT (= max up move / ATR)   -> short stopped if >=1
  whipsaw = price moved >=1 ATR in BOTH directions in 24h -> BOTH long & short get wicked
  tail5   = a >=5 ATR move happened in some direction (the convex target)
If whipsaw rises with ML_WIN faster than tail5, high ML_WIN concentrates chop, not clean runs.
"""
import numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')

df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
df = df[df['fwdMaxUp24H'].notna() & df['fwdMaxDown24H'].notna() & (df['atrPercent'] > 0)].copy()
df = df.sort_values('timestamp').reset_index(drop=True)
df['upN'] = df['fwdMaxUp24H']      # short's adverse wick (already in ATR units)
df['dnN'] = df['fwdMaxDown24H']    # long's adverse wick (already in ATR units)

# WF: train ML_WIN, collect out-of-fold mlP on the back 65% so we bucket what the model selects
edges = np.linspace(df['timestamp'].min() + (df['timestamp'].max() - df['timestamp'].min()) * 0.35,
                    df['timestamp'].max(), 6)
parts = []
for k in range(len(edges) - 1):
    tr = df[df['timestamp'] < edges[k] - 14 * 86400]
    te = df[(df['timestamp'] >= edges[k]) & (df['timestamp'] < edges[k + 1])].copy()
    if len(tr) < 8000 or len(te) < 200:
        continue
    m = H.make_model(); m.fit(tr[H.FEATURES].fillna(0), tr['goodR'])
    te['mlP'] = m.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
    parts.append(te)
d = pd.concat(parts, ignore_index=True)

print(f"n={len(d):,}  (clean csv_exports_v11_fixed, OOF ML_WIN)\n")
print(f"{'ML_WIN bucket':<14}{'n':>8}{'long wick>=1':>13}{'short wick>=1':>14}"
      f"{'WHIPSAW both':>14}{'tail>=5ATR':>12}{'med |move|':>12}")
for lo, hi in [(0.0, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 1.01)]:
    b = d[(d['mlP'] >= lo) & (d['mlP'] < hi)]
    if not len(b):
        continue
    longw = (b['dnN'] >= 1).mean() * 100
    shortw = (b['upN'] >= 1).mean() * 100
    whip = ((b['dnN'] >= 1) & (b['upN'] >= 1)).mean() * 100        # wicked BOTH ways
    tail5 = (np.maximum(b['upN'], b['dnN']) >= 5).mean() * 100      # a 5-ATR run happened
    medmove = np.maximum(b['upN'], b['dnN']).median()
    print(f"{f'[{lo:.1f},{hi:.1f})':<14}{len(b):>8,}{longw:>12.0f}%{shortw:>13.0f}%"
          f"{whip:>13.0f}%{tail5:>11.0f}%{medmove:>12.2f}")
print("\nIf WHIPSAW climbs with ML_WIN but tail>=5 barely moves -> high ML_WIN = more chop "
      "(both sides wicked), not more catchable tails. That's why ML_WIN gating hurts.")
