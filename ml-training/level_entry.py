#!/usr/bin/env python3
"""Does entering at a LEVEL beat entering at market? (Part 4, frozen at 8df5b21)

At each bar: place an entry depth x ATR against the direction, wait up to 12h for a touch, then run
stop (2 ATR) and targets (1.5 / 2.5 ATR) FROM THE FILL. Unfilled setups are recorded, not discarded.

THE PRIMARY NUMBER IS R PER OPPORTUNITY, not per filled trade. A pullback rule only trades when price
comes back, so it systematically misses the bars where price ran away -- the strongest moves. Judging
it on filled trades alone measures the survivors of its own selection.
"""
import glob, os
import numpy as np, pandas as pd

WAIT_H, HOLD_H = 12, 72
STOP_ATR, TP1_ATR, TP2_ATR = 2.0, 1.5, 2.5
DEPTHS = [0.00, 0.25, 0.50, 1.00]
FEE = 0.171
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'

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
    out = {'symbol': sym, 'timestamp': fts[r_], 'atrPct': atrp[r_]}
    NEVER = span + 10
    first = lambda m: np.where(m.any(1), m.argmax(1), NEVER)

    for depth in DEPTHS:
        for side in ('LONG','SHORT'):
            sg = 1.0 if side=='LONG' else -1.0
            entry = e_ - sg*depth*atr                  # pullback AGAINST the direction
            if depth == 0.0:
                filled = np.ones(len(e_), bool); fill_i = np.zeros(len(e_), int)
            else:
                w = np.arange(1, WAIT_H+1)
                wl, wh = lo[base[:,None]+w], hi[base[:,None]+w]
                ti = first(wl <= entry[:,None]) if side=='LONG' else first(wh >= entry[:,None])
                filled = ti < NEVER; fill_i = np.where(filled, ti+1, 0)
            risk = STOP_ATR*atr
            stop = entry - sg*risk
            tp2  = entry + sg*TP2_ATR*atr
            # Hold window starts at the FILL bar, not at the signal bar.
            h = np.arange(1, HOLD_H+1)
            gi = base[:,None] + fill_i[:,None] + h
            gi = np.clip(gi, 0, len(hi)-1)
            gh, gl = hi[gi], lo[gi]
            si = first(gl <= stop[:,None]) if side=='LONG' else first(gh >= stop[:,None])
            qi = first(gh >= tp2[:,None])  if side=='LONG' else first(gl <= tp2[:,None])
            exit_px = cl[np.clip(base+fill_i+HOLD_H, 0, len(cl)-1)]
            to_r = sg*(exit_px-entry)/risk
            R = TP2_ATR/STOP_ATR
            won = qi < si; lost = (si < NEVER) & ~won
            r = np.where(won, R, np.where(lost, -1.0, np.clip(to_r,-1.0,R)))
            fee_r = FEE/np.clip(atrp[r_]*STOP_ATR, 0.05, None)
            out[f'd{depth}_{side}_filled'] = filled.astype(np.int8)
            # Unfilled opportunities score EXACTLY 0 -- no trade, no gain, no loss. That is what
            # makes per-opportunity comparable across depths with different fill rates.
            out[f'd{depth}_{side}_oppR'] = np.where(filled, r - fee_r, 0.0)
            out[f'd{depth}_{side}_fillR'] = np.where(filled, r - fee_r, np.nan)
    return pd.DataFrame(out)

syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
d = pd.concat([x for s in syms if (x := sim(s)) is not None], ignore_index=True)
d.to_pickle('level_entry_rows.pkl.gz')
d['dt'] = pd.to_datetime(d.timestamp, unit='s')
periods = pd.date_range('2022-01-01','2026-07-01',freq='6MS')

print(f'{len(d):,} opportunities, {d.symbol.nunique()} symbols\n')
for side in ('SHORT','LONG'):
    print(f'=== {side} — TP2, net of fees ===')
    print(f'{"depth":>8}{"fill rate":>11}{"R per FILLED":>14}{"R per OPPORTUNITY":>19}{"vs market":>11}{"periods+":>10}')
    b = d[f'd0.0_{side}_oppR'].mean()
    for dep in DEPTHS:
        fr = d[f'd{dep}_{side}_filled'].mean()
        pf = d[f'd{dep}_{side}_fillR'].mean()
        po = d[f'd{dep}_{side}_oppR'].mean()
        pos=tot=0
        for i in range(len(periods)-1):
            w = (d.dt>=periods[i]) & (d.dt<periods[i+1])
            if w.sum() < 2000: continue
            tot += 1; pos += (d.loc[w,f'd{dep}_{side}_oppR'].mean() - d.loc[w,f'd0.0_{side}_oppR'].mean()) >= 0
        print(f'{dep:>8.2f}{fr:>11.1%}{pf:>14.4f}{po:>19.4f}{po-b:>+11.4f}{f"{pos}/{tot}":>10}')
    print()
