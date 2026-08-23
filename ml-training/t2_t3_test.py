#!/usr/bin/env python3
"""T2 crash-probability model + T3 conditional direction under extreme states.
Designs frozen in docs/research/untested-four.md.

T3 carries a Bonferroni correction declared IN ADVANCE (alpha 0.05/8 = 0.00625) plus a holdout the
search never touches, because slicing eight states and hunting for one that departs from 50% is the
textbook way to manufacture a false discovery.
"""
import numpy as np, pandas as pd, lightgbm as lgb
from pathlib import Path
from scipy import stats as st
from sklearn.metrics import roc_auc_score

DROP = {'symbol','timestamp','price','regime','emaRegime'}
CRASH_BARS, CRASH_PCT = 60, -0.10          # 10 days of 4H bars, >10% drawdown


def build():
    fr = []
    for f in sorted(Path('csv_exports_v14').glob('*.csv')):
        d = pd.read_csv(f, low_memory=False)
        if len(d) < 400: continue
        d = d.sort_values('timestamp').reset_index(drop=True)
        # T2 target: worst forward drawdown over the next 10 days
        fmin = d['price'][::-1].rolling(CRASH_BARS, min_periods=1).min()[::-1].shift(-1)
        d['y_crash'] = ((fmin / d['price'] - 1) <= CRASH_PCT).astype(float)
        d.loc[fmin.isna(), 'y_crash'] = np.nan
        # T3 target: plain 24h direction
        d['y_up'] = (d['price'].shift(-6) > d['price']).astype(float)
        d.loc[d['price'].shift(-6).isna(), 'y_up'] = np.nan
        d['sym'] = f.stem
        fr.append(d)
    a = pd.concat(fr, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    feats = [c for c in a.columns if c not in DROP and c != 'sym' and not c.startswith(('fwd','y_'))
             and pd.api.types.is_numeric_dtype(a[c])]
    return a, feats


def t2(a, feats):
    print('=== T2 — crash probability: P(drawdown > 10% within 10 days) ===')
    d = a.dropna(subset=['y_crash']).reset_index(drop=True)
    n = len(d); aucs = []; preds = []
    print(f'  {n:,} bars, base rate {d.y_crash.mean()*100:.1f}%')
    for i in range(3):
        tr_end, te_end = int(n*(0.4+0.2*i)), int(n*(0.6+0.2*i))
        tr, te = d.iloc[:max(0, tr_end-48)], d.iloc[tr_end:te_end]
        if len(tr) < 5000 or len(te) < 1000: continue
        m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.05,
                               num_leaves=15, verbose=-1, n_jobs=-1)
        m.fit(tr[feats], tr['y_crash'])
        p = m.predict_proba(te[feats])[:, 1]
        aucs.append(roc_auc_score(te['y_crash'], p))
        preds.append(pd.DataFrame({'p': p, 'y': te['y_crash'].values}))
    print(f"  folds {'  '.join(f'{x:.3f}' for x in aucs)}   mean {np.mean(aucs):.4f}")
    allp = pd.concat(preds)
    allp['b'] = pd.cut(allp.p, [0, .1, .2, .3, .5, 1.0])
    rel = allp.groupby('b', observed=True).agg(actual=('y','mean'), n=('y','size'))
    print('  reliability:')
    prev = -1; mono = True
    for b, r in rel.iterrows():
        print(f"    {str(b):<14} actual {r.actual*100:>5.1f}%   n={int(r.n):>7,}")
        if r.actual < prev: mono = False
        prev = r.actual
    c1, c2 = all(x > 0.65 for x in aucs), mono
    print(f"  [{'PASS' if c1 and c2 else 'FAIL'}] AUC>0.65 all folds {c1} | monotone reliability {c2}")
    return aucs


def t3(a):
    print('\n=== T3 — conditional direction under 8 extreme states (Bonferroni a=0.00625) ===')
    d = a.dropna(subset=['y_up']).reset_index(drop=True)
    hold = d.iloc[int(len(d)*0.8):]            # holdout the search never touches
    srch = d.iloc[:int(len(d)*0.8)]
    def q(col, lo, hi):
        if col not in srch: return None
        return srch[col].quantile(lo), srch[col].quantile(hi)
    states = {}
    if 'atrPercentile' in srch: states['extreme volatility'] = lambda x: x.atrPercentile >= x.atrPercentile.quantile(.95)
    if 'fundingRateRaw' in srch: states['extreme funding'] = lambda x: (x.fundingRateRaw >= x.fundingRateRaw.quantile(.95)) | (x.fundingRateRaw <= x.fundingRateRaw.quantile(.05))
    if 'dVolumeRatio' in srch: states['extreme volume'] = lambda x: x.dVolumeRatio >= x.dVolumeRatio.quantile(.95)
    if 'vpDistToPocATR' in srch: states['major S/R interaction'] = lambda x: x.vpDistToPocATR.abs() <= 0.25
    if 'barsSinceRegimeChange' in srch: states['regime transition'] = lambda x: x.barsSinceRegimeChange <= 3
    if 'isWeekend' in srch: states['weekend'] = lambda x: x.isWeekend == 1
    if 'dRsi' in srch: states['extreme RSI'] = lambda x: (x.dRsi <= 20) | (x.dRsi >= 80)
    if 'ethBtcDelta6' in srch: states['BTC-alt divergence'] = lambda x: x.ethBtcDelta6.abs() >= x.ethBtcDelta6.abs().quantile(.95)
    alpha = 0.05/max(1, len(states))
    print(f'  {len(states)} states, alpha = 0.05/{len(states)} = {alpha:.5f}')
    print(f"  {'state':<24}{'n':>9}{'P(up)':>9}{'vs 50%':>9}{'p-value':>11}{'folds':>18}{'holdout':>10}")
    hits = []
    for name, fn in states.items():
        m = fn(srch); sub = srch[m]
        if len(sub) < 500: continue
        k, n = int(sub.y_up.sum()), len(sub)
        p = st.binomtest(k, n, 0.5).pvalue
        pu = k/n
        fl = [srch[m].iloc[c].y_up.mean() for c in np.array_split(np.arange(len(sub)), 3)]
        same = all(x > .5 for x in fl) or all(x < .5 for x in fl)
        hm = fn(hold); hsub = hold[hm]
        hp = hsub.y_up.mean() if len(hsub) > 100 else np.nan
        ok = p < alpha and abs(pu-.5) > .03 and same
        if ok: hits.append((name, pu, hp))
        print(f"  {name:<24}{n:>9,}{pu*100:>8.1f}%{(pu-.5)*100:>+8.1f}{p:>11.2e}"
              f"{'  '.join(f'{x*100:.0f}' for x in fl):>18}{(hp*100 if hp==hp else 0):>9.1f}%")
    print(f"\n  states passing p<{alpha:.5f} AND |dev|>3pp AND consistent sign: {len(hits)}")
    for nm, pu, hp in hits:
        surv = hp == hp and ((pu > .5) == (hp > .5)) and abs(hp-.5) > .01
        print(f"    {nm}: search {pu*100:.1f}% -> holdout {hp*100:.1f}%  [{'SURVIVES' if surv else 'FAILS holdout'}]")
    print(f"  [{'PASS' if any(h[2]==h[2] and (h[1]>.5)==(h[2]>.5) and abs(h[2]-.5)>.01 for h in hits) else 'FAIL'}] ship bar")


if __name__ == '__main__':
    a, feats = build()
    print(f'{len(a):,} bars, {len(feats)} features, {a.sym.nunique()} symbols\n')
    t2(a, feats); t3(a)
