#!/usr/bin/env python3
"""Phase 2, C6 — how should the ML gate be parameterised? (Part 11, re-asked correctly.)

Part 11 asked ABSOLUTE-threshold vs COVERAGE-quantile, and its shipped artifact was retracted the
same day for a specific reason worth restating: it MEASURED unconditionally — `m = w & (d.ml >= t)`
with no bias filter, so 41.3% was 41.3% of ALL bars — and then SHIPPED conditionally on SHORT, whose
ML runs lower, giving a realised selectivity of ~24% that the same research called worse than no
gate. The population the gate governs was never the population it was measured on.

C4 and C5 have since established that side is the DOMINANT term: the ML floor lifts SHORT and inverts
LONG. So C6 conditions every arm on the side it would govern, which is the correction the retraction
demanded.

Three arms, each per side:
    ABSOLUTE     fixed raw threshold, never fitted
    COVERAGE     keep the top q by ML within the side — the parameterisation Part 11 shipped
    WALK-FORWARD fit the best threshold on earlier periods, apply to the next. Part 11 found this
                 DESTROYS the edge, with one arm returning -0.5342R out of sample and the optimizer
                 repeatedly converging on "no gate". Included as the control that decides whether any
                 fitted form is admissible at all.
"""
import glob, os
import numpy as np, pandas as pd
from _report import moving_block_bootstrap, period_consistency

ENV_DIR = 'envelope_exports_ml'
ABS_GRID = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65]
COV_GRID = [0.60, 0.50, 0.41, 0.30, 0.20]
OVERLAP = 18


def load():
    rows = pd.read_pickle('level_entry_rows.pkl.gz')
    syms = sorted(set(rows.symbol) & {os.path.basename(p)[:-4] for p in glob.glob(f'{ENV_DIR}/*.csv')})
    env = pd.concat([pd.read_csv(f'{ENV_DIR}/{s}.csv') for s in syms], ignore_index=True)
    oof = pd.read_csv('phase2_oof_crypto.csv')[['symbol', 'timestamp', 'p']]
    d = rows.merge(env, on=['symbol', 'timestamp'], how='inner')
    return d.merge(oof, on=['symbol', 'timestamp'], how='inner').reset_index(drop=True)


def gate_lift(sub, col, keep):
    """Lift of the KEPT set over trading every bar of this side, with a block interval."""
    v = sub[col].to_numpy(float)
    keep = np.asarray(keep, bool)
    if keep.sum() < 300:
        return None
    all_m = float(np.nanmean(v))
    contrib = np.where(keep, (v - all_m) / max(1e-9, keep.mean()), 0.0)
    pos, tot = period_consistency(sub.assign(_k=np.where(keep, v, np.nan)), '_k', col)
    return {'coverage': float(keep.mean()), 'lift': float(np.nanmean(v[keep])) - all_m,
            'ci': moving_block_bootstrap(contrib, OVERLAP), 'periods': f'{pos}/{tot}'}


def walk_forward_fit(sub, col, grid, periods_freq='6MS'):
    """Fit the argmax threshold on all EARLIER periods, apply to the next. Never peeks."""
    d = sub.copy()
    d['_dt'] = pd.to_datetime(d.timestamp, unit='s')
    edges = pd.date_range('2023-01-01', '2026-07-01', freq=periods_freq)
    applied, chosen = [], []
    for i in range(1, len(edges) - 1):
        past = d[d._dt < edges[i]]
        nxt = d[(d._dt >= edges[i]) & (d._dt < edges[i + 1])]
        if len(past) < 5000 or len(nxt) < 1000:
            continue
        best, best_t = -1e9, None
        for t in grid:
            k = past.p >= t
            if k.sum() < 300:
                continue
            s = past.loc[k, col].mean() - past[col].mean()
            if s > best:
                best, best_t = s, t
        if best_t is None:
            continue
        k = nxt.p >= best_t
        if k.sum() < 100:
            continue
        applied.append(nxt.loc[k, col].mean() - nxt[col].mean())
        chosen.append(best_t)
    return applied, chosen


def main():
    d = load()
    print(f'{len(d):,} rows, {d.symbol.nunique()} symbols\n')
    for entry in ('d0.0', 'd0.25'):
        for side in ('SHORT', 'LONG'):
            sub = d[d.alignedDirection == side].reset_index(drop=True)
            if len(sub) < 2000:
                continue
            col = f'{entry}_{side}_oppR'
            print(f'=== {entry} — {side} (ML within this side: '
                  f'median {sub.p.median():.3f}, p75 {sub.p.quantile(.75):.3f}) ===')
            print(f'{"arm":>22}{"coverage":>10}{"lift":>10}{"block 95% CI":>22}{"periods":>9}')
            for t in ABS_GRID:
                r = gate_lift(sub, col, (sub.p >= t).to_numpy())
                if r:
                    print(f'{f"ABS ML >= {t:.2f}":>22}{r["coverage"]:>10.1%}{r["lift"]:>+10.4f}'
                          f'{f"[{r['ci'][0]:+.4f},{r['ci'][1]:+.4f}]":>22}{r["periods"]:>9}')
            for q in COV_GRID:
                thr = sub.p.quantile(1 - q)
                r = gate_lift(sub, col, (sub.p >= thr).to_numpy())
                if r:
                    print(f'{f"COV top {q:.0%} (>= {thr:.3f})":>22}{r["coverage"]:>10.1%}'
                          f'{r["lift"]:>+10.4f}{f"[{r['ci'][0]:+.4f},{r['ci'][1]:+.4f}]":>22}{r["periods"]:>9}')
            ap, ch = walk_forward_fit(sub, col, ABS_GRID)
            if ap:
                per = ', '.join(f'{float(x):+.3f}' for x in ap)
                npos = sum(1 for x in ap if x > 0)
                print(f'{"WALK-FORWARD fitted":>22}{"—":>10}{np.mean(ap):>+10.4f}'
                      f'{f"{npos}/{len(ap)} periods":>22}')
                print(f'{"":>22}  out-of-sample by period: [{per}]')
                print(f'{"":>22}  thresholds it chose:     {[float(x) for x in ch]}')
            print()


if __name__ == '__main__':
    main()
