#!/usr/bin/env python3
"""T11 — attribution / placebo audit of T9. No new signal, no features, no optimisation.
Asks whether T9's improvement is attributable to the CRASH MODEL rather than to generic exposure
reduction or a lucky sequence of 2020-2026 regimes.
"""
import numpy as np, pandas as pd

T9_D = lambda p: 1.00 if p < .30 else (0.50 if p <= .50 else 0.00)
REGIMES = [('2020 bull','2020-07-01','2021-04-14'), ('2021 bull','2021-04-15','2021-11-10'),
           ('2022 bear','2021-11-10','2022-11-21'), ('2022-25 recovery','2022-11-21','2025-10-06'),
           ('2025-26 bear','2025-10-06','2026-06-29')]


def load():
    s = pd.read_csv('t9_signal.csv'); s['date'] = pd.to_datetime(s.date).dt.date
    sig = s.set_index('date')['p']
    px = pd.read_csv('csv_exports_v14/BTCUSDT.csv', usecols=['timestamp','price'], low_memory=False)
    px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
    btc = px.groupby('date')['price'].last()
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date']); tb['date'] = tb.date.dt.date
    cash = tb.set_index('date')['rate'].reindex(btc.index).ffill().fillna(0)/100/365.25
    d = pd.DataFrame({'btc': btc.pct_change(), 'cash': cash, 'px': btc}).join(sig.rename('p'), how='left')
    d['p'] = d['p'].ffill(); d = d.dropna(subset=['btc','p'])
    d['sig'] = d['p'].shift(1); d = d.dropna(subset=['sig'])
    d['w'] = d.sig.map(T9_D)
    d['r9'] = d.w*d.btc + (1-d.w)*d.cash
    return d


def episodes(px, thresh):
    """Peak-to-trough declines >= thresh, non-overlapping."""
    out = []; peak_i = 0
    p = px.values; idx = px.index
    i = 1
    while i < len(p):
        if p[i] > p[peak_i]: peak_i = i
        elif p[i]/p[peak_i]-1 <= -thresh:
            j = i
            while j+1 < len(p) and p[j+1] <= p[j]*1.0001 or (j+1 < len(p) and p[j+1] < p[peak_i]*(1-thresh*0.5)):
                if p[j+1] > p[j] and p[j+1] > p[peak_i]*(1-thresh*0.5): break
                j += 1
                if j+1 >= len(p): break
            tr = peak_i + int(np.argmin(p[peak_i:j+1]))
            out.append((idx[peak_i], idx[tr], p[peak_i], p[tr]))
            peak_i = tr; i = tr
        i += 1
    return out


def mets(r):
    r = r.dropna()
    if len(r) < 5: return {}
    eq = (1+r).cumprod(); yrs = len(r)/365.25; dd = eq/eq.cummax()-1
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    return dict(total=(eq.iloc[-1]-1)*100, cagr=cagr, dd=dd.min()*100,
                calmar=cagr/abs(dd.min()*100) if dd.min() else np.nan)


