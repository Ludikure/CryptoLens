#!/usr/bin/env python3
"""
Validate the #1 volatility-pricing edge: is "buy an ATM straddle when the app says vol is CHEAP
(HAR-RV forecast > options-implied)" actually +EV, net of real crypto-option friction?

Data: Deribit DVOL (implied vol, annualized %) + daily closes (BTC/ETH).
Model (un-hedged ATM straddle, held H days):
  premium%  ≈ 0.7979 * IV_annual * sqrt(H/365)     (BS ATM straddle ≈ 2*phi(0)*S*sig*sqrt(T))
  payoff%   = |S_{t+H} / S_t - 1|
  net%      = payoff% - premium% - friction%
Friction: crypto ATM option round-trip is EXPENSIVE — bid/ask a few % of premium each way + fees.
Modeled as a fraction of premium (default 8%, i.e. ~4% each side).

Signal (the app's read): HAR-RV forecast vol vs implied. HAR-RV forecast = weighted trailing
realized vol (1d/7d/30d), annualized. "cheap" = forecast > implied * MARGIN.

Reports: baseline (buy every day) vs signal-gated EV per symbol/horizon, net of friction, with n.
The KEY question: does the gate turn indiscriminate vol-buying (expected -EV, you pay the vol
risk premium) into +EV?
"""
import numpy as np, pandas as pd, os
PHI0 = 1.0 / np.sqrt(2 * np.pi)          # 0.3989
STRADDLE_K = 2 * PHI0                      # 0.7979 — ATM straddle price / (S*sig*sqrt(T))
FRICTION_FRAC = float(os.environ.get('FRICTION', '0.08'))   # round-trip friction as fraction of premium
MARGIN = float(os.environ.get('MARGIN', '1.10'))            # forecast must exceed implied by this factor

def load(sym_dvol, sym_px):
    dv = pd.read_csv(f'dvol_{sym_dvol}.csv', parse_dates=['date'])
    c = pd.read_csv('crypto_candles_4h.csv.gz')
    tc = 'time' if 'time' in c.columns else 'timestamp'
    g = c[c['symbol'] == sym_px].copy()
    t = g[tc].astype('int64'); g['t'] = np.where(t > 1e12, t // 1000, t)
    g['date'] = pd.to_datetime(g['t'], unit='s').dt.floor('D')
    daily = g.groupby('date')['close'].last().reset_index()
    df = pd.merge(dv, daily, on='date', how='inner').sort_values('date').reset_index(drop=True)
    # trailing realized vol (annualized) over windows, from daily log returns
    r = np.log(df['close'] / df['close'].shift(1))
    for w in (1, 7, 30):
        df[f'rv{w}'] = r.rolling(w).std() * np.sqrt(365) * 100
    df['rv1'] = (r.abs()) * np.sqrt(365) * 100   # 1-day proxy = |ret|
    # HAR-RV forecast: classic 1/7/30 blend
    df['harv'] = 0.4 * df['rv1'] + 0.35 * df['rv7'] + 0.25 * df['rv30']
    return df

def straddle_pnl(df, H):
    fwd = df['close'].shift(-H) / df['close'] - 1.0
    payoff = fwd.abs() * 100
    premium = STRADDLE_K * df['dvol'] * np.sqrt(H / 365.0)
    friction = premium * FRICTION_FRAC
    net = payoff - premium - friction
    return net, premium, payoff

def summarize(name, net, mask=None):
    x = net.dropna()
    if mask is not None:
        x = net[mask].dropna()
    if len(x) < 30:
        return f"  {name:<34} n={len(x):>4}  (too few)"
    win = (x > 0).mean() * 100
    return f"  {name:<34} n={len(x):>4}  EV={x.mean():+6.2f}%/trade  win={win:4.1f}%  median={x.median():+.2f}%"

def main():
    for dvol_sym, px_sym in [('BTC', 'BTCUSDT'), ('ETH', 'ETHUSDT')]:
        df = load(dvol_sym, px_sym)
        print(f"\n=== {px_sym}  ({df['date'].min().date()} → {df['date'].max().date()}, n={len(df)} days) "
              f"| friction={FRICTION_FRAC*100:.0f}% of premium, cheap-margin={MARGIN:.2f}x ===")
        # baseline vol-risk-premium: implied vs realized-30d-forward
        fwd_rv = (np.log(df['close'] / df['close'].shift(1)).rolling(30).std().shift(-30) * np.sqrt(365) * 100)
        vrp = (df['dvol'] - fwd_rv).mean()
        print(f"  vol-risk-premium (implied - realized30d fwd, mean): {vrp:+.1f} vol pts  "
              f"({'implied RICH — buying vol loses on average' if vrp > 0 else 'implied CHEAP on average'})")
        for H in (7, 14, 30):
            net, prem, payoff = straddle_pnl(df, H)
            cheap = df['harv'] > df['dvol'] * MARGIN
            rich = df['harv'] < df['dvol'] / MARGIN
            print(f" H={H:>2}d  avg premium {prem.mean():.2f}% of spot")
            print(summarize('ALL (buy every day)', net))
            print(summarize('GATED: app says vol CHEAP', net, cheap))
            print(summarize('(contrast) app says vol RICH', net, rich))

if __name__ == '__main__':
    main()
