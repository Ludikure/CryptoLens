#!/usr/bin/env python3
"""Phase 2, C3 — the gates removed in Parts 1-11 that have no independent ground.

This is the open PRODUCTION decision: those removals stand today, and the evidence that produced
them is retracted. Unsupported is not the same as proven wrong, so each one has to be re-decided on
evidence rather than left where a broken measurement put it.

WHAT IS DIFFERENT THIS TIME. Every earlier test of these conditions RECONSTRUCTED them in Python from
v14 feature columns, and the reconstruction audit measured that reconstruction against the real
envelope at 11.3% agreement. This joins `envelope_exports/` — the verdict recorded by the real
`buildUserPrompt` — to the payoff rows on (symbol, timestamp). The conditions are read, not rebuilt.

PRE-DECLARED BAR, unchanged from Parts 1-9 and printed beside every value:
    lift >= +0.02R  AND  >= 6/9 half-year periods positive  AND  coverage >= 20%
The coverage floor is what stops a thin slice with a large lift from being adopted; Part 9's +0.1345R
on 2,523 kept bars is the case it exists to catch.

BOTH ENTRY STYLES are reported. C1 established that a pullback entry is mostly abstention, so a gate
that only helps under one entry style is a weaker finding than one that helps under both.
"""
import glob, os
import numpy as np, pandas as pd
from _report import moving_block_bootstrap, cluster_bootstrap, period_consistency
import _guards as G

BAR_LIFT, BAR_PERIODS, BAR_COVERAGE = 0.02, 6, 0.20
OVERLAP = 18


def load():
    rows = pd.read_pickle('level_entry_rows.pkl.gz')
    syms = sorted(set(rows.symbol) & {os.path.basename(p)[:-4] for p in glob.glob('envelope_exports/*.csv')})
    env = pd.concat([pd.read_csv(f'envelope_exports/{s}.csv') for s in syms], ignore_index=True)
    return rows.merge(env, on=['symbol', 'timestamp'], how='inner').reset_index(drop=True)


def evaluate(d, name, fires, payoff_col, side):
    """`fires` = the gate BLOCKS this bar. Lift is what the KEPT set gains over trading everything."""
    fires = np.asarray(fires, bool)
    kept = ~fires
    v = d[payoff_col].to_numpy(float)
    if kept.sum() < 500 or fires.sum() < 500:
        return {'name': name, 'side': side, 'skip': f'too few ({int(fires.sum())} blocked, {int(kept.sum())} kept)'}
    all_mean = float(np.nanmean(v))
    kept_mean = float(np.nanmean(v[kept]))
    blocked_mean = float(np.nanmean(v[fires]))
    lift = kept_mean - all_mean
    # The interval is on the LIFT, so it must be built from a per-row quantity whose mean IS the
    # lift: keeping a bar contributes (v - all_mean)/P(kept) and blocking contributes 0.
    contrib = np.where(kept, (v - all_mean) / max(1e-9, kept.mean()), 0.0)
    pos, tot = period_consistency(d.assign(_k=np.where(kept, v, np.nan)), '_k', payoff_col)
    cov = float(kept.mean())
    ok = lift >= BAR_LIFT and pos >= BAR_PERIODS and cov >= BAR_COVERAGE
    return {'name': name, 'side': side, 'fires': float(fires.mean()), 'coverage': cov,
            'blocked': blocked_mean, 'kept': kept_mean, 'lift': lift,
            'block_ci': moving_block_bootstrap(contrib, OVERLAP),
            'cluster_ci': cluster_bootstrap(d.assign(_c=contrib), '_c'),
            'periods': f'{pos}/{tot}', 'passes': ok}


def show(res, title):
    print(f'=== {title} ===')
    print(f'{"side":>6}{"condition":>22}{"blocks":>8}{"cover":>7}{"blocked R":>11}{"kept R":>9}'
          f'{"lift":>9}{"block 95% CI":>21}{"periods":>9}{"verdict":>9}')
    for r in res:
        if 'skip' in r:
            print(f'{r["side"]:>6}{r["name"]:>22}  {r["skip"]}')
            continue
        ci = f'[{r["block_ci"][0]:+.4f},{r["block_ci"][1]:+.4f}]'
        print(f'{r["side"]:>6}{r["name"]:>22}{r["fires"]:>8.1%}{r["coverage"]:>7.0%}{r["blocked"]:>+11.4f}'
              f'{r["kept"]:>+9.4f}{r["lift"]:>+9.4f}{ci:>21}{r["periods"]:>9}'
              f'{"PASSES" if r["passes"] else "fails":>9}')
    print()


def main():
    d = load()
    print(f'{len(d):,} rows, {d.symbol.nunique()} symbols — envelope verdicts joined to payoffs')
    print(f'independence: {G.check_independence(len(d), 72, 4)}\n')

    aligned_full = d.alignment.isin(['ALIGNED_BULLISH', 'ALIGNED_BEARISH'])
    not_full = ~aligned_full

    for entry, tag in (('d0.0', 'MARKET entry'), ('d0.25', '0.25 ATR PULLBACK entry')):
        res = []
        for side in ('SHORT', 'LONG'):
            col = f'{entry}_{side}_oppR'
            dirn = d.alignedDirection == side
            # `alignment_not_full` — REMOVED on SHORT in Part 1, kept on LONG. Scoped to the bars the
            # gate would actually govern: it only speaks where the daily bias picks that side.
            sub = d[dirn].reset_index(drop=True)
            if len(sub) > 1000:
                res.append(evaluate(sub, 'alignment_not_full', not_full[dirn.to_numpy()].to_numpy(), col, side))
                # `continuation < 2` — kept on crypto SHORT, REMOVED on LONG.
                res.append(evaluate(sub, 'continuation < 2', (sub.continuationCount < 2).to_numpy(), col, side))
                res.append(evaluate(sub, 'continuation < 3', (sub.continuationCount < 3).to_numpy(), col, side))
        show(res, f'{tag} — gate LIFT over trading every bar of that side')

    print('GUARDS on the true conditions (these are the checks the reconstructions failed):')
    conds = {'alignment_not_full': not_full.to_numpy(),
             'continuation<2': (d.continuationCount < 2).to_numpy(),
             'continuation<3': (d.continuationCount < 3).to_numpy()}
    try:
        print(G.check_fire_rates(conds).to_string(index=False))
    except G.GuardError as e:
        print(f'  {e}')
    for nm, thr in (('continuationCount', 2), ('continuationCount', 3)):
        try:
            print('  ', G.check_value_domain(nm, d.continuationCount.to_numpy(), thr))
        except G.GuardError as e:
            print(f'   {e}')
    print(f'\npre-declared bar: lift >= {BAR_LIFT:+.4f} AND periods >= {BAR_PERIODS}/9 '
          f'AND coverage >= {BAR_COVERAGE:.0%}')


if __name__ == '__main__':
    main()
