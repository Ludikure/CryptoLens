"""
Download historical premium index (basis) data from data.binance.vision.
Merges with existing backtest CSVs to add basisPct and basisExtreme features.
"""

import os
import io
import csv
import zipfile
import requests
import pandas as pd
from datetime import datetime

DOWNLOADS = '/Users/bojanmihovilovic/Downloads'
SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT',
           'LINKUSDT', 'AVAXUSDT', 'DOTUSDT', 'NEARUSDT']
BASE_URL = 'https://data.binance.vision/data/futures/um/monthly/premiumIndexKlines'


def download_premium_index(symbol: str) -> pd.DataFrame:
    """Download all monthly premium index 4H CSVs for a symbol."""
    all_rows = []
    year, month = 2020, 1
    now = datetime.now()

    while True:
        if year > now.year or (year == now.year and month > now.month):
            break

        url = f"{BASE_URL}/{symbol}/4h/{symbol}-4h-{year:04d}-{month:02d}.zip"
        try:
            resp = requests.get(url, timeout=10)
            if resp.status_code != 200:
                print(f"  {symbol} {year}-{month:02d}: HTTP {resp.status_code}")
                month += 1
                if month > 12:
                    month = 1; year += 1
                continue

            zf = zipfile.ZipFile(io.BytesIO(resp.content))
            for name in zf.namelist():
                if name.endswith('.csv'):
                    with zf.open(name) as f:
                        reader = csv.reader(io.TextIOWrapper(f))
                        header = next(reader)
                        for row in reader:
                            ts = int(row[0]) // 1000  # ms to seconds
                            close = float(row[4])  # premium index close = basis ratio
                            all_rows.append({'timestamp': ts, 'basisPct': close * 100})
        except Exception as e:
            print(f"  {symbol} {year}-{month:02d}: {e}")

        month += 1
        if month > 12:
            month = 1; year += 1

    df = pd.DataFrame(all_rows)
    if not df.empty:
        df = df.sort_values('timestamp').drop_duplicates('timestamp')
    print(f"  {symbol}: {len(df)} premium index bars ({df['timestamp'].min() if len(df) else 'N/A'} to {df['timestamp'].max() if len(df) else 'N/A'})")
    return df


def merge_basis_into_csv(symbol: str, basis_df: pd.DataFrame):
    """Merge basis data into existing backtest CSV."""
    csv_path = f"{DOWNLOADS}/{symbol}.csv"
    if not os.path.exists(csv_path):
        print(f"  {symbol}: CSV not found, skipping")
        return

    df = pd.read_csv(csv_path)
    original_cols = len(df.columns)

    # Round timestamps to 4H boundaries for matching
    def round_4h(ts):
        return (ts // 14400) * 14400

    df['_ts4h'] = df['timestamp'].apply(round_4h)
    basis_df = basis_df.copy()
    basis_df['_ts4h'] = basis_df['timestamp'].apply(round_4h)
    basis_lookup = basis_df.set_index('_ts4h')['basisPct'].to_dict()

    # Add basis features
    df['basisPct'] = df['_ts4h'].map(basis_lookup).fillna(0)
    df['basisExtreme'] = df['basisPct'].apply(
        lambda x: 1 if x > 0.5 else (-1 if x < -0.5 else 0))

    df = df.drop(columns=['_ts4h'])

    # Save
    df.to_csv(csv_path, index=False)
    matched = (df['basisPct'] != 0).sum()
    print(f"  {symbol}: {matched}/{len(df)} bars matched ({matched/len(df)*100:.0f}%), cols {original_cols} -> {len(df.columns)}")


if __name__ == '__main__':
    for symbol in SYMBOLS:
        print(f"\n=== {symbol} ===")
        basis = download_premium_index(symbol)
        if not basis.empty:
            merge_basis_into_csv(symbol, basis)
        else:
            print(f"  No basis data for {symbol}")

    print("\nDone. CSVs updated with basisPct and basisExtreme columns.")
