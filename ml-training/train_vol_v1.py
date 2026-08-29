"""Phase 1 (risk platform) — HAR-RV volatility forecaster, GATE validation.

Predict forward realized vol (4h/24h/72h) per asset class from past RV components
(HAR-RV: 24h / 7d / 30d). This script ONLY validates the gate before we build any
worker/UI around it:
  - OOS R^2 >= 0.35 at 24h  (HAR-RV literature: 0.4-0.6 achievable)
  - 1sigma band coverage ~68%, 2sigma ~95% (the calibration that actually matters)
If the gate passes, proceed to the ML residual + worker integration; else ship HAR-only.

Realized vol over a window = sqrt( sum( ln(c_t/c_{t-1})^2 ) ), per-horizon, not annualized.
"""
import time, urllib.request, json, numpy as np, pandas as pd

CRYPTO = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','LINK','DOT',
          'MATIC','LTC','ATOM','UNI','AAVE','NEAR','FIL','ETC','XLM','TRX']
H1 = 3600_000
HBARS = {'4h':4, '24h':24, '72h':72}          # forward horizons in 1H bars
COMP  = {'24h':24, '7d':168, '30d':720}        # HAR lookback components

def fetch_1h(sym, years=2.0):
    """Page Binance USDT-M futures 1H klines forward from `years` ago to now."""
    end = int(time.time()*1000); start = end - int(years*365*86400*1000)
    out = []
    cur = start
    while cur < end:
        url = (f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}USDT'
               f'&interval=1h&limit=1500&startTime={cur}')
        try:
            k = json.load(urllib.request.urlopen(url, timeout=30))
        except Exception as e:
            print(f'  {sym}: fetch err {e}'); break
        if not k: break
        out += k
        cur = k[-1][0] + H1
        if len(k) < 1500: break
        time.sleep(0.15)
    if not out: return None
    df = pd.DataFrame(out, columns=['t','o','h','l','c','v','ct','q','n','tb','tq','ig'])
    df = df[['t','c']].astype({'t':'int64','c':'float'}).drop_duplicates('t').sort_values('t')
    df['sym'] = sym
    return df

def build(df):
    """Per-symbol: log returns -> HAR component RVs (trailing) + forward RV targets."""
    c = df['c'].values; r = np.diff(np.log(c), prepend=np.log(c[0]))
    r2 = r*r; n = len(r)
    out = {'sym': df['sym'].values, 't': df['t'].values, 'logc': np.log(c)}
    csum = np.concatenate([[0], np.cumsum(r2)])
    def rv_trailing(w):                          # sqrt sum r^2 over PAST w bars (incl t)
        v = np.full(n, np.nan)
        for i in range(w, n): v[i] = np.sqrt(csum[i+1]-csum[i+1-w])
        return v
    def rv_forward(w):                           # sqrt sum r^2 over NEXT w bars
        v = np.full(n, np.nan)
        for i in range(0, n-w): v[i] = np.sqrt(csum[i+1+w]-csum[i+1])
        return v
    for k,w in COMP.items():  out[f'rv_{k}'] = rv_trailing(w)
    for k,w in HBARS.items():
        out[f'fwd_rv_{k}'] = rv_forward(w)
        # terminal forward log-move over the horizon (for coverage test)
        tm = np.full(n, np.nan)
        for i in range(0, n-w): tm[i] = out['logc'][i+w]-out['logc'][i]
        out[f'fwd_move_{k}'] = tm
    return pd.DataFrame(out)

import os
CACHE = '/tmp/vol_data_crypto.pkl'
if os.path.exists(CACHE):
    D = pd.read_pickle(CACHE)
    print(f'loaded cached {len(D):,} bar-rows across {D.sym.nunique()} symbols\n')
else:
    print('Fetching 1H candles (crypto basket)...')
    parts=[]
    for s in CRYPTO:
        d = fetch_1h(s)
        if d is None or len(d) < COMP['30d']+100: continue
        parts.append(build(d)); print(f'  {s}: {len(d)} bars')
    D = pd.concat(parts, ignore_index=True).sort_values('t').reset_index(drop=True)
    D.to_pickle(CACHE)
    print(f'total {len(D):,} bar-rows across {D.sym.nunique()} symbols\n')

