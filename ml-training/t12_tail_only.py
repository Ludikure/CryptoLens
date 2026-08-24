#!/usr/bin/env python3
"""T12 — tail-risk-only overlay. Activate T9 ONLY when crash probability is elevated AND the market
is already showing stress. No new features, no retraining, no threshold sweep.

DECLARED BY ME (spec said "same exposure reduction" without specifying the vol-only ladder):
  Control 3 mirrors T9's structure driven by volatility percentile: >80th -> 50%, >90th -> 0%.
Volatility percentiles are EXPANDING (information available at the time), never full-sample.
"""
import numpy as np, pandas as pd

T9_D = lambda p: 1.00 if p < .30 else (0.50 if p <= .50 else 0.00)
PROB_T, VOL_PCT = 0.30, 0.80
EPISODES = [('2020 H2 bull','2020-07-01','2021-04-14','bull'), ('2021 leg-2 bull','2021-07-20','2021-11-10','bull'),
            ('2021 crash','2021-04-14','2021-07-20','crash'), ('2022 bear','2021-11-10','2022-11-21','crash'),
            ('2022-25 recovery','2022-11-21','2025-10-06','bull'), ('2023 corrections','2023-07-13','2023-09-11','crash'),
            ('2024 corrections','2024-03-13','2024-08-05','crash'), ('2025 crash','2025-01-21','2025-04-08','crash'),
            ('2025-26 drawdown','2025-10-06','2026-06-29','crash')]


def mets(r):
    r = r.dropna()
    if len(r) < 5: return {}
    eq = (1+r).cumprod(); yrs = len(r)/365.25; dd = eq/eq.cummax()-1
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    dn = r[r < 0]
    return dict(total=(eq.iloc[-1]-1)*100, cagr=cagr, dd=dd.min()*100,
                calmar=cagr/abs(dd.min()*100) if dd.min() else np.nan,
                sharpe=r.mean()/r.std()*np.sqrt(365.25) if r.std() else np.nan,
                sortino=r.mean()/dn.std()*np.sqrt(365.25) if len(dn) and dn.std() else np.nan)


def profile(w):
    ch = w.diff().abs().fillna(0)
    defensive = w < 1.0
    grp = (defensive != defensive.shift()).cumsum()
    lens = [len(s) for _, s in w[defensive].groupby(grp[defensive])]
    return dict(avgexp=w.mean()*100, turnover=ch.sum()/(len(w)/365.25),
                changes=int((ch > 1e-9).sum()), episodes=len(lens),
                medlen=float(np.median(lens)) if lens else 0.0)


