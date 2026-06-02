#!/usr/bin/env python3
"""
DIRECTION-AGNOSTIC BREAKOUT backtest — "predict volatility, let price pick the side."

Gate trades on ML_WIN (the real volatility edge). At each flagged bar, arm a bracket:
  buy-stop at +B·ATR, sell-stop at −B·ATR. Whichever the forward 4H candles touch FIRST
sets the direction + entry (no prediction). Then run the trade from there with a stop and a
target, resolved bar-by-bar on real OHLC. Charge realistic costs (fees + slippage + funding).

This is the honest test the leaked setup-execution backtests couldn't be: clean ML_WIN
(daily-leak features dropped), real fills, real costs, walk-forward across the whole history,
and a no-gate baseline so we can see if ML_WIN gating actually adds value.

Run:  python3 strategy_breakout_ev.py
"""
import os, sys, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta')

# Strategy params (ATR multiples)
B_BREAK = 0.5     # breakout trigger distance from the signal close
SL_ATR  = 1.0     # stop distance from the breakout entry
TP_ATR  = 2.0     # target distance from the breakout entry  → 2.0R per win
WAIT_BARS = 6     # 4H bars to wait for a break (24h)
HOLD_BARS = 12    # 4H bars to hold after entry (48h)
# Costs (% of notional). Coinbase perp taker ~0.05%/side; +slippage on stop fills; +funding.
FEE_PCT = 0.12; SLIP_PCT = 0.06; FUND_PCT = 0.03   # round-trip total ≈ 0.21% of price
ML_GATE = 0.60    # ML_WIN threshold to arm a bracket
FADE = os.environ.get('FADE') == '1'   # FADE=1 → trade AGAINST the break (mean-reversion)
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def load_candle_index():
    if not os.path.exists(CANDLES):
        sys.exit(f"Missing {CANDLES} — run fetch_crypto_candles.py first.")
    c = pd.read_csv(CANDLES)
    # normalize time to seconds
    tcol = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tcol].values.astype(np.int64)
    if t.max() > 1e12: t = t // 1000
    c['t'] = t
    idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('open', 'high', 'low', 'close')}
        idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def resolve_breakout(entry_ref, atr, fwd):
    """fwd = dict of forward OHLC arrays (chronological). Returns net R or None (no break)."""
    o, h, l, c = fwd['open'], fwd['high'], fwd['low'], fwd['close']
    buyStop = entry_ref + B_BREAK * atr
    sellStop = entry_ref - B_BREAK * atr
    n = len(h)
    # Phase 1: first bar that touches either breakout level
    bi, direction, entry = -1, 0, 0.0
    for i in range(min(WAIT_BARS, n)):
        up = h[i] >= buyStop
        dn = l[i] <= sellStop
        if up and dn:
            # both in one bar — assume the side the bar OPENED nearer to triggers first
            direction = 1 if abs(o[i] - buyStop) <= abs(o[i] - sellStop) else -1
        elif up:
            direction = 1
        elif dn:
            direction = -1
        else:
            continue
        entry = buyStop if direction == 1 else sellStop
        bi = i
        break
    if bi < 0:
        return None  # no breakout — no trade
    if FADE:
        direction = -direction   # trade AGAINST the break (bet it reverts to the mean)
    # Phase 2: run the trade from bar bi, stop ±SL·ATR, target ±TP·ATR (R-unit = SL·ATR)
    sl = entry - SL_ATR * atr if direction == 1 else entry + SL_ATR * atr
    tp = entry + TP_ATR * atr if direction == 1 else entry - TP_ATR * atr
    rr_win = TP_ATR / SL_ATR
    end = min(bi + 1 + HOLD_BARS, n)
    for j in range(bi, end):
        if direction == 1:
            sl_hit, tp_hit = l[j] <= sl, h[j] >= tp
        else:
            sl_hit, tp_hit = h[j] >= sl, l[j] <= tp
        if sl_hit and tp_hit:
            up_bar = c[j] >= o[j]
            won = up_bar if direction == 1 else (not up_bar)
            gross = rr_win if won else -1.0
            return gross - cost_R(atr, entry_ref)
        if tp_hit:
            return rr_win - cost_R(atr, entry_ref)
        if sl_hit:
            return -1.0 - cost_R(atr, entry_ref)
    # timed out: mark to last close in R units
    move = (c[end - 1] - entry) * direction
    return float(np.clip(move / (SL_ATR * atr), -1.0, rr_win)) - cost_R(atr, entry_ref)


