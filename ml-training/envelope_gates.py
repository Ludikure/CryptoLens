#!/usr/bin/env python3
"""What SHOULD the gates be? Tests whether gate SELECTION generalises out-of-sample.

Pre-declared in docs/research/envelope-rules.md Part 3 (frozen at 2abc7ae).

Greedy forward selection runs INSIDE each training fold, is frozen, and is then applied unchanged to
the held-out fold. The reported number therefore answers "does evidence-driven gate selection
generalise?" rather than "what was optimal in hindsight?" -- the latter proves nothing.
"""
import numpy as np, pandas as pd, lightgbm as lgb

FEE, PURGE = 0.171, 24
MIN_GAIN, MIN_COV = 0.005, 0.05
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)

d = (pd.read_pickle('excursion_dataset.pkl.gz')
       .merge(pd.read_pickle('envelope_payoff_rows.pkl.gz'), on=['symbol','timestamp'])
       .sort_values('timestamp').reset_index(drop=True))
feats = [c for c in d.columns if c.startswith('f_') and c != 'f_timestamp'
         and not c.startswith(('f_fwd','f_trade')) and pd.api.types.is_numeric_dtype(d[c])]
d['fee_r'] = FEE / (d['f_atrPercent'].clip(lower=0.05) * 2.0)
d['y_goodr'] = (d['f_fwdMaxFavR'] >= 1.5).astype(int)
d['y_crash'] = np.nan
d['dt'] = pd.to_datetime(d.timestamp, unit='s')

# Out-of-fold ML_WIN and crash probability -- both must be purged, both stand in for live models.
for tgt, col in (('y_goodr','ml'), (None,'crash')):
    d[col] = np.nan
uq = np.unique(d.timestamp.values)
# crash label: >=10% fall within 10 days (60 4h bars), per symbol
for sym, g in d.groupby('symbol'):
    idx = g.index
    fmin = g['f_price'][::-1].rolling(60, min_periods=1).min()[::-1].shift(-1)
    d.loc[idx,'y_crash'] = ((fmin / g['f_price'] - 1) <= -0.10).astype(float)
d['y_crash'] = d['y_crash'].fillna(0)

for i in range(4):
    a,b = int(len(uq)*(0.35+0.15*i)), int(len(uq)*(0.50+0.15*i))
    if b > len(uq): break
    tr = d[d.timestamp <= uq[a-1]]
    msk = (d.timestamp > uq[min(a+PURGE,len(uq)-1)]) & (d.timestamp <= uq[b-1])
    if len(tr) < 20000 or msk.sum() < 1000: continue
    for target, col in (('y_goodr','ml'), ('y_crash','crash')):
        m = lgb.LGBMClassifier(**PARAMS).fit(tr[feats], tr[target])
        d.loc[msk, col] = m.predict_proba(d.loc[msk, feats])[:,1]
d = d.dropna(subset=['ml','crash']).reset_index(drop=True)
print(f'{len(d):,} bars with out-of-fold ML and crash  ({d.dt.min().date()} → {d.dt.max().date()})')

al=d.f_tfAlignment; age=d.f_barsSinceRegimeChange
stack=d.f_dStackBull.astype(bool)|d.f_dStackBear.astype(bool)
rv = d.f_atrPercent
# Each gate is a KEEP mask: True = tradeable.
GATES = {
 'ml>=0.50':        d.ml >= 0.50,
 'ml>=0.60':        d.ml >= 0.60,
 'ml>=0.70':        d.ml >= 0.70,
 'crash<0.45':      d.crash < 0.45,
 'crash<0.55':      d.crash < 0.55,
 'crash>=0.45':     d.crash >= 0.45,
 'atr_pct high':    d.f_atrPercentile >= 50,
 'atr_pct low':     d.f_atrPercentile < 50,
 'vol>median':      rv >= rv.median(),
 'vol<median':      rv < rv.median(),
 'not RSI>70':      d.f_dRsi <= 70,
 'not RSI<30':      d.f_dRsi >= 30,
 'aligned only':    al.abs()==2,
 'not aligned':     al.abs()<2,
 'not mixed':       al!=0,
 'mixed only':      al==0,
 'trend young':     age<30,
 'trend mature':    age>=30,
 'not full stack':  ~stack,
 'funding calm':    d.f_fundingRateRaw.abs() < d.f_fundingRateRaw.abs().quantile(0.8),
}

def netR(mask, side, sub=None):
    m = mask if sub is None else (mask & sub)
    if m.sum() < 200: return np.nan, 0.0
    g = d[m]
    return (g[f'tp2_{side}_R'] - g.fee_r).mean(), m.mean()

