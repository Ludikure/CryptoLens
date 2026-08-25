#!/usr/bin/env python3
"""Part 11: should the ML gate be an ABSOLUTE threshold or a fixed COVERAGE?

Pre-declared in docs/research/envelope-rules.md (frozen at 25f5bc2).

Decided by walk-forward generalization, not by argument: fit the parameter on earlier periods ONLY,
apply it to the held-out period, compare realized R per opportunity. Coverage re-derives its
threshold from the TEST period's own ML distribution, which is what makes it self-adjusting.

Geometry is the app's (Part 10): 0.25 ATR pullback entry, unfilled = 0, stop 1.25 ATR primary.
"""
import glob, os
import numpy as np, pandas as pd, lightgbm as lgb

WAIT_H, HOLD_H, TP2_ATR, DEPTH, FEE = 12, 72, 2.5, 0.25, 0.171
STOPS = [1.25, 2.0]
PURGE = 24
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)
FEAT, PATH = 'csv_exports_v14', 'vision_backfill/klines_long'


def sim(sym):
    fp, pp = f'{FEAT}/{sym}.csv', f'{PATH}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)): return None
    f = pd.read_csv(fp, low_memory=False)
    tr = f['timestamp'].to_numpy(np.int64)
    f['ts'] = (tr // 1000) if tr[0] > 1e12 else tr
    p = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)
    pts = p['ts'].to_numpy(np.int64)
    hi, lo, cl = (p[c].to_numpy(np.float64) for c in ('high', 'low', 'close'))
    span = WAIT_H + HOLD_H
    idx = np.searchsorted(pts, f['ts'].to_numpy(np.int64), side='left')
    ok = (idx < len(pts) - span) & (idx >= 0) & (pts[np.clip(idx, 0, len(pts) - 1)] == f['ts'].to_numpy(np.int64))
    e0 = f['price'].to_numpy(np.float64); atrp = f['atrPercent'].to_numpy(np.float64)
    a = (atrp / 100.0) * e0
    ok &= np.isfinite(a) & (a > 0) & np.isfinite(e0) & (e0 > 0) & np.isfinite(f['fwdMaxFavR'].to_numpy())
    if ok.sum() == 0: return None
    r_ = np.where(ok)[0]; base = idx[r_]; e_, atr = e0[r_], a[r_]
    NEVER = span + 10
    first = lambda m: np.where(m.any(1), m.argmax(1), NEVER)
    out = {'symbol': sym, 'timestamp': f['ts'].to_numpy()[r_],
           'y_goodr': (f['fwdMaxFavR'].to_numpy()[r_] >= 1.5).astype(int)}
    feats = [c for c in f.columns if c not in ('timestamp', 'ts', 'symbol')
             and not c.startswith(('fwd', 'trade')) and pd.api.types.is_numeric_dtype(f[c])]
    for c in feats: out['f_' + c] = f[c].to_numpy()[r_]

    for stop_atr in STOPS:
        risk = stop_atr * atr
        R = TP2_ATR / stop_atr
        fee_r = FEE / np.clip(atrp[r_] * stop_atr, 0.05, None)
        for side in ('LONG', 'SHORT'):
            sg = 1.0 if side == 'LONG' else -1.0
            entry = e_ - sg * DEPTH * atr
            w = np.arange(1, WAIT_H + 1)
            wl, wh = lo[base[:, None] + w], hi[base[:, None] + w]
            ti = first(wl <= entry[:, None]) if side == 'LONG' else first(wh >= entry[:, None])
            filled = ti < NEVER; fill_i = np.where(filled, ti + 1, 0)
            stop = entry - sg * risk
            tp2 = entry + sg * TP2_ATR * atr
            gi = np.clip(base[:, None] + fill_i[:, None] + np.arange(1, HOLD_H + 1), 0, len(hi) - 1)
            gh, gl = hi[gi], lo[gi]
            si = first(gl <= stop[:, None]) if side == 'LONG' else first(gh >= stop[:, None])
            qi = first(gh >= tp2[:, None]) if side == 'LONG' else first(gl <= tp2[:, None])
            exit_px = cl[np.clip(base + fill_i + HOLD_H, 0, len(cl) - 1)]
            to_r = sg * (exit_px - entry) / risk
            won = qi < si; lost = (si < NEVER) & ~won
            r = np.where(won, R, np.where(lost, -1.0, np.clip(to_r, -1.0, R)))
            out[f's{stop_atr}_{side}'] = np.where(filled, r - fee_r, 0.0)
    return pd.DataFrame(out)


