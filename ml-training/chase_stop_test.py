#!/usr/bin/env python3
"""Part 10: the chase guard under the app's own entry rule, and the stop it actually ships.

Pre-declared in docs/research/envelope-rules.md (frozen at ce81648).

Q1  chaseLevel=='HIGH' transcribed from prompt.ts. Two components are NOT in the feature set --
    intoLevel (needs S/R) and CVD divergence -- and both can only LOWER chaseScore, so this fires
    less often than the real guard and classifies a strict subset. Declared, not discovered.

    The decisive comparison is the guard's lift under MARKET entry vs under PULLBACK entry on the
    SAME bars: if it only helps at market, it is redundant with ENTRY DISCIPLINE.

Q2  stop swept over {1.0 ... 3.0} x 4H ATR with TP2 held at a fixed 2.5 ATR distance. Absolute oppR
    is reported at every stop, because "the entry rule is real but the shipped trade is
    unprofitable" is a different and more serious result than the relative gain surviving.
"""
import glob, os
import numpy as np, pandas as pd

WAIT_H, HOLD_H = 12, 72
TP2_ATR = 2.5
DEPTH = 0.25
FEE = 0.171
STOPS = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0]
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
BAR = 4 * 3600

FCOLS = ['timestamp', 'price', 'atrPercent', 'fourHBias', 'dRsi', 'hRsi', 'dStochK', 'hStochK',
         'dDivergence', 'hDivergence', 'crowdingSignal']


def ema(v, n):
    a = 2.0 / (n + 1.0)
    out = np.empty(len(v)); out[:] = np.nan
    if len(v) < n: return out
    s = v[:n].mean(); out[n - 1] = s
    for i in range(n, len(v)):
        s = v[i] * a + s * (1 - a); out[i] = s
    return out


