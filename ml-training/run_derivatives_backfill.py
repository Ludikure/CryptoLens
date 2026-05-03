"""
Orchestrator: hit /debug/backfill-derivatives once per crypto symbol via the deployed worker.
Worker reaches Binance from non-US Cloudflare edge, fetches + inserts D1 directly.

What gets backfilled:
  - funding_rate: 1 year of history (Binance has full history on /fapi/v1/fundingRate)
  - open_interest, top_trader_long_pct, taker_buy_vol, taker_sell_vol, long_percent,
    taker_ratio: only last ~30 days (Binance /futures/data/* endpoints don't expose
    older history). Going forward the cron keeps these fresh for all 76 symbols.

Per-symbol call takes ~30-60s on the worker. 76 symbols sequential = ~30-60 min.
"""

import json
import time
import urllib.request

WORKER_URL = "https://marketscope-proxy.ludikure.workers.dev"
DAYS = 365

CRYPTO_SYMBOLS = [
    'BTC', 'ETH', 'BCH', 'XRP', 'LTC', 'TRX', 'ETC', 'LINK', 'XLM', 'ADA',
    'XMR', 'DASH', 'ZEC', 'XTZ', 'BNB', 'ATOM', 'ONT', 'IOTA', 'BAT', 'VET',
    'NEO', 'QTUM', 'IOST', 'THETA', 'ALGO', 'ZIL', 'KNC', 'ZRX', 'COMP', 'DOGE',
    'KAVA', 'BAND', 'RLC', 'SNX', 'DOT', 'YFI', 'CRV', 'TRB', 'RUNE', 'SUSHI',
    'EGLD', 'SOL', 'ICX', 'STORJ', 'UNI', 'AVAX', 'ENJ', 'KSM', 'NEAR', 'AAVE',
    'FIL', 'RSR', 'BEL', 'AXS', 'SKL', 'GRT',
    'SAND', 'MANA', 'HBAR', 'MATIC', 'ICP', 'DYDX', 'GALA',
    'IMX', 'GMT', 'APE', 'INJ', 'LDO', 'APT',
    'ARB', 'SUI', 'PENDLE', 'SEI', 'TIA', 'JUP', 'PEPE',
]


def main():
    total_inserted = 0
    failures = []
    start = time.time()
    for i, base in enumerate(CRYPTO_SYMBOLS):
        symbol = f"{base}USDT"
        url = f"{WORKER_URL}/debug/backfill-derivatives?symbol={symbol}&days={DAYS}"
        req = urllib.request.Request(url, headers={
            'X-App-ID': 'marketscope-ios',
            'User-Agent': 'Mozilla/5.0',
        })
        sym_start = time.time()
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            elapsed = time.time() - sym_start
            inserted = data.get('inserted', 0)
            buckets = data.get('buckets_total', 0)
            total_inserted += inserted
            print(f"[{i+1:>2}/{len(CRYPTO_SYMBOLS)}] {symbol:<14s} buckets={buckets:>4} inserted={inserted:>4} ({elapsed:.0f}s)")
        except Exception as e:
            print(f"[{i+1:>2}/{len(CRYPTO_SYMBOLS)}] {symbol:<14s} ERROR: {e}")
            failures.append(symbol)
    total_elapsed = time.time() - start
    print(f"\nDONE in {total_elapsed/60:.1f} min. Total inserted: {total_inserted}. Failures: {len(failures)}")
    if failures:
        print(f"Failed: {failures}")


if __name__ == '__main__':
    main()
