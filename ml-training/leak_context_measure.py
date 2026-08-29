#!/usr/bin/env python3
"""How much of the forward label could the cross-asset leak carry? (plan step 4.1)

`scripts/context.ts` sliced every DAILY cross-asset series at the 4H bar's OPEN, so at any intraday
bar the CURRENT day's SPY / IWM / sector / VIX / DXY candle was included — and a daily candle's OHLC
spans the whole day, including the hours AFTER the bar. Nine features built from those slices ship in
`ml-model-stock.json`.

The definitive number is a leaked-vs-clean walk-forward AUC, which needs a full stock regen (~3.5h of
network). This measures the thing that makes such a leak dangerous and needs no regen: how much the
LEAKED QUANTITY correlates with the FORWARD LABEL. If a same-day SPY close carries real information
about a stock's next 24 hours, the model had a handle to pull on.

Reads the local box archive, which is the same tape the export was built from.
"""
import sqlite3
import numpy as np, pandas as pd

DB = '../marketscope-worker/marketscope.db'
SYMS = ['AAPL', 'MSFT', 'NVDA', 'JPM', 'XOM', 'UNH', 'WMT', 'CAT', 'PFE', 'INTC']


def load(con, sym, interval):
    return pd.read_sql(
        'SELECT timestamp AS t, open, high, low, close FROM candles '
        'WHERE symbol=? AND interval=? ORDER BY timestamp', con, params=(sym, interval))


def main():
    con = sqlite3.connect(DB)
    spy_d = load(con, 'SPY', '1d')
    spy_d['day'] = pd.to_datetime(spy_d.t, unit='ms').dt.tz_localize('UTC').dt.tz_convert('America/New_York').dt.date
    spy_d['spy_ret'] = spy_d.close.pct_change()          # the LEAKED quantity: today's SPY move
    spy_map = dict(zip(spy_d.day, spy_d.spy_ret))

    rows = []
    for sym in SYMS:
        h4 = load(con, sym, '4h')
        if len(h4) < 500:
            continue
        ts = pd.to_datetime(h4.t, unit='ms').dt.tz_localize('UTC').dt.tz_convert('America/New_York')
        h4 = h4.assign(day=ts.dt.date, hour=ts.dt.hour)
        # Forward 24h return from this bar's close (6 x 4H bars).
        h4['fwd'] = h4.close.shift(-6) / h4.close - 1.0
        h4['spy_today'] = h4.day.map(spy_map)
        # An INTRADAY bar is one where the day is not yet over — exactly where the leak bites.
        first_hour = h4.groupby('day').hour.transform('min')
        h4['intraday'] = h4.hour > first_hour
        d = h4.dropna(subset=['fwd', 'spy_today'])
        rows.append(d.assign(symbol=sym))
    d = pd.concat(rows, ignore_index=True)

    print(f'{len(d):,} stock 4H bars, {d.symbol.nunique()} symbols\n')
    print('correlation between the LEAKED quantity (today\'s full-day SPY return, which the buggy')
    print('slice exposed) and the FORWARD 24h return the label measures:\n')
    print(f'{"population":>28}{"n":>10}{"corr":>10}{"|corr|>0.05":>13}')
    for label, m in (('all bars', np.ones(len(d), bool)),
                     ('INTRADAY bars (leak bites)', d.intraday.to_numpy()),
                     ('first bar of day (no leak)', ~d.intraday.to_numpy())):
        sub = d[m]
        c = float(np.corrcoef(sub.spy_today, sub.fwd)[0, 1])
        print(f'{label:>28}{len(sub):>10,}{c:>10.4f}{"YES" if abs(c) > 0.05 else "no":>13}')

    print('\nby symbol, intraday bars only:')
    for sym, g in d[d.intraday].groupby('symbol'):
        print(f'  {sym:>6}  n={len(g):>6,}  corr={float(np.corrcoef(g.spy_today, g.fwd)[0, 1]):+.4f}')

    # The share of the forward window that overlaps the leaked day.
    print('\nmechanism: an intraday bar\'s 24h forward window overlaps the remainder of the very day')
    print('whose SPY close the feature encoded. Hours of overlap by bar-of-day:')
    for h, g in d[d.intraday].groupby('hour'):
        print(f'  {h:02d}:00 ET  n={len(g):>6,}  corr={float(np.corrcoef(g.spy_today, g.fwd)[0, 1]):+.4f}')


if __name__ == '__main__':
    main()
