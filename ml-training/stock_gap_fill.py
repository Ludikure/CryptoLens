#!/usr/bin/env python3
"""Part 8 follow-up: what the EV test could not see, by construction.

stock_rows.py prices every stopped trade at EXACTLY -1R. Real stops do not fill at the stop price
when the market gaps through them overnight -- and the earnings variance test just measured that
P(overnight gap >= 2 ATR) runs 5-7x baseline inside the earnings windows. So the earnings EV null is
an ARTIFACT of the fill assumption, not evidence that the gates guard nothing.

This re-prices stopped trades at the actual fill: if the breaching bar OPENED beyond the stop, the
fill is that open, not the stop. Then re-runs the earnings arms on the honest number.

Also settles the short gate's nan: how often do all three confirmations actually fire together?
"""
import glob, json, os
import numpy as np, pandas as pd

WAIT_H, HOLD_H = 10, 59
STOP_ATR, TP2_ATR, FEE = 2.0, 2.5, 0.05
DEPTH = 0.25
FEAT, PATH = 'csv_exports_v14_stocks', 'stock_klines'


def sim(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)): return None
    f = pd.read_csv(fp, low_memory=False, usecols=['timestamp', 'price', 'atrPercent'])
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    tr = f['timestamp'].to_numpy(np.int64); fts = (tr // 1000) if tr[0] > 1e12 else tr
    pts = p['ts'].to_numpy(np.int64)
    op, hi, lo, cl = (p[c].to_numpy(np.float64) for c in ('open', 'high', 'low', 'close'))
    span = WAIT_H + HOLD_H
    idx = np.searchsorted(pts, fts, side='left')
    ok = (idx < len(pts) - span) & (idx >= 0) & (pts[np.clip(idx, 0, len(pts) - 1)] == fts)
    e0 = f['price'].to_numpy(np.float64); atrp = f['atrPercent'].to_numpy(np.float64)
    a = (atrp / 100.0) * e0
    ok &= np.isfinite(a) & (a > 0) & np.isfinite(e0) & (e0 > 0)
    if ok.sum() == 0: return None
    r_ = np.where(ok)[0]; base = idx[r_]; e_, atr = e0[r_], a[r_]
    NEVER = span + 10
    first = lambda m: np.where(m.any(1), m.argmax(1), NEVER)
    out = {'symbol': sym, 'timestamp': fts[r_]}

    for side in ('LONG', 'SHORT'):
        sg = 1.0 if side == 'LONG' else -1.0
        entry = e_ - sg * DEPTH * atr
        w = np.arange(1, WAIT_H + 1)
        wl, wh = lo[base[:, None] + w], hi[base[:, None] + w]
        ti = first(wl <= entry[:, None]) if side == 'LONG' else first(wh >= entry[:, None])
        filled = ti < NEVER; fill_i = np.where(filled, ti + 1, 0)
        risk = STOP_ATR * atr
        stop = entry - sg * risk
        tp2 = entry + sg * TP2_ATR * atr
        gi = np.clip(base[:, None] + fill_i[:, None] + np.arange(1, HOLD_H + 1), 0, len(hi) - 1)
        gh, gl, go = hi[gi], lo[gi], op[gi]
        si = first(gl <= stop[:, None]) if side == 'LONG' else first(gh >= stop[:, None])
        qi = first(gh >= tp2[:, None]) if side == 'LONG' else first(gl <= tp2[:, None])
        exit_px = cl[np.clip(base + fill_i + HOLD_H, 0, len(cl) - 1)]
        to_r = sg * (exit_px - entry) / risk
        R = TP2_ATR / STOP_ATR
        won = qi < si; lost = (si < NEVER) & ~won

        # THE HONEST FILL: the stop fills at the breaching bar's OPEN when that open is already
        # beyond the stop (an overnight gap), otherwise at the stop price itself.
        rows = np.arange(len(e_))
        si_c = np.clip(si, 0, HOLD_H - 1)
        gap_open = go[rows, si_c]
        through = (gap_open < stop) if side == 'LONG' else (gap_open > stop)
        fill_px = np.where(lost & through, gap_open, stop)
        r_stop = sg * (fill_px - entry) / risk          # <= -1 when it gapped through

        fee_r = FEE / np.clip(atrp[r_] * STOP_ATR, 0.05, None)
        r_ideal = np.where(won, R, np.where(lost, -1.0, np.clip(to_r, -1.0, R)))
        r_real = np.where(won, R, np.where(lost, r_stop, np.clip(to_r, -1.0, R)))
        out[f'{side}_filled'] = filled.astype(np.int8)
        out[f'{side}_idealR'] = np.where(filled, r_ideal - fee_r, 0.0)
        out[f'{side}_realR'] = np.where(filled, r_real - fee_r, 0.0)
        out[f'{side}_slipR'] = np.where(filled & lost, np.minimum(r_stop + 1.0, 0.0), 0.0)
        out[f'{side}_gapped'] = (filled & lost & through).astype(np.int8)
        out[f'{side}_stopped'] = (filled & lost).astype(np.int8)
    return pd.DataFrame(out)


syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
d = pd.concat([x for s in syms if (x := sim(s)) is not None], ignore_index=True)
d['dt'] = pd.to_datetime(d.timestamp, unit='s')

ed = json.load(open('../CryptoLens/Resources/earnings_history.json'))
fwd = np.full(len(d), 9999.0)
for sym, g in d.groupby('symbol', sort=False):
    dates = ed.get(sym)
    if not dates: continue
    et = np.sort(pd.to_datetime(pd.Series(dates)).values); ts = g.dt.to_numpy()
    j = np.searchsorted(et, ts, side='left'); okj = j < len(et)
    v = np.full(len(g), 9999.0)
    v[okj] = (et[j[okj]] - ts[okj]) / np.timedelta64(1, 'D')
    fwd[g.index.to_numpy()] = v
d['earn_fwd_d'] = fwd
known = d.earn_fwd_d < 9999
WIN = {'0-2d': (d.earn_fwd_d >= 0) & (d.earn_fwd_d <= 2),
       '3-7d': (d.earn_fwd_d > 2) & (d.earn_fwd_d <= 7),
       '8-14d': (d.earn_fwd_d > 7) & (d.earn_fwd_d <= 14),
       '>14d (baseline)': known & (d.earn_fwd_d > 14)}
periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')

print(f'{len(d):,} opportunities, {d.symbol.nunique()} symbols\n')
print('=== WHAT THE -1R FILL ASSUMPTION HIDES ===')
print(f'{"":>18}{"stops":>9}{"gapped thru":>13}{"mean slip":>11}{"idealR":>10}{"realR":>10}{"cost":>10}')
for side in ('SHORT', 'LONG'):
    print(f'  --- {side} ---')
    for name, m in WIN.items():
        m = m & known
        st = d.loc[m, f'{side}_stopped'].sum()
        gp = d.loc[m, f'{side}_gapped'].sum()
        slip = d.loc[m & (d[f'{side}_stopped'] == 1), f'{side}_slipR'].mean()
        i_, r_ = d.loc[m, f'{side}_idealR'].mean(), d.loc[m, f'{side}_realR'].mean()
        print(f'  {name:>16}{st:>9,}{gp / max(st, 1):>12.1%}{slip:>11.3f}'
              f'{i_:>10.4f}{r_:>10.4f}{r_ - i_:>+10.4f}')

print('\n=== EARNINGS GATES RE-TESTED ON THE HONEST FILL ===')
print('Same pre-declared bar: lift >= +0.02R, >= 6/9 periods, kept coverage >= 20%.\n')
for side in ('SHORT', 'LONG'):
    print(f'  --- {side} ---')
    print(f'  {"window":>16}{"fires":>8}{"blocked":>10}{"kept":>10}{"lift":>10}{"per+":>7}{"verdict":>10}')
    c = f'{side}_realR'
    for name in ('0-2d', '3-7d', '8-14d'):
        fires = WIN[name] & known
        blocked, kept = d.loc[fires, c].mean(), d.loc[~fires, c].mean()
        lift = kept - d[c].mean()
        pos = tot = 0
        for i in range(len(periods) - 1):
            w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
            if w.sum() < 2000: continue
            k, a = d.loc[w & ~fires, c].mean(), d.loc[w, c].mean()
            if np.isfinite(k) and np.isfinite(a): tot += 1; pos += (k - a) >= 0
        ok = lift >= 0.02 and pos >= 6 and (~fires).mean() >= 0.20
        v = 'EARNS IT' if ok else ('INVERTED' if lift < -0.005 else 'noise')
        print(f'  {name:>16}{fires.mean():>8.2%}{blocked:>10.4f}{kept:>10.4f}{lift:>+10.4f}'
              f'{f"{pos}/{tot}":>7}{v:>10}')
