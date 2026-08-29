#!/usr/bin/env python3
"""T15 — continuous crash-risk position sizing. Frozen mapping, frozen 10pp rebalance band.

DECLARED BY ME (spec left the control mappings open): CTRL 3 and CTRL 4 each build a risk score in
[0,1] (higher = more dangerous) and feed it through the SAME frozen exposure curve, so the three arms
differ only in what generates the score:
  CTRL3 risk = expanding percentile of 20d realised volatility
  CTRL4 risk = 1 - expanding percentile of (price / 200D EMA)
CTRL 2 permutes constant-exposure RUNS, preserving the exposure distribution AND turnover exactly.
"""
import numpy as np, pandas as pd

PTS = np.array([0.20, 0.30, 0.40, 0.50, 0.60, 0.70])          # frozen
EXP = np.array([1.00, 0.85, 0.70, 0.55, 0.40, 0.25])          # frozen
BAND, COST = 0.10, 0.0010
T9_D = lambda p: 1.00 if p < .30 else (0.50 if p <= .50 else 0.00)
REGIMES = [('2020 bull','2020-07-01','2021-04-14'), ('2021 bull','2021-04-15','2021-11-10'),
           ('2022 bear','2021-11-10','2022-11-21'), ('2022-25 recovery','2022-11-21','2025-10-06'),
           ('2025-26 bear','2025-10-06','2026-06-29')]


def curve(x): return np.interp(x, PTS, EXP)


def band_filter(target):
    """Trade only when the target moves >= BAND from the held position."""
    out = np.empty(len(target)); cur = target.iloc[0]
    for i, t in enumerate(target.values):
        if abs(t-cur) >= BAND: cur = t
        out[i] = cur
    return pd.Series(out, index=target.index)


def mets(r):
    r = r.dropna()
    if len(r) < 20: return {}
    eq = (1+r).cumprod(); yrs = len(r)/365.25; dd = eq/eq.cummax()-1
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    dn = r[r < 0]
    return dict(cagr=cagr, dd=dd.min()*100, calmar=cagr/abs(dd.min()*100) if dd.min() else np.nan,
                sharpe=r.mean()/r.std()*np.sqrt(365.25) if r.std() else np.nan,
                sortino=r.mean()/dn.std()*np.sqrt(365.25) if len(dn) and dn.std() else np.nan)


