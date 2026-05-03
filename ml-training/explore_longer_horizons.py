"""
Step 1 — Longer-horizon target test.

Question: are structural moves over 5d / 2w / 4w more predictable than 24h ATR magnitude?

Method:
1. Pull daily candles from worker D1 archive (already complete back to 2017+)
2. For each (symbol, eval_timestamp) in existing v12 CSVs, compute fwdMaxFavR
   over multiple forward windows: 24h (sanity check), 48h, 5d, 10d, 14d, 20d
3. Define targets at multiple ATR thresholds per horizon
4. Run WF with current 111 features but new targets
5. Compare skill (WF acc − majority-class) vs current v12-baseline

If any horizon shows materially better skill, that's our new strategic direction.
If 24h goodR is still tops, we can move on to LSTM (Step 2).
"""

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from calibrate_v11_stocks import (
    FEATURES,
    STOCK_SYMBOLS,
    DOWNLOADS,
    load_symbol,
    downsample_daily,
)
from explore_targets_and_models import walk_forward_with_target, make_xgb

WORKER_URL = "https://marketscope-proxy.ludikure.workers.dev"


def fetch_daily(symbol: str) -> pd.DataFrame:
    """Pull daily candles from worker D1 archive (covers back to 2017+)."""
    # D1 stores ms timestamps; ask for everything from 2018 onwards
    start_ms = int(datetime(2018, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    end_ms = int(time.time() * 1000)
    url = f"{WORKER_URL}/history?symbol={symbol}&interval=1d&start={start_ms}&end={end_ms}"
    req = urllib.request.Request(url, headers={
        'X-App-ID': 'marketscope-ios',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        candles = data.get('candles', [])
        if not candles:
            return pd.DataFrame()
        df = pd.DataFrame(candles)
        # ts in ms → date (UTC)
        df['date'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True).dt.date
        df = df.sort_values('timestamp').reset_index(drop=True)
        return df
    except Exception as e:
        print(f"  WARN: {symbol} D1 fetch failed: {e}")
        return pd.DataFrame()


def compute_horizon_targets(eval_df: pd.DataFrame, daily_df: pd.DataFrame, horizons_days: list[int]):
    """For each row in eval_df (one per training row of this symbol), compute
    fwdMaxFavR_<N>d for each horizon N in horizons_days.

    fwdMaxFavR = max(max(high)-entry, entry-min(low)) over the next N trading days,
                 normalized by daily ATR at eval time (from existing atrPercent feature).

    Returns eval_df with new columns added."""
    if daily_df.empty:
        for h in horizons_days:
            eval_df[f'fwdMaxFavR_{h}d'] = np.nan
        return eval_df

    # Build a date-indexed array of (high, low) for fast slicing
    daily_arr = daily_df[['high', 'low']].values
    daily_dates = daily_df['date'].values

    new_cols = {f'fwdMaxFavR_{h}d': [] for h in horizons_days}

    eval_dates = pd.to_datetime(eval_df['timestamp'], unit='s', utc=True).dt.date.values
    eval_prices = eval_df['price'].values
    # atrPercent is daily ATR as %. atr_abs = price * atrPercent / 100
    atr_abs = eval_df['price'].values * eval_df['atrPercent'].values / 100.0

    for i in range(len(eval_df)):
        eval_date = eval_dates[i]
        eval_price = eval_prices[i]
        atr = atr_abs[i] if atr_abs[i] > 0 else max(0.01 * eval_price, 0.01)

        # Find first daily candle strictly AFTER eval_date (forward window starts next day)
        start_idx = np.searchsorted(daily_dates, eval_date, side='right')

        for h in horizons_days:
            end_idx = min(start_idx + h, len(daily_arr))
            if end_idx <= start_idx:
                new_cols[f'fwdMaxFavR_{h}d'].append(np.nan)
                continue
            window = daily_arr[start_idx:end_idx]
            max_high = window[:, 0].max()
            min_low = window[:, 1].min()
            # Max excursion in either direction
            up = max(0, max_high - eval_price)
            down = max(0, eval_price - min_low)
            max_fav = max(up, down)
            new_cols[f'fwdMaxFavR_{h}d'].append(max_fav / atr)

    for col, vals in new_cols.items():
        eval_df[col] = vals
    return eval_df


def main():
    print("=" * 80)
    print("Longer-Horizon Target Test")
    print("=" * 80)

    horizons = [1, 2, 5, 10, 14, 20]  # days
    print(f"Horizons (days): {horizons}")

    print("\nLoading + downsampling stock CSVs...")
    parts = []
    for sym in STOCK_SYMBOLS:
        d = load_symbol(sym, is_crypto=False)
        if d is None:
            continue
        d = downsample_daily(d).sort_values('timestamp').reset_index(drop=True)
        d['symbol_id'] = sym
        parts.append((sym, d))
    print(f"Loaded {len(parts)} symbol CSVs")

    print("\nFetching daily candles from D1 + computing forward windows...")
    augmented = []
    for i, (sym, d) in enumerate(parts):
        daily = fetch_daily(sym)
        d = compute_horizon_targets(d, daily, horizons)
        augmented.append(d)
        if (i + 1) % 20 == 0 or i + 1 == len(parts):
            print(f"  [{i+1}/{len(parts)}] processed")

    data = pd.concat(augmented, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    print(f"\nTotal rows: {len(data)}")

    # Drop rows missing the longest horizon (end of training period — no forward data)
    data = data[data['fwdMaxFavR_20d'].notna()].copy()
    print(f"After dropping rows without 20d forward window: {len(data)}")

    # Define targets at multiple ATR thresholds per horizon
    print("\nDefining targets...")
    target_configs: list[tuple[str, float]] = []
    for h in horizons:
        col = f'fwdMaxFavR_{h}d'
        for thr in [1.0, 1.5, 2.0, 3.0, 4.0]:
            target_name = f'goodR_{h}d_{thr}atr'
            data[target_name] = (data[col] >= thr).astype(int)
            target_configs.append((target_name, thr))

    # Also keep the original 24h goodR (1.5 ATR) as the reference baseline
    if 'fwdMaxFavR' in data.columns:
        data['goodR_24h_orig'] = (data['fwdMaxFavR'] >= 1.5).astype(int)

    # Run WF for each. Drop targets that have <15% or >85% positive class (no skill ceiling).
    print("\n" + "=" * 80)
    print(f"WF accuracy on each target (XGBoost d5 t100, 111 features)")
    print("=" * 80)
    print(f"{'Target':<28} {'Class %':>10} {'WF acc':>10} {'Skill':>10} {'Top bucket':>12} {'Top n':>10}")
    print("-" * 80)

    # Reference baseline: original 24h
    ref = walk_forward_with_target(data, lambda: make_xgb(5, 100), target_col='goodR_24h_orig')
    if ref:
        acc, top, top_n, balance = ref
        majority = max(balance, 1 - balance)
        skill = acc - majority
        print(f"{'goodR_24h_orig (v12)':<28} {balance*100:>9.1f}% {acc*100:>9.2f}% {skill*100:>+9.2f}pp {top*100:>10.1f}% {top_n:>10}")

    print("-" * 80)
    results = []
    for target_name, _thr in target_configs:
        balance = data[target_name].mean()
        if balance < 0.15 or balance > 0.85:
            print(f"{target_name:<28} {balance*100:>9.1f}% {'(class skew, skip)':>30}")
            continue
        r = walk_forward_with_target(data, lambda: make_xgb(5, 100), target_col=target_name)
        if r is None:
            continue
        acc, top, top_n, _ = r
        majority = max(balance, 1 - balance)
        skill = acc - majority
        results.append((target_name, balance, acc, skill, top, top_n))
        print(f"{target_name:<28} {balance*100:>9.1f}% {acc*100:>9.2f}% {skill*100:>+9.2f}pp {top*100:>10.1f}% {top_n:>10}")

    # Sort by skill, show best 5
    print("\n" + "=" * 80)
    print("RANKED BY SKILL (above majority-class baseline)")
    print("=" * 80)
    results.sort(key=lambda r: r[3], reverse=True)
    for i, (name, bal, acc, skill, top, top_n) in enumerate(results[:8]):
        marker = " ← v12 reference at +13.17pp skill, 75.7% top bucket" if name == 'goodR_24h_1.5atr' else ""
        print(f"  {i+1}. {name:<26} skill={skill*100:>+6.2f}pp  WF={acc*100:>5.2f}%  top={top*100:>4.1f}% (n={top_n}){marker}")


if __name__ == '__main__':
    main()
