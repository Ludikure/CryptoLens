#!/usr/bin/env python3
"""Does entering at a LEVEL beat entering at market? (Part 4 — RE-RUN 2026-08-26 on `_payoff`.)

At each bar: place an entry depth x ATR against the direction, wait up to 12h for a touch, then run
stop (2 ATR) and target (2.5 ATR) FROM THE FILL. Unfilled setups are recorded, not discarded.

THE PRIMARY NUMBER IS R PER OPPORTUNITY, not per filled trade. A pullback rule only trades when price
comes back, so it systematically misses the bars where price ran away -- the strongest moves. Judging
it on filled trades alone measures the survivors of its own selection.

WHAT CHANGED. The original indexed price paths from the feature timestamp T, but a feature row's
`price` is the CLOSE of the bar spanning T..T+4h, so it scanned for fills from T+1h -- four hours
before the signal existed. A pullback that had already happened inside the signal bar counted as a
fill. The simulation now lives in `_payoff.py` under `anchor='bar_close'`; this file is a driver.

The correction INVERTS the headline result on SHORT. See the module docstring and
`_payoff_equiv_check.py`, which proves the port bit-identical under the old anchor before flipping.
"""
import glob, os
import numpy as np, pandas as pd
from _payoff import simulate, PayoffParams, overlap_eff_n

DEPTHS = [0.00, 0.25, 0.50, 1.00]
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
P = PayoffParams(wait_h=12, hold_h=72, stop_atr=2.0, tp_atr=2.5, fee_pct=0.171, bar_hours=4)
OUT = 'level_entry_rows.pkl.gz'


def build(anchor='bar_close'):
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    frames, prov = [], []
    for sym in syms:
        f = pd.read_csv(f'{FEAT}/{sym}.csv', low_memory=False)
        p = pd.read_csv(f'{PATH}/{sym}.csv').sort_values('ts').reset_index(drop=True)
        cols, keys = {}, None
        for depth in DEPTHS:
            for side in ('LONG', 'SHORT'):
                out, pv = simulate(f, p, symbol=sym, depth_atr=depth, side=side, anchor=anchor,
                                   entry_mode='market' if depth == 0.0 else 'pullback', params=P)
                prov.append(pv)
                if not len(out):
                    keys = None
                    break
                keys = keys if keys is not None else out[['symbol', 'timestamp', 'atrPct']]
                for k in ('filled', 'oppR', 'fillR'):
                    cols[f'd{depth}_{side}_{k}'] = out[k].to_numpy()
            if keys is None:
                break
        if keys is not None:
            frames.append(pd.concat([keys.reset_index(drop=True), pd.DataFrame(cols)], axis=1))
    return pd.concat(frames, ignore_index=True), prov


def main():
    d, prov = build()
    d.attrs['provenance'] = [p.to_dict() for p in prov[:1]]
    d.to_pickle(OUT)
    d = d.copy()
    d['dt'] = pd.to_datetime(d.timestamp, unit='s')
    periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')

    eff = overlap_eff_n(len(d), P.hold_h, P.bar_hours)
    print(f'{len(d):,} opportunities, {d.symbol.nunique()} symbols — but only ~{eff:,} independent: '
          f'a {P.hold_h}h hold at {P.bar_hours}h spacing means ~{P.hold_h // P.bar_hours} consecutive '
          f'rows resolve against overlapping paths.\n')
    for side in ('SHORT', 'LONG'):
        print(f'=== {side} — 2.5 ATR target, 2 ATR stop, net of fees ===')
        print(f'{"depth":>8}{"fill rate":>11}{"R per FILLED":>14}{"R per OPPORTUNITY":>19}'
              f'{"vs market":>11}{"periods+":>10}')
        b = d['d0.0_%s_oppR' % side].mean()
        for dep in DEPTHS:
            pos = tot = 0
            for i in range(len(periods) - 1):
                w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
                if w.sum() < 2000:
                    continue
                tot += 1
                pos += (d.loc[w, f'd{dep}_{side}_oppR'].mean()
                        - d.loc[w, f'd0.0_{side}_oppR'].mean()) >= 0
            po = d[f'd{dep}_{side}_oppR'].mean()
            print(f'{dep:>8.2f}{d[f"d{dep}_{side}_filled"].mean():>11.1%}'
                  f'{d[f"d{dep}_{side}_fillR"].mean():>14.4f}{po:>19.4f}{po - b:>+11.4f}'
                  f'{f"{pos}/{tot}":>10}')
        print()


if __name__ == '__main__':
    main()
