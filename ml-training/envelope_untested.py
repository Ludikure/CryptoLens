#!/usr/bin/env python3
"""Two conditions I wrongly called untestable (Part 7 follow-up).

  continuation < 2 / < 3   reconstructible after all: the envelope counts 4H EMA-stack alignment and
                           direction-supporting funding, both of which are in the feature set. My
                           first proxy (momentumAlignment) was simply the wrong variable.
  macro_IMMINENT           testable against the 986 Fed releases backfilled 2026-08-22.

DAY-OF-WEEK STRATIFICATION IS MANDATORY for the macro arm. news-catalyst-test.md recorded a -10.8pp
"finding" at z=-10.4 that was entirely a day-of-week artifact: releases land on weekdays, BTC goodR
swings 34pp across the week, and a ">72h from any event" baseline systematically over-samples
weekends. Every economic calendar has this trap available.
"""
import numpy as np, pandas as pd

d = (pd.read_pickle('excursion_dataset.pkl.gz')
       .merge(pd.read_pickle('level_entry_rows.pkl.gz'), on=['symbol','timestamp'])
       .sort_values(['symbol','timestamp']).reset_index(drop=True))
d['dt']=pd.to_datetime(d.timestamp, unit='s', utc=True)
d['dow']=d.dt.dt.dayofweek
periods=pd.date_range('2022-01-01','2026-07-01',freq='6MS', tz='UTC')

# ── continuation, reconstructed the way the envelope actually computes it ──
bull4h = d.f_hStackBull.astype(bool); bear4h = d.f_hStackBear.astype(bool)
fr = d.f_fundingRateRaw.fillna(0)
bias = np.sign(d.f_tfAlignment)
cont = (bull4h.astype(int) + bear4h.astype(int)
        + (((bias > 0) & (fr < -0.00005)) | ((bias < 0) & (fr > 0.00005))).astype(int))
print(f'\ncontinuation count distribution: {cont.value_counts().sort_index().to_dict()}')

# ── macro proximity from the Fed backfill ──
ev = pd.read_csv('news_events.csv')
dcol = [c for c in ev.columns if 'date' in c.lower()][0]
ev['d'] = pd.to_datetime(ev[dcol], utc=True, errors='coerce')
ev = ev.dropna(subset=['d']).sort_values('d')
et = ev['d'].to_numpy()
idx = np.searchsorted(et, d.dt.to_numpy())
prev_h = np.where(idx>0, (d.dt.to_numpy()-et[np.clip(idx-1,0,len(et)-1)])/np.timedelta64(1,'h'), 1e9)
next_h = np.where(idx<len(et), (et[np.clip(idx,0,len(et)-1)]-d.dt.to_numpy())/np.timedelta64(1,'h'), 1e9)
d['to_event_h'] = np.minimum(prev_h, next_h)
print(f'{len(ev):,} Fed releases; bars within 4h of one: {(d.to_event_h<=4).mean():.1%}, within 24h: {(d.to_event_h<=24).mean():.1%}')

CONDS = {
  'continuation < 2 (cap LOW)':       cont < 2,
  'continuation < 3 (cap MODERATE)':  cont < 3,
  'macro IMMINENT (<=4h to Fed)':     d.to_event_h <= 4,
  'macro NEARBY (<=24h)':             d.to_event_h <= 24,
}

def sweep(stratify_dow):
    for side in ('SHORT','LONG'):
        c=f'd0.25_{side}_oppR'
        print(f'\n  --- {side} ---')
        print(f'  {"condition":>32}{"fires":>8}{"blocked":>10}{"kept":>10}{"lift":>10}{"per+":>7}{"verdict":>12}')
        for name, fires in CONDS.items():
            if fires.sum() < 500 or (~fires).sum() < 500:
                print(f'  {name:>32}{fires.mean():>8.1%}{"degenerate":>39}'); continue
            if stratify_dow:
                # Compare within each weekday, then average — kills the calendar artifact.
                lifts=[]
                for dw, g in d.groupby('dow'):
                    f2=fires.loc[g.index]
                    if f2.sum()<100 or (~f2).sum()<100: continue
                    lifts.append(g.loc[~f2,c].mean() - g[c].mean())
                lift=float(np.mean(lifts)) if lifts else np.nan
                blocked=d.loc[fires,c].mean(); kept=d.loc[~fires,c].mean()
            else:
                blocked, kept = d.loc[fires,c].mean(), d.loc[~fires,c].mean()
                lift = kept - d[c].mean()
            pos=tot=0
            for i in range(len(periods)-1):
                w=(d.dt>=periods[i])&(d.dt<periods[i+1])
                if w.sum()<2000: continue
                k,a=d.loc[w&~fires,c].mean(), d.loc[w,c].mean()
                if np.isfinite(k) and np.isfinite(a): tot+=1; pos += (k-a)>=0
            ok = np.isfinite(lift) and lift>=0.02 and pos>=6 and (~fires).mean()>=0.20
            v='EARNS IT' if ok else ('INVERTED' if np.isfinite(lift) and lift<-0.005 else 'noise')
            print(f'  {name:>32}{fires.mean():>8.1%}{blocked:>10.4f}{kept:>10.4f}{lift:>+10.4f}{f"{pos}/{tot}":>7}{v:>12}')

print('\n=== RAW ==='); sweep(False)
print('\n=== DAY-OF-WEEK STRATIFIED (the correction news-catalyst-test.md demands) ==='); sweep(True)
