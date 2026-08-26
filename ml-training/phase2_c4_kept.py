#!/usr/bin/env python3
"""Phase 2, C4 — the gates that are CURRENTLY IN FORCE.

C3 asked whether the removals were right. C4 asks the opposite and more urgent question: are the
gates still standing earning their place? The cost of error here is an over-restrictive app, which is
the complaint that started this whole programme ("it tells me not to trade, trade long, trade short
at the same time" / "auto-FLAT for a week while BTC ran").

Conditions are READ from `envelope_exports/` (the real `buildUserPrompt` verdict), joined to payoffs
on (symbol, timestamp). ML comes from `phase2_oof.py` — walk-forward, production target, production
feature list, provenance recorded. Mean OOF AUC 0.6767 against production v14's 0.674.

RAW SCALE, deliberately. Production gates on a live-calibrated value, but the PAV layer refits from
forward data that does not exist for a historical bar, and calibrating on the same rows being scored
would be circular. Thresholds are swept on the raw scale; the mapping is C6's question, which is
where Part 11 put it.

UNTESTABLE AND SAID SO: `macro_*`, `news_thesis_conflict` and `data_stale` have no historical archive
to replay against. Under the Part 6 principle they guard exogenous events and never claimed
predictive power, so an EV null could not refute them anyway. They stay, untested, and this file does
not pretend otherwise.

Bar: lift >= +0.02R AND >= 6/9 periods AND coverage >= 20%.
"""
import glob, os
import numpy as np, pandas as pd
from phase2_c3_removed import evaluate, show, BAR_LIFT, BAR_PERIODS, BAR_COVERAGE

ML_THRESHOLDS = [0.40, 0.45, 0.50, 0.55, 0.60]


def load():
    rows = pd.read_pickle('level_entry_rows.pkl.gz')
    syms = sorted(set(rows.symbol) & {os.path.basename(p)[:-4] for p in glob.glob('envelope_exports/*.csv')})
    env = pd.concat([pd.read_csv(f'envelope_exports/{s}.csv') for s in syms], ignore_index=True)
    oof = pd.read_csv('phase2_oof_crypto.csv')[['symbol', 'timestamp', 'p']]
    d = rows.merge(env, on=['symbol', 'timestamp'], how='inner')
    return d.merge(oof, on=['symbol', 'timestamp'], how='inner').reset_index(drop=True)


def main():
    d = load()
    print(f'{len(d):,} rows, {d.symbol.nunique()} symbols, with OOF ML attached')
    q = d.p.quantile([.1, .25, .5, .75, .9]).round(3).to_dict()
    print(f'raw OOF ML distribution: {q}')
    print(f'base goodR rate: {d.goodR.mean():.3f}\n' if 'goodR' in d else '')

    for entry, tag in (('d0.0', 'MARKET entry'), ('d0.25', '0.25 ATR PULLBACK entry')):
        res = []
        for side in ('SHORT', 'LONG'):
            sub = d[d.alignedDirection == side].reset_index(drop=True)
            if len(sub) < 1000:
                continue
            col = f'{entry}_{side}_oppR'
            for t in ML_THRESHOLDS:
                res.append(evaluate(sub, f'ML < {t:.2f}', (sub.p < t).to_numpy(), col, side))
            res.append(evaluate(sub, 'crypto_bear_regime', sub.cryptoBearRegime.astype(bool).to_numpy(), col, side))
            res.append(evaluate(sub, 'oneH opposes (downgrade)', sub.oneHOpposes.astype(bool).to_numpy(), col, side))
            res.append(evaluate(sub, 'ANY_KILLED', sub.anyKilled.astype(bool).to_numpy(), col, side))
        show(res, f'{tag} — gate LIFT over trading every bar of that side')

    print(f'pre-declared bar: lift >= {BAR_LIFT:+.4f} AND periods >= {BAR_PERIODS}/9 '
          f'AND coverage >= {BAR_COVERAGE:.0%}')
    print('\nNOT TESTED, and not testable: macro_IMMINENT / macro_NEARBY / macro_UPCOMING,')
    print('news_thesis_conflict, data_stale. No historical economic-calendar or feed archive exists')
    print('to replay. Per the Part 6 principle they guard EXOGENOUS events and never claimed')
    print('predictive power, so an EV null could not refute them. They stay untested by design.')


if __name__ == '__main__':
    main()
