#!/usr/bin/env python3
"""Decompose the convex structure's payoff into its THREE real outcomes.

`opportunity.ts:expectedValueR` is binary -- `p*winR - (1-p)*lossR` -- which assumes every trade
ends at the target or the stop. The barrier labels say otherwise: at 5R the target-first rate is
6.6% against a 16.7% driftless-random-walk benchmark, so most trades must be ending somewhere else.

A finite horizon has a third outcome the analytic formula has no room for: TIMEOUT, exiting at
whatever the market offers 72h later. Ignoring it does not make the estimate slightly wrong, it
makes it wrong in an unbounded direction -- a timeout exit can land anywhere in (-1R, +R).

This measures all three and the realised EV, which is the number the pipeline should be using.
"""
import glob, os
import numpy as np
import pandas as pd

HORIZON_H = 72
STOP_ATR = 1.0
R_GRID = [1.0, 1.5, 2.0, 3.0, 5.0, 8.0]
FEAT_DIR, PATH_DIR = 'csv_exports_v14', 'vision_backfill/klines_long'


def decompose(sym):
    fp, pp = f'{FEAT_DIR}/{sym}.csv', f'{PATH_DIR}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)):
        return None
    feat = pd.read_csv(fp)
    path = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)

    ts_raw = feat['timestamp'].to_numpy(np.int64)
    fts = (ts_raw // 1000) if ts_raw[0] > 1e12 else ts_raw
    pts = path['ts'].to_numpy(np.int64)
    high, low, close = (path[c].to_numpy(np.float64) for c in ('high', 'low', 'close'))

    idx = np.searchsorted(pts, fts, side='left')
    ok = (idx < len(pts) - HORIZON_H) & (idx >= 0)
    ok &= pts[np.clip(idx, 0, len(pts) - 1)] == fts
    entry = feat['price'].to_numpy(np.float64)
    atr = (feat['atrPercent'].to_numpy(np.float64) / 100.0) * entry
    ok &= np.isfinite(atr) & (atr > 0) & np.isfinite(entry) & (entry > 0)
    if ok.sum() == 0:
        return None

    rows = np.where(ok)[0]
    base, e, risk = idx[rows], entry[rows], STOP_ATR * atr[rows]
    offs = np.arange(1, HORIZON_H + 1)
    gh, gl = high[base[:, None] + offs], low[base[:, None] + offs]
    exit_px = close[base + HORIZON_H]                       # the timeout fill
    NEVER = HORIZON_H + 10

    def first(mat):
        return np.where(mat.any(axis=1), mat.argmax(axis=1), NEVER)

    recs = []
    for side in ('LONG', 'SHORT'):
        sgn = 1.0 if side == 'LONG' else -1.0
        stop_px = (e - sgn * risk)[:, None]
        stop_i = first(gl <= stop_px) if side == 'LONG' else first(gh >= stop_px)
        # R at the timeout fill, signed by side.
        timeout_r = sgn * (exit_px - e) / risk

        for R in R_GRID:
            tgt_px = (e + sgn * R * risk)[:, None]
            tgt_i = first(gh >= tgt_px) if side == 'LONG' else first(gl <= tgt_px)

            won = tgt_i < stop_i
            lost = (stop_i < NEVER) & ~won
            timed = ~won & ~lost

            # Realised R per trade: target pays +R, stop pays -1, timeout pays the mark.
            r = np.where(won, R, np.where(lost, -1.0, np.clip(timeout_r, -1.0, R)))
            recs.append(dict(symbol=sym, side=side, R=R, n=len(r),
                             p_target=won.mean(), p_stop=lost.mean(), p_timeout=timed.mean(),
                             mean_timeout_r=timeout_r[timed].mean() if timed.any() else np.nan,
                             ev_real=r.mean(),
                             ev_binary_assumption=won.mean() * R - (1 - won.mean()) * 1.0))
    return pd.DataFrame(recs)


def main():
    syms = sorted({os.path.basename(f)[:-4] for f in glob.glob(f'{FEAT_DIR}/*.csv')} &
                  {os.path.basename(f)[:-4] for f in glob.glob(f'{PATH_DIR}/*.csv')})
    parts = [d for s in syms if (d := decompose(s)) is not None]
    df = pd.concat(parts, ignore_index=True)
    df.to_csv('excursion_payoff.csv', index=False)

    print(f'{len(syms)} symbols, {df["n"].sum():,} trade-simulations\n')
    print('POOLED payoff decomposition (weighted by n):')
    print(f'{"side":>6}{"R":>5}{"P(tgt)":>9}{"P(stop)":>9}{"P(t/o)":>9}'
          f'{"E[R|t/o]":>10}{"EV real":>9}{"EV if binary":>14}{"error":>9}')
    for side in ('LONG', 'SHORT'):
        for R in R_GRID:
            s = df[(df.side == side) & (df.R == R)]
            w = s['n'] / s['n'].sum()
            pt, ps, po = [(s[c] * w).sum() for c in ('p_target', 'p_stop', 'p_timeout')]
            mto = (s['mean_timeout_r'] * w).sum()
            ev, evb = (s['ev_real'] * w).sum(), (s['ev_binary_assumption'] * w).sum()
            print(f'{side:>6}{R:>5g}{pt:>9.4f}{ps:>9.4f}{po:>9.4f}{mto:>10.3f}'
                  f'{ev:>9.4f}{evb:>14.4f}{ev - evb:>+9.4f}')

    print('\nBest structure by realised EV (pooled):')
    best = []
    for side in ('LONG', 'SHORT'):
        for R in R_GRID:
            s = df[(df.side == side) & (df.R == R)]
            w = s['n'] / s['n'].sum()
            best.append((side, R, (s['ev_real'] * w).sum()))
    for side, R, ev in sorted(best, key=lambda x: -x[2])[:6]:
        print(f'  {side:5s} {R:>4g}R  EV {ev:+.4f}R')


if __name__ == '__main__':
    main()
