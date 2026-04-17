"""
Download FINRA RegSHO daily short sale volume files and extract dark pool features
for ML training.

Downloads daily files from cdn.finra.org, filters to our stock symbols, computes:
  - shortVolumeRatio: ShortVolume / TotalVolume (typically 0.4-0.6)
  - shortVolumeZScore: (ratio - 20d mean) / 20d std — anomaly detection

Output: ml-training/dark_pool_history.json
  { "AAPL": [{"date": "2020-01-02", "ratio": 0.45, "zscore": -0.3}, ...], ... }

Usage:
    python3 ml-training/finra_dark_pool.py
"""

import json
import os
import sys
from datetime import datetime, timedelta
from collections import defaultdict
import urllib.request
import time

OUTPUT = '/Users/bojanmihovilovic/CryptoLens/ml-training/dark_pool_history.json'
CACHE_DIR = '/Volumes/External/Downloads/finra_cache'

STOCK_SYMBOLS = {
    'AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN',
    'CRM', 'NFLX', 'AMD', 'ORCL', 'ADBE', 'INTC', 'CSCO',
    'AVGO', 'QCOM', 'MU', 'AMAT', 'LRCX', 'MRVL',
    'PLTR', 'ROKU', 'SHOP', 'SQ', 'SNAP', 'COIN', 'RBLX',
    'BYND', 'GME',
    'JPM', 'GS', 'MS', 'BAC', 'WFC', 'BLK', 'SCHW',
    'UNH', 'LLY', 'ABBV', 'JNJ', 'PFE', 'MRK', 'TMO',
    'REGN', 'VRTX', 'GILD', 'BIIB',
    'HD', 'MA', 'V', 'DIS', 'NKE', 'SBUX', 'MCD', 'WMT', 'COST',
    'CAT', 'DE', 'X', 'BA',
    'XOM', 'OXY', 'FANG', 'CVX', 'SLB',
    'LMT', 'RTX', 'GD',
    'UNP', 'FDX', 'DAL',
    'T', 'VZ', 'CMCSA',
    'SPG', 'O',
    'SPY', 'QQQ', 'IWM', 'XLE', 'XLF', 'XLK', 'XLV', 'GLD', 'TLT',
}

START_DATE = datetime(2020, 1, 2)


def trading_days(start, end):
    """Generate weekday dates between start and end."""
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def download_file(date_str):
    """Download FINRA short volume file for a date. Returns lines or None."""
    cache_path = os.path.join(CACHE_DIR, f'{date_str}.txt')
    if os.path.exists(cache_path):
        with open(cache_path, 'r') as f:
            return f.readlines()

    url = f'https://cdn.finra.org/equity/regsho/daily/CNMSshvol{date_str}.txt'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read().decode('utf-8')
            with open(cache_path, 'w') as f:
                f.write(data)
            return data.splitlines()
    except Exception:
        return None


def parse_file(lines, date_str):
    """Parse FINRA file, return {symbol: (shortVol, totalVol)} for our symbols."""
    result = {}
    for line in lines:
        if line.startswith('Date') or not line.strip():
            continue
        parts = line.strip().split('|')
        if len(parts) < 5:
            continue
        sym = parts[1]
        if sym not in STOCK_SYMBOLS:
            continue
        try:
            short_vol = float(parts[2])
            total_vol = float(parts[4])
            if total_vol > 0:
                result[sym] = (short_vol, total_vol)
        except (ValueError, IndexError):
            continue
    return result


def compute_zscores(raw_data):
    """Compute rolling 20-day Z-score of short volume ratio per symbol.
    raw_data: {symbol: [(date_str, ratio), ...]} sorted by date.
    Returns {symbol: [(date_str, ratio, zscore), ...]}.
    """
    result = {}
    for sym, entries in raw_data.items():
        out = []
        window = []
        for date_str, ratio in entries:
            window.append(ratio)
            if len(window) > 20:
                window.pop(0)
            if len(window) >= 5:
                mean = sum(window) / len(window)
                std = (sum((x - mean) ** 2 for x in window) / len(window)) ** 0.5
                z = (ratio - mean) / std if std > 0.001 else 0.0
            else:
                z = 0.0
            out.append((date_str, round(ratio, 6), round(z, 4)))
        result[sym] = out
    return result


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)

    end_date = datetime.now() - timedelta(days=1)
    dates = list(trading_days(START_DATE, end_date))
    print(f"Downloading {len(dates)} trading days of FINRA data...")
    print(f"Cache dir: {CACHE_DIR}")

    # Collect raw ratios per symbol
    raw_data = defaultdict(list)
    downloaded = 0
    skipped = 0

    for i, d in enumerate(dates):
        date_str = d.strftime('%Y%m%d')
        if i % 100 == 0:
            print(f"  [{i}/{len(dates)}] {date_str}...")

        lines = download_file(date_str)
        if lines is None:
            skipped += 1
            continue

        parsed = parse_file(lines, date_str)
        date_iso = d.strftime('%Y-%m-%d')
        for sym, (short_vol, total_vol) in parsed.items():
            ratio = short_vol / total_vol
            raw_data[sym].append((date_iso, ratio))
        downloaded += 1

        # Rate limit: ~5 req/sec for fresh downloads
        cache_path = os.path.join(CACHE_DIR, f'{date_str}.txt')
        if not os.path.exists(cache_path):
            time.sleep(0.2)

    print(f"\nDownloaded: {downloaded}, skipped (holidays): {skipped}")
    print(f"Symbols with data: {len(raw_data)}")

    # Compute Z-scores
    scored = compute_zscores(raw_data)

    # Build output
    output = {}
    for sym in sorted(scored.keys()):
        entries = scored[sym]
        output[sym] = [{'date': d, 'ratio': r, 'zscore': z} for d, r, z in entries]
        print(f"  {sym:6s}: {len(entries):4d} days, "
              f"ratio mean={sum(e[1] for e in entries)/len(entries):.3f}, "
              f"zscore range=[{min(e[2] for e in entries):.2f}, {max(e[2] for e in entries):.2f}]")

    with open(OUTPUT, 'w') as f:
        json.dump(output, f)
    print(f"\nWrote {OUTPUT} ({os.path.getsize(OUTPUT) / 1024 / 1024:.1f} MB)")


if __name__ == '__main__':
    main()
