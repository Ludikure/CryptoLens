#!/usr/bin/env python3
"""T24 — remove the 43 features the trained model never splits on.
Q1 serving path (must be EXACT). Q2 retrain (per-symbol AND cross-sectional, both mandatory).
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util, json, collections
from sklearn.metrics import roc_auc_score

M=json.load(open('../marketscope-worker/src/ml-model-crypto.json'))
FEATS=M['features']; cnt=collections.Counter()
def walk(n):
    if 'leaf' in n: return
    cnt[n['split']]+=1
    for c in n.get('children',[]): walk(c)
for t in M['trees']: walk(t)
USED=[f for f in FEATS if cnt[f]>0]; DEAD=[f for f in FEATS if cnt[f]==0]
print(f"shipped model: {len(FEATS)} declared, {len(USED)} used, {len(DEAD)} dead\n")

# ---------- Q1: serving path must be EXACT ----------
def raw(fd):
    tot=0.0
    for t in M['trees']:
        n=t
        while 'leaf' not in n:
            v=fd.get(n['split'])
            nxt=n['yes'] if (v is None or v < n['split_condition']) else n['no']
            n=next(c for c in n['children'] if c['nodeid']==nxt)
        tot+=n['leaf']
    return 1/(1+np.exp(-tot))
import glob
print("Q1 — SERVING PATH: same model, dead features REMOVED from the input dict")
allsame=True
for f in sorted(glob.glob('../marketscope-worker/test/fixtures/backtest-canonical/*.json')):
    fx=json.load(open(f)); d=fx['expected']['features']
    full=raw(d); trimmed=raw({k:v for k,v in d.items() if k not in DEAD})
    same=(full==trimmed); allsame &= same
    print(f"  {f.split('/')[-1]:<30} full {full:.12f}  trimmed {trimmed:.12f}  {'IDENTICAL' if same else 'DIFFERS'}")
print(f"  -> {'EXACT — trimming the serving path is provably safe' if allsame else 'MISMATCH — analysis is wrong'}\n")

# ---------- Q2: retrain on the 67 used features ----------
spec=importlib.util.spec_from_file_location('t2','t2_t3_test.py');t2=importlib.util.module_from_spec(spec);spec.loader.exec_module(t2)
a,_=t2.build(); a['y_good']=(a['fwdMaxFavR']>=1.5).astype(float)
a=a.dropna(subset=['y_good']).reset_index(drop=True)
n=len(a); cut=int(n*0.7); tr,te=a.iloc[:cut-48],a.iloc[cut:]
print(f"Q2 — RETRAIN: train {len(tr):,}  test {len(te):,}  symbols {te.sym.nunique()}")
print(f"  {'arm':<14}{'per-symbol AUC':>16}{'within-ts AUC':>15}{'xs spread':>11}")
res={}
for name,cols in (('FULL 110',FEATS),('USED 67',USED)):
    cols=[c for c in cols if c in a.columns]
    m=lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.05,num_leaves=15,verbose=-1,n_jobs=-1)
    m.fit(tr[cols],tr['y_good'])
    t=te.copy(); t['p']=m.predict_proba(t[cols])[:,1]
    per=np.mean([roc_auc_score(g.y_good,g.p) for _,g in t.groupby('sym') if g.y_good.nunique()>1])
    g=t.groupby('timestamp')
    def xa(grp):
        return roc_auc_score(grp.y_good,grp.p) if grp.y_good.nunique()>1 and len(grp)>=5 else np.nan
    xs=g.apply(xa, include_groups=False).dropna()
    spread=g['p'].std().mean()
    res[name]=(per,xs.mean(),spread)
    print(f"  {name:<14}{per:>16.4f}{xs.mean():>15.4f}{spread:>11.4f}")
F,U=res['FULL 110'],res['USED 67']
print(f"\n  Δ per-symbol {U[0]-F[0]:+.4f}   Δ within-timestamp {U[1]-F[1]:+.4f}   spread retained {U[2]/F[2]*100:.0f}%")
c1=abs(U[0]-F[0])<=0.005; c2=abs(U[1]-F[1])<=0.010; c3=U[2]/F[2]>=0.90
for ok,t_ in [(c1,f"1. per-symbol within 0.005      {U[0]-F[0]:+.4f}"),
              (c2,f"2. within-timestamp within 0.010 {U[1]-F[1]:+.4f}"),
              (c3,f"3. spread >= 90% of FULL         {U[2]/F[2]*100:.0f}%"),
              (allsame,"4. Q1 serving path exact")]:
    print(f"  [{'PASS' if ok else 'FAIL'}] {t_}")
print(f"\n  VERDICT: {'SHIP' if all([c1,c2,c3,allsame]) else 'DOES NOT MEET THE BAR'}")
