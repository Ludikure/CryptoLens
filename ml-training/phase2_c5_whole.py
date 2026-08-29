#!/usr/bin/env python3
"""Phase 2, C5 — the envelope AS A WHOLE, on its real verdicts.

THIS IS THE PREMISE CHECK. Part 2 concluded "the envelope is NOT VERIFIED", and the entire Parts 6-10
programme — every removal, every rescoping — was built on that verdict. The reconstruction audit then
measured Part 2's implementation against the real envelope at 11.3% agreement, and showed that its
reconstructed tier NEVER EMITTED MODERATE OR HIGH across 799,193 bars: `cont = |momentumAlignment|`
takes values {0,1}, so both continuation thresholds fired on every row and the tier collapsed to
{FLAT, LOW}. Part 2's arms were comparing two slices of a two-valued function.

So the question is open, and this is the first measurement of it that reads the envelope's actual
`max_allowed` rather than rebuilding it. Envelope tiers come from `exportEnvelope.ts` re-run with the
walk-forward OOF ML injected, which is what makes the ML gates live in the exported verdict.

THE ARMS, following Part 2's design so the comparison is like-for-like:
    envelope        trade only non-FLAT bars, sized by tier
    random          a coverage-matched random gate — the control Part 2 used, and the one that
                    matters: a gate that cannot beat a coin flip at the same exposure is decoration
    ML alone        the ML floor with no other condition — Part 2 claimed this beats the full
                    envelope fourfold
    inverse         the envelope's own negation — Part 2 claimed this beats it on LONG

Reported per side, because C4 established that the ML component is direction-dependent and Part 2
did not split.
"""
import glob, os
import numpy as np, pandas as pd
from _report import moving_block_bootstrap, cluster_bootstrap, period_consistency

SIZE = {'FLAT': 0.0, 'LOW': 0.5, 'MODERATE': 0.75, 'HIGH': 1.0}
SIZE_ALT = {'FLAT': 0.0, 'LOW': 0.33, 'MODERATE': 0.67, 'HIGH': 1.0}
ENV_DIR = 'envelope_exports_ml'
OVERLAP = 18


def load():
    rows = pd.read_pickle('level_entry_rows.pkl.gz')
    syms = sorted(set(rows.symbol) & {os.path.basename(p)[:-4] for p in glob.glob(f'{ENV_DIR}/*.csv')})
    if not syms:
        raise SystemExit(f'no exports in {ENV_DIR}/ — run exportEnvelope.ts --ml first')
    env = pd.concat([pd.read_csv(f'{ENV_DIR}/{s}.csv') for s in syms], ignore_index=True)
    return rows.merge(env, on=['symbol', 'timestamp'], how='inner').reset_index(drop=True)


def arm(d, payoff, size, label, seed=0):
    """R per unit of exposure — the honest way to score a SIZING function.

    Dividing by mean size is what makes a gate that trades 8% of bars comparable to one that trades
    all of them: without it, any gate looks better simply by trading less.
    """
    v = d[payoff].to_numpy(float)
    s = np.asarray(size, float)
    if s.mean() <= 0:
        return None
    per_unit = np.where(np.isfinite(v), v * s, 0.0) / s.mean()
    return {'label': label, 'exposure': float(s.mean()), 'mean': float(np.nanmean(per_unit)),
            'block_ci': moving_block_bootstrap(per_unit, OVERLAP, seed=seed),
            'cluster_ci': cluster_bootstrap(d.assign(_p=per_unit), '_p', seed=seed),
            'periods': period_consistency(d.assign(_p=per_unit), '_p')}


def show(rows, title):
    print(f'=== {title} ===')
    print(f'{"arm":>22}{"exposure":>10}{"R per unit":>12}{"block 95% CI":>22}'
          f'{"cluster 95% CI":>24}{"periods":>9}')
    for r in rows:
        if r is None:
            continue
        b = f'[{r["block_ci"][0]:+.4f},{r["block_ci"][1]:+.4f}]'
        c = f'[{r["cluster_ci"][0]:+.4f},{r["cluster_ci"][1]:+.4f}]'
        p, t = r['periods']
        print(f'{r["label"]:>22}{r["exposure"]:>10.3f}{r["mean"]:>+12.4f}{b:>22}{c:>24}{f"{p}/{t}":>9}')
    print()


def main():
    d = load()
    print(f'{len(d):,} rows, {d.symbol.nunique()} symbols, tiers from the REAL envelope with OOF ML')
    print('tier distribution:', d.maxAllowed.value_counts(normalize=True).round(4).to_dict(), '\n')
    rng = np.random.default_rng(11)

    for entry, tag in (('d0.0', 'MARKET entry'), ('d0.25', '0.25 ATR PULLBACK entry')):
        for side in ('SHORT', 'LONG'):
            sub = d[d.alignedDirection == side].reset_index(drop=True)
            if len(sub) < 2000:
                continue
            col = f'{entry}_{side}_oppR'
            env_size = sub.maxAllowed.map(SIZE).to_numpy()
            alt_size = sub.maxAllowed.map(SIZE_ALT).to_numpy()
            inv_size = sub.maxAllowed.map({'FLAT': 1.0, 'LOW': 0.75, 'MODERATE': 0.5, 'HIGH': 0.0}).to_numpy()
            ml_size = (sub.rawMlPct.fillna(0) >= 50).astype(float).to_numpy()
            # Coverage-matched random: same MEAN exposure, allocated at random.
            rnd_size = (rng.random(len(sub)) < env_size.mean()).astype(float)
            rows = [
                arm(sub, col, np.ones(len(sub)), 'trade everything'),
                arm(sub, col, env_size, 'envelope (0/.5/.75/1)'),
                arm(sub, col, alt_size, 'envelope (0/.33/.67/1)'),
                arm(sub, col, rnd_size, 'RANDOM, matched'),
                arm(sub, col, ml_size, 'ML >= 50 alone'),
                arm(sub, col, inv_size, 'envelope INVERTED'),
            ]
            show(rows, f'{tag} — {side}')

    print('R per unit of EXPOSURE, so a gate cannot look good merely by trading less.')
    print('Part 2 claimed: envelope beats random by +0.0012R; ML alone beats the envelope fourfold;')
    print('on LONG the envelope is worse than random and its own inverse beats it.')


if __name__ == '__main__':
    main()
