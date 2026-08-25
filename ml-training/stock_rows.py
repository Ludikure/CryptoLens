#!/usr/bin/env python3
"""Part 8 rows: stock entry-discipline outcomes + the earnings gap metric.

Pre-declared in docs/research/envelope-rules.md (frozen at 8396f25).

Mirrors level_entry.py exactly, with two declared changes:
  - horizon held at 3/18 ATR-PERIODS rather than clock hours. A stock "4H" bar is ET-session
    aggregated (two per 6.5h session = 3.25 trading hours), so 3/18 periods is WAIT 10 / HOLD 59
    hourly bars, not 12/72.
  - fee 0.05% round trip (retail commission-free + spread), not crypto's 0.171% derivatives taker.

Also emits maxGapATR -- the largest overnight |open - prior close| inside the hold window, in ATR
units. That is the earnings gates' OWN claim ("gap risk, stop will not hold") and the only way to
test them, since by the Part 6 principle an EV null cannot refute an exogenous-event guard.
"""
import glob, os
import numpy as np, pandas as pd

WAIT_H, HOLD_H = 10, 59          # 3 / 18 ATR-periods at 3.25 trading hours per stock 4H bar
HOLD_ALT = 72                    # declared robustness re-run (22 periods)
STOP_ATR, TP2_ATR = 2.0, 2.5
DEPTHS = [0.00, 0.25]
FEE = 0.05
FEAT, PATH = 'csv_exports_v14_stocks', 'stock_klines'

KEEP = ['timestamp', 'price', 'atrPercent', 'relStrengthVsSpy', 'dRsiDelta1', 'dRsiDelta',
        'dStochCross', 'hStochCross', 'regimeCode', 'biasAlignment', 'tfAlignment',
        'fwdMaxFavR', 'dailyBias', 'fourHBias']


def sim(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)):
        return None
    f = pd.read_csv(fp, low_memory=False)
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    tr = f['timestamp'].to_numpy(np.int64)
    fts = (tr // 1000) if tr[0] > 1e12 else tr
    pts = p['ts'].to_numpy(np.int64)
    op, hi, lo, cl = (p[c].to_numpy(np.float64) for c in ('open', 'high', 'low', 'close'))
    span = WAIT_H + max(HOLD_H, HOLD_ALT)
    idx = np.searchsorted(pts, fts, side='left')
    ok = (idx < len(pts) - span) & (idx >= 0) & (pts[np.clip(idx, 0, len(pts) - 1)] == fts)
    e0 = f['price'].to_numpy(np.float64)
    atrp = f['atrPercent'].to_numpy(np.float64)
    a = (atrp / 100.0) * e0
    ok &= np.isfinite(a) & (a > 0) & np.isfinite(e0) & (e0 > 0)
    if ok.sum() == 0:
        return None
    r_ = np.where(ok)[0]
    base = idx[r_]
    e_, atr = e0[r_], a[r_]
    NEVER = span + 10
    first = lambda m: np.where(m.any(1), m.argmax(1), NEVER)

    out = {'symbol': sym, 'timestamp': fts[r_]}
    for c in KEEP:
        if c in f.columns and c != 'timestamp':
            out['f_' + c] = f[c].to_numpy()[r_]

    # Largest overnight gap inside the hold window, in ATR units. Intraday hourly bars gap by
    # ~nothing, so the max naturally selects the session boundary.
    gwin = base[:, None] + np.arange(1, HOLD_H + 1)
    gwin = np.clip(gwin, 1, len(op) - 1)
    out['maxGapATR'] = (np.abs(op[gwin] - cl[gwin - 1]).max(1)) / atr

    for hold, tag in ((HOLD_H, ''), (HOLD_ALT, '_h72')):
        for depth in DEPTHS:
            for side in ('LONG', 'SHORT'):
                sg = 1.0 if side == 'LONG' else -1.0
                entry = e_ - sg * depth * atr
                if depth == 0.0:
                    filled = np.ones(len(e_), bool); fill_i = np.zeros(len(e_), int)
                else:
                    w = np.arange(1, WAIT_H + 1)
                    wl, wh = lo[base[:, None] + w], hi[base[:, None] + w]
                    ti = first(wl <= entry[:, None]) if side == 'LONG' else first(wh >= entry[:, None])
                    filled = ti < NEVER; fill_i = np.where(filled, ti + 1, 0)
                risk = STOP_ATR * atr
                stop = entry - sg * risk
                tp2 = entry + sg * TP2_ATR * atr
                gi = np.clip(base[:, None] + fill_i[:, None] + np.arange(1, hold + 1), 0, len(hi) - 1)
                gh, gl = hi[gi], lo[gi]
                si = first(gl <= stop[:, None]) if side == 'LONG' else first(gh >= stop[:, None])
                qi = first(gh >= tp2[:, None]) if side == 'LONG' else first(gl <= tp2[:, None])
                exit_px = cl[np.clip(base + fill_i + hold, 0, len(cl) - 1)]
                to_r = sg * (exit_px - entry) / risk
                R = TP2_ATR / STOP_ATR
                won = qi < si; lost = (si < NEVER) & ~won
                r = np.where(won, R, np.where(lost, -1.0, np.clip(to_r, -1.0, R)))
                fee_r = FEE / np.clip(atrp[r_] * STOP_ATR, 0.05, None)
                out[f'd{depth}_{side}_filled{tag}'] = filled.astype(np.int8)
                # Unfilled opportunities score EXACTLY 0 -- no trade, no gain, no loss.
                out[f'd{depth}_{side}_oppR{tag}'] = np.where(filled, r - fee_r, 0.0)
                out[f'd{depth}_{side}_fillR{tag}'] = np.where(filled, r - fee_r, np.nan)
                if tag == '':   # fee sensitivity only needed on the primary horizon
                    for fname, fv in (('_fee0', 0.0), ('_fee171', 0.171)):
                        fr2 = fv / np.clip(atrp[r_] * STOP_ATR, 0.05, None)
                        out[f'd{depth}_{side}_oppR{fname}'] = np.where(filled, r - fr2, 0.0)
    return pd.DataFrame(out)


syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
d = pd.concat([x for s in syms if (x := sim(s)) is not None], ignore_index=True)
d.to_pickle('stock_entry_rows.pkl.gz')

d['dt'] = pd.to_datetime(d.timestamp, unit='s')
print(f'{len(d):,} opportunities, {d.symbol.nunique()} symbols  '
      f'({d.dt.min().date()} → {d.dt.max().date()})\n')
print(f'{"":>8}{"fill rate":>11}{"R per FILLED":>14}{"R per OPPORTUNITY":>19}{"vs market":>11}')
for side in ('SHORT', 'LONG'):
    b = d[f'd0.0_{side}_oppR'].mean()
    for dep in DEPTHS:
        print(f'{side if dep == 0.0 else "":>6} {dep:>5.2f}'
              f'{d[f"d{dep}_{side}_filled"].mean():>11.1%}'
              f'{d[f"d{dep}_{side}_fillR"].mean():>14.4f}'
              f'{d[f"d{dep}_{side}_oppR"].mean():>19.4f}'
              f'{d[f"d{dep}_{side}_oppR"].mean() - b:>+11.4f}')
print(f'\nmaxGapATR: median {d.maxGapATR.median():.3f}  '
      f'P(>=2 ATR) {(d.maxGapATR >= 2).mean():.4f}')
