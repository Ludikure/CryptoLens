#!/usr/bin/env python3
"""Which price structure predicts WHERE liquidations land?

Exploratory, and labelled as such — no ship bar, because this characterises rather than decides.
It answers the question a liquidation map has to answer before it can be built: given that price
reaches a level, is there anything structural about how much forced flow is waiting there?

The metric throughout is INTENSITY:

    intensity(zone) = share of liquidation notional in zone / share of TIME price spent in zone

Time-normalisation is the whole point. Longs die when price falls, so "long liquidations happen at
low prices" is true by construction and would show up as a huge raw share. Dividing by time-at-price
removes that tautology: 1.0x means a zone sees exactly the forced flow its occupancy predicts, and
only >1 is real concentration.

Inputs: CandleFeed per-event liquidations (price + side + USD) and Binance Vision 1h klines.
"""
import numpy as np
import pandas as pd
from pathlib import Path

HERE = Path(__file__).parent
LIQ = HERE / 'candlefeed' / 'liquidations' / 'BTCUSDT.csv'
KL = HERE / 'vision_backfill' / 'klines' / 'BTCUSDT_1h.csv'


def load():
    liq = pd.read_csv(LIQ)
    liq['ts'] = pd.to_datetime(liq['time'], format='mixed', utc=True)
    liq['usd'] = pd.to_numeric(liq['usd_value'], errors='coerce')
    liq['price'] = pd.to_numeric(liq['price'], errors='coerce')
    liq = liq.dropna(subset=['usd', 'price']).sort_values('ts')

    k = pd.read_csv(KL)
    k['ts'] = pd.to_datetime(k['ts'], utc=True)
    for c in ('open', 'high', 'low', 'close'):
        k[c] = pd.to_numeric(k[c], errors='coerce')
    k = k.dropna().sort_values('ts').reset_index(drop=True)
    return liq, k


def intensity(liq, k, level_fn, name, side):
    """Share of liquidation notional beyond an anchor / share of hours spent beyond it.

    Anchors are computed from CLOSED history only (shift(1)), so a level never sees the bar it is
    being tested against — the same leak discipline as the feature test.
    """
    lv = level_fn(k)
    ref = pd.DataFrame({'ts': k['ts'], 'level': lv, 'close': k['close']}).dropna()
    if ref.empty:
        return None
    # Time: hours where price sat beyond the anchor (below for longs, above for shorts).
    beyond_time = (ref['close'] < ref['level']) if side == 'sell' else (ref['close'] > ref['level'])
    t_share = beyond_time.mean()
    # Liquidations: notional printed beyond the anchor in force at that hour.
    j = pd.merge_asof(liq[liq['side'] == side].sort_values('ts'), ref.sort_values('ts'),
                      on='ts', direction='backward')
    j = j.dropna(subset=['level'])
    if j.empty or t_share in (0, 1):
        return None
    beyond_liq = (j['price'] < j['level']) if side == 'sell' else (j['price'] > j['level'])
    l_share = j.loc[beyond_liq, 'usd'].sum() / j['usd'].sum()
    return dict(anchor=name, time=t_share * 100, liq=l_share * 100,
                intensity=(l_share / t_share) if t_share else np.nan,
                notional=j['usd'].sum() / 1e6, n=len(j))


def main():
    liq, k = load()
    print(f'{len(liq):,} liquidation events  {liq.ts.min():%Y-%m-%d} -> {liq.ts.max():%Y-%m-%d}')
    print(f'{len(k):,} hourly bars\n')

    # Candidate anchors — each returns a per-hour price level, from CLOSED history only.
    anchors = {
        'prior 24h low/high':  lambda k, s: (k['low'].rolling(24).min().shift(1) if s == 'sell'
                                             else k['high'].rolling(24).max().shift(1)),
        'prior 3d low/high':   lambda k, s: (k['low'].rolling(72).min().shift(1) if s == 'sell'
                                             else k['high'].rolling(72).max().shift(1)),
        'prior 7d low/high':   lambda k, s: (k['low'].rolling(168).min().shift(1) if s == 'sell'
                                             else k['high'].rolling(168).max().shift(1)),
        'round $1000':         lambda k, s: (np.floor(k['close'].shift(1) / 1000) * 1000 if s == 'sell'
                                             else np.ceil(k['close'].shift(1) / 1000) * 1000),
        '24h VWAP':            lambda k, s: (k['close'].rolling(24).mean().shift(1)),
        '-1 ATR / +1 ATR':     lambda k, s: (k['close'].shift(1) - (k['high'] - k['low']).rolling(24).mean().shift(1)
                                             if s == 'sell' else
                                             k['close'].shift(1) + (k['high'] - k['low']).rolling(24).mean().shift(1)),
    }

    for side, label in (('sell', 'LONG liquidations (price falls into them)'),
                        ('buy', 'SHORT liquidations (price rises into them)')):
        print(f'=== {label} ===')
        print(f'{"anchor":<22}{"% time beyond":>14}{"% liq beyond":>14}{"intensity":>11}')
        rows = []
        for name, fn in anchors.items():
            r = intensity(liq, k, lambda kk, f=fn, s=side: f(kk, s), name, side)
            if r:
                rows.append(r)
                print(f'{name:<22}{r["time"]:>13.1f}%{r["liq"]:>13.1f}%{r["intensity"]:>10.2f}x')
        if rows:
            best = max(rows, key=lambda r: r['intensity'])
            print(f'  -> strongest: {best["anchor"]} at {best["intensity"]:.2f}x '
                  f'(${best["notional"]:,.0f}M over {best["n"]:,} events)')
        print()

    print('READ: 1.00x = the zone sees exactly the forced flow its time-at-price predicts, i.e.')
    print('nothing structural. Only materially >1 is a real cluster worth mapping.')


if __name__ == '__main__':
    main()
