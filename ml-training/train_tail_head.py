"""Tail head: P(fwdMaxFavR >= 4.0 ATR in 24h). A dedicated big-move/risk gauge to sit
alongside ML_WIN (which targets >=1.5 ATR and structurally can't flag the huge moves).
Embeds heads.tail into the CLEAN ml-model-crypto.json (worker + iOS) — clean lineage,
separate from the leak-era ml-model-crypto.heads.json. Emits the all-zero parity
reference (for heads-parity.test.ts) + the HIGH/ELEVATED bucket thresholds.

Usage: python3 train_tail_head.py [source_dir]     (default csv_exports_v14)
RUN ORDER: after calibrate_v14.py --ship — this embeds into the EXISTING
ml-model-crypto.json, so the main model must be in place first. After running,
update the all-zero parity reference in heads-parity.test.ts from the printed value."""
import os, sys, json, numpy as np, pandas as pd, lightgbm as lgb
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score
from calibrate_v12_crypto_clean import FEATURES, extract_trees

# v14: volScalarML dropped (r=1.000 duplicate of atrPercentile) — keep the head
# consistent with the main model's feature set.
FEATURES=[f for f in FEATURES if f!='volScalarML']

HERE=os.path.dirname(os.path.abspath(__file__))
REPO=os.path.dirname(HERE)
SRC=os.path.join(HERE, sys.argv[1] if len(sys.argv)>1 else 'csv_exports_v14')
TAIL=4.0; CAP=0.60
WORKER=f'{REPO}/marketscope-worker/src/ml-model-crypto.json'
IOS=f'{REPO}/CryptoLens/ML/ml-model-crypto.json'

parts=[]
for fn in sorted(os.listdir(SRC)):
    if not fn.endswith('USDT.csv'): continue
    df=pd.read_csv(os.path.join(SRC,fn))
    if 'fwdMaxFavR' not in df: continue
    df=df[df['fwdMaxFavR'].notna()].copy(); df['symbol']=fn[:-4]
    df['date']=pd.to_datetime(df['timestamp'],unit='s').dt.date
    parts.append(df.groupby('date').tail(1))
print(f"source: {SRC} ({len(parts)} symbols)")
d=pd.concat(parts,ignore_index=True).sort_values('timestamp').reset_index(drop=True)
for f in FEATURES:
    if f not in d.columns: d[f]=0.0
X,y=d[FEATURES],(d['fwdMaxFavR']>=TAIL).astype(int).values
n=len(d); print(f"{n:,} bars, tail(>= {TAIL} ATR) base={y.mean()*100:.1f}%")

def mk():
    return lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.03,subsample=0.8,
        colsample_bytree=0.8,min_child_samples=10,reg_alpha=0.1,reg_lambda=1.0,random_state=42,verbose=-1)

# WF OOF -> isotonic calibration breakpoints (cap 0.60)
oof=np.full(n,np.nan)
for k in range(1,4):
    cut=int(n*k/4); ve=int(n*(k+1)/4)
    trI=np.arange(0,cut-48); vaI=np.arange(cut,ve)
    if len(trI)<500: continue
    m=mk(); m.fit(X.iloc[trI],y[trI]); oof[vaI]=m.predict_proba(X.iloc[vaI])[:,1]
mask=~np.isnan(oof)
iso=IsotonicRegression(out_of_bounds='clip'); iso.fit(oof[mask],y[mask])
x_cal=iso.X_thresholds_.tolist(); y_cal=np.minimum(iso.y_thresholds_,CAP).tolist()
print(f"OOF AUC={roc_auc_score(y[mask],oof[mask]):.3f}, {len(x_cal)} cal breakpoints")

# Final model on ALL data -> trees in worker JSON format
final=mk(); final.fit(X,y)
trees,base_score=extract_trees(final,is_lgb=True)

# --- replicate the TS evaluator EXACTLY for parity reference + bucketing ---
def eval_tree(node,inp):
    if 'leaf' in node: return node['leaf']
    val=inp.get(node['split'],0.0)
    nid=node['yes'] if val<node['split_condition'] else node['no']
    for c in node['children']:
        if c['nodeid']==nid: return eval_tree(c,inp)
    return 0.0
def iso_cal(raw):
    x,yv=x_cal,y_cal
    if raw<=x[0]: return yv[0]
    if raw>=x[-1]: return min(CAP,yv[-1])
    lo=0
    for i in range(1,len(x)):
        if x[i]>raw: lo=i-1; break
    t=(raw-x[lo])/(x[lo+1]-x[lo])
    return max(0.0,min(CAP,yv[lo]+t*(yv[lo+1]-yv[lo]))) 
def predict(inp):
    s=np.log(base_score/(1-base_score))+sum(eval_tree(t,inp) for t in trees)
    return iso_cal(1/(1+np.exp(-s)))

ref=predict({})  # all-zero input == empty dict (evaluateTree defaults missing to 0)
print(f"\nPARITY REFERENCE (all-zero input): mlPredictTail = {ref:.10f}")

# bucket thresholds from calibrated full-data predictions
cal_all=np.array([predict(r) for r in d[FEATURES].to_dict('records')])
q70,q90=np.quantile(cal_all,[.70,.90])
print(f"BUCKET THRESHOLDS: ELEVATED >= {q70:.4f}, HIGH >= {q90:.4f}")
print(f"  base tail rate {y.mean()*100:.1f}% | NORMAL<{q70:.3f} | ELEVATED [{q70:.3f},{q90:.3f}) | HIGH>={q90:.3f}")

# --- embed heads.tail into both clean model JSONs ---
head={'trees':trees,'base_score':base_score,'threshold':TAIL,
      'target':f'fwdMaxFavR>={TAIL}','calibration':{'x':x_cal,'y':y_cal,'cap':CAP,'method':'isotonic'},
      'buckets':{'elevated':round(float(q70),4),'high':round(float(q90),4)},
      'base_rate':round(float(y.mean()),4),'n_samples':int(n),
      'description':f'Big-move/tail risk head: P(fwdMaxFavR>={TAIL} ATR in 24h). LightGBM d4 t150, '
                    f'{os.path.basename(SRC)}. Sits alongside ML_WIN; aimed at the '
                    f'huge moves ML_WIN (>=1.5 ATR target) structurally under-flags.'}
for path in (WORKER,IOS):
    if not os.path.isfile(path): print(f"  SKIP missing {path}"); continue
    j=json.load(open(path))
    j.setdefault('heads',{})['tail']=head
    json.dump(j,open(path,'w'))
    print(f"  wrote heads.tail -> {path} ({len(trees)} trees)")
