#!/usr/bin/env python3
"""RETRACTED 2026-08-26 — this script RECONSTRUCTS the Conviction Envelope, and the reconstruction
is measurably wrong. Do not run it, and do not cite any number it produced.

Measured on 799,193 bars across 75 symbols against `envelope_exports/`, which records the REAL verdict from the real
`buildUserPrompt` (`marketscope-worker/scripts/exportEnvelope.ts`). Run
`envelope_reconstruction_audit.py` to reproduce:

  |momentumAlignment| takes values {0, 1}, so `cont < 2` and `cont < 3` fire on 100% of rows
      against a true 75.4% and 99.1%. The reconstructed tier collapses to {FLAT, LOW} and never
      emits MODERATE or HIGH at all. Whole-tier agreement with the real envelope: 11.3%.
  funding_supports_counter is reconstructed as sign(funding) == -bias where the live rule
      (prompt.ts:884) is == sign(bias). Jaccard 0.0000 — the two masks are disjoint by
      construction.
  ANY_KILLED exists only inside `if (oneHOpposes && oneH)`, so every kill rule lives on 6.6% of
      bars. Part 7 scored them on 100% — a 15.1x population inflation.
  biases_MIXED as `tfAlignment == 0` fires on 29.5% where the real MIXED state is 63.9%.

The replacement is a JOIN, not a better reconstruction: read `envelope_exports/<SYM>.csv` and merge
on (symbol, timestamp). The payoff half of these scripts is separately retracted — it indexes price
paths from a feature timestamp that is four hours later than assumed (see the 2026-08-25j entry in
CLAUDE.md), and the shared module that replaces it is plan step 1a.
"""

import sys as _sys
if __name__ == '__main__':
    _sys.exit('RETRACTED — see this file\'s docstring and envelope_reconstruction_audit.py. '
              'The envelope reconstruction disagrees with the real envelope on 89% of bars.')


"""Part 8: the four stock-only envelope conditions.

Pre-declared in docs/research/envelope-rules.md (frozen at 8396f25).

Conditions are transcribed from prompt.ts, not from memory:
  alignedDirection   = daily bias alone ('Bearish'->SHORT, 'Bullish'->LONG, else FLAT)  [:752]
  envAlignment       = needs the 1H bias too -- ALIGNED_* requires daily AND 4H AND 1H  [:1155]
                       (the CSV's `biasAlignment` column is daily+4H only, a DIFFERENT quantity)
  longConfirm        = relStrengthVsSpy>=1.0 and dRsiDelta1>=1.0 -> PASS/PARTIAL/FAIL   [:784]
  shortGate          = aligned-bearish stock SHORT unless ML>=70 AND 4H stoch bearish
                       AND regimeCode==2 (TRENDING)                                     [:1307]
  earnings           = forward days to the next report, from earnings_history.json

TWO lifts are reported. GLOBAL is the pre-declared bar and is primary. WITHIN-APPLICABLE restricts
to the subpopulation where the gate can fire at all -- without it, a gate firing on 4% of bars is
recorded "noise" on arithmetic alone, which says nothing about whether its logic is right.
"""
import glob, json, os
import numpy as np, pandas as pd, lightgbm as lgb

PURGE = 24
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)
BIAS = ['dailyBias', 'fourHBias', 'oneHBias']

d = pd.read_pickle('stock_entry_rows.pkl.gz')

