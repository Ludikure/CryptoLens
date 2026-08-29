#!/usr/bin/env python3
"""T5 — volatility-conditioned tail strategy.

Does the proven volatility model tell us WHEN the proven convex payoff is worth deploying?
Both components already have independent empirical support; no new features, no directional claim.

Design pre-declared by the user. Non-negotiables honoured:
  - OHLC path simulator (1h bars inside the 72h horizon), NOT close-only
  - percentile thresholds fitted on TRAINING data only, applied forward
  - production model config frozen (LGB d4/t150); no tuning after seeing folds
  - 1R/5R and 72h unchanged; direction-agnostic throughout
"""
import numpy as np, pandas as pd, lightgbm as lgb
from pathlib import Path

STOP_R, TGT_R, HOLD_H = 1.0, 5.0, 72
COST_PCT = 0.25
TAIL_DECILE = 0.90                      # matches strategy_tail_test.py's top-decile gate
DROP = {'symbol','timestamp','price','regime','emaRegime'}
KL = Path('vision_backfill/klines_long')


def load_paths(sym):
    f = KL/f'{sym}.csv'
    if not f.exists(): return None
    k = pd.read_csv(f).sort_values('ts').reset_index(drop=True)
    return k


def simulate(k, idx, P, A, horizon_bars):
    """Resolve 1R-stop / 5R-target from real OHLC, both directions.

    Same-bar ambiguity (stop and target both touched within one 1h bar) is charged as the STOP —
    the conservative reading, applied identically to every arm so it cannot favour a filter.
    """
    hi = k['high'].values; lo = k['low'].values; cl = k['close'].values
    end = min(idx + horizon_bars, len(k))
    out = []
    for sgn in (1, -1):
        stop = P - sgn*STOP_R*A
        tgt  = P + sgn*TGT_R*A
        r = None
        for j in range(idx+1, end):
            hit_s = (lo[j] <= stop) if sgn > 0 else (hi[j] >= stop)
            hit_t = (hi[j] >= tgt)  if sgn > 0 else (lo[j] <= tgt)
            if hit_s: r = -STOP_R; break
            if hit_t: r =  TGT_R; break
        if r is None:
            r = sgn*(cl[end-1] - P)/A if end > idx+1 else 0.0
        out.append(max(min(r, TGT_R), -STOP_R))
    return float(np.mean(out))          # direction-agnostic: mean of long and short


def build():
    rows = []
    for f in sorted(Path('csv_exports_v14').glob('*.csv')):
        sym = f.stem
        k = load_paths(sym)
        if k is None: continue
        d = pd.read_csv(f, low_memory=False).sort_values('timestamp').reset_index(drop=True)
        if 'atrPercent' not in d: continue
        pos = {t: i for i, t in enumerate(k['ts'].values)}
        d['kidx'] = d['timestamp'].map(pos)
        d = d[d.kidx.notna()].copy(); d['kidx'] = d.kidx.astype(int)
        if len(d) < 400: continue
        A = (d.atrPercent/100.0*d.price)
        hi = k['high'].values; lo = k['low'].values
        R, favR72, favR24 = [], [], []
        for _, r in d.iterrows():
            i, P, a = int(r.kidx), r.price, A.loc[r.name]
            if not (a > 0) or i+HOLD_H >= len(k):
                R.append(np.nan); favR72.append(np.nan); favR24.append(np.nan); continue
            R.append(simulate(k, i, P, a, HOLD_H))
            w72 = slice(i+1, i+1+HOLD_H); w24 = slice(i+1, i+1+24)
            favR72.append(max(hi[w72].max()-P, P-lo[w72].min())/a)
            favR24.append(max(hi[w24].max()-P, P-lo[w24].min())/a)
        d['R'] = R; d['favR72'] = favR72; d['favR24'] = favR24
        d['sym'] = sym
        rows.append(d)
    a = pd.concat(rows, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    a = a.dropna(subset=['R','favR72','favR24','atrPercent']).reset_index(drop=True)
    a['bigTail'] = (a.favR72 >= 5).astype(int)          # strategy_tail_test.py definition
    a['goodR'] = (a.favR24 >= 1.5).astype(int)          # production volatility target
    a['cost'] = COST_PCT/a.atrPercent                    # round trip expressed in R
    feats = [c for c in a.columns if c not in DROP and c not in
             ('sym','kidx','R','favR72','favR24','bigTail','goodR','cost')
             and not c.startswith('fwd') and pd.api.types.is_numeric_dtype(a[c])]
    return a, feats


def fit(tr, te, feats, target):
    m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.05,
                           num_leaves=15, verbose=-1, n_jobs=-1)
    m.fit(tr[feats], tr[target])
    return m.predict_proba(te[feats])[:, 1], m.predict_proba(tr[feats])[:, 1]


def metrics(sel, label):
    if sel.empty or len(sel) < 20:
        return dict(label=label, n=len(sel), ev=np.nan, sharpe=np.nan, win=np.nan,
                    loss1r=np.nan, win5r=np.nan, total=np.nan, dd=np.nan)
    net = sel.R - sel.cost
    eq = net.cumsum()
    return dict(label=label, n=len(sel), ev=net.mean(),
                sharpe=net.mean()/net.std() if net.std() else np.nan,
                win=(net > 0).mean()*100,
                loss1r=(sel.R <= -0.99).mean()*100,
                win5r=(sel.R >= 4.99).mean()*100,
                total=net.sum(), dd=(eq - eq.cummax()).min())