def daily_stretch(pp, bar_ts):
    """|price - EMA200| / daily ATR(14), evaluated at each 4H bar off CLOSED daily bars."""
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    p['d'] = (p.ts // 86400) * 86400
    g = p.groupby('d').agg(h=('high', 'max'), l=('low', 'min'), c=('close', 'last'))
    if len(g) < 210: return None
    h, l, c = g.h.to_numpy(), g.l.to_numpy(), g.c.to_numpy()
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    atr = pd.Series(tr).ewm(alpha=1 / 14, adjust=False).mean().to_numpy()
    e200 = ema(c, 200)
    dts = g.index.to_numpy()
    # For a 4H bar at t, the last CLOSED daily bar is the one strictly before t's day.
    j = np.searchsorted(dts, bar_ts, side='left') - 1
    ok = (j >= 0) & np.isfinite(e200[np.clip(j, 0, len(e200) - 1)]) & (atr[np.clip(j, 0, len(atr) - 1)] > 0)
    out = np.full(len(bar_ts), np.nan)
    jj = np.clip(j, 0, len(c) - 1)
    out[ok] = np.abs(c[jj][ok] - e200[jj][ok]) / atr[jj][ok]
    return out


def four_h_exhaustion(pp, bar_ts):
    """volume_diverging (3 same-dir bars, vol<0.8x prior 20) and rejection_wick (wick > 2x body)."""
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    edges = np.sort(np.asarray(bar_ts, dtype=np.int64))
    j = np.searchsorted(edges, p.ts.to_numpy(np.int64), side='right') - 1
    p = p[j >= 0].copy(); p['b'] = edges[j[j >= 0]]
    g = p.groupby('b').agg(o=('open', 'first'), h=('high', 'max'), l=('low', 'min'),
                           c=('close', 'last'), v=('volume', 'sum'))
    if len(g) < 25: return None
    o, hi, lo, c, v = (g[x].to_numpy(np.float64) for x in ('o', 'h', 'l', 'c', 'v'))
    n = len(g)
    up, dn = c > o, c < o
    allup = np.zeros(n, bool); alldn = np.zeros(n, bool); ratio = np.full(n, np.nan)
    for i in range(23, n):
        allup[i] = up[i - 2:i + 1].all(); alldn[i] = dn[i - 2:i + 1].all()
        pa = v[i - 22:i - 2].mean()
        if pa > 0: ratio[i] = v[i - 2:i + 1].mean() / pa
    body = np.abs(c - o)
    upper = hi - np.maximum(c, o); lower = np.minimum(c, o) - lo
    with np.errstate(invalid='ignore'):
        wick_up = (body > 0) & (upper > 2 * body)      # bearish exhaustion in an uptrend
        wick_dn = (body > 0) & (lower > 2 * body)
    return pd.DataFrame({'ts': g.index.to_numpy(), 'allup': allup, 'alldn': alldn,
                         'volr': ratio, 'wick_up': wick_up, 'wick_dn': wick_dn})


def sim(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)): return None
    f = pd.read_csv(fp, low_memory=False)
    cols = [c for c in FCOLS if c in f.columns]
    f = f[cols].copy()
    tr = f['timestamp'].to_numpy(np.int64)
    f['ts'] = (tr // 1000) if tr[0] > 1e12 else tr
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    pts = p['ts'].to_numpy(np.int64)
    op, hi, lo, cl = (p[c].to_numpy(np.float64) for c in ('open', 'high', 'low', 'close'))
    span = WAIT_H + HOLD_H
    idx = np.searchsorted(pts, f['ts'].to_numpy(np.int64), side='left')
    ok = (idx < len(pts) - span) & (idx >= 0) & (pts[np.clip(idx, 0, len(pts) - 1)] == f['ts'].to_numpy(np.int64))
    e0 = f['price'].to_numpy(np.float64); atrp = f['atrPercent'].to_numpy(np.float64)
    a = (atrp / 100.0) * e0
    ok &= np.isfinite(a) & (a > 0) & np.isfinite(e0) & (e0 > 0)
    if ok.sum() == 0: return None

    st = daily_stretch(pp, f['ts'].to_numpy(np.int64))
    ex = four_h_exhaustion(pp, f['ts'].to_numpy(np.int64))
    if st is None or ex is None: return None
    f['stretch'] = st
    f = f.merge(ex.rename(columns={'ts': 'ts_'}), left_on='ts', right_on='ts_', how='left')
    ok &= f['stretch'].notna().to_numpy() & f['volr'].notna().to_numpy()
    if ok.sum() == 0: return None

    r_ = np.where(ok)[0]; base = idx[r_]; e_, atr = e0[r_], a[r_]
    NEVER = span + 10
    first = lambda m: np.where(m.any(1), m.argmax(1), NEVER)
    fs = f.iloc[r_].reset_index(drop=True)
    out = {'symbol': sym, 'timestamp': fs['ts'].to_numpy(), 'atrPct': atrp[r_]}

    bull = fs.fourHBias.astype(str).str.contains('Bullish', case=False, na=False).to_numpy()
    bear = fs.fourHBias.astype(str).str.contains('Bearish', case=False, na=False).to_numpy()
    dR, hR = fs.dRsi.to_numpy(), fs.hRsi.to_numpy()
    dS, hS = fs.dStochK.to_numpy(), fs.hStochK.to_numpy()
    stretch = fs.stretch.to_numpy()
    rsiHot = np.where(bull, (dR >= 70) | (hR >= 72), np.where(bear, (dR <= 30) | (hR <= 28), False))
    stochHot = np.where(bull, (dS >= 85) | (hS >= 85), np.where(bear, (dS <= 15) | (hS <= 15), False))
    div = fs.dDivergence.fillna(0).to_numpy(); hdiv = fs.hDivergence.fillna(0).to_numpy()
    exh_div = np.where(bull, (div < 0) | (hdiv < 0), np.where(bear, (div > 0) | (hdiv > 0), False))
    volr = fs.volr.to_numpy(); allup = fs.allup.fillna(False).to_numpy(); alldn = fs.alldn.fillna(False).to_numpy()
    exh_vol = np.where(bull, allup & (volr < 0.8), np.where(bear, alldn & (volr < 0.8), False))
    exh_wick = np.where(bull, fs.wick_up.fillna(False).to_numpy(),
                        np.where(bear, fs.wick_dn.fillna(False).to_numpy(), False))
    crowd = fs.crowdingSignal.fillna(0).to_numpy() if 'crowdingSignal' in fs else np.zeros(len(fs))
    exh_crowd = np.where(bull, crowd > 0, np.where(bear, crowd < 0, False))
    exh_n = (exh_div.astype(int) + exh_vol.astype(int) + exh_wick.astype(int) + exh_crowd.astype(int))

    score = ((stretch >= 2).astype(int) + rsiHot.astype(int) + stochHot.astype(int)
             + (exh_n >= 1).astype(int))          # intoLevel MISSING -> conservative undercount
    core = (stretch >= 2) | (exh_n >= 2)
    out['chaseHIGH'] = (core & (score >= 3)).astype(np.int8)
    out['extended'] = (stretch >= 2).astype(np.int8)
    out['chaseDir'] = np.where(bull, 1, np.where(bear, -1, 0)).astype(np.int8)

    for stop_atr in STOPS:
        risk = stop_atr * atr
        R = TP2_ATR / stop_atr
        fee_r = FEE / np.clip(atrp[r_] * stop_atr, 0.05, None)
        for depth, dl in ((0.0, 'mkt'), (DEPTH, 'pb')):
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
                stop = entry - sg * risk
                tp2 = entry + sg * TP2_ATR * atr
                gi = np.clip(base[:, None] + fill_i[:, None] + np.arange(1, HOLD_H + 1), 0, len(hi) - 1)
                gh, gl = hi[gi], lo[gi]
                si = first(gl <= stop[:, None]) if side == 'LONG' else first(gh >= stop[:, None])
                qi = first(gh >= tp2[:, None]) if side == 'LONG' else first(gl <= tp2[:, None])
                exit_px = cl[np.clip(base + fill_i + HOLD_H, 0, len(cl) - 1)]
                to_r = sg * (exit_px - entry) / risk
                won = qi < si; lost = (si < NEVER) & ~won
                r = np.where(won, R, np.where(lost, -1.0, np.clip(to_r, -1.0, R)))
                out[f's{stop_atr}_{dl}_{side}'] = np.where(filled, r - fee_r, 0.0)
    return pd.DataFrame(out)


syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
d = pd.concat([x for s in syms if (x := sim(s)) is not None], ignore_index=True)
d['dt'] = pd.to_datetime(d.timestamp, unit='s')
periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')
print(f'{len(d):,} opportunities, {d.symbol.nunique()} symbols  ({d.dt.min().date()} → {d.dt.max().date()})')
print(f'chase HIGH fires on {d.chaseHIGH.mean():.1%} of bars (conservative — intoLevel + CVD missing)')
print(f'stretch>=2 fires on {d.extended.mean():.1%}\n')


def periods_pos(mask_col, fires, col_a, col_b=None):
    """periods where (kept mean - all mean) >= 0, or (a - b) >= 0 when col_b given."""
    pos = tot = 0
    for i in range(len(periods) - 1):
        w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
        if w.sum() < 2000: continue
        if col_b is None:
            k, a = d.loc[w & ~fires, col_a].mean(), d.loc[w, col_a].mean()
        else:
            k, a = d.loc[w, col_a].mean(), d.loc[w, col_b].mean()
        if np.isfinite(k) and np.isfinite(a): tot += 1; pos += (k - a) >= 0
    return pos, tot


print('=' * 92)
print('Q1 — does the chase guard help at MARKET but not at PULLBACK?  (stop 2.0 ATR, as measured)')
print('=' * 92)
for gate, gname in ((d.chaseHIGH == 1, 'chase HIGH (faithful)'), (d.extended == 1, 'stretch>=2 (robust arm)')):
    print(f'\n  --- {gname}: fires {gate.mean():.1%} ---')
    print(f'  {"entry":>10}{"side":>7}{"blocked":>10}{"kept":>10}{"lift":>10}{"per+":>7}{"penalty":>10}{"verdict":>10}')
    for dl, elabel in (('mkt', 'MARKET'), ('pb', 'PULLBACK')):
        for side in ('SHORT', 'LONG'):
            c = f's2.0_{dl}_{side}'
            blocked, kept = d.loc[gate, c].mean(), d.loc[~gate, c].mean()
            lift = kept - d[c].mean()
            pos, tot = periods_pos(None, gate, c)
            ok = lift >= 0.02 and pos >= 6 and (~gate).mean() >= 0.20
            v = 'EARNS IT' if ok else ('INVERTED' if lift < -0.005 else 'noise')
            print(f'  {elabel:>10}{side:>7}{blocked:>10.4f}{kept:>10.4f}{lift:>+10.4f}'
                  f'{f"{pos}/{tot}":>7}{kept - blocked:>+10.4f}{v:>10}')

print('\n' + '=' * 92)
print('Q2 — does the pullback edge survive the app\'s tighter stop?  (TP2 fixed at 2.5 ATR)')
print('=' * 92)
for side in ('SHORT', 'LONG'):
    print(f'\n  --- {side} ---')
    print(f'  {"stop":>7}{"R at TP2":>10}{"mkt oppR":>11}{"pb oppR":>11}{"gain":>10}{"per+":>7}{"verdict":>12}')
    for s in STOPS:
        m, pb = f's{s}_mkt_{side}', f's{s}_pb_{side}'
        gain = d[pb].mean() - d[m].mean()
        pos, tot = periods_pos(None, None, pb, m)
        ok = gain >= 0.02 and pos >= 6
        v = ('SURVIVES' if ok else 'fails')
        if ok and d[pb].mean() < 0: v = 'gain but -EV'
        print(f'  {s:>7.2f}{TP2_ATR / s:>10.2f}{d[m].mean():>11.4f}{d[pb].mean():>11.4f}'
              f'{gain:>+10.4f}{f"{pos}/{tot}":>7}{v:>12}')
print('\n  (the app ships ~1.22 ATR; the research measured 2.0)')
