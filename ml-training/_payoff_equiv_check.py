#!/usr/bin/env python3
"""Two-knob equivalence (plan step 1.2), the gate on trusting `_payoff.py`.

A "behaviour-preserving consolidation" proof is unavailable here, because the anchor changes
everywhere. This is the substitute:

  1. Run the module under `anchor='legacy_open'` and require BIT-IDENTICAL output against
     `level_entry_rows.pkl.gz`, the artefact produced by the script being replaced. That isolates
     PORT errors from the FIX.
  2. Flip to `anchor='bar_close'` and record the delta. That delta IS the finding.

If step 1 does not match, stop: the module is not a faithful port and any difference in step 2 is
unattributable.
"""
import glob, os, sys
import numpy as np, pandas as pd
from _payoff import simulate, PayoffParams

FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
DEPTHS = [0.00, 0.25, 0.50, 1.00]
P = PayoffParams(wait_h=12, hold_h=72, stop_atr=2.0, tp_atr=2.5, fee_pct=0.171, bar_hours=4)


def run(anchor, require_contiguous=True):
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    frames, provs = [], []
    for sym in syms:
        f = pd.read_csv(f'{FEAT}/{sym}.csv', low_memory=False)
        p = pd.read_csv(f'{PATH}/{sym}.csv').sort_values('ts').reset_index(drop=True)
        cols = {}
        keys = None
        for depth in DEPTHS:
            for side in ('LONG', 'SHORT'):
                mode = 'market' if depth == 0.0 else 'pullback'
                out, prov = simulate(f, p, symbol=sym, depth_atr=depth, side=side,
                                     anchor=anchor, entry_mode=mode, params=P,
                                     require_contiguous=require_contiguous)
                provs.append(prov)
                if not len(out):
                    keys = None
                    break
                if keys is None:
                    keys = out[['symbol', 'timestamp', 'atrPct']]
                cols[f'd{depth}_{side}_filled'] = out['filled'].to_numpy()
                cols[f'd{depth}_{side}_oppR'] = out['oppR'].to_numpy()
                cols[f'd{depth}_{side}_fillR'] = out['fillR'].to_numpy()
        if keys is None:
            continue
        frames.append(pd.concat([keys.reset_index(drop=True), pd.DataFrame(cols)], axis=1))
    return pd.concat(frames, ignore_index=True), provs


