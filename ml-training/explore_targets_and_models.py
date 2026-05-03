"""
Target × model sweep on existing v12 stock CSVs.

The v12-baseline has plateaued at 67% WF accuracy on goodR (≥1.5 ATR favorable in 24H).
Two consecutive feature-addition experiments (options, insider) failed to break through.
This script explores whether changing the TARGET DEFINITION or MODEL ARCHITECTURE
unlocks lift on the same 111 features and same training data.

Phase 1 — Target definition sweep (one model, many targets)
  - Different ATR thresholds: 0.75, 1.0, 1.5 (baseline), 2.0, 2.5, 3.0
  - Different horizons: 4H direction, 12H direction, 24H direction (alt to fwdMaxFavR magnitude)
  - Different magnitude defs: fwdReturn24H >= X%, |fwdReturn24H| >= X%

Phase 2 — Model architecture sweep (best target from Phase 1, many models)
  - XGBoost depth ∈ {3, 4, 5, 6}, n_trees ∈ {100, 200, 300}
  - LightGBM depth ∈ {3, 4, 5, 6}, n_trees ∈ {100, 200}
  - Logistic regression baseline
  - Naive baselines: predict majority class, predict random

Outputs a comparison table to stdout. Doesn't write any production model files.
"""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd
import xgboost as xgb
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.isotonic import IsotonicRegression

from calibrate_v11_stocks import (
    FEATURES,
    STOCK_SYMBOLS,
    DOWNLOADS,
    load_symbol,
    downsample_daily,
    compute_sample_weights,
)

CAP = 0.85


def walk_forward_with_target(data, make_model_fn, target_col='goodR', n_folds=3, purge=48):
    """Run WF CV with a custom target column. Returns (acc, top_acc, top_n, balance)."""
    n = len(data)
    oof_probs, oof_y = [], []
    target = data[target_col].values
    for i in range(n_folds):
        train_end = int(n * (0.4 + i * 0.15))
        val_start = train_end + purge
        val_end = int(n * (0.55 + i * 0.15)) if i < n_folds - 1 else n
        if val_start >= val_end:
            continue
        train = data.iloc[:train_end]
        val = data.iloc[val_start:val_end]
        X_t = train[FEATURES].fillna(0)
        y_t = target[:train_end]
        X_v = val[FEATURES].fillna(0)
        y_v = target[val_start:val_end]
        w_t = compute_sample_weights(train['timestamp'].values)
        m = make_model_fn()
        # Try fitting; some sklearn models don't accept sample_weight
        try:
            m.fit(X_t, y_t, sample_weight=w_t)
        except TypeError:
            m.fit(X_t, y_t)
        if hasattr(m, 'predict_proba'):
            p = m.predict_proba(X_v)[:, 1]
        else:
            p = m.predict(X_v).astype(float)
        oof_probs.append(p)
        oof_y.append(y_v)
    if not oof_probs:
        return None
    probs = np.concatenate(oof_probs)
    y = np.concatenate(oof_y)
    if len(set(y)) < 2:
        return None  # degenerate target
    acc = ((probs >= 0.5).astype(int) == y).mean()
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(probs, y)
    cal = np.minimum(iso.predict(probs), CAP)
    top_mask = cal >= 0.7
    top_acc = float(y[top_mask].mean()) if top_mask.sum() > 0 else 0.0
    return float(acc), top_acc, int(top_mask.sum()), float(y.mean())


def make_xgb(depth=5, n=100):
    return xgb.XGBClassifier(
        max_depth=depth, n_estimators=n, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric='logloss', random_state=42,
    )


def make_lgb(depth=5, n=100):
    return lgb.LGBMClassifier(
        max_depth=depth, n_estimators=n, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8, min_child_samples=10,
        reg_alpha=0.1, reg_lambda=1.0, random_state=42, verbose=-1,
    )


def make_lr():
    # Wrap in a Pipeline-like class so it scales features
    class ScaledLR:
        def __init__(self):
            self.scaler = StandardScaler()
            self.model = LogisticRegression(max_iter=500, C=1.0)
        def fit(self, X, y, sample_weight=None):
            X_scaled = self.scaler.fit_transform(X)
            if sample_weight is not None:
                self.model.fit(X_scaled, y, sample_weight=sample_weight)
            else:
                self.model.fit(X_scaled, y)
            return self
        def predict_proba(self, X):
            return self.model.predict_proba(self.scaler.transform(X))
    return ScaledLR()


def add_target_columns(df):
    """Build all target candidate columns from existing forward-return columns."""
    # Magnitude / goodR-style at different ATR thresholds
    for thr in [0.75, 1.0, 1.5, 2.0, 2.5, 3.0]:
        df[f'goodR_{thr}atr'] = (df['fwdMaxFavR'] >= thr).astype(int)

    # Direction targets at different horizons
    df['dir_4h'] = (df['fwdReturn4H'] > 0).astype(int)
    df['dir_12h'] = (df['fwdReturn12H'] > 0).astype(int)
    df['dir_24h'] = (df['fwdReturn24H'] > 0).astype(int)

    # Magnitude (% return) at different horizons
    for thr_pct in [0.5, 1.0, 2.0, 3.0]:
        df[f'absMove24h_{thr_pct}pct'] = (df['fwdReturn24H'].abs() >= thr_pct).astype(int)
        df[f'upMove24h_{thr_pct}pct'] = (df['fwdReturn24H'] >= thr_pct).astype(int)
        df[f'downMove24h_{thr_pct}pct'] = (df['fwdReturn24H'] <= -thr_pct).astype(int)
    return df


