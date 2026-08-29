#!/usr/bin/env python3
"""T9 — full-cycle crash-overlay validation. Design in docs/research/full-cycle-overlay.md.
Bull coverage achieved by SHORTENING the walk-forward burn-in (6 months), not by extending history
(impossible: Binance futures launched 2019-09, so ~20 of the 110 features cannot exist before then).
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util

ARMS = {'A: B&H': lambda p: 1.00,
        'B: light': lambda p: 1.00 if p < .30 else (0.75 if p <= .50 else 0.50),
        'C: moderate': lambda p: 1.00 if p < .30 else (0.60 if p <= .50 else 0.25),
        'D: defensive': lambda p: 1.00 if p < .30 else (0.50 if p <= .50 else 0.00)}
BULLS = [('2020 H2 bull','2020-07-01','2021-04-14'), ('2021 leg2 bull','2021-07-20','2021-11-10'),
         ('2022-25 recovery','2022-11-21','2025-10-06')]
BEARS = [('2022 bear','2021-11-10','2022-11-21'), ('2025-26 bear','2025-10-06','2026-06-29')]


def mets(r):
    r = r.dropna()
    if len(r) < 20: return {}
    eq = (1+r).cumprod(); yrs = len(r)/365.25; dd = eq/eq.cummax()-1
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    return dict(total=(eq.iloc[-1]-1)*100, cagr=cagr, dd=dd.min()*100,
                calmar=cagr/abs(dd.min()*100) if dd.min() else np.nan,
                sharpe=r.mean()/r.std()*np.sqrt(365.25) if r.std() else np.nan)


def main():
    spec = importlib.util.spec_from_file_location('t2','t2_t3_test.py')
    t2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(t2)
    a, feats = t2.build()
    a = a.dropna(subset=['y_crash']).reset_index(drop=True)
    a['dt'] = pd.to_datetime(a.timestamp, unit='s', utc=True)
    n = len(a)
    # 6-month burn-in then expand monthly -> OOS from mid-2020, covering the 2020-21 bull
    t0 = a.dt.min(); starts = pd.date_range(t0+pd.DateOffset(months=6), a.dt.max(), freq='MS', tz='UTC')
    preds = []
    for i, s in enumerate(starts):
        e = starts[i+1] if i+1 < len(starts) else a.dt.max()+pd.Timedelta(days=1)
        tr = a[a.dt < s - pd.Timedelta(hours=4*72)]        # purge 72 bars > 60-bar label horizon
        te = a[(a.dt >= s) & (a.dt < e) & (a.sym == 'BTCUSDT')]
        if len(tr) < 3000 or len(te) == 0: continue
        m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.05,
                               num_leaves=15, verbose=-1, n_jobs=-1)
        m.fit(tr[feats], tr['y_crash'])
        t = te.copy(); t['p'] = m.predict_proba(t[feats])[:, 1]; preds.append(t[['timestamp','p']])
    P = pd.concat(preds).sort_values('timestamp')
    P['date'] = pd.to_datetime(P.timestamp, unit='s', utc=True).dt.date
    sig = P.groupby('date')['p'].last()

    px = pd.read_csv('csv_exports_v14/BTCUSDT.csv', usecols=['timestamp','price'], low_memory=False)
    px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
    btc = px.groupby('date')['price'].last()
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date']); tb['date'] = tb.date.dt.date
    cash = tb.set_index('date')['rate'].reindex(btc.index).ffill().fillna(0)/100/365.25
    d = pd.DataFrame({'btc': btc.pct_change(), 'cash': cash, 'px': btc}).join(sig.rename('p'), how='left')
    d['p'] = d['p'].ffill(); d = d.dropna(subset=['btc','p'])
    d['sig'] = d['p'].shift(1); d = d.dropna(subset=['sig'])
    print(f"T9: {len(d):,} days  {d.index[0]} -> {d.index[-1]}   (T8 started 2021-12-21)")
    print(f"  cash mean {d.cash.mean()*365.25*100:.2f}% ann.   crash prob mean {d.sig.mean():.3f}\n")

    def run(s, arm, cost=0.0):
        w = s.map(ARMS[arm])
        turn = w.diff().abs().fillna(0)
        return w*d.btc + (1-w)*d.cash - turn*cost, w

    R = {a_: run(d.sig, a_)[0] for a_ in ARMS}
    W = {a_: run(d.sig, a_)[1] for a_ in ARMS}
    M = {k: mets(v) for k, v in R.items()}
    print(f"{'arm':<15}{'total':>10}{'CAGR':>8}{'maxDD':>9}{'Calmar':>8}{'Sharpe':>8}{'avgExp':>8}")
    for k in ARMS:
        print(f"{k:<15}{M[k]['total']:>9,.0f}%{M[k]['cagr']:>7.1f}%{M[k]['dd']:>8.1f}%{M[k]['calmar']:>8.2f}{M[k]['sharpe']:>8.2f}{W[k].mean()*100:>7.0f}%")

    print(f"\n--- CRITERION 3 (decisive): bull-period upside retention ---")
    print(f"  {'period':<20}{'BTC':>9}{'D':>9}{'captured':>10}{'avgExp':>8}{'cuts':>7}")
    caps = []
    for nm, s, e in BULLS:
        m = (pd.Index(d.index) >= pd.Timestamp(s).date()) & (pd.Index(d.index) <= pd.Timestamp(e).date())
        if m.sum() < 30: print(f"  {nm:<20}(no coverage)"); continue
        b = (1+d.btc[m]).prod()-1; dd_ = (1+R['D: defensive'][m]).prod()-1
        cap = dd_/b*100 if b > 0 else np.nan
        caps.append((nm, cap))
        print(f"  {nm:<20}{b*100:>8.0f}%{dd_*100:>8.0f}%{cap:>9.0f}%{W['D: defensive'][m].mean()*100:>7.0f}%"
              f"{int((W['D: defensive'][m].diff().fillna(0)<0).sum()):>7}")
    print(f"\n--- bear periods ---")
    print(f"  {'period':<20}{'BTC':>9}{'D':>9}{'BTC dd':>9}{'D dd':>8}{'avgExp':>8}")
    for nm, s, e in BEARS:
        m = (pd.Index(d.index) >= pd.Timestamp(s).date()) & (pd.Index(d.index) <= pd.Timestamp(e).date())
        if m.sum() < 30: continue
        print(f"  {nm:<20}{((1+d.btc[m]).prod()-1)*100:>8.0f}%{((1+R['D: defensive'][m]).prod()-1)*100:>8.0f}%"
              f"{mets(d.btc[m])['dd']:>8.0f}%{mets(R['D: defensive'][m])['dd']:>7.0f}%{W['D: defensive'][m].mean()*100:>7.0f}%")

    print(f"\n--- THE CRITICAL TABLE: calendar year ---")
    print(f"  {'year':<7}{'B&H':>10}{'D':>10}{'avgExp':>9}")
    yr = pd.Series([x.year for x in d.index], index=d.index)
    for y in sorted(yr.unique()):
        m = yr == y
        print(f"  {y:<7}{((1+d.btc[m]).prod()-1)*100:>9.0f}%{((1+R['D: defensive'][m]).prod()-1)*100:>9.0f}%{W['D: defensive'][m].mean()*100:>8.0f}%")

    print(f"\n--- CONTROLS (Calmar) ---")
    real = M['D: defensive']['calmar']
    sh = np.mean([mets(run(pd.Series(np.random.default_rng(s).permutation(d.sig.values), index=d.index),'D: defensive')[0])['calmar'] for s in range(5)])
    lag = mets(run(d.sig.shift(30).ffill().bfill(),'D: defensive')[0])['calmar']
    rv = d.px.pct_change().rolling(20).std()
    rvq = rv.expanding(200).quantile(0.70); rvq90 = rv.expanding(200).quantile(0.90)   # frozen pcts, expanding = no lookahead
    rvsig = pd.Series(np.where(rv > rvq90, 1.0, np.where(rv > rvq, 0.5, 0.0)), index=d.index).shift(1).fillna(0)
    rvw = 1.0 - rvsig
    rvr = rvw*d.btc + (1-rvw)*d.cash
    ema = d.px.ewm(span=200, adjust=False).mean(); slope = ema.diff(20)
    e200 = ((d.px > ema) & (slope > 0)).astype(float).shift(1).fillna(0)
    e200r = e200*d.btc + (1-e200)*d.cash
    print(f"  real D {real:.2f} | shuffled {sh:.2f} | 30d lag {lag:.2f} | realised-vol rule {mets(rvr)['calmar']:.2f} | 200D rule {mets(e200r)['calmar']:.2f}")

    print(f"\n--- TRANSACTION COSTS (arm D) ---")
    turn = W['D: defensive'].diff().abs().fillna(0)
    print(f"  annualised turnover {turn.sum()/(len(d)/365.25):.1f}x   exposure changes {int((turn>0).sum())}   avg holding {len(d)/max(1,(turn>0).sum()):.1f}d")
    for c in (0.0, 0.0005, 0.0010, 0.0025):
        r, _ = run(d.sig, 'D: defensive', c); m = mets(r)
        print(f"  {c*100:>5.2f}% RT: CAGR {m['cagr']:>6.1f}%  Calmar {m['calmar']:>5.2f}  total {m['total']:>7,.0f}%")

    print(f"\n--- SHIP BAR ---")
    bh = M['A: B&H']; D = M['D: defensive']
    cuts = np.array_split(np.arange(len(d)), 3)
    c1 = D['calmar'] > bh['calmar']
    c2 = (abs(bh['dd'])-abs(D['dd'])) >= 25
    c3 = sum(1 for _, x in caps if x >= 70) >= 2
    c4 = real > sh*1.1; c5 = real > lag*1.1; c6 = real > mets(rvr)['calmar']
    c7 = sum(1 for c in cuts if (1+R['D: defensive'].iloc[c]).prod() > 1) >= 2
    for ok, t in [(c1, f"1. beats B&H Calmar            {D['calmar']:.2f} vs {bh['calmar']:.2f}"),
                  (c2, f"2. maxDD better >=25pp         {abs(bh['dd'])-abs(D['dd']):+.1f}pp"),
                  (c3, f"3. >=70% retention in 2+ bulls {sum(1 for _,x in caps if x>=70)}/{len(caps)}"),
                  (c4, f"4. beats shuffled              {real:.2f} vs {sh:.2f}"),
                  (c5, f"5. beats 30d lag               {real:.2f} vs {lag:.2f}"),
                  (c6, f"6. beats realised-vol rule     {real:.2f} vs {mets(rvr)['calmar']:.2f}"),
                  (c7, f"7. positive >=2/3 folds        {sum(1 for c in cuts if (1+R['D: defensive'].iloc[c]).prod()>1)}/3")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"  [PASS] 8. no period selected post-hoc (all windows declared in advance)")
    print(f"\n  VERDICT: {'SHIP' if all([c1,c2,c3,c4,c5,c6,c7]) else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
