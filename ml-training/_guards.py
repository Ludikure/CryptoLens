#!/usr/bin/env python3
"""Cheap assertions that would each have caught a confirmed defect in this project.

Every one of these is a response to something that actually shipped. They are cheap enough to run on
every condition dict in every study, and the argument for doing so is that all five measurement
defects the 2026-08-25 reviews found were the kind a two-line check catches — none needed a
simulation to expose.

    check_fire_rates      `continuation < 2` fired on 97.4% of stock bars and shipped. The plan's
                          first draft set the ceiling at 99%, which would have MISSED it.
    check_no_duplicates   `funding_supports_counter` and its reconstruction were the exact logical
                          complement; two conditions being identical or complementary is always a
                          modelling error, never a finding.
    check_value_domain    `cont = |momentumAlignment| < 2` where the variable ranges {-1, 0, 1}.
                          Printing the attainable range next to the threshold needs no simulation.
    check_independence    a 72h hold at 4h spacing means ~18 rows share an outcome, so "9/9 periods"
                          over rows overstates the evidence. Four near-misses in this project.
"""
from __future__ import annotations
import numpy as np
import pandas as pd


class GuardError(AssertionError):
    """A guard failed. These are errors, not warnings: a study that trips one is not reportable."""


def check_fire_rates(conds: dict[str, np.ndarray], *, lo: float = 0.01, hi: float = 0.95) -> pd.DataFrame:
    """ERROR when a condition fires on almost none or almost all of the population.

    The bounds are deliberately tighter than they look like they need to be. `continuation < 2` fires
    on 97.4% of stock bars — a rule that is nearly universal is not a filter, it is a constant with
    extra steps, and its "lift" is measuring the 2.6% remainder. A 99% ceiling would have passed it.
    """
    rows, bad = [], []
    for name, m in conds.items():
        m = np.asarray(m, bool)
        rate = float(m.mean())
        rows.append({'condition': name, 'fires': rate, 'n_true': int(m.sum()), 'n': len(m)})
        if rate < lo or rate > hi:
            bad.append(f'{name}: fires on {rate:.4%} (allowed {lo:.0%}-{hi:.0%})')
    if bad:
        raise GuardError('condition fire rates outside the usable band:\n  ' + '\n  '.join(bad))
    return pd.DataFrame(rows)


def check_no_duplicates(conds: dict[str, np.ndarray], *, tol: float = 1e-9,
                        min_fire: float = 0.02) -> None:
    """ERROR when two conditions are identical, exact complements, or DISJOINT.

    Two supposedly distinct rules that agree on every row are one rule. Two that disagree on every
    row are one rule and its negation.

    The third case is the one that matters here and it was missing from the first version of this
    guard, which passed on the real data it was written for. `funding_supports_counter` and its
    reconstruction are `sign(f) == sign(bias)` and `sign(f) == -sign(bias)`: they are NOT
    complements, because both are false wherever funding or bias is zero. They are DISJOINT — each
    fires on ~1/3 of bars and they never co-occur, Jaccard 0.0000. Two conditions that both fire
    substantially and never together are one condition and its sign flip, restricted to a domain.

    `min_fire` keeps the disjoint test off genuinely rare conditions, where an empty intersection is
    ordinary rather than structural.
    """
    names = list(conds)
    problems = []
    for i in range(len(names)):
        a = np.asarray(conds[names[i]], bool)
        for j in range(i + 1, len(names)):
            b = np.asarray(conds[names[j]], bool)
            if len(a) != len(b):
                problems.append(f'{names[i]} and {names[j]} have different lengths')
                continue
            same = float((a == b).mean())
            if same > 1 - tol:
                problems.append(f'{names[i]} and {names[j]} are IDENTICAL')
            elif same < tol:
                problems.append(f'{names[i]} and {names[j]} are EXACT COMPLEMENTS '
                                f'— one of them is the other with its sign flipped')
            elif a.mean() >= min_fire and b.mean() >= min_fire and not (a & b).any():
                problems.append(
                    f'{names[i]} ({a.mean():.1%}) and {names[j]} ({b.mean():.1%}) are DISJOINT '
                    f'— they never co-occur, so one is the other with its sign flipped, '
                    f'restricted to a domain')
    if problems:
        raise GuardError('degenerate condition pairs:\n  ' + '\n  '.join(problems))


def check_value_domain(name: str, values: np.ndarray, threshold: float, *,
                       op: str = '<') -> dict:
    """ERROR when a threshold sits outside the attainable range of the variable it compares.

    `cont < 2` and `cont < 3` against a variable taking values in {-1, 0, 1}: both are constants.
    This needs no simulation to detect and no data beyond the column itself.
    """
    v = np.asarray(values, float)
    v = v[np.isfinite(v)]
    if not len(v):
        raise GuardError(f'{name}: no finite values')
    lo, hi = float(v.min()), float(v.max())
    uniq = np.unique(v)
    rate = float((v < threshold).mean() if op == '<' else (v > threshold).mean())
    if (op == '<' and threshold > hi) or (op == '>' and threshold < lo):
        raise GuardError(
            f'{name}: threshold {op} {threshold} is outside the attainable range [{lo}, {hi}] '
            f'— the condition is a CONSTANT (fires on {rate:.2%}), not a filter. '
            f'{"Observed values: " + str(uniq[:10].tolist()) if len(uniq) <= 10 else ""}')
    if rate in (0.0, 1.0):
        raise GuardError(f'{name}: threshold {op} {threshold} fires on exactly {rate:.0%} of rows '
                         f'over the attainable range [{lo}, {hi}]')
    return {'name': name, 'min': lo, 'max': hi, 'n_unique': int(len(uniq)),
            'threshold': threshold, 'fires': rate}


def check_independence(n_rows: int, hold_h: int, bar_hours: int, *, min_eff: int = 200) -> dict:
    """Report the effective sample size, and ERROR when it is too small to support a claim.

    Rows are not observations when consecutive ones resolve against overlapping price paths. Every
    "9/9 periods" claim in this vault was computed over rows.
    """
    overlap = max(1, hold_h // max(1, bar_hours))
    eff = n_rows // overlap
    if eff < min_eff:
        raise GuardError(f'effective n is {eff} ({n_rows:,} rows / {overlap}x overlap) — '
                         f'below the {min_eff} floor; this population cannot support a claim')
    return {'rows': n_rows, 'overlap': overlap, 'effective_n': eff}
