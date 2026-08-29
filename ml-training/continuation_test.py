#!/usr/bin/env python3
"""Part 9: `continuation`, reconstructed from the actual signal list.

Pre-declared in docs/research/envelope-rules.md (frozen at 49b0420).

Part 7 used `momentumAlignment` (wrong variable), then reconstructed 2 of 3 signals and called `< 3`
untestable. The real list is exactly three, all reconstructible:

  1 volume_confirming   last three 4H candles same direction AND mean(last 3 vol)/mean(prior 20) > 1.2
  2 ema_stack_aligned   4H EMA20>EMA50>EMA200 (or reverse)     -> hStackBull / hStackBear
  3 funding_supports    4H bias + fundingRatePercent beyond -+0.005 (raw -+0.00005)  [CRYPTO ONLY]

Signal 1 is rebuilt from the hourly klines aggregated to 4H, which is what makes this possible now.

Reports BOTH global lift (the Parts 1-7 bar) and the per-blocked-bar penalty (the Part 8 correction),
because global lift is capped at fire_rate x spread and cannot see a sparse condition.
"""
import glob, os
import numpy as np, pandas as pd

BAR = 4 * 3600


def four_h_signals(pp, bar_ts):
    """Rebuild signal 1 at every 4H bar from the hourly path.

    Buckets the hourly bars by the FEATURE timestamps rather than by a UTC floor. Crypto 4H bars are
    UTC-aligned so either works, but stock "4H" bars are ET-session aggregated (13:00/17:00 UTC, and
    14:00/18:00 under DST) and floor to the wrong bucket -- which silently produced a zero-row join.
    """
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    edges = np.sort(np.asarray(bar_ts, dtype=np.int64))
    j = np.searchsorted(edges, p.ts.to_numpy(np.int64), side='right') - 1
    p = p[j >= 0].copy()
    p['b'] = edges[j[j >= 0]]
    g = p.groupby('b').agg(o=('open', 'first'), c=('close', 'last'), v=('volume', 'sum'))
    g = g[g.v.notna()]
    if len(g) < 25:
        return None
    up = (g.c > g.o).to_numpy()
    dn = (g.c < g.o).to_numpy()
    vol = g.v.to_numpy(np.float64)
    n = len(g)
    all_up = np.zeros(n, bool); all_dn = np.zeros(n, bool); ratio = np.full(n, np.nan)
    # window is the last 3 bars INCLUSIVE of the current one, prior 20 before those -- matching
    # `candles.slice(-3)` against `candles.slice(0,-3).slice(-20)`.
    for i in range(23, n):
        all_up[i] = up[i - 2:i + 1].all()
        all_dn[i] = dn[i - 2:i + 1].all()
        pa = vol[i - 22:i - 2].mean()
        if pa > 0:
            ratio[i] = vol[i - 2:i + 1].mean() / pa
    return pd.DataFrame({'ts': g.index.to_numpy(), 'all_up': all_up, 'all_dn': all_dn, 'volr': ratio})


