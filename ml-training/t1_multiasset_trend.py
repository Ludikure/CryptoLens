#!/usr/bin/env python3
"""T1 — multi-asset trend portfolio with volatility targeting.
Design frozen in docs/research/untested-four.md. Controls are mandatory: crypto-only isolates
diversification, no-vol-target isolates the sizing rule.
"""
import numpy as np, pandas as pd
from pathlib import Path

CRYPTO = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT',
          'BNBUSDT','DOTUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','UNIUSDT']
ETFS = ['SPY','QQQ','IWM','DIA','TLT','HYG','GLD','XLE','XLF','XLK','XLV','XLY','XLP','XLI','XLU','XLC','VXX']
CLASS = {**{s:'crypto' for s in CRYPTO},
         **{s:'equity' for s in ['SPY','QQQ','IWM','DIA']},
         **{s:'sector' for s in ['XLE','XLF','XLK','XLV','XLY','XLP','XLI','XLU','XLC']},
         **{s:'bond' for s in ['TLT','HYG']}, 'GLD':'commodity', 'VXX':'vol'}
FEE, CAP, EMAS = 0.0010, 0.15, (20, 50, 100, 200)


def daily(sym, folder):
    f = Path(folder)/f'{sym}.csv'
    if not f.exists(): return None
    d = pd.read_csv(f, usecols=['timestamp','price'], low_memory=False)
    d['date'] = pd.to_datetime(d['timestamp'], unit='s', utc=True).dt.date
    g = d.groupby('date')['price'].last()
    return g[g > 0]


def panel():
    s = {}
    for c in CRYPTO:
        v = daily(c, 'csv_exports_v14');       s[c] = v if v is not None else None
    for e in ETFS:
        v = daily(e, 'csv_exports_v14_stocks'); s[e] = v if v is not None else None
    return pd.DataFrame({k: v for k, v in s.items() if v is not None}).sort_index()


def trend_score(px):
    """Continuous: mean sign of price vs each EMA. +1 fully aligned up, -1 fully aligned down."""
    sc = sum(np.sign(px - px.ewm(span=n, adjust=False).mean()) for n in EMAS) / len(EMAS)
    return sc


def prep(px):
    """Align a mixed 24/7 + market-hours universe onto one calendar, honestly.

    ETFs do not trade weekends, so on a crypto-union index their rows are NaN. Two consequences had
    to be handled explicitly, and getting either wrong silently deletes the ETFs from the portfolio:
      - VOLATILITY is computed on each asset's OWN observation calendar, then carried forward. A
        rolling window over the union index never sees 20 consecutive observations for an ETF.
      - RETURNS are zero on days an asset does not trade (position held, no P&L), not NaN — but only
        AFTER its first real observation, so nothing is fabricated before listing.
    """
    px = px.copy()
    first = {c: px[c].first_valid_index() for c in px.columns}
    pxf = px.ffill()
    ret = pxf.pct_change()
    rv = pd.DataFrame(index=px.index, columns=px.columns, dtype=float)
    for c in px.columns:
        own = px[c].dropna().pct_change()                    # asset's own trading calendar
        rv[c] = own.rolling(20, min_periods=10).std().reindex(px.index).ffill()
    for c in px.columns:
        if first[c] is not None:
            ret.loc[ret.index < first[c], c] = np.nan        # never trade before listing
            ret.loc[ret.index >= first[c], c] = ret.loc[ret.index >= first[c], c].fillna(0.0)
    return pxf, ret, rv


def run(px, vol_target=True, label=''):
    pxf, ret, rv = prep(px)
    sc = pd.DataFrame({c: trend_score(pxf[c].dropna()) for c in pxf.columns}).reindex(px.index)
    sc = sc.where(px.ffill().notna())
    raw = (sc / rv) if vol_target else sc
    raw = raw.replace([np.inf, -np.inf], np.nan)
    gross = raw.abs().sum(axis=1).replace(0, np.nan)
    w = raw.div(gross, axis=0).clip(-CAP, CAP)
    mon = pd.Series(w.index, index=w.index).apply(lambda d: d.weekday() == 0)
    wk = w.where(mon).ffill()                                 # weekly rebalance, held between
    wl = wk.shift(1)                                          # act on the prior close
    pnl = (wl * ret).sum(axis=1) - wk.diff().abs().sum(axis=1).fillna(0) * FEE
    return pnl.dropna()


