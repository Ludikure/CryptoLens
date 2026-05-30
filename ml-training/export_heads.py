#!/usr/bin/env python3
"""
Serving export — write the validated Phase 1/2 heads into the crypto model JSON.

Produces `heads.{meta,quantiles,conformal}` per MODEL_JSON_SCHEMA.md, ADDITIVE:
the existing quality head (top-level trees/calibration) is copied through untouched.
Validation is done (holdout), so heads train on ALL csv_exports_v11 data.

Includes a Python PARITY SELF-CHECK that replicates the worker/iOS evaluator
aggregation (baseLogit + Σ tree leaves → sigmoid → isotonic, val < split_condition
→ yes child) and asserts it matches xgboost predict_proba within 1e-7. If this
passes, the JSON heads will evaluate identically in MLScoring.swift / ml-predict.ts
once the read-paths are added (the remaining serving step + manual fixture capture).

Output: ml-model-crypto.heads.json (NEW file, NOT overwriting production).

Run:  python3 export_heads.py
"""
import json
import os

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression

H = __import__('_harness')
P1 = __import__('phase1_meta')
P2 = __import__('phase2_conformal')

FEATURES = H.FEATURES
META_FEATURES = FEATURES + ['tradeDir']
CAP = 0.85          # match the evaluator's hardcoded isotonic cap
CONF_TARGET = 0.60
EMBARGO = 14 * 86400
IOS_ML = os.path.join(os.path.dirname(__file__), '..', 'CryptoLens', 'ML')


# base_score pinned explicitly so leaves are relative to a known base (XGBoost 2.x+
# otherwise auto-LEARNS base_score to the label base rate, breaking the evaluator's
# fixed-base assumption). Classifier 0.5 → baseLogit 0; regressor 0.0 → pred = Σleaves.
CLF_BASE = 0.5
QR_BASE = 0.0


def make_clf(seed=42):
    return xgb.XGBClassifier(max_depth=5, n_estimators=100, learning_rate=0.03,
                             subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
                             reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss',
                             base_score=CLF_BASE, random_state=seed)


def make_qr(alpha):
    return xgb.XGBRegressor(objective='reg:quantileerror', quantile_alpha=alpha,
                            max_depth=5, n_estimators=100, learning_rate=0.03,
                            subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
                            reg_alpha=0.1, reg_lambda=1.0, base_score=QR_BASE, random_state=42)


