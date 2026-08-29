#!/usr/bin/env python3
"""Phase 2, C2 — the earnings gates, tested on their OWN stated mechanism.

The three earnings conditions are the only ones in the envelope whose code states a MECHANISM rather
than a payoff claim: "gap risk, the stop will not hold". By the Part 6 principle an EV null cannot
refute an exogenous-event guard, so the test has to be the variance claim itself — does an overnight
gap large enough to jump a 2 ATR stop actually become more likely near a report?

That statistic is independent of the entry simulation, so it is one of the few Part 8 results the
anchor retraction did not touch. It is re-run here anyway, on `maxGapATR` recomputed by the migrated
`stock_rows.py` at `anchor='bar_close'`.

PRE-DECLARED BAR (Part 8, unchanged): ratio >= 1.5x the away-from-earnings baseline, with the
majority of half-year periods positive. Printed beside every computed value.

The BASELINE is bars more than 14 days from any report — not all bars. Comparing a window against
an all-bars average would dilute the baseline with the very windows being tested.
"""
import json
import numpy as np, pandas as pd
from _report import cluster_bootstrap

ROWS = 'stock_rows.pkl.gz'
EARNINGS = '../marketscope-worker/src/earnings_history.json'
GAP_ATR = 2.0            # a gap this size jumps clean over the app's 2 ATR stop
BAR_RATIO = 1.5
WINDOWS = [('0-2d', 0, 2), ('3-7d', 3, 7), ('8-14d', 8, 14)]


def days_to_earnings(d: pd.DataFrame) -> np.ndarray:
    """Calendar days from each bar to the NEXT earnings report for that symbol; inf when none."""
    ev = {k: np.sort(np.array([np.datetime64(x) for x in v], dtype='datetime64[D]'))
          for k, v in json.load(open(EARNINGS)).items()}
    out = np.full(len(d), np.inf)
    bar_day = pd.to_datetime(d.timestamp, unit='s').dt.floor('D').to_numpy().astype('datetime64[D]')
    for sym, g in d.groupby('symbol', sort=False):
        dates = ev.get(sym)
        if dates is None or not len(dates):
            continue
        i = g.index.to_numpy()
        pos = np.searchsorted(dates, bar_day[i], side='left')
        ok = pos < len(dates)
        delta = np.full(len(i), np.inf)
        delta[ok] = (dates[pos[ok]] - bar_day[i][ok]).astype(int)
        out[i] = delta
    return out


def main():
    d = pd.read_pickle(ROWS).reset_index(drop=True)
    d['days'] = days_to_earnings(d)
    d['gapped'] = (d.maxGapATR >= GAP_ATR).astype(float)
    d['dt'] = pd.to_datetime(d.timestamp, unit='s')

    known = np.isfinite(d.days)
    base_mask = known & (d.days > 14)
    base = d.loc[base_mask, 'gapped'].mean()
    print(f'{len(d):,} stock bars, {d.symbol.nunique()} symbols; '
          f'{known.mean():.1%} have a known next report')
    print(f'baseline P(overnight gap >= {GAP_ATR:g} ATR inside the hold window), '
          f'bars >14d from any report: {base:.4f}\n')

    periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')
    print(f'{"window":>8}{"bars":>10}{"P(gap)":>10}{"ratio":>9}{"cluster 95% CI of ratio":>27}'
          f'{"periods":>10}{"verdict":>10}')
    for name, lo, hi in WINDOWS:
        m = known & (d.days >= lo) & (d.days <= hi)
        p = d.loc[m, 'gapped'].mean()
        ratio = p / base
        ci = cluster_bootstrap(d[m], 'gapped')
        ci_r = (ci[0] / base, ci[1] / base)
        pos = tot = 0
        for i in range(len(periods) - 1):
            w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
            a, b = d.loc[w & m, 'gapped'].mean(), d.loc[w & base_mask, 'gapped'].mean()
            if np.isfinite(a) and np.isfinite(b) and (w & m).sum() >= 200:
                tot += 1
                pos += (a / b) >= BAR_RATIO
        ok = ratio >= BAR_RATIO and pos >= (tot + 1) // 2
        print(f'{name:>8}{int(m.sum()):>10,}{p:>10.4f}{ratio:>8.2f}x'
              f'{f"[{ci_r[0]:.2f}x, {ci_r[1]:.2f}x]":>27}{f"{pos}/{tot}":>10}'
              f'{"PASSES" if ok else "fails":>10}')
    print(f'\npre-declared bar: ratio >= {BAR_RATIO}x baseline AND a majority of periods clearing it')

    # CONTROL: is the effect an ATR-normalisation artifact? Implied vol runs up into a report, and a
    # higher ATR would DEFLATE gap/ATR — so if the windows showed elevated ATR, the ratios would be
    # understated, not manufactured. Measured: ATR is FLAT (baseline 2.070 vs 1.94-2.00 inside the
    # windows), and the effect survives on a gap measured as a fraction of PRICE.
    d['gap_pct'] = d.maxGapATR * d.f_atrPercent / 100.0
    b_pct = d.loc[base_mask, 'gap_pct'].ge(0.02).mean()
    print('\ncontrol — the same test with an ATR-FREE threshold (gap >= 2% of price):')
    print(f'{"window":>8}{"mean atrPct":>13}{"P(gap>=2% px)":>16}{"ratio":>9}')
    print(f'{">14d base":>8}{d.loc[base_mask, "f_atrPercent"].mean():>13.3f}{b_pct:>16.4f}{1.0:>8.2f}x')
    for name, lo, hi in WINDOWS:
        m = known & (d.days >= lo) & (d.days <= hi)
        pp = d.loc[m, 'gap_pct'].ge(0.02).mean()
        print(f'{name:>8}{d.loc[m, "f_atrPercent"].mean():>13.3f}{pp:>16.4f}{pp / b_pct:>8.2f}x')
    print('\nThe ATR-free ratios are smaller because a 2%-of-price gap is far commoner than a 2 ATR')
    print('one (36.7% baseline vs 8.05%), which compresses every ratio toward 1. The ATR-normalised')
    print('figure is the operative one: the gate\'s claim is about a stop placed at 2 ATR.')


if __name__ == '__main__':
    main()