HARX = ['rv_24h','rv_7d','rv_30d']
def har_eval(target):
    d = D.dropna(subset=HARX+[target,'fwd_move_24h' if False else target]).copy()
    d = d.dropna(subset=HARX+[target])
    cut = d['t'].quantile(0.70); tr, ho = d[d['t']<cut], d[d['t']>=cut]
    X = np.column_stack([np.ones(len(tr))]+[tr[c].values for c in HARX])
    beta, *_ = np.linalg.lstsq(X, tr[target].values, rcond=None)
    Xho = np.column_stack([np.ones(len(ho))]+[ho[c].values for c in HARX])
    pred = Xho@beta; y = ho[target].values
    ss_res = np.sum((y-pred)**2); ss_tot = np.sum((y-y.mean())**2)
    r2 = 1 - ss_res/ss_tot
    # AR(1) baseline for context: forward_RV ~ rv_24h only
    Xa=np.column_stack([np.ones(len(tr)),tr['rv_24h']]); ba,*_=np.linalg.lstsq(Xa,tr[target].values,rcond=None)
    pa=np.column_stack([np.ones(len(ho)),ho['rv_24h']])@ba
    r2a=1-np.sum((y-pa)**2)/ss_tot
    return beta, r2, r2a, ho, pred

print('=== HAR-RV out-of-sample R^2 (holdout 30% by time, pooled crypto) ===')
res={}
for h in HBARS:
    beta,r2,r2a,ho,pred = har_eval(f'fwd_rv_{h}')
    res[h]=(beta,ho,pred)
    gate = 'PASS' if (h!='24h' or r2>=0.35) else 'FAIL'
    print(f'  {h:>4}: HAR R2={r2:.3f}  (AR1-only R2={r2a:.3f})   beta={np.round(beta,3)}  {"<-- GATE "+gate if h=="24h" else ""}')

print('\n=== Coverage test (24h band: |terminal move| vs k*forecast_sigma) ===')
beta,ho,pred = res['24h']
sigma = pred                                       # forecast forward RV = sigma for terminal move
move = ho['fwd_move_24h'].values
ok = ~np.isnan(move) & (sigma>0)
move,sigma = move[ok], sigma[ok]
for k,want in [(1,68),(2,95)]:
    cov = (np.abs(move) <= k*sigma).mean()*100
    print(f'  {k}sigma: empirical coverage {cov:.1f}%  (target {want}%)')
# empirical correction factor so 1sigma hits 68% (|z| 68th pct should be 1.0)
z = np.abs(move)/sigma
corr = np.percentile(z, 68)
print(f'  -> sigma correction factor for 68% 1sigma coverage: x{corr:.3f}  (apply if coverage is off)')
cov1c=(np.abs(move)<=corr*sigma).mean()*100; cov2c=(np.abs(move)<=2*corr*sigma).mean()*100
print(f'  after correction: 1sigma {cov1c:.1f}%  2sigma {cov2c:.1f}%')

# ---- EXPORT model artifact (HAR coeffs per horizon + SEPARATE empirical band multipliers) ----
# Fit final HAR on ALL data per horizon; band multipliers = empirical 68th/95th pct of |move|/sigma
# computed per horizon (separate m68/m95 handles crypto fat tails — exact coverage by construction).
import json
model = {'market':'crypto','method':'HAR-RV','components':list(COMP.keys()),
         'comp_bars':COMP,'horizon_bars':HBARS,'n_samples':int(len(D)),
         'horizons':{}}
for h,w in HBARS.items():
    tgt=f'fwd_rv_{h}'
    d=D.dropna(subset=HARX+[tgt,f'fwd_move_{h}'])
    X=np.column_stack([np.ones(len(d))]+[d[c].values for c in HARX])
    beta,*_=np.linalg.lstsq(X,d[tgt].values,rcond=None)
    sig=(X@beta); mv=d[f'fwd_move_{h}'].values; m=sig>0
    z=np.abs(mv[m])/sig[m]
    m68=float(np.percentile(z,68)); m95=float(np.percentile(z,95)); m99=float(np.percentile(z,99))
    model['horizons'][h]={'beta':{'intercept':float(beta[0]),'rv_24h':float(beta[1]),
                          'rv_7d':float(beta[2]),'rv_30d':float(beta[3])},
                          'band_mult':{'s1':round(m68,4),'s2':round(m95,4),'s99':round(m99,4)}}
out='/Users/bojanmihovilovic/CryptoLens/marketscope-worker/src/ml-vol-crypto.json'
json.dump(model,open(out,'w'),indent=2)
print(f'\nexported {out}')
for h in HBARS:
    bm=model['horizons'][h]['band_mult']
    print(f'  {h}: band multipliers 68%={bm["s1"]} 95%={bm["s2"]} 99%={bm["s99"]}  (x forecast RV)')
