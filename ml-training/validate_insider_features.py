"""
Phase: Insider Features Validation Gate

Tests whether 5 insider-flow features computed from Finnhub Form 4 data
improve goodR prediction over the v12-baseline (fresh data, 111 features).

Method (3-way comparison, mirrors validate_options_features.py):
1. Load v11 stock CSVs (fresh data, post merge fix)
2. Load insider_history.json (raw Finnhub txs per symbol)
3. For each (symbol, eval_date) row, compute 5 insider features over rolling
   30/90/180-day windows ending at eval_date — strictly historical, no leak
4. Train v12-baseline (111 features, no insider) — control
5. Train v12-insider (116 features = 111 + 5 insider) — treatment
6. Decision: gate passes if WF accuracy improves ≥ +0.3pp AND no top-bucket
   regression vs v12-baseline

Insider features:
  - insiderNetBuyUSD30d:    sum(buy USD) − sum(sell USD), open-market only, 30d window
  - insiderBuyCount30d:     count of distinct buy txs (P code), 30d
  - insiderUniqueBuyers90d: count of distinct insider names buying, 90d (cluster signal)
  - insiderNetBuyUSD180d:   net USD value, 180d
  - insiderBuyToSellRatio180d: count(buys) / max(1, count(sells)), 180d

Open-market trades only: filter by transactionCode == 'P' (purchase) or 'S' (sale).
Code 'A' (award/grant) and 'M' (option exercise) excluded — those are compensation,
not directional bets.

Decision rule:
  PASS  → run calibrate_v13_insider.py to ship v13 model
  FAIL  → drop insider features, stay on v12-baseline
"""

import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from calibrate_v11_stocks import (
    FEATURES as V11_FEATURES,
    STOCK_SYMBOLS,
    DOWNLOADS,
    walk_forward_oof,
    make_stock_model,
)


INSIDER_PATH = '/Users/bojanmihovilovic/CryptoLens/ml-training/insider_history.json'

INSIDER_FEATURES = [
    'insiderNetBuyUSD30d',
    'insiderBuyCount30d',
    'insiderUniqueBuyers90d',
    'insiderNetBuyUSD180d',
    'insiderBuyToSellRatio180d',
]
INSIDER_DEFAULTS = {
    'insiderNetBuyUSD30d': 0.0,
    'insiderBuyCount30d': 0,
    'insiderUniqueBuyers90d': 0,
    'insiderNetBuyUSD180d': 0.0,
    'insiderBuyToSellRatio180d': 1.0,  # neutral when no data
}


def load_insider_data() -> dict[str, list[dict]]:
    if not os.path.isfile(INSIDER_PATH):
        print(f"ERROR: {INSIDER_PATH} not found. Run insider_backfill.py first.")
        sys.exit(1)
    with open(INSIDER_PATH) as f:
        return json.load(f)


