"""Can ANY model predict the HUGE moves in advance? Frozen holdout, clean data.
Targets of increasing severity. For each: train LGB, measure OOS AUC + catch-rate
(of the actual huge moves, what % land in the model's top-30% confidence) + lift."""
import os, numpy as np, pandas as pd, lightgbm as lgb
from sklearn.metrics import roc_auc_score
from calibrate_v12_crypto_clean import FEATURES, CRYPTO_SYMBOLS

parts=[]
for s in CRYPTO_SYMBOLS:
    p=f'csv_exports_v11_fixed/{s}USDT.csv'
    if not os.path.isfile(p): continue
    df=pd.read_csv(p)
    if 'fwdMaxFavR' not in df: continue
    df=df[df['fwdMaxFavR'].notna()].copy(); df['symbol']=s
    df['date']=pd.to_datetime(df['timestamp'],unit='s').dt.date
    parts.append(df.groupby('date').tail(1))
d=pd.concat(parts,ignore_index=True).sort_values('timestamp').reset_index(drop=True)
for f in FEATURES:
    if f not in d.columns: d[f]=0.0
cut=int(len(d)*0.70); tr,ho=d.iloc[:cut].copy(),d.iloc[cut:].copy()

def run(name, ytr, yho):
    base=yho.mean()
    if base<=0 or base>=1: print(f"{name}: degenerate base {base:.3f}"); return
    m=lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.03,subsample=0.8,
        colsample_bytree=0.8,min_child_samples=10,reg_alpha=0.1,reg_lambda=1.0,random_state=42,verbose=-1)
    m.fit(tr[FEATURES],ytr)
    p=m.predict_proba(ho[FEATURES])[:,1]
    auc=roc_auc_score(yho,p)
    # catch-rate: of actual positives, % in model's top-30% predictions
    thr=np.quantile(p,0.70); top=p>=thr
    catch=(yho[top].sum())/max(1,yho.sum())
    prec_top=yho[top].mean()                 # precision in the top bucket
    lift=prec_top/base
    # top-decile concentration
    thr9=np.quantile(p,0.90); top9=p>=thr9
    prec9=yho[top9].mean(); lift9=prec9/base
    print(f"{name:<26} base={base*100:>4.1f}%  AUC={auc:.3f}  | top30%: catch {catch*100:>4.0f}% prec {prec_top*100:>4.1f}% (lift {lift:.2f}x)  | top10%: prec {prec9*100:>4.1f}% (lift {lift9:.2f}x)")

print(f"daily-downsampled clean crypto: {len(d):,} bars (train {len(tr):,} / holdout {len(ho):,})\n")
print("Target = a forward move of at least N ATR in 24h (the BTC misses were 4-5.6 ATR):\n")
for thr in [1.5, 2.0, 3.0, 4.0, 5.0]:
    run(f"fwdMaxFavR >= {thr} ATR", (tr['fwdMaxFavR']>=thr).astype(int), (ho['fwdMaxFavR']>=thr).astype(int))
print("\nIf AUC stays ~0.55-0.60 and lift barely rises as moves get bigger, the HUGE moves are")
print("no more predictable than average ones — the info isn't in the features (timing is exogenous).")

print("\n\n=== DECISIVE: does a dedicated big-move head beat the current >=1.5 model at flagging huge moves? ===")
# train both heads
def fit(y):
    m=lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.03,subsample=0.8,
        colsample_bytree=0.8,min_child_samples=10,reg_alpha=0.1,reg_lambda=1.0,random_state=42,verbose=-1)
    m.fit(tr[FEATURES],y); return m
m15=fit((tr['fwdMaxFavR']>=1.5).astype(int))
p15=m15.predict_proba(ho[FEATURES])[:,1]
for thr in [3.0,4.0,5.0]:
    yb=(ho['fwdMaxFavR']>=thr).astype(int)
    mb=fit((tr['fwdMaxFavR']>=thr).astype(int))
    pb=mb.predict_proba(ho[FEATURES])[:,1]
    a15=roc_auc_score(yb,p15); ab=roc_auc_score(yb,pb)
    # catch-rate of >=thr events in each model's top-20%
    t15=p15>=np.quantile(p15,0.80); tb=pb>=np.quantile(pb,0.80)
    c15=yb[t15].sum()/max(1,yb.sum()); cb=yb[tb].sum()/max(1,yb.sum())
    print(f">= {thr} ATR events: current(>=1.5) model AUC={a15:.3f} catch{c15*100:>3.0f}%  |  dedicated head AUC={ab:.3f} catch{cb*100:>3.0f}%  |  gain +{(ab-a15):.3f} AUC, +{(cb-c15)*100:.0f}pp catch")