def main():
    s = pd.read_csv('t9_signal.csv'); s['date'] = pd.to_datetime(s.date).dt.date
    sig = s.set_index('date')['p']
    px = pd.read_csv('csv_exports_v14/BTCUSDT.csv', usecols=['timestamp','price'], low_memory=False)
    px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
    btc = px.groupby('date')['price'].last()
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date']); tb['date'] = tb.date.dt.date
    cash = tb.set_index('date')['rate'].reindex(btc.index).ffill().fillna(0)/100/365.25
    d = pd.DataFrame({'btc': btc.pct_change(), 'cash': cash, 'px': btc}).join(sig.rename('p'), how='left')
    d['p'] = d['p'].ffill(); d = d.dropna(subset=['btc','p'])
    # realised vol + EXPANDING percentiles: no full-sample lookahead
    rv = d.btc.rolling(20).std()
    d['rv80'] = rv > rv.expanding(200).quantile(VOL_PCT)
    d['rv90'] = rv > rv.expanding(200).quantile(0.90)
    d['sig'] = d['p'].shift(1); d['s80'] = d.rv80.shift(1).fillna(False); d['s90'] = d.rv90.shift(1).fillna(False)
    d = d.dropna(subset=['btc','sig'])
    print(f"T12: {len(d):,} days {d.index[0]} -> {d.index[-1]}")
    print(f"  stress (vol>80th) on {d.s80.mean()*100:.0f}% of days;  crash p>0.30 on {(d.sig>PROB_T).mean()*100:.0f}%;"
          f"  BOTH on {((d.sig>PROB_T)&d.s80).mean()*100:.0f}%\n")

    w9 = d.sig.map(T9_D)
    extreme = (d.sig > PROB_T) & d.s80
    w12 = pd.Series(np.where(extreme, w9, 1.0), index=d.index)
    wvol = pd.Series(np.where(d.s90, 0.0, np.where(d.s80, 0.5, 1.0)), index=d.index)
    wlag = d.sig.shift(30).ffill().bfill().map(T9_D)
    rng = np.random.default_rng(0)

    def ret(w, c=0.0): return w*d.btc + (1-w)*d.cash - w.diff().abs().fillna(0)*c
    arms = {'BTC B&H': pd.Series(1.0, index=d.index), 'T9 (ctrl4: prob only)': w9,
            'T12 tail-only': w12, 'ctrl3: vol only': wvol, 'ctrl2: 30d lag': wlag}
    R = {k: ret(v) for k, v in arms.items()}; M = {k: mets(v) for k, v in R.items()}; P = {k: profile(v) for k, v in arms.items()}
    print(f"{'arm':<24}{'CAGR':>8}{'maxDD':>9}{'Calmar':>8}{'Sharpe':>8}{'Sortino':>9}{'avgExp':>8}{'turn/y':>8}{'chg':>6}{'eps':>5}{'medLen':>8}")
    for k in arms:
        m, p_ = M[k], P[k]
        print(f"{k:<24}{m['cagr']:>7.1f}%{m['dd']:>8.1f}%{m['calmar']:>8.2f}{m['sharpe']:>8.2f}{m['sortino']:>9.2f}"
              f"{p_['avgexp']:>7.0f}%{p_['turnover']:>8.1f}{p_['changes']:>6}{p_['episodes']:>5}{p_['medlen']:>8.0f}")
    sh = [mets(ret(pd.Series(np.where((pd.Series(rng.permutation(d.sig.values), index=d.index) > PROB_T) & d.s80,
          pd.Series(rng.permutation(d.sig.values), index=d.index).map(T9_D), 1.0), index=d.index))) for _ in range(20)]
    print(f"{'ctrl1: shuffled probs':<24}{np.mean([x['cagr'] for x in sh]):>7.1f}%{np.mean([x['dd'] for x in sh]):>8.1f}%{np.mean([x['calmar'] for x in sh]):>8.2f}")

    print(f"\n--- PER-EPISODE (no aggregation) ---")
    print(f"  {'episode':<20}{'kind':<7}{'BTC':>8}{'T9':>8}{'T12':>8}{'volOnly':>9}{'T12 exp':>9}")
    ep_imp = {}
    for nm, a, b, kind in EPISODES:
        m = (pd.Index(d.index) >= pd.Timestamp(a).date()) & (pd.Index(d.index) <= pd.Timestamp(b).date())
        if m.sum() < 15: continue
        bb = ((1+d.btc[m]).prod()-1)*100
        r9 = ((1+R['T9 (ctrl4: prob only)'][m]).prod()-1)*100
        r12 = ((1+R['T12 tail-only'][m]).prod()-1)*100
        rv_ = ((1+R['ctrl3: vol only'][m]).prod()-1)*100
        ep_imp[nm] = r12 - r9
        print(f"  {nm:<20}{kind:<7}{bb:>7.0f}%{r9:>7.0f}%{r12:>7.0f}%{rv_:>8.0f}%{w12[m].mean()*100:>8.0f}%")

    print(f"\n--- SHIP BAR ---")
    t9, t12, vol = M['T9 (ctrl4: prob only)'], M['T12 tail-only'], M['ctrl3: vol only']
    p9, p12 = P['T9 (ctrl4: prob only)'], P['T12 tail-only']
    c1 = (t12['calmar'] > t9['calmar'] or (abs(t9['dd'])-abs(t12['dd'])) >= 5) and t12['cagr'] >= t9['cagr']*0.90
    c2 = p12['turnover'] <= p9['turnover']*0.70
    c3 = t12['calmar'] > vol['calmar']
    c4 = t12['calmar'] > np.mean([x['calmar'] for x in sh])*1.5
    ho = slice(int(len(d)*0.8), None)
    c5 = mets(R['T12 tail-only'].iloc[ho])['calmar'] > mets(R['T9 (ctrl4: prob only)'].iloc[ho])['calmar']
    tot_imp = sum(abs(v) for v in ep_imp.values())
    top = max(abs(v) for v in ep_imp.values())/tot_imp if tot_imp else 1
    c6 = top <= 0.50
    for ok, t in [(c1, f"1. Calmar>T9 or maxDD -5pp, CAGR kept  {t12['calmar']:.2f} vs {t9['calmar']:.2f} | dd {t12['dd']:.1f} vs {t9['dd']:.1f} | CAGR {t12['cagr']:.1f} vs {t9['cagr']:.1f}"),
                  (c2, f"2. turnover cut >=30%                   {p12['turnover']:.1f} vs {p9['turnover']:.1f} ({(1-p12['turnover']/p9['turnover'])*100:.0f}% cut)"),
                  (c3, f"3. beats vol-only Calmar                {t12['calmar']:.2f} vs {vol['calmar']:.2f}"),
                  (c4, f"4. beats shuffled decisively            {t12['calmar']:.2f} vs {np.mean([x['calmar'] for x in sh]):.2f}"),
                  (c5, f"5. survives holdout vs T9               {mets(R['T12 tail-only'].iloc[ho])['calmar']:.2f} vs {mets(R['T9 (ctrl4: prob only)'].iloc[ho])['calmar']:.2f}"),
                  (c6, f"6. no episode >50% of improvement       {top*100:.0f}%")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  VERDICT: {'SHIP' if all([c1,c2,c3,c4,c5,c6]) else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
