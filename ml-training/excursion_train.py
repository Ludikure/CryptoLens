#!/usr/bin/env python3
"""Train and validate the excursion model against the bar pre-declared in
docs/research/excursion-model.md. The bar was fixed at 3238cde, before any number below existed.

Two arms, same folds, same features, same rows:

  A (incumbent)  trained on goodR  = fwdMaxFavR >= 1.5   -- what the system predicts today
  B (challenger) trained on the BARRIER label            -- target-before-stop, what a trade faces

Criterion 5 says B must beat A by >= +0.01 AUC in ALL folds. If it does not, the honest answer is to
recalibrate the existing model onto the barrier target rather than train a second one -- a mapping,
not a model, and the recalibrate-before-retrain ladder from 2026-08-14.

BOTH AUC axes are reported, always. On 2026-08-24 a pruned model passed three validations on
per-symbol AUC and was reverted within the hour because its within-timestamp AUC had collapsed.
"""
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

DATA = 'excursion_dataset.pkl.gz'
PRIMARY_R = 5.0
N_FOLDS = 3
PURGE_BARS = 24            # >= 18 = 72h horizon / 4h cadence, with margin
MIN_XS_ASSETS = 5          # a "cross-sectional AUC" over 2 assets is not information
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1)


def both_auc(df, score_col, label_col):
    """Per-symbol AUC and within-timestamp AUC. Reporting one without the other is the failure mode."""
    per = []
    for _, g in df.groupby('symbol'):
        if g[label_col].nunique() == 2:
            per.append(roc_auc_score(g[label_col], g[score_col]))
    xs = []
    for _, g in df.groupby('timestamp'):
        if len(g) >= MIN_XS_ASSETS and g[label_col].nunique() == 2:
            xs.append(roc_auc_score(g[label_col], g[score_col]))
    return (float(np.mean(per)) if per else np.nan,
            float(np.mean(xs)) if xs else np.nan,
            len(xs))


def folds(ts_sorted, n):
    """Expanding-window walk-forward on unique timestamps, purged by PURGE_BARS."""
    uniq = np.unique(ts_sorted)
    cuts = np.linspace(len(uniq) * 0.4, len(uniq), n + 1).astype(int)
    for i in range(n):
        tr_end, te_end = cuts[i], cuts[i + 1]
        if te_end - tr_end < 50:
            continue
        yield uniq[max(0, tr_end - 1)], uniq[min(tr_end + PURGE_BARS, len(uniq) - 1)], uniq[te_end - 1]


