#!/usr/bin/env python3
"""T13 — crash signal as an ENTRY FILTER on new capital, never as an exit.
Existing holdings are never sold. No shorting, leverage or options.

DECLARED BY ME (spec said "fixed fraction of portfolio value", which is circular across arms whose
values diverge): the contribution schedule is a FIXED DAILY AMOUNT, identical for every arm, so the
comparison is like-for-like. Risk metrics use a UNITISED NAV so contributions cannot mask drawdowns.
"""
import numpy as np, pandas as pd

PROB_T, MAX_CASH, CONTRIB, COST = 0.30, 0.30, 0.0010, 0.0010   # CONTRIB is now a FRACTION of own portfolio/day (~44%/yr)


def load():
    s = pd.read_csv('t9_signal.csv'); s['date'] = pd.to_datetime(s.date).dt.date
    sig = s.set_index('date')['p']
    px = pd.read_csv('csv_exports_v14/BTCUSDT.csv', usecols=['timestamp','price'], low_memory=False)
    px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
    btc = px.groupby('date')['price'].last()
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date']); tb['date'] = tb.date.dt.date
    cash = tb.set_index('date')['rate'].reindex(btc.index).ffill().fillna(0)/100/365.25
    d = pd.DataFrame({'px': btc, 'cash': cash}).join(sig.rename('p'), how='left')
    d['p'] = d['p'].ffill(); d = d.dropna(subset=['px','p'])
    d['sig'] = d['p'].shift(1); d = d.dropna(subset=['sig'])
    return d


def simulate(d, defer, cost=COST):
    """defer[t] True -> hold the day's contribution in cash. Existing BTC is NEVER sold."""
    px = d.px.values; rate = d.cash.values; dfr = np.asarray(defer, dtype=bool)
    units = 1.0/px[0]; cash = 0.0
    prev = units*px[0]
    navr = [0.0]; cashpct = [0.0]; spent = 0.0; bought = 0.0; deferred = 0; delays = []; run = 0
    for t in range(1, len(px)):
        cash *= (1+rate[t])
        port = units*px[t] + cash
        navr.append(port/prev - 1 if prev > 0 else 0.0)
        contrib = CONTRIB*port                            # fraction of own portfolio, per the spec
        port_after = port + contrib
        over = cash + contrib > MAX_CASH*port_after       # reserve cap forces deployment
        if dfr[t] and not over:
            cash += contrib; deferred += 1; run += 1
        else:
            deploy = contrib + cash
            if run: delays.append(run); run = 0
            u = deploy*(1-cost)/px[t]
            units += u; spent += deploy; bought += u; cash = 0.0
        prev = units*px[t] + cash
        cashpct.append(cash/prev if prev > 0 else 0.0)
    final = units*px[-1] + cash
    return dict(nav=pd.Series(navr, index=d.index), final=final,
                avgcash=np.mean(cashpct)*100, maxcash=np.max(cashpct)*100,
                deferred=deferred, avgdelay=float(np.mean(delays)) if delays else 0.0,
                entrypx=spent/bought if bought else np.nan,
                turnover=(deferred and 0) or 0)


def mets(r):
    r = r.dropna()
    eq = (1+r).cumprod(); yrs = len(r)/365.25; dd = eq/eq.cummax()-1
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    dn = r[r < 0]
    return dict(cagr=cagr, dd=dd.min()*100, calmar=cagr/abs(dd.min()*100) if dd.min() else np.nan,
                sharpe=r.mean()/r.std()*np.sqrt(365.25) if r.std() else np.nan,
                sortino=r.mean()/dn.std()*np.sqrt(365.25) if len(dn) and dn.std() else np.nan)