def main():
    print('=== step 1: legacy_open must reproduce level_entry_rows.pkl.gz exactly ===')
    # A FROZEN copy of the artifact produced by the pre-migration `level_entry.py`, restored from
    # commit 75864bf. It deliberately does NOT share a filename with anything a driver writes: the
    # first version of this check read `level_entry_rows.pkl.gz`, which the migrated driver then
    # overwrote with corrected output, and the check silently started comparing the new code against
    # itself. A reference artifact that a run can clobber is not a reference.
    old = pd.read_pickle('level_entry_rows.LEGACY.pkl.gz')
    new, provs = run('legacy_open')
    print(f'old {len(old):,} rows x {old.shape[1]} cols   new {len(new):,} rows x {new.shape[1]} cols')

    # `_payoff` drops rows whose window crosses a path gap; the original did not check. Compare on
    # the intersection and report what the guard removed, rather than calling a difference a failure.
    # csv_exports_v14 contains exactly ONE duplicated (symbol, timestamp): AVAXUSDT @ 1778025600,
    # same price and dRsi but two different atrPercent values. A key-merge cross-joins it 2x2 and
    # pairs the rows the wrong way round, which shows up as a spurious 1.7e-3 "port difference".
    # Drop it from both sides rather than papering over it — and note it, since a duplicate feature
    # row is a (small) defect in the training export itself.
    key = ['symbol', 'timestamp']
    dup_old = old.duplicated(key, keep=False)
    dup_new = new.duplicated(key, keep=False)
    if dup_old.any() or dup_new.any():
        print(f'duplicate keys dropped: {int(dup_old.sum())} old / {int(dup_new.sum())} new '
              f'({sorted(set(old.loc[dup_old, "symbol"]) | set(new.loc[dup_new, "symbol"]))})')
        old, new = old[~dup_old], new[~dup_new]
    merged = old.merge(new, on=key, suffixes=('_old', '_new'), how='inner')
    only_old = len(old) - len(merged)
    print(f'joined {len(merged):,}  |  in old only: {only_old:,} (gap guard + horizon)')

    worst, bad = 0.0, []
    for depth in DEPTHS:
        for side in ('LONG', 'SHORT'):
            for suffix in ('filled', 'oppR', 'fillR'):
                c = f'd{depth}_{side}_{suffix}'
                a, b = merged[f'{c}_old'].to_numpy(np.float64), merged[f'{c}_new'].to_numpy(np.float64)
                both_nan = np.isnan(a) & np.isnan(b)
                d = np.abs(np.where(both_nan, 0.0, a - b))
                if np.isnan(d).any():
                    bad.append((c, 'NaN mismatch', int(np.isnan(d).sum())))
                    continue
                worst = max(worst, float(d.max()))
                if d.max() > 0:
                    bad.append((c, 'value', float(d.max())))
    print(f'max absolute difference across all 24 columns: {worst:.3e}')
    if bad:
        print('MISMATCHES:')
        for x in bad[:12]:
            print('  ', x)
        sys.exit('step 1 FAILED — the port is not faithful; stop rather than interpreting step 2')
    print('step 1 PASSED — bit-identical on every shared row\n')

    print('=== step 2: bar_close, the corrected anchor. This delta is the finding. ===')
    fixed, provs2 = run('bar_close')
    for label, d in (('legacy_open', new), ('bar_close', fixed)):
        print(f'\n--- {label} ---')
        print(f'{"depth":>8}{"fill rate":>11}{"R per FILLED":>14}{"R per OPP":>12}{"vs market":>11}{"periods+":>10}')
        d = d.copy()
        d['dt'] = pd.to_datetime(d.timestamp, unit='s')
        periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')
        for side in ('SHORT', 'LONG'):
            print(f'  {side}')
            b = d[f'd0.0_{side}_oppR'].mean()
            for dep in DEPTHS:
                pos = tot = 0
                for i in range(len(periods) - 1):
                    w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
                    if w.sum() < 2000:
                        continue
                    tot += 1
                    pos += (d.loc[w, f'd{dep}_{side}_oppR'].mean() - d.loc[w, f'd0.0_{side}_oppR'].mean()) >= 0
                po = d[f'd{dep}_{side}_oppR'].mean()
                print(f'{dep:>8.2f}{d[f"d{dep}_{side}_filled"].mean():>11.1%}'
                      f'{d[f"d{dep}_{side}_fillR"].mean():>14.4f}{po:>12.4f}{po - b:>+11.4f}{f"{pos}/{tot}":>10}')

    print('\n=== acceptance test (plan step 1.3) ===')
    # The plan's targets came from a heredoc — the fourth hand computation of this number. They are
    # reproduced in SIGN, in MAGNITUDE and in PERIOD COUNT, but not to 1e-4, and the reason is
    # identified: they sit strictly BETWEEN the two admissible hold-window conventions (fill+0 gives
    # -0.0125/+0.0211, fill+1 gives -0.0120/+0.0221). The module's numbers supersede them, because
    # the module states its convention and the heredoc did not.
    for side, target, per in (('SHORT', -0.0123, '2/9'), ('LONG', +0.0216, '8/9')):
        got = fixed[f'd0.25_{side}_oppR'].mean() - fixed[f'd0.0_{side}_oppR'].mean()
        print(f'  {side}: plan {target:+.4f} ({per})  module {got:+.4f}  delta {got-target:+.4f}')

    tot_gap = sum(p.dropped_gap_in_window for p in provs2)
    tot_hz = sum(p.dropped_short_horizon for p in provs2)
    print(f'\nguards under bar_close: {tot_gap:,} row-slots dropped for a gap in the window, '
          f'{tot_hz:,} for a short horizon')


if __name__ == '__main__':
    main()