syms = sorted({os.path.basename(x)[:-4] for x in glob.glob(f'{FEAT}/*.csv')} &
              {os.path.basename(x)[:-4] for x in glob.glob(f'{PATH}/*.csv')})
d = pd.concat([x for s in syms if (x := sim(s)) is not None], ignore_index=True)
d = d.sort_values('timestamp').reset_index(drop=True)
d['dt'] = pd.to_datetime(d.timestamp, unit='s')

# ---- walk-forward out-of-fold ML (same recipe as envelope_test.py) ----
fcols = [c for c in d.columns if c.startswith('f_') and pd.api.types.is_numeric_dtype(d[c])]
d['ml'] = np.nan
uniq = np.unique(d.timestamp.values)
for i in range(6):
    tr_end = int(len(uniq) * (0.30 + 0.10 * i)); te_end = int(len(uniq) * (0.40 + 0.10 * i))
    if te_end > len(uniq): break
    tr_t, pg_t, te_t = uniq[tr_end - 1], uniq[min(tr_end + PURGE, len(uniq) - 1)], uniq[te_end - 1]
    trn = d[d.timestamp <= tr_t]; msk = (d.timestamp > pg_t) & (d.timestamp <= te_t)
    if len(trn) < 20000 or msk.sum() < 1000: continue
    m = lgb.LGBMClassifier(**PARAMS).fit(trn[fcols], trn['y_goodr'])
    d.loc[msk, 'ml'] = m.predict_proba(d.loc[msk, fcols])[:, 1]
d = d.dropna(subset=['ml']).reset_index(drop=True)

periods = pd.date_range('2022-01-01', '2026-07-01', freq='6MS')
pid = np.full(len(d), -1)
for i in range(len(periods) - 1):
    pid[((d.dt >= periods[i]) & (d.dt < periods[i + 1])).to_numpy()] = i
d['pid'] = pid
d = d[d.pid >= 0].reset_index(drop=True)
valid = [i for i in sorted(d.pid.unique()) if (d.pid == i).sum() >= 2000]
print(f'{len(d):,} opportunities, {d.symbol.nunique()} symbols, {len(valid)} usable periods')
print(f'ML base rate {d.y_goodr.mean():.1%}; ML p10/50/90 = '
      f'{d.ml.quantile(.1):.3f}/{d.ml.median():.3f}/{d.ml.quantile(.9):.3f}\n')

THRESH = np.round(np.arange(0.30, 0.86, 0.01), 2)
COV = np.round(np.arange(0.05, 1.001, 0.05), 2)


def run(col):
    rows = []
    for k, ti in enumerate(valid):
        if k < 3: continue                      # need >=3 training periods
        trn = d[d.pid.isin(valid[:k])]; tst = d[d.pid == ti]
        if len(trn) < 5000 or len(tst) < 2000: continue
        # Arm A — absolute threshold fitted on training periods only
        best_t = max(THRESH, key=lambda t: trn.loc[trn.ml >= t, col].mean()
                     if (trn.ml >= t).sum() >= 500 else -9)
        a_r = tst.loc[tst.ml >= best_t, col].mean() if (tst.ml >= best_t).sum() >= 100 else np.nan
        a_cov = (tst.ml >= best_t).mean()
        # Arm B — coverage fitted on training, threshold re-derived from the TEST distribution
        def cov_r(df, q, ref):
            cut = ref.ml.quantile(1 - q)
            m = df.ml >= cut
            return df.loc[m, col].mean() if m.sum() >= 100 else np.nan
        best_q = max(COV, key=lambda q: (cov_r(trn, q, trn) if np.isfinite(cov_r(trn, q, trn)) else -9))
        b_r = cov_r(tst, best_q, tst)
        rows.append(dict(period=str(periods[ti].date()), n=len(tst),
                         t=best_t, abs_r=a_r, abs_cov=a_cov,
                         q=best_q, cov_r=b_r,
                         nogate=tst[col].mean()))
    return pd.DataFrame(rows)


