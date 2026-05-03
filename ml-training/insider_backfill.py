"""
Backfill historical Form 4 insider transactions from Finnhub for all stock symbols.

Free tier returns 6+ years with explicit from/to dates (verified). 159 symbols × 1 call =
~3 min wall clock at the 60-call/min rate limit.

Output: ml-training/insider_history.json — symbol → array of raw Finnhub tx records.
Feature computation (rolling 30d/90d/180d aggregates) happens at training time so we
don't bake fixed windows into the bundled artifact.

Usage:
    python3 ml-training/insider_backfill.py
"""

import json
import os
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

# Use the deployed worker as our Finnhub proxy (handles auth + caching).
# Worker version 20e5992d (deployed 2026-05-03) supports from/to passthrough.
WORKER_URL = "https://marketscope-proxy.ludikure.workers.dev"
FROM_DATE = "2020-01-01"
TO_DATE = datetime.now(timezone.utc).strftime("%Y-%m-%d")
OUT_PATH = "/Users/bojanmihovilovic/CryptoLens/ml-training/insider_history.json"
RATE_LIMIT_DELAY_SEC = 1.1  # Finnhub free tier: 60 req/min, plus a touch of margin

STOCK_SYMBOLS = [
    'AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'CRM', 'NFLX', 'AMD',
    'ORCL', 'ADBE', 'INTC', 'CSCO',
    'NOW', 'INTU', 'CRWD', 'PANW', 'FTNT', 'SNOW', 'DDOG', 'NET', 'ZS', 'WDAY', 'TEAM', 'MDB',
    'AVGO', 'QCOM', 'MU', 'AMAT', 'LRCX', 'MRVL', 'TXN', 'KLAC', 'ON', 'MCHP',
    'PLTR', 'ROKU', 'SHOP', 'SNAP', 'COIN', 'RBLX',
    'BYND', 'GME',
    'UBER', 'ABNB', 'BKNG', 'DASH', 'PYPL', 'SPOT', 'F', 'GM',
    'JPM', 'GS', 'MS', 'BAC', 'WFC', 'BLK', 'SCHW',
    'AXP', 'C', 'COF', 'USB', 'PNC', 'CME', 'ICE', 'AIG',
    'UNH', 'LLY', 'ABBV', 'JNJ', 'PFE', 'MRK', 'TMO',
    'AMGN', 'BMY', 'ABT', 'MDT', 'DHR', 'ISRG', 'BSX', 'SYK', 'CVS', 'ELV',
    'REGN', 'VRTX', 'GILD', 'BIIB',
    'HD', 'MA', 'V', 'DIS', 'NKE', 'SBUX', 'MCD', 'WMT', 'COST',
    'LOW', 'TGT', 'TJX', 'CMG', 'MAR', 'HLT', 'MGM',
    'CAT', 'DE', 'BA',
    'HON', 'MMM', 'GE', 'EMR', 'ETN', 'ITW', 'PH',
    'XOM', 'OXY', 'FANG', 'CVX', 'SLB',
    'COP', 'EOG', 'PSX', 'VLO',
    'LMT', 'RTX', 'GD', 'NOC',
    'UNP', 'FDX', 'DAL',
    'T', 'VZ', 'CMCSA', 'TMUS', 'CHTR',
    'SPG', 'O',
    'AMT', 'EQIX', 'PLD', 'CCI', 'PSA',
    'SPY', 'QQQ', 'IWM', 'XLE', 'XLF', 'XLK', 'XLV', 'GLD', 'TLT',
    'DIA', 'XLY', 'XLP', 'XLI', 'XLU', 'XLC', 'HYG', 'VXX',
]


def fetch_insider(symbol: str) -> list[dict]:
    url = (f"{WORKER_URL}/finnhub/insider"
           f"?symbol={symbol}&from={FROM_DATE}&to={TO_DATE}")
    # Cloudflare WAF blocks the default Python-urllib User-Agent (error code 1010).
    # Use a normal browser UA to pass the bot-detection filter. The X-App-ID still gates worker auth.
    req = urllib.request.Request(url, headers={
        'X-App-ID': 'marketscope-ios',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                return data.get('data', [])
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                print(f"  rate limited, sleeping 30s...")
                time.sleep(30)
                continue
            print(f"  HTTP {e.code}: {e.reason}")
            return []
        except Exception as e:
            if attempt < 2:
                time.sleep(2)
                continue
            print(f"  error: {e}")
            return []
    return []


def main():
    print(f"Backfilling {len(STOCK_SYMBOLS)} symbols, window {FROM_DATE} → {TO_DATE}")
    out: dict[str, list[dict]] = {}
    total_tx = 0
    for i, sym in enumerate(STOCK_SYMBOLS):
        txs = fetch_insider(sym)
        out[sym] = txs
        total_tx += len(txs)
        # Quick sanity from the response
        if txs:
            dates = [t.get('transactionDate', '?') for t in txs]
            d_min, d_max = min(dates), max(dates)
            print(f"[{i+1:>3}/{len(STOCK_SYMBOLS)}] {sym:6s}: {len(txs):>4} txs, {d_min} → {d_max}")
        else:
            print(f"[{i+1:>3}/{len(STOCK_SYMBOLS)}] {sym:6s}: 0 txs (empty or error)")
        time.sleep(RATE_LIMIT_DELAY_SEC)

    with open(OUT_PATH, 'w') as f:
        json.dump(out, f)

    size_mb = os.path.getsize(OUT_PATH) / 1024 / 1024
    print(f"\nDONE. {len(out)} symbols, {total_tx} total transactions, {size_mb:.1f} MB → {OUT_PATH}")


if __name__ == '__main__':
    main()
