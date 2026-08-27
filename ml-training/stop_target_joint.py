#!/usr/bin/env python3
"""THE TEST pre-declared in docs/research/stop-target-joint.md (e286e31). All four criteria required."""
import glob, os, sys
import numpy as np, pandas as pd
from _payoff import simulate, PayoffParams, align_arms
from _report import period_consistency

FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
STOPS = {'LONG': [2.0, 3.0, 4.0, 5.0], 'SHORT': [1.0, 2.0, 3.0]}
RRS = [0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0]
SHIPPED = {'LONG': (4.0, 1.5), 'SHORT': (2.0, 1.5)}   # analysis path: floor x crypto idealTP2RR

env = pd.concat([pd.read_csv(f) for f in glob.glob('envelope_exports_ml/*.csv')],
                ignore_index=True)[['symbol', 'timestamp', 'alignedDirection']]

def build(fee):
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    fr = []
    for i, s in enumerate(syms, 1):
        f = pd.read_csv(f'{FEAT}/{s}.csv', low_memory=False)
        p = pd.read_csv(f'{PATH}/{s}.csv').sort_values('ts').reset_index(drop=True)
        arms, ok = {}, True
        for side in ('LONG', 'SHORT'):
            for st in STOPS[side]:
                for rr in RRS:
                    for mode, tag in (('market', 'mkt'), ('pullback', 'pb')):
                        o, _ = simulate(f, p, symbol=s, depth_atr=0.0 if mode == 'market' else 0.25,
                                        side=side, anchor='bar_close', entry_mode=mode,
                                        params=PayoffParams(wait_h=12, hold_h=72, stop_atr=st,
                                                            tp_atr=st * rr, fee_pct=fee, bar_hours=4))
                        if not len(o): ok = False; break
                        arms[f'{side}_{st}_{rr}_{tag}'] = o[['symbol', 'timestamp', 'oppR']]
                    if not ok: break
                if not ok: break
            if not ok: break
        if ok:
            j, _ = align_arms(arms); fr.append(j)
        print(f'  {i}/{len(syms)} {s}{"" if ok else "  SKIPPED"}', file=sys.stderr)
    return pd.concat(fr, ignore_index=True).merge(env, on=['symbol', 'timestamp'])

print('building net...', file=sys.stderr); net = build(0.171)
print('building gross...', file=sys.stderr); gross = build(0.0)
net.to_pickle('stop_target_net.pkl'); gross.to_pickle('stop_target_gross.pkl')

for side in ('LONG', 'SHORT'):
    S = net[net.alignedDirection == side]; G = gross[gross.alignedDirection == side]
    eff = len(S) // 18
    print(f'\n{"="*78}\n{side}: {len(S):,} bars, effective n ~{eff:,}\n{"="*78}')
    print(f'{"stop":>6}' + ''.join(f'{f"R:R {r}":>11}' for r in RRS))
    for st in STOPS[side]:
        print(f'{st:>5.1f}A' + ''.join(f'{S[f"{side}_{st}_{r}_mkt|oppR"].mean():>+11.4f}' for r in RRS))
    print(f'\n  pullback entry:')
    for st in STOPS[side]:
        print(f'{st:>5.1f}A' + ''.join(f'{S[f"{side}_{st}_{r}_pb|oppR"].mean():>+11.4f}' for r in RRS))
    print(f'\n  gross (market):')
    for st in STOPS[side]:
        print(f'{st:>5.1f}A' + ''.join(f'{G[f"{side}_{st}_{r}_mkt|oppR"].mean():>+11.4f}' for r in RRS))
