#!/usr/bin/env python3
"""The two ACTUAL envelope rules, not the raw flag (Part 6 follow-up, same pre-declared bar).

  divergence_escalated_6+_candles  -> divergence in the SAME direction on 6+ consecutive bars
  divergence_against_bias          -> divergence sign OPPOSING the multi-timeframe bias

Both are hard AUTO-FLATs today (the second via ANY_KILLED). Same question as Part 6C: does blocking
these bars improve the bars that REMAIN? Entry is the Part 4/5 discipline (0.25 ATR pullback,
unfilled = 0), so the market-entry problem that made Parts 1-3 uninformative does not apply.
"""
import numpy as np, pandas as pd

d = (pd.read_pickle('excursion_dataset.pkl.gz')
       .merge(pd.read_pickle('level_entry_rows.pkl.gz'), on=['symbol','timestamp'])
       .sort_values(['symbol','timestamp']).reset_index(drop=True))
d['dt'] = pd.to_datetime(d.timestamp, unit='s')
periods = pd.date_range('2022-01-01','2026-07-01',freq='6MS')

def run_length(g):
    """Consecutive bars with the SAME non-zero divergence sign, per symbol."""
    v = g.to_numpy(); out = np.zeros(len(v), int); run = 0
    for i in range(len(v)):
        if v[i] != 0 and i > 0 and v[i] == v[i-1]: run += 1
        elif v[i] != 0: run = 1
        else: run = 0
        out[i] = run
    return pd.Series(out, index=g.index)

for col, label in (('f_dDivergence','DAILY'), ('f_hDivergence','4H')):
    d[f'{col}_run'] = d.groupby('symbol', group_keys=False)[col].apply(run_length)

bias = np.sign(d.f_tfAlignment)          # +1 bullish, -1 bearish, 0 none
CONDS = {}
for col, label in (('f_dDivergence','daily'), ('f_hDivergence','4H')):
    CONDS[f'escalated 6+ ({label})'] = d[f'{col}_run'] >= 6
    CONDS[f'against bias ({label})']  = (d[col] != 0) & (bias != 0) & (np.sign(d[col]) != bias)
CONDS['escalated 6+ (either TF)'] = (d['f_dDivergence_run'] >= 6) | (d['f_hDivergence_run'] >= 6)
CONDS['against bias (either TF)'] = (((d.f_dDivergence != 0) & (np.sign(d.f_dDivergence) != bias)) |
                                     ((d.f_hDivergence != 0) & (np.sign(d.f_hDivergence) != bias))) & (bias != 0)

print(f'{len(d):,} bars\n')
for side in ('SHORT','LONG'):
    c = f'd0.25_{side}_oppR'
    allb = d[c].mean()
    print(f'=== {side} — does the FLAT improve what remains?  (baseline {allb:+.4f}R) ===')
    print(f'{"envelope rule":>28}{"fires":>8}{"blocked":>10}{"kept":>10}{"lift":>10}{"periods+":>10}{"verdict":>12}')
    for name, fires in CONDS.items():
        if fires.sum() < 500:
            print(f'{name:>28}{fires.mean():>8.2%}{"too rare to judge":>42}'); continue
        blocked, kept = d.loc[fires,c].mean(), d.loc[~fires,c].mean()
        lift = kept - allb
        pos=tot=0
        for i in range(len(periods)-1):
            w = (d.dt>=periods[i]) & (d.dt<periods[i+1])
            if w.sum()<2000: continue
            k, a = d.loc[w&~fires,c].mean(), d.loc[w,c].mean()
            if np.isfinite(k) and np.isfinite(a): tot+=1; pos += (k-a) >= 0
        ok = lift >= 0.02 and tot > 0 and pos >= 6
        print(f'{name:>28}{fires.mean():>8.2%}{blocked:>10.4f}{kept:>10.4f}{lift:>+10.4f}'
              f'{f"{pos}/{tot}":>10}{("JUSTIFIED" if ok else "unsupported"):>12}')
    print()
