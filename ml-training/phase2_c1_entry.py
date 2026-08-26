#!/usr/bin/env python3
"""Phase 2, C1 — entry discipline, with the statistical treatment the plan requires.

C1 runs FIRST because its answer is already known from the corrected re-run, which makes it a free
oracle on the whole rebuilt stack: `_payoff` under `anchor='bar_close'`, `_report`'s intervals, and
the guards. If C1 does not reproduce -0.0125 / +0.0211, something in the stack moved and every later
part is unattributable.

It also settles the geometry every other part assumes: the app's real structure is a 2 ATR stop and a
2.5 ATR target, entered on a pullback, and that is what these arms measure.

THE BAR is the one Parts 1-9 used and is printed next to every computed value: lift >= +0.02R with
>= 6 of 9 half-year periods positive. It is stated here so it cannot be adjusted after the fact.
"""
import numpy as np, pandas as pd
from _payoff import overlap_eff_n
from _report import report, print_table, moving_block_bootstrap
import _guards as G

ROWS = 'level_entry_rows.pkl.gz'
DEPTHS = [0.25, 0.50, 1.00]
BAR_LIFT, BAR_PERIODS = 0.02, 6
OVERLAP = 72 // 4          # 72h hold at 4h spacing


def decompose(d):
    """Split the gain into ABSTENTION and SELECTION.

    An unfilled setup scores exactly 0, and when the market-entry baseline is NEGATIVE, scoring 0 is
    itself a gain. So a rule that fills less often looks better without entering anywhere better.
    This separates the two:

        gain = (1 - fill) x (0 - market)   ABSTENTION — the benefit of not trading
             + fill x (fillR - market)     SELECTION  — the benefit of trading at a better price
    """
    print('=== decomposition: is the gain a better ENTRY, or simply FEWER trades? ===')
    for side in ('SHORT', 'LONG'):
        m = d[f'd0.0_{side}_oppR'].mean()
        print(f'{side} — market baseline {m:+.4f}R')
        print(f'{"depth":>8}{"fill":>8}{"fillR":>10}{"gain":>10}{"abstention":>13}'
              f'{"selection":>12}{"sel share":>11}')
        for dep in DEPTHS:
            f = d[f'd{dep}_{side}_filled'].mean()
            fr = d[f'd{dep}_{side}_fillR'].mean()
            gain = d[f'd{dep}_{side}_oppR'].mean() - m
            abst, sel = (1 - f) * (0 - m), f * (fr - m)
            print(f'{dep:>8.2f}{f:>8.1%}{fr:>10.4f}{gain:>+10.4f}{abst:>+13.4f}{sel:>+12.4f}'
                  f'{(sel / gain if gain else float("nan")):>10.0%}')
        print()


def random_abstention_control(d, draws=200, seed=7):
    """Abstain at RANDOM on the same fraction of bars the rule misses.

    The decomposition says the gain is mostly abstention; this proves it operationally. If a coin
    flip that trades the same fraction of bars captures the benefit, then the rule's contribution is
    what it adds OVER that coin flip — not the headline number.
    """
    rng = np.random.default_rng(seed)
    print('=== control: random abstention at the same rate ===')
    print(f'{"side":>6}{"depth":>7}{"rule gain":>12}{"random gain":>14}{"rule - random":>15}'
          f'{"block 95% CI":>24}')
    for side in ('SHORT', 'LONG'):
        mk = d[f'd0.0_{side}_oppR'].to_numpy(float)
        m = mk.mean()
        for dep in DEPTHS:
            f = d[f'd{dep}_{side}_filled'].mean()
            gain = d[f'd{dep}_{side}_oppR'].mean() - m
            rg = float(np.mean([np.where(rng.random(len(mk)) < f, mk, 0.0).mean() - m
                                for _ in range(draws)]))
            diff = d[f'd{dep}_{side}_oppR'].to_numpy(float) - np.where(rng.random(len(mk)) < f, mk, 0.0)
            ci = moving_block_bootstrap(diff, OVERLAP, seed=3)
            print(f'{side:>6}{dep:>7.2f}{gain:>+12.4f}{rg:>+14.4f}{gain - rg:>+15.4f}'
                  f'{f"[{ci[0]:+.4f},{ci[1]:+.4f}]":>24}')
    print()


def main():
    d = pd.read_pickle(ROWS)
    print(f'{len(d):,} opportunities, {d.symbol.nunique()} symbols')
    print(f'independence: {G.check_independence(len(d), 72, 4)}\n')

    for side in ('SHORT', 'LONG'):
        base = f'd0.0_{side}_oppR'
        rows = [report(d, f'd{dep}_{side}_oppR', label=f'pullback {dep:.2f} ATR',
                       baseline_col=base, overlap=OVERLAP,
                       bar_lift=BAR_LIFT, bar_periods=BAR_PERIODS)
                for dep in DEPTHS]
        print_table(rows, f'{side} — gain over a MARKET entry, per opportunity, net of fees')
        m = d[base].mean()
        print(f'market-entry baseline: {m:+.4f}R  '
              f'(fill rates: ' + ', '.join(f'{dep:.2f}->{d[f"d{dep}_{side}_filled"].mean():.0%}'
                                           for dep in DEPTHS) + ')\n')

    decompose(d)
    random_abstention_control(d)

    print('ORACLE CHECK — the corrected re-run this stack must reproduce:')
    for side, want in (('SHORT', -0.0125), ('LONG', +0.0211)):
        got = d[f'd0.25_{side}_oppR'].mean() - d[f'd0.0_{side}_oppR'].mean()
        ok = abs(got - want) < 1e-4
        print(f'  {side}: expected {want:+.4f}  got {got:+.4f}  {"OK" if ok else "*** DRIFT ***"}')


if __name__ == '__main__':
    main()
