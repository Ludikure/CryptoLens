#!/usr/bin/env python3
"""Does the WHALE TRAP flag predict the flush it warns about?

Runs the design frozen in docs/research/whale-trap-validation.md. Thresholds are pre-declared —
do not tune them after seeing output.

Unlike the liquidation-FEATURE test, this does not ask whether liquidation data predicts price. It
asks whether an EXISTING PROMPT CLAIM predicts liquidations. A negative result deletes a forecast
the app currently makes to users, which is worth as much as a positive one.

Reconstructs 3 of the 4 production tells (spot CVD is archived nowhere), so this covers a SUBSET of
production firings — see the fidelity table in the design doc.
"""
import csv
import datetime as dt
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
METRICS = HERE / 'vision_backfill' / 'metrics'
LIQ = HERE / 'candlefeed' / 'liquidations_aggregated'
V14 = HERE / 'csv_exports_v14'

# Pre-declared (docs/research/whale-trap-validation.md)
BAR_PP = 5.0
BAR_MIN_N = 30

METRICS_COLS = ['create_time', 'symbol', 'sum_open_interest', 'sum_open_interest_value',
                'count_toptrader_long_short_ratio', 'sum_toptrader_long_short_ratio',
                'count_long_short_ratio', 'sum_taker_long_short_vol_ratio']


def load_metrics(sym):
    f = METRICS / f'{sym}.csv'
    if not f.exists() or f.stat().st_size == 0:
        return None
    d = pd.read_csv(f, names=METRICS_COLS, header=None)
    d = d[d['create_time'].astype(str).str[:4].str.isdigit()]
    d['ts'] = pd.to_datetime(d['create_time'], errors='coerce')
    d = d.dropna(subset=['ts']).sort_values('ts')
    d['date'] = d['ts'].dt.date
    # Last observation of each day — the flag is evaluated at the close of day D.
    daily = d.groupby('date').last().reset_index()
    # retail long share from the long/short RATIO: ratio = long/short -> long% = r/(1+r)
    r = pd.to_numeric(daily['count_long_short_ratio'], errors='coerce')
    daily['retail_long_pct'] = (r / (1 + r)) * 100
    tr = pd.to_numeric(daily['sum_toptrader_long_short_ratio'], errors='coerce')
    daily['top_long_pct'] = (tr / (1 + tr)) * 100
    daily['oi'] = pd.to_numeric(daily['sum_open_interest'], errors='coerce')
    daily['oi_chg_24h'] = daily['oi'].pct_change() * 100
    return daily[['date', 'retail_long_pct', 'top_long_pct', 'oi_chg_24h']]


def load_funding(sym):
    f = V14 / f'{sym}.csv'
    if not f.exists():
        return None
    d = pd.read_csv(f, usecols=['timestamp', 'fundingRateRaw'])
    d['date'] = pd.to_datetime(d['timestamp'], unit='s').dt.date
    # fundingRateRaw is a rate (0.01 = 0.01%/8h in the prompt's `fundingRatePercent` units)
    return d.groupby('date')['fundingRateRaw'].last().reset_index()


def load_liq(sym):
    f = LIQ / f'{sym}.csv'
    if not f.exists():
        return None
    d = pd.read_csv(f)
    d['date'] = pd.to_datetime(d['timestamp']).dt.date
    tot = d['long_liq_usd'] + d['short_liq_usd']
    d['long_share'] = np.where(tot > 0, d['long_liq_usd'] / tot * 100, np.nan)
    return d[['date', 'long_share', 'long_liq_usd', 'short_liq_usd']]


def whale_trap(row):
    """Production logic (prompt.ts:1663-1700) minus the CVD tell, which is archived nowhere."""
    rl, tl, fr, oi = row['retail_long_pct'], row['top_long_pct'], row['fundingRateRaw'], row['oi_chg_24h']
    if pd.isna(rl):
        return None
    crowd_long, crowd_short = rl >= 60, (100 - rl) >= 60
    if not (crowd_long or crowd_short):
        return None
    tells = 0
    if not pd.isna(tl):                                     # smart money against the crowd
        tells += 1 if (crowd_long and tl < 50) or (crowd_short and tl > 50) else 0
    if not pd.isna(fr):                                     # funding stretched in the crowd's direction
        tells += 1 if (crowd_long and fr > 0.03) or (crowd_short and fr < -0.03) else 0
    if not pd.isna(oi) and oi > 2:                          # OI building
        tells += 1
    if tells < 2:
        return None
    return 'LONG' if crowd_long else 'SHORT'


