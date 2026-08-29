#!/usr/bin/env python3
"""Part 9 retroactive: re-judge the Parts 1-7 conditions on statistics their coverage can support.

Pre-declared in docs/research/envelope-rules.md (frozen at 49b0420).

Part 8 established that global lift is capped at `fire_rate x (kept - blocked)`, so a condition
firing on 1-2% of bars CANNOT reach a +0.02R bar no matter how good it is -- the earnings gates
scored "noise" while delivering 100% of their arithmetic maximum. Every sparse condition judged in
Parts 1-7 was therefore judged against a bar it could not reach.

Adds two columns the earlier sweeps lacked:
  maxlift   fire_rate x (kept - blocked) -- the ceiling of the metric they were scored on
  penalty   kept - blocked, per BLOCKED bar, which is coverage-independent
  pen+      periods in which the penalty is positive (consistency of the penalty, not of the lift)

A condition is re-opened only if its penalty is large AND consistent. Nothing here is adopted on
this pass; the point is to find anything dismissed on arithmetic rather than on evidence.
"""
import numpy as np, pandas as pd

d = (pd.read_pickle('excursion_dataset.pkl.gz')
       .merge(pd.read_pickle('level_entry_rows.pkl.gz'), on=['symbol', 'timestamp'])
       .sort_values(['symbol', 'timestamp']).reset_index(drop=True))
d['dt'] = pd.to_datetime(d.timestamp, unit='s')
periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')

bias = np.sign(d.f_tfAlignment)
vol_hi = d.f_dVolumeRatio >= d.f_dVolumeRatio.quantile(0.70)
counter_move = np.sign(d.f_dRsiDelta1.fillna(0)) == -bias
oneH_bias = np.sign(d.f_oneHScore.fillna(0))
stack_bull, stack_bear = d.f_dStackBull.astype(bool), d.f_dStackBear.astype(bool)

CONDS = {
    'counter_move_volume_exceeds (kill)': vol_hi & counter_move & (bias != 0),
    'funding_supports_counter (REMOVED)': (np.sign(d.f_fundingRateRaw.fillna(0)) == -bias) & (bias != 0),
    '1H opposes daily (downgrade)':       (oneH_bias != 0) & (bias != 0) & (oneH_bias != bias),
    'structureAlignment weak':            d.f_structureAlignment.abs() < 1,
    'crypto_bear_regime (downgrade)':     stack_bear,
    'chase: extended aligned trend':      (bias != 0) & (stack_bull | stack_bear),
}


def eff_n(mask):
    tot = 0
    for _, g in d.groupby('symbol'):
        v = mask.loc[g.index].to_numpy()
        tot += int(((v[1:] & ~v[:-1]).sum()) + (1 if len(v) and v[0] else 0))
    return tot


print(f'{len(d):,} bars, {d.symbol.nunique()} symbols\n')
for side in ('SHORT', 'LONG'):
    c = f'd0.25_{side}_oppR'
    allb = d[c].mean()
    print(f'=== {side} — baseline {allb:+.4f}R ===')
    print(f'{"condition":>36}{"fires":>7}{"episodes":>10}{"lift":>9}{"maxlift":>9}'
          f'{"per+":>6}{"penalty":>10}{"pen+":>6}{"re-open?":>10}')
    for name, fires in CONDS.items():
        if fires.sum() < 500:
            print(f'{name:>36}{fires.mean():>7.1%}{"too rare":>50}'); continue
        blocked, kept = d.loc[fires, c].mean(), d.loc[~fires, c].mean()
        lift = kept - allb
        maxlift = fires.mean() * (kept - blocked)
        penalty = kept - blocked
        pos = tot = pp = pt = 0
        for i in range(len(periods) - 1):
            w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
            if w.sum() < 2000: continue
            k, a = d.loc[w & ~fires, c].mean(), d.loc[w, c].mean()
            if np.isfinite(k) and np.isfinite(a): tot += 1; pos += (k - a) >= 0
            bl, kp = d.loc[w & fires, c].mean(), d.loc[w & ~fires, c].mean()
            if np.isfinite(bl) and np.isfinite(kp): pt += 1; pp += (kp - bl) >= 0
        # Re-open only when the coverage-independent statistic is both large and consistent.
        reopen = 'YES' if (penalty >= 0.02 and pp >= 6 and lift < 0.02) else '—'
        print(f'{name:>36}{fires.mean():>7.1%}{eff_n(fires):>10,}{lift:>+9.4f}{maxlift:>+9.4f}'
              f'{f"{pos}/{tot}":>6}{penalty:>+10.4f}{f"{pp}/{pt}":>6}{reopen:>10}')
    print()
