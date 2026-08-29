#!/usr/bin/env python3
"""Standard statistical treatment for every Phase 2 number.

The plan requires each headline figure to carry: effective n, an interval that accounts for
dependence, the PRE-DECLARED bar printed next to the computed value, and provenance. This module is
the single implementation of that, for the same reason `_payoff.py` is the single simulator — twelve
private copies is how five defects reached production independently.

WHY THE INTERVALS ARE NOT ORDINARY ONES. Two dependence structures overlap here and both inflate a
naive interval's implied precision:

  HORIZON OVERLAP   a 72h hold sampled every 4h means ~18 consecutive rows resolve against
                    overlapping price paths. Rows are not observations.
  SYMBOL CLUSTERING crypto symbols are heavily correlated — a BTC drawdown is in every alt's rows at
                    once. 24 symbols do not give 24 independent draws.

A moving-block bootstrap handles the first; a symbol-cluster bootstrap handles the second. Both are
reported because they answer different questions, and the WIDER one is the honest headline.

Dependent observations have nearly produced a finding in this project four separate times.
"""
from __future__ import annotations
import numpy as np
import pandas as pd


def moving_block_bootstrap(x: np.ndarray, block: int, n_boot: int = 2000,
                           seed: int = 0) -> tuple[float, float]:
    """95% CI for the mean, resampling contiguous BLOCKS to preserve autocorrelation.

    `block` should be at least the overlap factor (hold_h // bar_hours) so a resampled block carries
    a whole dependent run rather than slicing through one.
    """
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    n = len(x)
    if n < block * 2:
        return (float('nan'), float('nan'))
    rng = np.random.default_rng(seed)
    n_blocks = int(np.ceil(n / block))
    starts = rng.integers(0, n - block + 1, size=(n_boot, n_blocks))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(n_boot, -1)[:, :n]
    means = x[idx].mean(axis=1)
    return (float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))


def cluster_bootstrap(df: pd.DataFrame, col: str, by: str = 'symbol',
                      n_boot: int = 2000, seed: int = 0) -> tuple[float, float]:
    """95% CI for the mean, resampling whole SYMBOLS with replacement.

    The relevant question for a cross-sectional claim: would this hold on a different draw of
    symbols? Crypto's answer is usually "much less precisely than the row count suggests", because
    the symbols are one correlated bet counted many times.
    """
    groups = [g[col].to_numpy(float) for _, g in df.groupby(by, sort=False)]
    groups = [g[np.isfinite(g)] for g in groups]
    groups = [g for g in groups if len(g)]
    if len(groups) < 3:
        return (float('nan'), float('nan'))
    rng = np.random.default_rng(seed)
    k = len(groups)
    means = np.empty(n_boot)
    for b in range(n_boot):
        pick = rng.integers(0, k, size=k)
        means[b] = np.concatenate([groups[i] for i in pick]).mean()
    return (float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))


def period_consistency(df: pd.DataFrame, col: str, baseline_col: str | None = None,
                       start: str = '2022-01-01', end: str = '2026-07-01',
                       freq: str = '6MS', min_rows: int = 2000) -> tuple[int, int]:
    """Half-year periods in which `col` beats `baseline_col` (or zero). Returns (positive, total)."""
    d = df.copy()
    d['_dt'] = pd.to_datetime(d.timestamp, unit='s')
    periods = pd.date_range(start, end, freq=freq)
    pos = tot = 0
    for i in range(len(periods) - 1):
        w = (d._dt >= periods[i]) & (d._dt < periods[i + 1])
        if w.sum() < min_rows:
            continue
        v = d.loc[w, col].mean()
        b = d.loc[w, baseline_col].mean() if baseline_col else 0.0
        if np.isfinite(v) and np.isfinite(b):
            tot += 1
            pos += (v - b) >= 0
    return pos, tot


def report(df: pd.DataFrame, col: str, *, label: str, baseline_col: str | None = None,
           overlap: int = 18, bar_lift: float | None = None, bar_periods: int | None = None,
           seed: int = 0) -> dict:
    """One arm, fully dressed: mean, both intervals, effective n, period count, and the bar."""
    v = df[col].to_numpy(float)
    b = df[baseline_col].to_numpy(float) if baseline_col else np.zeros(len(v))
    delta = v - b
    mean = float(np.nanmean(delta))
    mb = moving_block_bootstrap(delta, overlap, seed=seed)
    cb = cluster_bootstrap(df.assign(_delta=delta), '_delta', seed=seed)
    pos, tot = period_consistency(df, col, baseline_col)
    passes = None
    if bar_lift is not None and bar_periods is not None:
        passes = (mean >= bar_lift) and (pos >= bar_periods)
    return {'label': label, 'mean': mean, 'rows': len(v), 'eff_n': len(v) // max(1, overlap),
            'block_ci': mb, 'cluster_ci': cb, 'periods': f'{pos}/{tot}',
            'bar': None if bar_lift is None else f'mean >= {bar_lift:+.4f} AND periods >= {bar_periods}',
            'passes': passes}


def print_table(rows: list[dict], title: str) -> None:
    print(f'=== {title} ===')
    print(f'{"arm":>28}{"mean":>10}{"block 95% CI":>22}{"cluster 95% CI":>24}'
          f'{"eff n":>9}{"periods":>9}{"verdict":>9}')
    for r in rows:
        mb = f'[{r["block_ci"][0]:+.4f},{r["block_ci"][1]:+.4f}]'
        cb = f'[{r["cluster_ci"][0]:+.4f},{r["cluster_ci"][1]:+.4f}]'
        v = '' if r['passes'] is None else ('PASSES' if r['passes'] else 'fails')
        print(f'{r["label"]:>28}{r["mean"]:>+10.4f}{mb:>22}{cb:>24}'
              f'{r["eff_n"]:>9,}{r["periods"]:>9}{v:>9}')
    if rows and rows[0]['bar']:
        print(f'\npre-declared bar: {rows[0]["bar"]}')
