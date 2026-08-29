#!/usr/bin/env python3
"""Daily BEARISH divergence -> go LONG. Does the isolated cell survive?

Part 6 reported this at +1.43pp, p=4.0e-4. But that p-value treats 15,399 BARS as independent
observations, and divergence PERSISTS: it is the same signal re-read every 4h. The honest unit is
the EPISODE (a contiguous run), not the bar.
"""
import numpy as np, pandas as pd
from scipy import stats

d = (pd.read_pickle('excursion_dataset.pkl.gz')
       .merge(pd.read_pickle('level_entry_rows.pkl.gz'), on=['symbol','timestamp'])
       .sort_values(['symbol','timestamp']).reset_index(drop=True))
d['dt']=pd.to_datetime(d.timestamp, unit='s')
d['up24']=(d.f_fwdReturn24H>0).astype(int)
base=d.up24.mean()
cell = d.f_dDivergence == -1                       # daily BEARISH divergence

# Episode id: contiguous runs of the condition, per symbol.
def episodes(g):
    v=g.to_numpy(); ep=np.zeros(len(v),int); cur=0
    for i in range(len(v)):
        if v[i] and (i==0 or not v[i-1]): cur+=1
        ep[i]=cur if v[i] else 0
    return pd.Series(ep,index=g.index)
d['ep']=d.groupby('symbol',group_keys=False)[cell.name if hasattr(cell,'name') else 'f_dDivergence'].apply(lambda x: pd.Series(0,index=x.index))
d['is_cell']=cell
d['ep']=d.groupby('symbol',group_keys=False)['is_cell'].apply(episodes)
sub=d[cell]
n_bars=len(sub); n_eps=sub.groupby(['symbol','ep']).ngroups
print(f'daily bearish divergence: {n_bars:,} BARS but only {n_eps:,} EPISODES '
      f'({n_bars/n_eps:.1f} bars each)')
print(f'unconditional P(up24) = {base:.4f}\n')

print('A. DIRECTION — per bar vs per episode')
p_bar=sub.up24.mean()
pv_bar=stats.binomtest(int(sub.up24.sum()), n_bars, base).pvalue
ep_mean=sub.groupby(['symbol','ep']).up24.mean()        # one observation per episode
p_ep=ep_mean.mean()
t,pv_ep=stats.ttest_1samp(ep_mean, base)
print(f'  per BAR     n={n_bars:>7,}  P(up)={p_bar:.4f}  vs base {p_bar-base:+.4f}  p={pv_bar:.2e}')
print(f'  per EPISODE n={n_eps:>7,}  P(up)={p_ep:.4f}  vs base {p_ep-base:+.4f}  p={pv_ep:.2e}')
print(f'  -> significance inflation factor ~{np.sqrt(n_bars/n_eps):.1f}x from treating bars as independent\n')

print('B. MONEY — LONG on daily bearish divergence, 0.25 ATR pullback, net of fees')
periods=pd.date_range('2022-01-01','2026-07-01',freq='6MS')
cellR=d.loc[cell,'d0.25_LONG_oppR']; baseR=d.loc[~cell,'d0.25_LONG_oppR']
pos=tot=0
for i in range(len(periods)-1):
    w=(d.dt>=periods[i])&(d.dt<periods[i+1])
    if w.sum()<2000: continue
    a=d.loc[w&cell,'d0.25_LONG_oppR'].mean(); b=d.loc[w&~cell,'d0.25_LONG_oppR'].mean()
    if np.isfinite(a) and np.isfinite(b): tot+=1; pos += (a-b)>=0
print(f'  cell     {cellR.mean():+.4f}R   (n={len(cellR):,})')
print(f'  all else {baseR.mean():+.4f}R')
print(f'  lift     {cellR.mean()-baseR.mean():+.4f}R   periods positive {pos}/{tot}')
print(f'  bar: >= +0.02R and >= 6/9  ->  '
      f'{"PASSES" if (cellR.mean()-baseR.mean())>=0.02 and pos>=6 else "FAILS"}\n')

print('C. Is the direction edge big enough to matter at this geometry?')
hit=d.loc[cell,'d0.25_LONG_oppR'].notna()
print(f'  a +{(p_ep-base)*100:.2f}pp shift on a {base:.1%} base rate is a {p_ep:.1%} coin.')
print(f'  median fee at a 2-ATR stop = {(0.171/(d.f_atrPercent.median()*2)):.4f}R per round trip.')
print(f'  the edge has to clear that before anything is left.')
