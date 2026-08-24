#!/usr/bin/env python3
"""T20 — activity-based momentum index. Uncompromised redo of T19.
PRIMARY evaluation on six assets never used in T16-T19. Formulas frozen in docs/research/activity-index.md.
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util
from sklearn.metrics import roc_auc_score

FRESH=['ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','LTCUSDT']   # never used T16-T19
BURNED=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']                          # secondary only
MKT=['ethBtcRatio','ethBtcDelta6','fearGreedIndex','fearGreedZone','vix','vixLevelCode','vixTermStructure',
     'dxyAboveEma20','dxyMomentum','relStrengthVsSpy','relStrengthVsSector','iwmSpyRatio','isCrypto']
DERIV=['fundingSignal','oiSignal','takerSignal','crowdingSignal','derivativesCombined','fundingRateRaw',
       'oiChangePct','takerRatioRaw','longPctRaw','oiPriceInteraction','fundingSlope','basisPct','basisExtreme']


def zexp(s):
    m=s.expanding(200).mean(); sd=s.expanding(200).std()
    return (s-m)/sd.replace(0,np.nan)


def activity_index(d):
    A=[zexp(d['dMacdHist']).abs(), zexp(d['hMacdHist']).abs(), zexp(d['dRsiDelta']).abs(),
       zexp(d['hRsiDelta']).abs(), zexp(d['dAdxDelta']).abs()]
    return pd.concat(A,axis=1).mean(axis=1)


def main():
    spec=importlib.util.spec_from_file_location('t2','t2_t3_test.py');t2=importlib.util.module_from_spec(spec);spec.loader.exec_module(t2)
    a,feats=t2.build(); a=a.dropna(subset=['y_crash']).reset_index(drop=True)
    a['dt']=pd.to_datetime(a.timestamp,unit='s',utc=True)
    base=[c for c in feats if c not in MKT and c not in DERIV]
    starts=pd.date_range(a.dt.min()+pd.DateOffset(months=6),a.dt.max(),freq='QS',tz='UTC')
    res={}
    for sym in FRESH+BURNED:
        d=a[a.sym==sym].sort_values('timestamp').reset_index(drop=True)
        if len(d)<2000: print(f"  {sym}: too little history, skipped",flush=True); continue
        r={}
        idx=activity_index(d); m=idx.notna()&d.y_crash.notna()
        if m.sum()<500: continue
        r['index']=roc_auc_score(d.y_crash[m],idx[m])
        rv=d.price.pct_change().rolling(120).std(); mm=rv.notna()&d.y_crash.notna()
        r['rv']=roc_auc_score(d.y_crash[mm],rv[mm])
        r['shuf']=float(np.mean([roc_auc_score(d.y_crash[m], np.random.default_rng(s).permutation(idx[m].values)) for s in range(15)]))
        P=[]
        for i,s_ in enumerate(starts):
            e=starts[i+1] if i+1<len(starts) else a.dt.max()+pd.Timedelta(days=1)
            tr=a[(a.dt<s_-pd.Timedelta(hours=4*72))&(a.sym!=sym)]; te=a[(a.dt>=s_)&(a.dt<e)&(a.sym==sym)]
            if len(tr)<3000 or len(te)==0: continue
            mdl=lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.05,num_leaves=15,verbose=-1,n_jobs=-1)
            mdl.fit(tr[base],tr['y_crash']); t=te.copy(); t['p']=mdl.predict_proba(t[base])[:,1]; P.append(t[['p','y_crash']])
        if P:
            D=pd.concat(P); r['ml']=roc_auc_score(D.y_crash,D.p)
        res[sym]=r; print(f"  [{sym}] index {r['index']:.3f}  rv {r['rv']:.3f}  ml {r.get('ml',float('nan')):.3f}",flush=True)

    def block(name,syms):
        S=[s for s in syms if s in res]
        print(f"\n{name}")
        print(f"  {'asset':<10}{'ACTIVITY idx':>14}{'realised vol':>14}{'ML':>8}{'shuffled':>10}{'idx-rv':>9}{'ml-idx':>9}")
        for s in S:
            r=res[s]
            print(f"  {s:<10}{r['index']:>14.3f}{r['rv']:>14.3f}{r.get('ml',np.nan):>8.3f}{r['shuf']:>10.3f}"
                  f"{r['index']-r['rv']:>+9.3f}{r.get('ml',np.nan)-r['index']:>+9.3f}")
        mi=np.mean([res[s]['index'] for s in S]); mr=np.mean([res[s]['rv'] for s in S])
        mm_=np.mean([res[s]['ml'] for s in S if 'ml' in res[s]]); ms=np.mean([res[s]['shuf'] for s in S])
        print(f"  {'MEAN':<10}{mi:>14.3f}{mr:>14.3f}{mm_:>8.3f}{ms:>10.3f}{mi-mr:>+9.3f}{mm_-mi:>+9.3f}")
        return S,mi,mr,mm_,ms

    S,mi,mr,mm_,ms = block("PRIMARY — six assets never used in T16-T19", FRESH)
    block("SECONDARY — the four burned assets (comparability only, cannot carry the verdict)", BURNED)

    print("\n"+"="*78); print("SHIP BAR (fresh assets only)")
    c1=mi>0.520; c2=mi>=mr; c3=sum(1 for s in S if res[s]['index']>res[s]['shuf']+0.02)>=4
    d_=mm_-mi
    for ok,t in [(c1,f"1. index beats shuffled          {mi:.3f} vs {ms:.3f}"),
                 (c2,f"2. index >= realised volatility  {mi:.3f} vs {mr:.3f}"),
                 (c3,f"3. consistent on >=4/6 assets    {sum(1 for s in S if res[s]['index']>res[s]['shuf']+0.02)}/6")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  ATTRIBUTION: ML - index = {d_:+.4f}")
    print(f"  -> {'ML holds information BEYOND the simple index' if d_>0.020 else 'ML approximates a simple activity phenomenon'}")


if __name__=='__main__': main()
