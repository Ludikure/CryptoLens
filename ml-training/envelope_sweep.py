#!/usr/bin/env python3
"""Every remaining testable envelope condition, one sweep (Part 7, frozen at fe69586).

Same bar as Parts 1-6, same entry discipline (0.25 ATR pullback, unfilled = 0), and EFFECTIVE n
printed for every condition — a condition that persists across many bars has far fewer independent
observations than rows, which has nearly produced a finding here four times.
"""
import numpy as np, pandas as pd

d = (pd.read_pickle('excursion_dataset.pkl.gz')
       .merge(pd.read_pickle('level_entry_rows.pkl.gz'), on=['symbol','timestamp'])
       .sort_values(['symbol','timestamp']).reset_index(drop=True))
d['dt']=pd.to_datetime(d.timestamp, unit='s')
periods=pd.date_range('2022-01-01','2026-07-01',freq='6MS')

bias = np.sign(d.f_tfAlignment)                       # +1 bullish, -1 bearish
mom  = d.f_momentumAlignment
vol_hi = d.f_dVolumeRatio >= d.f_dVolumeRatio.quantile(0.70)
# price moving AGAINST the prevailing bias over the last bar
counter_move = np.sign(d.f_dRsiDelta1.fillna(0)) == -bias
oneH_bias = np.sign(d.f_oneHScore.fillna(0))

CONDS = {
  'counter_move_volume_exceeds (kill)': vol_hi & counter_move & (bias != 0),
  'funding_supports_counter (kill)':    (np.sign(d.f_fundingRateRaw.fillna(0)) == -bias) & (bias != 0),
  'continuation < 2 (cap LOW)':         mom.abs() < 2,
  'continuation < 3 (cap MODERATE)':    mom.abs() < 3,
  '1H opposes daily (downgrade)':       (oneH_bias != 0) & (bias != 0) & (oneH_bias != bias),
  'structureAlignment weak':            d.f_structureAlignment.abs() < 1,
  'macro proxy: VIX high':              d.f_vix >= d.f_vix.quantile(0.75),
  'macro proxy: VIX term inverted':     d.f_vixTermStructure < 0,
}

def eff_n(mask):
    """Independent EPISODES, not bars: contiguous runs of the condition per symbol."""
    tot=0
    for _, g in d.groupby('symbol'):
        v=mask.loc[g.index].to_numpy()
        tot += int(((v[1:] & ~v[:-1]).sum()) + (1 if len(v) and v[0] else 0))
    return tot

print(f'{len(d):,} bars\n')
for side in ('SHORT','LONG'):
    c=f'd0.25_{side}_oppR'; allb=d[c].mean()
    print(f'=== {side} — baseline {allb:+.4f}R ===')
    print(f'{"condition":>36}{"fires":>8}{"episodes":>10}{"blocked":>10}{"kept":>10}{"lift":>10}{"per+":>7}{"verdict":>13}')
    for name, fires in CONDS.items():
        if fires.sum() < 500:
            print(f'{name:>36}{fires.mean():>8.1%}{"too rare":>50}'); continue
        blocked, kept = d.loc[fires,c].mean(), d.loc[~fires,c].mean()
        lift = kept-allb; cov=(~fires).mean()
        pos=tot=0
        for i in range(len(periods)-1):
            w=(d.dt>=periods[i])&(d.dt<periods[i+1])
            if w.sum()<2000: continue
            k,a = d.loc[w&~fires,c].mean(), d.loc[w,c].mean()
            if np.isfinite(k) and np.isfinite(a): tot+=1; pos += (k-a)>=0
        ok = lift>=0.02 and pos>=6 and cov>=0.20
        v = 'EARNS IT' if ok else ('INVERTED' if lift<-0.005 else 'noise')
        print(f'{name:>36}{fires.mean():>8.1%}{eff_n(fires):>10,}{blocked:>10.4f}{kept:>10.4f}'
              f'{lift:>+10.4f}{f"{pos}/{tot}":>7}{v:>13}')
    print()
