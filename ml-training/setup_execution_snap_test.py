#!/usr/bin/env python3
"""
Does snapping targets to S/R levels improve EV vs raw ATR-band targets?

THE question for S/R: everything else measured hold-rate (secondary). This measures money.
Same entries, two target schemes, compare realized R/trade:

  Scheme A (ATR band):  TP1 = entry ± 1.5 ATR, TP2 = entry ± 2.5 ATR   (tighter-band default)
  Scheme B (snap):      TP1/TP2 snapped to the nearest swing level within the allowed band,
                        front-run by 0.1 ATR; ATR default if no level in band.

Entries: swing-pivot reversals (swing low → LONG, swing high → SHORT) — the natural
"enter near support/resistance" stream that makes snapping relevant. Stop 1.0 ATR.
Execution model (matches strategy-targets-bands): 50% off at TP1 → stop to break-even →
runner to TP2; 30-bar horizon, mark-to-market on timeout; SL-first tie-break. No lookahead
(levels only from swings confirmed before entry).

If B beats A on EV, S/R-snapping earns its place in the pipeline. If it's a wash, the bands
do all the work and S/R is scaffolding. Run:  python3 setup_execution_snap_test.py
"""
import numpy as np
import pandas as pd

LV = __import__('level_validation')

TP1_BAND = (1.0, 2.5); TP1_DEF = 1.5
TP2_BAND = (1.8, 3.0); TP2_DEF = 2.5
STOP_ATR = 1.0
HORIZON = 30


def snap(levels, entry, atr, d, band, default_mult):
    """Nearest level in the profit direction within [band] ATR; front-run 0.1 ATR. Returns
    (price, snapped?)."""
    if len(levels):
        dist = (levels - entry) * d / atr      # +ve = ahead in profit direction
        cand = levels[(dist >= band[0]) & (dist <= band[1])]
        if len(cand):
            nearest = cand[np.argmin((cand - entry) * d)]
            return nearest - d * 0.1 * atr, True
    return entry + d * default_mult * atr, False


def resolve(h, l, c, start, entry, sl, tp1, tp2, d):
    risk = abs(entry - sl)
    if risk <= 0:
        return None
    r1 = abs(tp1 - entry) / risk
    r2 = abs(tp2 - entry) / risk
    n = len(c)
    tp1_hit = False
    for k in range(start + 1, min(start + 1 + HORIZON, n)):
        hi, lo = h[k], l[k]
        if not tp1_hit:
            sl_hit = lo <= sl if d > 0 else hi >= sl
            t1 = hi >= tp1 if d > 0 else lo <= tp1
            if sl_hit:                       # SL-first tie-break
                return -1.0
            if t1:
                tp1_hit = True
                continue
        else:
            be_hit = lo <= entry if d > 0 else hi >= entry
            t2 = hi >= tp2 if d > 0 else lo <= tp2
            if be_hit:                       # BE-first tie-break (conservative)
                return 0.5 * r1
            if t2:
                return 0.5 * r1 + 0.5 * r2
    last = c[min(start + HORIZON, n - 1)]
    mtm = d * (last - entry) / risk
    return mtm if not tp1_hit else 0.5 * r1 + 0.5 * mtm


def run(market, path):
    df_all = pd.read_csv(path)
    A, B = [], []                 # realized R per scheme
    Bdiff_A, Bdiff_B = [], []     # subset where snap actually changed a target

    for sym, g in df_all.groupby('symbol'):
        g = g.sort_values('timestamp').reset_index(drop=True)
        if len(g) < 120:
            continue
        h = g['high'].values; l = g['low'].values; c = g['close'].values
        atr = LV.atr_series(h, l, c)
        sw = sorted(LV.swings(h, l), key=lambda s: s[1])  # by confirm idx
        past = []  # swing prices confirmed before current entry

        for _, confirm_idx, price, is_high in sw:
            d = -1 if is_high else 1                 # swing high → SHORT, low → LONG
            entry = c[confirm_idx]
            a = atr[confirm_idx]
            if a <= 0 or entry <= 0:
                past.append(price); continue
            sl = entry - d * STOP_ATR * a
            levels = np.array([p for p in past if (p - entry) * d > 0])  # ahead in profit dir

            tp1A = entry + d * TP1_DEF * a
            tp2A = entry + d * TP2_DEF * a
            tp1B, s1 = snap(levels, entry, a, d, TP1_BAND, TP1_DEF)
            tp2B, s2 = snap(levels, entry, a, d, TP2_BAND, TP2_DEF)
            # keep TP2 beyond TP1 in profit direction
            if (tp2B - tp1B) * d <= 0:
                tp2B = entry + d * TP2_DEF * a

            rA = resolve(h, l, c, confirm_idx, entry, sl, tp1A, tp2A, d)
            rB = resolve(h, l, c, confirm_idx, entry, sl, tp1B, tp2B, d)
            if rA is not None and rB is not None:
                A.append(rA); B.append(rB)
                if s1 or s2:
                    Bdiff_A.append(rA); Bdiff_B.append(rB)
            past.append(price)

    print(f"\n{'='*60}\n{market.upper()} — target placement: ATR band vs snap-to-S/R\n{'='*60}")
    print(f"  all entries (n={len(A):,}):")
    print(f"    ATR band   EV {np.mean(A):+.4f}R   win {np.mean([x>0 for x in A])*100:.1f}%")
    print(f"    snap S/R   EV {np.mean(B):+.4f}R   win {np.mean([x>0 for x in B])*100:.1f}%")
    print(f"    → snap − ATR = {np.mean(B)-np.mean(A):+.4f}R/trade")
    if Bdiff_A:
        print(f"  subset where snap CHANGED a target (n={len(Bdiff_A):,}, {len(Bdiff_A)/len(A)*100:.0f}% of entries):")
        print(f"    ATR band   EV {np.mean(Bdiff_A):+.4f}R")
        print(f"    snap S/R   EV {np.mean(Bdiff_B):+.4f}R")
        print(f"    → snap − ATR = {np.mean(Bdiff_B)-np.mean(Bdiff_A):+.4f}R/trade (where it applies)")


def main():
    for market, path in LV.CANDLES.items():
        run(market, path)


if __name__ == '__main__':
    main()