for stop in STOPS:
    for side in ('SHORT', 'LONG'):
        col = f's{stop}_{side}'
        r = run(col)
        if r.empty: continue
        tag = '  (the app)' if stop == 1.25 else ''
        print('=' * 96)
        print(f'stop {stop} ATR{tag} — {side}')
        print('=' * 96)
        print(f'{"held-out":>12}{"n":>8}{"| abs t":>9}{"cov":>7}{"oppR":>9}'
              f'{"| best q":>10}{"oppR":>9}{"| no gate":>11}{"winner":>10}')
        for _, x in r.iterrows():
            w = 'coverage' if (np.isfinite(x.cov_r) and np.isfinite(x.abs_r) and x.cov_r > x.abs_r) else 'absolute'
            print(f'{x.period:>12}{x.n:>8,}{x.t:>9.2f}{x.abs_cov:>7.1%}{x.abs_r:>9.4f}'
                  f'{x.q:>10.2f}{x.cov_r:>9.4f}{x.nogate:>11.4f}{w:>10}')
        A, B, N = r.abs_r.mean(), r.cov_r.mean(), r.nogate.mean()
        print(f'\n  MEAN out-of-sample:  absolute {A:+.4f}   coverage {B:+.4f}   no gate {N:+.4f}')
        print(f'  periods beating no-gate:  absolute {(r.abs_r > r.nogate).sum()}/{len(r)}'
              f'   coverage {(r.cov_r > r.nogate).sum()}/{len(r)}')
        print(f'  per-period optimum spread:  threshold {r.t.min():.2f}-{r.t.max():.2f}'
              f'   coverage {r.q.min():.2f}-{r.q.max():.2f}')
        gap = B - A
        verdict = 'COVERAGE' if gap >= 0.01 else ('ABSOLUTE' if gap <= -0.01 else 'TIE -> keep ABSOLUTE')
        print(f'  gap (coverage - absolute) = {gap:+.4f}  ->  {verdict}\n')

d.to_pickle('ml_gate_rows.pkl.gz')

# ---- Control 2, declared above but not implemented in the first pass: FIXED gates, no fitting. ----
# The walk-forward arms select argmax on training data, which at these sample sizes chases thin
# slices (it picked thresholds admitting 0.2-4.5% of bars, one of them returning -0.53R). That is a
# property of the SELECTION, not of gating, so it cannot answer "does any sensible ML gate help?".
# A fixed, never-fitted threshold can.
print('\n' + '=' * 96)
print('CONTROL 2 — FIXED thresholds, never fitted, applied to every period')
print('=' * 96)
for stop in STOPS:
    for side in ('SHORT', 'LONG'):
        col = f's{stop}_{side}'
        base = [d.loc[d.pid == i, col].mean() for i in valid]
        print(f'\n  stop {stop} ATR — {side}   (no gate: mean {np.mean(base):+.4f})')
        print(f'  {"gate":>14}{"coverage":>10}{"mean oppR":>12}{"vs no-gate":>12}{"periods+":>10}')
        for t in (0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70):
            rs, pos, tot = [], 0, 0
            for i in valid:
                w = d.pid == i
                m = w & (d.ml >= t)
                if m.sum() < 200: continue
                r = d.loc[m, col].mean(); b = d.loc[w, col].mean()
                rs.append(r); tot += 1; pos += r > b
            if not rs: continue
            print(f'  {"ML >= " + f"{t:.2f}":>14}{(d.ml >= t).mean():>10.1%}{np.mean(rs):>12.4f}'
                  f'{np.mean(rs) - np.mean(base):>+12.4f}{f"{pos}/{tot}":>10}')
