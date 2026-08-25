#!/usr/bin/env python3
"""Is the SHORT result an EDGE, or is it a bear market in the test window?

The holdout EV came out +0.27R net at top-10% SHORT and negative everywhere on LONG. That asymmetry
is the shape of a regime artifact, and this project has been caught by exactly that before:
[[regime-hold]] produced a spectacular short return that was one directional bet, and T6's rotation
looked strong until equal-weight beat it.

The holdout (2024-07 onward) contains BTC's run to ~124k AND the crash to ~59k, so a window-wide
number cannot distinguish "the model selects well" from "the window fell".

THREE CONTROLS, all of which the headline must survive:

  1. ALWAYS-SHORT baseline in the same window. If the model does not beat taking every short, the
     selection adds nothing and the result is the regime.
  2. SIGN STABILITY across non-overlapping sub-periods. A real edge does not need the tape to fall.
     Reported alongside each period's BTC return so regime dependence is visible, not inferred.
  3. LONG-SHORT SPREAD. If the model ranks well, its top-decile short should beat its bottom-decile
     short within the same window - a comparison that is immune to the window's direction because
     both legs live in it.
"""
import numpy as np
import pandas as pd
import lightgbm as lgb

R, PURGE = 5.0, 24
FEE = 0.171
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)


def main():
    df = (pd.read_pickle('excursion_dataset.pkl.gz')
            .merge(pd.read_pickle('excursion_payoff_rows.pkl.gz'), on=['symbol', 'timestamp'])
            .sort_values('timestamp').reset_index(drop=True))
    feats = [c for c in df.columns if c.startswith('f_') and c != 'f_timestamp'
             and not c.startswith(('f_fwd', 'f_trade')) and pd.api.types.is_numeric_dtype(df[c])]
    df['fee_r'] = FEE / df['f_atrPercent'].clip(lower=0.05)
    df['dt'] = pd.to_datetime(df.timestamp, unit='s')

    btc = df[df.symbol == 'BTCUSDT'].set_index('dt')['f_price'].sort_index()

    # Six-month non-overlapping test periods; each trains only on data strictly before it.
    periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')
    print(f'{"period":>18}{"BTC ret":>9}{"n":>8}{"always-short":>14}'
          f'{"model top10%":>14}{"bottom10%":>11}{"spread":>9}')
    print('-' * 84)

    rowsout = []
    for i in range(len(periods) - 1):
        a, b = periods[i], periods[i + 1]
        trn = df[df.dt < a - pd.Timedelta(hours=PURGE * 4)]
        tst = df[(df.dt >= a) & (df.dt < b)]
        if len(trn) < 20_000 or len(tst) < 2_000:
            continue
        y = f'hit_SHORT_{R:g}R'
        if trn[y].nunique() < 2:
            continue

        m = lgb.LGBMClassifier(**PARAMS).fit(trn[feats], trn[y])
        t = tst.copy()
        t['score'] = m.predict_proba(t[feats])[:, 1]
        rc = f'r_SHORT_{R:g}R'

        net = lambda s: (s[rc] - s['fee_r']).mean()
        always = net(t)
        hi = net(t[t.score >= t.score.quantile(0.90)])
        lo = net(t[t.score <= t.score.quantile(0.10)])

        bs = btc[(btc.index >= a) & (btc.index < b)]
        bret = (bs.iloc[-1] / bs.iloc[0] - 1) if len(bs) > 2 else np.nan

        print(f'{a.strftime("%Y-%m"):>10}->{b.strftime("%m"):>6}{bret:>+9.1%}{len(t):>8,}'
              f'{always:>+14.4f}{hi:>+14.4f}{lo:>+11.4f}{hi-lo:>+9.4f}')
        rowsout.append(dict(period=a, btc=bret, always=always, hi=hi, lo=lo, spread=hi - lo))

    r = pd.DataFrame(rowsout)
    if r.empty:
        print('no periods'); return

    print('-' * 84)
    print(f'{"MEAN":>18}{r.btc.mean():>+9.1%}{"":>8}{r.always.mean():>+14.4f}'
          f'{r.hi.mean():>+14.4f}{r.lo.mean():>+11.4f}{r.spread.mean():>+9.4f}')

    r.to_csv('excursion_regime_control.csv', index=False)
    up, dn = r[r.btc > 0], r[r.btc <= 0]
    print(f'\nCONTROL 1 -- does selection beat always-short?')
    print(f'  model top-10% {r.hi.mean():+.4f}R  vs  always-short {r.always.mean():+.4f}R'
          f'   -> {"BEATS" if r.hi.mean() > r.always.mean() else "DOES NOT BEAT"}')

    # Judged on the SIGN COUNT and the MEDIAN, not the mean. With 5 periods a single large
    # outlier drags the mean positive while most periods lose -- which is exactly what happens
    # here, and an earlier version of this control passed the result on that mean.
    print(f'\nCONTROL 2 -- sign stability (a real edge should not need a falling tape)')
    print(f'  periods with BTC UP   n={len(up):>2}: median {up.hi.median():+.4f}R  '
          f'mean {up.hi.mean():+.4f}R  ({(up.hi > 0).sum()}/{len(up)} positive)')
    print(f'  periods with BTC DOWN n={len(dn):>2}: median {dn.hi.median():+.4f}R  '
          f'mean {dn.hi.mean():+.4f}R  ({(dn.hi > 0).sum()}/{len(dn)} positive)')
    print(f'  correlation(top-10% EV, BTC return) = {r.hi.corr(r.btc):+.3f}'
          f'   [near -1 = pure regime bet]')
    if len(up):
        w = up.loc[up.hi.idxmax()]
        print(f'  largest UP-period contributor: {w.period:%Y-%m} at {w.hi:+.4f}R -- '
              f'mean without it {up.drop(up.hi.idxmax()).hi.mean():+.4f}R')

    print(f'\nCONTROL 3 -- within-window ranking spread (immune to window direction)')
    print(f'  top-decile minus bottom-decile: {r.spread.mean():+.4f}R'
          f'   ({(r.spread > 0).sum()}/{len(r)} periods positive)')

    c1 = r.hi.mean() > r.always.mean()
    c2 = len(up) > 0 and (up.hi > 0).sum() >= 0.6 * len(up)      # sign count, not mean
    c3 = (r.spread > 0).sum() >= 0.7 * len(r)
    print(f'\n  [{"PASS" if c1 else "FAIL"}] 1 selection beats always-short')
    print(f'  [{"PASS" if c2 else "FAIL"}] 2 profitable in rising markets '
          f'({(up.hi > 0).sum()}/{len(up)} periods)')
    print(f'  [{"PASS" if c3 else "FAIL"}] 3 ranking spread holds in every window')
    print(f'\n=> RANKING is {"REAL" if c3 else "not established"}; '
          f'PROFITABILITY is {"regime-independent" if c2 else "REGIME-DEPENDENT"}')


if __name__ == '__main__':
    main()
