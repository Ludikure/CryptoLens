#!/usr/bin/env python3
"""Score the judges against the pre-declared bar (docs/research/llm-selection-test.md).

Arms: take-all, card-number (top half by net EV within the sample), and each LLM's TAKE / SKIP.
Selection gap = mean R(taken) - mean R(all sampled proposals), CI by day-clustered bootstrap.

Run:  python3 llm_selection_analyze.py
"""
import json
import os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'llm_selection')
B = 2000
SEED = 7
BAR_GAP = 0.05
BAR_PERIODS = (9, 13)
BAR_COVERAGE = 0.20
HORIZON_S = 72 * 3600


def eff_n(df):
    """Trades on one symbol with overlapping 72h windows are one observation (greedy on start)."""
    n = 0
    for _, g in df.groupby('symbol'):
        end = -np.inf
        for t in np.sort(g.timestamp.values):
            if t >= end:
                n += 1; end = t + HORIZON_S
            else:
                end = max(end, t + HORIZON_S)
    return n


def day_bootstrap_gap(taken, pop, rng):
    """CI on mean(taken) - mean(pop), resampling DAYS so co-moving rows travel together."""
    days = np.array(sorted(set(pop.day)))
    tg = {d: v.r_net.values for d, v in taken.groupby('day')}
    pg = {d: v.r_net.values for d, v in pop.groupby('day')}
    out = []
    for _ in range(B):
        pick = days[rng.randint(0, len(days), len(days))]
        t = np.concatenate([tg[d] for d in pick if d in tg]) if any(d in tg for d in pick) else np.array([])
        p = np.concatenate([pg[d] for d in pick if d in pg])
        if len(t) < 5 or len(p) < 5:
            continue
        out.append(t.mean() - p.mean())
    out = np.sort(out)
    return (out[int(0.025 * len(out))], out[int(0.975 * len(out)) - 1]) if len(out) > 100 else (np.nan, np.nan)


def arm_stats(name, taken, pop, rng):
    gap = taken.r_net.mean() - pop.r_net.mean()
    lo, hi = day_bootstrap_gap(taken, pop, rng)
    pos = tot = 0
    for h, sub in pop.groupby('half'):
        t = taken[taken.half == h]
        if len(t) >= 20 and len(sub) >= 20:
            tot += 1; pos += (t.r_net.mean() - sub.r_net.mean()) > 0
    wins = (taken.r_net > 0).sum(); losses = (taken.r_net < 0)
    pf = taken.r_net[taken.r_net > 0].sum() / abs(taken.r_net[taken.r_net < 0].sum()) if losses.any() else np.inf
    return dict(arm=name, n=len(taken), eff_n=eff_n(taken), coverage=len(taken) / len(pop),
                mean_r=taken.r_net.mean(), win=wins / max(len(taken), 1), pf=pf,
                gap=gap, lo=lo, hi=hi, pos=pos, tot=tot)


def verdict(s, card_gap):
    fails = []
    if not (s['gap'] >= BAR_GAP): fails.append(f'magnitude {s["gap"]:+.3f} < +{BAR_GAP}')
    if not (s['lo'] > 0): fails.append('CI includes 0')
    if not (s['pos'] >= BAR_PERIODS[0]): fails.append(f'periods {s["pos"]}/{s["tot"]} < {BAR_PERIODS[0]}')
    if not (s['gap'] > card_gap): fails.append(f'does not beat the card ({card_gap:+.3f})')
    if not (s['coverage'] >= BAR_COVERAGE): fails.append(f'coverage {s["coverage"]:.0%} < {BAR_COVERAGE:.0%}')
    return 'SHIPS' if not fails else 'NOT SUPPORTED — ' + '; '.join(fails)


def main():
    key = pd.read_pickle(os.path.join(OUT, 'key.pkl.gz'))
    key.index.name = 'id'
    pop = key.reset_index()
    rng = np.random.RandomState(SEED)
    print(f'population (sampled proposals): {len(pop):,} rows, eff n {eff_n(pop):,}, '
          f'{pop.day.nunique():,} days, mean net R {pop.r_net.mean():+.4f}, '
          f'target rate {(pop.r_gross >= 5).mean():.1%}, half-years {pop.half.nunique()}\n')

    rows = []
    rows.append(arm_stats('take-all', pop, pop, rng))
    card = pop[pop.net_ev >= pop.net_ev.median()]
    rows.append(arm_stats('card number (top half by EV)', card, pop, rng))
    card_gap = rows[-1]['gap']

    for judge in ('deepseek', 'anthropic'):
        p = os.path.join(OUT, f'decisions_{judge}.jsonl')
        if not os.path.exists(p):
            continue
        dec = {}
        for l in open(p):
            o = json.loads(l)
            if o.get('decision') in ('TAKE', 'SKIP'):
                dec[o['id']] = o['decision']
        d = pop[pop.id.isin(dec)].copy()
        d['decision'] = d.id.map(dec)
        take = d[d.decision == 'TAKE']; skip = d[d.decision == 'SKIP']
        print(f'{judge}: {len(d):,} decided ({len(take):,} TAKE / {len(skip):,} SKIP)')
        rows.append(arm_stats(f'{judge} TAKE', take, d, rng))
        s_skip = arm_stats(f'{judge} SKIP', skip, d, rng)
        rows.append(s_skip)

    print(f'\n{"arm":<32}{"n":>6}{"eff":>6}{"cov":>6}{"mean R":>9}{"win":>6}{"PF":>6}{"gap":>9}{"95% CI":>19}{"periods+":>10}')
    for s in rows:
        print(f'{s["arm"]:<32}{s["n"]:>6,}{s["eff_n"]:>6,}{s["coverage"]:>6.0%}{s["mean_r"]:>+9.4f}{s["win"]:>6.0%}'
              f'{s["pf"]:>6.2f}{s["gap"]:>+9.4f}   [{s["lo"]:+.3f}, {s["hi"]:+.3f}]{s["pos"]:>5}/{s["tot"]:<4}')

    print('\nverdict against the pre-declared bar:')
    for s in rows:
        if s['arm'].endswith('TAKE'):
            print(f'  {s["arm"]:<18} {verdict(s, card_gap)}')

    # Agreement between the two LLMs, when both ran.
    dd, da = [os.path.join(OUT, f'decisions_{j}.jsonl') for j in ('deepseek', 'anthropic')]
    if os.path.exists(dd) and os.path.exists(da):
        a = {json.loads(l)['id']: json.loads(l).get('decision') for l in open(dd)}
        b = {json.loads(l)['id']: json.loads(l).get('decision') for l in open(da)}
        both = [i for i in a if i in b and a[i] and b[i]]
        agree = np.mean([a[i] == b[i] for i in both]) if both else np.nan
        print(f'\nLLM agreement on {len(both):,} shared rows: {agree:.1%}')


if __name__ == '__main__':
    main()