def stats(p, label):
    eq = (1+p).cumprod(); yrs = len(p)/365.25
    return dict(label=label, total=(eq.iloc[-1]-1)*100,
                cagr=(eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan,
                dd=(eq/eq.cummax()-1).min()*100,
                sharpe=p.mean()/p.std()*np.sqrt(365.25) if p.std() else np.nan,
                calmar=((eq.iloc[-1]**(1/yrs)-1)*100)/abs((eq/eq.cummax()-1).min()*100)
                       if eq.iloc[-1] > 0 and (eq/eq.cummax()-1).min() else np.nan)


def folds(p, k=3):
    return [((1+p.iloc[c]).prod()-1)*100 for c in np.array_split(np.arange(len(p)), k)]


def main():
    px = panel()
    px = px[px.index >= pd.Timestamp('2020-07-13').date()]
    print(f'universe {px.shape[1]} instruments, {len(px):,} days ({px.index[0]} -> {px.index[-1]})')
    byc = pd.Series({c: CLASS.get(c,'?') for c in px.columns}).value_counts()
    print('by class:', dict(byc), '\n')

    # Does the universe actually diversify? This is the premise being tested.
    ret = px.pct_change()
    cr = ret.corr()
    cc = [cr.loc[a,b] for a in CRYPTO if a in cr for b in CRYPTO if b in cr and a < b]
    allp = [cr.loc[a,b] for i,a in enumerate(cr.columns) for b in cr.columns[i+1:]]
    print(f'mean pairwise corr — crypto-only {np.mean(cc):.3f} | full universe {np.mean(allp):.3f}\n')

    arms = {
        'T1 multi-asset + volTarget': run(px, True),
        'ctrl: multi-asset, no volTarget': run(px, False),
        'ctrl: crypto-only + volTarget': run(px[[c for c in CRYPTO if c in px]], True),
    }
    _, retb, _ = prep(px)
    bh = retb.mean(axis=1).dropna()
    arms['bench: equal-weight buy&hold'] = bh

    print(f"{'':<34}{'total':>10}{'CAGR':>8}{'maxDD':>9}{'Sharpe':>8}{'Calmar':>8}")
    S = {}
    for k, v in arms.items():
        idx = v.index.intersection(bh.index)
        S[k] = stats(v.reindex(idx).fillna(0), k)
        s = S[k]
        print(f"{k:<34}{s['total']:>9,.0f}%{s['cagr']:>7.1f}%{s['dd']:>8.1f}%{s['sharpe']:>8.2f}{s['calmar']:>8.2f}")

    t1 = arms['T1 multi-asset + volTarget']
    f = folds(t1)
    print(f"\nT1 folds: {'  '.join(f'{x:+.1f}%' for x in f)}")
    for name, a, b in [('2022 bear','2021-11-10','2022-11-21'), ('2025-26 bear','2025-10-06','2026-06-25')]:
        m = (t1.index >= pd.Timestamp(a).date()) & (t1.index <= pd.Timestamp(b).date())
        if m.sum() > 30:
            print(f"  {name:<14}T1 {((1+t1[m]).prod()-1)*100:>+7.1f}%   B&H {((1+bh[bh.index.isin(t1[m].index)]).prod()-1)*100:>+7.1f}%")

    s = S['T1 multi-asset + volTarget']
    c1, c2, c3 = s['sharpe'] > 0.8, s['dd'] > -40, sum(x > 0 for x in f) >= 2
    print('\n--- SHIP BAR ---')
    for ok, t in [(c1, f"Sharpe > 0.8        {s['sharpe']:.2f}"),
                  (c2, f"maxDD better -40%   {s['dd']:.1f}%"),
                  (c3, f">=2/3 folds positive {sum(x>0 for x in f)}/3")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  VERDICT: {'SHIP' if all([c1,c2,c3]) else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
