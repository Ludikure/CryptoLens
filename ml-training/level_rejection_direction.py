#!/usr/bin/env python3
"""
RESULT (2026-07-14): REJECTED — a coin flip. Continuation hit-rate 50.1-50.4% on BOTH markets,
BOTH horizons (3 & 4 bars), loose AND strict-wick rejections. vs base drift: crypto support→LONG
+1.8pp (just the known upward drift), resistance→SHORT −1 to −1.7pp (WORSE than base). Gross EV
+0.005..+0.059% crypto / ~0 stock → break-even round-trip ≤0.06%, below Binance ~0.10%. Walk-forward
net EV @0.10% fees: 0-2/6 positive folds, negative in EVERY calendar year incl. the 2022 bear.
Consistent with strategy-levels: a level is a real REACTION location (+4.3pp hold rate) but the
reaction carries NO tradeable directional EV. "Observed event, not a prediction" did not rescue it.

Does a CONFIRMED rejection at a major S/R level predict tradeable short-horizon DIRECTION?

The open question (never measured): level_validation.py measured the HOLD-vs-break RATE at a
level (~88.9% crypto, +4.3pp over random — a real but small reaction). It did NOT measure the
EXECUTION EV of trading the continuation AWAY from the level after an OBSERVED rejection, over a
short (3-4 bar) horizon, net of fees. That's this script.

Motivation: a rejection is an OBSERVED EVENT at a KNOWN location (supply/demand showed up), not a
momentum prediction — the category that could carry an edge where direction-prediction (a proven
coin flip here) does not. Honest prior: the level edge is small and short horizons are where fees
bite hardest, so expect THIN / fee-gated. We measure it instead of assuming.

Setup (reuses level_validation's validated detection — swing fractals N=3, ATR cluster):
  EVENT  a bar pokes a major level (high reaches within TOUCH_ATR of a resistance the price is
         below / low reaches a support the price is above) AND closes back away by >= REJECT_ATR
         → a confirmed rejection candle.
  TRADE  enter the continuation at the rejection close (resistance→SHORT, support→LONG); stop just
         beyond the rejection wick (level side); risk R = |entry-stop|.
  MEASURE over the next N bars:
    (1) DIRECTION: is close[i+N] on the continuation side? (the pure question — vs the base drift)
    (2) EXECUTION: fixed target at TARGET_R×R with bar-by-bar fills (stop-first on same-bar tie),
        else exit at bar N close. Gross return % and R.
    (3) COST CURVE: net EV per trade across round-trip fee tiers → the break-even fee.
  Split by market / side / walk-forward calendar fold (incl. the 2022 bear). Pre-registered kill
  line: net EV after realistic fees (Binance ~0.10% round trip) must be > 0 in a MAJORITY of folds.

Run:  python3 level_rejection_direction.py
"""
import numpy as np
import pandas as pd
from datetime import datetime, timezone

# --- level detection (mirrors level_validation.py / MarketStructure.swift) ---
N_PIVOT = 3
ATR_PERIOD = 14
# --- rejection event ---
TOUCH_ATR = 0.25       # bar poked within this of the level = touched the zone
REJECT_ATR = 0.50      # bar closed back this far away from the level = confirmed rejection
STRICT_WICK = True     # require the wick to actually REACH/pierce the level (true rejection), not just come near
PROX_ATR = 2.0         # only consider levels within this many ATR of price (IN_PLAY)
MAX_LIFE = 240         # a level is tradeable up to this many bars after its last confirm (40d/4h)
COOLDOWN = 6           # bars to skip re-triggering the SAME level (don't double-count one rejection)
STOP_BUFFER_ATR = 0.25 # stop sits this far beyond the rejection wick
# --- trade ---
HORIZONS = (3, 4)      # "3 or 4 next bars is good enough" — measure both
TARGET_R = 1.0         # fixed target as a multiple of risk
FEE_TIERS = (0.0, 0.05, 0.10, 0.15, 0.20, 0.25)   # round-trip cost, % of notional
CANDLES = {'crypto': 'crypto_candles_4h.csv.gz', 'stock': 'stock_candles_4h.csv.gz'}


def atr_series(h, l, c):
    pc = np.roll(c, 1); pc[0] = c[0]
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    return pd.Series(tr).rolling(ATR_PERIOD, min_periods=1).mean().values


