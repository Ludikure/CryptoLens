#!/usr/bin/env python3
"""
Do MONTHLY highs/lows hold better than an equivalent NON-calendar 30-day extreme?

Pre-declared in docs/research/level-monthly-extremes.md (committed BEFORE this ran).

A monthly high is three things at once — a visited price, an extreme of a ~30-day window,
and calendar-aligned — and only the third is the hypothesis. The matched control is the
trailing-W-bar high anchored at a bar that is NOT a month end, with the SAME W. Identical
object, different cut point.

Reports a 95% CI on every gap because the monthly arm is underpowered by construction
(there are only ~54 months per symbol on this tape). Verdict rule is pre-declared:
CI upper bound < +2.0pp -> NOT SUPPORTED; CI spanning +2.0pp -> INCONCLUSIVE.

Run:  python3 level_monthly_test.py
"""
import sys
import numpy as np
import pandas as pd

LV = __import__('level_validation')
CTRL_PER_MONTH = 3
EDGE_GUARD = 2          # control anchors stay >= this many bars off a month boundary


def periods(ts_ms):
    d = pd.to_datetime(ts_ms, unit='ms')
    return d.year.astype(str) + np.where(d.month <= 6, 'H1', 'H2')


def eff_n(df, col='held'):
    g = df.groupby(['symbol', 'period'])[col].agg(['mean', 'count'])
    g = g[g['count'] >= 5]
    if len(g) < 3:
        return len(df), 1.0
    n = int(g['count'].sum())
    w = g['count'] / g['count'].sum()
    mu = float((w * g['mean']).sum())
    var_clust = float(((w ** 2) * g['mean'].var(ddof=1)).sum() * len(g) / max(len(g) - 1, 1))
    var_iid = mu * (1 - mu) / n if 0 < mu < 1 else 0
    if var_clust <= 0 or var_iid <= 0:
        return n, 1.0
    deff = max(var_clust / var_iid, 1.0)
    return int(round(n / deff)), deff


def gap_ci(a, b, rng=None, B=2000):
    """95% CI on (mean(a) - mean(b)) in pp by SYMBOL-level block bootstrap.

    Replaces a Kish design-effect estimate, which broke down on the sparse monthly arms:
    with ~1,200 events spread over ~675 (symbol, period) cells, most cells fell under the
    minimum-count filter and the between-block variance became unstable, reporting eff_n of
    ~20 and CIs +/-15pp. Resampling whole symbols with replacement handles within-symbol
    dependence at any sparsity without needing a design effect at all, and keeps the two arms
    paired on the same resampled symbols so their shared symbol composition cancels.
    """
    rng = rng or np.random.RandomState(7)
    syms = np.array(sorted(set(a['symbol']) | set(b['symbol'])))
    if len(syms) < 5:
        return (a['held'].mean() - b['held'].mean()) * 100, float('nan'), float('nan')
    ga = {k: v['held'].values for k, v in a.groupby('symbol')}
    gb = {k: v['held'].values for k, v in b.groupby('symbol')}
    obs = (a['held'].mean() - b['held'].mean()) * 100
    draws = []
    for _ in range(B):
        pick = syms[rng.randint(0, len(syms), len(syms))]
        va = np.concatenate([ga[s] for s in pick if s in ga]) if any(s in ga for s in pick) else None
        vb = np.concatenate([gb[s] for s in pick if s in gb]) if any(s in gb for s in pick) else None
        if va is None or vb is None or len(va) < 10 or len(vb) < 10:
            continue
        draws.append((va.mean() - vb.mean()) * 100)
    if len(draws) < B // 4:
        return obs, float('nan'), float('nan')
    return obs, float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5))


def implied_n(sub, lo, hi):
    """Back an effective n out of the bootstrap CI width, so the power is legible."""
    p = sub['held'].mean()
    hw = (hi - lo) / 2 / 100
    if not np.isfinite(hw) or hw <= 0:
        return float('nan')
    return p * (1 - p) / (hw / 1.96) ** 2


