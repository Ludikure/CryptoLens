#!/usr/bin/env python3
"""First-passage / barrier-ordering test. For high-score bars, does the FAVORABLE barrier get
hit BEFORE the adverse one — more than a driftless random walk would give?
  - Volatility: P(+1.5 ATR ever reached in 72h)  -> should RISE with score (the real edge).
  - Ordering (+1.5/-1, long): P(+1.5 before -1).  Random-walk null = 1/(1.5+1) = 40%.
  - Ordering (+1/-1,  long): P(+1 before -1).      Random-walk null = 50%.
  - Ordering with a DIRECTIONAL CALL (daily Stoch cross sign): same, in the called direction.
If ordering sits at the null while volatility rises -> the model sees variance, not direction.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
HOLD = 18
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def first_passage(direction, entry, atr, up_atr, dn_atr, h, l):
    """fav = profit barrier (up_atr ATR in trade dir); adv = loss barrier (dn_atr ATR against).
    Conservative: if both touched in a bar, count adverse first."""
    if direction == 1:
        fav, adv = entry + up_atr * atr, entry - dn_atr * atr
        for j in range(min(HOLD, len(h))):
            if l[j] <= adv: return 'adv'
            if h[j] >= fav: return 'fav'
    else:
        fav, adv = entry - up_atr * atr, entry + dn_atr * atr
        for j in range(min(HOLD, len(h))):
            if h[j] >= adv: return 'adv'
            if l[j] <= fav: return 'fav'
    return 'neither'


def reached(direction, entry, atr, up_atr, h, l):
    """did the favorable barrier EVER get touched in the window (ignoring the adverse one)?"""
    bar = (h if direction == 1 else l)
    tgt = entry + up_atr * atr if direction == 1 else entry - up_atr * atr
    for j in range(min(HOLD, len(bar))):
        if (h[j] >= tgt) if direction == 1 else (l[j] <= tgt): return True
    return False


def fav_pct(rows, dirn_key, up, dn):
    fav = adv = 0
    for en, a, h, l, d in rows:
        dd = d if dirn_key == 'call' else dirn_key
        if dd == 0: continue
        r = first_passage(dd, en, a, up, dn, h, l)
        if r == 'fav': fav += 1
        elif r == 'adv': adv += 1
    return fav / (fav + adv) * 100 if (fav + adv) else float('nan'), fav + adv


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna()].copy().sort_values('timestamp').reset_index(drop=True)
    cidx = candle_index()
    edges = np.linspace(df['timestamp'].min() + (df['timestamp'].max() - df['timestamp'].min()) * 0.35, df['timestamp'].max(), 6)
    parts = []
    for k in range(len(edges) - 1):
        tr = df[df['timestamp'] < edges[k] - 14 * 86400]; te = df[(df['timestamp'] >= edges[k]) & (df['timestamp'] < edges[k + 1])].copy()
        if len(tr) < 8000 or len(te) < 200: continue
        m = H.make_model(); m.fit(tr[H.FEATURES].fillna(0), tr['goodR'])
        te['mlP'] = m.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        parts.append(te)
    d = pd.concat(parts, ignore_index=True)
    print("null (random walk, no drift):  +1.5/-1 long → 40% fav    |    +1/-1 long → 50% fav\n")
    print(f"{'ML_WIN':<12}{'n':>8}{'vol:P(reach+1.5)':>18}{'ord +1.5/-1':>14}{'ord +1/-1':>12}"
          f"{'Stoch-called +1.5/-1':>22}")
    for lo, hi in [(0.0, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 1.01)]:
        b = d[(d['mlP'] >= lo) & (d['mlP'] < hi)]
        rows = []
        for _, row in b.iterrows():
            sym = row['symbol']
            if sym not in cidx or row['atrPercent'] <= 0: continue
            ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
            if s >= len(ct) or s == 0: continue
            e = min(s + HOLD, len(ct)); h, l = cidx[sym]['high'][s:e], cidx[sym]['low'][s:e]
            if len(h) < 2: continue
            en = cidx[sym]['close'][s - 1]; a = row['atrPercent'] / 100 * en
            dcall = 1 if row.get('dStochCross', 0) > 0 else (-1 if row.get('dStochCross', 0) < 0 else 0)
            rows.append((en, a, h, l, dcall))
        if not rows: continue
        vol = np.mean([reached(1, en, a, 1.5, h, l) for en, a, h, l, _ in rows]) * 100
        o15, _ = fav_pct(rows, 1, 1.5, 1.0)
        o11, _ = fav_pct(rows, 1, 1.0, 1.0)
        oc, nc = fav_pct(rows, 'call', 1.5, 1.0)
        print(f"{f'[{lo:.1f},{hi:.1f})':<12}{len(rows):>8,}{vol:>16.0f}%{o15:>13.0f}%{o11:>11.0f}%"
              f"{oc:>20.0f}% (n={nc:,})")
    print("\nRead: if 'vol:P(reach+1.5)' climbs with ML_WIN but the ordering columns sit at their "
          "nulls (40% / 50%), the model detects VOLATILITY, not DIRECTION — the 1.5R move happens "
          "more, but it's a coin flip whether it happens before the stop.")


if __name__ == '__main__':
    main()
