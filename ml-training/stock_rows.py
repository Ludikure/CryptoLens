#!/usr/bin/env python3
"""Part 8 rows: stock entry-discipline outcomes + the earnings gap metric.

Pre-declared in docs/research/envelope-rules.md (frozen at 8396f25).

Mirrors `level_entry.py`, with two declared changes:
  - horizon held at 3/18 ATR-PERIODS rather than clock hours. A stock "4H" bar is ET-session
    aggregated (two per 6.5h session = 3.25 trading hours), so 3/18 periods is WAIT 10 / HOLD 59
    hourly bars, not 12/72.
  - fee 0.05% round trip (retail commission-free + spread), not crypto's 0.171% derivatives taker.

Also emits `maxGapATR` -- the largest overnight |open - prior close| inside the hold window, in ATR
units. That is the earnings gates' OWN claim ("gap risk, stop will not hold") and the only way to
test them, since by the Part 6 principle an EV null cannot refute an exogenous-event guard.

RE-RUN 2026-08-26 ON `_payoff` (`anchor='bar_close'`). Two things this migration settles:

1. The anchor generalises. A stock feature bar is 4H of ET SESSION time, which is 4 hourly path bars
   just as it is for crypto, so `bar_hours=4` is right for both — the offset is counted in BARS, and
   the bar sequence is the trading-hours sequence.

2. The gap guard does NOT generalise unchanged, and setting it to 3600s would silently drop every
   stock row. A stock series' normal spacings are 3600s intraday, 64800s overnight, 237600s over a
   weekend and 324000s over a long one; those are the market being closed, not missing data.
   `max_gap_s` is therefore set to 4.5 days, so only a genuine hole disqualifies a window. Measured
   on the archive: the largest real gap is 334,800s (93h), comfortably inside it.

EVIDENCE STATUS: Part 8's EV arms scored a column produced by the retracted lookahead anchor, and its
LONG_CONFIRMATION arms are not re-runnable at all without an export change (the live day-over-day
daily-RSI delta is exported under no name). The GAP metric is independent of the entry simulation and
survives.
"""
import glob, os
import numpy as np, pandas as pd
from _payoff import simulate, locate, PayoffParams, align_arms, Provenance

WAIT_H, HOLD_H = 10, 59          # 3 / 18 ATR-periods at 3.25 trading hours per stock 4H bar
HOLD_ALT = 72                    # declared robustness re-run (22 periods)
STOP_ATR, TP2_ATR = 2.0, 2.5
DEPTHS = [0.00, 0.25]
FEE = 0.05
FEAT, PATH = 'csv_exports_v14_stocks', 'stock_klines'
MAX_GAP_S = int(4.5 * 86400)     # longer than any legitimate market closure; see docstring

KEEP = ['price', 'atrPercent', 'relStrengthVsSpy', 'dRsiDelta1', 'dRsiDelta',
        'dStochCross', 'hStochCross', 'regimeCode', 'biasAlignment', 'tfAlignment',
        'fwdMaxFavR', 'dailyBias', 'fourHBias']


def rows(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)):
        return None
    f = pd.read_csv(fp, low_memory=False)
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)

    arms = {}
    for hold, tag in ((HOLD_H, ''), (HOLD_ALT, '_h72')):
        P = PayoffParams(wait_h=WAIT_H, hold_h=hold, stop_atr=STOP_ATR, tp_atr=TP2_ATR,
                         fee_pct=FEE, bar_hours=4)
        for depth in DEPTHS:
            for side in ('LONG', 'SHORT'):
                o, _ = simulate(f, p, symbol=sym, depth_atr=depth, side=side, anchor='bar_close',
                                entry_mode='market' if depth == 0.0 else 'pullback',
                                params=P, max_gap_s=MAX_GAP_S)
                if not len(o):
                    return None
                arms[f'd{depth}_{side}{tag}'] = o[['symbol', 'timestamp', 'filled', 'oppR']]
    joined, _ = align_arms(arms)

    # maxGapATR, on the SAME rows the payoffs use. Computed here rather than in the module because it
    # is a stock-specific diagnostic, not part of any payoff.
    prov = Provenance(anchor='bar_close')
    loc = locate(f, p, symbol=sym, anchor='bar_close', span_h=WAIT_H + HOLD_ALT,
                 bar_hours=4, max_gap_s=MAX_GAP_S, prov=prov)
    op, cl = (p[c].to_numpy(np.float64) for c in ('open', 'close'))
    gwin = loc.base[:, None] + np.arange(loc.first_off, loc.first_off + HOLD_H)
    assert gwin.min() >= 1 and gwin.max() < len(op), f'{sym}: gap window out of range'
    gap = pd.DataFrame({'timestamp': loc.fts,
                        'maxGapATR': np.abs(op[gwin] - cl[gwin - 1]).max(1) / loc.atr})
    fts = f['timestamp'].to_numpy(np.int64)
    fts = (fts // 1000) if fts[0] > 1e12 else fts
    feats = f.iloc[loc.rows][[c for c in KEEP if c in f.columns]].reset_index(drop=True).add_prefix('f_')
    gap = pd.concat([gap.reset_index(drop=True), feats], axis=1)

    return joined.merge(gap, on='timestamp', how='inner')


def main():
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    parts = []
    for s in syms:
        try:
            d = rows(s)
        except Exception as ex:
            print(f'  {s}: FAILED {ex}')
            continue
        if d is not None and len(d):
            parts.append(d)
    d = pd.concat(parts, ignore_index=True)
    d.to_pickle('stock_rows.pkl.gz')
    print(f'wrote {len(d):,} rows, {d.symbol.nunique()} symbols')
    for side in ('SHORT', 'LONG'):
        m = d[f'd0.0_{side}|oppR'].mean()
        pb = d[f'd0.25_{side}|oppR'].mean()
        print(f'  {side}: market {m:+.4f}   pullback 0.25 {pb:+.4f}   gain {pb - m:+.4f}   '
              f'fill {d[f"d0.25_{side}|filled"].mean():.1%}')
    print(f'  maxGapATR mean {d.maxGapATR.mean():.3f}, P(gap >= 2 ATR) {(d.maxGapATR >= 2).mean():.4f}')


if __name__ == '__main__':
    main()