def main():
    df = pd.read_pickle(DATA).sort_values('timestamp').reset_index(drop=True)
    # Numeric only. The string bias/regime columns have numeric twins already in the set
    # (regimeCode, tfAlignment, momentumAlignment), so dropping them loses no information.
    feats = [c for c in df.columns if c.startswith('f_')
             and c not in ('f_timestamp',)
             and not c.startswith('f_fwd') and not c.startswith('f_trade')
             and pd.api.types.is_numeric_dtype(df[c])]
    # goodR, the incumbent target, reconstructed from the same rows.
    df['y_goodr'] = (df['f_fwdMaxFavR'] >= 1.5).astype(int)
    print(f'{len(df):,} rows | {len(feats)} features | {df.symbol.nunique()} symbols')
    print(f'purge {PURGE_BARS} bars, {N_FOLDS} expanding folds\n')

    for side in ('LONG', 'SHORT'):
        y_bar = f'hit_{side}_{PRIMARY_R:g}R'
        print(f'{"="*78}\n{side} @ {PRIMARY_R:g}R   base rate {df[y_bar].mean():.4f}'
              f'   (random walk {1/(1+PRIMARY_R):.4f})\n{"="*78}')
        print(f'{"fold":>5}{"n_test":>9}{"A per-sym":>11}{"A xs":>8}{"B per-sym":>11}{"B xs":>8}'
              f'{"B-A per":>9}{"B-A xs":>9}')

        deltas_per, deltas_xs, held = [], [], []
        for k, (tr, pg, te) in enumerate(folds(df.timestamp.values, N_FOLDS), 1):
            trn = df[df.timestamp <= tr]
            tst = df[(df.timestamp > pg) & (df.timestamp <= te)]
            if len(tst) < 200 or trn[y_bar].nunique() < 2 or tst[y_bar].nunique() < 2:
                continue

            mA = lgb.LGBMClassifier(**PARAMS).fit(trn[feats], trn['y_goodr'])
            mB = lgb.LGBMClassifier(**PARAMS).fit(trn[feats], trn[y_bar])
            t = tst.copy()
            t['sA'] = mA.predict_proba(t[feats])[:, 1]
            t['sB'] = mB.predict_proba(t[feats])[:, 1]

            aP, aX, _ = both_auc(t, 'sA', y_bar)
            bP, bX, nx = both_auc(t, 'sB', y_bar)
            print(f'{k:>5}{len(t):>9,}{aP:>11.4f}{aX:>8.4f}{bP:>11.4f}{bX:>8.4f}'
                  f'{bP-aP:>+9.4f}{bX-aX:>+9.4f}')
            deltas_per.append(bP - aP); deltas_xs.append(bX - aX)
            held.append((t, y_bar, bP, bX, nx))

        if not held:
            print('  no evaluable folds'); continue

        # ---- controls, on the last fold's held-out predictions ----
        t, y_bar_l, bP, bX, nx = held[-1]
        rng = np.random.default_rng(42)
        ctl = {}
        s = t['sB'].to_numpy().copy(); rng.shuffle(s)
        ctl['shuffled-timing'] = both_auc(t.assign(sB=s), 'sB', y_bar_l)
        yl = t[y_bar_l].to_numpy().copy(); rng.shuffle(yl)
        ctl['random-labels'] = both_auc(t.assign(**{y_bar_l: yl}), 'sB', y_bar_l)
        lag = t.sort_values(['symbol', 'timestamp']).groupby('symbol')['sB'].shift(30)
        lg = t.assign(sB=lag).dropna(subset=['sB'])
        ctl['lag-30'] = both_auc(lg, 'sB', y_bar_l) if len(lg) > 200 else (np.nan, np.nan, 0)

        print(f'\n  controls (final fold, real = {bP:.4f} per-sym / {bX:.4f} xs, {nx} timestamps):')
        for name, (cp, cx, _) in ctl.items():
            print(f'    {name:16s} per-sym {cp:.4f} (Δ{bP-cp:+.4f})   xs {cx:.4f} (Δ{bX-cx:+.4f})')

        # ---- calibration monotonicity on the final fold ----
        t2 = t.copy(); t2['dec'] = pd.qcut(t2['sB'], 10, labels=False, duplicates='drop')
        rel = t2.groupby('dec')[y_bar_l].mean()
        inv = int((rel.diff().dropna() < 0).sum())
        print(f'  calibration deciles: {" ".join(f"{v:.3f}" for v in rel.values)}  ({inv} inversions)')

        # ---- verdict against the pre-declared bar ----
        print(f'\n  PRE-DECLARED BAR:')
        c1 = (bP >= 0.55) and (bX >= 0.55)
        c2 = all(bP - ctl[c][0] >= 0.02 and (np.isnan(ctl[c][1]) or bX - ctl[c][1] >= 0.02)
                 for c in ('shuffled-timing', 'lag-30'))
        c3 = abs(ctl['random-labels'][0] - 0.5) <= 0.03
        c4 = inv <= 1
        c5 = len(deltas_per) > 0 and all(d >= 0.01 for d in deltas_per)
        for n, c, d in [('1 AUC>=0.55 both axes', c1, f'{bP:.4f} / {bX:.4f}'),
                        ('2 beats controls +0.02', c2, ''),
                        ('3 random-label ~0.50', c3, f'{ctl["random-labels"][0]:.4f}'),
                        ('4 monotonic calibration', c4, f'{inv} inversions'),
                        ('5 beats incumbent all folds', c5,
                         ' '.join(f'{d:+.4f}' for d in deltas_per))]:
            print(f'    [{"PASS" if c else "FAIL"}] {n:32s} {d}')
        print(f'  => {"SHIP" if all([c1,c2,c3,c4,c5]) else "DO NOT SHIP"}\n')


if __name__ == '__main__':
    main()