def normalize_txs(txs: list[dict]) -> list[dict]:
    """Filter to open-market trades (codes P, S) and parse dates as epoch ms.
    Returns list sorted ascending by ts; each dict has ts (ms), is_buy, value (USD), name."""
    out = []
    for t in txs:
        code = t.get('transactionCode', '')
        if code not in ('P', 'S'):
            continue  # skip awards (A), exercises (M), other
        date_str = t.get('transactionDate')
        if not date_str:
            continue
        try:
            ts = int(datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            continue
        share = abs(t.get('change', 0) or 0)
        price = t.get('transactionPrice', 0) or 0
        value = share * price
        if value <= 0:
            continue
        is_buy = code == 'P'
        out.append({
            'ts': ts,
            'is_buy': is_buy,
            'value': value,
            'name': t.get('name', '') or '',
        })
    out.sort(key=lambda x: x['ts'])
    return out


def compute_insider_features(txs_sorted: list[dict], eval_ts_ms: int) -> dict:
    """Compute the 5 insider features as-of eval_ts_ms using only txs strictly before it."""
    if not txs_sorted:
        return dict(INSIDER_DEFAULTS)
    # Binary search via list comprehension is fine for a few hundred txs/symbol
    win_30d = eval_ts_ms - 30 * 86400 * 1000
    win_90d = eval_ts_ms - 90 * 86400 * 1000
    win_180d = eval_ts_ms - 180 * 86400 * 1000

    # iterate from the back (most recent) until before eval_ts_ms, then collect by window
    relevant = [t for t in txs_sorted if t['ts'] < eval_ts_ms]
    if not relevant:
        return dict(INSIDER_DEFAULTS)
    in_30 = [t for t in relevant if t['ts'] >= win_30d]
    in_90 = [t for t in relevant if t['ts'] >= win_90d]
    in_180 = [t for t in relevant if t['ts'] >= win_180d]

    net_30 = sum((t['value'] if t['is_buy'] else -t['value']) for t in in_30)
    buys_30 = sum(1 for t in in_30 if t['is_buy'])
    unique_buyers_90 = len({t['name'] for t in in_90 if t['is_buy']})
    net_180 = sum((t['value'] if t['is_buy'] else -t['value']) for t in in_180)
    buys_180 = sum(1 for t in in_180 if t['is_buy'])
    sells_180 = sum(1 for t in in_180 if not t['is_buy'])
    ratio_180 = buys_180 / max(1, sells_180)

    return {
        'insiderNetBuyUSD30d': float(net_30),
        'insiderBuyCount30d': int(buys_30),
        'insiderUniqueBuyers90d': int(unique_buyers_90),
        'insiderNetBuyUSD180d': float(net_180),
        'insiderBuyToSellRatio180d': float(ratio_180),
    }


def load_symbol_with_insider(symbol: str, txs_sorted: list[dict]) -> pd.DataFrame | None:
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

    # Fill v11 features that may be missing
    for feat in V11_FEATURES:
        if feat not in valid.columns:
            if feat == 'takerRatioRaw':
                valid[feat] = 1.0
            elif feat == 'longPctRaw':
                valid[feat] = 50.0
            else:
                valid[feat] = 0.0

    # Compute insider features per row using as-of-date lookups against txs_sorted
    feat_cols: dict[str, list] = {f: [] for f in INSIDER_FEATURES}
    for ts in valid['timestamp'].values:
        eval_ms = int(float(ts)) * 1000
        feats = compute_insider_features(txs_sorted, eval_ms)
        for f in INSIDER_FEATURES:
            feat_cols[f].append(feats[f])
    for f in INSIDER_FEATURES:
        valid[f] = feat_cols[f]
    return valid


def _wf(data, features_list):
    import calibrate_v11_stocks as v11
    v11.FEATURES = features_list
    probs, y, _ = walk_forward_oof(data, make_stock_model)
    acc = ((probs >= 0.5).astype(int) == y).mean()
    from sklearn.isotonic import IsotonicRegression
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(probs, y)
    cal = np.minimum(iso.predict(probs), 0.85)
    top_mask = cal >= 0.7
    top_acc = float(y[top_mask].mean()) if top_mask.sum() > 0 else 0.0
    return acc, top_acc, int(top_mask.sum())


def main():
    print("=" * 70)
    print("Insider Features Validation Gate (3-way)")
    print("=" * 70)

    print("\nLoading insider history...")
    insider_raw = load_insider_data()
    insider_sorted = {sym: normalize_txs(txs) for sym, txs in insider_raw.items()}
    total_clean = sum(len(v) for v in insider_sorted.values())
    print(f"  {len(insider_sorted)} symbols, {total_clean} open-market (P/S) transactions after filtering")

    print("\nAugmenting CSVs with insider features (this is the slow step)...")
    parts = []
    rows_with_data = 0
    rows_total = 0
    for sym in STOCK_SYMBOLS:
        txs = insider_sorted.get(sym, [])
        d = load_symbol_with_insider(sym, txs)
        if d is None:
            continue
        d['date'] = pd.to_datetime(d['timestamp'], unit='s').dt.date
        d = d.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)
        # Count rows where insider features are non-default (proxy for coverage)
        non_default = ((d['insiderNetBuyUSD30d'] != 0) |
                       (d['insiderBuyCount30d'] > 0) |
                       (d['insiderNetBuyUSD180d'] != 0)).sum()
        rows_with_data += int(non_default)
        rows_total += len(d)
        parts.append(d)
        print(f"  {sym:6s}: {len(d)} bars, {int(non_default)} ({100*non_default/len(d):.0f}%) have insider activity")

    data = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    print(f"\nTotal: {len(data)} bars, insider-activity rows: {rows_with_data} ({100*rows_with_data/rows_total:.1f}%)")
    print(f"goodR rate: {data['goodR'].mean()*100:.1f}%")

    # Build augmented FEATURES list (insert 5 insider features after shortVolumeZScore)
    new_features = list(V11_FEATURES)
    insert_idx = new_features.index('shortVolumeZScore') + 1
    for i, f in enumerate(INSIDER_FEATURES):
        new_features.insert(insert_idx + i, f)
    assert len(new_features) == 116, f"expected 116, got {len(new_features)}"

    print("\n" + "─" * 70)
    print("Run A: v12-baseline — fresh data, 111 features (no insider)")
    print("─" * 70)
    base_acc, base_top, base_top_n = _wf(data, list(V11_FEATURES))
    print(f"  WF accuracy: {base_acc*100:.2f}%, top bucket [0.70+): {base_top*100:.1f}% (n={base_top_n})")

    print("\n" + "─" * 70)
    print("Run B: v13-insider — fresh data, 116 features (with insider)")
    print("─" * 70)
    ins_acc, ins_top, ins_top_n = _wf(data, new_features)
    print(f"  WF accuracy: {ins_acc*100:.2f}%, top bucket [0.70+): {ins_top*100:.1f}% (n={ins_top_n})")

    print("\n" + "=" * 70)
    print("3-WAY COMPARISON")
    print("=" * 70)
    V11_BASE_ACC = 0.668
    V11_BASE_TOP = 0.750
    print(f"  v11 stale baseline   : {V11_BASE_ACC*100:.2f}% WF, {V11_BASE_TOP*100:.1f}% top bucket")
    print(f"  v12-baseline (fresh) : {base_acc*100:.2f}% WF, {base_top*100:.1f}% top bucket")
    print(f"  v13-insider (fresh)  : {ins_acc*100:.2f}% WF, {ins_top*100:.1f}% top bucket")
    print()
    print(f"  Δ from data freshness (v12-baseline vs v11)   : {(base_acc - V11_BASE_ACC)*100:+.2f}pp WF")
    print(f"  Δ from insider       (v13-insider vs baseline) : {(ins_acc - base_acc)*100:+.2f}pp WF, {(ins_top - base_top)*100:+.2f}pp top bucket")
    print(f"  Δ total              (v13-insider vs v11)     : {(ins_acc - V11_BASE_ACC)*100:+.2f}pp WF")

    delta = (ins_acc - base_acc) * 100
    print()
    print("=" * 70)
    print("DECISION (insider gate)")
    print("=" * 70)
    if delta >= 0.3 and ins_top >= base_top - 0.005:
        print(f"  ✓ PASS: insider features added {delta:+.2f}pp WF over v12-baseline (gate: ≥+0.3pp)")
        print(f"  → Proceed to Phase: integrate into MLFeatures struct + worker live serving")
    else:
        print(f"  ✗ FAIL: insider features added {delta:+.2f}pp WF over v12-baseline (gate: ≥+0.3pp)")
        print(f"  → Stop. Skip insider features. v12-baseline remains the production model.")


if __name__ == '__main__':
    main()