def select(side, train_mask):
    """Greedy forward selection using TRAIN ONLY."""
    keep = pd.Series(True, index=d.index); chosen=[]
    cur,_ = netR(keep, side, train_mask)
    while True:
        best=None
        for name, g in GATES.items():
            if name in chosen: continue
            v, cov = netR(keep & g, side, train_mask)
            covtr = (keep & g & train_mask).sum()/max(train_mask.sum(),1)
            if np.isfinite(v) and covtr >= MIN_COV and v - cur >= MIN_GAIN and (best is None or v > best[1]):
                best = (name, v)
        if best is None: break
        chosen.append(best[0]); keep = keep & GATES[best[0]]; cur = best[1]
    return chosen, keep, cur

periods = pd.date_range('2022-01-01','2026-07-01',freq='6MS')
for side in ('SHORT','LONG'):
    print(f'\n{"="*94}\n{side} — out-of-sample gate selection\n{"="*94}')
    print(f'{"fold":>5}{"selected on train":>44}{"train R":>9}{"TEST R":>9}{"no-gate":>9}{"lift":>9}{"cov":>7}')
    lifts=[]; rand_lifts=[]; covs=[]; per_pos=0; per_tot=0
    for i in range(4):
        a,b = int(len(uq)*(0.35+0.15*i)), int(len(uq)*(0.50+0.15*i))
        if b > len(uq): break
        trm = d.timestamp <= uq[a-1]
        tem = (d.timestamp > uq[min(a+PURGE,len(uq)-1)]) & (d.timestamp <= uq[b-1])
        if trm.sum()<20000 or tem.sum()<1000: continue
        chosen, keep, trR = select(side, trm)
        teR,_ = netR(keep, side, tem)
        base,_ = netR(pd.Series(True,index=d.index), side, tem)
        cov = (keep & tem).sum()/tem.sum()
        # coverage-matched random control on the SAME test fold
        rs=[]
        for seed in range(20):
            r = np.random.default_rng(seed)
            rk = pd.Series(r.random(len(d)) < cov, index=d.index)
            v,_ = netR(rk, side, tem)
            if np.isfinite(v): rs.append(v)
        rnd = float(np.mean(rs)) if rs else np.nan
        lab = ' + '.join(chosen)[:42] if chosen else '(none selected)'
        print(f'{i+1:>5}{lab:>44}{trR:>9.4f}{teR:>9.4f}{base:>9.4f}{teR-base:>+9.4f}{cov:>7.1%}')
        if np.isfinite(teR-base):
            lifts.append(teR-base); rand_lifts.append(teR-rnd); covs.append(cov)
            # Criterion 3, which the first version of this script never evaluated: sign count over
            # SIX-MONTH periods inside this fold's test window, not over folds. Three folds cannot
            # support a mean -- that is the outlier trap already caught twice today.
            for k in range(len(periods)-1):
                w = tem & (d.dt>=periods[k]) & (d.dt<periods[k+1])
                if w.sum() < 1500: continue
                gv,_ = netR(keep, side, w); bv,_ = netR(pd.Series(True,index=d.index), side, w)
                if np.isfinite(gv) and np.isfinite(bv): per_tot += 1; per_pos += (gv-bv) >= 0
    if lifts:
        med = float(np.median(lifts)); medr = float(np.median(rand_lifts))
        print(f'\n  lift vs no-gate:  mean {np.mean(lifts):+.4f}R   MEDIAN {med:+.4f}R'
              f'   ({sum(l>0 for l in lifts)}/{len(lifts)} folds positive)')
        print(f'  lift vs coverage-matched RANDOM: mean {np.mean(rand_lifts):+.4f}R   MEDIAN {medr:+.4f}R')
        print(f'  six-month periods positive: {per_pos}/{per_tot}')
        print(f'  coverage per fold: {", ".join(f"{c:.1%}" for c in covs)}   (floor {MIN_COV:.0%})')
        c1 = med >= 0.02; c2 = medr >= 0.02
        c3 = per_tot > 0 and per_pos >= 0.66*per_tot
        c4 = all(c >= MIN_COV for c in covs)
        for n,c in (('1 beats no-gate (median)',c1),('2 beats random (median)',c2),
                    ('3 consistent across periods',c3),('4 coverage floor held every fold',c4)):
            print(f'    [{"PASS" if c else "FAIL"}] {n}')
        print(f'  => {"ADOPT" if all([c1,c2,c3,c4]) else "DO NOT ADOPT"}')
