#!/usr/bin/env python3
"""Criteria 2 and 3 of docs/research/stop-target-joint.md, for the cells the map selected."""
import glob, os, sys
import numpy as np, pandas as pd
from _payoff import simulate, PayoffParams, align_arms
from _report import period_consistency, moving_block_bootstrap

FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
# (side, shipped, candidate) — declared by the map, not fitted beyond the pre-declared grid.
CELLS = {'SHORT': ((2.0, 1.5), (1.0, 5.0)), 'LONG': ((4.0, 1.5), (3.0, 5.0))}
env = pd.concat([pd.read_csv(f) for f in glob.glob('envelope_exports_ml/*.csv')],
                ignore_index=True)[['symbol', 'timestamp', 'alignedDirection']]
CACHE = 'stj_confirm'; os.makedirs(CACHE, exist_ok=True)
only = os.environ.get('ONLY')

syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
for s in ([x for x in syms if x == only] if only else syms):
    cf = f'{CACHE}/{s}.pkl'
    if os.path.exists(cf): continue
    f = pd.read_csv(f'{FEAT}/{s}.csv', low_memory=False)
    p = pd.read_csv(f'{PATH}/{s}.csv').sort_values('ts').reset_index(drop=True)
    arms = {}
    for side, (sh, cand) in CELLS.items():
        for (st, rr), nm in ((sh, 'ship'), (cand, 'cand')):
            for fee, ftag in ((0.171, 'net'), (0.0, 'gross')):
                o, _ = simulate(f, p, symbol=s, depth_atr=0.0, side=side, anchor='bar_close',
                                entry_mode='market',
                                params=PayoffParams(wait_h=12, hold_h=72, stop_atr=st,
                                                    tp_atr=st * rr, fee_pct=fee, bar_hours=4))
                arms[f'{side}_{nm}_{ftag}'] = o[['symbol', 'timestamp', 'oppR']]
    j, _ = align_arms(arms)
    for c in j.columns:
        if j[c].dtype == 'float64': j[c] = j[c].astype('float32')
    j.to_pickle(cf)
    print(f'  {s}', file=sys.stderr)

if len(glob.glob(f'{CACHE}/*.pkl')) < len(syms):
    print('incomplete — rerun', file=sys.stderr); sys.exit(0)

df = pd.concat([pd.read_pickle(f'{CACHE}/{s}.pkl') for s in syms],
               ignore_index=True).merge(env, on=['symbol', 'timestamp'])

for side, (sh, cand) in CELLS.items():
    S = df[df.alignedDirection == side]
    cn, sn = f'{side}_cand_net|oppR', f'{side}_ship_net|oppR'
    cg, sg = f'{side}_cand_gross|oppR', f'{side}_ship_gross|oppR'
    diff = S[cn].mean() - S[sn].mean()
    lo, hi = moving_block_bootstrap(S[cn].to_numpy(float) - S[sn].to_numpy(float), 18)
    pos, tot = period_consistency(S.assign(_a=S[cn]), '_a', sn, start='2020-01-01')
    gd = S[cg].mean() - S[sg].mean()
    eff = len(S) // 18
    print(f'\n{side}: shipped {sh[0]:g}A@{sh[1]:g}R -> candidate {cand[0]:g}A@{cand[1]:g}R')
    print(f'  n {len(S):,}  effective {eff:,}')
    print(f'  1 MAGNITUDE   net {diff:+.4f}  95% CI [{lo:+.4f},{hi:+.4f}]   bar +0.0200 '
          f'-> {"PASS" if diff >= 0.02 else "FAIL"}')
    print(f'  2 PERIODS     {pos}/{tot}  bar 6/9                        '
          f'-> {"PASS" if pos >= 6 and tot >= 9 else "FAIL"}')
    print(f'  3 GROSS       {gd:+.4f} (same direction? {"yes" if gd > 0 else "NO"})     '
          f'-> {"PASS" if gd > 0 else "FAIL"}')
    print(f'  4 POWER       effective n {eff:,}  bar 500                '
          f'-> {"PASS" if eff >= 500 else "FAIL"}')
    ok = diff >= 0.02 and pos >= 6 and tot >= 9 and gd > 0 and eff >= 500
    print(f'  VERDICT: {"SUPPORTED — ship" if ok else "NOT SUPPORTED — shipped geometry stands"}')