def main():
    s = pd.read_csv('t9_signal.csv'); s['date'] = pd.to_datetime(s.date).dt.date
    sig = s.set_index('date')['p']
    px = pd.read_csv('csv_exports_v14/BTCUSDT.csv', usecols=['timestamp','price'], low_memory=False)
    px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
    btc = px.groupby('date')['price'].last()
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date']); tb['date'] = tb.date.dt.date
    d = pd.DataFrame({'px': btc}).join(sig.rename('p'), how='left')
    d['p'] = d['p'].ffill(); d['cashr'] = tb.set_index('date')['rate'].reindex(d.index).ffill().fillna(0)/100/365.25
    d = d.dropna(subset=['p']); d['btc'] = d.px.pct_change(); d['sig'] = d.p.shift(1)
    d = d.dropna(subset=['btc','sig'])

    rv = d.btc.rolling(20).std()
    risk_vol = rv.expanding(200).apply(lambda x: (x.iloc[-1] >= x).mean(), raw=False).shift(1).fillna(0.5)
    ema = d.px.ewm(span=200, adjust=False).mean(); ratio = d.px/ema
    risk_ema = (1 - ratio.expanding(200).apply(lambda x: (x.iloc[-1] >= x).mean(), raw=False)).shift(1).fillna(0.5)

    W = {'T15 continuous':        band_filter(pd.Series(curve(d.sig.values), index=d.index)),
         'CTRL1 T9 baseline':     d.sig.map(T9_D),
         'CTRL3 vol sizing':      band_filter(pd.Series(curve(risk_vol.values), index=d.index)),
         'CTRL4 200D sizing':     band_filter(pd.Series(curve(risk_ema.values), index=d.index)),
         'CTRL5 static 70% BTC':  pd.Series(0.70, index=d.index),
         'BTC 100%':              pd.Series(1.00, index=d.index)}

    def ret(w, c=COST): return w*d.btc + (1-w)*d.cashr - w.diff().abs().fillna(0)*c
    R = {k: ret(v) for k, v in W.items()}; M = {k: mets(v) for k, v in R.items()}

    # CTRL2: permute constant-exposure RUNS -> distribution and turnover preserved exactly
    w15 = W['T15 continuous']; runs = []
    cur = [w15.iloc[0]]
    for v in w15.values[1:]:
        if v == cur[-1]: cur.append(v)
        else: runs.append(cur); cur = [v]
    runs.append(cur)
    sh = []
    for sd in range(20):
        order = np.random.default_rng(sd).permutation(len(runs))
        seq = np.concatenate([runs[i] for i in order])[:len(w15)]
        sh.append(mets(ret(pd.Series(seq, index=w15.index))))
    M['CTRL2 shuffled runs'] = {k: np.mean([x[k] for x in sh]) for k in sh[0]}

    print(f"T15: {len(d):,} days {d.index[0]} -> {d.index[-1]}\n")
    print(f"{'arm':<24}{'CAGR':>8}{'maxDD':>9}{'Calmar':>8}{'Sharpe':>8}{'Sortino':>9}{'avgExp':>8}{'turn/y':>8}{'taxEv':>7}")
    order_ = ['BTC 100%','CTRL1 T9 baseline','T15 continuous','CTRL3 vol sizing','CTRL4 200D sizing','CTRL5 static 70% BTC','CTRL2 shuffled runs']
    for k in order_:
        m = M[k]
        if k in W:
            ch = W[k].diff().abs().fillna(0)
            print(f"{k:<24}{m['cagr']:>7.1f}%{m['dd']:>8.1f}%{m['calmar']:>8.2f}{m['sharpe']:>8.2f}{m['sortino']:>9.2f}"
                  f"{W[k].mean()*100:>7.0f}%{ch.sum()/(len(d)/365.25):>8.1f}{int((ch>1e-9).sum()):>7}")
        else:
            print(f"{k:<24}{m['cagr']:>7.1f}%{m['dd']:>8.1f}%{m['calmar']:>8.2f}{m['sharpe']:>8.2f}{m['sortino']:>9.2f}{'—':>8}{'—':>8}{'—':>7}")

    print(f"\n--- PARETO: can continuous sizing move T9 toward MORE return AND LESS drawdown? ---")
    for k in ['BTC 100%','CTRL1 T9 baseline','T15 continuous']:
        print(f"  {k:<22} CAGR {M[k]['cagr']:>6.1f}%   maxDD {M[k]['dd']:>7.1f}%   Calmar {M[k]['calmar']:.2f}")
    t9, t15 = M['CTRL1 T9 baseline'], M['T15 continuous']
    print(f"  -> vs T9: CAGR {t15['cagr']-t9['cagr']:+.1f}pp, maxDD {abs(t9['dd'])-abs(t15['dd']):+.1f}pp better")

    print(f"\n--- REGIME SWEEP ---")
    print(f"  {'regime':<20}{'BTC':>9}{'T9':>9}{'T15':>9}{'T15 exp':>9}")
    ep = {}
    for nm, a, b in REGIMES:
        m = (pd.Index(d.index) >= pd.Timestamp(a).date()) & (pd.Index(d.index) <= pd.Timestamp(b).date())
        if m.sum() < 20: continue
        bb = ((1+d.btc[m]).prod()-1)*100; r9 = ((1+R['CTRL1 T9 baseline'][m]).prod()-1)*100
        r15 = ((1+R['T15 continuous'][m]).prod()-1)*100
        ep[nm] = r15-r9
        print(f"  {nm:<20}{bb:>8.0f}%{r9:>8.0f}%{r15:>8.0f}%{W['T15 continuous'][m].mean()*100:>8.0f}%")

    print(f"\n--- SHIP BAR ---")
    ho = slice(int(len(d)*0.8), None)
    tot = sum(abs(v) for v in ep.values()); top = max(abs(v) for v in ep.values())/tot if tot else 1
    cr = [(t15['calmar'] > t9['calmar'], f"1. Calmar > T9                {t15['calmar']:.2f} vs {t9['calmar']:.2f}"),
          (abs(t15['dd']) - abs(t9['dd']) <= 5, f"2. maxDD not worse by >5pp    {t15['dd']:.1f}% vs {t9['dd']:.1f}%"),
          (t15['cagr'] >= 0.80*t9['cagr'], f"3. CAGR >= 80% of T9         {t15['cagr']:.1f}% vs {0.8*t9['cagr']:.1f}%"),
          (t15['calmar'] > M['CTRL5 static 70% BTC']['calmar'], f"4. beats static 70% BTC       {t15['calmar']:.2f} vs {M['CTRL5 static 70% BTC']['calmar']:.2f}"),
          (t15['calmar'] > M['CTRL3 vol sizing']['calmar'], f"5. beats vol sizing           {t15['calmar']:.2f} vs {M['CTRL3 vol sizing']['calmar']:.2f}"),
          (t15['calmar'] > M['CTRL4 200D sizing']['calmar'], f"6. beats 200D sizing          {t15['calmar']:.2f} vs {M['CTRL4 200D sizing']['calmar']:.2f}"),
          (t15['calmar'] > M['CTRL2 shuffled runs']['calmar']*1.25, f"7. beats shuffled decisively  {t15['calmar']:.2f} vs {M['CTRL2 shuffled runs']['calmar']:.2f}"),
          (mets(R['T15 continuous'].iloc[ho])['calmar'] > mets(R['CTRL1 T9 baseline'].iloc[ho])['calmar'],
           f"8. persists on holdout        {mets(R['T15 continuous'].iloc[ho])['calmar']:.2f} vs {mets(R['CTRL1 T9 baseline'].iloc[ho])['calmar']:.2f}"),
          (mets(ret(W['T15 continuous'], 0.0025))['calmar'] > mets(ret(W['CTRL1 T9 baseline'], 0.0025))['calmar'],
           f"9. survives 0.25% costs       {mets(ret(W['T15 continuous'],0.0025))['calmar']:.2f} vs {mets(ret(W['CTRL1 T9 baseline'],0.0025))['calmar']:.2f}"),
          (top <= 0.50, f"10. no episode >50%           {top*100:.0f}%")]
    for ok, t in cr: print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  VERDICT: {'SHIP' if all(x for x, _ in cr) else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
