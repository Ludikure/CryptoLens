#!/usr/bin/env python3
"""Walk-forward OOF ML predictions, with declared provenance. (Phase 2 input.)

The envelope's ML thresholds cannot be tested without a per-bar ML value, and the exported envelope
carries none — `exportEnvelope.ts` deliberately leaves ML absent so the injection is explicit. The
plan authorises exactly one injection: "ML_WIN is the one legitimate injection (walk-forward OOF from
Python)."

WHY NOT `oof_24h.csv`, WHICH ALREADY EXISTS ON DISK. Its producer is `h1_horizon_test.py:walk()`,
found by search rather than by any record, and it targets a DIFFERENT label: a forward max over
feature-row CLOSES via `price[::-1].rolling(n).max()[::-1].shift(-1)`, which never sees an intrabar
high and starts a bar later than the production target. Its feature set is "everything numeric not in
DROP", which is not the shipped 110. Using a file whose semantics differ from production to
re-decide a production threshold is the exact error this programme exists to stop, so it is not used.

WHAT THIS DOES INSTEAD
  target   `goodR = fwdMaxFavR >= 1.5`, read straight from the v14 column — the production target.
  features the shipped 110, read from `ml-model-crypto.json` rather than re-listed here, so the two
           cannot drift apart.
  folds    `calibrate_v14.folds()` verbatim: 3 expanding windows, 48-bar purge.
  output   raw model probability per (symbol, timestamp), plus a provenance JSON.

The predictions are RAW, not calibrated. The envelope gates on a calibrated value in production, but
the live PAV layer refits from forward data that does not exist for a historical bar. Applying a
calibration fit on the same rows would be circular. So thresholds are swept on the raw scale and the
mapping question is left to C6, which is where Part 11 put it.

CAVEAT, stated rather than buried: the features come from `csv_exports_v14`, which carries the
cross-asset leak fixed in Phase 4.1. Measured handle on the forward label was |corr| <= 0.016, so the
effect on these predictions is small — but it is not zero, and a clean regen would be better.
"""
import glob, json, os, subprocess, time
import numpy as np, pandas as pd
import lightgbm as lgb

FEAT_DIR = 'csv_exports_v14'
MODEL = '../marketscope-worker/src/ml-model-crypto.json'
OUT, PROV = 'phase2_oof_crypto.csv', 'phase2_oof_crypto.provenance.json'
PURGE, N_FOLDS = 48, 3


def folds(n, n_folds=N_FOLDS, purge=PURGE):
    """Verbatim from calibrate_v14.py — the production walk-forward convention."""
    for i in range(n_folds):
        train_end = int(n * (0.4 + i * 0.15))
        val_start = train_end + purge
        val_end = int(n * (0.55 + i * 0.15)) if i < n_folds - 1 else n
        if val_start < val_end:
            yield i, train_end, val_start, val_end


def weights(ts):
    """Time-decay sample weighting, as production uses: last year 3x, prior year 2x."""
    now = ts.max()
    w = np.ones(len(ts))
    w[ts >= now - 730 * 86400] = 2.0
    w[ts >= now - 365 * 86400] = 3.0
    return w


def main():
    feats = json.load(open(MODEL))['features']
    files = sorted(glob.glob(f'{FEAT_DIR}/*.csv'))
    frames = []
    for f in files:
        d = pd.read_csv(f, low_memory=False)
        d['symbol'] = os.path.basename(f)[:-4]
        frames.append(d)
    a = pd.concat(frames, ignore_index=True)
    a = a.dropna(subset=['fwdMaxFavR']).sort_values('timestamp').reset_index(drop=True)
    a['goodR'] = (a.fwdMaxFavR >= 1.5).astype(int)
    missing = [c for c in feats if c not in a.columns]
    assert not missing, f'{len(missing)} model features absent from the CSVs: {missing[:8]}'

    X = a[feats].fillna(0)
    y = a['goodR'].to_numpy()
    w = weights(a['timestamp'].to_numpy())
    oof = np.full(len(a), np.nan)
    aucs = []
    t0 = time.time()
    for i, te, vs, ve in folds(len(a)):
        m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.03,
                               num_leaves=15, verbose=-1, n_jobs=-1)
        m.fit(X.iloc[:te], y[:te], sample_weight=w[:te])
        p = m.predict_proba(X.iloc[vs:ve])[:, 1]
        oof[vs:ve] = p
        from sklearn.metrics import roc_auc_score
        auc = roc_auc_score(y[vs:ve], p)
        aucs.append(auc)
        print(f'  fold {i}: train {te:,}  val {ve - vs:,}  AUC {auc:.4f}', flush=True)

    keep = np.isfinite(oof)
    out = a.loc[keep, ['symbol', 'timestamp', 'price', 'atrPercent']].copy()
    out['p'] = oof[keep]
    out['goodR'] = y[keep]
    out.to_csv(OUT, index=False)

    try:
        sha = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], text=True).strip()
    except Exception:
        sha = None
    json.dump({'script': 'phase2_oof.py', 'git_sha': sha, 'feat_dir': FEAT_DIR,
               'model_feature_source': MODEL, 'n_features': len(feats),
               'target': 'goodR = fwdMaxFavR >= 1.5', 'folds': N_FOLDS, 'purge': PURGE,
               'rows_total': int(len(a)), 'rows_oof': int(keep.sum()),
               'symbols': int(a.symbol.nunique()), 'fold_aucs': [round(x, 4) for x in aucs],
               'mean_auc': round(float(np.mean(aucs)), 4), 'calibrated': False,
               'known_caveat': 'features carry the Phase 4.1 cross-asset leak (|corr| <= 0.016)',
               'seconds': round(time.time() - t0, 1)},
              open(PROV, 'w'), indent=2)
    print(f'\nwrote {OUT}: {keep.sum():,} OOF rows, mean AUC {np.mean(aucs):.4f}')
    print(f'provenance -> {PROV}')


if __name__ == '__main__':
    main()
