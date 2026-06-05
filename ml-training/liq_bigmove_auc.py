"""Decisive: does liquidation data improve big-move prediction BEYOND volatility?
Raw-% target (no ATR-normalization trap). Compare holdout AUC of [vol] vs [vol + liq].
If AUC doesn't rise, liquidation zones add nothing the model doesn't already have."""
import glob, numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
L=25.0; D=1/L; W=42; K=6; ATRW=14; BAND=0.05

rec=[]
for f in sorted(glob.glob('cg_data/*.csv')):
    d=pd.read_csv(f)
    if len(d)<W+K+ATRW+5 or 'long_liq' not in d: continue
    px=d['price'].values.astype(float); oi=d['oi'].values.astype(float)
    lp=d['long_pct'].values.astype(float)/100.0
    liq=(d['long_liq'].values+d['short_liq'].values).astype(float)
    ret=np.diff(px,prepend=px[0])/px
    volp=pd.Series(np.abs(ret)).rolling(ATRW).mean().values
    dOI=np.maximum(0.0,np.diff(oi,prepend=oi[0]))
    n=len(px)
    for i in range(W,n-K):
        Pt=px[i]
        if oi[i]<=0 or not(volp[i]>0): continue
        fuel=0.0
        for j in range(i-W,i):
            if dOI[j]<=0: continue
            Pj=px[j]
            if abs(Pj*(1-D)-Pt)/Pt<BAND: fuel+=dOI[j]*lp[j]
            if abs(Pj*(1+D)-Pt)/Pt<BAND: fuel+=dOI[j]*(1-lp[j])
        win=px[i+1:i+1+K]
        raw_move=max(win.max()/Pt-1, 1-win.min()/Pt)          # RAW % max excursion (no ATR)
        rec.append((d['time'].values[i], volp[i], fuel/oi[i], liq[i]/oi[i], raw_move))

r=pd.DataFrame(rec,columns=['t','vol','fuel','liqspike','raw']).replace([np.inf,-np.inf],np.nan).dropna()
cut=r['t'].quantile(0.70); tr,ho=r[r['t']<cut].copy(),r[r['t']>=cut].copy()
thr=tr['raw'].quantile(0.90)                                  # "big move" = top-decile raw move
tr['big']=(tr['raw']>=thr).astype(int); ho['big']=(ho['raw']>=thr).astype(int)
print(f"{len(r):,} signals, 25 sym ~6mo. Big move = raw 24h excursion >= {thr*100:.1f}% (top decile). "
      f"holdout base {ho['big'].mean()*100:.1f}%\n")

def auc(cols):
    m=LogisticRegression(max_iter=1000)
    Xtr=(tr[cols]-tr[cols].mean())/tr[cols].std()
    Xho=(ho[cols]-tr[cols].mean())/tr[cols].std()
    m.fit(Xtr,tr['big']); return roc_auc_score(ho['big'],m.predict_proba(Xho)[:,1])

a_vol=auc(['vol'])
a_volliq=auc(['vol','fuel','liqspike'])
a_liq=auc(['fuel','liqspike'])
print(f"holdout AUC, predicting a big RAW move:")
print(f"  vol only ................. {a_vol:.3f}")
print(f"  liq only (fuel+spike) .... {a_liq:.3f}")
print(f"  vol + liq ................ {a_volliq:.3f}   (lift over vol: {a_volliq-a_vol:+.3f})")
# also: big-move rate by liq-fuel tercile WITHIN the lowest/highest vol half (vol-controlled, non-parametric)
print("\nbig-move rate by near-fuel tercile, split by vol regime (holdout, vol-controlled):")
for vlab,vsel in [('LOW vol half', ho['vol']<=ho['vol'].median()),('HIGH vol half', ho['vol']>ho['vol'].median())]:
    sub=ho[vsel]; q=sub['fuel'].quantile([1/3,2/3]).values
    lo=sub[sub['fuel']<=q[0]]['big'].mean()*100; hi=sub[sub['fuel']>=q[1]]['big'].mean()*100
    print(f"  {vlab:<14} low-fuel {lo:>4.1f}%  high-fuel {hi:>4.1f}%  (diff {hi-lo:+.1f})")
