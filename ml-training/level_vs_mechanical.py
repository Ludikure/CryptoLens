#!/usr/bin/env python3
"""Do STRUCTURAL levels beat a mechanical pullback? (Part 5, pre-declared)

All arms are limit orders with a 12h wait; unfilled scores exactly 0 and is counted, so fill-rate
differences are paid for. Swing levels are computed from CLOSED bars strictly before the signal bar.
"""
import glob, os
import numpy as np, pandas as pd

WAIT_H, HOLD_H = 12, 72
STOP_ATR, TP2_ATR, FEE = 2.0, 2.5, 0.171
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'

def sim(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)): return None
    f = pd.read_csv(fp, low_memory=False); p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    tr = f['timestamp'].to_numpy(np.int64); fts = (tr//1000) if tr[0] > 1e12 else tr
    pts = p['ts'].to_numpy(np.int64)
    hi, lo, cl = (p[c].to_numpy(np.float64) for c in ('high','low','close'))
    span = WAIT_H+HOLD_H
    idx = np.searchsorted(pts, fts, side='left')
    ok = (idx < len(pts)-span) & (idx >= 73) & (pts[np.clip(idx,0,len(pts)-1)] == fts)
    e0 = f['price'].to_numpy(np.float64); atrp = f['atrPercent'].to_numpy(np.float64)
    a = (atrp/100.0)*e0
    ok &= np.isfinite(a)&(a>0)&np.isfinite(e0)&(e0>0)
    if ok.sum()==0: return None
    r_=np.where(ok)[0]; base=idx[r_]; e_,atr=e0[r_],a[r_]
    NEVER=span+10; first=lambda m: np.where(m.any(1), m.argmax(1), NEVER)

    # Swing levels from bars STRICTLY BEFORE the signal bar (no lookahead).
    def swing(n):
        w = np.arange(-n, 0)
        return lo[base[:,None]+w].min(1), hi[base[:,None]+w].max(1)
    sw24_lo, sw24_hi = swing(24); sw72_lo, sw72_hi = swing(72)

    arms = {'market': (e_, e_),
            'mech 0.25 ATR': (e_-0.25*atr, e_+0.25*atr),
            'swing 24h': (sw24_lo, sw24_hi),
            'swing 72h': (sw72_lo, sw72_hi)}
    out = {'symbol': sym, 'timestamp': fts[r_]}
    for label,(elong,eshort) in arms.items():
        for side in ('LONG','SHORT'):
            sg = 1.0 if side=='LONG' else -1.0
            entry = (elong if side=='LONG' else eshort).copy()
            # A "pullback" must be against the direction; if the level is the wrong side of price
            # it is a breakout entry, which is a different trade — exclude rather than silently mix.
            wrong = (entry > e_) if side=='LONG' else (entry < e_)
            if label=='market':
                filled=np.ones(len(e_),bool); fill_i=np.zeros(len(e_),int)
            else:
                w=np.arange(1,WAIT_H+1); wl,wh = lo[base[:,None]+w], hi[base[:,None]+w]
                ti = first(wl<=entry[:,None]) if side=='LONG' else first(wh>=entry[:,None])
                filled=(ti<NEVER)&~wrong; fill_i=np.where(filled, ti+1, 0)
            risk=STOP_ATR*atr; stop=entry-sg*risk; tp=entry+sg*TP2_ATR*atr
            h=np.arange(1,HOLD_H+1); gi=np.clip(base[:,None]+fill_i[:,None]+h,0,len(hi)-1)
            gh,gl=hi[gi],lo[gi]
            si = first(gl<=stop[:,None]) if side=='LONG' else first(gh>=stop[:,None])
            qi = first(gh>=tp[:,None])   if side=='LONG' else first(gl<=tp[:,None])
            ex = cl[np.clip(base+fill_i+HOLD_H,0,len(cl)-1)]
            to_r=sg*(ex-entry)/risk; R=TP2_ATR/STOP_ATR
            won=qi<si; lost=(si<NEVER)&~won
            r=np.where(won,R,np.where(lost,-1.0,np.clip(to_r,-1.0,R)))
            fee=FEE/np.clip(atrp[r_]*STOP_ATR,0.05,None)
            out[f'{label}|{side}|fill']=filled.astype(np.int8)
            out[f'{label}|{side}|opp']=np.where(filled, r-fee, 0.0)
            out[f'{label}|{side}|depth']=np.where(filled, np.abs(e_-entry)/atr, np.nan)
    return pd.DataFrame(out)

syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
d = pd.concat([x for s in syms if (x := sim(s)) is not None], ignore_index=True)
d['dt']=pd.to_datetime(d.timestamp, unit='s')
periods=pd.date_range('2022-01-01','2026-07-01',freq='6MS')
ARMS=['market','mech 0.25 ATR','swing 24h','swing 72h']
print(f'{len(d):,} opportunities\n')
for side in ('SHORT','LONG'):
    print(f'=== {side} — R per OPPORTUNITY, net of fees ===')
    print(f'{"arm":>16}{"fill":>8}{"mean depth":>12}{"R/opp":>10}{"vs mech":>10}{"periods+ vs mech":>18}')
    mech = d[f'mech 0.25 ATR|{side}|opp'].mean()
    for a in ARMS:
        fr=d[f'{a}|{side}|fill'].mean(); v=d[f'{a}|{side}|opp'].mean()
        dep=d[f'{a}|{side}|depth'].mean()
        pos=tot=0
        for i in range(len(periods)-1):
            w=(d.dt>=periods[i])&(d.dt<periods[i+1])
            if w.sum()<2000: continue
            tot+=1; pos += (d.loc[w,f'{a}|{side}|opp'].mean()-d.loc[w,f'mech 0.25 ATR|{side}|opp'].mean())>=0
        print(f'{a:>16}{fr:>8.1%}{dep:>12.2f}{v:>10.4f}{v-mech:>+10.4f}{f"{pos}/{tot}":>18}')
    print()
