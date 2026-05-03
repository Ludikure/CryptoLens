"""
Phase 2 redo: model architecture sweep on goodR_1.5atr (the actual best-skill target).

The previous full sweep selected the wrong "best" target (downMove24h_2.0pct, which had
zero skill — its 78.67% WF was just the majority-class baseline). Reanalyzing Phase 1
results with skill = WF_acc − max(class_pct, 1-class_pct), goodR_1.5atr is the clear
winner at +13.17pp of skill.

This script runs ONLY the model architecture comparison on the right target, so we know
whether architecture changes can move the needle on what we know is the most predictable
target shape.
"""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

from explore_targets_and_models import (
    walk_forward_with_target,
    make_xgb,
    make_lgb,
    make_lr,
)
from calibrate_v11_stocks import STOCK_SYMBOLS, load_symbol, downsample_daily
import pandas as pd


def main():
    print("=" * 80)
    print("Model Architecture Sweep on goodR_1.5atr (the real best-skill target)")
    print("=" * 80)

    print("\nLoading CSVs...")
    parts = []
    for sym in STOCK_SYMBOLS:
        d = load_symbol(sym, is_crypto=False)
        if d is None:
            continue
        d = downsample_daily(d)
        parts.append(d)
    data = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    data = data[data['fwdMaxFavR'].notna() & data['fwdReturn24H'].notna()].copy()
    data['goodR_1.5atr'] = (data['fwdMaxFavR'] >= 1.5).astype(int)
    print(f"Total rows: {len(data)}, class balance: {data['goodR_1.5atr'].mean()*100:.1f}%")
    print(f"Majority-class baseline: {max(data['goodR_1.5atr'].mean(), 1 - data['goodR_1.5atr'].mean())*100:.1f}%")
    print()
    print(f"{'Model':<35} {'WF acc':>10} {'Skill':>10} {'Top bucket':>12} {'Top n':>10}")
    print("-" * 80)

    majority = max(data['goodR_1.5atr'].mean(), 1 - data['goodR_1.5atr'].mean())

    configs = [
        ("XGBoost d3 t100", lambda: make_xgb(3, 100)),
        ("XGBoost d4 t100", lambda: make_xgb(4, 100)),
        ("XGBoost d5 t100 (baseline)", lambda: make_xgb(5, 100)),
        ("XGBoost d6 t100", lambda: make_xgb(6, 100)),
        ("XGBoost d5 t200", lambda: make_xgb(5, 200)),
        ("XGBoost d5 t300", lambda: make_xgb(5, 300)),
        ("XGBoost d6 t200", lambda: make_xgb(6, 200)),
        ("XGBoost d7 t150", lambda: make_xgb(7, 150)),
        ("LightGBM d4 t150", lambda: make_lgb(4, 150)),
        ("LightGBM d5 t150", lambda: make_lgb(5, 150)),
        ("LightGBM d6 t200", lambda: make_lgb(6, 200)),
        ("LightGBM d4 t300", lambda: make_lgb(4, 300)),
        ("Logistic Regression (scaled)", lambda: make_lr()),
    ]

    results = []
    for name, fn in configs:
        try:
            r = walk_forward_with_target(data, fn, target_col='goodR_1.5atr')
            if r is None:
                print(f"{name:<35} {'(failed)':>20}")
                continue
            acc, top, top_n, _ = r
            skill = acc - majority
            results.append((name, acc, top, top_n, skill))
            print(f"{name:<35} {acc*100:>9.2f}% {skill*100:>+9.2f}pp {top*100:>10.1f}% {top_n:>10}")
        except Exception as e:
            print(f"{name:<35} (error: {str(e)[:30]})")

    if results:
        best = max(results, key=lambda r: r[1])
        baseline = next((r for r in results if r[0].startswith("XGBoost d5 t100")), None)
        print()
        print("=" * 80)
        print(f"BEST: {best[0]}")
        print(f"  WF accuracy: {best[1]*100:.2f}%")
        print(f"  Skill: {best[4]*100:+.2f}pp above majority-class")
        print(f"  Top bucket: {best[2]*100:.1f}% (n={best[3]})")
        if baseline:
            delta = (best[1] - baseline[1]) * 100
            print(f"\n  vs current production (XGBoost d5 t100): {delta:+.2f}pp WF")
            if delta < 0.2:
                print("  → Architecture is essentially saturated. Current production model is near-optimal.")
            else:
                print(f"  → Architecture change might be worth shipping ({delta:+.2f}pp lift).")


if __name__ == '__main__':
    main()
