#!/usr/bin/env python3
"""Does the pruned model still DISCRIMINATE ACROSS SYMBOLS at a point in time?

Every T22/T23/production test measured per-symbol time-series AUC. The app scores ~76 symbols
simultaneously and the user compares them, so cross-sectional spread is a separate property that
none of those tests covered.
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util, json

MKT=['ethBtcRatio','ethBtcDelta6','fearGreedIndex','fearGreedZone','vix','vixLevelCode','vixTermStructure',
     'dxyAboveEma20','dxyMomentum','relStrengthVsSpy','relStrengthVsSector','iwmSpyRatio','isCrypto']
spec=importlib.util.spec_from_file_location('t2','t2_t3_test.py');t2=importlib.util.module_from_spec(spec);spec.loader.exec_module(t2)
a,feats=t2.build(); a['y_good']=(a['fwdMaxFavR']>=1.5).astype(float)
a=a.dropna(subset=['y_good']).reset_index(drop=True)
MINIMAL=json.load(open('../marketscope-worker/src/ml-model-crypto.json'))['features']
FULL=[c for c in feats]
n=len(a); cut=int(n*0.7)
tr,te=a.iloc[:cut-48],a.iloc[cut:]
print(f"train {len(tr):,}  test {len(te):,}  symbols {te.sym.nunique()}\n")
out={}
for name,cols in (('FULL',FULL),('MINIMAL',MINIMAL)):
    cols=[c for c in cols if c in a.columns]
    m=lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.05,num_leaves=15,verbose=-1,n_jobs=-1)
    m.fit(tr[cols],tr['y_good'])
    t=te.copy(); t['p']=m.predict_proba(t[cols])[:,1]
    # cross-sectional: within each timestamp, how much do predictions vary across symbols?
    g=t.groupby('timestamp')
    spread=g['p'].std().mean(); rng=(g['p'].max()-g['p'].min()).mean()
    # and does the RANKING within a timestamp carry information?
    def xs_auc(grp):
        if grp.y_good.nunique()<2 or len(grp)<5: return np.nan
        from sklearn.metrics import roc_auc_score
        return roc_auc_score(grp.y_good,grp.p)
    xsa=g.apply(xs_auc, include_groups=False).dropna()
    out[name]=(spread,rng,xsa.mean(),len(xsa))
    print(f"  {name:<9} cross-sectional sd {spread:.4f} | mean range {rng:.4f} | "
          f"within-timestamp AUC {xsa.mean():.4f} (n={len(xsa):,} timestamps)")
f,mi=out['FULL'],out['MINIMAL']
print(f"\n  spread retained: {mi[0]/f[0]*100:.0f}% of FULL")
print(f"  within-timestamp AUC: {mi[2]:.4f} vs {f[2]:.4f}  ({mi[2]-f[2]:+.4f})")
print(f"\n  READ: within-timestamp AUC asks whether, at one moment, the model ranks the symbols that")
print(f"  WILL move above those that won't. 0.50 = no cross-sectional information.")
