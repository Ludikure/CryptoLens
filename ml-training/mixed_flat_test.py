#!/usr/bin/env python3
"""Does the biases_MIXED auto-FLAT earn its place? (2026-07-06)

Context: the Conviction Envelope auto-FLATs when daily/4H biases are MIXED
("wait for alignment") AND auto-FLATs the mature aligned chase (2026-07-02
symmetry fix). The user observes the combination means near-constant FLAT, and
the rationale is circular: by the time TFs align, the move is exhausted. The
prompt's own Counter-Trend Reversal playbook (ML>=70 -> MODERATE cap) is
unreachable because the MIXED auto-FLAT fires first — an internal
contradiction. The old 73-86% counter-trend goodR numbers were also measured
on LEAK-ERA data and need clean re-validation.

PRE-DECLARED question: per biasAlignment state (aligned / conflict / neutral),
on the clean v14 CSVs, what is
  (1) the share of bars (how often each envelope path fires),
  (2) the goodR rate (fwdMaxFavR >= 1.5, the direction-agnostic vol edge),
  (3) the directional coin-flip check P(fwdReturn24H > 0) and the ATR-
      normalized EV of following the DAILY bias (aligned states only),
  (4) goodR by trend age (barsSinceRegimeChange <=10 / 11-30 / >30).

PRE-DECLARED decision rule: if conflict-state goodR >= aligned-state goodR
minus 2pp, the MIXED auto-FLAT is not defensible as an EV gate (it suppresses
a state at least as tradeable by the only edge we have) -> downgrade it to a
conviction cap that the existing counter-trend playbook can actually use.
If conflict goodR is materially lower, the block stays.
"""
import csv
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))

def load(dirname):
    rows = []
    d = os.path.join(HERE, dirname)
    for fn in sorted(os.listdir(d)):
        if not fn.endswith('.csv'):
            continue
        with open(os.path.join(d, fn)) as f:
            for r in csv.DictReader(f):
                try:
                    rows.append({
                        'align': r['biasAlignment'],
                        'age': float(r['barsSinceRegimeChange']),
                        'goodR': float(r['fwdMaxFavR']) >= 1.5,
                        'fwd24': float(r['fwdReturn24H']),
                        'atrPct': float(r['atrPercent']),  # 4H ATR as % of price
                    })
                except (KeyError, ValueError):
                    continue
    return rows

def pct(x, n):
    return f'{100*x/n:5.1f}%' if n else '    —'

def report(market, dirname):
    rows = load(dirname)
    n = len(rows)
    print(f'\n===== {market}: {n:,} bars =====')
    print(f'{"state":<18}{"share":>8}{"goodR":>8}{"P(up24)":>9}{"EV_daily_dir(ATR)":>19}{"n":>9}')
    states = ['aligned_bullish', 'aligned_bearish', 'conflict', 'neutral']
    for s in states:
        sub = [r for r in rows if r['align'] == s]
        m = len(sub)
        if not m:
            continue
        gr = sum(r['goodR'] for r in sub)
        up = sum(r['fwd24'] > 0 for r in sub)
        # EV of following the daily bias direction, in ATR units (aligned states
        # have a defined direction; conflict/neutral don't — leave blank).
        ev = ''
        if s == 'aligned_bullish':
            ev = f"{sum(r['fwd24']/r['atrPct'] for r in sub if r['atrPct'] > 0)/m:+.3f}"
        elif s == 'aligned_bearish':
            ev = f"{sum(-r['fwd24']/r['atrPct'] for r in sub if r['atrPct'] > 0)/m:+.3f}"
        print(f'{s:<18}{pct(m, n):>8}{pct(gr, m):>8}{pct(up, m):>9}{ev:>19}{m:>9,}')

    print(f'\n  goodR by trend age within state:')
    print(f'  {"state":<18}{"age<=10":>10}{"11-30":>10}{">30":>10}')
    for s in states:
        cells = []
        for lo, hi in ((0, 10), (11, 30), (31, 1e9)):
            sub = [r for r in rows if r['align'] == s and lo <= r['age'] <= hi]
            cells.append(pct(sum(r['goodR'] for r in sub), len(sub)) + f' ({len(sub):,})')
        print(f'  {s:<18}{cells[0]:>16}{cells[1]:>16}{cells[2]:>16}')

report('CRYPTO', 'csv_exports_v14')
report('STOCKS', 'csv_exports_v14_stocks')
