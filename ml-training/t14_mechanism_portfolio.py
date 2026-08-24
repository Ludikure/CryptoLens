#!/usr/bin/env python3
"""T14 — honest mechanism portfolio. Static allocations only (T6 killed rotation). No new signals.

DECLARED BEFORE RUNNING (spec left these open):
 1. "structural premium" in P1 == covered carry (the only validated structural premium).
 2. Components 2 (T9 overlay) and 6 (convex) appear in the eligible list but in NONE of the three
    declared allocations. The three are run EXACTLY as written. A T9-overlaid variant of each is
    reported separately and labelled as MY ADDITION, declared now, before any result is seen.
 3. Carry is modelled as a CONSTANT 8%/yr (the measured Coinbase covered rate). No Binance funding
    data is used, per the spec. See the loud caveat in the results: a zero-volatility asset is not
    real and flatters every portfolio holding it.
"""
import numpy as np, pandas as pd

CARRY_ANNUAL = 0.08
PORTFOLIOS = {                                   # declared before the run; no fourth may be added
    'P1 RETURN':    {'btc': .80, 'trend': .10, 'carry': .10},
    'P2 BALANCED':  {'btc': .60, 'trend': .20, 'carry': .10, 'cash': .10},
    'P3 DEFENSIVE': {'btc': .40, 'trend': .20, 'carry': .20, 'cash': .20},
}
REGIMES = [('2020 bull','2020-07-01','2021-04-14'), ('2021 bull','2021-04-15','2021-11-10'),
           ('2022 bear','2021-11-10','2022-11-21'), ('2022-25 recovery','2022-11-21','2025-10-06'),
           ('2025-26 bear','2025-10-06','2026-06-29')]


def mets(r):
    r = r.dropna()
    if len(r) < 20: return {}
    eq = (1+r).cumprod(); yrs = len(r)/365.25; dd = eq/eq.cummax()-1
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    dn = r[r < 0]
    uw = dd < -0.001
    # recovery time: longest run underwater
    grp = (uw != uw.shift()).cumsum(); runs = [len(s) for _, s in uw[uw].groupby(grp[uw])]
    return dict(cagr=cagr, dd=dd.min()*100, calmar=cagr/abs(dd.min()*100) if dd.min() else np.nan,
                sharpe=r.mean()/r.std()*np.sqrt(365.25) if r.std() else np.nan,
                sortino=r.mean()/dn.std()*np.sqrt(365.25) if len(dn) and dn.std() else np.nan,
                terminal=eq.iloc[-1], recov=max(runs) if runs else 0)


