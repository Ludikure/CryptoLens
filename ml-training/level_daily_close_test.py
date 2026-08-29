#!/usr/bin/env python3
"""
Is a DAILY CLOSE a real level class, or just a visited price?

Pre-declared in docs/research/level-daily-close.md (committed BEFORE this ran).

Finding 4 of strategy-levels.md compared daily-close levels against random horizontal
lines 0.5-3.0 ATR from price. A daily close differs from that control in three ways at
once — it is a price the market traded at, it sits at distance 0 when it forms, and it
falls on a day boundary — and only the third is the hypothesis.

THE DECISIVE CONTRAST, which absorbs all three confounds at once:

    evaluate EVERY 4H close as a level, through identical logic, then split by whether
    that bar happens to be the last bar of its calendar day.

Both arms are 4H closes. Both are visited prices. Both sit at distance 0 at formation.
Both are evaluated from the same start bar by the same forward_outcome. The ONLY
difference is the calendar boundary. Exhaustive, perfectly matched, no sampling noise.

If day-boundary closes hold no better than the other closes, "daily close" is decoration
in exactly the sense the WORN/FLIP tags (Finding 1) and the Fibonacci ratios (Finding 5)
were decoration.

Run:  python3 level_daily_close_test.py
"""
import sys
import numpy as np
import pandas as pd

LV = __import__('level_validation')

HALF_YEAR = 'h'   # period label granularity


def periods(ts_ms):
    d = pd.to_datetime(ts_ms, unit='ms')
    return d.year.astype(str) + np.where(d.month <= 6, 'H1', 'H2')


def eff_n(df, col='held'):
    """Effective n under (symbol, period) block clustering.

    Levels overlap heavily and consecutive closes are autocorrelated, so nominal n
    overstates independence. Design effect from the between-block variance of the block
    means (Kish): n_eff = n / (1 + (m_bar - 1) * rho_intra), estimated via the ratio of
    the clustered variance of the mean to the iid variance of the mean.
    """
    g = df.groupby(['symbol', 'period'])[col].agg(['mean', 'count'])
    g = g[g['count'] >= 5]
    if len(g) < 3:
        return len(df), 1.0
    n = int(g['count'].sum())
    w = g['count'] / g['count'].sum()
    mu = float((w * g['mean']).sum())
    # clustered variance of the overall mean (between-block, weighted)
    var_clust = float(((w ** 2) * g['mean'].var(ddof=1)).sum() * len(g) / max(len(g) - 1, 1))
    var_iid = mu * (1 - mu) / n
    if var_clust <= 0 or var_iid <= 0:
        return n, 1.0
    deff = max(var_clust / var_iid, 1.0)
    return int(round(n / deff)), deff


