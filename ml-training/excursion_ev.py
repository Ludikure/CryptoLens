#!/usr/bin/env python3
"""Does trading the excursion model's selections make money?

AUC 0.65 says the model RANKS barrier outcomes. It does not say a position pays. The pre-declaration
is explicit that passing the bar "does not establish that trading the structure is profitable", so
this measures the only thing that settles it: realised EV per trade, by selection threshold, against
the real fee.

THE PAYOFF IS THREE-WAY, NOT BINARY. `opportunity.ts:expectedValueR` assumes every trade ends at the
target or the stop; measured pooled, at 5R that assumption is wrong by +0.50R because ~20-25% of
trades end at NEITHER and exit at the 72h mark. Timeout is priced at its realised fill here.

FEE IN R IS NOT A CONSTANT. A 0.171% round trip costs 0.171R against a 1%-ATR stop and 0.057R
against a 3% one, so the fee is charged per trade off that row's own ATR rather than as one average.
"""
import numpy as np
import pandas as pd
import lightgbm as lgb

DATA = 'excursion_dataset.pkl.gz'
PAYOFF = 'excursion_payoff_rows.pkl.gz'
PRIMARY_R = 5.0
PURGE_BARS = 24
ROUND_TRIP_PCT = 0.171          # the user's measured Coinbase Advanced 2 derivatives round trip
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)


def main():
    df = pd.read_pickle(DATA).sort_values('timestamp').reset_index(drop=True)
    pay = pd.read_pickle(PAYOFF)
    df = df.merge(pay, on=['symbol', 'timestamp'], how='inner')
    feats = [c for c in df.columns if c.startswith('f_') and c != 'f_timestamp'
             and not c.startswith(('f_fwd', 'f_trade')) and pd.api.types.is_numeric_dtype(df[c])]

    # Fee in R units, per row: (round-trip % of notional) / (stop distance as % of price).
    # atrPercent IS the stop distance in percent, because the stop is 1.0 x ATR.
    df['fee_r'] = ROUND_TRIP_PCT / df['f_atrPercent'].clip(lower=0.05)

    uniq = np.unique(df.timestamp.values)
    split = uniq[int(len(uniq) * 0.70)]
    purge = uniq[min(int(len(uniq) * 0.70) + PURGE_BARS, len(uniq) - 1)]
    trn, tst = df[df.timestamp <= split], df[df.timestamp > purge]
    print(f'train {len(trn):,} rows  ->  holdout {len(tst):,} rows '
          f'({pd.to_datetime(purge, unit="s").date()} onward)')
    print(f'fee: {ROUND_TRIP_PCT}% round trip; median = {df.fee_r.median():.3f}R '
          f'(ATR median {df.f_atrPercent.median():.2f}%)\n')

    for side in ('LONG', 'SHORT'):
        y = f'hit_{side}_{PRIMARY_R:g}R'
        r_col = f'r_{side}_{PRIMARY_R:g}R'
        m = lgb.LGBMClassifier(**PARAMS).fit(trn[feats], trn[y])
        t = tst.copy()
        t['score'] = m.predict_proba(t[feats])[:, 1]

        print(f'{"="*84}\n{side} @ {PRIMARY_R:g}R  --  realised EV on the holdout, by selectivity\n{"="*84}')
        print(f'{"select":>10}{"n":>9}{"P(tgt)":>9}{"P(stop)":>9}{"P(t/o)":>9}'
              f'{"gross R":>10}{"fee R":>8}{"NET R":>9}{"verdict":>10}')

        for q in (1.00, 0.50, 0.20, 0.10, 0.05, 0.02):
            cut = t['score'].quantile(1 - q)
            s = t[t['score'] >= cut]
            if len(s) < 100:
                continue
            gross = s[r_col].mean()
            fee = s['fee_r'].mean()
            net = gross - fee
            pt = s[y].mean()
            ps = s[f'stopfirst_{side}'].mean() - pt      # stop first, i.e. stopped and not a win
            po = 1 - pt - max(ps, 0)
            print(f'{f"top {q:.0%}":>10}{len(s):>9,}{pt:>9.4f}{max(ps,0):>9.4f}{max(po,0):>9.4f}'
                  f'{gross:>10.4f}{fee:>8.3f}{net:>+9.4f}'
                  f'{("PROFIT" if net > 0 else "loss"):>10}')
        print()

    # Where does the fee actually bind? High-ATR rows pay far less in R terms.
    print('Fee drag by ATR bucket (why "0.171%" is not one number):')
    t = df.copy()
    t['atr_b'] = pd.qcut(t.f_atrPercent, 5, labels=['lowest', 'low', 'mid', 'high', 'highest'])
    g = t.groupby('atr_b', observed=True).agg(atr_pct=('f_atrPercent', 'median'),
                                              fee_r=('fee_r', 'median'), n=('fee_r', 'size'))
    for b, row in g.iterrows():
        print(f'  {b:>8}  ATR {row.atr_pct:>5.2f}%   fee {row.fee_r:>5.3f}R   n={int(row.n):,}')


if __name__ == '__main__':
    main()