# ---- full feature set + the three bias labels, straight from the v14 stock regen ----
parts = []
for fp in sorted(glob.glob('csv_exports_v14_stocks/*.csv')):
    f = pd.read_csv(fp, low_memory=False)
    tr = f['timestamp'].to_numpy(np.int64)
    f['timestamp'] = (tr // 1000) if tr[0] > 1e12 else tr
    f['symbol'] = os.path.basename(fp)[:-4]
    parts.append(f)
F = pd.concat(parts, ignore_index=True)
feats = [c for c in F.columns
         if c not in ('timestamp', 'symbol') and not c.startswith(('fwd', 'trade'))
         and pd.api.types.is_numeric_dtype(F[c])]
F['y_goodr'] = (F['fwdMaxFavR'] >= 1.5).astype(int)
d = d.merge(F[['symbol', 'timestamp', 'y_goodr'] + BIAS + feats], on=['symbol', 'timestamp'])
d = d.sort_values('timestamp').reset_index(drop=True)
d['dt'] = pd.to_datetime(d.timestamp, unit='s')
d['dow'] = d.dt.dt.dayofweek

# ---- ML_WIN stand-in: walk-forward goodR predictions, purged (same recipe as envelope_test.py) ----
d['ml'] = np.nan
uniq = np.unique(d.timestamp.values)
for i in range(4):
    tr_end = int(len(uniq) * (0.35 + 0.15 * i)); te_end = int(len(uniq) * (0.50 + 0.15 * i))
    if te_end > len(uniq): break
    tr_t, pg_t, te_t = uniq[tr_end - 1], uniq[min(tr_end + PURGE, len(uniq) - 1)], uniq[te_end - 1]
    tr = d[d.timestamp <= tr_t]; msk = (d.timestamp > pg_t) & (d.timestamp <= te_t)
    if len(tr) < 20000 or msk.sum() < 1000: continue
    m = lgb.LGBMClassifier(**PARAMS).fit(tr[feats], tr['y_goodr'])
    d.loc[msk, 'ml'] = m.predict_proba(d.loc[msk, feats])[:, 1]
d = d.dropna(subset=['ml']).reset_index(drop=True)
print(f'{len(d):,} bars with out-of-fold ML_WIN  ({d.dt.min().date()} → {d.dt.max().date()})')
print(f'ML_WIN: p10={d.ml.quantile(.1):.3f} median={d.ml.median():.3f} p90={d.ml.quantile(.9):.3f}')

# ---- forward days to the next earnings report ----
ed = json.load(open('../CryptoLens/Resources/earnings_history.json'))
fwd = np.full(len(d), 9999.0)
for sym, g in d.groupby('symbol', sort=False):
    dates = ed.get(sym)
    if not dates: continue
    et = np.sort(pd.to_datetime(pd.Series(dates)).values)
    ts = g.dt.to_numpy()
    j = np.searchsorted(et, ts, side='left')      # first report AT OR AFTER the bar
    ok = j < len(et)
    v = np.full(len(g), 9999.0)
    v[ok] = (et[j[ok]] - ts[ok]) / np.timedelta64(1, 'D')
    fwd[g.index.to_numpy()] = v
d['earn_fwd_d'] = fwd
cov = (d.earn_fwd_d < 9999).mean()
print(f'earnings dates for {cov:.1%} of bars; '
      f'0-2d {((d.earn_fwd_d>=0)&(d.earn_fwd_d<=2)).mean():.2%} '
      f'3-7d {((d.earn_fwd_d>2)&(d.earn_fwd_d<=7)).mean():.2%} '
      f'8-14d {((d.earn_fwd_d>7)&(d.earn_fwd_d<=14)).mean():.2%}\n')

# ---- reconstruct the envelope's own variables ----
h = lambda col, word: d[col].astype(str).str.contains(word, case=False, na=False)
dB, dU = h('dailyBias', 'Bearish'), h('dailyBias', 'Bullish')
fB, fU = h('fourHBias', 'Bearish'), h('fourHBias', 'Bullish')
oB, oU = h('oneHBias', 'Bearish'), h('oneHBias', 'Bullish')
alignedDir = np.where(dB, 'SHORT', np.where(dU, 'LONG', 'FLAT'))
envAlign = np.where(dU & fU & oU, 'ALIGNED_BULLISH',
           np.where(dB & fB & oB, 'ALIGNED_BEARISH',
           np.where((dU & fU) | (dB & fB), 'HIGHER_TF_ONLY', 'MIXED')))

rsPass, drsPass = d.relStrengthVsSpy >= 1.0, d.dRsiDelta1 >= 1.0
lcFAIL = ~rsPass & ~drsPass
lcPART = rsPass ^ drsPass
shortApplicable = (alignedDir == 'SHORT') & (envAlign == 'ALIGNED_BEARISH')
shortConfirmed = (d.ml >= 0.70) & (d.hStochCross == -1) & (d.regimeCode == 2)

CONDS = {
    'treatment_long_confirm_FAIL':   ((alignedDir == 'LONG') & lcFAIL & (envAlign != 'MIXED'),
                                      pd.Series(alignedDir == 'LONG', index=d.index)),
    'treatment_long_confirm_PARTIAL': ((alignedDir == 'LONG') & lcPART,
                                      pd.Series(alignedDir == 'LONG', index=d.index)),
    'treatment_short_gate_stocks':   (shortApplicable & ~shortConfirmed, shortApplicable),
    'earnings 0-2d (cap LOW)':       ((d.earn_fwd_d >= 0) & (d.earn_fwd_d <= 2),
                                      pd.Series(d.earn_fwd_d < 9999, index=d.index)),
    'earnings 3-7d (cap MODERATE)':  ((d.earn_fwd_d > 2) & (d.earn_fwd_d <= 7),
                                      pd.Series(d.earn_fwd_d < 9999, index=d.index)),
    'earnings 8-14d (downgrade)':    ((d.earn_fwd_d > 7) & (d.earn_fwd_d <= 14),
                                      pd.Series(d.earn_fwd_d < 9999, index=d.index)),
}

periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')


def sweep(col, stratify_dow, label):
    print(f'\n=== {label} ===')
    for side in ('SHORT', 'LONG'):
        c = col.format(side=side)
        print(f'  --- {side} ---')
        print(f'  {"condition":>32}{"fires":>7}{"blocked":>9}{"kept":>9}{"lift":>9}'
              f'{"per+":>7}{"applic.lift":>13}{"verdict":>10}')
        for name, (fires, applic) in CONDS.items():
            fires = pd.Series(np.asarray(fires), index=d.index)
            applic = pd.Series(np.asarray(applic), index=d.index)
            if fires.sum() < 500 or (~fires).sum() < 500:
                print(f'  {name:>32}{fires.mean():>7.1%}{"degenerate":>48}'); continue
            if stratify_dow:
                lifts = []
                for _, g in d.groupby('dow'):
                    f2 = fires.loc[g.index]
                    if f2.sum() < 100 or (~f2).sum() < 100: continue
                    lifts.append(g.loc[~f2, c].mean() - g[c].mean())
                lift = float(np.mean(lifts)) if lifts else np.nan
            else:
                lift = d.loc[~fires, c].mean() - d[c].mean()
            blocked, kept = d.loc[fires, c].mean(), d.loc[~fires, c].mean()
            sub = d[applic]
            fa = fires[applic]
            alift = (sub.loc[~fa, c].mean() - sub[c].mean()) if (fa.sum() >= 200 and (~fa).sum() >= 200) else np.nan
            pos = tot = 0
            for i in range(len(periods) - 1):
                w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
                if w.sum() < 2000: continue
                k, a = d.loc[w & ~fires, c].mean(), d.loc[w, c].mean()
                if np.isfinite(k) and np.isfinite(a): tot += 1; pos += (k - a) >= 0
            ok = np.isfinite(lift) and lift >= 0.02 and pos >= 6 and (~fires).mean() >= 0.20
            v = 'EARNS IT' if ok else ('INVERTED' if np.isfinite(lift) and lift < -0.005 else 'noise')
            print(f'  {name:>32}{fires.mean():>7.1%}{blocked:>9.4f}{kept:>9.4f}{lift:>+9.4f}'
                  f'{f"{pos}/{tot}":>7}{alift:>+13.4f}{v:>10}')


sweep('d0.25_{side}_oppR', False, 'PRIMARY — 0.25 ATR pullback, HOLD 59, fee 0.05%')
sweep('d0.25_{side}_oppR', True, 'DAY-OF-WEEK STRATIFIED (mandatory for the earnings arms)')
sweep('d0.25_{side}_oppR_h72', False, 'ROBUSTNESS — HOLD 72 (22 ATR-periods)')
sweep('d0.25_{side}_oppR_fee0', False, 'ROBUSTNESS — fee 0.00%')
sweep('d0.25_{side}_oppR_fee171', False, 'ROBUSTNESS — fee 0.171%')

# ---- the earnings gates' OWN claim: gap risk ----
print('\n\n=== EARNINGS VARIANCE TEST — P(overnight gap >= 2 ATR) inside the hold window ===')
print('The gate says "gap risk 5-20%, stop will not hold". Bar: >=1.5x the far-from-earnings')
print('baseline, in >=6/9 periods. An EV null cannot refute an exogenous-event guard; this can.\n')
known = d.earn_fwd_d < 9999
far = known & (d.earn_fwd_d > 14)
base = (d.loc[far, 'maxGapATR'] >= 2).mean()
print(f'  baseline (>14d from earnings): P(gap>=2 ATR) = {base:.4f}   n={far.sum():,}')
print(f'  {"window":>22}{"n":>10}{"P(gap>=2ATR)":>15}{"ratio":>9}{"per+":>8}{"verdict":>10}')
for name, m in (('0-2d', (d.earn_fwd_d >= 0) & (d.earn_fwd_d <= 2)),
                ('3-7d', (d.earn_fwd_d > 2) & (d.earn_fwd_d <= 7)),
                ('8-14d', (d.earn_fwd_d > 7) & (d.earn_fwd_d <= 14))):
    m = m & known
    r = (d.loc[m, 'maxGapATR'] >= 2).mean()
    pos = tot = 0
    for i in range(len(periods) - 1):
        w = (d.dt >= periods[i]) & (d.dt < periods[i + 1])
        if (w & m).sum() < 200 or (w & far).sum() < 200: continue
        tot += 1
        pos += ((d.loc[w & m, 'maxGapATR'] >= 2).mean() >= 1.5 * (d.loc[w & far, 'maxGapATR'] >= 2).mean())
    ratio = r / base if base > 0 else np.nan
    v = 'REAL' if (ratio >= 1.5 and pos >= 6) else 'NOT SUPPORTED'
    print(f'  {name:>22}{m.sum():>10,}{r:>15.4f}{ratio:>9.2f}x{f"{pos}/{tot}":>8}{v:>10}')
