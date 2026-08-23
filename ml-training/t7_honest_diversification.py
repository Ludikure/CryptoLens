#!/usr/bin/env python3
"""T7 — does mechanism diversification survive HONEST inputs?
Design frozen in docs/research/mechanism-diversification.md. Sensitivity analysis, not a
reconciliation: shape and variance preserved, disputed RETURN removed.
"""
import numpy as np, pandas as pd, importlib.util

TRUSTWORTHY_CONVEX_R = -0.008     # strategy-breakeven.md, net at 0.25% round trip
RISK_PER_TRADE = 0.01             # same convention T6 used: 1R = 1% of capital
COINBASE_COVERED_ANNUAL = 0.08    # funding-carry.md, covered basis on TOTAL capital


def stats(p):
    p = p.dropna()
    if len(p) < 30: return dict(total=np.nan, cagr=np.nan, dd=np.nan, sharpe=np.nan, calmar=np.nan)
    eq = (1+p).cumprod(); yrs = len(p)/365.25
    dd = (eq/eq.cummax()-1).min()*100
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    return dict(total=(eq.iloc[-1]-1)*100, cagr=cagr, dd=dd,
                sharpe=p.mean()/p.std()*np.sqrt(365.25) if p.std() else np.nan,
                calmar=cagr/abs(dd) if dd else np.nan)


def main():
    spec = importlib.util.spec_from_file_location('t6','t6_regime_rotation.py')
    t6 = importlib.util.module_from_spec(spec); spec.loader.exec_module(t6)
    R = t6.build_exposures().dropna(how='all')
    R = R[R.index >= pd.Timestamp('2021-04-01').date()].fillna(0.0)
    print(f'{len(R):,} days  {R.index[0]} -> {R.index[-1]}\n')

    C = R.copy()
    # convex: shift location so mean net R == the trustworthy figure; keep shape and variance
    conv_days = C['convex'] != 0
    cur_mean_R = C.loc[conv_days,'convex'].mean()/RISK_PER_TRADE
    shift = (TRUSTWORTHY_CONVEX_R - cur_mean_R)*RISK_PER_TRADE
    C.loc[conv_days,'convex'] = C.loc[conv_days,'convex'] + shift
    # carry: scale to the Coinbase COVERED annual rate
    cur_ann = C['carry'].mean()*365.25
    C['carry'] = C['carry'] * (COINBASE_COVERED_ANNUAL/cur_ann if cur_ann else 0)

    print('CORRECTIONS APPLIED (shape/variance preserved, location shifted):')
    print(f"  convex mean net R  {cur_mean_R:+.4f}  ->  {C.loc[conv_days,'convex'].mean()/RISK_PER_TRADE:+.4f}")
    print(f"  carry annualised   {cur_ann*100:>6.1f}%  ->  {C['carry'].mean()*365.25*100:>5.1f}%\n")

    H = C.copy(); H['volsell'] = 0.0        # HARSH: retail cannot reach defined-risk straddles

    arms = {
        'EW optimistic (T6, contaminated)': R.mean(axis=1),
        'EW CONSERVATIVE (honest inputs)':  C.mean(axis=1),
        'EW harsh (+ volsell removed)':     H.mean(axis=1),
        'buy & hold':                       R['hold'],
    }
    print(f"{'arm':<36}{'total':>10}{'CAGR':>9}{'maxDD':>9}{'Sharpe':>8}{'Calmar':>8}")
    S = {k: stats(v) for k, v in arms.items()}
    for k, s in S.items():
        print(f"{k:<36}{s['total']:>9,.1f}%{s['cagr']:>8.1f}%{s['dd']:>8.1f}%{s['sharpe']:>8.2f}{s['calmar']:>8.2f}")

    print(f"\nCONSERVATIVE exposures individually:")
    print(f"  {'exposure':<12}{'total':>10}{'maxDD':>9}{'Sharpe':>8}")
    for c in C.columns:
        s = stats(C[c]); print(f"  {c:<12}{s['total']:>9,.1f}%{s['dd']:>8.1f}%{s['sharpe']:>8.2f}")
    cc = C.drop(columns=['cash']).corr()
    print(f"  mean pairwise corr (ex-cash): {cc.values[np.triu_indices(len(cc),1)].mean():.3f}")

    cons, bh = arms['EW CONSERVATIVE (honest inputs)'], arms['buy & hold']
    cuts = np.array_split(np.arange(len(R)), 3)
    fc = [(stats(cons.iloc[c])['calmar'], stats(bh.iloc[c])['calmar']) for c in cuts]
    print(f"\nfold Calmar  conservative: {'  '.join(f'{a:+.2f}' for a,_ in fc)}")
    print(f"             buy & hold  : {'  '.join(f'{b:+.2f}' for _,b in fc)}")
    ho = slice(int(len(R)*0.8), None)
    hc, hb = stats(cons.iloc[ho]), stats(bh.iloc[ho])

    Sc, Sb = S['EW CONSERVATIVE (honest inputs)'], S['buy & hold']
    beat = sum(1 for a,b in fc if (a==a and b==b and a>b) or (a==a and b!=b))
    c1 = Sc['calmar'] > Sb['calmar']
    c2 = (Sc['dd'] - Sb['dd']) >= 20
    c3 = Sc['total'] > 0
    c4 = beat >= 2
    c5 = hc['calmar'] > hb['calmar'] if (hc['calmar']==hc['calmar'] and hb['calmar']==hb['calmar']) else hc['total'] > hb['total']
    print('\n--- SHIP BAR (conservative arm vs buy & hold) ---')
    for ok, t in [(c1, f"1. beats B&H on Calmar          {Sc['calmar']:.2f} vs {Sb['calmar']:.2f}"),
                  (c2, f"2. maxDD better by >=20pp       {Sc['dd']:.1f}% vs {Sb['dd']:.1f}%  ({Sc['dd']-Sb['dd']:+.1f}pp)"),
                  (c3, f"3. positive total return        {Sc['total']:+.1f}%"),
                  (c4, f"4. beats B&H Calmar >=2/3 folds {beat}/3"),
                  (c5, f"5. persists on holdout          {hc['calmar']:.2f} vs {hb['calmar']:.2f}")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  VERDICT: {'SHIP — diversification survives honest inputs' if all([c1,c2,c3,c4,c5]) else 'DOES NOT MEET THE BAR'}")
    print(f"  harsh arm (volsell also removed): Calmar {S['EW harsh (+ volsell removed)']['calmar']:.2f}, "
          f"maxDD {S['EW harsh (+ volsell removed)']['dd']:.1f}%, total {S['EW harsh (+ volsell removed)']['total']:+.1f}%")


if __name__ == '__main__':
    main()
