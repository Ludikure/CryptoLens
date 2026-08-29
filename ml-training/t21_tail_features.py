#!/usr/bin/env python3
"""T21 — do distributional TAIL-SHAPE features improve crash prediction?
Features frozen in docs/research/tail-shape-features.md. Backward-looking windows only.
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util
from sklearn.metrics import roc_auc_score

ORIG=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']
FRESH=['ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','LTCUSDT']
ASSETS=ORIG+FRESH
MKT=['ethBtcRatio','ethBtcDelta6','fearGreedIndex','fearGreedZone','vix','vixLevelCode','vixTermStructure',
     'dxyAboveEma20','dxyMomentum','relStrengthVsSpy','relStrengthVsSector','iwmSpyRatio','isCrypto']
DERIV=['fundingSignal','oiSignal','takerSignal','crowdingSignal','derivativesCombined','fundingRateRaw',
       'oiChangePct','takerRatioRaw','longPctRaw','oiPriceInteraction','fundingSlope','basisPct','basisExtreme']
TAIL=['tailSkew60','tailKurt60','tailSkew180','tailKurt180','tailDownUp60','tailFreq60','tailMaxDD60','tailQSpread60']


def add_tail(d):
    """Eight distributional features. All windows look BACKWARD only — no shift needed because the
    target is forward and these use returns up to and including the current bar."""
    r = d['price'].pct_change()
    d['tailSkew60']  = r.rolling(60).skew()
    d['tailKurt60']  = r.rolling(60).kurt()
    d['tailSkew180'] = r.rolling(180).skew()
    d['tailKurt180'] = r.rolling(180).kurt()
    dn = r.where(r < 0); up = r.where(r > 0)
    d['tailDownUp60'] = (dn.rolling(60, min_periods=10).std() /
                         up.rolling(60, min_periods=10).std().replace(0, np.nan))
    sd = r.rolling(60).std()
    d['tailFreq60'] = (r.abs() > 2*sd).rolling(60).mean()
    roll_max = d['price'].rolling(60).max()
    d['tailMaxDD60'] = (d['price']/roll_max - 1).rolling(60).min()
    q95 = r.rolling(60).quantile(0.95); q50 = r.rolling(60).quantile(0.50); q05 = r.rolling(60).quantile(0.05)
    d['tailQSpread60'] = (q95-q50) / (q50-q05).replace(0, np.nan)
    return d


def main():
    spec=importlib.util.spec_from_file_location('t2','t2_t3_test.py');t2=importlib.util.module_from_spec(spec);spec.loader.exec_module(t2)
    a,feats=t2.build(); a=a.dropna(subset=['y_crash']).reset_index(drop=True)
    # per-symbol so rolling windows never span an asset boundary
    parts=[]
    for _sym, g in a.sort_values(['sym','timestamp']).groupby('sym', sort=False):
        parts.append(add_tail(g.copy()))
    a=pd.concat(parts).sort_values('timestamp').reset_index(drop=True)
    a['dt']=pd.to_datetime(a.timestamp,unit='s',utc=True)
    a[TAIL]=a[TAIL].replace([np.inf,-np.inf],np.nan)
    base=[c for c in feats if c not in MKT and c not in DERIV]
    ARMS={'A FULL':base, 'B FULL+TAIL':base+TAIL, 'C TAIL ONLY':TAIL}
    print(f"features: FULL={len(base)}  +TAIL={len(base)+len(TAIL)}  TAILONLY={len(TAIL)}")
    print(f"tail coverage: {a[TAIL].notna().all(axis=1).mean()*100:.0f}% of rows have all eight\n",flush=True)
    starts=pd.date_range(a.dt.min()+pd.DateOffset(months=6),a.dt.max(),freq='QS',tz='UTC')
    res={arm:{} for arm in ARMS}
    for arm,cols in ARMS.items():
        for sym in ASSETS:
            P=[]
            for i,s in enumerate(starts):
                e=starts[i+1] if i+1<len(starts) else a.dt.max()+pd.Timedelta(days=1)
                tr=a[(a.dt<s-pd.Timedelta(hours=4*72))&(a.sym!=sym)]; te=a[(a.dt>=s)&(a.dt<e)&(a.sym==sym)]
                if len(tr)<3000 or len(te)==0: continue
                m=lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.05,num_leaves=15,verbose=-1,n_jobs=-1)
                m.fit(tr[cols],tr['y_crash']); t=te.copy(); t['p']=m.predict_proba(t[cols])[:,1]; P.append(t[['p','y_crash']])
            if P:
                D=pd.concat(P); res[arm][sym]=roc_auc_score(D.y_crash,D.p)
        print(f"  {arm:<14} mean AUC {np.mean(list(res[arm].values())):.4f}",flush=True)

    print("\n"+"="*88); print("T21 — AUC by asset (leave-one-symbol-out, identical folds)")
    print(f"{'asset':<10}{'A FULL':>10}{'B +TAIL':>10}{'C TAILonly':>12}{'B - A':>10}")
    deltas={}
    for grp,name in ((ORIG,'--- original four ---'),(FRESH,'--- six fresh ---')):
        print(name)
        for s in grp:
            if s not in res['A FULL']: continue
            dA,dB,dC=res['A FULL'][s],res['B FULL+TAIL'][s],res['C TAIL ONLY'][s]
            deltas[s]=dB-dA
            print(f"{s:<10}{dA:>10.3f}{dB:>10.3f}{dC:>12.3f}{dB-dA:>+10.3f}")
    mA=np.mean(list(res['A FULL'].values())); mB=np.mean(list(res['B FULL+TAIL'].values())); mC=np.mean(list(res['C TAIL ONLY'].values()))
    print(f"{'MEAN':<10}{mA:>10.3f}{mB:>10.3f}{mC:>12.3f}{mB-mA:>+10.3f}")

    print("\n"+"="*88); print("SHIP BAR")
    improved=sum(1 for v in deltas.values() if v>0)
    c1=(mB-mA)>=0.010; c2=improved>=7; c3=mC>0.520
    for ok,t in [(c1,f"1. mean AUC gain >= +0.010      {mB-mA:+.4f}"),
                 (c2,f"2. improves on >=7/10 assets    {improved}/10"),
                 (c3,f"3. TAIL ONLY beats chance       {mC:.3f}")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  VERDICT: {'TAIL FEATURES EARN THEIR PLACE' if all([c1,c2,c3]) else 'DOES NOT MEET THE BAR'}")


if __name__=='__main__': main()
