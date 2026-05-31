#!/usr/bin/env python3
"""
Do HIGHER-TIMEFRAME levels hold better than 4H swings?

Extends level_validation.py to test daily-close and weekly (close / high / low) levels as
S/R, vs the 4H swing baseline and the random-line control — all through the IDENTICAL
forward-outcome logic so the comparison is fair.

Unlike the worn/flip tags (disproven), HTF significance has a real mechanism: weekly closes
and prior-week highs/lows have more resting orders + more eyes than a 4H wiggle. This
measures whether that shows up.

Each level class → candidate horizontal lines (formation_idx, price), no lookahead (a level
exists only after its bar completes). For each, find the first forward retest (price leaves
the zone then re-enters) and classify HOLD/BREAK over 48h. Hold rate per class.

Run:  python3 level_validation_htf.py
"""
import numpy as np
import pandas as pd

LV = __import__('level_validation')


def resample(df, freq):
    """4H bars → daily ('D') or weekly ('W') OHLC, keeping the 4H index where each
    period's last bar sits (that's when the level becomes 'formed', no lookahead)."""
    d = df.copy()
    d['dt'] = pd.to_datetime(d['timestamp'], unit='ms')
    d['pos'] = np.arange(len(d))
    g = d.set_index('dt').groupby(pd.Grouper(freq=freq))
    out = g.agg(open=('open', 'first'), high=('high', 'max'), low=('low', 'min'),
                close=('close', 'last'), form_idx=('pos', 'last')).dropna()
    out['form_idx'] = out['form_idx'].astype(int)
    return out


def class_hold(levels, h, l, c, atr):
    """levels = list of (formation_idx, price, is_resistance_hint). Returns (hold%, n)."""
    held = []
    n = len(c)
    for idx, price, is_res in levels:
        if idx < 0 or idx >= n - 2 or price <= 0:
            continue
        out = LV.forward_outcome(h, l, c, atr, idx, price, is_resistance=is_res)
        if out is not None:
            held.append(out[0])
    if not held:
        return None, 0
    return np.mean(held) * 100, len(held)


def run(market, path):
    df_all = pd.read_csv(path)
    classes = {'4H swing': [], 'daily close': [], 'weekly close': [],
               'weekly high': [], 'weekly low': []}
    ctrl = []
    rng = np.random.RandomState(7)

    for sym, g in df_all.groupby('symbol'):
        g = g.sort_values('timestamp').reset_index(drop=True)
        if len(g) < 120:
            continue
        h = g['high'].values; l = g['low'].values; c = g['close'].values
        atr = LV.atr_series(h, l, c)
        sw = LV.swings(h, l)  # for the control's off-swing check

        # daily + weekly levels (no lookahead via form_idx)
        daily = resample(g, 'D')
        weekly = resample(g, 'W')
        for _, row in daily.iterrows():
            fi = int(row['form_idx'])
            _append(classes['daily close'], (fi, row['close'], None), h, l, c, atr)
        for _, row in weekly.iterrows():
            fi = int(row['form_idx'])
            _append(classes['weekly close'], (fi, row['close'], None), h, l, c, atr)
            _append(classes['weekly high'], (fi, row['high'], True), h, l, c, atr)
            _append(classes['weekly low'], (fi, row['low'], False), h, l, c, atr)

        LV.sample_control(g, sw, ctrl, rng)

    # 4H swing via uniform per-event method (redo cleanly)
    sw_holds = []
    for sym, g in df_all.groupby('symbol'):
        g = g.sort_values('timestamp').reset_index(drop=True)
        if len(g) < 120: continue
        h = g['high'].values; l = g['low'].values; c = g['close'].values
        atr = LV.atr_series(h, l, c)
        for pivot_idx, confirm_idx, price, is_high in LV.swings(h, l):
            out = LV.forward_outcome(h, l, c, atr, confirm_idx, price, is_resistance=is_high)
            if out is not None: sw_holds.append(out[0])

    ctrl_rate = np.mean([x[0] for x in ctrl]) * 100 if ctrl else float('nan')
    print(f"\n{'='*60}\n{market.upper()} — hold rate by level class (48h, identical logic)\n{'='*60}")
    print(f"  {'class':<14} {'HOLD':>7} {'n':>9}   vs random")
    rows = [('4H swing', np.mean(sw_holds)*100 if sw_holds else float('nan'), len(sw_holds))]
    for name in ['daily close', 'weekly close', 'weekly high', 'weekly low']:
        arr = classes[name]
        rows.append((name, np.mean(arr)*100 if arr else float('nan'), len(arr)))
    for name, rate, n in rows:
        print(f"  {name:<14} {rate:>6.1f}% {n:>9,}   {rate-ctrl_rate:+.1f}pp")
    print(f"  {'random (ctrl)':<14} {ctrl_rate:>6.1f}% {len(ctrl):>9,}   baseline")


def _append(bucket, level_tuple, h, l, c, atr):
    idx, price, is_res = level_tuple
    n = len(c)
    if idx < 0 or idx >= n - 2 or price <= 0: return
    hint = is_res if is_res is not None else (price > c[idx])
    out = LV.forward_outcome(h, l, c, atr, idx, price, is_resistance=hint)
    if out is not None: bucket.append(out[0])


def main():
    for market, path in LV.CANDLES.items():
        # reset 4H swing bucket (we recompute cleanly inside run)
        run(market, path)


if __name__ == '__main__':
    main()
