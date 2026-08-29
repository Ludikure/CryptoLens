#!/usr/bin/env python3
"""Per-row realised R for the primary structure, so EV can be measured on model selections.

Same path walk as `excursion_labels.py`, but keeps the REALISED R of each simulated trade rather than
only the binary label: target pays +R, stop pays -1, and a timeout pays its actual 72h fill clipped
into [-1, R]. The timeout branch is the one a binary label cannot express and it is ~20-25% of rows.

RE-RUN 2026-08-26 ON `_payoff` (`anchor='bar_close'`). The original walked the path from T+1h, four
hours before the signal existed — see the module docstring.
"""
import glob, os
import numpy as np, pandas as pd
from _payoff import simulate, PayoffParams

H, STOP_ATR, R = 72, 1.0, 5.0
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
# fee_pct=0: this file measures the GROSS structure. Cost sensitivity is a separate arm, and folding
# a fee in here would silently make every downstream consumer net-of-a-fee it never asked for.
P = PayoffParams(wait_h=0, hold_h=H, stop_atr=STOP_ATR, tp_atr=R * STOP_ATR, fee_pct=0.0, bar_hours=4)


def rows(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)):
        return None
    f = pd.read_csv(fp, low_memory=False)
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    out = None
    for side in ('LONG', 'SHORT'):
        o, _ = simulate(f, p, symbol=sym, depth_atr=0.0, side=side,
                        anchor='bar_close', entry_mode='market', params=P)
        if not len(o):
            return None
        if out is None:
            out = o[['symbol', 'timestamp']].copy()
        out[f'r_{side}_{R:g}R'] = o['oppR'].to_numpy()
    return out


def main():
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    d = pd.concat([x for s in syms if (x := rows(s)) is not None], ignore_index=True)
    d.to_pickle('excursion_payoff_rows.pkl.gz')
    print(f'wrote {len(d):,} rows; mean R  LONG {d[f"r_LONG_{R:g}R"].mean():+.4f}  '
          f'SHORT {d[f"r_SHORT_{R:g}R"].mean():+.4f}')


if __name__ == '__main__':
    main()
