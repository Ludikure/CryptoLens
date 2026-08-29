#!/usr/bin/env python3
"""THE TEST pre-declared in docs/research/ml-floor-long-inversion.md (d478ba7).

Bar, fixed before running, all four required:
  1 monotonicity      Spearman(ML band, net R) negative at p < 0.01
  2 period consistency no-floor beats the current floor in >= 6 of 9 half-year periods
  3 both regimes      the sign holds in greed AND not-greed
  4 power             effective n >= 500 in every cell carrying a claim
Partial support does not ship.
"""
import glob, os
import numpy as np, pandas as pd
from scipy.stats import spearmanr
from _report import moving_block_bootstrap

FLOOR = 0.55          # the floor as currently applied
OVERLAP = 18


def load():
    rows = pd.read_pickle('level_entry_rows.pkl.gz')
    env = pd.concat([pd.read_csv(f) for f in glob.glob('envelope_exports_ml/*.csv')],
                    ignore_index=True)[['symbol', 'timestamp', 'alignedDirection']]
    oof = pd.read_csv('phase2_oof_crypto.csv')[['symbol', 'timestamp', 'p']]
    px = pd.concat([pd.read_csv(f, usecols=['timestamp', 'price', 'fearGreedIndex'], low_memory=False)
                    .assign(symbol=os.path.basename(f)[:-4])
                    for f in sorted(glob.glob('csv_exports_v14/*.csv'))],
                   ignore_index=True).sort_values(['symbol', 'timestamp'])
    px['own'] = px.groupby('symbol').price.transform(lambda s: s / s.shift(540) - 1.0)
    d = rows.merge(env, on=['symbol', 'timestamp']).merge(oof, on=['symbol', 'timestamp']) \
            .merge(px, on=['symbol', 'timestamp'])
    d = d[(d.fearGreedIndex > 0) & d.own.notna() & (d.alignedDirection == 'LONG')]
    d['mood'] = np.where(d.fearGreedIndex >= 55, 'greed', 'not-greed')
    d['dt'] = pd.to_datetime(d.timestamp, unit='s')
    return d.reset_index(drop=True)


def main():
    d = load()
    col = 'd0.0_LONG_oppR'
    print(f'{len(d):,} LONG-biased bars; effective n ~{len(d)//OVERLAP:,}\n')

    # 1 — monotonicity
    edges = [0, .30, .35, .40, .45, .50, .55, .60, 1.01]
    band, mean_r = [], []
    for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
        s = d[(d.p >= lo) & (d.p < hi)]
        if len(s) < 300: continue
        band.append(i); mean_r.append(s[col].mean())
    rho, pval = spearmanr(band, mean_r)
    c1 = rho < 0 and pval < 0.01
    print(f'1 MONOTONICITY   Spearman rho {rho:+.3f}  p {pval:.4f}   -> {"PASS" if c1 else "FAIL"}')

    # 2 — period consistency: no-floor vs current floor
    cur = d[d.p >= FLOOR]; nof = d
    periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')
    pos = tot = 0
    for i in range(len(periods) - 1):
        w = lambda x: x[(x.dt >= periods[i]) & (x.dt < periods[i + 1])]
        a, b = w(nof), w(cur)
        if len(a) < 500 or len(b) < 200: continue
        tot += 1; pos += a[col].mean() > b[col].mean()
    c2 = pos >= 6 and tot >= 9
    print(f'2 PERIODS        no-floor beats floor in {pos}/{tot}  (bar: >= 6 of 9)   '
          f'-> {"PASS" if c2 else "FAIL"}')
    if tot < 9:
        print(f'                 only {tot} periods available — the OOF window starts 2023-03, so')
        print(f'                 the criterion CANNOT be satisfied with this data. Not a near miss.')

    # 3 — both regimes
    print('3 BOTH REGIMES')
    signs = {}
    for mood in ('greed', 'not-greed'):
        s = d[d.mood == mood]
        lo_, hi_ = s[s.p < FLOOR][col].mean(), s[s.p >= FLOOR][col].mean()
        signs[mood] = lo_ - hi_
        b = moving_block_bootstrap((s[s.p < FLOOR][col]).to_numpy(float), OVERLAP)
        print(f'   {mood:>10}: below-floor {lo_:+.4f}  above-floor {hi_:+.4f}  '
              f'diff {lo_-hi_:+.4f}  n={len(s):,}')
    c3 = all(v > 0 for v in signs.values())
    print(f'                 sign holds in both -> {"PASS" if c3 else "FAIL"}')

    # 4 — power
    cells = [len(d[(d.mood == m) & (d.p < FLOOR)]) // OVERLAP for m in ('greed', 'not-greed')]
    c4 = all(c >= 500 for c in cells)
    print(f'4 POWER          effective n per cell {cells}  (bar: >= 500)   -> {"PASS" if c4 else "FAIL"}')

    print(f'\nVERDICT: {"SUPPORTED — ship" if all([c1,c2,c3,c4]) else "NOT SUPPORTED — do not ship"}')
    if not all([c1, c2, c3, c4]):
        print('Per the stopping rule, the LONG floor is left exactly as it is.')


if __name__ == '__main__':
    main()