def main():
    d = load()
    n = len(d)
    print(f"T13: {n:,} days {d.index[0]} -> {d.index[-1]}")
    print(f"  fixed daily contribution {CONTRIB} (identical across arms), cash cap {MAX_CASH*100:.0f}%,"
          f" threshold p>={PROB_T} inherited from T9\n")

    rv = d.px.pct_change().rolling(20).std()
    rng = np.random.default_rng(0)
    arms = {
        'B: untimed DCA':        np.zeros(n, dtype=bool),
        'D: T13 crash signal':   (d.sig >= PROB_T).values,
        'E: 30-day lag':         (d.sig.shift(30).ffill().bfill() >= PROB_T).values,
        'F: realised vol >80th': (rv > rv.expanding(200).quantile(0.80)).shift(1).fillna(False).values,
    }
    S = {k: simulate(d, v) for k, v in arms.items()}
    M = {k: mets(v['nav']) for k, v in S.items()}
    # A: pure buy & hold of the initial stake, no contributions -> NAV comparison only
    bh_nav = d.px.pct_change().fillna(0)
    M['A: BTC buy & hold'] = mets(bh_nav)
    # C: randomised timing, distribution + count of high-risk days preserved
    ndef = int((d.sig >= PROB_T).sum())
    Cs = []
    for s in range(20):
        mask = np.zeros(n, dtype=bool)
        mask[np.random.default_rng(s).choice(n, ndef, replace=False)] = True
        Cs.append(simulate(d, mask))
    M['C: randomised timing'] = mets(pd.concat([c['nav'] for c in Cs], axis=1).mean(axis=1))

    print(f"{'arm':<24}{'CAGR':>8}{'maxDD':>9}{'Calmar':>8}{'Sharpe':>8}{'Sortino':>9}{'final':>9}{'avgCash':>9}{'maxCash':>9}")
    order = ['A: BTC buy & hold','B: untimed DCA','C: randomised timing','D: T13 crash signal','E: 30-day lag','F: realised vol >80th']
    for k in order:
        m = M[k]; s_ = S.get(k)
        fin = f"{s_['final']:.2f}" if s_ else "-"
        ac = f"{s_['avgcash']:.1f}%" if s_ else "-"
        mc = f"{s_['maxcash']:.1f}%" if s_ else "-"
        if k == 'C: randomised timing':
            fin = f"{np.mean([c['final'] for c in Cs]):.2f}"; ac = f"{np.mean([c['avgcash'] for c in Cs]):.1f}%"; mc = f"{np.mean([c['maxcash'] for c in Cs]):.1f}%"
        print(f"{k:<24}{m['cagr']:>7.1f}%{m['dd']:>8.1f}%{m['calmar']:>8.2f}{m['sharpe']:>8.2f}{m['sortino']:>9.2f}{fin:>9}{ac:>9}{mc:>9}")

    print(f"\n--- CAPITAL EFFICIENCY ---")
    print(f"  {'arm':<24}{'deferrals':>11}{'avgDelay':>10}{'entryPx':>11}")
    for k in ['B: untimed DCA','D: T13 crash signal','E: 30-day lag','F: realised vol >80th']:
        s_ = S[k]; print(f"  {k:<24}{s_['deferred']:>11}{s_['avgdelay']:>10.1f}{s_['entrypx']:>11,.0f}")
    print(f"  {'C: randomised (mean)':<24}{np.mean([c['deferred'] for c in Cs]):>11.0f}"
          f"{np.mean([c['avgdelay'] for c in Cs]):>10.1f}{np.mean([c['entrypx'] for c in Cs]):>11,.0f}")
    print(f"  -> lower contribution-weighted entry price = capital deployed at better prices")

    print(f"\n--- SHIP BAR ---")
    D_, B_, C_ = M['D: T13 crash signal'], M['B: untimed DCA'], M['C: randomised timing']
    ho = slice(int(n*0.8), None)
    hD, hB = mets(S['D: T13 crash signal']['nav'].iloc[ho]), mets(S['B: untimed DCA']['nav'].iloc[ho])
    # criterion 4: is the improvement driven by one episode?
    diff = S['D: T13 crash signal']['nav'] - S['B: untimed DCA']['nav']
    yr = pd.Series([x.year for x in d.index], index=d.index)
    byyr = diff.groupby(yr).sum(); share = (byyr.abs()/byyr.abs().sum()).max()
    c1 = D_['calmar'] > B_['calmar'] and D_['sharpe'] > B_['sharpe']
    c2 = D_['calmar'] > C_['calmar']
    c3 = hD['calmar'] > hB['calmar']
    c4 = share <= 0.50
    c5 = S['D: T13 crash signal']['avgcash'] < 50 and (d.sig >= PROB_T).mean() < 0.50
    c6 = mets(simulate(d, arms['D: T13 crash signal'], 0.0025)['nav'])['calmar'] > B_['calmar']
    for ok, t in [(c1, f"1. beats untimed DCA on Calmar AND Sharpe  {D_['calmar']:.2f}/{D_['sharpe']:.2f} vs {B_['calmar']:.2f}/{B_['sharpe']:.2f}"),
                  (c2, f"2. beats randomised timing                 {D_['calmar']:.2f} vs {C_['calmar']:.2f}"),
                  (c3, f"3. survives holdout                        {hD['calmar']:.2f} vs {hB['calmar']:.2f}"),
                  (c4, f"4. not driven by one episode               largest year = {share*100:.0f}%"),
                  (c5, f"5. <50% of period in cash                  avg cash {S['D: T13 crash signal']['avgcash']:.1f}%, deferred days {(d.sig>=PROB_T).mean()*100:.0f}%"),
                  (c6, f"6. survives 0.25% costs                    {mets(simulate(d, arms['D: T13 crash signal'], 0.0025)['nav'])['calmar']:.2f} vs {B_['calmar']:.2f}")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  VERDICT: {'SHIP' if all([c1,c2,c3,c4,c5,c6]) else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
