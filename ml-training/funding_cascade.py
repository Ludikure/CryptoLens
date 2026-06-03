#!/usr/bin/env python3
"""Cascade-via-funding test (free, deep funding history). Hypothesis: funding EXTREMES predict
the AGAINST-the-crowd move — crowded longs (high +funding) → down-flush; crowded shorts
(deep -funding) → up-squeeze. Contrarian if real. Per-symbol funding z-score (stats from TRAIN
only, applied to HOLDOUT), bucketed, measuring forward direction + cascade asymmetry on BOTH.
If high-funding P(up) < 50 AND low-funding P(up) > 50, monotonic, AND it holds out → real signal.
"""
import numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
ev = __import__('edge_validation'); P1 = __import__('phase1_meta')

df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
df = df[(df['fundingRateRaw'].fillna(0) != 0) & df['fwdReturn24H'].notna() &
        df['fwdMaxUp24H'].notna() & df['fwdMaxDown24H'].notna()].copy()
df = df.sort_values('timestamp').reset_index(drop=True)
print(f"funding bars: {len(df):,}  span {pd.to_datetime(df['timestamp'].min(),unit='s').date()} "
      f"→ {pd.to_datetime(df['timestamp'].max(),unit='s').date()}")

# time split: train 70% / holdout 30% (most recent, frozen)
cut = df['timestamp'].quantile(0.70)
train, hold = df[df['timestamp'] < cut].copy(), df[df['timestamp'] >= cut].copy()

# per-symbol funding z-score using TRAIN stats only (no holdout leakage)
stats = train.groupby('symbol')['fundingRateRaw'].agg(['mean', 'std']).replace(0, np.nan)
def zscore(d):
    m = d['symbol'].map(stats['mean']); s = d['symbol'].map(stats['std'])
    return ((d['fundingRateRaw'] - m) / s).replace([np.inf, -np.inf], np.nan)
train['fz'] = zscore(train); hold['fz'] = zscore(hold)
train = train.dropna(subset=['fz']); hold = hold.dropna(subset=['fz'])

BUCKETS = [('crowded SHORT (fz<-1.5)', lambda d: d['fz'] < -1.5),
           ('mild short (-1.5..-0.5)', lambda d: (d['fz'] >= -1.5) & (d['fz'] < -0.5)),
           ('neutral (-0.5..0.5)',     lambda d: (d['fz'] >= -0.5) & (d['fz'] < 0.5)),
           ('mild long (0.5..1.5)',    lambda d: (d['fz'] >= 0.5) & (d['fz'] < 1.5)),
           ('crowded LONG (fz>1.5)',   lambda d: d['fz'] >= 1.5)]


def report(d, label):
    print(f"\n=== {label} (n={len(d):,}) ===  cascade predicts: crowded LONG → P(up)<50, crowded SHORT → P(up)>50")
    print(f"  {'bucket':<26}{'n':>8}{'P(up)':>8}{'z vs50':>8}{'meanRet%':>10}{'down/up exc':>12}")
    for name, f in BUCKETS:
        b = d[f(d)]
        if len(b) < 50: continue
        pup = (b['fwdReturn24H'] > 0).mean()
        z = (pup - 0.5) / np.sqrt(0.25 / len(b))
        ret = np.clip(b['fwdReturn24H'] * 100, -15, 15).mean()
        exc = b['fwdMaxDown24H'].mean() / max(b['fwdMaxUp24H'].mean(), 1e-9)  # >1 = downside dominates
        print(f"  {name:<26}{len(b):>8,}{pup*100:>7.1f}%{z:>+8.2f}{ret:>+10.2f}{exc:>12.2f}")


report(train, 'TRAIN (in-sample)')
report(hold, 'HOLDOUT (frozen, most recent 30%)')
print("\nRead: a REAL contrarian cascade signal shows P(up) sloping DOWN across buckets (short→long), "
      "crowded-LONG P(up) clearly <50 with |z|>2, crowded-SHORT >50 — AND the same pattern on HOLDOUT. "
      "If P(up)~50 everywhere or the holdout doesn't match, funding is already priced in (no edge).")
