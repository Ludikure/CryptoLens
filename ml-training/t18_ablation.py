#!/usr/bin/env python3
"""T18 section B — group ablation. Locates where the (small) residual signal lives.
Partition frozen in docs/research/price-structure-decomposition.md."""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util
from sklearn.metrics import roc_auc_score, brier_score_loss

ASSETS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']
MKT=['ethBtcRatio','ethBtcDelta6','fearGreedIndex','fearGreedZone','vix','vixLevelCode','vixTermStructure',
     'dxyAboveEma20','dxyMomentum','relStrengthVsSpy','relStrengthVsSector','iwmSpyRatio','isCrypto']
DERIV=['fundingSignal','oiSignal','takerSignal','crowdingSignal','derivativesCombined','fundingRateRaw',
       'oiChangePct','takerRatioRaw','longPctRaw','oiPriceInteraction','fundingSlope','basisPct','basisExtreme']
G2=['atrPercent','atrPercentile','volScalar','volScalarML','dBBBandwidth','hBBBandwidth','dBBSqueeze','hBBSqueeze']
G3=['bodyWickRatio','last3Green','last3Red']
G5=['dVolumeRatio','hVolumeRatio','last3VolIncreasing','obvRising','adLineAccumulation','shortVolumeRatio','shortVolumeZScore']
G6=['tfAlignment','momentumAlignment','structureAlignment']
G4pre=['dStructBull','dStructBear','hStructBull','hStructBear','dBBPercentB','hBBPercentB','dAboveVwap','hAboveVwap',
       'fiftyTwoWeekPct','distToFiftyTwoHigh','vpDistToPocATR','vpAbovePoc','vpVAWidth','vpInValueArea',
       'vpDistToVAH_ATR','vpDistToVAL_ATR','gapPercent','gapFilled','gapDirectionAligned','dDivergence','hDivergence',
       'dStochK','hStochK','eStochK','dStochCross','hStochCross']

def main():
    spec=importlib.util.spec_from_file_location('t2','t2_t3_test.py');t2=importlib.util.module_from_spec(spec);spec.loader.exec_module(t2)
    a,feats=t2.build(); a=a.dropna(subset=['y_crash']).reset_index(drop=True)
    a['dt']=pd.to_datetime(a.timestamp,unit='s',utc=True)
    base=[c for c in feats if c not in MKT and c not in DERIV]      # T17 arm B = price/vol
    G={'2 REALISED VOL':[c for c in G2 if c in base], '3 TAIL SHAPE':[c for c in G3 if c in base],
       '4 PRICE STRUCTURE':[c for c in G4pre if c in base], '5 LIQUIDITY':[c for c in G5 if c in base],
       '6 CROSS-HORIZON':[c for c in G6 if c in base]}
    assigned=set().union(*G.values())
    G['1 TREND/MOMENTUM']=[c for c in base if c not in assigned]
    print("group sizes: "+"  ".join(f"{k}={len(v)}" for k,v in sorted(G.items()))+f"   (base={len(base)})\n",flush=True)
    starts=pd.date_range(a.dt.min()+pd.DateOffset(months=6),a.dt.max(),freq='QS',tz='UTC')
    configs={'FULL (arm B)':base}
    for k,v in sorted(G.items()): configs[f'minus {k}']=[c for c in base if c not in v]
    res={}
    for cname,cols in configs.items():
        per={}
        for sym in ASSETS:
            P=[]
            for i,s in enumerate(starts):
                e=starts[i+1] if i+1<len(starts) else a.dt.max()+pd.Timedelta(days=1)
                tr=a[(a.dt<s-pd.Timedelta(hours=4*72))&(a.sym!=sym)]; te=a[(a.dt>=s)&(a.dt<e)&(a.sym==sym)]
                if len(tr)<3000 or len(te)==0: continue
                m=lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.05,num_leaves=15,verbose=-1,n_jobs=-1)
                m.fit(tr[cols],tr['y_crash']); t=te.copy(); t['p']=m.predict_proba(t[cols])[:,1]; P.append(t[['p','y_crash']])
            if P:
                D=pd.concat(P); per[sym]=(roc_auc_score(D.y_crash,D.p),
                                          D[D.p>=D.p.quantile(.9)].y_crash.mean()*100, brier_score_loss(D.y_crash,D.p))
        res[cname]=per; print(f"  {cname:<22} mean AUC {np.mean([v[0] for v in per.values()]):.4f}",flush=True)
    print("\n"+"="*80); print("GROUP ABLATION (LOSO, quarterly, identical folds) — PRIMARY METRIC = ΔAUC")
    print(f"{'config':<22}"+"".join(f"{s[:3]:>9}" for s in ASSETS)+f"{'meanAUC':>10}{'dAUC':>9}{'topDec':>9}{'Brier':>9}")
    f0=np.mean([v[0] for v in res['FULL (arm B)'].values()])
    for cname,per in res.items():
        au=np.mean([v[0] for v in per.values()])
        print(f"{cname:<22}"+"".join(f"{per[s][0]:>9.3f}" for s in ASSETS if s in per)+
              f"{au:>10.4f}{au-f0:>+9.4f}{np.mean([v[1] for v in per.values()]):>8.1f}%{np.mean([v[2] for v in per.values()]):>9.4f}")
    print("\n  most damaging removal (largest AUC drop) = the group carrying the signal")
if __name__=='__main__': main()
