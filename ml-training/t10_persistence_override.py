#!/usr/bin/env python3
"""T10 — bull-persistence override on the T9 crash overlay.
Not a direction predictor: the T9 crash probability remains primary. This tests whether PERSISTENT
observed market behaviour should override a STALE risk estimate.

DECLARED BY ME (spec fixed N and X, not Y):
  Y = 10% max drawdown from episode high — matched to the crash model's own 10% target.
  Episode trigger = crash prob > 0.30, i.e. the threshold at which T9 begins reducing exposure.
Both frozen before running. All three rules reported; none selected.
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util
from pathlib import Path

T9_D = lambda p: 1.00 if p < .30 else (0.50 if p <= .50 else 0.00)
RULES = {'P1: 7d +5%': (7, 0.05), 'P2: 14d +10%': (14, 0.10), 'P3: 30d +15%': (30, 0.15)}
Y_DD = 0.10
EPISODE_TRIGGER = 0.30
BULLS = [('2020 H2 bull','2020-07-01','2021-04-14'), ('2021 leg2 bull','2021-07-20','2021-11-10'),
         ('2022-25 recovery','2022-11-21','2025-10-06')]
BEARS = [('2022 bear','2021-11-10','2022-11-21'), ('2025-26 bear','2025-10-06','2026-06-29')]


def mets(r):
    r = r.dropna()
    if len(r) < 20: return {}
    eq = (1+r).cumprod(); yrs = len(r)/365.25; dd = eq/eq.cummax()-1
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    return dict(total=(eq.iloc[-1]-1)*100, cagr=cagr, dd=dd.min()*100,
                calmar=cagr/abs(dd.min()*100) if dd.min() else np.nan)


def get_signal():
    cache = Path('t9_signal.csv')
    if cache.exists():
        s = pd.read_csv(cache); s['date'] = pd.to_datetime(s.date).dt.date
        return s.set_index('date')['p']
    spec = importlib.util.spec_from_file_location('t2','t2_t3_test.py')
    t2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(t2)
    a, feats = t2.build(); a = a.dropna(subset=['y_crash']).reset_index(drop=True)
    a['dt'] = pd.to_datetime(a.timestamp, unit='s', utc=True)
    starts = pd.date_range(a.dt.min()+pd.DateOffset(months=6), a.dt.max(), freq='MS', tz='UTC')
    preds = []
    for i, s in enumerate(starts):
        e = starts[i+1] if i+1 < len(starts) else a.dt.max()+pd.Timedelta(days=1)
        tr = a[a.dt < s - pd.Timedelta(hours=4*72)]
        te = a[(a.dt >= s) & (a.dt < e) & (a.sym == 'BTCUSDT')]
        if len(tr) < 3000 or len(te) == 0: continue
        m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.05,
                               num_leaves=15, verbose=-1, n_jobs=-1)
        m.fit(tr[feats], tr['y_crash'])
        t = te.copy(); t['p'] = m.predict_proba(t[feats])[:, 1]; preds.append(t[['timestamp','p']])
    P = pd.concat(preds).sort_values('timestamp')
    P['date'] = pd.to_datetime(P.timestamp, unit='s', utc=True).dt.date
    sig = P.groupby('date')['p'].last()
    sig.reset_index().to_csv(cache, index=False)
    return sig


def persistence_mask(px, sig, N, X):
    """True where a stale-risk episode has become a persistent advance."""
    out = np.zeros(len(px), dtype=bool)
    start = None
    p = px.values; s = sig.values
    for i in range(len(p)):
        if s[i] > EPISODE_TRIGGER:
            if start is None: start = i
            run = i - start + 1
            if run >= N:
                seg = p[start:i+1]
                cum = p[i]/p[start] - 1
                ddown = p[i]/seg.max() - 1
                if p[i] > p[start] and cum > X and ddown > -Y_DD:
                    out[i] = True
        else:
            start = None
    return pd.Series(out, index=px.index)


def main():
    sig = get_signal()
    px = pd.read_csv('csv_exports_v14/BTCUSDT.csv', usecols=['timestamp','price'], low_memory=False)
    px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
    btc = px.groupby('date')['price'].last()
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date']); tb['date'] = tb.date.dt.date
    cash = tb.set_index('date')['rate'].reindex(btc.index).ffill().fillna(0)/100/365.25
    d = pd.DataFrame({'btc': btc.pct_change(), 'cash': cash, 'px': btc}).join(sig.rename('p'), how='left')
    d['p'] = d['p'].ffill(); d = d.dropna(subset=['btc','p'])
    d['sig'] = d['p'].shift(1); d = d.dropna(subset=['sig'])
    print(f"T10: {len(d):,} days  {d.index[0]} -> {d.index[-1]}")
    print(f"  declared: Y={Y_DD*100:.0f}% dd from episode high, episode trigger p>{EPISODE_TRIGGER}\n")

    base_w = d.sig.map(T9_D)
    def ret(w, cost=0.0):
        return w*d.btc + (1-w)*d.cash - w.diff().abs().fillna(0)*cost

    arms = {'T9 baseline (D)': base_w}
    for nm, (N, X) in RULES.items():
        # LOOKAHEAD FIX: the mask is built from prices/signals up to and including day i, so it
        # must be SHIFTED before it sets exposure — otherwise today's close decides today's position.
        pm = persistence_mask(d.px, d.sig, N, X).shift(1).fillna(False).astype(bool)
        arms[f'T10 {nm}'] = base_w.where(~pm, np.maximum(base_w, 0.75))
        print(f"  {nm:<14} override active on {pm.sum():>4} days ({pm.mean()*100:.1f}%)")

    R = {k: ret(v) for k, v in arms.items()}
    M = {k: mets(v) for k, v in R.items()}
    bh = mets(d.btc)
    print(f"\n{'arm':<20}{'total':>10}{'CAGR':>8}{'maxDD':>9}{'Calmar':>8}{'avgExp':>8}")
    print(f"{'BTC B&H':<20}{bh['total']:>9,.0f}%{bh['cagr']:>7.1f}%{bh['dd']:>8.1f}%{bh['calmar']:>8.2f}{100:>7.0f}%")
    for k in arms:
        print(f"{k:<20}{M[k]['total']:>9,.0f}%{M[k]['cagr']:>7.1f}%{M[k]['dd']:>8.1f}%{M[k]['calmar']:>8.2f}{arms[k].mean()*100:>7.0f}%")

    print(f"\n--- BULL CAPTURE (% of BTC return) ---")
    print(f"  {'period':<20}" + "".join(f"{k.replace('T10 ','').split(':')[0]:>12}" for k in arms))
    cap = {k: {} for k in arms}
    for nm, s, e in BULLS:
        m = (pd.Index(d.index) >= pd.Timestamp(s).date()) & (pd.Index(d.index) <= pd.Timestamp(e).date())
        if m.sum() < 30: continue
        b = (1+d.btc[m]).prod()-1
        row = f"  {nm:<20}"
        for k in arms:
            c = ((1+R[k][m]).prod()-1)/b*100 if b > 0 else np.nan
            cap[k][nm] = c; row += f"{c:>11.0f}%"
        print(row + f"   (BTC {b*100:+.0f}%)")

    print(f"\n--- BEAR PROTECTION (return, and maxDD) ---")
    for nm, s, e in BEARS:
        m = (pd.Index(d.index) >= pd.Timestamp(s).date()) & (pd.Index(d.index) <= pd.Timestamp(e).date())
        if m.sum() < 30: continue
        row = f"  {nm:<20}BTC {((1+d.btc[m]).prod()-1)*100:>+6.0f}%  "
        for k in arms: row += f"{k.replace('T10 ','').split(':')[0]} {((1+R[k][m]).prod()-1)*100:>+5.0f}%  "
        print(row)

    print(f"\n--- CONTROLS (Calmar) ---")
    shuf = np.mean([mets(ret(pd.Series(np.random.default_rng(s).permutation(d.sig.values), index=d.index).map(T9_D)))['calmar'] for s in range(5)])
    lag = mets(ret(d.sig.shift(30).ffill().bfill().map(T9_D)))['calmar']
    ema = d.px.ewm(span=200, adjust=False).mean(); sl = ema.diff(20)
    e200 = mets(ret(((d.px > ema) & (sl > 0)).astype(float).shift(1).fillna(0)))['calmar']
    print(f"  shuffled {shuf:.2f} | 30d lag {lag:.2f} | 200D {e200:.2f} | T9 no-override {M['T9 baseline (D)']['calmar']:.2f}")
    for k in list(arms)[1:]:
        print(f"    {k:<20} {M[k]['calmar']:.2f}  -> {'improves real T9' if M[k]['calmar'] > M['T9 baseline (D)']['calmar'] else 'does NOT improve real T9'}")

    print(f"\n--- SHIP BAR (per rule) ---")
    t9 = M['T9 baseline (D)']; t9cap = cap['T9 baseline (D)']
    for k in list(arms)[1:]:
        m = M[k]; c = cap[k]
        c1 = c.get('2021 leg2 bull', 0) > t9cap.get('2021 leg2 bull', 0) + 10
        c2 = c.get('2021 leg2 bull', 0) >= 80
        c3 = (abs(bh['dd'])-abs(m['dd'])) >= 0.80*(abs(bh['dd'])-abs(t9['dd']))
        c4 = m['calmar'] >= t9['calmar']*0.90
        c5 = m['calmar'] > bh['calmar']
        c6 = mets(ret(arms[k], 0.0025))['calmar'] > mets(d.btc)['calmar']
        others = [n for n in BULLS if n[0] != '2021 leg2 bull']
        c7 = any(c.get(n[0], 0) > t9cap.get(n[0], 0)+0.5 for n in others)
        print(f"  {k}")
        for ok, t in [(c1,f"1. materially improves 2021   {t9cap.get('2021 leg2 bull',0):.0f}% -> {c.get('2021 leg2 bull',0):.0f}%"),
                      (c2,f"2. >=80% of 2021 advance      {c.get('2021 leg2 bull',0):.0f}%"),
                      (c3,f"3. keeps >=80% of dd cut      {abs(bh['dd'])-abs(m['dd']):.1f}pp of {abs(bh['dd'])-abs(t9['dd']):.1f}pp"),
                      (c4,f"4. Calmar >= T9 x0.90         {m['calmar']:.2f} vs {t9['calmar']*0.90:.2f}"),
                      (c5,f"5. beats B&H Calmar           {m['calmar']:.2f} vs {bh['calmar']:.2f}"),
                      (c6,f"6. survives 0.25% costs       {mets(ret(arms[k],0.0025))['calmar']:.2f}"),
                      (c7,f"7. helps >=1 other bull       {c7}")]:
            print(f"    [{'P' if ok else 'F'}] {t}")
        print(f"    VERDICT: {'PASS' if all([c1,c2,c3,c4,c5,c6,c7]) else 'FAIL'}")


if __name__ == '__main__':
    main()