def build(feat_dir, path_dir, is_crypto):
    rows = []
    for fp in sorted(glob.glob(f'{feat_dir}/*.csv')):
        sym = os.path.basename(fp)[:-4]
        pp = f'{path_dir}/{sym}.csv'
        if not os.path.exists(pp):
            continue
        need = ['timestamp', 'fourHBias', 'hStackBull', 'hStackBear', 'fundingRateRaw']
        f = pd.read_csv(fp, low_memory=False)
        cols = [c for c in need if c in f.columns]
        f = f[cols].copy()
        tr = f['timestamp'].to_numpy(np.int64)
        f['ts'] = (tr // 1000) if tr[0] > 1e12 else tr
        s = four_h_signals(pp, f['ts'].to_numpy(np.int64))
        if s is None:
            continue
        f = f.drop(columns=['timestamp']).merge(s, on='ts', how='inner')
        f['symbol'] = sym
        rows.append(f)
    return pd.concat(rows, ignore_index=True)


def run(market, feat_dir, path_dir, entry_pkl, is_crypto):
    print(f'\n{"=" * 78}\n{market}\n{"=" * 78}')
    d = pd.read_pickle(entry_pkl)
    key = ['symbol', 'timestamp']
    c = build(feat_dir, path_dir, is_crypto).rename(columns={'ts': 'timestamp'})
    d = d.merge(c, on=key, how='inner').sort_values('timestamp').reset_index(drop=True)
    d['dt'] = pd.to_datetime(d.timestamp, unit='s')

    bull = d.fourHBias.astype(str).str.contains('Bullish', case=False, na=False)
    bear = d.fourHBias.astype(str).str.contains('Bearish', case=False, na=False)
    s1 = ((bull & d.all_up) | (bear & d.all_dn)) & (d.volr > 1.2)
    s2 = (bull & (d.hStackBull == 1)) | (bear & (d.hStackBear == 1))
    if is_crypto and 'fundingRateRaw' in d:
        fr = d.fundingRateRaw.fillna(0)
        s3 = (bull & (fr < -0.00005)) | (bear & (fr > 0.00005))
    else:
        s3 = pd.Series(False, index=d.index)
    cont = s1.astype(int) + s2.astype(int) + s3.astype(int)
    print(f'{len(d):,} bars, {d.symbol.nunique()} symbols  ({d.dt.min().date()} → {d.dt.max().date()})')
    print(f'signal fire rates: volume {s1.mean():.1%}  ema_stack {s2.mean():.1%}  funding {s3.mean():.1%}')
    print(f'continuation count: {cont.value_counts().sort_index().to_dict()}')
    print(f'  --> P(count == 3) = {(cont == 3).mean():.4%}   P(count >= 2) = {(cont >= 2).mean():.2%}')

    periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')
    CONDS = {'continuation < 3 (cap MODERATE)': cont < 3,
             'continuation < 2 (cap LOW)': cont < 2}
    for side in ('SHORT', 'LONG'):
        col = f'd0.25_{side}_oppR'
        if col not in d: continue
        print(f'\n  --- {side} ---')
        print(f'  {"condition":>34}{"fires":>8}{"blocked":>10}{"kept":>10}{"lift":>9}'
              f'{"maxlift":>9}{"per+":>7}{"penalty":>10}{"pen+":>6}')
        for name, fires in CONDS.items():
            if fires.sum() < 500 or (~fires).sum() < 500:
                print(f'  {name:>34}{fires.mean():>8.1%}   DEGENERATE — cannot fire both ways')
                continue
            blocked, kept = d.loc[fires, col].mean(), d.loc[~fires, col].mean()
            lift = kept - d[col].mean()
            maxlift = fires.mean() * (kept - blocked)      # the ceiling of the global metric
            pos = tot = penpos = pentot = 0
            for i in range(len(periods) - 1):
                w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
                if w.sum() < 2000: continue
                k, a = d.loc[w & ~fires, col].mean(), d.loc[w, col].mean()
                if np.isfinite(k) and np.isfinite(a): tot += 1; pos += (k - a) >= 0
                bl, kp = d.loc[w & fires, col].mean(), d.loc[w & ~fires, col].mean()
                if np.isfinite(bl) and np.isfinite(kp): pentot += 1; penpos += (kp - bl) >= 0
            penalty = kept - blocked                       # per-blocked-bar, the Part 8 statistic
            print(f'  {name:>34}{fires.mean():>8.1%}{blocked:>10.4f}{kept:>10.4f}{lift:>+9.4f}'
                  f'{maxlift:>+9.4f}{f"{pos}/{tot}":>7}{penalty:>+10.4f}{f"{penpos}/{pentot}":>6}')


run('CRYPTO — all three signals reachable', 'csv_exports_v14', 'vision_backfill/klines_long',
    'level_entry_rows.pkl.gz', True)
run('STOCKS — funding unreachable, count maxes at 2', 'csv_exports_v14_stocks', 'stock_klines',
    'stock_entry_rows.pkl.gz', False)