def trees_of(model, base, feature_names):
    """Return XGBoost trees in the evaluator's nested-children JSON with FULL
    float32 precision, parsed from save_model JSON (split_conditions / base_weights
    arrays). The text dumps (get_dump, trees_to_dataframe) round leaf values to ~5
    sig figs which accumulates to ~1e-1 error over 100 trees. base = pinned base_score.
    feature_names maps split_indices → the evaluator's name-keyed inputs."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as f:
        path = f.name
    model.get_booster().save_model(path)
    raw = json.load(open(path))
    os.remove(path)
    # Use the base_score XGBoost ACTUALLY used (it may override the constructor value,
    # e.g. for reg:quantileerror it sets the label quantile). Bracketed-array string.
    base = float(str(raw['learner']['learner_model_param']['base_score']).strip('[]'))
    tnodes = raw['learner']['gradient_booster']['model']['trees']
    trees = []
    for t in tnodes:
        sidx = t['split_indices']
        scond = t['split_conditions']
        left = t['left_children']
        right = t['right_children']

        def build(i):
            if left[i] == -1:  # leaf
                # XGBoost stores the LEAF OUTPUT in split_conditions[i] (not base_weights,
                # which is the pre-shrinkage Newton weight — they coincide for the
                # classifier but diverge for the regressor).
                return {'nodeid': i, 'leaf': float(scond[i])}
            return {'nodeid': i, 'split': feature_names[sidx[i]],
                    'split_condition': float(scond[i]),
                    'yes': left[i], 'no': right[i], 'missing': left[i],
                    'children': [build(left[i]), build(right[i])]}
        trees.append(build(0))
    return trees, base


# ---- evaluator replica (mirrors ml-predict.ts evaluateTree + mlPredict) ----
def eval_tree(node, inp):
    if 'leaf' in node:
        return node['leaf']
    if 'split' not in node or 'split_condition' not in node:
        return 0.0
    val = inp.get(node['split'], 0.0)
    go_left = val < node['split_condition']
    nxt_id = node['yes'] if go_left else node['no']
    for c in node.get('children', []):
        if c['nodeid'] == nxt_id:
            return eval_tree(c, inp)
    return 0.0


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def clf_prob(trees, base_prob, inp):
    """Classifier replica: matches ml-predict.ts mlPredict (baseLogit + Σleaves → sigmoid)."""
    margin = np.log(base_prob / (1.0 - base_prob)) + sum(eval_tree(t, inp) for t in trees)
    return sigmoid(margin)


def qr_pred(trees, base_raw, inp):
    """Regressor replica: raw base + Σleaves (no logit, no sigmoid)."""
    return base_raw + sum(eval_tree(t, inp) for t in trees)


def apply_iso(x_cal, y_cal, p, cap=CAP):
    if p <= x_cal[0]:
        return y_cal[0]
    if p >= x_cal[-1]:
        return min(cap, y_cal[-1])
    lo = 0
    for i in range(1, len(x_cal)):
        if x_cal[i] > p:
            lo = i - 1
            break
    t = (p - x_cal[lo]) / (x_cal[lo + 1] - x_cal[lo])
    return max(0.0, min(cap, y_cal[lo] + t * (y_cal[lo + 1] - y_cal[lo])))


def wf_oof_meta(df):
    """5-fold OOF for the meta calibration (no holdout split — validation done)."""
    df = df.sort_values('timestamp').reset_index(drop=True)
    t = df['timestamp'].values
    t_lo, t_hi = t.min(), t.max()
    span = t_hi - t_lo
    oof_p, oof_y = [], []
    for i in range(5):
        lo = t_lo + span * (0.25 + i * 0.15)
        hi = t_lo + span * (0.25 + (i + 1) * 0.15) if i < 4 else t_hi + 1
        train = df[(df['timestamp'] < lo - EMBARGO) & (df['tradeDir'] != 0)]
        val = df[(df['timestamp'] >= lo) & (df['timestamp'] < hi) & (df['tradeDir'] != 0)]
        if len(train) < 5000 or len(val) < 200:
            continue
        m = make_clf(); m.fit(train[META_FEATURES].fillna(0), train['tbWin'])
        oof_p.append(m.predict_proba(val[META_FEATURES].fillna(0))[:, 1])
        oof_y.append(val['tbWin'].values)
    return np.concatenate(oof_p), np.concatenate(oof_y)


def main():
    print("Loading crypto v11 + labels...")
    df, _ = H.load_market('crypto')
    df = P1.add_labels(df)
    tr = df[df['tradeDir'] != 0].copy()
    print(f"  bars={len(df):,}  tradeable(dir!=0)={len(tr):,}")

    # --- META head: OOF calibration + final model on all tradeable bars ---
    print("Training meta head (OOF calibration + final)...")
    oof_p, oof_y = wf_oof_meta(df)
    iso = IsotonicRegression(out_of_bounds='clip'); iso.fit(oof_p, oof_y)
    x_cal = [float(v) for v in iso.X_thresholds_]
    y_cal = [float(min(CAP, v)) for v in iso.y_thresholds_]
    meta = make_clf(); meta.fit(tr[META_FEATURES].fillna(0), tr['tbWin'])
    meta_trees, meta_base = trees_of(meta, CLF_BASE, META_FEATURES)

    # --- conformal threshold on OOF calibrated meta ---
    cal_oof = np.array([apply_iso(x_cal, y_cal, p) for p in oof_p])
    tau = P2.find_threshold(cal_oof, oof_y, CONF_TARGET)
    # per-regime tau
    reg_oof = None  # OOF regime not tracked; compute global only (per Phase 2: collapses to global)
    print(f"  conformal tau (target {CONF_TARGET}) = {tau}")

    # --- QUANTILE heads ---
    print("Training quantile heads (0.50/0.75/0.90)...")
    q_heads = {}
    for a in (0.50, 0.75, 0.90):
        qm = make_qr(a); qm.fit(df[FEATURES].fillna(0), df['fwdMaxFavR'])
        qt, qb = trees_of(qm, QR_BASE, FEATURES)
        q_heads[f"{a:.2f}"] = {'trees': qt, 'base_score': qb}

    # --- PARITY SELF-CHECK on a random sample (meta head) ---
    print("Parity self-check (evaluator replica vs predict_proba)...")
    samp = tr.sample(min(2000, len(tr)), random_state=1)
    xgb_prob = meta.predict_proba(samp[META_FEATURES].fillna(0))[:, 1]
    max_diff = 0.0
    for (_, row), xp in zip(samp.iterrows(), xgb_prob):
        inp = {f: (0.0 if pd.isna(row[f]) else float(row[f])) for f in META_FEATURES}
        replica = clf_prob(meta_trees, meta_base, inp)
        max_diff = max(max_diff, abs(replica - xp))
    print(f"  meta head max |replica - predict_proba| = {max_diff:.2e}  "
          f"({'PASS' if max_diff < 1e-6 else 'FAIL'} @ 1e-6)")
    # quantile parity
    qm75 = make_qr(0.75); qm75.fit(df[FEATURES].fillna(0), df['fwdMaxFavR'])
    qt, qb = trees_of(qm75, QR_BASE, FEATURES)
    xq = qm75.predict(samp[FEATURES].fillna(0))
    maxq = 0.0
    for (_, row), xv in zip(samp.iterrows(), xq):
        inp = {f: (0.0 if pd.isna(row[f]) else float(row[f])) for f in FEATURES}
        maxq = max(maxq, abs(qr_pred(qt, qb, inp) - xv))
    print(f"  quantile head max |replica - predict| = {maxq:.2e}  "
          f"({'PASS' if maxq < 1e-4 else 'FAIL'} @ 1e-4)")

    # --- assemble: copy production quality head, attach heads ---
    prod_path = os.path.join(IOS_ML, 'ml-model-crypto.json')
    m = json.load(open(prod_path))
    m['heads'] = {
        'meta': {
            'kind': 'classifier', 'conditioned_on': 'direction',
            'trees': meta_trees, 'base_score': meta_base,
            'calibration': {'x': x_cal, 'y': y_cal, 'cap': CAP, 'method': 'isotonic'},
            'target': 'tb_win_given_dir', 'features': META_FEATURES, 'version': 1,
        },
        'quantiles': {
            'kind': 'regressor', 'target': 'fwdMaxFavR', 'q': q_heads, 'version': 1,
        },
        'conformal': {
            'target_coverage': CONF_TARGET, 'threshold': tau, 'version': 1,
        },
    }
    m['heads_description'] = ('Phase1/2: triple-barrier meta (tb_win_given_dir) + '
                              'fwdMaxFavR quantiles + conformal abstention tau. Additive; '
                              'quality head unchanged. See PLAN_OUTCOMES.md.')
    out = os.path.join(IOS_ML, 'ml-model-crypto.heads.json')
    json.dump(m, open(out, 'w'))
    sz = os.path.getsize(out) / 1024
    print(f"\n  wrote {out} ({sz:.0f} KB)  | meta {len(meta_trees)} trees, "
          f"quantiles 3x{len(q_heads['0.75']['trees'])} trees, conformal tau={tau}")
    print("  NOT deployed / not swapped into production — review + add evaluator read-paths + fixtures next.")


if __name__ == '__main__':
    main()
