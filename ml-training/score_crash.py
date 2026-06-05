"""Score BTC's crash-window features with the DEPLOYED models (out-of-sample: they
trained on data ending 2026-05-31). Show ML_WIN vs the new tail head vs reality."""
import json, numpy as np, pandas as pd
from calibrate_v12_crypto_clean import FEATURES

M=json.load(open('/Users/bojanmihovilovic/CryptoLens/marketscope-worker/src/ml-model-crypto.json'))
main_trees=M['trees']; main_cal=M['calibration']; tail=M['heads']['tail']

def eval_tree(node,inp):
    if 'leaf' in node: return node['leaf']
    nid=node['yes'] if inp.get(node['split'],0.0)<node['split_condition'] else node['no']
    for c in node['children']:
        if c['nodeid']==nid: return eval_tree(c,inp)
    return 0.0
def iso(cal,raw,cap):
    x,y=cal['x'],cal['y']
    if raw<=x[0]: return y[0]
    if raw>=x[-1]: return min(cap,y[-1])
    lo=0
    for i in range(1,len(x)):
        if x[i]>raw: lo=i-1; break
    t=(raw-x[lo])/(x[lo+1]-x[lo]); return max(0.0,min(cap,y[lo]+t*(y[lo+1]-y[lo])))
def ml_win(inp):
    s=sum(eval_tree(t,inp) for t in main_trees); return iso(main_cal,1/(1+np.exp(-s)),0.85)
def big_move(inp):
    s=np.log(0.5/0.5)+sum(eval_tree(t,inp) for t in tail['trees']); return iso(tail['calibration'],1/(1+np.exp(-s)),0.60)
EL,HI=tail['buckets']['elevated'],tail['buckets']['high']
def bucket(p): return 'HIGH' if p>=HI else 'ELEVATED' if p>=EL else 'NORMAL'

d=pd.read_csv('/tmp/btc_recent.csv')
d['dt']=pd.to_datetime(d['timestamp'],unit='s')
for f in FEATURES:
    if f not in d.columns: d[f]=0.0
d=d[d['dt']>='2026-05-29'].copy()
# daily downsample: last 4H bar of each day (matches training cadence)
d['day']=d['dt'].dt.date
day=d.groupby('day').tail(1).reset_index(drop=True)

print(f"BTC — DEPLOYED models on crash-window features (OUT-OF-SAMPLE; trained through 05-31)\n")
print(f"{'date':<12}{'price':>9}{'ML_WIN':>8}{'BigMove':>9}{'bucket':>10}{'realized move':>15}")
for _,r in day.iterrows():
    inp={f:r[f] for f in FEATURES}
    mw=ml_win(inp); bm=big_move(inp); fav=r['fwdMaxFavR']
    realized=f"{fav:.1f} ATR" if pd.notna(fav) and fav>0 else "(incomplete)"
    flag=' <-- huge' if pd.notna(fav) and fav>=3.0 else ''
    print(f"{str(r['day']):<12}{r['price']:>9,.0f}{mw*100:>7.0f}%{bm*100:>8.1f}%{bucket(bm):>10}{realized:>15}{flag}")
print(f"\nbuckets: NORMAL < {EL*100:.1f}% <= ELEVATED < {HI*100:.1f}% <= HIGH   (tail base rate 6.4%)")
