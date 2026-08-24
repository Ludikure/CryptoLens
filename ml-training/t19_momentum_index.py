#!/usr/bin/env python3
"""T19 — does the ML model beat a FIXED momentum/regime score built from its own surviving inputs?
Formulas frozen in docs/research/momentum-index.md. No fitting, no selection, no threshold tuning.
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util
from sklearn.metrics import roc_auc_score, brier_score_loss

ASSETS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']
MKT=['ethBtcRatio','ethBtcDelta6','fearGreedIndex','fearGreedZone','vix','vixLevelCode','vixTermStructure',
     'dxyAboveEma20','dxyMomentum','relStrengthVsSpy','relStrengthVsSector','iwmSpyRatio','isCrypto']
DERIV=['fundingSignal','oiSignal','takerSignal','crowdingSignal','derivativesCombined','fundingRateRaw',
       'oiChangePct','takerRatioRaw','longPctRaw','oiPriceInteraction','fundingSlope','basisPct','basisExtreme']


def zexp(s):
    """Expanding z-score: mean/sd from history to date only."""
    m = s.expanding(200).mean(); sd = s.expanding(200).std()
    return ((s-m)/sd.replace(0, np.nan))


def simple_score(d):
    M1 = zexp(d['hRsi']-50).abs()
    M2 = zexp(d['dRsi']-50).abs()
    M3 = zexp(d['hRsiAccel']).abs()
    M4 = zexp(d['dAdx'])
    M5 = zexp(d['dStochK']-50).abs()
    return pd.concat([M1,M2,M3,M4,M5], axis=1).mean(axis=1)


def report(y, p):
    return dict(auc=roc_auc_score(y,p), brier=brier_score_loss(y,(p-p.min())/(p.max()-p.min()+1e-12)),
                top=y[p >= np.quantile(p,0.90)].mean()*100)


def main():
    spec=importlib.util.spec_from_file_location('t2','t2_t3_test.py');t2=importlib.util.module_from_spec(spec);spec.loader.exec_module(t2)
    a,feats=t2.build(); a=a.dropna(subset=['y_crash']).reset_index(drop=True)
    a['dt']=pd.to_datetime(a.timestamp,unit='s',utc=True)
    base=[c for c in feats if c not in MKT and c not in DERIV]
    starts=pd.date_range(a.dt.min()+pd.DateOffset(months=6),a.dt.max(),freq='QS',tz='UTC')
    rows={}
    for sym in ASSETS:
        d=a[a.sym==sym].sort_values('timestamp').reset_index(drop=True)
        # B: fixed score, no training at all
        sc=simple_score(d); m=sc.notna()&d.y_crash.notna()
        r={}
        r['B simple score']=report(d.y_crash[m].values, sc[m].values)
        # C / D: baselines
        px=d.price; ret=px.pct_change()
        rv=ret.rolling(120).std(); mm=rv.notna()&d.y_crash.notna()
        r['C realised vol']=report(d.y_crash[mm].values, rv[mm].values)
        tr_=-(px/px.ewm(span=1200,adjust=False).mean()-1); mt=tr_.notna()&d.y_crash.notna()
        r['D 200D trend']=report(d.y_crash[mt].values, tr_[mt].values)
        # E: temporal permutation of the simple score
        es=[]
        for s_ in range(20):
            perm=pd.Series(np.random.default_rng(s_).permutation(sc[m].values))
            es.append(roc_auc_score(d.y_crash[m].values, perm.values))
        r['E shuffled score']={'auc':float(np.mean(es)),'brier':np.nan,'top':np.nan}
        # A: the ML model, same folds as T18 arm B
        P=[]
        for i,s_ in enumerate(starts):
            e=starts[i+1] if i+1<len(starts) else a.dt.max()+pd.Timedelta(days=1)
            tr=a[(a.dt<s_-pd.Timedelta(hours=4*72))&(a.sym!=sym)]; te=a[(a.dt>=s_)&(a.dt<e)&(a.sym==sym)]
            if len(tr)<3000 or len(te)==0: continue
            mdl=lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.05,num_leaves=15,verbose=-1,n_jobs=-1)
            mdl.fit(tr[base],tr['y_crash']); t=te.copy(); t['p']=mdl.predict_proba(t[base])[:,1]; P.append(t[['p','y_crash']])
        D=pd.concat(P); r['A ML model']=report(D.y_crash.values, D.p.values)
        rows[sym]=r; print(f"  [{sym}] done",flush=True)

    print("\n"+"="*76); print("T19 — AUC (leave-one-symbol-out for ML; the others need no training)")
    print(f"{'arm':<20}"+"".join(f"{s[:3]:>9}" for s in ASSETS)+f"{'mean':>9}")
    order=['A ML model','B simple score','C realised vol','D 200D trend','E shuffled score']
    means={}
    for arm in order:
        v=[rows[s][arm]['auc'] for s in ASSETS]; means[arm]=np.mean(v)
        print(f"{arm:<20}"+"".join(f"{x:>9.3f}" for x in v)+f"{np.mean(v):>9.3f}")
    print(f"\n{'top-decile precision':<20}"+"".join(f"{rows[s]['A ML model']['top']:>9.1f}" for s in ASSETS)+"   (ML)")
    print(f"{'':<20}"+"".join(f"{rows[s]['B simple score']['top']:>9.1f}" for s in ASSETS)+"   (simple)")

    dl=means['A ML model']-means['B simple score']
    print("\n"+"="*76); print("SHIP BAR")
    beats=sum(1 for s in ASSETS if rows[s]['A ML model']['auc']-rows[s]['B simple score']['auc']>=0.020)
    c1=dl>=0.020; c2=beats>=3; c3=means['B simple score']>means['C realised vol']
    c4=means['B simple score']>means['E shuffled score']*1.10
    for ok,t in [(c1,f"1. AUC(ML) - AUC(simple) >= +0.020    {dl:+.4f}"),
                 (c2,f"2. advantage on >=3/4 assets          {beats}/4"),
                 (c3,f"3. simple score beats realised vol    {means['B simple score']:.3f} vs {means['C realised vol']:.3f}"),
                 (c4,f"4. survives temporal permutation      {means['B simple score']:.3f} vs shuffled {means['E shuffled score']:.3f}")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  per-asset ML minus simple: "+"  ".join(f"{s[:3]} {rows[s]['A ML model']['auc']-rows[s]['B simple score']['auc']:+.3f}" for s in ASSETS))
    if not c1: verdict="ML does NOT contain material information beyond the fixed momentum score"
    else: verdict="ML contains additional information"
    print(f"\n  VERDICT: {verdict}")


if __name__=='__main__': main()
