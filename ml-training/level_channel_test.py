#!/usr/bin/env python3
"""
Do sloped trendlines / channels hold better than the HORIZONTAL levels already implemented?

Pre-declared in docs/research/level-trend-channels.md (committed BEFORE this ran).

A trendline's projected value is generally a price the market has NEVER traded, so it cannot
inherit the visited-price effect that carried every horizontal class. If it works, the
mechanism is different.

Decisive control: a HORIZONTAL line at the SAME anchor pivot — the incumbent.
Secondary control: the same anchor with a RANDOM slope — separates "the anchor does the work"
from "the fitted slope carries information".

Run:  python3 level_channel_test.py
"""
import sys
import numpy as np
import pandas as pd

LV = __import__('level_validation')

MAX_PROJ = LV.MAX_LEVEL_AGE   # never project a line further than the horizontal machinery looks
REG_N = 60                    # regression-channel lookback (10 days of 4H bars)
REG_K = 2.0                   # rail offset in residual sd


# ─────────────────────────────────────────────────────────────────────────────
# Sloped generalisation of LV.forward_outcome. MUST reduce to it exactly at slope 0.
# ─────────────────────────────────────────────────────────────────────────────
def forward_outcome_sloped(h, l, c, atr, start, level_at):
    """`level_at(j)` returns the line's price at bar j. Identical logic to
    LV.forward_outcome in every other respect — same leave-then-reenter requirement, same
    touch/break/react thresholds, same horizon, same unresolved->None."""
    n = len(c)
    L0 = level_at(start)
    a0 = atr[start] if atr[start] > 0 else L0 * 0.003
    touch = LV.TOUCH_ATR * a0
    left = False
    for j in range(start + 1, min(start + LV.MAX_LEVEL_AGE, n)):
        Lj = level_at(j)
        if Lj <= 0:
            return None
        in_zone = (l[j] - touch) <= Lj <= (h[j] + touch)
        if not left:
            if abs(c[j] - Lj) > 1.5 * touch:
                left = True
            continue
        if not in_zone:
            continue
        approach_below = c[j - 1] < level_at(j - 1)
        a = atr[j] if atr[j] > 0 else Lj * 0.003
        brk = LV.BREAK_ATR * a; react = LV.REACT_ATR * a
        best_reject = 0.0
        for k in range(j, min(j + LV.HORIZON, n)):
            Lk = level_at(k)
            if approach_below:
                if c[k] > Lk + brk: return (False, 0.0, j)
                best_reject = max(best_reject, (Lk - l[k]) / a)
            else:
                if c[k] < Lk - brk: return (False, 0.0, j)
                best_reject = max(best_reject, (h[k] - Lk) / a)
            if best_reject * a >= react:
                return (True, best_reject, j)
        return None
    return None


def assert_slope0_parity():
    """Refuse to run unless the sloped function reproduces LV.forward_outcome EXACTLY at
    slope 0. A sloped generalisation IS a reconstruction, and the standing rule from the
    2026-08-25j retraction is that a reconstruction is asserted against the original on
    shared inputs before its output is used."""
    df = pd.read_csv(LV.CANDLES['crypto'], nrows=60000)
    rng = np.random.RandomState(3)
    checked = mismatch = 0
    for sym, g in df.groupby('symbol'):
        g = g.sort_values('timestamp').reset_index(drop=True)
        if len(g) < 300:
            continue
        h = g['high'].values; l = g['low'].values; c = g['close'].values
        atr = LV.atr_series(h, l, c)
        for _ in range(400):
            i = int(rng.randint(LV.N_PIVOT, len(c) - 3))
            lvl = float(c[i]) * float(rng.uniform(0.95, 1.05))
            a = LV.forward_outcome(h, l, c, atr, i, lvl, is_resistance=(lvl > c[i]))
            b = forward_outcome_sloped(h, l, c, atr, i, lambda j, L=lvl: L)
            b = b[:2] if b is not None else None
            checked += 1
            if a != b:
                mismatch += 1
        if checked >= 4000:
            break
    if mismatch:
        sys.exit(f"PARITY FAILED: {mismatch}/{checked} slope-0 cases differ from LV.forward_outcome")
    print(f"  slope-0 parity vs LV.forward_outcome: {checked:,} cases, 0 mismatches", flush=True)


def periods(ts_ms):
    d = pd.to_datetime(ts_ms, unit='ms')
    return d.year.astype(str) + np.where(d.month <= 6, 'H1', 'H2')


