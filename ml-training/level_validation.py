#!/usr/bin/env python3
"""
Do the S/R level TAGS actually predict hold vs break?

The app tags structure levels by test-count (FRESH_1x / WORN_Nx) and FLIP_ROLE
(appeared as both a swing high AND low → "broken and reclaimed → stronger"), and the
prompt DISTRUSTS worn levels. None of that was ever backtested. This measures it.

Mirrors CryptoLens/Indicators/MarketStructure.swift:
  - swing pivot: strict extreme vs N=3 bars each side
  - cluster threshold: max(price*0.003, atr*0.1)
  - flip_role: a cluster containing both a swing-high and a swing-low

Outcome of a level test (the thing the tag is supposed to predict):
  Starting at the bar a swing CONFIRMS the level, scan forward. Once price LEAVES the
  level zone (>1.5*touch away) and later RE-ENTERS it (a genuine retest), classify over
  the next HORIZON bars:
    BREAK = a bar closes beyond the level by >= BREAK_ATR in the away-from-approach dir
    HOLD  = price rejects >= REACT_ATR back toward the approach side before any break
    (unresolved within horizon → dropped)
  bounce = max rejection excursion (ATR) after the retest.

Hold rate + bounce are then grouped by tag. If WORN really breaks more / FLIP holds
more, the taxonomy earns its place. If the buckets are flat, the tags are decoration.

Descriptive conditional stats (no model fit → no holdout needed); survivorship still
applies. Run:  python3 level_validation.py
"""
import gzip
import numpy as np
import pandas as pd

N_PIVOT = 3
ATR_PERIOD = 14
TOUCH_ATR = 0.25      # price within this of level = in the zone
BREAK_ATR = 0.50      # close beyond by this = break
REACT_ATR = 0.50      # reject by this = hold
HORIZON = 12          # 48h on 4h bars
MAX_LEVEL_AGE = 120   # a level older than this without a retest is abandoned
CANDLES = {'crypto': 'crypto_candles_4h.csv.gz', 'stock': 'stock_candles_4h.csv.gz'}


def atr_series(h, l, c):
    pc = np.roll(c, 1); pc[0] = c[0]
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    a = pd.Series(tr).rolling(ATR_PERIOD, min_periods=1).mean().values
    return a


def swings(h, l):
    """Confirmed swing pivots. Returns list of (pivot_idx, confirm_idx, price, is_high)."""
    out = []
    n = len(h)
    for i in range(N_PIVOT, n - N_PIVOT):
        hi = h[i]; lo = l[i]
        if all(h[i-k] < hi for k in range(1, N_PIVOT+1)) and all(h[i+k] < hi for k in range(1, N_PIVOT+1)):
            out.append((i, i + N_PIVOT, hi, True))
        if all(l[i-k] > lo for k in range(1, N_PIVOT+1)) and all(l[i+k] > lo for k in range(1, N_PIVOT+1)):
            out.append((i, i + N_PIVOT, lo, False))
    out.sort(key=lambda s: s[1])  # by confirm time
    return out


def evaluate_symbol(df, events):
    h = df['high'].values; l = df['low'].values; c = df['close'].values
    atr = atr_series(h, l, c)
    n = len(c)
    sw = swings(h, l)

    # Incrementally cluster confirmed swings into levels; snapshot a test each time a
    # swing JOINS an existing level (that's a level with a known tag to evaluate forward).
    levels = []  # each: dict(price, count, has_high, has_low, last_confirm)
    for pivot_idx, confirm_idx, price, is_high in sw:
        a = atr[pivot_idx] if atr[pivot_idx] > 0 else price * 0.003
        thr = max(price * 0.003, a * 0.1)
        # drop stale levels
        levels = [lv for lv in levels if confirm_idx - lv['last_confirm'] <= MAX_LEVEL_AGE]
        match = None
        for lv in levels:
            if abs(lv['price'] - price) < thr:
                match = lv; break
        if match is None:
            levels.append(dict(price=price, count=1,
                               has_high=is_high, has_low=not is_high, last_confirm=confirm_idx))
            continue
        # This swing re-tests an existing level. Snapshot the tag BEFORE updating, then
        # evaluate the forward retest outcome from this confirm bar.
        tag_count = match['count']
        flip = match['has_high'] and match['has_low']
        outcome = forward_outcome(h, l, c, atr, confirm_idx, match['price'], is_resistance=is_high)
        if outcome is not None:
            held, bounce = outcome
            events.append((tag_count, flip, is_high, held, bounce))
        # update level
        match['count'] += 1
        match['has_high'] = match['has_high'] or is_high
        match['has_low'] = match['has_low'] or (not is_high)
        match['price'] = (match['price'] * tag_count + price) / (tag_count + 1)
        match['last_confirm'] = confirm_idx