def run(market, path):
    df_all = pd.read_csv(path)
    rows = []          # (symbol, period, arm, side, held)
    ctrl_line = []
    rng = np.random.RandomState(23)

    syms = list(df_all.groupby('symbol'))
    for si, (sym, g) in enumerate(syms):
        g = g.sort_values('timestamp').reset_index(drop=True)
        if len(g) < 200:
            continue
        h = g['high'].values; l = g['low'].values; c = g['close'].values
        ts = g['timestamp'].values
        atr = LV.atr_series(h, l, c)
        n = len(c)
        per = periods(ts)

        dt = pd.to_datetime(ts, unit='ms')
        ym = (dt.year * 100 + dt.month).values

        # month blocks: (start_pos, end_pos) inclusive
        blocks = []
        s0 = 0
        for i in range(1, n):
            if ym[i] != ym[i - 1]:
                blocks.append((s0, i - 1)); s0 = i
        blocks.append((s0, n - 1))

        def emit(arm, side, start, level):
            if start < LV.N_PIVOT or start >= n - 2 or level <= 0:
                return
            out = LV.forward_outcome(h, l, c, atr, start, level, is_resistance=(side == 'high'))
            if out is not None:
                rows.append((sym, per[start], arm, side, out[0]))

        for (a, b) in blocks:
            W = b - a + 1
            if W < 20 or b >= n - 2:
                continue
            # ── monthly arms: extreme of THIS calendar month, formed at its last bar ──
            emit('monthly', 'high', b, h[a:b + 1].max())
            emit('monthly', 'low',  b, l[a:b + 1].min())
            emit('monthly', 'close', b, c[b])

            # ── matched control: trailing-W extreme anchored INSIDE the month ──
            lo_anchor = a + EDGE_GUARD
            hi_anchor = b - EDGE_GUARD
            if hi_anchor <= lo_anchor:
                continue
            for _ in range(CTRL_PER_MONTH):
                i = int(rng.randint(lo_anchor, hi_anchor + 1))
                w0 = i - W + 1
                if w0 < 0:
                    continue
                emit('control', 'high', i, h[w0:i + 1].max())
                emit('control', 'low',  i, l[w0:i + 1].min())
                emit('control', 'close', i, c[i])

        LV.sample_control(g, LV.swings(h, l), ctrl_line, rng)
        if (si + 1) % 25 == 0:
            print(f"  ..{si+1}/{len(syms)}", file=sys.stderr, flush=True)

    d = pd.DataFrame(rows, columns=['symbol', 'period', 'arm', 'side', 'held'])
    line = pd.DataFrame(ctrl_line, columns=['held', 'bounce', 'dist'])
    base = line['held'].mean() * 100

    print(f"\n{'='*78}\n{market.upper()} — monthly extreme vs a matched NON-calendar 30-day extreme\n{'='*78}")
    print(f"  {'':<34}{'HOLD':>7}{'n':>9}{'eff_n':>8}{'gap vs matched':>17}{'95% CI':>18}")
    verdicts = {}
    for side in ['high', 'low', 'close']:
        m = d[(d['arm'] == 'monthly') & (d['side'] == side)]
        k = d[(d['arm'] == 'control') & (d['side'] == side)]
        if len(m) < 30 or len(k) < 30:
            continue
        gm, lo, hi = gap_ci(m, k)
        nm = implied_n(m, lo, hi); nk, _ = eff_n(k)
        lab = {'high': 'monthly HIGH', 'low': 'monthly LOW', 'close': 'monthly CLOSE'}[side]
        ctl = {'high': 'trailing-W high (non-month)', 'low': 'trailing-W low (non-month)',
               'close': 'close at non-month anchor'}[side]
        print(f"  {lab:<34}{m['held'].mean()*100:6.2f}%{len(m):>9,}{nm:>8,.0f}"
              f"{gm:>+15.2f}pp   [{lo:+.2f}, {hi:+.2f}]")
        print(f"  {'  vs '+ctl:<34}{k['held'].mean()*100:6.2f}%{len(k):>9,}{nk:>8,}")
        verdicts[side] = (gm, lo, hi)
        # period consistency
        pos = tot = 0
        for p, sub in d[d['side'] == side].groupby('period'):
            mm = sub[sub['arm'] == 'monthly']; kk = sub[sub['arm'] == 'control']
            if len(mm) < 40 or len(kk) < 40:
                continue
            tot += 1; pos += ((mm['held'].mean() - kk['held'].mean()) > 0)
        print(f"  {'  period consistency':<34}{pos} of {tot} periods positive")

    print(f"\n  random line 0.5-3.0 ATR (orig control): HOLD {base:.2f}%  (n={len(line):,})")
    for side in ['high', 'low', 'close']:
        m = d[(d['arm'] == 'monthly') & (d['side'] == side)]
        if len(m) >= 30:
            print(f"    monthly {side:<6} vs that random line: {m['held'].mean()*100-base:+.2f}pp")

    print(f"\n  PRE-DECLARED VERDICT RULE: CI upper bound < +2.0pp -> NOT SUPPORTED;")
    print(f"                             CI spanning +2.0pp   -> INCONCLUSIVE (underpowered)")
    for side, (gm, lo, hi) in verdicts.items():
        v = 'NOT SUPPORTED' if hi < 2.0 else ('INCONCLUSIVE — UNDERPOWERED' if lo < 2.0 else 'SUPPORTED')
        print(f"    monthly {side:<6}: gap {gm:+.2f}pp, CI upper {hi:+.2f}pp  ->  {v}")
    return d


def main():
    for market, path in LV.CANDLES.items():
        run(market, path)


if __name__ == '__main__':
    main()
