#!/usr/bin/env python3
"""Is the pullback result real, or an artifact? Three controls.

Part 4 found +0.0660R (SHORT) and +0.1168R (LONG) per opportunity, 9/9 periods. That is the strongest
consistency in this vault, which is precisely when to look for the mechanism rather than celebrate.

  A. CONSERVATIVE FILL   require price to trade THROUGH the level by 0.05 ATR, not merely touch it.
                         A limit order at a price the market kisses once often does not fill.
  B. DELAY ONLY          wait the same 12h, then enter AT MARKET. If this captures the benefit, the
                         effect is the DELAY, not the level.
  C. ADVERSE LEVEL       enter 0.25 ATR in the CHASE direction (buy higher / sell lower). If buying
                         dips genuinely helps, chasing should hurt by a similar magnitude. A result
                         that is positive both ways is measuring something else entirely.
"""
import glob, os
import numpy as np, pandas as pd

WAIT_H, HOLD_H = 12, 72
STOP_ATR, TP2_ATR = 2.0, 2.5
FEE, PEN = 0.171, 0.05
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
ARMS = [('market', 0.00, 'none'), ('pullback 0.25', 0.25, 'touch'),
        ('pullback 0.25 STRICT', 0.25, 'through'), ('delay 12h then market', 0.00, 'delay'),
        ('CHASE 0.25 (adverse)', -0.25, 'touch')]

def sim(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)): return None
    f = pd.read_csv(fp, low_memory=False); p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    tr = f['timestamp'].to_numpy(np.int64); fts = (tr//1000) if tr[0] > 1e12 else tr
    pts = p['ts'].to_numpy(np.int64)
    hi, lo, cl = (p[c].to_numpy(np.float64) for c in ('high','low','close'))
    span = WAIT_H + HOLD_H
    idx = np.searchsorted(pts, fts, side='left')
    ok = (idx < len(pts)-span) & (idx >= 0) & (pts[np.clip(idx,0,len(pts)-1)] == fts)
    e0 = f['price'].to_numpy(np.float64); atrp = f['atrPercent'].to_numpy(np.float64)
    a = (atrp/100.0)*e0
    ok &= np.isfinite(a) & (a>0) & np.isfinite(e0) & (e0>0)
    if ok.sum()==0: return None
    r_ = np.where(ok)[0]; base = idx[r_]; e_, atr = e0[r_], a[r_]
    NEVER = span+10
    first = lambda m: np.where(m.any(1), m.argmax(1), NEVER)
    out = {'symbol': sym, 'timestamp': fts[r_]}
    for label, depth, mode in ARMS:
        for side in ('LONG','SHORT'):
            sg = 1.0 if side=='LONG' else -1.0
            if mode == 'delay':
                filled = np.ones(len(e_), bool); fill_i = np.full(len(e_), WAIT_H)
                entry = cl[np.clip(base+WAIT_H, 0, len(cl)-1)]     # market, 12h later
            elif mode == 'none':
                filled = np.ones(len(e_), bool); fill_i = np.zeros(len(e_), int); entry = e_.copy()
            else:
                entry = e_ - sg*depth*atr
                trig = entry - sg*(PEN*atr if mode=='through' else 0.0)
                w = np.arange(1, WAIT_H+1)
                wl, wh = lo[base[:,None]+w], hi[base[:,None]+w]
                ti = first(wl <= trig[:,None]) if side=='LONG' else first(wh >= trig[:,None])
                filled = ti < NEVER; fill_i = np.where(filled, ti+1, 0)
            risk = STOP_ATR*atr
            stop = entry - sg*risk; tp = entry + sg*TP2_ATR*atr
            h = np.arange(1, HOLD_H+1)
            gi = np.clip(base[:,None]+fill_i[:,None]+h, 0, len(hi)-1)
            gh, gl = hi[gi], lo[gi]
            si = first(gl <= stop[:,None]) if side=='LONG' else first(gh >= stop[:,None])
            qi = first(gh >= tp[:,None])   if side=='LONG' else first(gl <= tp[:,None])
            ex = cl[np.clip(base+fill_i+HOLD_H, 0, len(cl)-1)]
            to_r = sg*(ex-entry)/risk; R = TP2_ATR/STOP_ATR
            won = qi < si; lost = (si < NEVER) & ~won
            r = np.where(won, R, np.where(lost,-1.0, np.clip(to_r,-1.0,R)))
            fee_r = FEE/np.clip(atrp[r_]*STOP_ATR, 0.05, None)
            out[f'{label}|{side}|fill'] = filled.astype(np.int8)
            out[f'{label}|{side}|opp'] = np.where(filled, r-fee_r, 0.0)
    return pd.DataFrame(out)

syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
d = pd.concat([x for s in syms if (x := sim(s)) is not None], ignore_index=True)
d['dt'] = pd.to_datetime(d.timestamp, unit='s')
periods = pd.date_range('2022-01-01','2026-07-01',freq='6MS')
print(f'{len(d):,} opportunities\n')
for side in ('SHORT','LONG'):
    print(f'=== {side} — R per OPPORTUNITY, net of fees ===')
    print(f'{"arm":>24}{"fill":>8}{"R/opp":>10}{"vs market":>11}{"periods+":>10}')
    b = d[f'market|{side}|opp'].mean()
    for label,_,_ in ARMS:
        fr = d[f'{label}|{side}|fill'].mean(); v = d[f'{label}|{side}|opp'].mean()
        pos=tot=0
        for i in range(len(periods)-1):
            w = (d.dt>=periods[i]) & (d.dt<periods[i+1])
            if w.sum()<2000: continue
            tot+=1; pos += (d.loc[w,f'{label}|{side}|opp'].mean() - d.loc[w,f'market|{side}|opp'].mean()) >= 0
        print(f'{label:>24}{fr:>8.1%}{v:>10.4f}{v-b:>+11.4f}{f"{pos}/{tot}":>10}')
    print()