def forward_outcome(h, l, c, atr, start, level, is_resistance):
    """Require price to leave the zone then re-enter (a real retest), then classify."""
    n = len(c)
    a0 = atr[start] if atr[start] > 0 else level * 0.003
    touch = TOUCH_ATR * a0
    left = False
    for j in range(start + 1, min(start + MAX_LEVEL_AGE, n)):
        dist = min(abs(h[j] - level), abs(l[j] - level), abs(c[j] - level))
        in_zone = (l[j] - touch) <= level <= (h[j] + touch)
        if not left:
            if abs(c[j] - level) > 1.5 * touch:
                left = True
            continue
        if not in_zone:
            continue
        # retest at bar j — approach direction from the pre-retest close
        approach_below = c[j-1] < level
        a = atr[j] if atr[j] > 0 else level * 0.003
        brk = BREAK_ATR * a; react = REACT_ATR * a
        best_reject = 0.0
        for k in range(j, min(j + HORIZON, n)):
            if approach_below:
                if c[k] > level + brk: return (False, 0.0)          # broke up
                best_reject = max(best_reject, (level - l[k]) / a)   # pushed back down
            else:
                if c[k] < level - brk: return (False, 0.0)          # broke down
                best_reject = max(best_reject, (h[k] - level) / a)   # pushed back up
            if best_reject * a >= react:
                return (True, best_reject)
        return None  # unresolved
    return None


def sample_control(df, sw, events_ctrl, rng):
    """CONTROL: random horizontal price lines that are NOT on any swing. Same forward
    outcome logic. If these hold as often as real swing levels, then 'level holds' is just
    a property of the price process and the swing structure adds nothing."""
    h = df['high'].values; l = df['low'].values; c = df['close'].values
    atr = atr_series(h, l, c)
    n = len(c)
    swing_prices = np.array([s[2] for s in sw]) if sw else np.array([])
    for start in range(N_PIVOT + 5, n - HORIZON - 2, 7):   # sample every 7 bars
        a = atr[start]
        if a <= 0: continue
        for _ in range(2):
            dist = rng.uniform(0.5, 3.0) * a
            side = 1 if rng.random() > 0.5 else -1
            Lp = c[start] + side * dist
            if Lp <= 0: continue
            thr = max(Lp * 0.003, a * 0.1)
            if swing_prices.size and np.min(np.abs(swing_prices - Lp)) < thr * 2:
                continue  # too close to a real swing — not a clean control
            out = forward_outcome(h, l, c, atr, start, Lp, is_resistance=(side > 0))
            if out is not None:
                held, bounce = out
                events_ctrl.append((held, bounce, dist / a))


def summarize_control(name, ctrl, real_hold, real_n):
    if not ctrl:
        print(f"  {name} control: no events"); return
    d = pd.DataFrame(ctrl, columns=['held', 'bounce', 'dist'])
    base = d['held'].mean() * 100
    print(f"\n  CONTROL (random non-level lines): HOLD {base:.1f}%  (n={len(d):,})")
    print(f"  REAL swing levels:                HOLD {real_hold:.1f}%  (n={real_n:,})")
    print(f"  → swing levels hold {real_hold - base:+.1f}pp vs random lines")
    # matched by distance bucket (controls for how far the line sits from price)
    print("  by distance from price at test (ATR):")
    for lo, hi in [(0.5, 1.0), (1.0, 1.5), (1.5, 2.5), (2.5, 3.0)]:
        dd = d[(d['dist'] >= lo) & (d['dist'] < hi)]
        if len(dd): print(f"    {lo:.1f}-{hi:.1f}: control HOLD {dd['held'].mean()*100:.1f}% (n={len(dd):,})")


def summarize(name, events):
    if not events:
        print(f"{name}: no events"); return
    df = pd.DataFrame(events, columns=['count', 'flip', 'is_res', 'held', 'bounce'])
    n = len(df); base = df['held'].mean() * 100
    print(f"\n{'='*64}\n{name}: {n:,} resolved level retests | baseline HOLD rate {base:.1f}%\n{'='*64}")

    print("  by test-count (the WORN heuristic — does more tests → more BREAK?):")
    df['bucket'] = np.where(df['count'] >= 3, '3+', df['count'].astype(str))
    for b in ['1', '2', '3+']:
        d = df[df['bucket'] == b]
        if len(d): print(f"    {b:>3} tests: HOLD {d['held'].mean()*100:5.1f}%  bounce {d['bounce'].median():.2f} ATR  (n={len(d):,})")

    print("  by FLIP_ROLE (does broken-and-reclaimed → stronger HOLD?):")
    for fv, lab in [(True, 'flip'), (False, 'non-flip')]:
        d = df[df['flip'] == fv]
        if len(d): print(f"    {lab:>8}: HOLD {d['held'].mean()*100:5.1f}%  bounce {d['bounce'].median():.2f} ATR  (n={len(d):,})")

    print("  by side:")
    for sv, lab in [(True, 'resistance'), (False, 'support')]:
        d = df[df['is_res'] == sv]
        if len(d): print(f"    {lab:>10}: HOLD {d['held'].mean()*100:5.1f}%  (n={len(d):,})")


def main():
    rng = np.random.RandomState(42)
    for market, path in CANDLES.items():
        df = pd.read_csv(path)
        events = []; ctrl = []
        for sym, g in df.groupby('symbol'):
            g = g.sort_values('timestamp').reset_index(drop=True)
            if len(g) < 60: continue
            sw = swings(g['high'].values, g['low'].values)
            evaluate_symbol(g, events)
            sample_control(g, sw, ctrl, rng)
        summarize(market.upper(), events)
        if events:
            real_hold = np.mean([e[3] for e in events]) * 100
            summarize_control(market.upper(), ctrl, real_hold, len(events))


if __name__ == '__main__':
    main()
