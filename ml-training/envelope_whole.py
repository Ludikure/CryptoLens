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


"""Is the Conviction Envelope, as a whole, a verified thesis?

Pre-declared in docs/research/envelope-rules.md Part 2 (frozen at 397ac3d).

The envelope is a SIZING function, not a filter, so it is measured as one: each bar gets a size from
its tier and the arms are compared on size-weighted net R.

ARM E IS THE POINT. Any gate that reduces exposure changes returns. The question is whether the
envelope's SPECIFIC choices beat a random gate that trades equally often.
"""
import numpy as np, pandas as pd, lightgbm as lgb

FEE, PURGE = 0.171, 24
SIZE_MAPS = {'assumed': {'HIGH':1.0,'MODERATE':0.66,'LOW':0.33,'FLAT':0.0},
             'steeper': {'HIGH':1.0,'MODERATE':0.50,'LOW':0.25,'FLAT':0.0}}
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)

d = (pd.read_pickle('excursion_dataset.pkl.gz')
       .merge(pd.read_pickle('envelope_payoff_rows.pkl.gz'), on=['symbol','timestamp'])
       .sort_values('timestamp').reset_index(drop=True))
feats = [c for c in d.columns if c.startswith('f_') and c != 'f_timestamp'
         and not c.startswith(('f_fwd','f_trade')) and pd.api.types.is_numeric_dtype(d[c])]
d['fee_r'] = FEE / (d['f_atrPercent'].clip(lower=0.05) * 2.0)
d['y_goodr'] = (d['f_fwdMaxFavR'] >= 1.5).astype(int)
d['dt'] = pd.to_datetime(d.timestamp, unit='s')

d['ml'] = np.nan
uq = np.unique(d.timestamp.values)
for i in range(4):
    a,b = int(len(uq)*(0.35+0.15*i)), int(len(uq)*(0.50+0.15*i))
    if b > len(uq): break
    tr = d[d.timestamp <= uq[a-1]]; msk = (d.timestamp > uq[min(a+PURGE,len(uq)-1)]) & (d.timestamp <= uq[b-1])
    if len(tr) < 20000 or msk.sum() < 1000: continue
    m = lgb.LGBMClassifier(**PARAMS).fit(tr[feats], tr['y_goodr'])
    d.loc[msk,'ml'] = m.predict_proba(d.loc[msk,feats])[:,1]
d = d.dropna(subset=['ml']).reset_index(drop=True)

al = d.f_tfAlignment; age = d.f_barsSinceRegimeChange
stack = d.f_dStackBull.astype(bool) | d.f_dStackBear.astype(bool)
cont = d.f_momentumAlignment.abs() if 'f_momentumAlignment' in d else pd.Series(2, index=d.index)

def tiers(drop_inverted=False, ml_only=False):
    """Faithful reconstruction of the envelope's tier logic → a size per bar."""
    flat = d.ml < 0.50
    if not ml_only:
        if not drop_inverted:
            flat = flat | ((al == 0) & (d.ml < 0.70))                 # biases_MIXED
        flat = flat | ((al.abs() == 2) & stack)                        # chase into extended aligned
    modb = d.ml < 0.60
    if not ml_only: modb = modb | (cont < 2)
    highb = d.ml < 0.70
    if not ml_only:
        highb = highb | (cont < 3)
        if not drop_inverted: highb = highb | (al.abs() < 2)           # alignment_not_full
    t = pd.Series('HIGH', index=d.index)
    t[highb] = 'MODERATE'; t[modb] = 'LOW'; t[flat] = 'FLAT'
    return t

ARMS = {'A no envelope': None,
        'B envelope as built': tiers(),
        'C minus inverted 3': tiers(drop_inverted=True),
        'D ML only': tiers(ml_only=True)}

def sized(tier, smap):
    return pd.Series(1.0, index=d.index) if tier is None else tier.map(smap)

def perf(size, side, mask=None):
    m = pd.Series(True, index=d.index) if mask is None else mask
    r = (d[f'tp2_{side}_R'] - d.fee_r)[m]; w = size[m]
    return (r*w).sum()/w.sum() if w.sum() > 0 else np.nan       # per unit of exposure taken

periods = pd.date_range('2022-01-01','2026-07-01',freq='6MS')
rng = np.random.default_rng(42)

for side in ('SHORT','LONG'):
    print(f'\n{"="*86}\n{side} — TP2 (1.25R), net of fees, size-weighted\n{"="*86}')
    for map_name, smap in SIZE_MAPS.items():
        base_size = sized(None, smap)
        base = perf(base_size, side)
        # E: random gate matched to arm B's exposure
        bsz = sized(ARMS['B envelope as built'], smap)
        target_exposure = bsz.mean()
        print(f'\n  [{map_name} sizing]  arm A baseline {base:+.4f}R   B exposure {target_exposure:.1%}')
        print(f'  {"arm":>22}{"exposure":>10}{"net R":>10}{"vs A":>9}{"periods+":>10}')
        for name, tier in ARMS.items():
            sz = sized(tier, smap); v = perf(sz, side)
            pos=tot=0
            for i in range(len(periods)-1):
                w = (d.dt>=periods[i]) & (d.dt<periods[i+1])
                if w.sum() < 2000: continue
                bb, kk = perf(base_size, side, w), perf(sz, side, w)
                if np.isfinite(bb) and np.isfinite(kk): tot+=1; pos += (kk-bb) >= 0
            print(f'  {name:>22}{sz.mean():>10.1%}{v:>10.4f}{v-base:>+9.4f}{f"{pos}/{tot}":>10}')
        # E and F
        e_vals=[]
        for seed in range(20):
            r2 = np.random.default_rng(seed)
            keep = pd.Series(r2.random(len(d)) < target_exposure, index=d.index).astype(float)
            e_vals.append(perf(keep, side))
        e_mean = float(np.mean(e_vals))
        finv = sized(ARMS['B envelope as built'], smap)
        finv = 1.0 - finv
        f_val = perf(finv, side)
        print(f'  {"E random (matched)":>22}{target_exposure:>10.1%}{e_mean:>10.4f}{e_mean-base:>+9.4f}{"—":>10}')
        print(f'  {"F inverted envelope":>22}{finv.mean():>10.1%}{f_val:>10.4f}{f_val-base:>+9.4f}{"—":>10}')
        bv = perf(bsz, side)
        print(f'    → B vs A {bv-base:+.4f}R   B vs E {bv-e_mean:+.4f}R   '
              f'{"VERIFIED" if (bv-base>=0.02 and bv-e_mean>=0.02) else "NOT VERIFIED"}')
