#!/usr/bin/env python3
"""T8 — crash-protection overlay on BTC buy-and-hold.
Design pre-declared by the user. No shorting, no leverage, no options, no funding, no venue data.

Asks the narrow question: can a WEAKLY predictive crash signal (T2, AUC 0.637 — which FAILED its own
bar) still be useful as insurance? The model need not predict direction, only distinguish periods of
unusually high drawdown risk.
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util
from pathlib import Path

ARMS = {                                    # thresholds frozen before evaluation
    'A: B&H control':      lambda p: 1.00,
    'B: light overlay':    lambda p: 1.00 if p < .30 else (0.75 if p <= .50 else 0.50),
    'C: moderate overlay': lambda p: 1.00 if p < .30 else (0.60 if p <= .50 else 0.25),
    'D: defensive overlay':lambda p: 1.00 if p < .30 else (0.50 if p <= .50 else 0.00),
}
WINDOWS = [('FULL','2020-01-01','2026-06-29'), ('BULL','2020-01-01','2021-11-10'),
           ('BEAR 2022','2021-11-10','2022-11-21'), ('RECOVERY','2022-11-21','2025-10-06'),
           ('LATE-BEAR','2025-10-06','2026-06-29')]


def metrics(r, bh_cagr=None, bh_dd=None):
    r = r.dropna()
    if len(r) < 30: return {}
    eq = (1+r).cumprod(); yrs = len(r)/365.25
    peak = eq.cummax(); dd = (eq/peak-1)
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    down = r[r < 0]
    m = dict(total=(eq.iloc[-1]-1)*100, cagr=cagr, dd=dd.min()*100,
             vol=r.std()*np.sqrt(365.25)*100,
             sharpe=r.mean()/r.std()*np.sqrt(365.25) if r.std() else np.nan,
             sortino=r.mean()/down.std()*np.sqrt(365.25) if len(down) and down.std() else np.nan,
             underwater=(dd < -0.001).mean()*100)
    m['calmar'] = cagr/abs(dd.min()*100) if dd.min() else np.nan
    if bh_cagr: m['retention'] = cagr/bh_cagr*100
    if bh_dd:   m['ddreduction'] = (1-abs(dd.min()*100)/abs(bh_dd))*100
    return m


def main():
    spec = importlib.util.spec_from_file_location('t2','t2_t3_test.py')
    t2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(t2)
    a, feats = t2.build()
    a = a.dropna(subset=['y_crash']).reset_index(drop=True)
    n = len(a)
    # T2's config and target, frozen. Folds extended to maximise OOS coverage — the RECIPE is
    # unchanged, only the number of walk-forward steps, so nothing is retrained differently.
    preds = []
    for i in range(8):
        tr_end = int(n*(0.20+0.10*i)); te_end = int(n*(0.30+0.10*i))
        if te_end > n: break
        tr, te = a.iloc[:max(0, tr_end-72)], a.iloc[tr_end:te_end]   # purge 72 > 60-bar label horizon
        if len(tr) < 5000 or len(te) < 500: continue
        m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.05,
                               num_leaves=15, verbose=-1, n_jobs=-1)
        m.fit(tr[feats], tr['y_crash'])
        t = te[te.sym == 'BTCUSDT'].copy()
        if len(t): t['p'] = m.predict_proba(t[feats])[:, 1]; preds.append(t[['timestamp','p']])
    P = pd.concat(preds).sort_values('timestamp')
    P['date'] = pd.to_datetime(P.timestamp, unit='s', utc=True).dt.date
    sig = P.groupby('date')['p'].last()                       # signal at daily close

    px = pd.read_csv('csv_exports_v14/BTCUSDT.csv', usecols=['timestamp','price'], low_memory=False)
    px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
    btc = px.groupby('date')['price'].last()
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date'])
    tb['date'] = tb.date.dt.date
    cash = tb.set_index('date')['rate'].reindex(btc.index).ffill().fillna(0)/100/365.25

    d = pd.DataFrame({'btc': btc.pct_change(), 'cash': cash}).join(sig.rename('p'), how='left')
    d['p'] = d['p'].ffill()
    d = d.dropna(subset=['btc','p'])
    d['p_lag1'] = d['p'].shift(1)                             # implement NEXT bar — no lookahead
    d = d.dropna(subset=['p_lag1'])
    print(f"BTC crash-overlay test: {len(d):,} days  {d.index[0]} -> {d.index[-1]}")
    print(f"  crash prob: mean {d.p_lag1.mean():.3f}  <30% {(d.p_lag1<.3).mean()*100:.0f}%  "
          f"30-50% {((d.p_lag1>=.3)&(d.p_lag1<=.5)).mean()*100:.0f}%  >50% {(d.p_lag1>.5).mean()*100:.0f}%")
    print(f"  cash rate: mean {d.cash.mean()*365.25*100:.2f}% annualised\n")

    def run(sig_series, arm):
        w = sig_series.map(ARMS[arm])
        return w*d.btc + (1-w)*d.cash

    bh = metrics(run(d.p_lag1, 'A: B&H control'))
    print(f"{'arm':<24}{'total':>10}{'CAGR':>8}{'maxDD':>9}{'Calmar':>8}{'Sharpe':>8}{'Sortino':>9}{'vol':>7}{'u/w%':>7}{'retain':>8}{'ddCut':>7}")
    res = {}
    for arm in ARMS:
        r = run(d.p_lag1, arm); m = metrics(r, bh['cagr'], bh['dd']); res[arm] = (r, m)
        print(f"{arm:<24}{m['total']:>9,.0f}%{m['cagr']:>7.1f}%{m['dd']:>8.1f}%{m['calmar']:>8.2f}"
              f"{m['sharpe']:>8.2f}{m['sortino']:>9.2f}{m['vol']:>6.0f}%{m['underwater']:>6.0f}%"
              f"{m.get('retention',0):>7.0f}%{m.get('ddreduction',0):>6.0f}%")

    print("\n--- MANDATORY CONTROL 1: SHUFFLED SIGNAL (distribution preserved, timing destroyed) ---")
    for arm in list(ARMS)[1:]:
        sh = []
        for s in range(5):
            rng = np.random.default_rng(s)
            perm = pd.Series(rng.permutation(d.p_lag1.values), index=d.index)
            sh.append(metrics(run(perm, arm), bh['cagr'], bh['dd']))
        real = res[arm][1]
        print(f"  {arm:<24} real Calmar {real['calmar']:.2f} / ddCut {real['ddreduction']:.0f}%"
              f"   shuffled {np.mean([x['calmar'] for x in sh]):.2f} / {np.mean([x['ddreduction'] for x in sh]):.0f}%"
              f"   -> {'TIMING MATTERS' if real['calmar'] > np.mean([x['calmar'] for x in sh])*1.1 else 'NO TIMING VALUE'}")

    print("\n--- MANDATORY CONTROL 2: SIGNAL LAGGED 30 DAYS ---")
    lag = d.p_lag1.shift(30).ffill().bfill()
    for arm in list(ARMS)[1:]:
        m = metrics(run(lag, arm), bh['cagr'], bh['dd']); real = res[arm][1]
        print(f"  {arm:<24} real Calmar {real['calmar']:.2f}   lagged {m['calmar']:.2f}"
              f"   -> {'timing is real' if real['calmar'] > m['calmar']*1.1 else 'LAG PERFORMS SIMILARLY'}")

    print("\n--- MANDATORY ROBUSTNESS: same windows as T7, BTC B&H benchmark each time ---")
    print(f"  {'window':<14}" + "".join(f"{a.split(':')[0]:>22}" for a in ARMS))
    for nm, s, e in WINDOWS:
        mask = (pd.Index(d.index) >= pd.Timestamp(s).date()) & (pd.Index(d.index) <= pd.Timestamp(e).date())
        if mask.sum() < 60: print(f"  {nm:<14}  (no OOS coverage)"); continue
        row = f"  {nm:<14}"
        for arm in ARMS:
            m = metrics(run(d.p_lag1, arm)[mask])
            row += f"{m['total']:>13.0f}% {m['dd']:>6.0f}%"
        print(row)

    print("\n--- SHIP BAR ---")
    cuts = np.array_split(np.arange(len(d)), 3)
    ho = slice(int(len(d)*0.8), None)
    bh_ho = metrics(run(d.p_lag1,'A: B&H control').iloc[ho])
    passed = []
    for arm in list(ARMS)[1:]:
        r, m = res[arm]
        c1 = m['retention'] >= 80
        c2 = m['ddreduction'] >= 0 and (abs(bh['dd']) - abs(m['dd'])) >= 25
        c3 = m['calmar'] >= bh['calmar']*1.25
        c4 = sum(1 for c in cuts if (1+r.iloc[c]).prod() > 1) >= 2
        c5 = metrics(r.iloc[ho])['calmar'] > bh_ho['calmar']
        ok = all([c1,c2,c3,c4,c5])
        passed.append(ok)
        print(f"  {arm}")
        print(f"    [{'P' if c1 else 'F'}] 1. retains >=80% CAGR        {m['retention']:.0f}%")
        print(f"    [{'P' if c2 else 'F'}] 2. maxDD better by >=25pp    {abs(bh['dd'])-abs(m['dd']):+.1f}pp")
        print(f"    [{'P' if c3 else 'F'}] 3. Calmar +25%               {m['calmar']:.2f} vs {bh['calmar']:.2f}")
        print(f"    [{'P' if c4 else 'F'}] 4. positive >=2/3 folds      {sum(1 for c in cuts if (1+r.iloc[c]).prod()>1)}/3")
        print(f"    [{'P' if c5 else 'F'}] 5. beats B&H Calmar holdout  {metrics(r.iloc[ho])['calmar']:.2f} vs {bh_ho['calmar']:.2f}")
    print(f"\n  6. no shorting  [PASS]   7. no inaccessible venue data  [PASS]")
    print(f"\n  VERDICT: {'SHIP' if any(passed) else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
