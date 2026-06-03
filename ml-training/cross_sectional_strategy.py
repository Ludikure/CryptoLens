#!/usr/bin/env python3
"""Does cross-sectional TAIL ranking improve the convex strategy, or is it the ML_WIN trap again?
Compute the convex trailing-strategy net-R for EVERY symbol-day, then select at matched ~10%:
  - ABSOLUTE tail gate (current): tailP >= global 90th pct
  - X-SEC top-10%/day: each day take the day's highest-tailP decile  (relative selection)
  - X-SEC bottom-10%/day + RANDOM 10%/day: nulls
Same per-symbol-day R values, different selection. If x-sec top > absolute gate -> relative
selection is a real upgrade. If ~equal/worse -> ranking vol doesn't improve tradeable net-R.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
import lightgbm as lgb
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
HOLD = 30; TRAIL = 2.0; FEE, SLIP, FUND = 0.07, 0.03, 0.03   # Binance USDT ~0.13%
MIN_SYMS = 25; FRAC = 0.10
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')
RNG = np.random.RandomState(7)


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def trail(direction, en, atr, h, l, c):
    R = atr; cost = (FEE + SLIP + FUND) / 100 * en / R
    n = min(HOLD, len(h)); stop = en - R if direction == 1 else en + R; ext = en
    for j in range(n):
        if direction == 1 and l[j] <= stop: return (stop - en) / R - cost
        if direction == -1 and h[j] >= stop: return (en - stop) / R - cost
        ext = max(ext, h[j]) if direction == 1 else min(ext, l[j])
        stop = max(stop, ext - TRAIL * atr) if direction == 1 else min(stop, ext + TRAIL * atr)
    return (c[n - 1] - en) * direction / R - cost


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & df['fwdMaxFavR72H'].notna() & (df['atrPercent'] > 0)].copy()
    df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
    df = df.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)
    df['bigTail'] = (df['fwdMaxFavR72H'] >= 5).astype(int)
    df['di'] = pd.factorize(df.sort_values('timestamp')['date'])[0]
    df = df.sort_values('timestamp').reset_index(drop=True); df['di'] = pd.factorize(df['date'])[0]
    cidx = candle_index(); X = df[H.FEATURES].fillna(0).values
    ndays = df['di'].max() + 1; edges = [int(ndays * f) for f in (0.40, 0.55, 0.70, 0.85, 1.0)]
    out = []
    for i in range(3):
        trm = df['di'] < edges[i + 1]; tem = (df['di'] >= edges[i + 1]) & (df['di'] < edges[i + 2])
        if tem.sum() < 1000: continue
        tr, te = df[trm], df[tem]
        m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.03, subsample=0.8,
                               colsample_bytree=0.8, min_child_samples=20, reg_lambda=1.0,
                               n_jobs=-1, random_state=42, verbose=-1).fit(X[tr.index], tr['bigTail'])
        te = te.copy(); te['tailP'] = m.predict_proba(X[te.index])[:, 1]
        for _, row in te.iterrows():
            sym = row['symbol']
            if sym not in cidx: continue
            ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
            if s >= len(ct) or s == 0: continue
            e = min(s + HOLD, len(ct)); h, l, c = cidx[sym]['high'][s:e], cidx[sym]['low'][s:e], cidx[sym]['close'][s:e]
            if len(h) < 3: continue
            en = cidx[sym]['close'][s - 1]; a = row['atrPercent'] / 100 * en
            out.append((row['di'], row['tailP'], (trail(1, en, a, h, l, c) + trail(-1, en, a, h, l, c)) / 2))
    r = pd.DataFrame(out, columns=['di', 'tailP', 'R'])
    r = r.groupby('di').filter(lambda g: len(g) >= MIN_SYMS)
    print(f"symbol-days={len(r):,}, days={r['di'].nunique()}  | convex trailing, Binance ~{FEE+SLIP+FUND:.2f}%\n")

    thr = r['tailP'].quantile(1 - FRAC)
    def dayrank(g): return g.assign(rk=g['tailP'].rank(pct=True), rnd=RNG.permutation(len(g)) / len(g))
    rr = r.groupby('di', group_keys=False).apply(dayrank)
    sets = {
        'ALL symbol-days':            r['R'],
        f'ABSOLUTE gate (tailP≥{thr:.2f})': r[r['tailP'] >= thr]['R'],
        f'X-SEC top-{int(FRAC*100)}%/day':       rr[rr['rk'] >= 1 - FRAC]['R'],
        f'X-SEC bottom-{int(FRAC*100)}%/day':    rr[rr['rk'] < FRAC]['R'],
        f'RANDOM {int(FRAC*100)}%/day':          rr[rr['rnd'] >= 1 - FRAC]['R'],
    }
    base = sets[f'ABSOLUTE gate (tailP≥{thr:.2f})'].mean()
    print(f"  {'selection':<28}{'net R/signal':>13}{'n':>9}{'vs absolute':>13}")
    for k, v in sets.items():
        d = '' if 'ABSOLUTE' in k or 'ALL' in k else f"{(v.mean()-base)*1000:>+11.0f}m"
        print(f"  {k:<28}{v.mean():>+13.3f}{len(v):>9,}{d:>13}")
    print("\n→ X-SEC top vs ABSOLUTE gate is the verdict: > => relative selection upgrades the "
          "strategy; ≈ or < => ranking vol/tail doesn't improve tradeable net-R (selection already "
          "saturated by the absolute gate).")


if __name__ == '__main__':
    main()
