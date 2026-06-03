#!/usr/bin/env python3
"""THE fork: is the path-dependence edge DRIFT (trend) or VARIANCE-structure (clustering+convexity)?
Condition on high score AND the first ±0.5 ATR excursion from entry, then measure the SUBSEQUENT
behavior FROM that excursion point, split by excursion direction:
  - conditional DRIFT  E[ signed return in the excursion direction | first move was that way ]
  - continuation first-passage: P(extend +1 ATR further BEFORE retracing -1 ATR)  [null 50%]
  - forward |move| (variance present?) so 'no drift' isn't just 'nothing happens'
DRIFT hypothesis: up-excursion -> +drift, down-excursion -> -drift, continuation >> 50%.
VARIANCE hypothesis: drift ~ 0 both sides, continuation ~ 50%, but |move| elevated.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
WIN = 30
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def measure(entry, atr, h, l, c):
    up, dn = entry + 0.5 * atr, entry - 0.5 * atr
    je, d = -1, 0
    for j in range(len(h)):
        hu, hd = h[j] >= up, l[j] <= dn
        if hu and hd: return None           # ambiguous same-bar — drop
        if hu: d, je = 1, j; break
        if hd: d, je = -1, j; break
    if je < 0: return None                   # never moved 0.5 ATR
    e0 = entry + d * 0.5 * atr
    cont_b, rev_b = e0 + d * atr, e0 - d * atr
    cont = None
    for j in range(je, len(h)):              # conservative: count revert first
        if d == 1:
            if l[j] <= rev_b: cont = False; break
            if h[j] >= cont_b: cont = True; break
        else:
            if h[j] >= rev_b: cont = False; break
            if l[j] <= cont_b: cont = True; break

    def dr(k):
        i = je + k
        return None if i >= len(c) else (c[i] - e0) * d / atr
    return d, cont, dr(6), dr(12), dr(6)


def report(tag, recs):
    for dirn, name in [(1, 'first move UP   '), (-1, 'first move DOWN '), (0, 'BOTH combined   ')]:
        r = [x for x in recs if (dirn == 0 or x[0] == dirn)]
        if not r: continue
        cont = [x[1] for x in r if x[1] is not None]
        d6 = [x[2] for x in r if x[2] is not None]
        d12 = [x[3] for x in r if x[3] is not None]
        a6 = [abs(x[4]) for x in r if x[4] is not None]
        print(f"  {name}  n={len(r):>7,}  continue%={np.mean(cont)*100:>4.0f}%  "
              f"drift@24h={np.mean(d6):>+6.3f}  drift@48h={np.mean(d12):>+6.3f}  |move@24h|={np.mean(a6):>4.2f} ATR")


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & df['fwdMaxFavR72H'].notna()].copy()
    df['bigTail'] = (df['fwdMaxFavR72H'] >= 5).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)
    cidx = candle_index()
    edges = np.linspace(df['timestamp'].min() + (df['timestamp'].max() - df['timestamp'].min()) * 0.35, df['timestamp'].max(), 6)
    parts = []
    for k in range(len(edges) - 1):
        tr = df[df['timestamp'] < edges[k] - 14 * 86400]; te = df[(df['timestamp'] >= edges[k]) & (df['timestamp'] < edges[k + 1])].copy()
        if len(tr) < 8000 or len(te) < 200: continue
        mt = H.make_model(); mt.fit(tr[H.FEATURES].fillna(0), tr['bigTail'])
        te['tailP'] = mt.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        parts.append(te)
    d = pd.concat(parts, ignore_index=True)
    d['gate'] = d['tailP'] >= d.groupby(d.index // 10**9)['tailP'].transform(lambda x: x.quantile(0.90)) if False else d['tailP'] >= d['tailP'].quantile(0.90)

    def collect(sub):
        recs = []
        for _, row in sub.iterrows():
            sym = row['symbol']
            if sym not in cidx or row['atrPercent'] <= 0: continue
            ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
            if s >= len(ct) or s == 0: continue
            e = min(s + WIN, len(ct)); h, l, c = cidx[sym]['high'][s:e], cidx[sym]['low'][s:e], cidx[sym]['close'][s:e]
            if len(h) < 8: continue
            en = cidx[sym]['close'][s - 1]; m = measure(en, row['atrPercent'] / 100 * en, h, l, c)
            if m: recs.append(m)
        return recs

    print("null: continue% = 50% (symmetric ±1 ATR from the excursion point), drift = 0.000\n")
    print("TAIL-GATED (high score):")
    report('gated', collect(d[d['gate']]))
    print("\nALL BARS (baseline, any score):")
    report('all', collect(d.sample(n=min(80000, len(d)), random_state=1)))
    print("\nRead: continue% > 50% AND signed drift > 0 on BOTH sides => DRIFT/trend persistence. "
          "continue% ~ 50% AND drift ~ 0 (with |move| elevated) => VARIANCE structure (clustering+"
          "convexity), NOT trend — pyramiding monetizes path geometry, not directional continuation.")


if __name__ == '__main__':
    main()
