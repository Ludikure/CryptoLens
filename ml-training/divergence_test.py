#!/usr/bin/env python3
"""Does RSI divergence predict anything? (Part 6, frozen at 7cb700c)

Three questions kept separate: DIRECTION (vs the real base rate, not 50%), MONEY (the trade classical
TA implies, entered with the Part 4/5 discipline), and THE APP'S RULE (does flatting on it help?).
"""
import numpy as np, pandas as pd
from scipy import stats

d = (pd.read_pickle('excursion_dataset.pkl.gz')
       .merge(pd.read_pickle('level_entry_rows.pkl.gz'), on=['symbol','timestamp'])
       .merge(pd.read_pickle('envelope_payoff_rows.pkl.gz'), on=['symbol','timestamp'])
       .sort_values('timestamp').reset_index(drop=True))
d['dt'] = pd.to_datetime(d.timestamp, unit='s')
d['up24'] = (d.f_fwdReturn24H > 0).astype(int)
periods = pd.date_range('2022-01-01','2026-07-01',freq='6MS')

for col, label in (('f_dDivergence','DAILY'), ('f_hDivergence','4H')):
    bull, bear, none = d[col]==1, d[col]==-1, d[col]==0
    base = d.up24.mean()
    print(f'\n{"="*88}\n{label} RSI DIVERGENCE   (bull {bull.mean():.1%}, bear {bear.mean():.1%} of bars)\n{"="*88}')

    # ── A. DIRECTION, against the REAL base rate ──
    print(f'A. DIRECTION — unconditional P(up 24h) = {base:.4f}  (NOT 0.50)')
    print(f'{"state":>12}{"n":>9}{"P(up24)":>10}{"vs base":>10}{"p-value":>11}  classical TA expects')
    for st, m, exp in (('bullish div', bull, 'UP'), ('bearish div', bear, 'DOWN'), ('no div', none, '—')):
        n = m.sum(); p = d.loc[m,'up24'].mean()
        pv = stats.binomtest(int(d.loc[m,'up24'].sum()), n, base).pvalue if n else np.nan
        print(f'{st:>12}{n:>9,}{p:>10.4f}{p-base:>+10.4f}{pv:>11.2e}  {exp}')

    # ── B. MONEY — the trade classical TA implies, entered on a 0.25 ATR pullback ──
    print(f'\nB. MONEY — the REVERSAL trade (LONG on bullish, SHORT on bearish), 0.25 ATR pullback')
    print(f'{"arm":>26}{"n":>9}{"R/opp":>10}{"vs no-div":>11}{"periods+":>10}')
    rev = pd.Series(np.nan, index=d.index)
    rev[bull] = d.loc[bull,'d0.25_LONG_oppR']; rev[bear] = d.loc[bear,'d0.25_SHORT_oppR']
    con = pd.Series(np.nan, index=d.index)          # the OPPOSITE: continuation
    con[bull] = d.loc[bull,'d0.25_SHORT_oppR']; con[bear] = d.loc[bear,'d0.25_LONG_oppR']
    nod = pd.concat([d.loc[none,'d0.25_LONG_oppR'], d.loc[none,'d0.25_SHORT_oppR']]).mean()
    for nm, ser in (('REVERSAL (classical TA)', rev), ('CONTINUATION (opposite)', con)):
        v = ser.mean(); pos=tot=0
        for i in range(len(periods)-1):
            w = (d.dt>=periods[i]) & (d.dt<periods[i+1])
            if w.sum()<2000: continue
            sv = ser[w].mean()
            if np.isfinite(sv): tot+=1; pos += (sv-nod) >= 0
        print(f'{nm:>26}{ser.notna().sum():>9,}{v:>10.4f}{v-nod:>+11.4f}{f"{pos}/{tot}":>10}')
    print(f'{"(no-div baseline)":>26}{"":>9}{nod:>10.4f}')

    # ── C. THE APP'S RULE — does flatting on divergence help what remains? ──
    print(f'\nC. THE APP\'S RULE — flat when divergence fires; does the remainder improve?')
    print(f'{"side":>8}{"blocked bars":>14}{"kept bars":>12}{"lift":>10}{"periods+":>10}')
    fires = bull | bear
    for side in ('SHORT','LONG'):
        c = f'd0.25_{side}_oppR'
        blocked, kept, allb = d.loc[fires,c].mean(), d.loc[~fires,c].mean(), d[c].mean()
        pos=tot=0
        for i in range(len(periods)-1):
            w = (d.dt>=periods[i]) & (d.dt<periods[i+1])
            if w.sum()<2000: continue
            k, a = d.loc[w&~fires,c].mean(), d.loc[w,c].mean()
            if np.isfinite(k) and np.isfinite(a): tot+=1; pos += (k-a) >= 0
        print(f'{side:>8}{blocked:>14.4f}{kept:>12.4f}{kept-allb:>+10.4f}{f"{pos}/{tot}":>10}')
