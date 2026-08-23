#!/usr/bin/env python3
"""H4 ML_WIN as SIZE vs binary gate  +  H5 SELLING volatility with defined risk.
Designs frozen in docs/research/five-hypotheses.md.
"""
import numpy as np, pandas as pd
from pathlib import Path

# ---------------- H4 ----------------
STOP_R, TGT_R, HOLD = 1.0, 5.0, 18      # 1R stop, 5R target, 72h = 18 four-hour bars
COST_PCT = 0.25                          # user's actual Coinbase round trip, in percent

def h4():
    oof = pd.read_csv('oof_24h.csv')
    recs = []
    for sym, g in oof.groupby('sym'):
        f = Path('csv_exports_v14')/f'{sym}.csv'
        if not f.exists(): continue
        d = pd.read_csv(f, usecols=['timestamp','price'], low_memory=False).sort_values('timestamp').reset_index(drop=True)
        px = d['price'].values; ts = d['timestamp'].values
        pos = {t:i for i,t in enumerate(ts)}
        for _, row in g.iterrows():
            i = pos.get(row['timestamp'])
            if i is None or i+HOLD >= len(px): continue
            P, atrp = px[i], row['atrPercent']
            if atrp <= 0: continue
            A = atrp/100.0*P
            path = px[i+1:i+1+HOLD]
            cost_R = COST_PCT/atrp                      # round-trip fee expressed in R
            for sgn in (1, -1):                          # direction-agnostic: both sides
                stop = P - sgn*STOP_R*A; tgt = P + sgn*TGT_R*A
                r = None
                for q in path:
                    if (q <= stop) if sgn>0 else (q >= stop): r = -STOP_R; break
                    if (q >= tgt)  if sgn>0 else (q <= tgt):  r =  TGT_R; break
                if r is None: r = sgn*(path[-1]-P)/A
                recs.append((row['timestamp'], row['p'], r - cost_R))
    t = pd.DataFrame(recs, columns=['ts','p','R']).sort_values('ts').reset_index(drop=True)
    print(f'H4: {len(t):,} simulated convex trades (1R stop / 5R target / 72h, fees {COST_PCT}% round trip)\n')
    arms = {'binary gate p>=0.70': (t.p>=0.70).astype(float),
            'size proportional p':  t.p/t.p.mean(),
            'size p^2 (aggressive)': t.p**2/(t.p**2).mean()}
    print(f"  {'arm':<24}{'capital':>10}{'net R/unit':>13}{'Sharpe':>9}   folds (R/unit)")
    out={}
    for name, w in arms.items():
        cap = w.sum()
        if cap == 0: continue
        ev = (w*t.R).sum()/cap
        pnl = w*t.R
        sh = pnl.mean()/pnl.std()*np.sqrt(len(t)/6/365) if pnl.std() else np.nan
        fl=[]
        for c in np.array_split(np.arange(len(t)),3):
            ww,rr = w.iloc[c], t.R.iloc[c]
            fl.append((ww*rr).sum()/ww.sum() if ww.sum() else np.nan)
        out[name]=(ev,sh,fl)
        print(f"  {name:<24}{cap:>10,.0f}{ev:>+13.4f}{sh:>9.3f}   {'  '.join(f'{x:+.4f}' for x in fl)}")
    g = out['binary gate p>=0.70']
    print('\n  --- SHIP BAR: a sizing arm beats the gate on net EV/unit AND Sharpe in >=2/3 folds ---')
    for name in ('size proportional p','size p^2 (aggressive)'):
        e,s,fl = out[name]
        beat = sum(1 for a,b in zip(fl,g[2]) if a>b)
        ok = e>g[0] and s>g[1] and beat>=2
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: EV {e:+.4f} vs {g[0]:+.4f} | Sharpe {s:.3f} vs {g[1]:.3f} | folds beaten {beat}/3")

# ---------------- H5 ----------------
K_PREM, FRICTION = 0.80, 0.01
H5_DAYS, CAP_MULT = 30, 3.0

def h5():
    print('\n=== H5  SELLING a 30d straddle, defined risk (loss capped at 3x premium) ===')
    for dv, sym in (('BTC','BTCUSDT'), ('ETH','ETHUSDT')):
        d = pd.read_csv(f'dvol_{dv}.csv', parse_dates=['date'])
        p = pd.read_csv(f'csv_exports_v14/{sym}.csv', usecols=['timestamp','price'], low_memory=False)
        p['date'] = pd.to_datetime(p['timestamp'], unit='s')
        px = p.groupby(p['date'].dt.normalize())['price'].last().reset_index().rename(columns={'date':'date','price':'close'})
        m = d.merge(px, on='date').sort_values('date').reset_index(drop=True)
        fwd = m['close'].shift(-H5_DAYS)/m['close'] - 1.0
        payoff = fwd.abs()*100
        prem = K_PREM*m['dvol']*np.sqrt(H5_DAYS/365.0)
        net = np.minimum(prem - payoff, prem) - prem*FRICTION      # seller
        net = np.maximum(net, -CAP_MULT*prem)                       # DEFINED RISK cap
        m['net'] = net; m = m.dropna(subset=['net'])
        m['yr'] = m['date'].dt.year
        yrs = m.groupby('yr')['net'].mean()
        pos = (yrs>0).sum(); worst = yrs.min()
        print(f"  {dv}: n={len(m):,}  EV {m.net.mean():+.2f}%/trade  win {(m.net>0).mean()*100:.0f}%  "
              f"worst-year {worst:+.1f}%  positive years {pos}/{len(yrs)}")
        print(f"       by year: {'  '.join(f'{y}:{v:+.1f}' for y,v in yrs.items())}")
        ok = m.net.mean()>0 and pos>=5 and worst>-15
        print(f"       [{'PASS' if ok else 'FAIL'}] EV>0 {m.net.mean()>0} | >=5 positive years {pos>=5} | worst > -15% {worst>-15}")

if __name__ == '__main__':
    h4(); h5()
