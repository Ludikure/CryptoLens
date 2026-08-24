#!/usr/bin/env python3
"""T17 — mechanism decomposition. Explanation, not optimisation. All arms reported; none selected.
Partition frozen in docs/research/mechanism-decomposition.md before any evaluation.
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util
from sklearn.metrics import roc_auc_score

ASSETS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']
T9_D = lambda p: 1.00 if p < .30 else (0.50 if p <= .50 else 0.00)
COST = 0.0010
DERIV = ['fundingSignal','oiSignal','takerSignal','crowdingSignal','derivativesCombined','fundingRateRaw',
         'oiChangePct','takerRatioRaw','longPctRaw','oiPriceInteraction','fundingSlope','basisPct','basisExtreme']
MKT = ['ethBtcRatio','ethBtcDelta6','fearGreedIndex','fearGreedZone','vix','vixLevelCode','vixTermStructure',
       'dxyAboveEma20','dxyMomentum','relStrengthVsSpy','relStrengthVsSector','iwmSpyRatio','isCrypto']
# T16's nine asset-specific clusters
SPECIFIC = {'ETHUSDT':['2020-09'], 'XRPUSDT':['2020-11','2021-02','2022-10','2025-01','2026-03'],
            'SOLUSDT':['2021-09','2023-02','2023-12']}


def mets(r):
    r = r.dropna(); eq = (1+r).cumprod(); yrs = len(r)/365.25; dd = eq/eq.cummax()-1
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    return dict(cagr=cagr, dd=dd.min()*100, calmar=cagr/abs(dd.min()*100) if dd.min() else np.nan)


def episodes(px, thresh=0.30):
    out=[]; peak=0; p=px.values; idx=px.index; i=1
    while i < len(p):
        if p[i] > p[peak]: peak=i
        elif p[i]/p[peak]-1 <= -thresh:
            j = peak+int(np.argmin(p[peak:min(len(p),peak+400)]))
            out.append((idx[peak], idx[j])); peak=j; i=j
        i += 1
    return out


def main():
    spec = importlib.util.spec_from_file_location('t2','t2_t3_test.py')
    t2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(t2)
    a, feats = t2.build(); a = a.dropna(subset=['y_crash']).reset_index(drop=True)
    a['dt'] = pd.to_datetime(a.timestamp, unit='s', utc=True)
    F = {'A FULL': feats,
         'B PRICE/VOL': [c for c in feats if c not in DERIV and c not in MKT],
         'C DERIVATIVES': [c for c in feats if c in DERIV],
         'D MARKET-WIDE': [c for c in feats if c in MKT],
         'E ASSET-SPEC': [c for c in feats if c not in MKT]}
    print("feature counts: " + "  ".join(f"{k}={len(v)}" for k, v in F.items()) + "\n")

    starts = pd.date_range(a.dt.min()+pd.DateOffset(months=6), a.dt.max(), freq='QS', tz='UTC')
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date']); tb['date']=tb.date.dt.date
    out = {k: {} for k in F}
    for arm, cols in F.items():
        for sym in ASSETS:
            preds=[]
            for i, s in enumerate(starts):
                e = starts[i+1] if i+1 < len(starts) else a.dt.max()+pd.Timedelta(days=1)
                tr = a[(a.dt < s-pd.Timedelta(hours=4*72)) & (a.sym != sym)]
                te = a[(a.dt >= s) & (a.dt < e) & (a.sym == sym)]
                if len(tr) < 3000 or len(te) == 0: continue
                m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.05,
                                       num_leaves=15, verbose=-1, n_jobs=-1)
                m.fit(tr[cols], tr['y_crash'])
                t = te.copy(); t['p'] = m.predict_proba(t[cols])[:,1]; preds.append(t[['timestamp','p','y_crash']])
            if not preds: continue
            P = pd.concat(preds).sort_values('timestamp')
            auc = roc_auc_score(P.y_crash, P.p)
            top = P[P.p >= P.p.quantile(0.90)].y_crash.mean()
            P['date'] = pd.to_datetime(P.timestamp, unit='s', utc=True).dt.date
            sig = P.groupby('date')['p'].last()
            px = pd.read_csv(f'csv_exports_v14/{sym}.csv', usecols=['timestamp','price'], low_memory=False)
            px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
            d = pd.DataFrame({'px': px.groupby('date')['price'].last()}).join(sig.rename('p'), how='left')
            d['p'] = d['p'].ffill()
            d['cashr'] = tb.set_index('date')['rate'].reindex(d.index).ffill().fillna(0)/100/365.25
            d = d.dropna(subset=['p']); d['ret']=d.px.pct_change(); d['sig']=d.p.shift(1)
            d = d.dropna(subset=['ret','sig']); d['w']=d.sig.map(T9_D)
            d['r9'] = d.w*d.ret + (1-d.w)*d.cashr - d.w.diff().abs().fillna(0)*COST
            eps = episodes(d.px); antic = sum(1 for pk,_ in eps if d.w[pd.Index(d.index)==pk].mean() < 1.0)
            spec_hit = spec_tot = 0
            for tag in SPECIFIC.get(sym, []):
                for pk, _ in eps:
                    if f"{pk:%Y-%m}" == tag:
                        spec_tot += 1
                        if d.w[pd.Index(d.index)==pk].mean() < 1.0: spec_hit += 1
            out[arm][sym] = dict(auc=auc, top=top*100, antic=antic, neps=len(eps),
                                 spec=(spec_hit, spec_tot), **mets(d.r9), base=mets(d.ret),
                                 turn=d.w.diff().abs().fillna(0).sum()/(len(d)/365.25))
            print(f"  [{arm:<14}{sym}] AUC {auc:.3f}", flush=True)

    print("\n"+"="*84); print("PREDICTIVE ABILITY (leave-one-symbol-out, quarterly refits, identical folds)")
    print(f"{'arm':<16}" + "".join(f"{s[:3]:>9}" for s in ASSETS) + f"{'meanAUC':>10}{'top-decile precision':>22}")
    for arm in F:
        r = out[arm]
        if not r: continue
        aucs=[r[s]['auc'] for s in ASSETS if s in r]; tops=[r[s]['top'] for s in ASSETS if s in r]
        print(f"{arm:<16}" + "".join(f"{r[s]['auc']:>9.3f}" for s in ASSETS if s in r) +
              f"{np.mean(aucs):>10.3f}{np.mean(tops):>21.1f}%")

    print("\n"+"="*84); print("PORTFOLIO OUTCOME (T9 rule applied to each arm's signal)")
    print(f"{'arm':<16}{'meanCalmar':>12}{'meanMaxDD':>11}{'meanCAGR':>10}{'turn/y':>9}{'drawdowns anticipated':>24}")
    for arm in F:
        r = out[arm]
        if not r: continue
        an = sum(r[s]['antic'] for s in r); tt = sum(r[s]['neps'] for s in r)
        print(f"{arm:<16}{np.mean([r[s]['calmar'] for s in r]):>12.2f}{np.mean([r[s]['dd'] for s in r]):>10.1f}%"
              f"{np.mean([r[s]['cagr'] for s in r]):>9.1f}%{np.mean([r[s]['turn'] for s in r]):>9.1f}{f'{an}/{tt} = {an/max(1,tt)*100:.0f}%':>24}")

    print("\n"+"="*84); print("THE DECISIVE TEST — T16's 9 ASSET-SPECIFIC crash clusters")
    print(f"{'arm':<16}{'anticipated':>13}   detail")
    for arm in F:
        r = out[arm]
        if not r: continue
        h = sum(r[s]['spec'][0] for s in r); t_ = sum(r[s]['spec'][1] for s in r)
        det = " ".join(f"{s[:3]}{r[s]['spec'][0]}/{r[s]['spec'][1]}" for s in r if r[s]['spec'][1])
        print(f"{arm:<16}{f'{h}/{t_}':>13}   {det}")


if __name__ == '__main__':
    main()
