#!/usr/bin/env python3
"""
Composite-execution band backtest — models what production ACTUALLY does:
  - enter at signal-bar close, stop = SL_ATR
  - 50% booked at TP1, stop moves to break-even (entry) for the runner
  - runner (50%) targets TP2, protected by the BE stop
  - blended R = 0.5*TP1_leg + 0.5*runner_leg

Sweeps TP2 to find the EV-maximizing runner target, per market, on the clean
multi-fold WF (timestamp-split + 14d embargo, folds span 2022 bear). dStoch
direction. Conservative tie-breaks (SL-first pre-TP1, BE-first for the runner).

Production today: crypto TP1 1.5 / TP2 2.5(max 3.0) / SL 2.0; stock TP1 1.5 /
TP2 2.5 / SL 1.5. Question: does widening the crypto runner beyond 2.5 pay, and
does it NOT pay on stocks (justifying a market-specific change)?

Run:  python3 composite_band_backtest.py
"""
import numpy as np, pandas as pd

ev = __import__('edge_validation')
rev = __import__('edge_revalidate')
load_features, build_candle_index = ev.load_features, ev.build_candle_index

HORIZON = 18  # 72h — give the runner room
TOP10 = rev.TOP10


def resolve_composite(direction, entry, atr_price, block, sl_atr, tp1_atr, tp2_atr):
    if direction == 1:
        sl, tp1, tp2, be = entry - atr_price*sl_atr, entry + atr_price*tp1_atr, entry + atr_price*tp2_atr, entry
    else:
        sl, tp1, tp2, be = entry + atr_price*sl_atr, entry - atr_price*tp1_atr, entry - atr_price*tp2_atr, entry
    highs, lows, closes = block['high'], block['low'], block['close']
    n = min(HORIZON, len(highs))
    if n == 0: return None
    realized = 0.0
    tp1_done = False
    for i in range(n):
        hi, lo = highs[i], lows[i]
        if not tp1_done:
            sl_hit = (lo <= sl) if direction == 1 else (hi >= sl)
            tp1_hit = (hi >= tp1) if direction == 1 else (lo <= tp1)
            if sl_hit:               # conservative: SL before TP1 if both
                return -sl_atr
            if tp1_hit:
                tp1_done = True
                realized += 0.5 * tp1_atr
                continue
        else:
            be_hit = (lo <= be) if direction == 1 else (hi >= be)
            tp2_hit = (hi >= tp2) if direction == 1 else (lo <= tp2)
            if be_hit:               # conservative: BE before TP2 if both → runner flat
                return realized + 0.0
            if tp2_hit:
                return realized + 0.5 * tp2_atr
    # horizon end — close remaining at market
    move = (closes[n-1] - entry) * direction
    r = move / atr_price
    if not tp1_done:
        return float(np.clip(r, -sl_atr, tp1_atr))
    return realized + 0.5 * float(np.clip(r, 0.0, tp2_atr))


def run(label, csv_dir, candles, sl_atr, tp1_atr, sym=None):
    print(f"\n{'='*78}\n{label}  (SL {sl_atr} / TP1 {tp1_atr} / horizon {HORIZON}b)\n{'='*78}")
    df = load_features(csv_dir, sym)
    idx = build_candle_index(candles, sym)
    val = rev.wf_clean(df).sort_values(['symbol','timestamp']).reset_index(drop=True)
    val['prevMl'] = val.groupby('symbol')['mlProb'].shift(1)
    rising = val[(val['prevMl'] < 0.70) & (val['mlProb'] >= 0.70)].copy()
    print(f"  rising-edge dStoch setups: ", end='')

    # pre-extract setups (dStoch direction)
    setups = []
    for _, r in rising.iterrows():
        d = rev.dir_dstoch(r)
        if d == 0: continue
        s = r['symbol']
        if s not in idx: continue
        ap = r['atrPercent']
        if ap <= 0: continue
        entry = r['price']; atrp = entry*ap/100.0
        c = idx[s]; i = np.searchsorted(c['ts'], r['ts_ms'], side='right')
        if i >= len(c['ts']): continue
        block = {k: c[k][i:i+HORIZON] for k in ('high','low','close')}
        if len(block['high']) == 0: continue
        setups.append((d, entry, atrp, block))
    print(f"{len(setups):,}")

    print(f"\n  {'TP2(ATR)':>9} {'blendedEV':>10} {'totalR':>9}")
    print("  " + "-"*32)
    best = None
    for tp2 in [2.0, 2.5, 3.0, 3.5, 4.0, 5.0]:
        rs = [resolve_composite(d, e, a, b, sl_atr, tp1_atr, tp2) for (d, e, a, b) in setups]
        rs = [x for x in rs if x is not None]
        evr, cum = float(np.mean(rs)), float(np.sum(rs))
        flag = ''
        if best is None or evr > best[1]: best = (tp2, evr); flag = ' *'
        print(f"  {tp2:>9.1f} {evr:>+10.4f} {cum:>+8.1f}{flag}")
    print(f"  → best TP2: {best[0]} ATR  (blended EV {best[1]:+.4f}R)")


def main():
    run("CRYPTO ALL (77)", 'csv_exports_v11', 'crypto_candles_4h.csv.gz', sl_atr=2.0, tp1_atr=1.5)
    run("CRYPTO TOP-10", 'csv_exports_v11', 'crypto_candles_4h.csv.gz', sl_atr=2.0, tp1_atr=1.5, sym=TOP10)
    run("STOCKS (159)", 'csv_exports_v13', 'stock_candles_4h.csv.gz', sl_atr=1.5, tp1_atr=1.5)


if __name__ == '__main__':
    main()
