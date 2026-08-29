#!/usr/bin/env python3
"""The biases_MIXED ML gate — runs the design frozen in docs/research/strategy-mixed-gate.md
(written 2026-07-24, unrun until now). Variants and ship bar are PRE-DECLARED; do not re-tune.

Population: non-aligned bars with CALIBRATED ML_WIN in [50,70) — the only bars the change affects.
Below 50 keeps its own FLAT; at/above 70 already passes.

Execution: the composite model from composite_band_backtest (50% off at TP1, stop to break-even,
runner to TP2) with counter-trend bands (TP1 1.0 / TP2 2.0 ATR), because that is what the opened
window would actually trade. Reported gross and net of Binance ~0.10% round trip.
"""
import csv, gzip, sys
import numpy as np, pandas as pd
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from composite_band_backtest import resolve_composite, HORIZON

HERE = Path(__file__).parent
SL, TP1, TP2 = 2.0, 1.0, 2.0          # counter-trend bands per the design
ROUND_TRIP = 0.0010                    # Binance ~0.10%
BAR_EV_EDGE, BAR_TRADE_MULT = 0.02, 10.0

def load_ml():
    d = pd.read_csv(HERE/'ml_raw_v14.csv')
    return {(r.symbol, int(r.ts)): r.rawMl for r in d.itertuples()}

def calib_curve():
    from bisect import bisect_left
    pts = [(23.7,39.4),(26.3,43.7),(32,52.6),(45.6,60.9),(65,65.6),(76.9,65.6),(82.3,76.2),(85,94.4)]
    xs=[p[0]/100 for p in pts]; ys=[p[1]/100 for p in pts]
    def f(raw):
        if raw<=xs[0]: return ys[0]
        if raw>=xs[-1]: return ys[-1]
        i=bisect_left(xs,raw)
        t=(raw-xs[i-1])/(xs[i]-xs[i-1]); return ys[i-1]+t*(ys[i]-ys[i-1])
    return f

def load_bars(ml):
    cal = calib_curve(); rows=[]
    for f in sorted((HERE/'csv_exports_v14').glob('*.csv')):
        sym=f.stem
        d=pd.read_csv(f, usecols=lambda c: c in ('timestamp','biasAlignment','price','atrPercent','fwdMaxFavR','dStochCross'))
        if 'biasAlignment' not in d.columns: continue
        d['symbol']=sym
        d['ts']=(d['timestamp']/1000).astype(int).where(d['timestamp']>1e11, d['timestamp'].astype(int))
        d['raw']=[ml.get((sym,int(t)), np.nan) for t in d['ts']]
        d=d.dropna(subset=['raw','price','atrPercent'])
        d['calib']=[cal(x) for x in d['raw']]
        rows.append(d)
    return pd.concat(rows, ignore_index=True).sort_values('ts').reset_index(drop=True)

def candle_index():
    idx={}
    with gzip.open(HERE/'crypto_candles_4h.csv.gz','rt') as fh:
        for r in csv.DictReader(fh):
            s=r.get('symbol')
            if not s: continue
            a=idx.setdefault(s,{'ts':[],'high':[],'low':[],'close':[]})
            t=float(r['timestamp']); a['ts'].append(t if t>1e11 else t*1000)
            a['high'].append(float(r['high'])); a['low'].append(float(r['low'])); a['close'].append(float(r['close']))
    for s in idx:
        for k in idx[s]: idx[s][k]=np.array(idx[s][k])
    return idx

def trades(pop, idx):
    out=[]
    for r in pop.itertuples():
        c=idx.get(r.symbol)
        if c is None: continue
        i=np.searchsorted(c['ts'], r.ts*1000, side='right')
        if i>=len(c['ts']): continue
        block={k:c[k][i:i+HORIZON] for k in ('high','low','close')}
        if len(block['high'])==0: continue
        atrp=r.price*r.atrPercent/100.0
        if atrp<=0: continue
        d=1 if getattr(r,'dStochCross',0)>=0 else -1      # structure-led side; direction is a coin flip
        v=resolve_composite(d, r.price, atrp, block, SL, TP1, TP2)
        if v is not None: out.append((r.ts, v))
    return out

def folds(n, k=3, purge=48):
    for i in range(k):
        te=int(n*(0.4+i*0.15)); vs=te+purge; ve=int(n*(0.55+i*0.15)) if i<k-1 else n
        if vs<ve: yield i,vs,ve

def main():
    print('loading…'); ml=load_ml(); bars=load_bars(ml); idx=candle_index()
    nonal = bars[~bars['biasAlignment'].astype(str).str.startswith('aligned')]
    print(f'{len(bars):,} bars, {len(nonal):,} non-aligned ({len(nonal)/len(bars)*100:.0f}%)')
    band = nonal[(nonal['calib']>=0.50)&(nonal['calib']<0.70)]
    print(f'population affected by the gate (non-aligned, calibrated ML in [50,70)): {len(band):,}\n')

    variants = {'A incumbent (FLAT <70)': None, 'B gate 70->60': 0.60, 'C gate 70->55': 0.55,
                'D MODERATE cap [50,70)': 0.50}
    print(f"{'variant':<26}{'trades':>8}{'grossEV':>10}{'netEV':>10}{'BE cost':>10}  folds net")
    base=None
    for name,thr in variants.items():
        if thr is None:
            print(f"{name:<26}{0:>8}{0.0:>+10.4f}{0.0:>+10.4f}{'-':>10}  (control: no trades opened)")
            base=0.0; continue
        pop=band[band['calib']>=thr]
        tr=trades(pop, idx)
        if not tr: print(f'{name:<26}{0:>8}  no trades'); continue
        ts=np.array([t for t,_ in tr]); rs=np.array([v for _,v in tr])
        # cost in R: round-trip % / (SL distance in %) — SL is SL_ATR * atrPercent
        cost = ROUND_TRIP / (SL*band['atrPercent'].median()/100.0)
        gross, net = rs.mean(), rs.mean()-cost
        fold_nets=[]
        for _,vs,ve in folds(len(rs)):
            seg=rs[vs:ve]
            if len(seg): fold_nets.append(seg.mean()-cost)
        be = rs.mean()*(SL*band['atrPercent'].median()/100.0)
        print(f"{name:<26}{len(rs):>8,}{gross:>+10.4f}{net:>+10.4f}{be*100:>9.3f}%  "
              + ' '.join(f'{x:+.3f}' for x in fold_nets))
    print('\nBE cost = round-trip % at which net EV hits zero.')


if __name__ == '__main__':
    main()