def main():
    a, feats = build()
    print(f'{len(a):,} bars, {a.sym.nunique()} symbols, {len(feats)} features')
    print(f'OHLC path simulator: 1h bars, {HOLD_H}h horizon, fees {COST_PCT}% round trip')
    print(f'base rates — bigTail(72h>=5ATR) {a.bigTail.mean()*100:.1f}%  goodR(24h>=1.5ATR) {a.goodR.mean()*100:.1f}%\n')

    n = len(a); fold_rows = []
    for i in range(3):
        tr_end, te_end = int(n*(0.4+0.2*i)), int(n*(0.6+0.2*i))
        tr, te = a.iloc[:max(0, tr_end-48)].copy(), a.iloc[tr_end:te_end].copy()
        if len(tr) < 5000 or len(te) < 1000: continue
        tailP, tailP_tr = fit(tr, te, feats, 'bigTail')
        volP,  volP_tr  = fit(tr, te, feats, 'goodR')
        te['tailP'] = tailP; te['volP'] = volP
        # thresholds from TRAINING data only — no full-dataset percentiles, no lookahead
        tail_thr = np.quantile(tailP_tr, TAIL_DECILE)
        gated = te[te.tailP >= tail_thr].copy()
        arms = {'A: ALL (unfiltered)': gated}
        for pct, name in ((0.50,'B: vol >= 50th'), (0.70,'C: vol >= 70th'), (0.90,'D: vol >= 90th')):
            arms[name] = gated[gated.volP >= np.quantile(volP_tr, pct)]
        # CONTROL 1 — random filter matched to arm C's trade count
        rng = np.random.default_rng(42 + i)
        nC = len(arms['C: vol >= 70th'])
        arms['ctrl1: random (n=C)'] = gated.iloc[rng.choice(len(gated), min(nC, len(gated)), replace=False)] if len(gated) else gated
        # CONTROL 2 — lagged REALISED vol in place of the model
        if 'atrPercentile' in gated:
            arms['ctrl2: realised vol >=70th'] = gated[gated.atrPercentile >= np.quantile(tr.atrPercentile.dropna(), 0.70)]
        for k, v in arms.items():
            r = metrics(v, k); r['fold'] = i+1; fold_rows.append(r)
        print(f"fold {i+1}: gated {len(gated):,} of {len(te):,}  "
              f"tail top-decile realized bigTail {gated.bigTail.mean()*100:.0f}% (base {te.bigTail.mean()*100:.0f}%)")

    df = pd.DataFrame(fold_rows)
    print(f"\n{'arm':<26}{'trades':>8}{'netEV/tr':>10}{'Sharpe':>8}{'win%':>7}{'1R-loss%':>10}{'5R-win%':>9}{'totalR':>9}{'maxDD':>8}")
    order = ['A: ALL (unfiltered)','B: vol >= 50th','C: vol >= 70th','D: vol >= 90th',
             'ctrl1: random (n=C)','ctrl2: realised vol >=70th']
    agg = {}
    for lbl in order:
        s = df[df.label == lbl]
        if s.empty: continue
        agg[lbl] = s
        print(f"{lbl:<26}{s.n.sum():>8,}{s.ev.mean():>+10.4f}{s.sharpe.mean():>8.3f}{s.win.mean():>7.1f}"
              f"{s.loss1r.mean():>10.1f}{s.win5r.mean():>9.1f}{s.total.sum():>+9.1f}{s.dd.mean():>8.1f}")

    base = agg['A: ALL (unfiltered)']
    print(f"\nper-fold netEV/trade:")
    for lbl in order:
        if lbl in agg:
            print(f"  {lbl:<26}{'  '.join(f'{x:+.4f}' for x in agg[lbl].ev)}")

    print('\n--- SECONDARY: monotonicity across vol percentile ---')
    evs = [agg[l].ev.mean() for l in order[:4] if l in agg]
    print('  ' + '  ->  '.join(f'{x:+.4f}' for x in evs) +
          ('   MONOTONE RISING' if all(b >= x for x, b in zip(evs, evs[1:])) else '   NOT monotone'))

    print('\n--- SHIP BAR (best filtered arm vs unfiltered) ---')
    best = max([l for l in order[1:4] if l in agg], key=lambda l: agg[l].ev.mean())
    B = agg[best]; A_ = base
    beat = sum(1 for x, y in zip(B.ev.values, A_.ev.values) if x > y)
    c1 = beat >= 2
    c2 = (B.ev > 0).sum() >= 2
    c3 = (B.ev.mean() - A_.ev.mean()) >= 0.03
    c4 = B.n.sum() >= 0.10 * A_.n.sum()
    print(f"  best filtered arm: {best}")
    for ok, t in [(c1, f"1. beats unfiltered in >=2/3 folds        {beat}/3"),
                  (c2, f"2. positive net EV in >=2/3 folds         {(B.ev>0).sum()}/3"),
                  (c3, f"3. improvement >= +0.03R/trade            {B.ev.mean()-A_.ev.mean():+.4f}"),
                  (c4, f"4. trade count >= 10% of unfiltered       {B.n.sum()/max(1,A_.n.sum())*100:.0f}%")]:
        print(f"  [{'PASS' if ok else 'FAIL'}] {t}")
    print(f"\n  CONTROLS: random(n=C) {agg['ctrl1: random (n=C)'].ev.mean():+.4f}"
          f"   realised-vol {agg.get('ctrl2: realised vol >=70th', pd.DataFrame({'ev':[np.nan]})).ev.mean():+.4f}"
          f"   vs model-filtered {agg[best].ev.mean():+.4f}")
    print(f"\n  VERDICT: {'SHIP (pending holdout)' if all([c1,c2,c3,c4]) else 'DOES NOT MEET THE BAR'}")


if __name__ == '__main__':
    main()
