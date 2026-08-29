#!/usr/bin/env python3
"""T4 — model conditional MFE/MAE, choose R:R dynamically instead of a fixed 1:5.
Design frozen in docs/research/untested-four.md. Benchmark is the current fixed 1R/5R design.
"""
import numpy as np, pandas as pd, lightgbm as lgb
from pathlib import Path
HOLD, COST_PCT = 18, 0.25          # 72h in 4H bars; user's actual round trip
RRS = [2.0, 3.0, 5.0, 8.0]
DROP = {'symbol','timestamp','price','regime','emaRegime'}

def build():
    fr=[]
    for f in sorted(Path('csv_exports_v14').glob('*.csv')):
        d=pd.read_csv(f,low_memory=False)
        if len(d)<400 or 'atrPercent' not in d: continue
        d=d.sort_values('timestamp').reset_index(drop=True)
        atr=(d.atrPercent/100*d.price).replace(0,np.nan)
        fmax=d.price[::-1].rolling(HOLD,min_periods=1).max()[::-1].shift(-1)
        fmin=d.price[::-1].rolling(HOLD,min_periods=1).min()[::-1].shift(-1)
        d['mfe']=(fmax-d.price)/atr; d['mae']=(d.price-fmin)/atr   # LONG-side excursions, ATR units
        d['sym']=f.stem; fr.append(d)
    a=pd.concat(fr,ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    a=a.dropna(subset=['mfe','mae','atrPercent']).reset_index(drop=True)
    feats=[c for c in a.columns if c not in DROP and c!='sym' and not c.startswith(('fwd','mfe','mae'))
           and pd.api.types.is_numeric_dtype(a[c])]
    return a,feats

def outcome(mfe,mae,rr):
    """Resolve a 1R-stop / rr-target trade from realised excursions.
    Ambiguous when BOTH are breached (path order unknown from excursions alone) -> charge the STOP,
    the conservative reading. Systematically pessimistic, and applied identically to every arm."""
    hit_t=mfe>=rr; hit_s=mae>=1.0
    return np.where(hit_s,-1.0,np.where(hit_t,rr,np.clip(mfe,-1,rr)))

def main():
    a,feats=build()
    n=len(a); print(f'{n:,} bars, {len(feats)} features\n')
    rows=[]
    for i in range(3):
        tr_end,te_end=int(n*(0.4+0.2*i)),int(n*(0.6+0.2*i))
        tr,te=a.iloc[:max(0,tr_end-48)],a.iloc[tr_end:te_end]
        if len(tr)<5000 or len(te)<1000: continue
        P={}
        for tgt in ('mfe','mae'):
            m=lgb.LGBMRegressor(max_depth=4,n_estimators=150,learning_rate=0.05,num_leaves=15,verbose=-1,n_jobs=-1)
            m.fit(tr[feats],tr[tgt]); P[tgt]=m.predict(te[feats])
        cost=COST_PCT/te.atrPercent.values
        mfe,mae=te.mfe.values,te.mae.values
        # predicted EV per candidate R:R, from the modelled excursion distribution
        pred_ev=np.column_stack([np.where(P['mae']>=1.0,-1.0,np.where(P['mfe']>=rr,rr,np.clip(P['mfe'],-1,rr)))-cost for rr in RRS])
        pick=np.array(RRS)[pred_ev.argmax(axis=1)]
        realized={f'fixed 1:{int(rr)}':(outcome(mfe,mae,rr)-cost).mean() for rr in RRS}
        dyn=np.array([outcome(mfe[j],mae[j],pick[j]) for j in range(len(te))])-cost
        realized['DYNAMIC']=dyn.mean()
        rows.append(realized)
        print(f"  fold {i+1}: " + "  ".join(f"{k} {v:+.4f}" for k,v in realized.items()))
    df=pd.DataFrame(rows)
    print(f"\n{'arm':<16}{'mean net R':>12}{'folds':>34}")
    for c in df.columns:
        print(f"{c:<16}{df[c].mean():>+12.4f}{'  '.join(f'{x:+.4f}' for x in df[c]):>34}")
    beat=(df['DYNAMIC']>df['fixed 1:5']).sum()
    c1,c2=beat>=2,(df['DYNAMIC']>0).any()
    print(f"\n--- SHIP BAR ---\n  [{'PASS' if c1 else 'FAIL'}] beats fixed 1:5 in >=2/3 folds ({beat}/3)")
    print(f"  [{'PASS' if c2 else 'FAIL'}] positive net EV in >=1 fold")
    print(f"\n  VERDICT: {'SHIP' if c1 and c2 else 'DOES NOT MEET THE BAR'}")

if __name__=='__main__': main()