def cost_R(atr, price):
    # cost as % of price → R units (R = SL·ATR price distance)
    cost_pct = FEE_PCT + SLIP_PCT + FUND_PCT
    r_price = SL_ATR * atr
    return (cost_pct / 100.0 * price) / r_price if r_price > 0 else 0.0


def summarize(rs, tag):
    rs = np.array([r for r in rs if r is not None])
    if len(rs) == 0:
        print(f"  {tag:<30} no trades"); return
    print(f"  {tag:<30} n={len(rs):>6}  win={ (rs>0).mean()*100:>4.0f}%  netR/trade={rs.mean():>+6.3f}  totalR={rs.sum():>+8.1f}")


def main():
    print("Loading clean ML_WIN (no daily-leak features) + crypto 4H candles...")
    df, _ = H.load_market('crypto'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna()].copy()
    df['up'] = (df['fwdReturn24H'] > 0).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)
    NONDAILY_D = {'dayOfWeek', 'dxyMomentum', 'darkPoolRatio', 'darkPoolZScore'}
    honest = [f for f in H.FEATURES if not (f.startswith('d') and f not in NONDAILY_D)]
    cidx = load_candle_index()
    print(f"  candle symbols: {len(cidx)}  | rows: {len(df):,}")

    tlo, thi = df['timestamp'].min(), df['timestamp'].max()
    edges = np.linspace(tlo + (thi - tlo) * 0.35, thi, 6)

    print(f"\nParams: break +/-{B_BREAK} ATR, stop {SL_ATR} ATR, target {TP_ATR} ATR ({TP_ATR/SL_ATR:.1f}R), "
          f"costs ~{FEE_PCT+SLIP_PCT+FUND_PCT:.2f}% of price, ML gate {ML_GATE}\n")
    all_gated, all_base = [], []
    for k in range(len(edges) - 1):
        wlo, whi = edges[k], edges[k + 1]
        tr = df[df['timestamp'] < wlo - 14 * 86400]
        te = df[(df['timestamp'] >= wlo) & (df['timestamp'] < whi)].copy()
        if len(tr) < 8000 or len(te) < 200:
            continue
        mq = H.make_model(); mq.fit(tr[honest].fillna(0), tr['goodR'])
        te['mlP'] = mq.predict_proba(te[honest].fillna(0))[:, 1]
        gated, base = [], []
        for _, row in te.iterrows():
            sym = row['symbol']
            if sym not in cidx or row['atrPercent'] <= 0:
                continue
            ct = cidx[sym]['t']; T = int(row['timestamp'])
            s = np.searchsorted(ct, T, side='right')   # first forward bar
            if s >= len(ct): continue
            e = min(s + WAIT_BARS + HOLD_BARS, len(ct))
            fwd = {kk: cidx[sym][kk][s:e] for kk in ('open', 'high', 'low', 'close')}
            if len(fwd['high']) < 2: continue
            price = float(row.get('close', fwd['open'][0]) if 'close' in row else fwd['open'][0])
            atr = row['atrPercent'] / 100.0 * price
            r = resolve_breakout(price, atr, fwd)
            if r is None: continue
            base.append(r)                              # every armed bar (no ML gate)
            if row['mlP'] >= ML_GATE: gated.append(r)   # ML_WIN-gated
        d0 = pd.to_datetime(wlo, unit='s').date(); d1 = pd.to_datetime(whi, unit='s').date()
        print(f"fold {k+1} {d0}->{d1}:")
        summarize(base, 'baseline (no ML gate)')
        summarize(gated, f'ML_WIN >= {ML_GATE} gated')
        all_gated += [r for r in gated if r is not None]; all_base += [r for r in base if r is not None]
    print("\n=== POOLED ===")
    summarize(all_base, 'baseline (no ML gate)')
    summarize(all_gated, f'ML_WIN >= {ML_GATE} gated')


if __name__ == '__main__':
    main()