def main():
    print("=" * 80)
    print("Target Definition × Model Architecture Sweep")
    print("=" * 80)

    print("\nLoading + downsampling stock CSVs...")
    parts = []
    for sym in STOCK_SYMBOLS:
        d = load_symbol(sym, is_crypto=False)
        if d is None:
            continue
        d = downsample_daily(d)
        parts.append(d)
    data = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)

    # Filter to rows with forward returns + max-fav available
    data = data[data['fwdMaxFavR'].notna() & data['fwdReturn24H'].notna() &
                data['fwdReturn4H'].notna() & data['fwdReturn12H'].notna()].copy()
    data = add_target_columns(data)
    print(f"Total rows: {len(data)}")

    # ===== PHASE 1: Target sweep with default XGBoost =====
    print("\n" + "=" * 80)
    print("PHASE 1: Target sweep (XGBoost depth=5 t=100, fixed)")
    print("=" * 80)
    print(f"{'Target':<26} {'Class %':>10} {'WF acc':>10} {'Top bucket':>12} {'Top n':>10}")
    print("-" * 80)

    targets_phase1 = [
        # ATR thresholds
        'goodR_0.75atr', 'goodR_1.0atr', 'goodR_1.5atr', 'goodR_2.0atr',
        'goodR_2.5atr', 'goodR_3.0atr',
        # Direction
        'dir_4h', 'dir_12h', 'dir_24h',
        # Absolute % moves
        'absMove24h_0.5pct', 'absMove24h_1.0pct', 'absMove24h_2.0pct', 'absMove24h_3.0pct',
        # Up/down separated
        'upMove24h_1.0pct', 'upMove24h_2.0pct',
        'downMove24h_1.0pct', 'downMove24h_2.0pct',
    ]
    phase1_results = []
    for tgt in targets_phase1:
        result = walk_forward_with_target(data, lambda: make_xgb(5, 100), target_col=tgt)
        if result is None:
            print(f"{tgt:<26} {'(degenerate or all-zero)':>20}")
            continue
        acc, top, top_n, balance = result
        phase1_results.append((tgt, acc, top, top_n, balance))
        print(f"{tgt:<26} {balance*100:>9.1f}% {acc*100:>9.2f}% {top*100:>10.1f}% {top_n:>10}")

    # ===== PHASE 2: Model architecture sweep on best target =====
    if phase1_results:
        # Pick best by WF accuracy with the constraint that class balance is >= 20% (avoid trivial)
        viable = [(t, a, top, n, b) for (t, a, top, n, b) in phase1_results
                  if 0.20 <= b <= 0.80]
        if viable:
            best = max(viable, key=lambda r: r[1])
            best_target = best[0]
            print(f"\n  → Best Phase 1 target: {best_target} ({best[1]*100:.2f}% WF, {best[4]*100:.1f}% balanced)")
        else:
            best_target = 'goodR_1.5atr'
            print(f"\n  → No viable Phase 1 target by balance criterion, defaulting to {best_target}")

        print("\n" + "=" * 80)
        print(f"PHASE 2: Model architecture sweep on target='{best_target}'")
        print("=" * 80)
        print(f"{'Model':<35} {'WF acc':>10} {'Top bucket':>12} {'Top n':>10}")
        print("-" * 80)

        model_configs = [
            ("XGBoost d3 t100", lambda: make_xgb(3, 100)),
            ("XGBoost d4 t100", lambda: make_xgb(4, 100)),
            ("XGBoost d5 t100 (baseline)", lambda: make_xgb(5, 100)),
            ("XGBoost d6 t100", lambda: make_xgb(6, 100)),
            ("XGBoost d5 t200", lambda: make_xgb(5, 200)),
            ("XGBoost d5 t300", lambda: make_xgb(5, 300)),
            ("XGBoost d6 t200", lambda: make_xgb(6, 200)),
            ("LightGBM d4 t150", lambda: make_lgb(4, 150)),
            ("LightGBM d5 t150", lambda: make_lgb(5, 150)),
            ("LightGBM d6 t200", lambda: make_lgb(6, 200)),
            ("Logistic Regression (scaled)", lambda: make_lr()),
        ]

        phase2_results = []
        for name, fn in model_configs:
            try:
                result = walk_forward_with_target(data, fn, target_col=best_target)
                if result is None:
                    print(f"{name:<35} {'(failed)':>20}")
                    continue
                acc, top, top_n, _ = result
                phase2_results.append((name, acc, top, top_n))
                print(f"{name:<35} {acc*100:>9.2f}% {top*100:>10.1f}% {top_n:>10}")
            except Exception as e:
                print(f"{name:<35} {f'(error: {str(e)[:30]})':>20}")

        # Final summary
        if phase2_results:
            best_model = max(phase2_results, key=lambda r: r[1])
            print(f"\n  → Best Phase 2 config: {best_model[0]}")
            print(f"     WF accuracy: {best_model[1]*100:.2f}%")
            print(f"     Top bucket [0.70+): {best_model[2]*100:.1f}% (n={best_model[3]})")

    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    if phase1_results:
        baseline = next((r for r in phase1_results if r[0] == 'goodR_1.5atr'), None)
        if baseline:
            print(f"v12-baseline target (goodR_1.5atr): {baseline[1]*100:.2f}% WF, {baseline[2]*100:.1f}% top bucket")
        # Show top 5 by WF acc that have reasonable class balance
        viable_sorted = sorted(
            [(t, a, top, n, b) for (t, a, top, n, b) in phase1_results if 0.20 <= b <= 0.80],
            key=lambda r: r[1], reverse=True
        )
        if viable_sorted:
            print("\nTop 5 viable targets by WF accuracy:")
            for t, a, top, n, b in viable_sorted[:5]:
                print(f"  {t:<26} {a*100:>6.2f}% WF, {top*100:>5.1f}% top bucket, balance={b*100:>5.1f}%")


if __name__ == '__main__':
    main()
