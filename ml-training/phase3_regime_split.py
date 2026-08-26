#!/usr/bin/env python3
"""Is the LONG inversion a MECHANISM or the BEAR MARKET? (2026-08-26)

Phase 2 found the ML floor lifts SHORT and inverts LONG, four times over, and every arm sat in one
window — so mechanism and regime could not be separated. That deferral was too quick: the OOF window
(2023-03 .. 2026-06) is NOT uniformly bearish. BTC ran +49% in 2023 and +112% in 2024 before falling
-7% in 2025 and -28% in 2026. There is real regime variation to condition on.

PRE-DECLARED, before any number below was computed:

  REGIME is BTC's trailing 90-day return at the bar. Causal — it uses only closed history, so
  conditioning on it introduces no lookahead. RISING > +10%, FALLING < -10%, else NEUTRAL.

  IF THE INVERSION IS REGIME: the LONG gate lift should be >= 0 in RISING periods. The mechanism
  would be that `goodR` is direction-agnostic, so "big move likely" resolves UP in a rising market
  and DOWN in a falling one — which would also predict the SHORT lift to WEAKEN or invert in RISING.

  IF THE INVERSION IS MECHANISM: LONG stays negative in both regimes, and the two sides do not swap.

  WHAT WOULD BE AMBIGUOUS: LONG improving but staying negative, or the rising sample being too thin
  to separate. Both are reported as ambiguous rather than argued into a verdict.

This is one measurement on a split of already-thin data. It is not a licence to change a gate.
"""
import glob, os, sqlite3
import numpy as np, pandas as pd
from _report import moving_block_bootstrap
from phase2_c3_removed import evaluate

DB = '../marketscope-worker/marketscope.db'
ENV_DIR = 'envelope_exports_ml'
ML_GRID = [0.45, 0.50, 0.55]
TRAIL_D = 90
UP, DOWN = 0.10, -0.10


def btc_regime():
    con = sqlite3.connect(DB)
    b = pd.read_sql("SELECT timestamp/1000 AS ts, close FROM candles "
                    "WHERE symbol='BTCUSDT' AND interval='1d' ORDER BY timestamp", con)
    b['trail'] = b.close / b.close.shift(TRAIL_D) - 1.0      # causal: past 90 days only
    return b.dropna(subset=['trail'])[['ts', 'trail']]


def load():
    rows = pd.read_pickle('level_entry_rows.pkl.gz')
    syms = sorted(set(rows.symbol) & {os.path.basename(p)[:-4] for p in glob.glob(f'{ENV_DIR}/*.csv')})
    env = pd.concat([pd.read_csv(f'{ENV_DIR}/{s}.csv') for s in syms], ignore_index=True)
    oof = pd.read_csv('phase2_oof_crypto.csv')[['symbol', 'timestamp', 'p']]
    d = rows.merge(env, on=['symbol', 'timestamp'], how='inner').merge(
        oof, on=['symbol', 'timestamp'], how='inner').reset_index(drop=True)
    r = btc_regime()
    d['btc_trail'] = np.interp(d.timestamp, r.ts, r.trail, left=np.nan, right=np.nan)
    d['regime'] = np.where(d.btc_trail > UP, 'RISING',
                  np.where(d.btc_trail < DOWN, 'FALLING', 'NEUTRAL'))
    return d.dropna(subset=['btc_trail']).reset_index(drop=True)


def main():
    d = load()
    print(f'{len(d):,} rows with a causal BTC 90d trailing return attached')
    print('regime mix:', d.regime.value_counts(normalize=True).round(3).to_dict(), '\n')

    for entry in ('d0.0', 'd0.25'):
        print(f'=== {entry} — ML gate lift, by regime and side ===')
        print(f'{"regime":>9}{"side":>7}{"gate":>12}{"n":>9}{"blocked R":>11}{"kept R":>9}'
              f'{"lift":>9}{"block 95% CI":>22}')
        for regime in ('RISING', 'NEUTRAL', 'FALLING'):
            for side in ('SHORT', 'LONG'):
                sub = d[(d.regime == regime) & (d.alignedDirection == side)].reset_index(drop=True)
                if len(sub) < 2000:
                    print(f'{regime:>9}{side:>7}{"—":>12}{len(sub):>9,}  too thin to split')
                    continue
                col = f'{entry}_{side}_oppR'
                for t in ML_GRID:
                    r = evaluate(sub, f'ML<{t}', (sub.p < t).to_numpy(), col, side)
                    if not r or 'skip' in r:
                        continue
                    ci = f'[{r["block_ci"][0]:+.4f},{r["block_ci"][1]:+.4f}]'
                    print(f'{regime:>9}{side:>7}{f"ML >= {t:.2f}":>12}{len(sub):>9,}'
                          f'{r["blocked"]:>+11.4f}{r["kept"]:>+9.4f}{r["lift"]:>+9.4f}{ci:>22}')
        print()

    print('PRE-DECLARED READ:')
    print('  regime  -> LONG lift >= 0 in RISING, and SHORT weakens or inverts there too')
    print('  mechanism -> LONG stays negative in BOTH regimes and the sides do not swap')
    print('  ambiguous -> LONG improves but stays negative, or RISING is too thin')


if __name__ == '__main__':
    main()
