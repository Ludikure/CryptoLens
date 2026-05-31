#!/usr/bin/env python3
"""
Do the 6 volume-profile features earn their place in the quality model?

Ablation on the frozen holdout (train on selection only). Compare:
  - full model (111 features)
  - drop the 6 VP features (vpDistToPocATR, vpAbovePoc, vpVAWidth, vpInValueArea,
    vpDistToVAH_ATR, vpDistToVAL_ATR)
  - CONTROL: drop random 6-feature sets — if the VP delta is within the random-drop
    spread, VP contributes nothing special.

Metrics: holdout AUC (ranking quality — the sensitive one), accuracy, and top-20%-bucket
actual goodR rate (the model's actual job: surface high-probability bars). Also prints VP
gain-importance rank among all 111. Methodology: docs/research/edge-methodology.md.

Run:  python3 ablation_vp.py
"""
import numpy as np
from sklearn.metrics import roc_auc_score

H = __import__('_harness')

VP = ['vpDistToPocATR', 'vpAbovePoc', 'vpVAWidth', 'vpInValueArea', 'vpDistToVAH_ATR', 'vpDistToVAL_ATR']


def evaluate(feats, sel, hold):
    m = H.make_model()
    m.fit(sel[feats].fillna(0), sel['goodR'])
    p = m.predict_proba(hold[feats].fillna(0))[:, 1]
    y = hold['goodR'].values
    auc = roc_auc_score(y, p)
    acc = ((p > 0.5).astype(int) == y).mean() * 100
    n = max(1, int(len(p) * 0.20))
    top = np.argsort(p)[::-1][:n]
    topwin = y[top].mean() * 100
    return auc, acc, topwin, m


def run(market):
    df, _ = H.load_market(market)
    sel, hold, _ = H.split_holdout(df)
    print(f"\n{'='*64}\n{market.upper()} — VP ablation (holdout n={len(hold):,}, base goodR {hold['goodR'].mean()*100:.1f}%)\n{'='*64}")

    auc_f, acc_f, top_f, m_full = evaluate(H.FEATURES, sel, hold)
    print(f"  full (111):       AUC {auc_f:.4f}   acc {acc_f:.1f}%   top20% goodR {top_f:.1f}%")

    feats_no_vp = [f for f in H.FEATURES if f not in VP]
    auc_v, acc_v, top_v, _ = evaluate(feats_no_vp, sel, hold)
    print(f"  drop VP (105):    AUC {auc_v:.4f}   acc {acc_v:.1f}%   top20% goodR {top_v:.1f}%")
    print(f"    → ΔAUC {(auc_v-auc_f)*1000:+.2f} (×1e-3)   Δtop20% {top_v-top_f:+.2f}pp")

    # control: drop random 6-feature sets
    rng = np.random.RandomState(0)
    pool = [f for f in H.FEATURES if f not in VP]
    dAUC, dTop = [], []
    for i in range(6):
        drop = list(rng.choice(pool, size=6, replace=False))
        feats = [f for f in H.FEATURES if f not in drop]
        a, _, t, _ = evaluate(feats, sel, hold)
        dAUC.append((a - auc_f) * 1000); dTop.append(t - top_f)
    print(f"  CONTROL drop-random-6 (×6): ΔAUC mean {np.mean(dAUC):+.2f} range [{min(dAUC):+.2f},{max(dAUC):+.2f}] (×1e-3)")
    print(f"                              Δtop20% mean {np.mean(dTop):+.2f} range [{min(dTop):+.2f},{max(dTop):+.2f}]pp")
    verdict = "within noise — VP adds nothing special" if (auc_v - auc_f) * 1000 >= min(dAUC) else "VP drop hurts MORE than random — they contribute"
    print(f"  → VERDICT: {verdict}")

    # VP importance rank among 111
    imp = m_full.feature_importances_
    order = np.argsort(imp)[::-1]
    rank = {H.FEATURES[idx]: r + 1 for r, idx in enumerate(order)}
    print("  VP gain-importance rank among 111 (1=most important):")
    for f in VP:
        print(f"    {f:<18} rank {rank[f]:>3}/111")


def main():
    for market in ('crypto', 'stock'):
        run(market)


if __name__ == '__main__':
    main()
