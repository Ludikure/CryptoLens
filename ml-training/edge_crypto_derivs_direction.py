#!/usr/bin/env python3
"""
Crypto-only: test derivative-based DIRECTION primitives on the clean forward split.
These columns already exist (fundingRateRaw, takerRatioRaw, longPctRaw, oiChangePct)
but are only used as direction-AGNOSTIC ML features, never as a direction signal.

The DERIVATIVES_SCORING_PLAN.md hypotheses, tested in isolation as the direction
filter on top of rising-edge ML >= 0.70, dStoch-equivalent slots:

  funding-contrarian:  extreme +funding (crowded longs) -> SHORT; extreme -funding -> LONG
  taker-momentum:      taker ratio > 1.05 -> LONG; < 0.95 -> SHORT
  ls-contrarian:       longPct > 0.62 -> SHORT (crowded longs); < 0.38 -> LONG
  oi-price:            (needs price dir) skipped here — covered by dStoch already
  dStoch + funding-confirm: dStoch direction, but only when funding doesn't contradict

Compared head-to-head with dStoch (validated winner) and the conflict-recovery
question: on bias-vs-dStoch CONFLICT bars (currently skipped in prod), does any
derivative signal recover positive EV?

Band fixed to crypto-optimal 1.5/3.0. Conservative SL-first tie-break.
"""
import numpy as np, pandas as pd

ev = __import__('edge_validation')
FEATURES, load_features, build_candle_index = ev.FEATURES, ev.load_features, ev.build_candle_index
make_model, resolve_fill = ev.make_model, ev.resolve_fill
EMBARGO_DAYS, TRAIN_FRAC, HORIZON_BARS = 14, 0.70, 6
SL_ATR, TP_ATR = 1.5, 3.0


def forward_test(df):
    t_lo, t_hi = df['timestamp'].min(), df['timestamp'].max()
    split_t = t_lo + (t_hi - t_lo) * TRAIN_FRAC
    train = df[df['timestamp'] < split_t]
    test = df[df['timestamp'] >= split_t + EMBARGO_DAYS*86400].copy()
    m = make_model(); m.fit(train[FEATURES].fillna(0), train['goodR'])
    test['mlProb'] = m.predict_proba(test[FEATURES].fillna(0))[:, 1]
    return test


def d_dstoch(r):
    s = r['dStochCross']; return 1 if s == 1 else (-1 if s == -1 else 0)

def d_funding_contrarian(r):
    f = r.get('fundingRateRaw', 0) or 0
    if f >= 0.0005: return -1   # crowded longs -> fade
    if f <= -0.0005: return 1   # crowded shorts -> fade
    return 0

def d_taker(r):
    t = r.get('takerRatioRaw', 1) or 1
    if t >= 1.05: return 1
    if t <= 0.95: return -1
    return 0

def d_ls_contrarian(r):
    lp = r.get('longPctRaw', 0.5) or 0.5
    if lp >= 0.62: return -1
    if lp <= 0.38: return 1
    return 0

def d_dstoch_funding_confirm(r):
    """dStoch direction, suppressed when funding strongly contradicts."""
    d = d_dstoch(r)
    if d == 0: return 0
    f = d_funding_contrarian(r)
    if f != 0 and f != d: return 0  # funding says the crowd is the other way -> skip
    return d


def resolve(rows, idx, dir_fn):
    out = []
    for _, r in rows.iterrows():
        d = dir_fn(r)
        if d == 0: continue
        sym = r['symbol']
        if sym not in idx: continue
        ap = r['atrPercent']
        if ap <= 0: continue
        entry = r['price']; atrp = entry*ap/100.0
        if d == 1: sl, tp = entry-atrp*SL_ATR, entry+atrp*TP_ATR
        else: sl, tp = entry+atrp*SL_ATR, entry-atrp*TP_ATR
        c = idx[sym]; i = np.searchsorted(c['ts'], r['ts_ms'], side='right')
        if i >= len(c['ts']): continue
        block = {k: c[k][i:i+HORIZON_BARS] for k in ('open','high','low','close')}
        if len(block['high']) == 0: continue
        res = resolve_fill(d, entry, sl, tp, block, SL_ATR, TP_ATR)
        if res is None: continue
        out.append({'symbol': sym, 'direction': d, 'R': res})
    return pd.DataFrame(out)


def rep(name, df):
    if len(df) == 0: print(f"  {name:<34} n=0"); return
    print(f"  {name:<34} n={len(df):>5,}  L={int((df['direction']==1).sum()):>4}/S={int((df['direction']==-1).sum()):>4}  "
          f"win={ (df['R']>0).mean()*100:>4.1f}%  EV={df['R'].mean():>+6.3f}R  totalR={df['R'].sum():>+8.1f}")


def main():
    print("Loading crypto (77 symbols)...")
    df = load_features('csv_exports_v11')
    idx = build_candle_index('crypto_candles_4h.csv.gz')
    test = forward_test(df).sort_values(['symbol','timestamp']).reset_index(drop=True)
    test['prevMl'] = test.groupby('symbol')['mlProb'].shift(1)
    rising = test[(test['prevMl'] < 0.70) & (test['mlProb'] >= 0.70)].copy()
    print(f"rising-edge events: {len(rising):,}  | band {SL_ATR}/{TP_ATR}\n")

    print("Direction primitives head-to-head (crypto, clean OOS):")
    for name, fn in [('dStoch (validated winner)', d_dstoch),
                     ('funding-contrarian', d_funding_contrarian),
                     ('taker-momentum', d_taker),
                     ('ls-contrarian', d_ls_contrarian),
                     ('dStoch + funding-confirm', d_dstoch_funding_confirm)]:
        rep(name, resolve(rising, idx, fn))

    # Conflict-recovery: bias vs dStoch disagree -> currently skipped in prod.
    def bias_dir(r):
        a = r['biasAlignment']; return 1 if a=='aligned_bullish' else (-1 if a=='aligned_bearish' else 0)
    rising['biasDir'] = rising.apply(bias_dir, axis=1)
    rising['stochDir'] = rising.apply(d_dstoch, axis=1)
    conflict = rising[(rising['biasDir'] != 0) & (rising['stochDir'] != 0) &
                      (rising['biasDir'] != rising['stochDir'])].copy()
    print(f"\nConflict bars (bias vs dStoch disagree — prod SKIPS these): n={len(conflict):,}")
    if len(conflict):
        rep("  if we took bias dir", resolve(conflict, idx, bias_dir))
        rep("  if we took dStoch dir", resolve(conflict, idx, d_dstoch))
        rep("  if we took funding-contrarian", resolve(conflict, idx, d_funding_contrarian))


if __name__ == '__main__':
    main()
