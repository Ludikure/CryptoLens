#!/usr/bin/env python3
"""Which Conviction Envelope conditions earn their place?

Pre-declared in docs/research/envelope-rules.md (frozen at 52b386b). Posed as a GATE question --
does blocking these bars improve the mean outcome of the bars that REMAIN? -- not as a correlation,
because a condition can track poor outcomes and still be a bad gate if it removes good bars too.

Geometry is the APP'S: stop 2.0 ATR, TP2 2.5 ATR (= 1.25R). Fees scale with the stop, so a 2 ATR
stop halves the R-cost of the same round trip.
"""
import numpy as np, pandas as pd, lightgbm as lgb

FEE, PURGE = 0.171, 24
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)

d = (pd.read_pickle('excursion_dataset.pkl.gz')
       .merge(pd.read_pickle('envelope_payoff_rows.pkl.gz'), on=['symbol','timestamp'])
       .sort_values('timestamp').reset_index(drop=True))
feats = [c for c in d.columns if c.startswith('f_') and c != 'f_timestamp'
         and not c.startswith(('f_fwd','f_trade')) and pd.api.types.is_numeric_dtype(d[c])]
d['fee_r'] = FEE / (d['f_atrPercent'].clip(lower=0.05) * 2.0)     # 2 ATR stop
d['y_goodr'] = (d['f_fwdMaxFavR'] >= 1.5).astype(int)
d['dt'] = pd.to_datetime(d.timestamp, unit='s')

# ---- ML_WIN stand-in: walk-forward goodR predictions, purged ----
d['ml'] = np.nan
uniq = np.unique(d.timestamp.values)
for i in range(4):
    tr_end = int(len(uniq)*(0.35+0.15*i)); te_end = int(len(uniq)*(0.50+0.15*i))
    if te_end > len(uniq): break
    tr_t, pg_t, te_t = uniq[tr_end-1], uniq[min(tr_end+PURGE,len(uniq)-1)], uniq[te_end-1]
    tr = d[d.timestamp <= tr_t]; msk = (d.timestamp > pg_t) & (d.timestamp <= te_t)
    if len(tr) < 20000 or msk.sum() < 1000: continue
    m = lgb.LGBMClassifier(**PARAMS).fit(tr[feats], tr['y_goodr'])
    d.loc[msk, 'ml'] = m.predict_proba(d.loc[msk, feats])[:,1]
d = d.dropna(subset=['ml']).reset_index(drop=True)
print(f'{len(d):,} bars with out-of-fold ML_WIN  ({d.dt.min().date()} → {d.dt.max().date()})')
print(f'ML_WIN distribution: p10={d.ml.quantile(.1):.3f} median={d.ml.median():.3f} p90={d.ml.quantile(.9):.3f}\n')

al = d.f_tfAlignment; age = d.f_barsSinceRegimeChange
# No raw EMA200 in the feature set, so the chase/bear conditions are reconstructed from the
# stack flags the model actually sees: a full bull/bear stack IS the "extended aligned trend" state.
stack_bull = d.f_dStackBull.astype(bool); stack_bear = d.f_dStackBear.astype(bool)

CONDITIONS = {
    'ML_WIN < 50':                    d.ml < 0.50,
    'ML_WIN < 60':                    d.ml < 0.60,
    'ML_WIN < 70':                    d.ml < 0.70,
    'biases_MIXED and ML<70':         (al == 0) & (d.ml < 0.70),
    'alignment_not_full':             al.abs() < 2,
    'chase: aligned + full stack':    (al.abs() == 2) & (stack_bull | stack_bear),
    'chase: mature + full stack':     (age >= 30) & (stack_bull | stack_bear),
    'crypto_bear_regime (bear stack)': stack_bear,
    'RSI stretched (>70 or <30)':     (d.f_dRsi > 70) | (d.f_dRsi < 30),
    'trend mature (age>=30)':         age >= 30,
}

def net(mask, side, tgt='tp2'):
    g = d[mask]
    return np.nan if len(g)==0 else (g[f'{tgt}_{side}_R'] - g.fee_r).mean()

periods = pd.date_range('2022-01-01','2026-07-01',freq='6MS')
import sys
SIDE = sys.argv[1] if len(sys.argv) > 1 else 'SHORT'
print(f'=== {SIDE} side, TP2 (1.25R), net of fees ===')
print(f'{"condition":>32}{"fires":>8}{"blocked":>9}{"kept":>9}{"lift":>9}{"periods+":>10}{"verdict":>16}')
print('-'*93)
results=[]
for name, fires in CONDITIONS.items():
    if fires.sum() < 500: continue
    base = net(pd.Series(True, index=d.index), SIDE)
    kept = net(~fires, SIDE); blocked = net(fires, SIDE)
    lift = kept - base
    coverage = (~fires).mean()
    # sign count across non-overlapping periods
    pos = 0; tot = 0
    for i in range(len(periods)-1):
        w = (d.dt >= periods[i]) & (d.dt < periods[i+1])
        if w.sum() < 2000: continue
        b = net(w, SIDE); k = net(w & ~fires, SIDE)
        if np.isfinite(b) and np.isfinite(k): tot += 1; pos += (k - b) >= 0
    c1 = lift >= 0.02; c2 = tot>0 and pos >= 6; c3 = coverage >= 0.20
    verdict = 'EARNS ITS PLACE' if (c1 and c2 and c3) else (
        'noise' if not c1 else ('regime-dependent' if not c2 else 'kills coverage'))
    print(f'{name:>32}{fires.mean():>8.1%}{blocked:>9.4f}{kept:>9.4f}{lift:>+9.4f}'
          f'{f"{pos}/{tot}":>10}{verdict:>16}')
    results.append((name, lift, pos, tot, coverage, verdict))

print(f'\n  baseline (trade everything, SHORT, TP2): {net(pd.Series(True,index=d.index),"SHORT"):+.4f}R')
print(f'  baseline LONG: {net(pd.Series(True,index=d.index),"LONG"):+.4f}R')
pd.DataFrame(results, columns=['condition','lift','pos','tot','coverage','verdict']).to_csv('envelope_test.csv', index=False)
