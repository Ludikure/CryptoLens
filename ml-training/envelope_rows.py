#!/usr/bin/env python3
"""Barrier outcomes at the APP'S REAL setup geometry, not the 5R research structure.

The envelope gates the LLM's setups, and those use the tighter bands: stop 2.0 ATR, TP1 1.5 ATR,
TP2 2.5 ATR -- i.e. TP1 at 0.75R and TP2 at 1.25R. Everything measured in the 5R structure is a
different instrument that happens to share a direction.

RE-RUN 2026-08-26 ON `_payoff` (`anchor='bar_close'`). The original walked the path from T+1h, four
hours before the signal existed — see the module docstring.
"""
import glob, os
import numpy as np, pandas as pd
from _payoff import simulate, PayoffParams, align_arms

H = 72
STOP_ATR = 2.0                       # the app's stop
TARGETS = {'tp1': 1.5, 'tp2': 2.5}   # in ATR -> 0.75R and 1.25R against a 2 ATR stop
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'


def rows(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)):
        return None
    f = pd.read_csv(fp, low_memory=False)
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    arms = {}
    for name, atr_mult in TARGETS.items():
        P = PayoffParams(wait_h=0, hold_h=H, stop_atr=STOP_ATR, tp_atr=atr_mult,
                         fee_pct=0.0, bar_hours=4)
        for side in ('LONG', 'SHORT'):
            o, _ = simulate(f, p, symbol=sym, depth_atr=0.0, side=side,
                            anchor='bar_close', entry_mode='market', params=P)
            if not len(o):
                return None
            arms[f'{name}_{side}'] = o[['symbol', 'timestamp', 'oppR']]
    joined, _ = align_arms(arms)
    ren = {f'{n}_{s}|oppR': f'{n}_{s}_R' for n in TARGETS for s in ('LONG', 'SHORT')}
    return joined.rename(columns=ren)


def main():
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    d = pd.concat([x for s in syms if (x := rows(s)) is not None], ignore_index=True)
    d.to_pickle('envelope_payoff_rows.pkl.gz')
    print(f'wrote {len(d):,} rows, {d.symbol.nunique()} symbols')
    for name in TARGETS:
        for side in ('LONG', 'SHORT'):
            print(f'  {name} {side:5s} mean R {d[f"{name}_{side}_R"].mean():+.4f}')


if __name__ == '__main__':
    main()
