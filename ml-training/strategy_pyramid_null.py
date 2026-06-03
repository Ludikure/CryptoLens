#!/usr/bin/env python3
"""Is the pyramiding gain REAL or an artifact? Two controls vs the single-shot/flat baseline:
 (1) CAPITAL: pyramiding deploys up to 3 units. Compare to flat 3x size (= 3 x single-shot),
     and report net-R per UNIT-BAR deployed (capital-normalized) so leverage can't masquerade.
 (2) SHUFFLE NULL: randomize the ORDER of each trade's forward bars (preserves the exact
     per-bar magnitude / fat-tail distribution, destroys momentum/continuation). If pyramiding
     still beats flat on shuffled paths -> it's fat-tail MAGNITUDE harvesting (robust, consistent
     with barrier-ordering). If the edge collapses on shuffle -> it was momentum (fragile).
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
HOLD = int(os.environ.get('HOLD', 30)); TRAIL = 2.0; ADD_K = 1.5; MAX_ADDS = 2
FEE, SLIP, FUND = [float(x) for x in os.environ.get('COSTS', '0.07,0.03,0.03').split(',')]
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')
RNG = np.random.RandomState(42)


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('open', 'high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def shuffle_path(en, o, h, l, c):
    """Rebuild the forward path from shuffled bars; each bar keeps its (close/open, hi/open,
    lo/open) multiplicative shape, only the SEQUENCE is permuted. Destroys order, keeps magnitudes."""
    n = len(o)
    rc, rh, rl = c / o, h / o, l / o
    order = RNG.permutation(n)
    no, nh, nl, nc = np.empty(n), np.empty(n), np.empty(n), np.empty(n)
    prev = en
    for k, i in enumerate(order):
        no[k] = prev; nc[k] = prev * rc[i]; nh[k] = prev * rh[i]; nl[k] = prev * rl[i]; prev = nc[k]
    return nh, nl, nc


def pyramid_R(direction, en, atr, h, l, c, max_adds):
    R = atr; cpu = (FEE + SLIP + FUND) / 100 * en / R
    n = min(HOLD, len(h)); units = [en]; ext = en; ubars = 0
    stop = en - R if direction == 1 else en + R
    nxt = en + ADD_K * atr if direction == 1 else en - ADD_K * atr
    for j in range(n):
        ubars += len(units)
        if (direction == 1 and l[j] <= stop) or (direction == -1 and h[j] >= stop):
            return sum((stop - u) * direction / R for u in units) - cpu * len(units), len(units), ubars
        fav = h[j] if direction == 1 else l[j]
        ext = max(ext, fav) if direction == 1 else min(ext, fav)
        while len(units) < 1 + max_adds and ((direction == 1 and ext >= nxt) or (direction == -1 and ext <= nxt)):
            units.append(nxt); nxt = nxt + ADD_K * atr if direction == 1 else nxt - ADD_K * atr
        stop = max(stop, ext - TRAIL * atr) if direction == 1 else min(stop, ext + TRAIL * atr)
    return sum((c[n - 1] - u) * direction / R for u in units) - cpu * len(units), len(units), ubars


def run(rows, paths):
    ss, py, units, ub_ss, ub_py = [], [], [], [], []
    for (en, a), (h, l, c) in zip(rows, paths):
        for d in (1, -1):
            r0, _, u0 = pyramid_R(d, en, a, h, l, c, 0)
            rp, npu, up = pyramid_R(d, en, a, h, l, c, MAX_ADDS)
            ss.append(r0); py.append(rp); units.append(npu); ub_ss.append(u0); ub_py.append(up)
    ss, py = np.array(ss), np.array(py); ubss, ubpy = np.array(ub_ss), np.array(ub_py)
    return (ss.mean(), py.mean(), np.mean(units),
            ss.sum() / ubss.sum(), py.sum() / ubpy.sum())   # net R per unit-bar (capital-normalized)


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & df['fwdMaxFavR72H'].notna()].copy()
    df['bigTail'] = (df['fwdMaxFavR72H'] >= 5).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)
    cidx = candle_index()
    edges = np.linspace(df['timestamp'].min() + (df['timestamp'].max() - df['timestamp'].min()) * 0.35, df['timestamp'].max(), 6)
    gated = []
    for k in range(len(edges) - 1):
        tr = df[df['timestamp'] < edges[k] - 14 * 86400]; te = df[(df['timestamp'] >= edges[k]) & (df['timestamp'] < edges[k + 1])].copy()
        if len(tr) < 8000 or len(te) < 200: continue
        mt = H.make_model(); mt.fit(tr[H.FEATURES].fillna(0), tr['bigTail'])
        te['tailP'] = mt.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        gated.append(te[te['tailP'] >= te['tailP'].quantile(0.90)])
    g = pd.concat(gated, ignore_index=True)
    rows, real, shuf = [], [], []
    for _, row in g.iterrows():
        sym = row['symbol']
        if sym not in cidx or row['atrPercent'] <= 0: continue
        ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
        if s >= len(ct) or s == 0: continue
        e = min(s + HOLD, len(ct)); o, h, l, c = (cidx[sym][q][s:e] for q in ('open', 'high', 'low', 'close'))
        if len(h) < 3: continue
        en = cidx[sym]['close'][s - 1]; a = row['atrPercent'] / 100 * en
        rows.append((en, a)); real.append((h, l, c)); shuf.append(shuffle_path(en, o, h, l, c))
    print(f"tail-gated {len(rows):,}, add {ADD_K} ATR/max {MAX_ADDS}, trail {TRAIL}, Binance ~{FEE+SLIP+FUND:.2f}%\n")
    print(f"{'paths':<12}{'single 1u':>11}{'pyramid':>10}{'avg units':>11}{'flat 3x':>10}"
          f"{'1u perUnitBar':>15}{'pyr perUnitBar':>16}")
    for tag, paths in [('REAL', real), ('SHUFFLED', shuf)]:
        ssm, pym, au, ssu, pyu = run(rows, paths)
        print(f"{tag:<12}{ssm:>+11.3f}{pym:>+10.3f}{au:>11.2f}{3*ssm:>+10.3f}{ssu:>+15.4f}{pyu:>+16.4f}")
    print("\nRead: 'perUnitBar' = capital-normalized (net R per unit held per bar). If pyramid's "
          "perUnitBar > single's on REAL *and* SHUFFLED, the edge is fat-tail magnitude harvesting "
          "via conditional sizing (robust). If pyramid≈flat-3x or collapses on SHUFFLED, it was "
          "leverage / momentum, not a new edge.")


if __name__ == '__main__':
    main()
