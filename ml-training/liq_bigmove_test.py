"""Do liquidation zones/events predict BIG MOVES (direction-agnostic), beyond volatility?
Coinglass data (25 majors, ~6mo 4H). Frozen holdout (last 30% by time). The control is the
key: liquidations are mechanically tied to vol, so we residualize forward-move on trailing
vol and ask if liq signal adds anything on top."""
import glob, numpy as np, pandas as pd
from scipy.stats import pearsonr
L=25.0; D=1/L; W=42; K=6; ATRW=14; BAND=0.05

rec=[]
for f in sorted(glob.glob('cg_data/*.csv')):
    d=pd.read_csv(f)
    if len(d)<W+K+ATRW+5 or 'long_liq' not in d: continue
    px=d['price'].values.astype(float); oi=d['oi'].values.astype(float)
    lp=d['long_pct'].values.astype(float)/100.0
    liq=(d['long_liq'].values+d['short_liq'].values).astype(float)
    ret=np.diff(px,prepend=px[0])/px
    atrp=pd.Series(np.abs(ret)).rolling(ATRW).mean().values
    dOI=np.maximum(0.0,np.diff(oi,prepend=oi[0]))
    n=len(px)
    for i in range(W,n-K):
        Pt=px[i]; a=atrp[i]
        if not(a>0) or oi[i]<=0: continue
        # ex-ante near-fuel: stacked leverage whose liq level sits within +-BAND of price
        fuel=0.0
        for j in range(i-W,i):
            if dOI[j]<=0: continue
            Pj=px[j]; LL=Pj*(1-D); SL=Pj*(1+D)
            if abs(LL-Pt)/Pt<BAND: fuel+=dOI[j]*lp[j]
            if abs(SL-Pt)/Pt<BAND: fuel+=dOI[j]*(1-lp[j])
        near_fuel=fuel/oi[i]                                  # normalized by current OI
        liq_spike=liq[i]/oi[i]                                # realized liq intensity at T
        recent_vol=atrp[i]                                    # trailing vol (the control)
        win=px[i+1:i+1+K]
        fwd_exc=max(win.max()/Pt-1, 1-win.min()/Pt)/a         # forward 24h max excursion (ATR), dir-agnostic
        contemp=max(px[i]/px[i-1]-1, 0)                       # not used; placeholder
        rec.append((d['time'].values[i], near_fuel, liq_spike, recent_vol, fwd_exc))

r=pd.DataFrame(rec,columns=['t','fuel','liqspike','vol','fwd']).replace([np.inf,-np.inf],np.nan).dropna()
cut=r['t'].quantile(0.70); tr,ho=r[r['t']<cut],r[r['t']>=cut]
print(f"signals: {len(r):,} (train {len(tr):,} / holdout {len(ho):,}), 25 symbols ~6mo\n")
big=r['fwd']>=3.0
print(f"big-move (fwd >= 3 ATR) base rate: {big.mean()*100:.1f}%\n")

def test(col,label):
    # raw corr with forward excursion
    craw=pearsonr(ho[col],ho['fwd'])
    # residualize fwd on trailing vol (fit on train), test leftover corr on holdout
    b1,b0=np.polyfit(tr['vol'],tr['fwd'],1)
    resid=ho['fwd']-(b0+b1*ho['vol'])
    cres=pearsonr(ho[col],resid)
    # big-move rate by tercile of the signal (holdout)
    q=ho[col].quantile([1/3,2/3]).values
    lo=ho[ho[col]<=q[0]]; hi=ho[ho[col]>=q[1]]
    print(f"{label:<22} corr(.,fwd) raw={craw[0]:+.3f}(p={craw[1]:.1e}) | vol-RESIDUALIZED={cres[0]:+.3f}(p={cres[1]:.1e}) | "
          f"big-move%: low {(lo['fwd']>=3).mean()*100:>4.1f} / high {(hi['fwd']>=3).mean()*100:>4.1f}")

print("CONTROL (must be strong — sanity): trailing vol vs forward move")
test('vol','trailing vol')
print("\nLIQUIDATION SIGNALS (do they add beyond vol? -> look at the RESIDUALIZED column):")
test('fuel','ex-ante near-fuel')
test('liqspike','realized liq spike')
print("\nRead: liq matters ONLY if vol-RESIDUALIZED corr is clearly >0 on HOLDOUT. If it collapses")
print("to ~0 after removing vol, liquidation 'zones' are just repackaged volatility (already in the model).")