def main():
    d = load()
    print(f"T11 audit: {len(d):,} days {d.index[0]} -> {d.index[-1]}\n")

    print("="*78); print("TEST 1 — DRAWDOWN PROTECTION, per episode (no aggregation)")
    eps = episodes(d.px, 0.20)
    print(f"  {'peak':<12}{'trough':<12}{'BTC dd':>8}{'expPeak':>9}{'expDecline':>11}{'T9 dd':>8}{'recovPart':>10}")
    ep_rows = []
    for pk, tr, pp, tp in eps:
        m = (pd.Index(d.index) >= pk) & (pd.Index(d.index) <= tr)
        if m.sum() < 5: continue
        t9dd = mets(d.r9[m]).get('dd', np.nan)
        # recovery participation: next 90d after trough
        post = d[(pd.Index(d.index) > tr)].head(90)
        rp = (((1+post.r9).prod()-1)/((1+post.btc).prod()-1)*100) if len(post) and (1+post.btc).prod() > 1 else np.nan
        ep_rows.append((pk, tr, (tp/pp-1)*100, d.w[pd.Index(d.index) == pk].mean()*100, d.w[m].mean()*100, t9dd, rp))
        print(f"  {str(pk):<12}{str(tr):<12}{(tp/pp-1)*100:>7.0f}%{ep_rows[-1][3]:>8.0f}%{ep_rows[-1][4]:>10.0f}%{t9dd:>7.0f}%{rp:>9.0f}%")

    print("\n"+"="*78); print("TEST 2 — EXPOSURE -> SUBSEQUENT OUTCOME (does low exposure precede bad outcomes?)")
    for h in (30, 60, 90):
        d[f'f{h}'] = d.px.shift(-h)/d.px - 1
    d['fdd'] = [(d.px.iloc[i+1:i+91].min()/d.px.iloc[i]-1) if i+91 <= len(d) else np.nan for i in range(len(d))]
    d['bucket'] = pd.cut(d.w, [-.01,.2,.4,.6,.8,1.01], labels=['0-20%','20-40%','40-60%','60-80%','80-100%'])
    g = d.groupby('bucket', observed=True).agg(n=('w','size'), f30=('f30','mean'), f60=('f60','mean'),
                                               f90=('f90','mean'), fdd=('fdd','mean'))
    print(f"  {'exposure':<10}{'n':>7}{'fwd30d':>9}{'fwd60d':>9}{'fwd90d':>9}{'fwd90 maxDD':>13}")
    for b, r in g.iterrows():
        print(f"  {str(b):<10}{int(r.n):>7,}{r.f30*100:>8.1f}%{r.f60*100:>8.1f}%{r.f90*100:>8.1f}%{r.fdd*100:>12.1f}%")
    mono = g.f90.is_monotonic_increasing
    print(f"  -> forward 90d return rises monotonically with exposure: {mono}")

    print("\n"+"="*78); print("TEST 3 & 5 — EVENT STUDY: >=30% drawdowns, did T9 de-risk BEFORE?")
    big = episodes(d.px, 0.30)
    print(f"  {'peak':<12}{'BTC loss':>9}{'expAtPeak':>10}{'minExp':>8}{'daysToMin':>10}{'lossAvoided':>12}{'leadDays':>9}")
    leads = []; avoided = []
    for pk, tr, pp, tp in big:
        m = (pd.Index(d.index) >= pk) & (pd.Index(d.index) <= tr)
        seg = d[m]
        if len(seg) < 5: continue
        mn = seg.w.min(); dmin = int((seg.w.values <= mn+1e-9).argmax())
        loss_b = (tp/pp-1)*100; loss_9 = ((1+seg.r9).prod()-1)*100
        # lead: days BEFORE the peak that exposure was already reduced
        pre = d[(pd.Index(d.index) < pk)].tail(30)
        lead = int((pre.w < 1.0).sum())
        leads.append(lead); avoided.append(loss_9-loss_b)
        print(f"  {str(pk):<12}{loss_b:>8.0f}%{seg.w.iloc[0]*100:>9.0f}%{mn*100:>7.0f}%{dmin:>10}{loss_9-loss_b:>11.0f}pp{lead:>9}")
    # random-timing comparison
    rng = np.random.default_rng(0)
    rand_av = []
    for _ in range(200):
        wr = pd.Series(rng.permutation(d.w.values), index=d.index)
        tot = []
        for pk, tr, pp, tp in big:
            m = (pd.Index(d.index) >= pk) & (pd.Index(d.index) <= tr)
            rr = wr[m]*d.btc[m] + (1-wr[m])*d.cash[m]
            tot.append(((1+rr).prod()-1)*100 - (tp/pp-1)*100)
        rand_av.append(np.mean(tot))
    print(f"  REAL mean loss avoided {np.mean(avoided):+.1f}pp   RANDOM timing {np.mean(rand_av):+.1f}pp "
          f"(p={np.mean([1 if x>=np.mean(avoided) else 0 for x in rand_av]):.3f})")

    print("\n"+"="*78); print("TEST 4 — FALSE-ALARM COST (de-risked, BTC then rose)")
    red = d.w < 1.0
    grp = (red != red.shift()).cumsum()
    fa = []
    for _, seg in d[red].groupby(grp[red]):
        if len(seg) < 3: continue
        fwd = d.px.shift(-30).loc[seg.index[-1]]/d.px.loc[seg.index[-1]] - 1
        if not (fwd == fwd) or fwd <= 0: continue
        cost = ((1+d.btc.loc[seg.index]).prod() - (1+seg.r9).prod())*100
        fa.append((fwd, cost, len(seg)))
    if fa:
        F = pd.DataFrame(fa, columns=['fwd','cost','days'])
        for lo, hi, nm in ((0,.10,'ordinary <10%'), (.10,.30,'strong 10-30%'), (.30,9,'parabolic >30%')):
            s = F[(F.fwd >= lo) & (F.fwd < hi)]
            if len(s): print(f"  {nm:<18}n={len(s):>3}  mean upside sacrificed {s.cost.mean():>5.2f}pp  median episode {s.days.median():.0f}d")
        print(f"  TOTAL false-alarm cost {F.cost.sum():.1f}pp across {len(F)} episodes")

    print("\n"+"="*78); print("TEST 6 — PLACEBO (exposure distribution + turnover preserved, only TIMING changed)")
    real = mets(d.r9)
    for nm, seed_fn in (('A shuffled probs', lambda s: pd.Series(np.random.default_rng(s).permutation(d.sig.values), index=d.index).map(T9_D)),
                        ('B permuted weights', lambda s: pd.Series(np.random.default_rng(s+99).permutation(d.w.values), index=d.index)),
                        ('C block-shuffled (30d)', lambda s: pd.Series(np.concatenate([np.array_split(d.w.values, max(2,len(d)//30))[i] for i in np.random.default_rng(s+7).permutation(max(2,len(d)//30))]), index=d.index))):
        vals = []
        for s in range(20):
            w = seed_fn(s)
            vals.append(mets(w*d.btc + (1-w)*d.cash))
        print(f"  {nm:<24} Calmar {np.mean([v['calmar'] for v in vals]):>5.2f}  maxDD {np.mean([v['dd'] for v in vals]):>6.1f}%  "
              f"CAGR {np.mean([v['cagr'] for v in vals]):>5.1f}%   (real {real['calmar']:.2f} / {real['dd']:.1f}% / {real['cagr']:.1f}%)")

    print("\n"+"="*78); print("TEST 7 — THRESHOLD ROBUSTNESS (no selection, all reported)")
    print(f"  {'rule':<28}{'CAGR':>8}{'maxDD':>9}{'Calmar':>8}")
    for lo in (0.20, 0.25, 0.30, 0.35, 0.40):
        f = lambda p, lo=lo: 1.00 if p < lo else (0.50 if p <= lo+0.20 else 0.00)
        w = d.sig.map(f); m = mets(w*d.btc + (1-w)*d.cash)
        print(f"  p>{lo:.2f} tiered{'  (T9)' if lo==0.30 else '':<12}{m['cagr']:>7.1f}%{m['dd']:>8.1f}%{m['calmar']:>8.2f}")

    print("\n"+"="*78); print("TEST 8 — REGIME-BY-REGIME ACCOUNTING")
    print(f"  {'regime':<20}{'BTC':>8}{'T9':>8}{'BTCdd':>8}{'T9dd':>7}{'avgExp':>8}{'upCap':>7}{'dnCap':>7}{'CAGRcontrib':>12}")
    contribs = []
    for nm, s, e in REGIMES:
        m = (pd.Index(d.index) >= pd.Timestamp(s).date()) & (pd.Index(d.index) <= pd.Timestamp(e).date())
        if m.sum() < 20: continue
        b = ((1+d.btc[m]).prod()-1)*100; t = ((1+d.r9[m]).prod()-1)*100
        up = t/b*100 if b > 0 else np.nan; dn = t/b*100 if b < 0 else np.nan
        contribs.append((nm, np.log1p(t/100)))
        print(f"  {nm:<20}{b:>7.0f}%{t:>7.0f}%{mets(d.btc[m]).get('dd',0):>7.0f}%{mets(d.r9[m]).get('dd',0):>6.0f}%"
              f"{d.w[m].mean()*100:>7.0f}%{(f'{up:.0f}%' if up==up else '-'):>7}{(f'{dn:.0f}%' if dn==dn else '-'):>7}{np.log1p(t/100):>11.2f}")
    tot = sum(c for _, c in contribs)
    print(f"\n  log-return contribution share:")
    for nm, c in sorted(contribs, key=lambda x: -abs(x[1])):
        print(f"    {nm:<20}{c/tot*100:>6.1f}%")
    top = max(abs(c/tot) for _, c in contribs)
    print(f"  -> largest single regime accounts for {top*100:.0f}% of total log return "
          f"({'FAILS' if top > 0.5 else 'passes'} the <50% requirement)")


if __name__ == '__main__':
    main()