def swings(h, l):
    out = []
    n = len(h)
    for i in range(N_PIVOT, n - N_PIVOT):
        hi, lo = h[i], l[i]
        if all(h[i-k] < hi for k in range(1, N_PIVOT+1)) and all(h[i+k] < hi for k in range(1, N_PIVOT+1)):
            out.append((i + N_PIVOT, hi, True))    # (confirm_idx, price, is_high)
        if all(l[i-k] > lo for k in range(1, N_PIVOT+1)) and all(l[i+k] > lo for k in range(1, N_PIVOT+1)):
            out.append((i + N_PIVOT, lo, False))
    out.sort(key=lambda s: s[0])
    return out


def build_levels(sw, atr):
    """Incremental ATR-clustering of confirmed swings → levels (same rule as level_validation)."""
    levels = []   # dict(price, first, last, count)
    for confirm_idx, price, is_high in sw:
        a = atr[min(confirm_idx, len(atr)-1)]
        thr = max(price * 0.003, (a if a > 0 else price*0.003) * 0.1)
        match = None
        for lv in levels:
            if abs(lv['price'] - price) < thr:
                match = lv; break
        if match is None:
            levels.append(dict(price=price, first=confirm_idx, last=confirm_idx, count=1))
        else:
            match['price'] = (match['price'] * match['count'] + price) / (match['count'] + 1)
            match['count'] += 1
            match['last'] = confirm_idx
    return levels


def resolve_trade(h, l, c, entry_i, entry, stop, direction, horizon):
    """Bar-by-bar fill over the next `horizon` bars. Returns (exit_price, hit) where hit in
    {'target','stop','timeout'}. Same-bar stop+target tie resolves to STOP (conservative)."""
    risk = abs(entry - stop)
    if risk <= 0:
        return None
    target = entry + direction * TARGET_R * risk
    n = len(c)
    for k in range(entry_i + 1, min(entry_i + 1 + horizon, n)):
        hit_stop = (l[k] <= stop) if direction > 0 else (h[k] >= stop)
        hit_tgt = (h[k] >= target) if direction > 0 else (l[k] <= target)
        if hit_stop:                      # stop-first on ambiguity
            return (stop, 'stop')
        if hit_tgt:
            return (target, 'target')
    return (c[min(entry_i + horizon, n - 1)], 'timeout')


def year_of(ts):
    # timestamps are ms epoch (Binance/Yahoo 4h archive). Guard for seconds just in case.
    t = ts / 1000 if ts > 1e11 else ts
    return datetime.fromtimestamp(t, tz=timezone.utc).year


def evaluate_symbol(df, rows, base):
    h = df['high'].values; l = df['low'].values; c = df['close'].values
    ts = df['timestamp'].values
    atr = atr_series(h, l, c)
    n = len(c)
    maxH = max(HORIZONS)
    sw = swings(h, l)
    if not sw:
        return
    levels = build_levels(sw, atr)
    lv_price = np.array([lv['price'] for lv in levels])
    lv_first = np.array([lv['first'] for lv in levels])
    lv_last = np.array([lv['last'] for lv in levels])
    lv_cool = np.full(len(levels), -10**9)   # last-trigger bar per level

    # base drift: P(close moves up) over each horizon, for the matched control
    for H in HORIZONS:
        up = (c[H:] > c[:-H])
        base[H]['up'] += int(up.sum()); base[H]['n'] += int(up.size)

    start = N_PIVOT + ATR_PERIOD
    for i in range(start, n - maxH):
        a = atr[i]
        if a <= 0:
            continue
        pc = c[i-1]
        # active, in-play levels: confirmed before now, not stale, within PROX_ATR of price
        active = (lv_first <= i-1) & (i - lv_last <= MAX_LIFE) & (np.abs(lv_price - c[i]) <= PROX_ATR * a) & (i - lv_cool >= COOLDOWN)
        if not active.any():
            continue
        touch = TOUCH_ATR * a; reject = REJECT_ATR * a; buf = STOP_BUFFER_ATR * a
        for j in np.nonzero(active)[0]:
            L = lv_price[j]
            poke_hi = (h[i] >= L) if STRICT_WICK else (h[i] >= L - touch)   # wick reached the level
            poke_lo = (l[i] <= L) if STRICT_WICK else (l[i] <= L + touch)
            if pc < L:                              # level acts as RESISTANCE (price below it)
                if poke_hi and c[i] <= L - reject:   # pierced up into it, closed back below
                    direction = -1
                    entry = c[i]; stop = max(L, h[i]) + buf
                else:
                    continue
            elif pc > L:                            # level acts as SUPPORT (price above it)
                if poke_lo and c[i] >= L + reject:   # pierced down into it, closed back above
                    direction = 1
                    entry = c[i]; stop = min(L, l[i]) - buf
                else:
                    continue
            else:
                continue
            risk = abs(entry - stop)
            if risk <= 0 or risk > 5 * a:           # sanity: skip degenerate/huge-risk events
                continue
            lv_cool[j] = i
            rec = dict(market_year=year_of(ts[i]), side='res' if direction < 0 else 'sup', direction=direction)
            # (1) pure direction at each horizon
            for H in HORIZONS:
                rec[f'dir{H}'] = 1 if (c[i+H] - entry) * direction > 0 else 0
            # (2) execution EV at the primary horizon (first in HORIZONS) with fixed target
            for H in HORIZONS:
                r = resolve_trade(h, l, c, i, entry, stop, direction, H)
                exit_px = r[0]
                rec[f'ret{H}'] = (exit_px - entry) / entry * direction * 100.0   # gross % return
                rec[f'R{H}'] = (exit_px - entry) / risk * direction
            rows.append(rec)


