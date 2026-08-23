#!/usr/bin/env python3
"""T6 — risk-premium regime rotation. Design frozen in docs/research/regime-rotation.md.

Builds daily return series for six ALREADY-MEASURED exposures, then allocates monthly to whichever
had the best trailing risk-adjusted performance. Every component keeps the parameterisation it was
measured with; nothing is re-tuned here.
"""
import numpy as np, pandas as pd, lightgbm as lgb
from pathlib import Path
import importlib.util

CRYPTO = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','BNBUSDT','DOTUSDT',
          'AVAXUSDT','LINKUSDT','LTCUSDT','UNIUSDT']
RISK_PER_TRADE = 0.01           # declared: 1R = 1% of capital
LOOKBACK, FEE = 90, 0.0010


def daily_px(sym, folder='csv_exports_v14'):
    f = Path(folder)/f'{sym}.csv'
    if not f.exists(): return None
    d = pd.read_csv(f, usecols=['timestamp','price','fundingRateRaw'], low_memory=False)
    d['date'] = pd.to_datetime(d['timestamp'], unit='s', utc=True).dt.date
    return d.groupby('date').agg(px=('price','last'), fr=('fundingRateRaw','mean'))


def build_exposures():
    """Six daily return series, each from its already-measured definition."""
    S = {s: daily_px(s) for s in CRYPTO}
    S = {k: v for k, v in S.items() if v is not None}
    px = pd.DataFrame({k: v.px for k, v in S.items()}).sort_index()
    fr = pd.DataFrame({k: v.fr for k, v in S.items()}).sort_index()
    ret = px.pct_change()
    out = {}

    # 6 — spot buy & hold, equal weight
    out['hold'] = ret.mean(axis=1)

    # 2 — cash-and-carry: funding received, delta-neutral (percent per 8h -> daily fraction)
    out['carry'] = (fr/100*3).mean(axis=1)

    # 3 — trend: 200D EMA + 20d slope, act on prior close, funding-aware
    tp = []
    for s in px.columns:
        p = px[s].dropna()
        if len(p) < 260: continue
        ema = p.ewm(span=200, adjust=False).mean(); slope = ema.diff(20)
        pos = pd.Series(np.where((p > ema) & (slope > 0), 1.0,
                        np.where((p < ema) & (slope < 0), -1.0, 0.0)), index=p.index).shift(1).fillna(0)
        chg = (pos.diff().fillna(0) != 0).astype(int)
        f = (fr[s].reindex(p.index).fillna(0)/100*3)
        tp.append(pos*p.pct_change().fillna(0) - pos*f - chg*FEE)
    out['trend'] = pd.DataFrame(tp).T.mean(axis=1) if tp else pd.Series(dtype=float)

    # 4 — defensive cash (no T-bill yield credited; conservative)
    out['cash'] = pd.Series(0.0, index=px.index)

    # 1 — convex tail: reuse T5's OHLC simulator and tail gate, unchanged
    spec = importlib.util.spec_from_file_location('t5','t5_vol_conditioned_tail.py')
    t5 = importlib.util.module_from_spec(spec); spec.loader.exec_module(t5)
    a, feats = t5.build()
    n = len(a); rows = []
    for i in range(4):                              # rolling refit, trailing data only
        tr_end = int(n*(0.2+0.2*i)); te_end = int(n*(0.4+0.2*i))
        tr, te = a.iloc[:max(0,tr_end-48)], a.iloc[tr_end:te_end]
        if len(tr) < 5000 or len(te) < 500: continue
        tailP, tailP_tr = t5.fit(tr, te, feats, 'bigTail')
        g = te[tailP >= np.quantile(tailP_tr, 0.90)].copy()
        g['date'] = pd.to_datetime(g['timestamp'], unit='s', utc=True).dt.date
        rows.append(g[['date','R','cost']])
    cx = pd.concat(rows)
    out['convex'] = cx.groupby('date').apply(lambda d: (d.R-d.cost).mean()*RISK_PER_TRADE,
                                             include_groups=False)

    # 5 — volatility selling: BTC/ETH 30d straddle sold, loss capped at 3x premium
    vs = []
    for dv, sym in (('BTC','BTCUSDT'), ('ETH','ETHUSDT')):
        try:
            d = pd.read_csv(f'dvol_{dv}.csv', parse_dates=['date'])
        except Exception:
            continue
        p = px[sym].reset_index(); p['date'] = pd.to_datetime(p['date'])
        mm = d.merge(p, on='date').sort_values('date').reset_index(drop=True)
        fwd = mm[sym].shift(-30)/mm[sym]-1
        prem = 0.7979*mm.dvol*np.sqrt(30/365)
        net = np.maximum(np.minimum(prem-fwd.abs()*100, prem)-prem*0.01, -3*prem)/100
        vs.append(pd.Series((net/30).values, index=mm.date.dt.date))   # spread over the 30d hold
    out['volsell'] = pd.DataFrame(vs).T.mean(axis=1) if vs else pd.Series(dtype=float)

    df = pd.DataFrame(out).sort_index()
    return df


