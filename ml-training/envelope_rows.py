#!/usr/bin/env python3
"""Barrier outcomes at the APP'S REAL setup geometry, not the 5R research structure.

The envelope gates the LLM's setups, and those use the tighter bands: stop 2.0 ATR, TP1 1.5 ATR,
TP2 2.5 ATR -- i.e. TP1 at 0.75R and TP2 at 1.25R. Everything measured so far used a 1 ATR stop and a
5R target, which is a different instrument that happens to share a direction.

Emits realised R for both targets, per side, plus the timeout branch priced at its actual fill.
"""
import glob, os
import numpy as np, pandas as pd

H = 72
STOP_ATR = 2.0                       # the app's stop
TARGETS = {'tp1': 1.5, 'tp2': 2.5}   # in ATR -> 0.75R and 1.25R against a 2 ATR stop
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'

def rows(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)): return None
    f = pd.read_csv(fp, low_memory=False); p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    tr = f['timestamp'].to_numpy(np.int64); fts = (tr//1000) if tr[0] > 1e12 else tr
    pts = p['ts'].to_numpy(np.int64)
    hi, lo, cl = (p[c].to_numpy(np.float64) for c in ('high','low','close'))
    idx = np.searchsorted(pts, fts, side='left')
    ok = (idx < len(pts)-H) & (idx >= 0) & (pts[np.clip(idx,0,len(pts)-1)] == fts)
    e = f['price'].to_numpy(np.float64); a = (f['atrPercent'].to_numpy(np.float64)/100.0)*e
    ok &= np.isfinite(a) & (a > 0) & np.isfinite(e) & (e > 0)
    if ok.sum() == 0: return None
    r_ = np.where(ok)[0]; base = idx[r_]; e_ = e[r_]; atr = a[r_]
    risk = STOP_ATR * atr
    offs = np.arange(1, H+1); gh, gl = hi[base[:,None]+offs], lo[base[:,None]+offs]
    exit_px = cl[base+H]; NEVER = H+10
    first = lambda m: np.where(m.any(1), m.argmax(1), NEVER)
    out = {'symbol': sym, 'timestamp': fts[r_]}
    for side in ('LONG','SHORT'):
        sg = 1.0 if side=='LONG' else -1.0
        sp = (e_ - sg*risk)[:,None]
        si = first(gl <= sp) if side=='LONG' else first(gh >= sp)
        to_r = sg*(exit_px - e_)/risk
        for name, atr_mult in TARGETS.items():
            R = atr_mult / STOP_ATR                       # target in R units
            tp = (e_ + sg*atr_mult*atr)[:,None]
            ti = first(gh >= tp) if side=='LONG' else first(gl <= tp)
            won = ti < si; lost = (si < NEVER) & ~won
            out[f'{name}_{side}_R'] = np.where(won, R, np.where(lost, -1.0, np.clip(to_r,-1.0,R)))
            out[f'{name}_{side}_hit'] = won.astype(np.int8)
    return pd.DataFrame(out)

syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
d = pd.concat([x for s in syms if (x := rows(s)) is not None], ignore_index=True)
d.to_pickle('envelope_payoff_rows.pkl.gz')
print(f'{len(d):,} rows, {d.symbol.nunique()} symbols  (stop {STOP_ATR} ATR)')
for n, m in TARGETS.items():
    R = m/STOP_ATR
    print(f'  {n} @ {m} ATR = {R:.2f}R:  hit L {d[f"{n}_LONG_hit"].mean():.4f} '
          f'S {d[f"{n}_SHORT_hit"].mean():.4f}   meanR L {d[f"{n}_LONG_R"].mean():+.4f} '
          f'S {d[f"{n}_SHORT_R"].mean():+.4f}')
