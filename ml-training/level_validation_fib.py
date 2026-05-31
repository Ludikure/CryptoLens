#!/usr/bin/env python3
"""
Do Fibonacci retracement levels hold better than random?

Same forward-outcome logic as level_validation.py. For each swing LEG (a confirmed swing
high → the next confirmed swing low, or vice versa), once the second pivot confirms, compute
the retracement levels 0.236/0.382/0.5/0.618/0.786 across that range and test each as S/R
going forward. Compared to the 4H-swing baseline and the random-line control.

Mechanism prior: weakest of all level types — no settlement (daily close), psychology
(round number), or resting orders (swing). If anything holds above random, report by ratio;
0.5/0.618 are the only ones folklore even claims. Measure, don't assume.

Run:  python3 level_validation_fib.py
"""
import numpy as np
import pandas as pd

LV = __import__('level_validation')

RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786]


def run(market, path):
    df_all = pd.read_csv(path)
    fib_by_ratio = {r: [] for r in RATIOS}
    fib_all = []
    randratio = []   # DECISIVE control: random retracement ratios in the SAME legs
    swing_holds = []
    ctrl = []
    rng = np.random.RandomState(11)

    for sym, g in df_all.groupby('symbol'):
        g = g.sort_values('timestamp').reset_index(drop=True)
        if len(g) < 120:
            continue
        h = g['high'].values; l = g['low'].values; c = g['close'].values
        atr = LV.atr_series(h, l, c)
        sw = LV.swings(h, l)  # (pivot_idx, confirm_idx, price, is_high), sorted by confirm

        # 4H swing baseline (each swing → first forward retest)
        for _, confirm_idx, price, is_high in sw:
            out = LV.forward_outcome(h, l, c, atr, confirm_idx, price, is_resistance=is_high)
            if out is not None:
                swing_holds.append(out[0])

        # Fib legs: consecutive opposite-type swings (sorted by pivot index)
        sw_by_pivot = sorted(sw, key=lambda s: s[0])
        for a, b in zip(sw_by_pivot, sw_by_pivot[1:]):
            if a[3] == b[3]:
                continue  # same type, not a leg
            hi = max(a[2], b[2]); lo = min(a[2], b[2])
            rng_px = hi - lo
            if rng_px <= 0:
                continue
            form = b[1]  # leg established when 2nd pivot confirms
            for r in RATIOS:
                level = hi - r * rng_px
                out = LV.forward_outcome(h, l, c, atr, form, level, is_resistance=(level > c[form]))
                if out is not None:
                    fib_by_ratio[r].append(out[0])
                    fib_all.append(out[0])
            # matched control: 5 RANDOM retracement ratios in the SAME leg. If Fib ratios
            # don't beat these, the "edge" is being a mid-range line, not Fibonacci.
            for _ in RATIOS:
                rr = rng.uniform(0.1, 0.9)
                level = hi - rr * rng_px
                out = LV.forward_outcome(h, l, c, atr, form, level, is_resistance=(level > c[form]))
                if out is not None:
                    randratio.append(out[0])

        LV.sample_control(g, sw, ctrl, rng)

    ctrl_rate = np.mean([x[0] for x in ctrl]) * 100 if ctrl else float('nan')
    sw_rate = np.mean(swing_holds) * 100 if swing_holds else float('nan')
    fib_rate = np.mean(fib_all) * 100 if fib_all else float('nan')

    print(f"\n{'='*58}\n{market.upper()} — Fibonacci levels (48h, identical logic)\n{'='*58}")
    print(f"  {'class':<16} {'HOLD':>7} {'n':>9}   vs random")
    print(f"  {'fib (all ratios)':<16} {fib_rate:>6.1f}% {len(fib_all):>9,}   {fib_rate-ctrl_rate:+.1f}pp")
    for r in RATIOS:
        arr = fib_by_ratio[r]
        rate = np.mean(arr) * 100 if arr else float('nan')
        print(f"    {('fib '+format(r,'.3f')):<14} {rate:>6.1f}% {len(arr):>9,}   {rate-ctrl_rate:+.1f}pp")
    rr_rate = np.mean(randratio) * 100 if randratio else float('nan')
    print(f"  {'RAND ratio (same legs)':<16} {rr_rate:>6.1f}% {len(randratio):>9,}   {rr_rate-ctrl_rate:+.1f}pp   <- the decisive control")
    print(f"  → fib ratios beat random ratios by {fib_rate - rr_rate:+.1f}pp (if ~0, Fibs add nothing)")
    print(f"  {'4H swing (ref)':<16} {sw_rate:>6.1f}% {len(swing_holds):>9,}   {sw_rate-ctrl_rate:+.1f}pp")
    print(f"  {'random far (ctrl)':<16} {ctrl_rate:>6.1f}% {len(ctrl):>9,}   baseline")


def main():
    for market, path in LV.CANDLES.items():
        run(market, path)


if __name__ == '__main__':
    main()