def stats(p):
    p = p.dropna()
    if len(p) < 30: return dict(total=np.nan, cagr=np.nan, dd=np.nan, sharpe=np.nan, calmar=np.nan)
    eq = (1+p).cumprod(); yrs = len(p)/365.25
    dd = (eq/eq.cummax()-1).min()*100
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    return dict(total=(eq.iloc[-1]-1)*100, cagr=cagr, dd=dd,
                sharpe=p.mean()/p.std()*np.sqrt(365.25) if p.std() else np.nan,
                calmar=cagr/abs(dd) if dd else np.nan)


def rotate(R, pick='best', seed=0):
    """Monthly rebalance onto the exposure with the best trailing 90d Sharpe. Trailing data only."""
    rng = np.random.default_rng(seed)
    idx = R.index; sel = pd.Series(index=idx, dtype=object)
    cur = 'cash'
    months = pd.Series([(d.year, d.month) for d in idx], index=idx)
    for i, d in enumerate(idx):
        if i > 0 and months.iloc[i] != months.iloc[i-1]:
            hist = R.iloc[max(0, i-LOOKBACK):i]
            if len(hist) >= 30:
                sh = hist.mean()/hist.std().replace(0, np.nan)*np.sqrt(365.25)
                sh = sh.dropna()
                if len(sh):
                    cur = rng.choice(list(R.columns)) if pick == 'random' else sh.idxmax()
        sel.iloc[i] = cur
    return pd.Series([R[sel.iloc[i]].iloc[i] for i in range(len(idx))], index=idx), sel


def main():
    R = build_exposures()
    R = R.dropna(how='all')
    R = R[R.index >= pd.Timestamp('2021-04-01').date()]     # first date all six exist
    R = R.fillna(0.0)
    print(f'exposures {list(R.columns)}')
    print(f'{len(R):,} days  {R.index[0]} -> {R.index[-1]}\n')
    print(f"{'exposure':<12}{'total':>10}{'CAGR':>9}{'maxDD':>9}{'Sharpe':>8}{'Calmar':>8}")
    for c in R.columns:
        s = stats(R[c]); print(f"{c:<12}{s['total']:>9,.1f}%{s['cagr']:>8.1f}%{s['dd']:>8.1f}%{s['sharpe']:>8.2f}{s['calmar']:>8.2f}")
    print(f"\nmean pairwise correlation of exposures: {R.corr().values[np.triu_indices(len(R.columns),1)].mean():.3f}")

    rot, sel = rotate(R, 'best')
    eq = R.mean(axis=1)
    rnd = pd.concat([rotate(R, 'random', s)[0] for s in range(5)], axis=1).mean(axis=1)
    arms = {'T6 ROTATION': rot, 'ctrl1: EQUAL-WEIGHT': eq, 'ctrl2: random rotation': rnd,
            'ctrl4: buy & hold': R['hold']}
    print(f"\n{'arm':<26}{'total':>10}{'CAGR':>9}{'maxDD':>9}{'Sharpe':>8}{'Calmar':>8}")
    S = {k: stats(v) for k, v in arms.items()}
    for k, s in S.items():
        print(f"{k:<26}{s['total']:>9,.1f}%{s['cagr']:>8.1f}%{s['dd']:>8.1f}%{s['sharpe']:>8.2f}{s['calmar']:>8.2f}")
    print(f"\nctrl3 best single ex-post: {max(R.columns, key=lambda c: stats(R[c])['sharpe'] if stats(R[c])['sharpe']==stats(R[c])['sharpe'] else -9)}")
    print(f"rotation picked: {dict(sel.value_counts())}")

    cuts = np.array_split(np.arange(len(R)), 3)
    print(f"\n{'':<26}{'fold Sharpes':>34}")
    fs = {}
    for k, v in arms.items():
        fs[k] = [stats(v.iloc[c])['sharpe'] for c in cuts]
        print(f"{k:<26}{'  '.join(f'{x:+.2f}' for x in fs[k]):>34}")

    ho = slice(int(len(R)*0.8), None)
    hr, he = stats(rot.iloc[ho]), stats(eq.iloc[ho])
    beat = sum(1 for a, b in zip(fs['T6 ROTATION'], fs['ctrl1: EQUAL-WEIGHT']) if a > b)
    c1 = beat >= 2
    c2 = S['T6 ROTATION']['calmar'] > S['ctrl1: EQUAL-WEIGHT']['calmar']
    c3 = S['T6 ROTATION']['sharpe'] > S['ctrl2: random rotation']['sharpe']
    c4 = sum(1 for c in cuts if (1+rot.iloc[c]).prod() > 1) >= 2
    c5 = hr['sharpe'] > he['sharpe']
    print('\n--- SHIP BAR ---')
    for ok, t in [(c1, f"1. beats equal-weight Sharpe >=2/3 folds   {beat}/3"),
                  (c2, f"2. beats equal-weight on Calmar            {S['T6 ROTATION']['calmar']:.2f} vs {S['ctrl1: EQUAL-WEIGHT']['calmar']:.2f}"),
                  (c3, f"3. beats random rotation on Sharpe         {S['T6 ROTATION']['sharpe']:.2f} vs {S['ctrl2: random rotation']['sharpe']:.2f}"),
                  (c4, f"4. positive return in >=2/3 folds          {sum(1 for c in cuts if (1+rot.iloc[c]).prod()>1)}/3"),
                  (c5, f"5. persists on holdout                     {hr['sharpe']:.2f} vs {he['sharpe']:.2f}")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  VERDICT: {'SHIP' if all([c1,c2,c3,c4,c5]) else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
