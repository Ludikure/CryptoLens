#!/usr/bin/env python3
"""Does the app's GEOMETRY give back the edge its model finds? (2026-08-26)

Two questions, both raised by the direction/ordering work and both testable on data already held.

  Q1 ENTRY STYLE. High-ML SHORT bars return +0.0571R at MARKET and +0.0030R on a 0.25 ATR pullback.
     If that holds, the app's ENTRY DISCIPLINE rule is destroying the edge on exactly the bars the
     model selects — the strongest moves run away and never fill.

  Q2 TARGET DISTANCE. ML lifts the ordered LONG hit rate by +0.023 at a 1.5R target and by +0.075 at
     3R. The app runs a 1.25R target (2 ATR stop / 2.5 ATR TP2), NEARER than either. A volatility
     model pays through distance; too near a target collects none of it.

PRE-DECLARED: net R per opportunity, after fees, at the app's stop. Both bootstraps must exclude
zero, and the direction of the effect must be consistent across BOTH sides, or it is noise.

The gate is scoped to the population it would govern (aligned direction), which is the correction the
Part 11 retraction demanded.
"""
import glob, os
import numpy as np, pandas as pd
from _payoff import simulate, PayoffParams, align_arms
from _report import moving_block_bootstrap, cluster_bootstrap

FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
BASE = dict(wait_h=12, hold_h=72, stop_atr=2.0, fee_pct=0.171, bar_hours=4)
TARGETS = [2.5, 3.5, 5.0, 7.0]           # ATR; against a 2 ATR stop that is 1.25R / 1.75R / 2.5R / 3.5R
ML_GATE = 0.55


def build():
    oof = pd.read_csv('phase2_oof_crypto.csv')[['symbol', 'timestamp', 'p']]
    env = pd.concat([pd.read_csv(f) for f in glob.glob('envelope_exports_ml/*.csv')], ignore_index=True)
    env = env[['symbol', 'timestamp', 'alignedDirection']]
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    frames = []
    for sym in syms:
        f = pd.read_csv(f'{FEAT}/{sym}.csv', low_memory=False)
        p = pd.read_csv(f'{PATH}/{sym}.csv').sort_values('ts').reset_index(drop=True)
        arms = {}
        ok = True
        for tp in TARGETS:
            for side in ('LONG', 'SHORT'):
                for mode, tag in (('market', 'mkt'), ('pullback', 'pb')):
                    o, _ = simulate(f, p, symbol=sym, depth_atr=0.0 if mode == 'market' else 0.25,
                                    side=side, anchor='bar_close', entry_mode=mode,
                                    params=PayoffParams(**BASE, tp_atr=tp))
                    if not len(o):
                        ok = False
                        break
                    arms[f'tp{tp:g}_{side}_{tag}'] = o[['symbol', 'timestamp', 'oppR']]
                if not ok:
                    break
            if not ok:
                break
        if ok:
            joined, _ = align_arms(arms)
            frames.append(joined)
    d = pd.concat(frames, ignore_index=True)
    return d.merge(env, on=['symbol', 'timestamp']).merge(oof, on=['symbol', 'timestamp']).reset_index(drop=True)


def main():
    d = build()
    print(f'{len(d):,} rows, {d.symbol.nunique()} symbols, gated at ML >= {ML_GATE}\n')
    print(f'{"side":>6}{"target":>9}{"R:R":>7}{"entry":>9}{"n":>8}{"net R":>10}'
          f'{"block 95% CI":>22}{"cluster 95% CI":>23}')
    for side in ('SHORT', 'LONG'):
        sub = d[(d.alignedDirection == side) & (d.p >= ML_GATE)].reset_index(drop=True)
        if len(sub) < 500:
            continue
        for tp in TARGETS:
            for tag, label in (('mkt', 'market'), ('pb', 'pullback')):
                col = f'tp{tp:g}_{side}_{tag}|oppR'
                v = sub[col].to_numpy(float)
                b = moving_block_bootstrap(v, 18)
                c = cluster_bootstrap(sub.assign(_v=v), '_v')
                print(f'{side:>6}{tp:>8.1f}A{tp / 2.0:>7.2f}{label:>9}{len(sub):>8,}'
                      f'{np.nanmean(v):>+10.4f}{f"[{b[0]:+.4f},{b[1]:+.4f}]":>22}'
                      f'{f"[{c[0]:+.4f},{c[1]:+.4f}]":>23}')
        print()
    print('The app ships 2.5 ATR (1.25 R:R) on a pullback — the top-right cell of each block.')


if __name__ == '__main__':
    main()
