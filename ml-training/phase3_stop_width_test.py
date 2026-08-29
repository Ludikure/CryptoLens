#!/usr/bin/env python3
"""THE TEST pre-declared in docs/research/stop-width.md (f144f07). All five criteria required."""
import glob, os
import numpy as np, pandas as pd
from scipy.stats import spearmanr
from _payoff import simulate, PayoffParams, align_arms
from _report import moving_block_bootstrap, period_consistency

FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
STOPS, RR = [2.0, 3.0, 4.0], 1.25
env = pd.concat([pd.read_csv(f) for f in glob.glob('envelope_exports_ml/*.csv')],
                ignore_index=True)[['symbol', 'timestamp', 'alignedDirection']]


def build(fee):
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    fr = []
    for s in syms:
        f = pd.read_csv(f'{FEAT}/{s}.csv', low_memory=False)
        p = pd.read_csv(f'{PATH}/{s}.csv').sort_values('ts').reset_index(drop=True)
        arms, ok = {}, True
        for st in STOPS:
            for side in ('LONG', 'SHORT'):
                for mode, tag in (('market', 'mkt'), ('pullback', 'pb')):
                    o, _ = simulate(f, p, symbol=s, depth_atr=0.0 if mode == 'market' else 0.25,
                                    side=side, anchor='bar_close', entry_mode=mode,
                                    params=PayoffParams(wait_h=12, hold_h=72, stop_atr=st,
                                                        tp_atr=st * RR, fee_pct=fee, bar_hours=4))
                    if not len(o): ok = False; break
                    arms[f's{st}_{side}_{tag}'] = o[['symbol', 'timestamp', 'oppR']]
                if not ok: break
            if not ok: break
        if ok:
            j, _ = align_arms(arms); fr.append(j)
    return pd.concat(fr, ignore_index=True).merge(env, on=['symbol', 'timestamp'])


net, gross = build(0.171), build(0.0)
L = net[net.alignedDirection == 'LONG']
print(f'{len(L):,} LONG bars, effective n ~{len(L)//18:,}\n')
print(f'{"stop":>7}{"net mkt":>11}{"net pb":>10}{"gross mkt":>12}')
Lg = gross[gross.alignedDirection == 'LONG']
for st in STOPS:
    print(f'{st:>6.1f}A{L[f"s{st}_LONG_mkt|oppR"].mean():>+11.4f}'
          f'{L[f"s{st}_LONG_pb|oppR"].mean():>+10.4f}{Lg[f"s{st}_LONG_mkt|oppR"].mean():>+12.4f}')

r1, p1 = spearmanr(STOPS, [L[f's{s}_LONG_mkt|oppR'].mean() for s in STOPS])
c1 = r1 > 0 and p1 < 0.01
# The harness defaults to a 2022-01 start, but `level_entry_rows` reaches back to 2020 — so windows
# that genuinely exist were simply not being used. Testing the criterion AS WRITTEN, over the whole
# span, rather than around it.
pos, tot = period_consistency(L.assign(_a=L['s4.0_LONG_mkt|oppR']), '_a', 's2.0_LONG_mkt|oppR',
                              start='2020-01-01')
import pandas as _pd
_d = L.copy(); _d['_dt'] = _pd.to_datetime(_d.timestamp, unit='s')
_per = _pd.date_range('2020-01-01', '2026-07-01', freq='6MS')
print('\nper-period detail (4 ATR minus 2 ATR, market entry):')
for _i in range(len(_per)-1):
    _w = (_d._dt >= _per[_i]) & (_d._dt < _per[_i+1])
    _n = int(_w.sum())
    if _n < 2000:
        print(f'  {_per[_i].date()}  n={_n:>6,}  (skipped, under 2,000)'); continue
    _diff = _d.loc[_w,'s4.0_LONG_mkt|oppR'].mean() - _d.loc[_w,'s2.0_LONG_mkt|oppR'].mean()
    print(f'  {_per[_i].date()}  n={_n:>6,}  {_diff:+.4f}  {"WIN" if _diff>0 else "loss"}')
c2 = pos >= 6 and tot >= 9
c3 = Lg['s4.0_LONG_mkt|oppR'].mean() > Lg['s2.0_LONG_mkt|oppR'].mean()
c4 = (L['s4.0_LONG_pb|oppR'].mean() - L['s2.0_LONG_pb|oppR'].mean()) > 0
c5 = len(L) // 18 >= 500
d = L['s4.0_LONG_mkt|oppR'].to_numpy(float) - L['s2.0_LONG_mkt|oppR'].to_numpy(float)
ci = moving_block_bootstrap(d, 18)
print(f'\n1 MONOTONE       Spearman {r1:+.3f} p {p1:.4f}            -> {"PASS" if c1 else "FAIL"}')
print(f'2 PERIODS        4 ATR beats 2 ATR in {pos}/{tot} (bar 6/9)  -> {"PASS" if c2 else "FAIL"}')
print(f'3 GROSS NOT FEES gross 4 {Lg["s4.0_LONG_mkt|oppR"].mean():+.4f} vs 2 '
      f'{Lg["s2.0_LONG_mkt|oppR"].mean():+.4f}  -> {"PASS" if c3 else "FAIL"}')
print(f'4 BOTH ENTRIES   pullback diff {L["s4.0_LONG_pb|oppR"].mean()-L["s2.0_LONG_pb|oppR"].mean():+.4f}      -> {"PASS" if c4 else "FAIL"}')
print(f'5 POWER          effective n {len(L)//18:,}                  -> {"PASS" if c5 else "FAIL"}')
print(f'\n4-vs-2 ATR net diff {np.nanmean(d):+.4f}  95% CI [{ci[0]:+.4f},{ci[1]:+.4f}]')
print(f'VERDICT: {"SUPPORTED — ship" if all([c1,c2,c3,c4,c5]) else "NOT SUPPORTED — floor stays at 2.0"}')
