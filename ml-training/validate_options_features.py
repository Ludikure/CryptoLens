"""
Phase 3 Validation Gate: Does adding the 5 options features actually improve goodR prediction?

Reads existing v11 stock CSVs, merges in options features from options_history.json,
runs the same XGBoost walk-forward CV as calibrate_v11_stocks.py, and reports the
delta vs the v11 baseline (66.8% WF accuracy).

DECISION RULE:
  - WF accuracy improvement >= 0.3pp AND no top-bucket regression → proceed to Phase 4
  - Otherwise → stop, abort options work, cancel MarketData trial

This script does NOT write any model JSON files. It's read-only on production assets.
For full v12 production training, use calibrate_v12_stocks.py (Phase 6).

Usage:
    python3 ml-training/validate_options_features.py
"""

import json
import os
import sys

import numpy as np
import pandas as pd

# Reuse v11 infrastructure
sys.path.insert(0, os.path.dirname(__file__))
from calibrate_v11_stocks import (
    FEATURES as V11_FEATURES,
    STOCK_SYMBOLS,
    DOWNLOADS,
    walk_forward_oof,
    fit_calibration,
    diagnose,
    make_stock_model,
)


OPTIONS_PATH = '/Users/bojanmihovilovic/CryptoLens/ml-training/options_history.json'

# 5 new features in canonical order (must match Swift struct + CSV header for v12).
OPTIONS_FEATURES = ['ivRank', 'atmIv', 'ivSkew25d', 'ivTermSlope', 'pcOiRatio']

# Defaults for symbols/dates not in options_history.json (matches OptionsData.swift logic).
OPTIONS_DEFAULTS = {
    'ivRank': 0.5,
    'atmIv': 0.0,
    'ivSkew25d': 0.0,
    'ivTermSlope': 0.0,
    'pcOiRatio': 1.0,
}


def load_options_lookup() -> dict[tuple[str, str], dict[str, float]]:
    """Read options_history.json into a flat (symbol, date) → features dict."""
    if not os.path.isfile(OPTIONS_PATH):
        print(f"ERROR: {OPTIONS_PATH} not found. Run options_backfill.py first.")
        sys.exit(1)
    with open(OPTIONS_PATH) as f:
        data = json.load(f)
    out = {}
    for sym, records in data.items():
        for rec in records:
            out[(sym, rec['date'])] = {k: rec.get(k, OPTIONS_DEFAULTS[k]) for k in OPTIONS_FEATURES}
    return out


def load_symbol_with_options(symbol: str, opt_lookup: dict) -> pd.DataFrame | None:
    """Same as v11 load_symbol but augments with 5 options columns."""
    path = f'{DOWNLOADS}/{symbol}.csv'
    if not os.path.isfile(path):
        return None
    df = pd.read_csv(path)
    if 'symbol' not in df.columns:
        df['symbol'] = symbol
    if 'fwdMaxFavR' not in df.columns:
        return None
    valid = df[df['fwdMaxFavR'].notna() & df['fwdReturn24H'].notna()].copy()
    valid['goodR'] = (valid['fwdMaxFavR'] >= 1.5).astype(int)

    # Fill v11 features that may be missing (matches load_symbol defaults)
    for feat in V11_FEATURES:
        if feat not in valid.columns:
            if feat == 'takerRatioRaw':
                valid[feat] = 1.0
            elif feat == 'longPctRaw':
                valid[feat] = 50.0
            else:
                valid[feat] = 0.0

    # Add 5 options features via lookup
    valid['date_str'] = pd.to_datetime(valid['timestamp'], unit='s').dt.strftime('%Y-%m-%d')
    for feat in OPTIONS_FEATURES:
        valid[feat] = valid.apply(
            lambda row: opt_lookup.get((symbol, row['date_str']), OPTIONS_DEFAULTS).get(feat, OPTIONS_DEFAULTS[feat]),
            axis=1,
        )
    valid.drop(columns=['date_str'], inplace=True)
    return valid


def _wf_accuracy(data, features_list):
    """Run walk-forward CV with the given feature list. Returns (acc, top_bucket_acc, n_top)."""
    import calibrate_v11_stocks as v11
    v11.FEATURES = features_list
    probs, y, _ = walk_forward_oof(data, make_stock_model)
    acc = ((probs >= 0.5).astype(int) == y).mean()
    # Top bucket reliability (calibrated >= 0.7)
    from sklearn.isotonic import IsotonicRegression
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(probs, y)
    cal = np.minimum(iso.predict(probs), 0.85)
    top_mask = cal >= 0.7
    top_acc = float(y[top_mask].mean()) if top_mask.sum() > 0 else 0.0
    return acc, top_acc, int(top_mask.sum())