def main():
    s = pd.read_csv('t9_signal.csv'); s['date'] = pd.to_datetime(s.date).dt.date
    sig = s.set_index('date')['p']
    px = pd.read_csv('csv_exports_v14/BTCUSDT.csv', usecols=['timestamp','price'], low_memory=False)
    px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
    btc = px.groupby('date')['price'].last()
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date']); tb['date'] = tb.date.dt.date
    d = pd.DataFrame({'px': btc}).join(sig.rename('p'), how='left')
    d['p'] = d['p'].ffill(); d['cashr'] = tb.set_index('date')['rate'].reindex(d.index).ffill().fillna(0)/100/365.25
    d = d.dropna(subset=['p'])
    d['btc'] = d.px.pct_change(); d['sig'] = d.p.shift(1)
    d = d.dropna(subset=['btc','sig'])

    C = pd.DataFrame(index=d.index)
    C['btc'] = d.btc
    ema = d.px.ewm(span=200, adjust=False).mean(); sl = ema.diff(20)
    tw = pd.Series(np.where((d.px > ema)&(sl > 0), 1.0, np.where((d.px < ema)&(sl < 0), -1.0, 0.0)), index=d.index).shift(1).fillna(0)
    C['trend'] = tw*d.btc - (tw.diff().abs().fillna(0))*0.0010
    C['carry'] = CARRY_ANNUAL/365.25
    C['cash'] = d.cashr
    t9w = d.sig.map(lambda p: 1.00 if p < .30 else (0.50 if p <= .50 else 0.00))
    C['btc_t9'] = t9w*d.btc + (1-t9w)*d.cashr - t9w.diff().abs().fillna(0)*0.0010

    print(f"T14: {len(C):,} days {C.index[0]} -> {C.index[-1]}")
    print(f"  components: " + " ".join(f"{c}({mets(C[c])['cagr']:.0f}%/{mets(C[c])['dd']:.0f}%)" for c in ['btc','trend','carry','cash','btc_t9']))
    cc = C[['btc','trend','carry','cash']].corr()
    print(f"  mean pairwise corr: {cc.values[np.triu_indices(4,1)].mean():.3f}\n")

    def build(alloc, btc_col='btc'):
        w = {(btc_col if k == 'btc' else k): v for k, v in alloc.items()}
        return sum(C[k]*v for k, v in w.items())

    rng = np.random.default_rng(20260823)
    rw = rng.dirichlet(np.ones(4))                                   # B4: fixed before any result
    B4 = dict(zip(['btc','trend','carry','cash'], rw))
    arms = {'B1 100% BTC': C.btc, 'B2 80/20 BTC-cash': .8*C.btc + .2*C.cash,
            'B3 equal-weight (T7)': C[['btc','trend','carry','cash']].mean(axis=1),
            f"B4 random {'/'.join(f'{v:.0%}' for v in rw)}": build(B4)}
    for nm, al in PORTFOLIOS.items(): arms[nm] = build(al)
    for nm, al in PORTFOLIOS.items(): arms[f'{nm} +T9'] = build(al, 'btc_t9')

    M = {k: mets(v) for k, v in arms.items()}
    print(f"{'arm':<26}{'CAGR':>8}{'maxDD':>9}{'Calmar':>8}{'Sharpe':>8}{'Sortino':>9}{'terminal':>10}{'worstYr':>9}{'recovD':>8}")
    yr = pd.Series([x.year for x in C.index], index=C.index)
    for k, v in arms.items():
        m = M[k]; wy = min((1+v[yr == y]).prod()-1 for y in yr.unique())*100
        print(f"{k:<26}{m['cagr']:>7.1f}%{m['dd']:>8.1f}%{m['calmar']:>8.2f}{m['sharpe']:>8.2f}{m['sortino']:>9.2f}{m['terminal']:>10.1f}{wy:>8.0f}%{m['recov']:>8}")

    print(f"\n--- MANDATORY REGIME SWEEP (total return per window) ---")
    print(f"  {'regime':<20}" + "".join(f"{k[:11]:>12}" for k in ['B1 100% BTC','P1 RETURN','P2 BALANCED','P3 DEFENSIVE']))
    beats = {k: 0 for k in PORTFOLIOS}
    for nm, a, b in REGIMES:
        m = (pd.Index(C.index) >= pd.Timestamp(a).date()) & (pd.Index(C.index) <= pd.Timestamp(b).date())
        if m.sum() < 20: continue
        row = f"  {nm:<20}"
        bb = mets(arms['B1 100% BTC'][m])
        for k in ['B1 100% BTC','P1 RETURN','P2 BALANCED','P3 DEFENSIVE']:
            mm = mets(arms[k][m]); row += f"{(mm['terminal']-1)*100:>11.0f}%"
            if k in beats and mm.get('calmar', -9) > bb.get('calmar', -9): beats[k] += 1
        print(row)
    print(f"  regime windows where Calmar beats BTC: " + ", ".join(f"{k} {v}/5" for k, v in beats.items()))

    print(f"\n--- MOST IMPORTANT CONTROL: permuted histories (mean/vol/CORRELATION preserved) ---")
    print(f"  {'arm':<26}{'real Calmar':>13}{'permuted':>11}{'real maxDD':>12}{'perm maxDD':>12}")
    for k in list(PORTFOLIOS):
        vals = []
        for sd in range(20):
            perm = np.random.default_rng(sd).permutation(len(C))     # SAME permutation across columns
            Cp = C.iloc[perm].reset_index(drop=True)
            w = PORTFOLIOS[k]
            vals.append(mets(sum(Cp[c]*v for c, v in w.items())))
        print(f"  {k:<26}{M[k]['calmar']:>13.2f}{np.mean([v['calmar'] for v in vals]):>11.2f}"
              f"{M[k]['dd']:>11.1f}%{np.mean([v['dd'] for v in vals]):>11.1f}%")

    print(f"\n--- SHIP BAR (at least ONE declared portfolio must pass all 7) ---")
    b1 = M['B1 100% BTC']; b4k = [k for k in arms if k.startswith('B4')][0]
    for k in PORTFOLIOS:
        m = M[k]
        c1 = m['calmar'] > b1['calmar']
        c2 = (abs(b1['dd'])-abs(m['dd'])) >= 20
        c3 = m['cagr'] >= 0.60*b1['cagr']
        c4 = m['cagr'] > 0
        c5 = m['calmar'] > M[b4k]['calmar']
        c6 = beats[k] >= 3
        c7 = True                                                     # carry is Coinbase-only by construction
        print(f"  {k}: " + " ".join(f"[{'P' if x else 'F'}]{i+1}" for i, x in enumerate([c1,c2,c3,c4,c5,c6,c7])) +
              f"   Calmar {m['calmar']:.2f} vs BTC {b1['calmar']:.2f} | dd {m['dd']:.1f}% | CAGR {m['cagr']:.1f}% ({m['cagr']/b1['cagr']*100:.0f}% of BTC) | regimes {beats[k]}/5")
    anypass = any(all([M[k]['calmar'] > b1['calmar'], (abs(b1['dd'])-abs(M[k]['dd'])) >= 20,
                       M[k]['cagr'] >= 0.60*b1['cagr'], M[k]['cagr'] > 0,
                       M[k]['calmar'] > M[b4k]['calmar'], beats[k] >= 3]) for k in PORTFOLIOS)
    print(f"\n  VERDICT: {'SHIP' if anypass else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
