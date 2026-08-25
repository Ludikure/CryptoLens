#!/usr/bin/env python3
"""Build barrier labels: did +R x risk arrive before -1 x risk, within 72h?

Pre-declared in docs/research/excursion-model.md. Nothing here was written after seeing a result.

The label a trade actually faces. `goodR` asks whether price EVER moved 1.5 ATR favourably and
ignores ordering, so a bar that fell 3 ATR and then rallied 2 scores 1 while the position was
stopped out hours earlier. This walks the real 1h path and records which barrier is touched first.

CONSERVATIVE INTRA-BAR CONVENTION: when a single 1h bar's range spans both barriers, ordering is
unknowable at this resolution and the STOP is assumed to fill first. That biases every probability
DOWN, which is the correct direction for a number that will size positions.
"""
import glob, os, sys
import numpy as np
import pandas as pd

HORIZON_H = 72            # hours; matches DEFAULT_STRUCTURE.holdingHorizonHours
STOP_ATR = 1.0            # matches DEFAULT_STRUCTURE.stopAtrMultiple
R_GRID = [1.0, 1.5, 2.0, 3.0, 5.0, 8.0]   # the grid provisionalCurve emits
FEAT_DIR = 'csv_exports_v14'
PATH_DIR = 'vision_backfill/klines_long'
OUT = 'excursion_dataset.pkl.gz'   # pickle+gzip: no pyarrow/fastparquet dependency


def label_symbol(sym: str) -> pd.DataFrame | None:
    fp, pp = f'{FEAT_DIR}/{sym}.csv', f'{PATH_DIR}/{sym}.csv'
    if not (os.path.exists(fp) and os.path.exists(pp)):
        return None

    feat = pd.read_csv(fp)
    path = pd.read_csv(pp).sort_values('ts').reset_index(drop=True)

    # Both are unix SECONDS. (Checked, not assumed: an earlier version divided by 1000 on the
    # assumption features were ms, which silently produced zero exact matches and zero rows.)
    ts_raw = feat['timestamp'].to_numpy(np.int64)
    fts = (ts_raw // 1000) if ts_raw[0] > 1e12 else ts_raw
    pts = path['ts'].to_numpy(np.int64)
    high = path['high'].to_numpy(np.float64)
    low = path['low'].to_numpy(np.float64)

    # Locate each feature bar in the 1h path. searchsorted 'left' then verify exactness: a feature
    # bar with no matching kline hour must be dropped, not silently snapped to a neighbour.
    idx = np.searchsorted(pts, fts, side='left')
    ok = (idx < len(pts) - HORIZON_H) & (idx >= 0)
    idx_safe = np.clip(idx, 0, len(pts) - 1)
    ok &= (pts[idx_safe] == fts)                       # exact hour match only

    # Entry is the bar's reference price -- the v14 column is `price`, which is exactly what the
    # live model sees. ATR comes from the same row, so entry and risk cannot disagree.
    entry = feat['price'].to_numpy(np.float64)
    atr = (feat['atrPercent'].to_numpy(np.float64) / 100.0) * entry
    ok &= np.isfinite(atr) & (atr > 0) & np.isfinite(entry) & (entry > 0)

    if ok.sum() == 0:
        return None

    rows = np.where(ok)[0]
    base = idx[rows]
    e, a = entry[rows], atr[rows]
    risk = STOP_ATR * a

    # Gather the next HORIZON_H bars for every row at once: (n, 72).
    offs = np.arange(1, HORIZON_H + 1)
    gh = high[base[:, None] + offs]
    gl = low[base[:, None] + offs]

    NEVER = HORIZON_H + 10

    def first_true(mat):
        """Index of the first True per row, or NEVER when the row never fires."""
        any_hit = mat.any(axis=1)
        first = mat.argmax(axis=1)
        return np.where(any_hit, first, NEVER)

    out = {'symbol': sym, 'timestamp': fts[rows], 'entry': e, 'atr': a}

    for side in ('LONG', 'SHORT'):
        # LONG  : stop below (low breaches), target above (high breaches)
        # SHORT : stop above (high breaches), target below (low breaches)
        # [:, None] gives each row its own barrier against the (n, 72) path matrix; without it
        # numpy aligns the (n,) barrier against the 72 TIME axis and compares the wrong things.
        stop_px = (e - risk if side == 'LONG' else e + risk)[:, None]
        stop_i = first_true(gl <= stop_px) if side == 'LONG' else first_true(gh >= stop_px)

        for R in R_GRID:
            tgt_px = (e + R * risk if side == 'LONG' else e - R * risk)[:, None]
            tgt_i = first_true(gh >= tgt_px) if side == 'LONG' else first_true(gl <= tgt_px)
            # Strict '<': a tie means the same 1h bar touched both, and the stop wins by convention.
            out[f'hit_{side}_{R:g}R'] = (tgt_i < stop_i).astype(np.int8)

        out[f'stopfirst_{side}'] = (stop_i < NEVER).astype(np.int8)

    lab = pd.DataFrame(out)
    # Carry the features across on the same rows, so the join cannot drift.
    fcols = [c for c in feat.columns if c not in ('symbol',)]
    return pd.concat([lab.reset_index(drop=True),
                      feat.iloc[rows][fcols].reset_index(drop=True).add_prefix('f_')], axis=1)


def main():
    syms = sorted({os.path.basename(f)[:-4] for f in glob.glob(f'{FEAT_DIR}/*.csv')} &
                  {os.path.basename(f)[:-4] for f in glob.glob(f'{PATH_DIR}/*.csv')})
    print(f'{len(syms)} symbols with both features and paths', flush=True)

    parts = []
    for i, s in enumerate(syms, 1):
        try:
            d = label_symbol(s)
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
