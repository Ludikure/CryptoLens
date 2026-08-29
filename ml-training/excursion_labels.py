#!/usr/bin/env python3
"""Build barrier labels: did +R x risk arrive before -1 x risk, within 72h?

Pre-declared in docs/research/excursion-model.md. Nothing here was written after seeing a result.

The label a trade actually faces. `goodR` asks whether price EVER moved 1.5 ATR favourably and
ignores ordering, so a bar that fell 3 ATR and then rallied 2 scores 1 while the position was
stopped out hours earlier. This walks the real 1h path and records which barrier is touched first.

RE-RUN 2026-08-26 ON `_payoff.barriers`. The original scanned `arange(1, 73)` from the bar whose
timestamp EQUALS the feature timestamp T. But a feature row's `price` is the CLOSE of the bar
spanning T..T+4h, so the label window started four hours BEFORE the signal existed — and the
pre-entry span T+1h..T+4h sits inside the very 4H bar whose OHLC is in the feature vector, giving
the leak a feature-side handle (`atrPercent`, `bodyWickRatio`, `hBBPercentB`).

That is why `ml-model-excursion-crypto.json` was quarantined on 2026-08-26 (plan step 0.5): it was
trained on these labels and served live. Regenerating this file is the prerequisite for retraining
it. The window now runs `arange(0, 72)` from the bar OPENING at T+4h.
"""
import glob, os, sys
import numpy as np
import pandas as pd
from _payoff import barriers, Provenance

HORIZON_H = 72            # hours; matches DEFAULT_STRUCTURE.holdingHorizonHours
STOP_ATR = 1.0            # matches DEFAULT_STRUCTURE.stopAtrMultiple
R_GRID = [1.0, 1.5, 2.0, 3.0, 5.0, 8.0]   # the grid provisionalCurve emits
FEAT_DIR = 'csv_exports_v14'
PATH_DIR = 'vision_backfill/klines_long'
OUT = 'excursion_dataset.pkl.gz'   # pickle+gzip: no pyarrow/fastparquet dependency
ANCHOR = 'bar_close'


def label_symbol(sym: str):
    fp, pp = f'{FEAT_DIR}/{sym}.csv', f'{PATH_DIR}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)):
        return None, None
    feat = pd.read_csv(fp, low_memory=False)
    path = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)

    frames, provs = [], []
    for side in ('LONG', 'SHORT'):
        out, prov = barriers(feat, path, symbol=sym, side=side, r_grid=R_GRID,
                             anchor=ANCHOR, horizon_h=HORIZON_H, stop_atr=STOP_ATR)
        provs.append(prov)
        if not len(out):
            return None, None
        frames.append(out if not frames else out.drop(columns=['symbol', 'timestamp', 'entry', 'atr']))
    lab = pd.concat(frames, axis=1)

    # Carry the features across on the SAME rows the labels came from, so the join cannot drift.
    # `barriers` returns rows in feature order, and `locate` reports which survived.
    keep = feat['timestamp'].to_numpy(np.int64)
    keep = (keep // 1000) if keep[0] > 1e12 else keep
    pos = pd.Index(keep).get_indexer(lab['timestamp'].to_numpy())
    assert (pos >= 0).all(), f'{sym}: a label row has no feature row'
    fcols = [c for c in feat.columns if c != 'symbol']
    return pd.concat([lab.reset_index(drop=True),
                      feat.iloc[pos][fcols].reset_index(drop=True).add_prefix('f_')], axis=1), provs
def main():
    syms = sorted({os.path.basename(f)[:-4] for f in glob.glob(f'{FEAT_DIR}/*.csv')} &
                  {os.path.basename(f)[:-4] for f in glob.glob(f'{PATH_DIR}/*.csv')})
    print(f'{len(syms)} symbols with both features and paths', flush=True)

    parts = []
    for i, s in enumerate(syms, 1):
        try:
            d, _pv = label_symbol(s)
        except Exception as ex:
            print(f'  {s}: FAILED {ex}', flush=True); continue
        if d is None or len(d) == 0:
            print(f'  {s}: no usable rows', flush=True); continue
        parts.append(d)
        print(f'  [{i:2d}/{len(syms)}] {s:12s} {len(d):>6,} rows  '
              f'5R long {d["hit_LONG_5R"].mean():.3f}  short {d["hit_SHORT_5R"].mean():.3f}', flush=True)

    if not parts:
        print('no data'); sys.exit(1)

    df = pd.concat(parts, ignore_index=True)
    df.attrs['provenance'] = Provenance(anchor=ANCHOR, entry_mode='barrier', symbols=len(parts),
                                        params=dict(horizon_h=HORIZON_H, stop_atr=STOP_ATR,
                                                    r_grid=R_GRID)).to_dict()
    df.to_pickle(OUT)
    print(f'\nwrote {OUT}: {len(df):,} rows, {df["symbol"].nunique()} symbols')

    print('\nbase rates vs the driftless random-walk benchmark 1/(1+R):')
    print(f'{"R":>5} {"LONG":>8} {"SHORT":>8} {"rand-walk":>10} {"edge(L)":>9}')
    for R in R_GRID:
        l, s = df[f'hit_LONG_{R:g}R'].mean(), df[f'hit_SHORT_{R:g}R'].mean()
        rw = 1 / (1 + R)
        print(f'{R:>5g} {l:>8.4f} {s:>8.4f} {rw:>10.4f} {l - rw:>+9.4f}')


if __name__ == '__main__':
    main()
