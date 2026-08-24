#!/usr/bin/env python3
"""T22 — which features can be removed? Fixed progressive arms, no subset search.
Design frozen in docs/research/feature-pruning.md. Smallest arm meeting the bar wins.
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
G_VOL=['atrPercent','atrPercentile','volScalar','volScalarML','dBBBandwidth','hBBBandwidth','dBBSqueeze','hBBSqueeze']
G_TAIL=['bodyWickRatio','last3Green','last3Red']
G_LIQ=['dVolumeRatio','hVolumeRatio','last3VolIncreasing','obvRising','adLineAccumulation','shortVolumeRatio','shortVolumeZScore']
G_XH=['tfAlignment','momentumAlignment','structureAlignment']
G_PS=['dStructBull','dStructBear','hStructBull','hStructBear','dBBPercentB','hBBPercentB','dAboveVwap','hAboveVwap',
      'fiftyTwoWeekPct','distToFiftyTwoHigh','vpDistToPocATR','vpAbovePoc','vpVAWidth','vpInValueArea',
      'vpDistToVAH_ATR','vpDistToVAL_ATR','gapPercent','gapFilled','gapDirectionAligned','dDivergence','hDivergence',
      'dStochK','hStochK','eStochK','dStochCross','hStochCross']


def main():
    spec=importlib.util.spec_from_file_location('t2','t2_t3_test.py');t2=importlib.util.module_from_spec(spec);spec.loader.exec_module(t2)
    a,feats=t2.build(); a=a.dropna(subset=['y_crash']).reset_index(drop=True)
    a['dt']=pd.to_datetime(a.timestamp,unit='s',utc=True)
    F=set(feats)
    keep_trend=[c for c in feats if c not in MKT+DERIV+G_VOL+G_TAIL+G_LIQ+G_XH+G_PS]
    ARMS={
        'A FULL':                       feats,
        'B -mktwide -deriv':            [c for c in feats if c not in MKT+DERIV],
        'C = B -pricestruct':           [c for c in feats if c not in MKT+DERIV+G_PS],
        'D MINIMAL trend+vol':          keep_trend+[c for c in G_VOL if c in F],
    }
    for k,v in ARMS.items(): print(f"  {k:<26}{len(v):>4} features",flush=True)
    print()
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
        print(f"  {arm:<26} mean AUC {np.mean(list(res[arm].values())):.4f}",flush=True)

    print("\n"+"="*92); print("T22 — AUC by asset (LOSO, identical folds)")
    hdr="".join(f"{k.split()[0]:>11}" for k in ARMS)
    print(f"{'asset':<10}{hdr}")
    for grp,name in ((ORIG,'--- burned four ---'),(FRESH,'--- six fresh ---')):
        print(name)
        for s in grp:
            print(f"{s:<10}"+"".join(f"{res[arm].get(s,float('nan')):>11.3f}" for arm in ARMS))
    print(f"{'MEAN':<10}"+"".join(f"{np.mean(list(res[arm].values())):>11.3f}" for arm in ARMS))
    print(f"{'vs FULL':<10}"+"".join(f"{np.mean(list(res[arm].values()))-np.mean(list(res['A FULL'].values())):>+11.4f}" for arm in ARMS))
    print(f"{'features':<10}"+"".join(f"{len(ARMS[arm]):>11}" for arm in ARMS))

    print("\n"+"="*92); print("SHIP BAR — within 0.005 of FULL, on >=7/10 assets, holding on the fresh six")
    full=res['A FULL']; mfull=np.mean(list(full.values()))
    passing=[]
    for arm in list(ARMS)[1:]:
        m=np.mean(list(res[arm].values()))
        within=sum(1 for s in ASSETS if s in res[arm] and res[arm][s] >= full[s]-0.005)
        fresh_ok=np.mean([res[arm][s] for s in FRESH if s in res[arm]]) >= np.mean([full[s] for s in FRESH])-0.005
        ok=(m>=mfull-0.005) and within>=7 and fresh_ok
        if ok: passing.append(arm)
        print(f"  [{'PASS' if ok else 'FAIL'}] {arm:<26}mean {m:.4f} ({m-mfull:+.4f}) | within-margin {within}/10 | fresh-six {'ok' if fresh_ok else 'no'}")
    print(f"\n  arms meeting the bar: {passing or 'none'}")
    if passing:
        win=min(passing, key=lambda k: len(ARMS[k]))
        print(f"  SMALLEST (the pre-declared rule): {win} — {len(ARMS[win])} features, "
              f"down from {len(ARMS['A FULL'])} ({(1-len(ARMS[win])/len(ARMS['A FULL']))*100:.0f}% removed)")


if __name__=='__main__': main()
