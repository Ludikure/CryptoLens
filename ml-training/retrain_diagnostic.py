"""Diagnose ML_WIN's behavior in strong-trend regions on clean crypto data.
Train on first 70% by time, predict last 30% (honest OOS). Bin by ADX deciles:
does ACTUAL goodR rise with ADX while the MODEL's prediction falls? That's the inversion."""
import os, glob, numpy as np, pandas as pd, lightgbm as lgb
from calibrate_v12_crypto_clean import FEATURES, CRYPTO_SYMBOLS

DATA='csv_exports_v11_fixed'
parts=[]
for s in CRYPTO_SYMBOLS:
    p=f'{DATA}/{s}USDT.csv'
    if not os.path.isfile(p): continue
    df=pd.read_csv(p)
    if 'fwdMaxFavR' not in df: continue
    df=df[df['fwdMaxFavR'].notna() & df['fwdReturn24H'].notna()].copy()
    df['symbol']=s
    df['date']=pd.to_datetime(df['timestamp'],unit='s').dt.date
    df=df.groupby('date').tail(1)               # daily downsample (match training)
    parts.append(df)
d=pd.concat(parts,ignore_index=True).sort_values('timestamp').reset_index(drop=True)
d['goodR']=(d['fwdMaxFavR']>=1.5).astype(int)
for f in FEATURES:
    if f not in d.columns: d[f]=0.0
print(f"bars={len(d):,}  base goodR={d['goodR'].mean()*100:.1f}%")

cut=int(len(d)*0.70); tr,ho=d.iloc[:cut],d.iloc[cut:]
m=lgb.LGBMClassifier(max_depth=4,n_estimators=150,learning_rate=0.03,subsample=0.8,
    colsample_bytree=0.8,min_child_samples=10,reg_alpha=0.1,reg_lambda=1.0,random_state=42,verbose=-1)
m.fit(tr[FEATURES],tr['goodR'])
ho=ho.copy(); ho['pred']=m.predict_proba(ho[FEATURES])[:,1]

def bin_report(col, label, nbins=10):
    h=ho[ho[col].notna()].copy()
    try: h['bin']=pd.qcut(h[col],nbins,duplicates='drop')
    except: return
    g=h.groupby('bin',observed=True).agg(n=('goodR','size'),actual=('goodR','mean'),pred=('pred','mean'),lo=(col,'min'),hi=(col,'max'))
    print(f"\n=== OOS binned by {label} ===")
    print(f"{'range':<20}{'n':>6}{'ACTUAL goodR':>14}{'MODEL pred':>12}{'gap(act-pred)':>14}")
    for _,r in g.iterrows():
        print(f"{f'{r.lo:.1f}–{r.hi:.1f}':<20}{int(r.n):>6}{r.actual*100:>13.1f}%{r.pred*100:>11.1f}%{(r.actual-r.pred)*100:>+13.1f}")
    # correlation of trend strength with actual vs predicted
    print(f"corr({label}, ACTUAL goodR)={np.corrcoef(h[col],h['goodR'])[0,1]:+.3f}   "
          f"corr({label}, MODEL pred)={np.corrcoef(h[col],h['pred'])[0,1]:+.3f}")

bin_report('dAdx','daily ADX')
bin_report('hAdx','4H ADX')
bin_report('atrPercentile','ATR percentile')
