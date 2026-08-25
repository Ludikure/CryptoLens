#!/usr/bin/env python3
"""Per-row realised R for the primary structure, so EV can be measured on model selections.

Same path walk as excursion_labels.py, but keeps the REALISED R of each simulated trade rather than
only the binary label: target pays +R, stop pays -1, and a timeout pays its actual 72h fill clipped
into [-1, R]. The timeout branch is the one a binary label cannot express and it is ~20-25% of rows.
"""
import glob, os
import numpy as np, pandas as pd

H, STOP_ATR, R = 72, 1.0, 5.0
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'

def rows(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)): return None
    f = pd.read_csv(fp); p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    tr = f['timestamp'].to_numpy(np.int64); fts = (tr // 1000) if tr[0] > 1e12 else tr
    pts = p['ts'].to_numpy(np.int64)
    hi, lo, cl = (p[c].to_numpy(np.float64) for c in ('high','low','close'))
    idx = np.searchsorted(pts, fts, side='left')
    ok = (idx < len(pts) - H) & (idx >= 0) & (pts[np.clip(idx,0,len(pts)-1)] == fts)
    e = f['price'].to_numpy(np.float64); a = (f['atrPercent'].to_numpy(np.float64)/100.0)*e
    ok &= np.isfinite(a) & (a > 0) & np.isfinite(e) & (e > 0)
    if ok.sum() == 0: return None
    r_ = np.where(ok)[0]; base = idx[r_]; e_, risk = e[r_], STOP_ATR*a[r_]
    offs = np.arange(1, H+1); gh, gl = hi[base[:,None]+offs], lo[base[:,None]+offs]
    exit_px = cl[base+H]; NEVER = H+10
    first = lambda m: np.where(m.any(1), m.argmax(1), NEVER)
    out = {'symbol': sym, 'timestamp': fts[r_]}
    for side in ('LONG','SHORT'):
        sg = 1.0 if side=='LONG' else -1.0
        sp = (e_ - sg*risk)[:,None]
        si = first(gl <= sp) if side=='LONG' else first(gh >= sp)
        tp = (e_ + sg*R*risk)[:,None]
        ti = first(gh >= tp) if side=='LONG' else first(gl <= tp)
        to_r = sg*(exit_px - e_)/risk
        won = ti < si; lost = (si < NEVER) & ~won
        out[f'r_{side}_{R:g}R'] = np.where(won, R, np.where(lost, -1.0, np.clip(to_r,-1.0,R)))
    return pd.DataFrame(out)

syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
d = pd.concat([x for s in syms if (x := rows(s)) is not None], ignore_index=True)
d.to_pickle('excursion_payoff_rows.pkl.gz')
print(f'wrote {len(d):,} rows; mean R  LONG {d[f"r_LONG_{R:g}R"].mean():+.4f}  SHORT {d[f"r_SHORT_{R:g}R"].mean():+.4f}')