def main():
    syms = [s for s in ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
            if (METRICS / f'{s}.csv').exists() and (METRICS / f'{s}.csv').stat().st_size > 0]
    print(f'symbols with both metrics and liquidation history: {syms}\n')
    frames = []
    for s in syms:
        m, fu, lq = load_metrics(s), load_funding(s), load_liq(s)
        if m is None or fu is None or lq is None:
            print(f'  {s}: missing input, skipped'); continue
        d = m.merge(fu, on='date', how='inner').merge(lq, on='date', how='inner').sort_values('date')
        # OUTCOME is day D+1 — strictly forward of every input used by the flag.
        d['next_long_share'] = d['long_share'].shift(-1)
        d['flag'] = d.apply(whale_trap, axis=1)
        d['crowd_only'] = np.where(d['retail_long_pct'] >= 60, 'LONG',
                            np.where((100 - d['retail_long_pct']) >= 60, 'SHORT', None))
        d['symbol'] = s
        frames.append(d.dropna(subset=['next_long_share']))
        print(f'  {s}: {len(d):,} overlapping days  ({d["date"].min()} -> {d["date"].max()})')
    if not frames:
        raise SystemExit('no overlapping data')
    a = pd.concat(frames, ignore_index=True)

    base = a['next_long_share'].mean()
    print(f'\nbaseline next-day LONG-liquidation share: {base:.1f}%   (n={len(a):,} days)')

    def report(col, label):
        print(f'\n--- {label} ---')
        out = {}
        for side in ('LONG', 'SHORT'):
            sub = a[a[col] == side]
            if len(sub) == 0:
                print(f'  crowd {side:<5}: no firings'); continue
            v = sub['next_long_share'].mean()
            out[side] = (v, len(sub))
            print(f'  crowd {side:<5}: next-day long-liq share {v:5.1f}%  '
                  f'({v-base:+5.1f}pp vs baseline)   n={len(sub):,}')
        return out

    full = report('flag', 'WHALE TRAP (crowding + >=2 tells) — the production claim')
    ctrl = report('crowd_only', 'CONTROL: crowding alone, no tells required')

    print(f'\n{"="*68}\nPRE-DECLARED SHIP BAR (docs/research/whale-trap-validation.md)\n{"="*68}')
    lv, ln = full.get('LONG', (np.nan, 0))
    sv, sn = full.get('SHORT', (np.nan, 0))
    c1 = (lv - base) >= BAR_PP
    c2 = (sv - base) <= -BAR_PP
    c3 = ln >= BAR_MIN_N and sn >= BAR_MIN_N
    print(f'  1. crowded-LONG  -> long-liq share >= base+{BAR_PP}pp .... {lv-base:+.1f}pp  {"PASS" if c1 else "FAIL"}')
    print(f'  2. crowded-SHORT -> long-liq share <= base-{BAR_PP}pp .... {sv-base:+.1f}pp  {"PASS" if c2 else "FAIL"}')
    print(f'  3. n >= {BAR_MIN_N} per side ........................ {ln}/{sn}   {"PASS" if c3 else "FAIL (underpowered)"}')
    verdict = 'VALIDATED' if (c1 and c2 and c3) else 'NOT VALIDATED'
    print(f'\n  VERDICT: {verdict}')

    if 'LONG' in full and 'LONG' in ctrl:
        edge = full['LONG'][0] - ctrl['LONG'][0]
        print(f'\n  Does the flag beat crowding alone? {edge:+.1f}pp on the LONG side.')
        print('  ' + ('The tells add signal.' if edge > 1 else
                      'The tells add nothing — the flag is doing what the crowding line already does.'))


if __name__ == '__main__':
    main()
