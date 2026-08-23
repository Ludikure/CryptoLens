#!/usr/bin/env python3
"""After an extreme one-sided liquidation cascade, does forward volatility rise or fall?

Runs the design frozen in docs/research/cascade-exhaustion.md. Thresholds are pre-declared.

Distinct from the rejected feature test: that asked whether liquidation info improves goodR in
GENERAL (it does not — redundant with ATR/volume). This asks a conditional TAIL question that a
tree ensemble would not surface, because trees fit the bulk rather than the extremes.
"""
import numpy as np, pandas as pd
from pathlib import Path

HERE = Path(__file__).parent
PCTL, DOMINANCE, FWD_H = 0.99, 0.70, 24
BAR_HI, BAR_LO, BAR_N = 1.25, 0.80, 100


def per_symbol(sym):
    lp = HERE/'candlefeed'/'liquidations'/f'{sym}.csv'
    kp = HERE/'vision_backfill'/'klines'/f'{sym}_1h.csv'
    if not (lp.exists() and kp.exists()) or lp.stat().st_size < 5000 or kp.stat().st_size < 50000:
        return None
    liq = pd.read_csv(lp)
    liq['ts'] = pd.to_datetime(liq['time'], format='mixed', utc=True).dt.floor('h')
    liq['usd'] = pd.to_numeric(liq['usd_value'], errors='coerce')
    g = liq.groupby(['ts','side'])['usd'].sum().unstack(fill_value=0)
    for c in ('buy','sell'):
        if c not in g: g[c] = 0.0
    g['tot'] = g['buy'] + g['sell']

    k = pd.read_csv(kp)
    k['ts'] = pd.to_datetime(k['ts'], utc=True)
    for c in ('high','low','close'):
        k[c] = pd.to_numeric(k[c], errors='coerce')
    k = k.dropna().sort_values('ts').reset_index(drop=True)
    k['atr24'] = (k['high'] - k['low']).rolling(24).mean()
    # forward 24h realised range, in trailing-ATR units — strictly forward of the bar
    k['fwd_range'] = (k['high'].shift(-1).rolling(FWD_H).max().shift(-(FWD_H-1))
                      - k['low'].shift(-1).rolling(FWD_H).min().shift(-(FWD_H-1))) / k['atr24']
    k['fwd_ret'] = (k['close'].shift(-FWD_H) / k['close'] - 1) * 100

    m = k.merge(g, left_on='ts', right_index=True, how='left').fillna({'buy':0,'sell':0,'tot':0})
    m = m.dropna(subset=['fwd_range','atr24'])
    if len(m) < 200: return None
    live = m[m['tot'] > 0]
    if len(live) < 50: return None
    thr = live['tot'].quantile(PCTL)
    m['cascade'] = m['tot'] >= thr
    m['side'] = np.where(m['sell'] >= DOMINANCE*m['tot'].replace(0,np.nan), 'long_liq',
                 np.where(m['buy'] >= DOMINANCE*m['tot'].replace(0,np.nan), 'short_liq', None))
    m['symbol'] = sym
    return m


def main():
    syms = sorted(p.stem for p in (HERE/'candlefeed'/'liquidations').glob('*.csv'))
    parts = [x for x in (per_symbol(s) for s in syms) if x is not None]
    a = pd.concat(parts, ignore_index=True)
    base = a.loc[~a['cascade'], 'fwd_range'].mean()
    print(f"{len(parts)} symbols, {len(a):,} symbol-hours")
    print(f"baseline forward 24h range: {base:.2f} ATR (non-cascade hours, n={(~a['cascade']).sum():,})\n")

    print(f"{'cascade side':<14}{'n':>7}{'fwd range':>12}{'ratio':>9}{'fwd ret %':>11}")
    out = {}
    for side, label in (('long_liq','long flush'), ('short_liq','short squeeze')):
        s = a[a['cascade'] & (a['side']==side)]
        if not len(s): continue
        v = s['fwd_range'].mean(); out[side] = (v/base, len(s), s['fwd_ret'].mean())
        print(f"{label:<14}{len(s):>7,}{v:>11.2f}A{v/base:>8.2f}x{s['fwd_ret'].mean():>10.2f}%")

    # Episode clustering — a violent week supplies many cascade hours; they are not independent.
    print()
    for side,label in (('long_liq','long flush'),('short_liq','short squeeze')):
        s = a[a['cascade'] & (a['side']==side)].sort_values(['symbol','ts'])
        if not len(s): continue
        eps=[]
        for sym,gp in s.groupby('symbol'):
            t=list(gp['ts']); v=list(gp['fwd_range']); cur=[v[0]]
            for i in range(1,len(t)):
                if (t[i]-t[i-1]).total_seconds() <= 6*3600: cur.append(v[i])
                else: eps.append(np.mean(cur)); cur=[v[i]]
            eps.append(np.mean(cur))
        rng=np.random.default_rng(42); bs=[np.mean(rng.choice(eps,len(eps),replace=True)) for _ in range(3000)]
        lo,hi=np.percentile(bs,[2.5,97.5])
        print(f"  {label:<14} {len(eps)} episodes  ratio {np.mean(eps)/base:.2f}x  95% CI [{lo/base:.2f}x, {hi/base:.2f}x]")

    print(f"\n{'='*62}\nPRE-DECLARED SHIP BAR (docs/research/cascade-exhaustion.md)\n{'='*62}")
    ok=True
    for side,label in (('long_liq','long flush'),('short_liq','short squeeze')):
        if side not in out: ok=False; continue
        r,n,_ = out[side]
        hit = (r>=BAR_HI or r<=BAR_LO) and n>=BAR_N
        ok &= hit
        print(f"  {label:<14} ratio {r:.2f}x (need >={BAR_HI} or <={BAR_LO}), n={n} (need >={BAR_N})  {'PASS' if hit else 'FAIL'}")
    print(f"\n  VERDICT: {'SUPPORTED' if ok else 'NOT SUPPORTED — file in rejected-hypotheses.md'}")


if __name__ == '__main__':
    main()