def run(market, path, subsample=1):
    df_all = pd.read_csv(path)
    rows = []          # every 4H close evaluated as a level
    swing_rows = []    # 4H swing baseline
    ctrl_rows = []     # original random-line control
    rng = np.random.RandomState(11)

    syms = list(df_all.groupby('symbol'))
    for si, (sym, g) in enumerate(syms):
        g = g.sort_values('timestamp').reset_index(drop=True)
        if len(g) < 120:
            continue
        h = g['high'].values; l = g['low'].values; c = g['close'].values
        ts = g['timestamp'].values
        atr = LV.atr_series(h, l, c)
        n = len(c)
        per = periods(ts)

        # day-boundary flag: the LAST 4H bar of each calendar day (UTC), which is exactly
        # the bar resample(g,'D') picks as form_idx and whose close becomes the level.
        dt = pd.to_datetime(ts, unit='ms')
        hour = dt.hour.values
        day = dt.date
        is_last_of_day = np.zeros(n, dtype=bool)
        is_last_of_day[:-1] = day[:-1] != day[1:]
        is_last_of_day[-1] = True

        # ── ARM 1+2: every 4H close as a level, split by day boundary ──
        for i in range(LV.N_PIVOT, n - 2, subsample):
            out = LV.forward_outcome(h, l, c, atr, i, c[i], is_resistance=False)
            if out is None:
                continue
            rows.append((sym, per[i], bool(is_last_of_day[i]), int(hour[i]), out[0], out[1]))

        # ── ARM 3: 4H swing baseline (incumbent) ──
        sw = LV.swings(h, l)
        for pivot_idx, confirm_idx, price, is_high in sw:
            out = LV.forward_outcome(h, l, c, atr, confirm_idx, price, is_resistance=is_high)
            if out is not None:
                swing_rows.append((sym, per[confirm_idx], out[0]))

        # ── ARM 4: original random-line control ──
        LV.sample_control(g, sw, ctrl_rows, rng)

        if (si + 1) % 20 == 0:
            print(f"  ..{si+1}/{len(syms)} symbols", file=sys.stderr, flush=True)

    d = pd.DataFrame(rows, columns=['symbol', 'period', 'boundary', 'hour', 'held', 'bounce'])
    sw_df = pd.DataFrame(swing_rows, columns=['symbol', 'period', 'held'])
    ctrl = pd.DataFrame(ctrl_rows, columns=['held', 'bounce', 'dist'])

    print(f"\n{'='*72}\n{market.upper()} — is the DAILY BOUNDARY what makes a 'daily close' hold?\n{'='*72}")

    bnd = d[d['boundary']]; oth = d[~d['boundary']]
    for lab, sub in [('daily close (day-boundary 4H close)', bnd),
                     ('other 4H close  (NOT a day boundary)', oth)]:
        ne, deff = eff_n(sub)
        print(f"  {lab:<38} HOLD {sub['held'].mean()*100:5.2f}%   "
              f"n {len(sub):>8,}  eff_n {ne:>7,} (deff {deff:.1f})")
    gap = (bnd['held'].mean() - oth['held'].mean()) * 100
    print(f"  {'':<38} {'GAP':>5} {gap:+.2f}pp   <-- the hypothesis")

    ne_s, deff_s = eff_n(sw_df)
    print(f"\n  {'4H swing (incumbent)':<38} HOLD {sw_df['held'].mean()*100:5.2f}%   "
          f"n {len(sw_df):>8,}  eff_n {ne_s:>7,} (deff {deff_s:.1f})")
    print(f"  {'random line 0.5-3.0 ATR (orig ctrl)':<38} HOLD {ctrl['held'].mean()*100:5.2f}%   "
          f"n {len(ctrl):>8,}")
    print(f"  {'':<38} {'':>5} vs random: daily close {bnd['held'].mean()*100-ctrl['held'].mean()*100:+.2f}pp, "
          f"other 4H close {oth['held'].mean()*100-ctrl['held'].mean()*100:+.2f}pp")

    # ── EVERY hour bucket as its own arm ──
    # The day-boundary arm is entirely one hour of the day (20:00 UTC on crypto), and this
    # project already knows time-of-day carries signal (hourBucket is a feature; dayOfWeek is
    # crypto's top permutation feature). So boundary-vs-rest could be an hour effect wearing a
    # calendar hat. If the day boundary is the mechanism, its hour stands ALONE above the other
    # five. If the hours are flat, or ordered by something other than the boundary, it is not.
    print(f"\n  every hour bucket as its own arm (the boundary hour is marked <-):")
    hh = d.groupby('hour')['held'].agg(['mean', 'count']).sort_index()
    bhours = set(d[d['boundary']]['hour'].unique())
    for hr, row in hh.iterrows():
        if row['count'] < 200:
            continue
        mark = '  <- day boundary' if hr in bhours else ''
        print(f"    {int(hr):02d}:00  HOLD {row['mean']*100:5.2f}%  (n {int(row['count']):>8,}){mark}")
    nb = hh[[h not in bhours for h in hh.index]]
    if len(nb) and len(bhours):
        spread = (nb['mean'].max() - nb['mean'].min()) * 100
        bmean = d[d['boundary']]['held'].mean() * 100
        print(f"    spread across NON-boundary hours: {spread:.2f}pp   "
              f"| boundary hour sits {bmean - nb['mean'].max()*100:+.2f}pp vs the best non-boundary hour")

    # ── period consistency on the decisive gap ──
    print(f"\n  period consistency of the day-boundary gap (bar: >= 7 of 9 positive):")
    pos = 0; tot = 0
    for p, sub in d.groupby('period'):
        b = sub[sub['boundary']]; o = sub[~sub['boundary']]
        if len(b) < 100 or len(o) < 100:
            continue
        gp = (b['held'].mean() - o['held'].mean()) * 100
        tot += 1; pos += (gp > 0)
        print(f"    {p}  {gp:+6.2f}pp   (n {len(b):>6,} / {len(o):>7,})")
    print(f"    -> {pos} of {tot} periods positive")

    # ── control's own precision, since every '+X pp' in Finding 4 rests on it ──
    se = (ctrl['held'].mean() * (1 - ctrl['held'].mean()) / len(ctrl)) ** 0.5 * 100
    print(f"\n  original control se = {se:.2f}pp (2sigma = {2*se:.2f}pp) on n={len(ctrl):,}")
    return d, sw_df, ctrl


def main():
    sub = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    for market, path in LV.CANDLES.items():
        run(market, path, subsample=sub)


if __name__ == '__main__':
    main()
