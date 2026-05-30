#!/usr/bin/env python3
"""
Phase 1 — triple-barrier tradeable label + direction-conditioned meta-model.

For this architecture, triple-barrier (1a) and meta-labeling (1b) merge: the
tradeable label is the triple-barrier outcome IN THE PRIMITIVE'S DIRECTION, and
the model that predicts it is the meta-model. We compare gating on the meta-prob
to the current direction-agnostic goodR gate, on the harness scorecard, with the
frozen holdout reserved.

Tradeable (triple-barrier) label, vectorized from existing columns:
  dir = union(bias, dStoch)            (the direction we'd actually take)
  favExc = (dir==1 ? fwdMaxUp24H : fwdMaxDown24H) / atrPercent     [ATR units]
  advExc = (dir==1 ? fwdMaxDown24H : fwdMaxUp24H) / atrPercent
  tbWin  = 1 if favExc >= 1.5 AND advExc < 1.0 else 0   (conservative: both-touch=loss,
           matching the SL-first tie-break used in the resolve)

Scenarios (actual resolved R via the harness candle-walk):
  A baseline       : rising-edge goodR-prob >=0.70, take union dir
  B meta-filter@t  : A's signals, kept only if metaProb >= t
  C meta-primary@t : rising-edge metaProb >= t, take union dir

Run:  python3 phase1_meta.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
FEATURES = H.FEATURES
EMBARGO = 14 * 86400
SL_ATR, TP_ATR = 1.0, 1.5
META_FEATURES = FEATURES + ['tradeDir']
META_THRESHOLDS = [0.50, 0.55, 0.60, 0.65]


def add_labels(df):
    """Vectorized union direction + triple-barrier tradeable label."""
    a = df['biasAlignment'].values
    biasDir = np.where(a == 'aligned_bullish', 1, np.where(a == 'aligned_bearish', -1, 0))
    s = df['dStochCross'].fillna(0).values
    stochDir = np.where(s == 1, 1, np.where(s == -1, -1, 0))
    conflict = (biasDir != 0) & (stochDir != 0) & (biasDir != stochDir)
    union = np.where(biasDir != 0, biasDir, stochDir)
    union = np.where(conflict, 0, union)
    df['tradeDir'] = union
    atr = df['atrPercent'].replace(0, np.nan)
    up_atr = df['fwdMaxUp24H'] / atr
    dn_atr = df['fwdMaxDown24H'] / atr
    favExc = np.where(union == 1, up_atr, dn_atr)
    advExc = np.where(union == 1, dn_atr, up_atr)
    df['tbWin'] = ((favExc >= TP_ATR) & (advExc < SL_ATR)).astype(int)
    return df


def wf_dual(selection):
    """5-fold clean WF (timestamp split + 14d embargo) training BOTH the goodR
    quality model and the direction-conditioned meta-model on selection data."""
    t = selection['timestamp'].values
    t_lo, t_hi = t.min(), t.max()
    span = t_hi - t_lo
    out = []
    for i in range(5):
        lo = t_lo + span * (0.25 + i * 0.15)
        hi = t_lo + span * (0.25 + (i + 1) * 0.15) if i < 4 else t_hi + 1
        train = selection[selection['timestamp'] < lo - EMBARGO]
        val = selection[(selection['timestamp'] >= lo) & (selection['timestamp'] < hi)].copy()
        if len(train) < 5000 or len(val) < 200:
            continue
        # quality (goodR) — direction-agnostic, current production target
        mq = H.make_model()
        mq.fit(train[FEATURES].fillna(0), train['goodR'])
        val['mlProb'] = mq.predict_proba(val[FEATURES].fillna(0))[:, 1]
        # meta — direction-conditioned tradeable label; train only where a dir fires
        trm = train[train['tradeDir'] != 0]
        mm = H.make_model()
        mm.fit(trm[META_FEATURES].fillna(0), trm['tbWin'])
        val['metaProb'] = mm.predict_proba(val[META_FEATURES].fillna(0))[:, 1]
        out.append(val)
    val = pd.concat(out, ignore_index=True).sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    val['prevMl'] = val.groupby('symbol')['mlProb'].shift(1)
    val['prevMeta'] = val.groupby('symbol')['metaProb'].shift(1)
    return val


def _ev(res):
    n = len(res)
    if n == 0:
        return dict(n=0, win=0, ev=0, totalR=0)
    return dict(n=n, win=float((res['R'] > 0).mean() * 100),
                ev=float(res['R'].mean()), totalR=float(res['R'].sum()))


def run(market):
    print(f"\n{'='*82}\n{market.upper()}\n{'='*82}")
    df, idx = H.load_market(market)
    df = add_labels(df)
    selection, holdout, boundary = H.split_holdout(df)
    print(f"  selection={len(selection):,}  holdout reserved >= {pd.to_datetime(boundary,unit='s').date()}")
    val = wf_dual(selection)

    # --- Optimism of the current label: among rising-edge tradeable bars, how
    #     many "goodR=1" are actually triple-barrier losses? ---
    re_mask = (val['prevMl'] < 0.70) & (val['mlProb'] >= 0.70) & (val['tradeDir'] != 0)
    re = val[re_mask]
    goodR1 = re[re['goodR'] == 1]
    optimism = (goodR1['tbWin'] == 0).mean() * 100 if len(goodR1) else 0
    print(f"\n  Label optimism: of rising-edge goodR=1 tradeable bars, "
          f"{optimism:.1f}% are triple-barrier LOSSES (n={len(goodR1):,})")

    # --- A: baseline (rising-edge goodR>=0.70, union dir) ---
    A = H._resolve(re, idx, H.dir_union)
    a = _ev(A)
    print(f"\n  {'scenario':<26} {'n':>6} {'win%':>6} {'EV(R)':>8} {'totalR':>9}  {'note'}")
    print("  " + "-"*72)
    print(f"  {'A baseline (goodR gate)':<26} {a['n']:>6,} {a['win']:>5.1f}% {a['ev']:>+7.3f} {a['totalR']:>+8.1f}")

    # --- B: meta-filter on A's signals ---
    best_b = None
    for t in META_THRESHOLDS:
        sub = re[re['metaProb'] >= t]
        B = H._resolve(sub, idx, H.dir_union)
        b = _ev(B)
        keep = b['n'] / max(1, a['n']) * 100
        print(f"  {'B meta-filter @'+str(t):<26} {b['n']:>6,} {b['win']:>5.1f}% {b['ev']:>+7.3f} {b['totalR']:>+8.1f}  keeps {keep:.0f}% of A")
        if b['n'] > 100 and (best_b is None or b['ev'] > best_b['ev']):
            best_b = dict(t=t, **b)

    # --- C: meta-primary (rising-edge of metaProb) ---
    for t in META_THRESHOLDS:
        cm = (val['prevMeta'] < t) & (val['metaProb'] >= t) & (val['tradeDir'] != 0)
        C = H._resolve(val[cm], idx, H.dir_union)
        c = _ev(C)
        print(f"  {'C meta-primary @'+str(t):<26} {c['n']:>6,} {c['win']:>5.1f}% {c['ev']:>+7.3f} {c['totalR']:>+8.1f}")

    # verdict
    if best_b:
        d_ev = best_b['ev'] - a['ev']
        print(f"\n  Best meta-filter: @{best_b['t']}  EV {best_b['ev']:+.3f}R vs baseline {a['ev']:+.3f}R "
              f"({d_ev:+.3f}R/trade, {best_b['n']:,} vs {a['n']:,} trades)")
        H.save_result('phase1_meta', market, dict(
            baseline_ev=a['ev'], baseline_n=a['n'], baseline_totalR=a['totalR'],
            best_meta_t=best_b['t'], best_meta_ev=best_b['ev'], best_meta_n=best_b['n'],
            best_meta_totalR=best_b['totalR'], label_optimism_pct=optimism))


def main():
    for mk in ('stock', 'crypto'):
        run(mk)
    print(f"\nsaved to {H.RESULTS_PATH}")


if __name__ == '__main__':
    main()
