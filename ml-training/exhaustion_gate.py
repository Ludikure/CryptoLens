#!/usr/bin/env python3
"""
Hypothesis: cap conviction (or abstain) when 4H exhaustion signals fire AGAINST the
trade direction. If high-exhaustion bars have materially lower EV, the gate helps.

The prompt's exhaustion signals (AnalysisPrompt C7), reconstructed from CSV features
against the trade direction (dStoch):
  rsi_divergence   hDivergence opposes direction
  volume_diverging last-3 aligned candles on weak volume (hVolumeRatio < 0.8)
  crowded_posn     longPctRaw extreme with direction (contrarian)
  cvd/taker        takerRatioRaw opposes direction
(rejection_wick needs single-bar OHLC, skipped — proxy uses the other 4.)

Test: on the frozen holdout, resolve rising-edge dStoch setups and bucket by
exhaustion count (0 / 1 / 2 / 3+). EV/trade per bucket → does it decline?

Run:  python3 exhaustion_gate.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')


def exhaustion_count(row, d):
    """Count 4H exhaustion signals against trade direction d (+1 long / -1 short)."""
    c = 0
    hdiv = row.get('hDivergence', 0) or 0
    if (d == 1 and hdiv == -1) or (d == -1 and hdiv == 1):
        c += 1
    hvr = row.get('hVolumeRatio', 1.0) or 1.0
    if d == 1 and (row.get('last3Green', 0) or 0) == 1 and hvr < 0.8:
        c += 1
    if d == -1 and (row.get('last3Red', 0) or 0) == 1 and hvr < 0.8:
        c += 1
    lp = row.get('longPctRaw', 0.5)
    lp = 0.5 if (lp is None or (isinstance(lp, float) and np.isnan(lp))) else lp
    if d == 1 and lp > 0.65:
        c += 1
    if d == -1 and lp < 0.35:
        c += 1
    tr = row.get('takerRatioRaw', 1.0)
    tr = 1.0 if (tr is None or (isinstance(tr, float) and np.isnan(tr))) else tr
    if d == 1 and tr < 0.95:
        c += 1
    if d == -1 and tr > 1.05:
        c += 1
    return c


def run(market):
    print(f"\n{'='*78}\n{market.upper()} — exhaustion-count vs EV (holdout, rising-edge dStoch)\n{'='*78}")
    df, idx = H.load_market(market)
    df = P1.add_labels(df)
    sel, hold, b = H.split_holdout(df)
    # ML on selection → holdout mlProb
    mq = H.make_model(); mq.fit(sel[H.FEATURES].fillna(0), sel['goodR'])
    hv = hold.copy()
    hv['mlProb'] = mq.predict_proba(hv[H.FEATURES].fillna(0))[:, 1]
    hv = hv.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    hv['prevMl'] = hv.groupby('symbol')['mlProb'].shift(1)
    rising = hv[(hv['prevMl'] < 0.70) & (hv['mlProb'] >= 0.70) & (hv['tradeDir'] != 0)].copy()

    rows = []
    for _, r in rising.iterrows():
        d = int(r['tradeDir'])
        sym = r['symbol']
        if sym not in idx or r['atrPercent'] <= 0:
            continue
        entry = r['price']; atrp = entry * r['atrPercent'] / 100.0
        sl, tp = (entry - atrp, entry + atrp*1.5) if d == 1 else (entry + atrp, entry - atrp*1.5)
        c = idx[sym]; i = np.searchsorted(c['ts'], r['ts_ms'], side='right')
        if i >= len(c['ts']):
            continue
        block = {k: c[k][i:i+H.HORIZON] for k in ('open', 'high', 'low', 'close')}
        if len(block['high']) == 0:
            continue
        res = H.resolve_fill(d, entry, sl, tp, block, 1.0, 1.5)
        if res is None:
            continue
        rows.append({'R': res, 'exh': exhaustion_count(r, d)})
    res = pd.DataFrame(rows)
    if len(res) == 0:
        print("  no setups"); return

    print(f"  total rising-edge dStoch setups: {len(res):,}\n")
    print(f"  {'exhaustion':>11} {'n':>6} {'win%':>6} {'EV(R)':>8}")
    print("  " + "-"*36)
    for k, label in [(0, '0'), (1, '1'), (2, '2'), (3, '3+')]:
        g = res[res['exh'] == k] if label != '3+' else res[res['exh'] >= 3]
        if len(g) == 0:
            print(f"  {label:>11} {0:>6}"); continue
        print(f"  {label:>11} {len(g):>6,} {(g['R']>0).mean()*100:>5.1f}% {g['R'].mean():>+7.3f}")
    # gate variants: abstain when exh >= threshold
    print(f"\n  Gate (abstain when exhaustion >= N):")
    base = res['R'].mean()
    print(f"  {'kept':>14} {'n':>6} {'EV(R)':>8}  vs baseline {base:+.3f}R (n={len(res):,})")
    for thr in (1, 2, 3):
        kept = res[res['exh'] < thr]
        if len(kept):
            print(f"  exh<{thr:<10} {len(kept):>6,} {kept['R'].mean():>+7.3f}  ({kept['R'].mean()-base:+.3f}R, drops {len(res)-len(kept)})")


def main():
    for mk in ('crypto', 'stock'):
        run(mk)


if __name__ == '__main__':
    main()