def main():
    print("=" * 60)
    print("Phase 3: Options Features Validation Gate (3-way comparison)")
    print("=" * 60)

    print("\nLoading options history...")
    opt_lookup = load_options_lookup()
    unique_symbols = len(set(k[0] for k in opt_lookup.keys()))
    print(f"  options_history.json: {len(opt_lookup)} (symbol, date) records across {unique_symbols} symbols")

    print("\nLoading + augmenting stock CSVs...")
    parts = []
    matched = 0
    total = 0
    for sym in STOCK_SYMBOLS:
        d = load_symbol_with_options(sym, opt_lookup)
        if d is None:
            print(f"  {sym}: MISSING CSV, skip")
            continue
        d['date'] = pd.to_datetime(d['timestamp'], unit='s').dt.date
        d = d.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)
        sym_matched = sum(1 for _, r in d.iterrows() if (sym, str(r['date'])) in opt_lookup)
        matched += sym_matched
        total += len(d)
        parts.append(d)
        print(f"  {sym}: {len(d)} bars, {sym_matched}/{len(d)} ({100*sym_matched/len(d):.0f}%) have options data")

    data = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    print(f"\nTotal: {len(data)} bars, options match rate: {100*matched/total:.1f}%")
    print(f"goodR rate: {data['goodR'].mean()*100:.1f}%")

    # Build augmented FEATURES list (insert 5 options features after shortVolumeZScore)
    new_features = list(V11_FEATURES)
    insert_idx = new_features.index('shortVolumeZScore') + 1
    for i, f in enumerate(OPTIONS_FEATURES):
        new_features.insert(insert_idx + i, f)
    assert len(new_features) == 116, f"expected 116, got {len(new_features)}"

    # ===== Run A: v12-baseline (fresh data, 111 features, NO options) =====
    print("\n" + "─" * 60)
    print("Run A: v12-baseline — fresh data, 111 features (no options)")
    print("─" * 60)
    base_acc, base_top, base_top_n = _wf_accuracy(data, list(V11_FEATURES))
    print(f"  WF accuracy: {base_acc*100:.2f}%, top bucket [0.70+): {base_top*100:.1f}% (n={base_top_n})")

    # ===== Run B: v12-options (fresh data, 116 features, WITH options) =====
    print("\n" + "─" * 60)
    print("Run B: v12-options — fresh data, 116 features (with options)")
    print("─" * 60)
    opt_acc, opt_top, opt_top_n = _wf_accuracy(data, new_features)
    print(f"  WF accuracy: {opt_acc*100:.2f}%, top bucket [0.70+): {opt_top*100:.1f}% (n={opt_top_n})")

    # ===== 3-way comparison =====
    V11_BASELINE_ACC = 0.668  # stale-data v11 reference
    V11_BASELINE_TOP = 0.750
    print("\n" + "=" * 60)
    print("3-WAY COMPARISON")
    print("=" * 60)
    print(f"  v11 stale baseline   : {V11_BASELINE_ACC*100:.2f}% WF, {V11_BASELINE_TOP*100:.1f}% top bucket")
    print(f"  v12-baseline (fresh) : {base_acc*100:.2f}% WF, {base_top*100:.1f}% top bucket")
    print(f"  v12-options (fresh)  : {opt_acc*100:.2f}% WF, {opt_top*100:.1f}% top bucket")
    print()
    print(f"  Δ from data freshness (v12-baseline vs v11)  : {(base_acc - V11_BASELINE_ACC)*100:+.2f}pp WF")
    print(f"  Δ from options       (v12-options vs baseline): {(opt_acc - base_acc)*100:+.2f}pp WF, {(opt_top - base_top)*100:+.2f}pp top bucket")
    print(f"  Δ total              (v12-options vs v11)    : {(opt_acc - V11_BASELINE_ACC)*100:+.2f}pp WF")

    # Decision rule: options gate is options vs v12-baseline (apples-to-apples)
    options_delta = (opt_acc - base_acc) * 100
    print()
    print("=" * 60)
    print("DECISION (options gate)")
    print("=" * 60)
    if options_delta >= 0.3 and opt_top >= base_top - 0.005:
        print(f"  ✓ PASS: options added {options_delta:+.2f}pp WF over fresh-data baseline (gate: ≥+0.3pp)")
        print(f"  → Proceed to Phase 4 (iOS pipeline integration)")
    else:
        print(f"  ✗ FAIL: options added {options_delta:+.2f}pp WF over fresh-data baseline (gate: ≥+0.3pp)")
        print(f"  → Stop. Cancel MarketData trial. Skip options work.")
        print(f"  → Note: data freshness alone gave {(base_acc - V11_BASELINE_ACC)*100:+.2f}pp — still worth shipping v12-baseline.")
    return  # skip the old single-run reporting block below

    # OLD SINGLE-RUN PATH (kept commented to preserve logic if needed) — unreachable due to return above.
    print("\nRunning walk-forward CV (3 folds, XGBoost d5 t100, time-decay weights)...")
    probs, y, _ = walk_forward_oof(data, make_stock_model)
    x_cal, y_cal = fit_calibration(probs, y)

    print(f"\n=== v12 PREVIEW (116 features) ===")
    diagnose("Stocks v12-preview", probs, y, x_cal, y_cal)

    v11_acc = 0.668
    v11_top_bucket = 0.750
    v12_correct = ((probs >= 0.5).astype(int) == y).mean()
    print(f"\n=== COMPARISON ===")
    print(f"  v11 WF accuracy:        {v11_acc*100:.1f}%")
    print(f"  v12 WF accuracy:        {v12_correct*100:.1f}%")
    delta = (v12_correct - v11_acc) * 100
    print(f"  Δ accuracy:             {delta:+.2f}pp")

    from sklearn.isotonic import IsotonicRegression
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(probs, y)
    cal_probs = np.minimum(iso.predict(probs), 0.85)
    top_mask = cal_probs >= 0.7
    if top_mask.sum() > 0:
        v12_top = y[top_mask].mean()
        print(f"  v11 top-bucket (>=70%): {v11_top_bucket*100:.1f}%")
        print(f"  v12 top-bucket (>=70%): {v12_top*100:.1f}% (n={top_mask.sum()})")

    # Decision
    print(f"\n=== DECISION ===")
    if delta >= 0.3:
        print(f"  ✓ PASS: improvement {delta:+.2f}pp meets gate (>= 0.3pp)")
        print(f"  → Proceed to Phase 4 (iOS pipeline integration)")
    else:
        print(f"  ✗ FAIL: improvement {delta:+.2f}pp below gate (>= 0.3pp)")
        print(f"  → Stop. Cancel MarketData trial. Skip options work.")


if __name__ == '__main__':
    main()
