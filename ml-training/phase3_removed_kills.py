#!/usr/bin/env python3
"""Phase 3 — the two conditions C3 could not reach: `funding_supports_counter` and divergence.

C3 tested the removals it could READ from the export. These two could not be read, because they were
removed from `ANY_KILLED` in Parts 6-7 and so no longer feed any gate. They are still COMPUTED by the
real rules, though, so `buildUserPrompt` now returns them as diagnostics and `exportEnvelope.ts`
writes them. No reconstruction — which matters, because reconstructing `funding_supports_counter` is
precisely how Part 7 measured its exact logical complement (Jaccard 0.0000 against the live rule).

THE DOMAIN IS THE POINT. The whole kill block is wrapped in `if (oneHOpposes && oneH)`, so these
conditions EXIST only on counter-trend-pullback bars — 6.6% of the tape. Part 7 scored them on 100%,
a 15x population inflation. Here an empty cell means "outside the domain", never zero, and every arm
is scoped to the bars where the rule can actually fire.

Bar, unchanged: lift >= +0.02R AND >= 6/9 periods AND coverage >= 20% of the governed population.
"""
import glob, os
import numpy as np, pandas as pd
from phase2_c3_removed import evaluate, show

ENV_DIR = 'envelope_exports_ml'
DIAGS = ['killFunding', 'killVolume', 'killMacro', 'killDivergence']


def main():
    rows = pd.read_pickle('level_entry_rows.pkl.gz')
    syms = sorted(set(rows.symbol) & {os.path.basename(p)[:-4] for p in glob.glob(f'{ENV_DIR}/*.csv')})
    env = pd.concat([pd.read_csv(f'{ENV_DIR}/{s}.csv') for s in syms], ignore_index=True)
    d = rows.merge(env, on=['symbol', 'timestamp'], how='inner').reset_index(drop=True)

    have = [c for c in DIAGS if c in d.columns]
    if not have:
        raise SystemExit('no diagnostic columns — re-run exportEnvelope.ts after the prompt.ts change')
    dom = d[have[0]].notna()
    print(f'{len(d):,} rows; the kill block runs on {dom.mean():.2%} of them '
          f'(counter-trend-pullback bars only — this is the domain Part 7 inflated 15x)\n')
    print('fire rates WITHIN the domain, which is the only place these conditions exist:')
    for c in have:
        v = d.loc[dom, c]
        print(f'  {c:<18} fires on {v.mean():.2%} of {int(dom.sum()):,} domain bars')
    print()

    gov = d[dom].reset_index(drop=True)
    for entry, tag in (('d0.0', 'MARKET entry'), ('d0.25', '0.25 ATR PULLBACK entry')):
        res = []
        for side in ('SHORT', 'LONG'):
            sub = gov[gov.alignedDirection == side].reset_index(drop=True)
            if len(sub) < 1000:
                continue
            col = f'{entry}_{side}_oppR'
            for c in have:
                res.append(evaluate(sub, c, sub[c].fillna(0).astype(bool).to_numpy(), col, side))
        show(res, f'{tag} — lift over trading every COUNTER-TREND-PULLBACK bar of that side')


if __name__ == '__main__':
    main()
