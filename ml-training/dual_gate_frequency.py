#!/usr/bin/env python3
"""
How often do BOTH models fire at the >=70 threshold, per month?

Definition of a signal (matches how notifications actually fire = rising edge):
  a bar where ML Win crosses UP through 0.70 (prev bar < 0.70, this bar >= 0.70)
  AND the direction model is itself >=70% confident (pUp >= 0.70 OR pUp <= 0.30).

We also report the looser tier (ML rising-edge >= 0.70, any direction lean) for
context — that's the ~80% accuracy bucket; the dual-gate is the ~94% bucket.

Measured on the FROZEN 6-month holdout (never seen in training). Reported as:
  total signals, signals/month across the whole universe, and per-symbol/month.

Run:  python3 dual_gate_frequency.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')


def run(market):
    df, _ = H.load_market(market)
    df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna()].copy()
    df['up'] = (df['fwdReturn24H'] > 0).astype(int)
    sel, hold, _ = H.split_holdout(df)

    mq = H.make_model(); mq.fit(sel[H.FEATURES].fillna(0), sel['goodR'])
    md = H.make_model(); md.fit(sel[H.FEATURES].fillna(0), sel['up'])
    h = hold.copy()
    h['mlProb'] = mq.predict_proba(h[H.FEATURES].fillna(0))[:, 1]
    h['pUp'] = md.predict_proba(h[H.FEATURES].fillna(0))[:, 1]
    h = h.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    h['prevMl'] = h.groupby('symbol')['mlProb'].shift(1)

    n_sym = h['symbol'].nunique()
    span_days = (h['timestamp'].max() - h['timestamp'].min()) / 86400
    months = span_days / 30.44

    # rising edge through 0.70
    rise = h[(h['mlProb'] >= 0.70) & (h['prevMl'] < 0.70)].copy()
    dual = rise[(rise['pUp'] >= 0.70) | (rise['pUp'] <= 0.30)].copy()

    # accuracy on each tier (direction sign)
    def acc(d):
        if not len(d): return float('nan')
        return ((d['pUp'] > 0.5).astype(int) == d['up']).mean()*100

    print(f"\n{'='*68}\n{market.upper()} — holdout {months:.1f} months, {n_sym} symbols\n{'='*68}")
    print(f"  Tier 1  ML rising-edge >=0.70 (any direction):")
    print(f"    {len(rise):>4} signals  |  {len(rise)/months:>5.1f}/month universe  |  "
          f"{len(rise)/months/n_sym:.2f}/month per symbol  |  dir-acc {acc(rise):.0f}%")
    print(f"  Tier 2  BOTH >=70 (ML>=0.70 AND pUp>=0.70/<=0.30):")
    print(f"    {len(dual):>4} signals  |  {len(dual)/months:>5.1f}/month universe  |  "
          f"{len(dual)/months/n_sym:.2f}/month per symbol  |  dir-acc {acc(dual):.0f}%")
    print(f"    long/short split: {int((dual['pUp']>=0.70).sum())} long / "
          f"{int((dual['pUp']<=0.30).sum())} short")

    # what it means if you watch a handful of symbols
    for w in (1, 5, 10):
        print(f"    if you watch {w:>2} symbol(s): ~{len(dual)/months/n_sym*w:.1f} dual-gate signal(s)/month")


def main():
    run('crypto')
    run('stock')  # stock has no direction model in prod, shown for context only


if __name__ == '__main__':
    main()
