#!/usr/bin/env python3
"""Is the pullback result real, or an artifact? Three controls. (RE-RUN 2026-08-26 on `_payoff`.)

  A. CONSERVATIVE FILL   require price to trade THROUGH the level by 0.05 ATR, not merely touch it.
                         A limit order at a price the market kisses once often does not fill.
  B. DELAY ONLY          wait the same 12h, then enter AT MARKET. If this captures the benefit, the
                         effect is the DELAY, not the level.
  C. ADVERSE ENTRY       enter 0.25 ATR in the CHASE direction. If entering better genuinely helps,
                         entering worse should hurt by a similar magnitude. A result that is
                         positive both ways is measuring something else entirely.

TWO CORRECTIONS SINCE THE ORIGINAL, both of which changed shipped numbers.

1. The anchor. Fills were scanned from T+1h when the signal only exists at T+4h. Now `_payoff` with
   `anchor='bar_close'`.

2. **Arm C was not testing what it said.** It set `depth = -0.25` and KEPT the pullback touch test —
   so for a LONG it placed the entry ABOVE price and then asked whether the low reached it, which is
   true almost immediately. It filled instantly on essentially every bar: a MARKET entry with forced
   adverse slippage, reported as "chasing". The -0.129R / -0.195R figures that shipped into both
   markets' prompt text came from that arm.

   `_payoff` refuses to build it: a negative depth raises, and a sign invariant asserts that a
   pullback entry is on the against-direction side of price. The arm is now expressed as what it
   always was — `entry_mode='market_with_slippage'` — which is an honest control, just not the one
   the label claimed. It answers "does a worse fill hurt?", NOT "does chasing hurt?". Chasing means
   entering after price has already moved, and testing that needs a different construction.
"""
import glob, os
import numpy as np, pandas as pd
from _payoff import simulate, PayoffParams, overlap_eff_n, align_arms

FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'
BASE = dict(wait_h=12, hold_h=72, stop_atr=2.0, tp_atr=2.5, fee_pct=0.171, bar_hours=4)

#      label                          entry_mode                depth  extra params
ARMS = [
    ('market',                        'market',                 0.00, {}),
    ('pullback 0.25',                 'pullback',               0.25, {}),
    ('pullback 0.25 STRICT (through)', 'pullback',              0.25, dict(trigger_penetration_atr=0.05)),
    ('delay 12h then market',         'market',                 0.00, dict(delay_bars=12)),
    ('ADVERSE 0.25 (worse fill)',     'market_with_slippage',   0.00, dict(slippage_atr=0.25)),
]


def build():
    syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
                  {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
    frames, losses = [], []
    for sym in syms:
        f = pd.read_csv(f'{FEAT}/{sym}.csv', low_memory=False)
        p = pd.read_csv(f'{PATH}/{sym}.csv').sort_values('ts').reset_index(drop=True)
        arms, ok = {}, True
        for label, mode, depth, extra in ARMS:
            for side in ('LONG', 'SHORT'):
                out, _ = simulate(f, p, symbol=sym, depth_atr=depth, side=side,
                                  anchor='bar_close', entry_mode=mode,
                                  params=PayoffParams(**BASE, **extra))
                if not len(out):
                    ok = False
                    break
                arms[f'{label}|{side}'] = out[['symbol', 'timestamp', 'filled', 'oppR']]
            if not ok:
                break
        if ok:
            joined, info = align_arms(arms)
            frames.append(joined)
            losses.append(info['loss'])
    d = pd.concat(frames, ignore_index=True)
    print(f'arm alignment cost up to {max(losses):.2%} of the largest arm per symbol '
          f'(arms need different horizons; they are compared on the intersection)\n')
    return d


def main():
    d = build()
    d['dt'] = pd.to_datetime(d.timestamp, unit='s')
    periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')
    eff = overlap_eff_n(len(d), BASE['hold_h'], BASE['bar_hours'])
    print(f'{len(d):,} opportunities, {d.symbol.nunique()} symbols — ~{eff:,} independent\n')

    for side in ('SHORT', 'LONG'):
        print(f'=== {side} ===')
        print(f'{"arm":>32}{"fill rate":>11}{"R per OPP":>12}{"vs market":>11}{"periods+":>10}')
        b = d[f'market|{side}|oppR'].mean()
        for label, *_ in ARMS:
            pos = tot = 0
            for i in range(len(periods) - 1):
                w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
                if w.sum() < 2000:
                    continue
                tot += 1
                pos += (d.loc[w, f'{label}|{side}|oppR'].mean()
                        - d.loc[w, f'market|{side}|oppR'].mean()) >= 0
            po = d[f'{label}|{side}|oppR'].mean()
            print(f'{label:>32}{d[f"{label}|{side}|filled"].mean():>11.1%}{po:>12.4f}'
                  f'{po - b:>+11.4f}{f"{pos}/{tot}":>10}')
        print()


if __name__ == '__main__':
    main()