def gap_ci(a, b, rng=None, B=2000):
    """95% CI on mean(a)-mean(b) in pp, symbol-level block bootstrap, arms paired on the
    same resampled symbols. (Kish design effects go unstable on sparse arms — see
    level-monthly-extremes.)"""
    rng = rng or np.random.RandomState(7)
    syms = np.array(sorted(set(a['symbol']) | set(b['symbol'])))
    obs = (a['held'].mean() - b['held'].mean()) * 100
    if len(syms) < 5:
        return obs, float('nan'), float('nan')
    ga = {k: v['held'].values for k, v in a.groupby('symbol')}
    gb = {k: v['held'].values for k, v in b.groupby('symbol')}
    draws = []
    for _ in range(B):
        pick = syms[rng.randint(0, len(syms), len(syms))]
        va = [ga[s] for s in pick if s in ga]
        vb = [gb[s] for s in pick if s in gb]
        if not va or not vb:
            continue
        va = np.concatenate(va); vb = np.concatenate(vb)
        if len(va) < 10 or len(vb) < 10:
            continue
        draws.append((va.mean() - vb.mean()) * 100)
    if len(draws) < B // 4:
        return obs, float('nan'), float('nan')
    return obs, float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5))


def run(market, path):
    df_all = pd.read_csv(path)
    rows = []          # (symbol, period, arm, side, projbin, held)
    line_ctrl = []
    rng = np.random.RandomState(31)
    slopes_seen = []

    syms = list(df_all.groupby('symbol'))
    for si, (sym, g) in enumerate(syms):
        g = g.sort_values('timestamp').reset_index(drop=True)
        if len(g) < 200:
            continue
        h = g['high'].values; l = g['low'].values; c = g['close'].values
        ts = g['timestamp'].values
        atr = LV.atr_series(h, l, c); n = len(c)
        per = periods(ts)
        sw = LV.swings(h, l)

        highs = [(pi, ci, p) for pi, ci, p, isH in sw if isH]
        lows  = [(pi, ci, p) for pi, ci, p, isH in sw if not isH]

        def emit(arm, side, start, fn, _unused=None):
            if start < LV.N_PIVOT or start >= n - 2:
                return
            out = forward_outcome_sloped(h, l, c, atr, start, fn)
            if out is None:
                return
            proj = out[2] - start          # bars from the anchor to the actual retest
            pb = '0-30' if proj <= 30 else ('30-60' if proj <= 60 else '60+')
            rows.append((sym, per[start], arm, side, pb, f"{sym}|{side}|{start}", out[0]))

        for side, pts in [('res', highs), ('sup', lows)]:
            for t in range(1, len(pts)):
                (p1, c1, y1), (p2, c2, y2) = pts[t - 1], pts[t]
                if p2 <= p1:
                    continue
                anchor = c2                      # the line is KNOWN only once pivot 2 confirms
                if anchor >= n - 3:
                    continue
                slope = (y2 - y1) / (p2 - p1)    # price per bar
                a_anchor = atr[anchor] if atr[anchor] > 0 else y2 * 0.003
                # reject degenerate near-vertical lines (>0.5 ATR of drift per bar)
                if abs(slope) > 0.5 * a_anchor:
                    continue
                slopes_seen.append(slope / a_anchor)

                emit('channel', side, anchor,
                     lambda j, y=y2, p=p2, s=slope: y + s * (j - p), MAX_PROJ)
                emit('horizontal', side, anchor, lambda j, y=y2: y, MAX_PROJ)
                rs = float(rng.choice(slopes_seen)) * a_anchor if len(slopes_seen) > 50 else slope
                emit('randslope', side, anchor,
                     lambda j, y=y2, p=p2, s=rs: y + s * (j - p), MAX_PROJ)

        # ── regression channel: LS fit on trailing REG_N bars, rails at +/- REG_K sd ──
        x = np.arange(REG_N, dtype=float)
        for i in range(REG_N + LV.N_PIVOT, n - 3, 7):
            w = c[i - REG_N + 1:i + 1]
            if len(w) < REG_N:
                continue
            b1, b0 = np.polyfit(x, w, 1)
            resid = w - (b0 + b1 * x)
            sd = resid.std()
            if sd <= 0:
                continue
            for side, sgn in [('res', +1), ('sup', -1)]:
                emit('regchan', side, i,
                     lambda j, b0=b0, b1=b1, i0=i, sd=sd, sg=sgn:
                         b0 + b1 * (REG_N - 1 + (j - i0)) + sg * REG_K * sd, MAX_PROJ)

        LV.sample_control(g, sw, line_ctrl, rng)
        if (si + 1) % 25 == 0:
            print(f"  ..{si+1}/{len(syms)}", file=sys.stderr, flush=True)

    d = pd.DataFrame(rows, columns=['symbol', 'period', 'arm', 'side', 'projbin', 'evkey', 'held'])
    base = pd.DataFrame(line_ctrl, columns=['held', 'bounce', 'dist'])['held'].mean() * 100

    print(f"\n{'='*80}\n{market.upper()} — sloped trendline vs the horizontal level at the SAME anchor\n{'='*80}")
    for arm in ['channel', 'horizontal', 'randslope', 'regchan']:
        s = d[d['arm'] == arm]
        if len(s) < 30:
            continue
        print(f"  {arm:<12} HOLD {s['held'].mean()*100:6.2f}%   n {len(s):>8,}   "
              f"vs random line {s['held'].mean()*100-base:+.2f}pp")

    ch = d[d['arm'] == 'channel']; hz = d[d['arm'] == 'horizontal']; rs = d[d['arm'] == 'randslope']
    for lab, A, B_ in [('channel vs HORIZONTAL (the ship bar)', ch, hz),
                       ('channel vs RANDOM SLOPE (is the slope real?)', ch, rs)]:
        if len(A) < 30 or len(B_) < 30:
            continue
        gm, lo, hi = gap_ci(A, B_)
        v = 'NOT SUPPORTED' if hi < 2.0 else ('INCONCLUSIVE' if lo < 2.0 else 'SUPPORTED')
        print(f"\n  {lab}\n    gap {gm:+.2f}pp   95% CI [{lo:+.2f}, {hi:+.2f}]   -> {v}")

    # A projected line can be unreachable while the horizontal at the same anchor is hit, so
    # the two arms need not resolve the same events. Report the PAIRED subset as well; if the
    # pooled and paired gaps disagree, the pooled one is a selection artifact.
    both = set(ch['evkey']) & set(hz['evkey'])
    if len(both) >= 100:
        cp = ch[ch['evkey'].isin(both)]; hp = hz[hz['evkey'].isin(both)]
        gm, lo, hi = gap_ci(cp, hp)
        print(f"\n  PAIRED on the {len(both):,} events BOTH arms resolved:")
        print(f"    channel {cp['held'].mean()*100:6.2f}%   horizontal {hp['held'].mean()*100:6.2f}%   "
              f"gap {gm:+.2f}pp  [{lo:+.2f}, {hi:+.2f}]")
        print(f"    resolution rate: channel {len(ch):,} events, horizontal {len(hz):,} "
              f"({len(both):,} shared)")

    print(f"\n  by side (channel vs horizontal):")
    for side in ['sup', 'res']:
        A = ch[ch['side'] == side]; B_ = hz[hz['side'] == side]
        if len(A) < 30 or len(B_) < 30:
            continue
        gm, lo, hi = gap_ci(A, B_)
        print(f"    {side}: channel {A['held'].mean()*100:6.2f}%  horizontal {B_['held'].mean()*100:6.2f}%  "
              f"gap {gm:+.2f}pp [{lo:+.2f}, {hi:+.2f}]  (n {len(A):,})")

    print(f"\n  by projection distance (does a line decay away from its anchor?):")
    for pb in ['0-30', '30-60', '60+']:
        A = ch[ch['projbin'] == pb]; B_ = hz[hz['projbin'] == pb]
        if len(A) < 30 or len(B_) < 30:
            continue
        print(f"    {pb:>6} bars: channel {A['held'].mean()*100:6.2f}%  "
              f"horizontal {B_['held'].mean()*100:6.2f}%  gap {(A['held'].mean()-B_['held'].mean())*100:+.2f}pp  (n {len(A):,})")

    print(f"\n  period consistency (channel > horizontal, bar >= 7 of 9):")
    pos = tot = 0
    for p in sorted(d['period'].unique()):
        A = ch[ch['period'] == p]; B_ = hz[hz['period'] == p]
        if len(A) < 40 or len(B_) < 40:
            continue
        gp = (A['held'].mean() - B_['held'].mean()) * 100
        tot += 1; pos += (gp > 0)
        print(f"    {p}  {gp:+6.2f}pp  (n {len(A):>6,})")
    print(f"    -> {pos} of {tot} periods positive")
    print(f"\n  random line 0.5-3.0 ATR (ancestral control): HOLD {base:.2f}%")
    return d


def main():
    print("startup checks:")
    assert_slope0_parity()
    for market, path in LV.CANDLES.items():
        run(market, path)


if __name__ == '__main__':
    main()
