#!/usr/bin/env python3
"""THE TEST pre-declared in docs/research/stop-target-joint.md (e286e31). All four criteria required."""
import glob, os, sys
import numpy as np, pandas as pd
from _payoff import simulate, PayoffParams, align_arms
from _report import period_consistency

FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
STOPS = {'LONG': [2.0, 3.0, 4.0, 5.0], 'SHORT': [1.0, 2.0, 3.0]}
RRS = [0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0]
SHIPPED = {'LONG': (4.0, 1.5), 'SHORT': (2.0, 1.5)}   # analysis path: floor x crypto idealTP2RR

env = pd.concat([pd.read_csv(f) for f in glob.glob('envelope_exports_ml/*.csv')],
                ignore_index=True)[['symbol', 'timestamp', 'alignedDirection']]

CACHE = 'stj_cache'
os.makedirs(CACHE, exist_ok=True)
BUDGET_S = float(os.environ.get('BUDGET_S', '1e9'))
import time; T0 = time.time()


def build(fee):
    """Per-symbol results are cached, so a killed run resumes instead of restarting.

    The first attempt ran unattended, was reaped after 4 of 24 symbols with no traceback, and had
    written nothing. At ~2 minutes a symbol, "all or nothing" is the wrong failure mode.
    """
    tag = f'{fee:g}'.replace('.', 'p')
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    # ONE SYMBOL PER PROCESS. Freeing the 98 per-symbol frames inside the loop was not enough —
    # three attempts died with exit 137 at symbol 5 within seven seconds, so the growth is inside
    # the interpreter rather than in anything a `del` reaches. A process boundary returns the memory
    # to the OS unconditionally, and the disk cache makes the loop restartable anyway.
    only = os.environ.get('ONLY')
    if only: syms = [x for x in syms if x == only]
    pending = False
    for i, s in enumerate(syms, 1):
        cf = f'{CACHE}/{s}_{tag}.pkl'
        if os.path.exists(cf):
            continue                      # NOTHING is held in memory during the build; see below
        if time.time() - T0 > BUDGET_S:
            pending = True; break
        f = pd.read_csv(f'{FEAT}/{s}.csv', low_memory=False)
        p = pd.read_csv(f'{PATH}/{s}.csv').sort_values('ts').reset_index(drop=True)
        arms, ok = {}, True
        for side in ('LONG', 'SHORT'):
            for st in STOPS[side]:
                for rr in RRS:
                    for mode, tag in (('market', 'mkt'), ('pullback', 'pb')):
                        o, _ = simulate(f, p, symbol=s, depth_atr=0.0 if mode == 'market' else 0.25,
                                        side=side, anchor='bar_close', entry_mode=mode,
                                        params=PayoffParams(wait_h=12, hold_h=72, stop_atr=st,
                                                            tp_atr=st * rr, fee_pct=fee, bar_hours=4))
                        if not len(o): ok = False; break
                        arms[f'{side}_{st}_{rr}_{tag}'] = o[['symbol', 'timestamp', 'oppR']]
                    if not ok: break
                if not ok: break
            if not ok: break
        if ok:
            j, _ = align_arms(arms)
            # float32 halves the frame and costs nothing: these are means over ~11k rows, not a
            # 1e-7 parity assertion.
            for c in j.columns:
                if j[c].dtype == 'float64': j[c] = j[c].astype('float32')
            j.to_pickle(cf)
        else:
            pd.DataFrame().to_pickle(cf)
        del arms, f, p
        print(f'  {i}/{len(syms)} {s}{"" if ok else " SKIPPED"} [{time.time()-T0:.0f}s]',
              file=sys.stderr)
    done = len(glob.glob(f'{CACHE}/*_{tag}.pkl'))
    print(f'  cached {done}/{len(syms)}', file=sys.stderr)
    if pending or done < len(syms):
        return None
    # The concat happens ONCE, here, after every symbol is on disk. Accumulating these 98-column
    # frames DURING the build is what got the first three attempts SIGKILLed at symbol 5 — exit 137,
    # no traceback, which reads exactly like a mysterious hang until you check the exit code.
    frames = [pd.read_pickle(f'{CACHE}/{s}_{tag}.pkl') for s in syms]
    return pd.concat([d for d in frames if len(d)], ignore_index=True) \
             .merge(env, on=['symbol', 'timestamp'])

# NET ONLY. The gross series is a CONFIRMATION criterion — "the gross series moves the same way" —
# and it is only ever read for two cells per side (shipped vs candidate), so computing the whole
# grid twice doubled a two-hour job to establish four numbers. `stop_target_gross.py` does those
# cells once the candidate is known. The pre-declared bar is unchanged; only the execution is.
print('building net...', file=sys.stderr)
net = build(0.171)
if net is None:
    print('\nincomplete — rerun to continue', file=sys.stderr); sys.exit(0)
net.to_pickle('stop_target_net.pkl')

for side in ('LONG', 'SHORT'):
    S = net[net.alignedDirection == side]
    eff = len(S) // 18
    print(f'\n{"="*78}\n{side}: {len(S):,} bars, effective n ~{eff:,}\n{"="*78}')
    print(f'{"stop":>6}' + ''.join(f'{f"R:R {r}":>11}' for r in RRS))
    for st in STOPS[side]:
        print(f'{st:>5.1f}A' + ''.join(f'{S[f"{side}_{st}_{r}_mkt|oppR"].mean():>+11.4f}' for r in RRS))
    print(f'\n  pullback entry:')
    for st in STOPS[side]:
        print(f'{st:>5.1f}A' + ''.join(f'{S[f"{side}_{st}_{r}_pb|oppR"].mean():>+11.4f}' for r in RRS))
    sh = SHIPPED[side]
    base = S[f'{side}_{sh[0]}_{sh[1]}_mkt|oppR'].mean()
    print(f'\n  shipped is {sh[0]:g} ATR @ {sh[1]:g}R -> {base:+.4f} net (market).'
          f'  Best cell in grid:')
    cells = [(st, r, S[f'{side}_{st}_{r}_mkt|oppR'].mean()) for st in STOPS[side] for r in RRS]
    for st, r, v in sorted(cells, key=lambda c: -c[2])[:3]:
        print(f'    {st:g} ATR @ {r:g}R  {v:+.4f}   (vs shipped {v - base:+.4f})')