def cost_curve(df, H):
    print(f"    cost curve (net EV %/trade, horizon {H} bars):")
    col = f'ret{H}'
    g = df[col].mean()
    be = None
    for fee in FEE_TIERS:
        net = (df[col] - fee).mean()
        mark = ' <= BE' if (be is None and net < 0) else ''
        if be is None and net < 0:
            be = fee
        print(f"      fee {fee:.2f}%: net {net:+.4f}%{mark}")
    # linear break-even estimate (cost where EV crosses 0): gross EV / 1 (cost is linear, coeff 1)
    print(f"      gross EV {g:+.4f}% → break-even round-trip ≈ {g:.3f}%"
          f"  ({'BINANCE-VIABLE' if g > 0.10 else 'below Binance ~0.10%' if g > 0 else 'NEGATIVE gross'})")


def summarize(market, rows, base):
    if not rows:
        print(f"{market}: no rejection events"); return
    df = pd.DataFrame(rows)
    print(f"\n{'='*70}\n{market}: {len(df):,} confirmed rejection events\n{'='*70}")
    for H in HORIZONS:
        base_up = base[H]['up'] / base[H]['n']
        # matched control: LONG(sup) should beat base_up; SHORT(res) should beat (1-base_up)
        sup = df[df.direction == 1]; res = df[df.direction == -1]
        dir_all = df[f'dir{H}'].mean()
        print(f"\n  ── horizon {H} bars ──")
        print(f"    DIRECTION hit-rate (continuation): {dir_all*100:.1f}%   (n={len(df):,})")
        if len(sup):
            print(f"      support→LONG:      {sup[f'dir{H}'].mean()*100:.1f}%  vs base P(up)   {base_up*100:.1f}%  → {(sup[f'dir{H}'].mean()-base_up)*100:+.1f}pp  (n={len(sup):,})")
        if len(res):
            print(f"      resistance→SHORT:  {res[f'dir{H}'].mean()*100:.1f}%  vs base P(down) {(1-base_up)*100:.1f}%  → {(res[f'dir{H}'].mean()-(1-base_up))*100:+.1f}pp  (n={len(res):,})")
        # execution
        wins = (df[f'R{H}'] > 0).mean()
        print(f"    EXECUTION (stop-beyond-level, target {TARGET_R:.1f}R): win {wins*100:.1f}%  avg {df[f'R{H}'].mean():+.3f}R")
        cost_curve(df, H)
    # walk-forward: net EV at Binance 0.10% by calendar year (H = first horizon)
    H = HORIZONS[0]
    print(f"\n  WALK-FORWARD net EV %/trade @ 0.10% round-trip (horizon {H}):")
    folds = []
    for yr, gy in df.groupby('market_year'):
        net = (gy[f'ret{H}'] - 0.10).mean()
        folds.append(net > 0)
        flag = '  ← 2022 bear' if yr == 2022 else ''
        print(f"      {yr}: net {net:+.4f}%  (n={len(gy):,}){flag}")
    print(f"    → positive folds: {sum(folds)}/{len(folds)}  "
          f"[{'PASSES majority kill-line' if sum(folds) > len(folds)/2 else 'FAILS majority kill-line'}]")


def main():
    print(f"Rejection→direction backtest | touch {TOUCH_ATR} reject {REJECT_ATR} prox {PROX_ATR} "
          f"stop-buf {STOP_BUFFER_ATR} target {TARGET_R}R horizons {HORIZONS}")
    for market, path in CANDLES.items():
        df = pd.read_csv(path)
        rows = []
        base = {H: dict(up=0, n=0) for H in HORIZONS}
        for sym, g in df.groupby('symbol'):
            g = g.sort_values('timestamp').reset_index(drop=True)
            if len(g) < 60:
                continue
            evaluate_symbol(g, rows, base)
        summarize(market.upper(), rows, base)


if __name__ == '__main__':
    main()
