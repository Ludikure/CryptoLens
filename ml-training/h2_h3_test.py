#!/usr/bin/env python3
"""H2 cross-sectional momentum (market-neutral) + H3 defensive flat regime.
Designs frozen in docs/research/five-hypotheses.md.
"""
import numpy as np, pandas as pd
from pathlib import Path
FEE = 0.0010

def daily_panel(min_days=400):
    out = {}
    for f in sorted(Path('csv_exports_v14').glob('*.csv')):
        d = pd.read_csv(f, usecols=['timestamp','price','fundingRateRaw'], low_memory=False)
        d['date'] = pd.to_datetime(d['timestamp'], unit='s', utc=True).dt.date
        g = d.groupby('date').agg(px=('price','last'), fr=('fundingRateRaw','mean'))
        if len(g) < min_days: continue
        out[f.stem] = g
    px = pd.DataFrame({s: g['px'] for s, g in out.items()}).sort_index()
    fr = pd.DataFrame({s: g['fr'] for s, g in out.items()}).sort_index()
    return px, fr

def stats(pnl):
    eq = (1+pnl).cumprod()
    yrs = len(pnl)/365.25
    return dict(total=(eq.iloc[-1]-1)*100,
                cagr=(eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1]>0 else np.nan,
                dd=(eq/eq.cummax()-1).min()*100,
                sharpe=pnl.mean()/pnl.std()*np.sqrt(365.25) if pnl.std() else np.nan)

def folds(pnl, k=3):
    cuts = np.array_split(np.arange(len(pnl)), k)
    return [(1+pnl.iloc[c]).prod()-1 for c in cuts]

# ---------------- H2 ----------------
def h2(px):
    ret = px.pct_change()
    mom = px.pct_change(30)                       # trailing 30d, known at t
    w = pd.DataFrame(0.0, index=px.index, columns=px.columns)
    reb = px.index[::7]                           # weekly
    cur = pd.Series(0.0, index=px.columns)
    for dt in px.index:
        if dt in set(reb):
            m = mom.loc[dt].dropna()
            m = m[px.loc[dt].notna()]
            if len(m) >= 10:
                q = len(m)//5
                r = m.rank(ascending=False)
                cur = pd.Series(0.0, index=px.columns)
                cur[r[r <= q].index] =  0.5/q     # long top quintile
                cur[r[r >  len(m)-q].index] = -0.5/q  # short bottom quintile
        w.loc[dt] = cur
    wl = w.shift(1).fillna(0)                     # act on prior close
    gross = (wl * ret).sum(axis=1)
    turn = (w.diff().abs().sum(axis=1)).fillna(0)
    net = gross - turn*FEE
    return net, gross, turn

# ---------------- H3 ----------------
def h3(px, fr):
    res = {}
    for s in px.columns:
        p = px[s].dropna()
        if len(p) < 260: continue
        ema = p.ewm(span=200, adjust=False).mean()
        slope = ema.diff(20)
        long_ = ((p > ema) & (slope > 0)).astype(float)            # H3: {0,+1}
        short = np.where((p < ema) & (slope < 0), -1.0, 0.0)
        both = pd.Series(np.where(long_ > 0, 1.0, short), index=p.index)  # regime-hold comparison
        r = p.pct_change().fillna(0)
        f = (fr[s].reindex(p.index).fillna(0)/100*3)
        for name, pos in (('flat', long_), ('short', both)):
            ps = pos.shift(1).fillna(0)
            chg = (ps.diff().fillna(0) != 0).astype(int)
            pnl = ps*r - ps*f - chg*FEE
            res.setdefault(name, {})[s] = pnl
        res.setdefault('bh', {})[s] = r
    return {k: pd.DataFrame(v).mean(axis=1).dropna() for k, v in res.items()}

def main():
    px, fr = daily_panel()
    print(f'panel: {px.shape[1]} symbols, {len(px):,} days ({px.index[0]} -> {px.index[-1]})\n')

    print('=== H2  cross-sectional momentum (dollar-neutral, weekly) ===')
    net, gross, turn = h2(px)
    net = net.dropna(); net = net[net.index >= px.index[35]]
    sg, sn = stats(gross.reindex(net.index).fillna(0)), stats(net)
    print(f"  gross  total {sg['total']:>9,.1f}%  CAGR {sg['cagr']:>6.1f}%  maxDD {sg['dd']:>7.1f}%  Sharpe {sg['sharpe']:.2f}")
    print(f"  NET    total {sn['total']:>9,.1f}%  CAGR {sn['cagr']:>6.1f}%  maxDD {sn['dd']:>7.1f}%  Sharpe {sn['sharpe']:.2f}")
    f2 = folds(net)
    print(f"  folds: {'  '.join(f'{x*100:+.1f}%' for x in f2)}   avg turnover {turn.mean()*100:.1f}%/day")
    c1, c2, c3 = sn['sharpe'] > 0.5, sum(x > 0 for x in f2) >= 2, sn['dd'] > -82
    print(f"  [{'PASS' if all([c1,c2,c3]) else 'FAIL'}] bar: Sharpe>0.5 {c1} | >=2/3 folds {c2} | maxDD better than -82% {c3}")

    print('\n=== H3  defensive FLAT vs short-capable vs buy&hold ===')
    r = h3(px, fr)
    idx = r['flat'].index.intersection(r['bh'].index).intersection(r['short'].index)
    S = {k: stats(v.reindex(idx).fillna(0)) for k, v in r.items()}
    print(f"  {'':<22}{'total':>11}{'CAGR':>9}{'maxDD':>9}{'Sharpe':>8}")
    for k, lbl in (('flat','H3 defensive flat'), ('short','regime (short-capable)'), ('bh','buy & hold')):
        print(f"  {lbl:<22}{S[k]['total']:>10,.0f}%{S[k]['cagr']:>8.1f}%{S[k]['dd']:>8.1f}%{S[k]['sharpe']:>8.2f}")
    ddgain = S['flat']['dd'] - S['bh']['dd']
    retrel = S['flat']['total']/S['bh']['total'] if S['bh']['total'] else 0
    c1 = ddgain >= 15; c2 = retrel >= 0.75
    print(f"  [{'PASS' if c1 and c2 else 'FAIL'}] bar: maxDD >=15pp better ({ddgain:+.1f}pp) | return within 25% ({retrel*100:.0f}% of B&H)")
    for name, a, b in [('2022 bear','2021-11-10','2022-11-21'), ('2025-26 bear','2025-10-06','2026-06-25')]:
        m = (pd.Index(idx) >= pd.Timestamp(a).date()) & (pd.Index(idx) <= pd.Timestamp(b).date())
        if m.sum() < 30: continue
        print(f"    {name:<14}flat {((1+r['flat'].reindex(idx)[m]).prod()-1)*100:>+7.1f}%   "
              f"short {((1+r['short'].reindex(idx)[m]).prod()-1)*100:>+7.1f}%   B&H {((1+r['bh'].reindex(idx)[m]).prod()-1)*100:>+7.1f}%")

if __name__ == '__main__':
    main()
