#!/usr/bin/env python3
"""Multi-month regime holds — the pre-declared test.

Design frozen in docs/research/regime-hold.md BEFORE this ran. No parameter sweep: 200D EMA with a
20-day slope filter is inherited from the app's existing crypto-bear-regime flag, not fitted here.

Counts what the exploratory probe ignored: FUNDING. On perps a short receives funding while funding
is positive (the normal crypto state), a long pays it. Over a multi-month hold that is material
carry, and it is the component that could plausibly close the gap to buy-and-hold.
"""
import numpy as np, pandas as pd
from pathlib import Path

HERE = Path(__file__).parent
UNIVERSE = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT',
            'BNBUSDT','DOTUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','UNIUSDT']
FEE = 0.0010          # round trip per position change
EMA, SLOPE = 200, 20


def daily(sym):
    """Daily close + daily funding, from the v14 export (4H bars, funding in percent per 8h)."""
    f = HERE / 'csv_exports_v14' / f'{sym}.csv'
    if not f.exists():
        return None
    d = pd.read_csv(f, usecols=['timestamp', 'price', 'fundingRateRaw'])
    d['ts'] = pd.to_datetime(d['timestamp'], unit='s', utc=True)
    d['date'] = d['ts'].dt.date
    g = d.groupby('date').agg(price=('price', 'last'), fr=('fundingRateRaw', 'mean')).reset_index()
    # fundingRateRaw is percent per 8h funding interval -> 3 intervals a day, to a fraction
    g['fund_day'] = g['fr'].fillna(0) / 100.0 * 3.0
    return g[g['price'] > 0].reset_index(drop=True)


def run(sym):
    g = daily(sym)
    if g is None or len(g) < EMA + SLOPE + 60:
        return None
    g['ema'] = g['price'].ewm(span=EMA, adjust=False).mean()
    g['slope'] = g['ema'].diff(SLOPE)
    g['sig'] = np.where((g.price < g.ema) & (g.slope < 0), -1,
                np.where((g.price > g.ema) & (g.slope > 0),  1, 0))
    g = g.iloc[EMA + SLOPE:].reset_index(drop=True)
    g['ret'] = g['price'].pct_change().fillna(0)
    g['pos'] = g['sig'].shift(1).fillna(0)                    # act on the PRIOR close — no lookahead
    g['chg'] = (g['pos'].diff().fillna(0) != 0).astype(int)
    # funding: a short RECEIVES when funding is positive, a long PAYS it
    g['carry'] = -g['pos'] * g['fund_day']
    g['pnl'] = g['pos'] * g['ret'] + g['carry'] - g['chg'] * FEE
    g['pnl_nofund'] = g['pos'] * g['ret'] - g['chg'] * FEE
    g['bh'] = g['ret']
    g['sym'] = sym
    return g


def stats(pnl, label):
    eq = (1 + pnl).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    yrs = len(pnl) / 365.25
    cagr = eq.iloc[-1] ** (1 / yrs) - 1 if eq.iloc[-1] > 0 and yrs > 0 else np.nan
    sharpe = pnl.mean() / pnl.std() * np.sqrt(365.25) if pnl.std() else np.nan
    return dict(label=label, total=(eq.iloc[-1] - 1) * 100, cagr=cagr * 100, dd=dd * 100, sharpe=sharpe)


def main():
    frames = [r for r in (run(s) for s in UNIVERSE) if r is not None]
    print(f'symbols with usable history: {len(frames)}/{len(UNIVERSE)}')
    all_ = pd.concat(frames)
    # equal-weight portfolio: mean across symbols present each day
    port = all_.groupby('date').agg(strat=('pnl', 'mean'), nofund=('pnl_nofund', 'mean'),
                                    bh=('bh', 'mean'), n=('sym', 'count')).reset_index()
    port = port[port['n'] >= 3].reset_index(drop=True)
    print(f'portfolio span {port.date.iloc[0]} -> {port.date.iloc[-1]}  ({len(port):,} days)\n')

    rows = [stats(port['strat'], 'REGIME (with funding)'),
            stats(port['nofund'], 'REGIME (no funding)'),
            stats(port['bh'], 'buy & hold')]
    print(f"{'':<24}{'total':>11}{'CAGR':>9}{'maxDD':>9}{'Sharpe':>8}")
    for r in rows:
        print(f"{r['label']:<24}{r['total']:>10,.0f}%{r['cagr']:>8.1f}%{r['dd']:>8.1f}%{r['sharpe']:>8.2f}")

    chg = all_.groupby('sym')['chg'].sum()
    yrs = (pd.Timestamp(port.date.iloc[-1]) - pd.Timestamp(port.date.iloc[0])).days / 365.25
    print(f"\nposition changes per symbol over {yrs:.1f}y: median {chg.median():.0f}, max {chg.max():.0f}")
    print(f"funding contribution: {(port['strat'].sum() - port['nofund'].sum())*100:+.1f}pp of raw return")
    ex = all_.groupby('date')['pos'].mean()
    print(f"average net exposure: {ex.mean():+.2f}  (time net-short {(ex<0).mean()*100:.0f}% of days)")

    # walk-forward folds
    print('\nWALK-FORWARD (expanding):')
    cuts = np.array_split(np.arange(len(port)), 3)
    for i, c in enumerate(cuts):
        p = port.iloc[c]
        s, b = (1 + p['strat']).prod() - 1, (1 + p['bh']).prod() - 1
        print(f"  fold {i+1}  {p.date.iloc[0]} -> {p.date.iloc[-1]}   regime {s*100:>+8.1f}%   B&H {b*100:>+8.1f}%   {'WIN' if s>b else 'lose'}")

    print('\nBEAR PERIODS (the capability being bought):')
    for name, a, b in [('2022 bear', '2021-11-10', '2022-11-21'), ('2025-26 bear', '2025-10-06', '2026-06-25')]:
        m = (port.date >= pd.Timestamp(a).date()) & (port.date <= pd.Timestamp(b).date())
        if m.sum() < 30: continue
        p = port[m]
        s, bh = (1 + p['strat']).prod() - 1, (1 + p['bh']).prod() - 1
        print(f"  {name:<14}{p.date.iloc[0]} -> {p.date.iloc[-1]}   regime {s*100:>+8.1f}%   B&H {bh*100:>+8.1f}%")

    print('\n--- SHIP BAR ---')
    st, bhs = rows[0], rows[2]
    c1 = st['total'] > bhs['total']; c2 = st['dd'] > bhs['dd']; c4 = chg.max() <= 50
    bears = []
    for name, a, b in [('2022 bear', '2021-11-10', '2022-11-21'), ('2025-26 bear', '2025-10-06', '2026-06-25')]:
        m = (port.date >= pd.Timestamp(a).date()) & (port.date <= pd.Timestamp(b).date())
        if m.sum() >= 30: bears.append((1 + port[m]['strat']).prod() - 1 > 0)
    c3 = all(bears) and bears
    for ok, txt in [(c1, f"1. beats buy&hold        {st['total']:,.0f}% vs {bhs['total']:,.0f}%"),
                    (c2, f"2. lower max drawdown    {st['dd']:.1f}% vs {bhs['dd']:.1f}%"),
                    (c3, f"3. positive in bear folds {bears}"),
                    (c4, f"4. <50 changes/symbol    max {chg.max():.0f}")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {txt}")
    print(f"\n  VERDICT: {'SHIP' if all([c1,c2,c3,c4]) else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
