#!/usr/bin/env python3
"""Tests the 'two-sided move, not clean trend' hypothesis two ways:
 PART A: of LONG paths that reach +1.5 ATR in 72h, what % hit -1 ATR FIRST (stopped then
         recovered)? High + rising with ML => two-sided variance, not directional trend.
 PART B: does RE-ENTRY after a stop-out recover EV? Single-shot trailing vs allow N re-entries
         (same side, fresh 1 ATR stop, trailing exit). If the move is real but order is random,
         re-entry should catch the leg you got whipsawed out of — IF the cost of extra legs
         doesn't eat it. Tail-gated, Binance fees, clean data.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
HOLD = int(os.environ.get('HOLD', 30))
TRAIL = 2.0
FEE, SLIP, FUND = [float(x) for x in os.environ.get('COSTS', '0.07,0.03,0.03').split(',')]
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def stop_then_recover(entry, atr, h, l):
    """LONG: did price hit -1 ATR before it first reached +1.5 ATR? among those that reach +1.5."""
    fav, adv = entry + 1.5 * atr, entry - 1.0 * atr
    hit_adv = False
    for j in range(min(HOLD, len(h))):
        if l[j] <= adv: hit_adv = True
        if h[j] >= fav: return True, hit_adv     # reached fav; did adv precede?
    return False, hit_adv                         # never reached fav


def seq_R(direction, en, atr, h, l, c, max_re):
    """Trailing trade with up to max_re re-entries after a losing stop. Returns total R."""
    R = atr; cost = (FEE + SLIP + FUND) / 100 * en / R
    n = min(HOLD, len(h)); total = 0.0; entry = en; j = 0; legs = 0
    while legs <= max_re and j < n:
        stop = entry - R if direction == 1 else entry + R; ext = entry; out = None
        while j < n:
            if direction == 1 and l[j] <= stop: out = (stop - entry) / R; break
            if direction == -1 and h[j] >= stop: out = (entry - stop) / R; break
            if direction == 1: ext = max(ext, h[j]); stop = max(stop, ext - TRAIL * atr)
            else: ext = min(ext, l[j]); stop = min(stop, ext + TRAIL * atr)
            j += 1
        if out is None:  # timecap
            total += (c[n - 1] - entry) * direction / R - cost; break
        total += out - cost; legs += 1
        if out > 0: break          # trailed into profit — caught it, done
        if j >= n: break
        entry = c[j]; j += 1       # re-enter at the stop bar's close, resume next bar
    return total


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
        mq = H.make_model(); mq.fit(tr[H.FEATURES].fillna(0), tr['goodR'])
        mt = H.make_model(); mt.fit(tr[H.FEATURES].fillna(0), tr['bigTail'])
        te['mlP'] = mq.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        te['tailP'] = mt.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        te['tailGate'] = te['tailP'] >= te['tailP'].quantile(0.90)
        parts.append(te)
    d = pd.concat(parts, ignore_index=True)

    # PART A: stop-then-recover by ML bucket
    print("PART A — of LONG paths reaching +1.5 ATR in 72h, what % were stopped at -1 ATR FIRST?\n")
    print(f"{'ML_WIN':<12}{'reach+1.5':>11}{'of those: -1 hit FIRST':>26}")
    for lo, hi in [(0.0, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 1.01)]:
        b = d[(d['mlP'] >= lo) & (d['mlP'] < hi)]; reach = stopfirst = nreach = 0; n = 0
        for _, row in b.iterrows():
            sym = row['symbol']
            if sym not in cidx or row['atrPercent'] <= 0: continue
            ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
            if s >= len(ct) or s == 0: continue
            e = min(s + HOLD, len(ct)); h, l = cidx[sym]['high'][s:e], cidx[sym]['low'][s:e]
            if len(h) < 2: continue
            en = cidx[sym]['close'][s - 1]; a = row['atrPercent'] / 100 * en
            rch, advfirst = stop_then_recover(en, a, h, l); n += 1
            if rch: nreach += 1; stopfirst += advfirst
        print(f"{f'[{lo:.1f},{hi:.1f})':<12}{nreach/n*100:>10.0f}%{stopfirst/nreach*100:>25.0f}%")

    # PART B: re-entry EV on tail-gated set
    g = d[d['tailGate']]; rows = []
    for _, row in g.iterrows():
        sym = row['symbol']
        if sym not in cidx or row['atrPercent'] <= 0: continue
        ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
        if s >= len(ct) or s == 0: continue
        e = min(s + HOLD, len(ct)); h, l, c = cidx[sym]['high'][s:e], cidx[sym]['low'][s:e], cidx[sym]['close'][s:e]
        if len(h) < 2: continue
        en = cidx[sym]['close'][s - 1]; rows.append((en, row['atrPercent'] / 100 * en, h, l, c))
    print(f"\nPART B — re-entry after stop-out (tail-gated {len(rows):,}, trail {TRAIL} ATR, Binance ~{FEE+SLIP+FUND:.2f}%):\n")
    print(f"  {'max re-entries':<16}{'net R/signal':>13}{'vs single-shot':>16}")
    base = None
    for mr in [0, 1, 2, 3]:
        rs = [(seq_R(1, en, a, h, l, c, mr) + seq_R(-1, en, a, h, l, c, mr)) / 2 for en, a, h, l, c in rows]
        m = float(np.mean(rs)); base = m if mr == 0 else base
        print(f"  {mr:<16}{m:>+13.3f}{(m-base)*1000:>+14.0f}m" if mr else f"  {mr:<16}{m:>+13.3f}{'(baseline)':>16}")
    print("\n→ if re-entry net R/signal > single-shot, the whipsaw-then-recover paths carry "
          "recoverable edge; if not, the extra legs' costs + random ordering eat it.")


if __name__ == '__main__':
    main()
