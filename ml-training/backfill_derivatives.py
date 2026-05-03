"""
One-time backfill of 1 year of derivatives history into D1 from Binance fapi.

Without this, the worker cron has only been accumulating since 2026-04-13
(~20 days) for 31 of 76 crypto symbols. Backfilling now gives ~1.5 years
of training data by November (1y backfill + 0.5y live) vs ~0.5y waiting.

Endpoints hit (all paginated 4H buckets):
  - /fapi/v1/fundingRate           → funding_rate
  - /futures/data/openInterestHist → open_interest
  - /futures/data/globalLongShortAccountRatio → long_percent
  - /futures/data/topLongShortPositionRatio   → top_trader_long_pct
  - /futures/data/takerlongshortRatio → taker_ratio + taker_buy_vol + taker_sell_vol

NULL columns (no Binance historical):
  - mark_price, index_price, basis_pct  → only available as live snapshot
  - large_buy_vol/sell_vol/count        → would require order-book replay
  Going forward, the cron fills these.

Output: /tmp/derivatives_backfill.sql containing INSERT OR REPLACE statements.
Then: wrangler d1 execute marketscope-db --remote --file=/tmp/derivatives_backfill.sql

Usage:
  python3 ml-training/backfill_derivatives.py
"""

import json
import sys
import time
import urllib.request
import urllib.error
from collections import defaultdict
from datetime import datetime, timezone, timedelta

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

FAPI = 'https://fapi.binance.com'
SQL_PATH = '/tmp/derivatives_backfill.sql'
LOOKBACK_DAYS = 365
LIMIT = 500  # Binance max per call for most endpoints

# 4H bucket size in ms
BUCKET_MS = 4 * 3600 * 1000


def http_get(url: str, retries: int = 3) -> list | dict | None:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            return None
        except Exception:
            if attempt < retries - 1:
                time.sleep(2)
                continue
            return None
    return None


def bucket_4h(ts_ms: int) -> int:
    """Snap a millisecond timestamp to its 4H bucket start (in seconds)."""
    bucket_start_ms = (ts_ms // BUCKET_MS) * BUCKET_MS
    return bucket_start_ms // 1000


def fetch_paginated(symbol: str, base_path: str, period_param: str = 'period=4h',
                    extra_params: str = '', value_field: str = None) -> list[dict]:
    """Fetch a Binance fapi endpoint paginated across LOOKBACK_DAYS.
    Returns list of {'time': ms, ... raw fields ...}."""
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - LOOKBACK_DAYS * 86400 * 1000
    out: list[dict] = []
    cur_end = end_ms
    while cur_end > start_ms:
        url = f"{FAPI}{base_path}?symbol={symbol}&{period_param}&endTime={cur_end}&limit={LIMIT}{extra_params}"
        data = http_get(url)
        if not data:
            break
        if not isinstance(data, list):
            break
        if not data:
            break
        out.extend(data)
        # Walk back to before the earliest timestamp returned
        earliest = min(int(d.get('timestamp', d.get('fundingTime', 0))) for d in data)
        if earliest >= cur_end:
            break  # no progress
        cur_end = earliest - 1
        time.sleep(0.05)  # gentle pacing
        if len(data) < LIMIT:
            break  # last page
    return out


def fetch_funding_rate(symbol: str) -> dict[int, float]:
    """funding_rate is published every 8H, not 4H. Snap to 4H bucket; multiple
    fundings per bucket get averaged."""
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - LOOKBACK_DAYS * 86400 * 1000
    out: dict[int, list[float]] = defaultdict(list)
    cur_start = start_ms
    while cur_start < end_ms:
        url = f"{FAPI}/fapi/v1/fundingRate?symbol={symbol}&startTime={cur_start}&limit=1000"
        data = http_get(url)
        if not data or not isinstance(data, list) or not data:
            break
        for d in data:
            ts = int(d['fundingTime'])
            rate = float(d['fundingRate'])
            out[bucket_4h(ts)].append(rate)
        last_ts = max(int(d['fundingTime']) for d in data)
        if last_ts <= cur_start:
            break
        cur_start = last_ts + 1
        time.sleep(0.05)
        if len(data) < 1000:
            break
    return {bucket: sum(rates) / len(rates) for bucket, rates in out.items()}


def main():
    print(f"Backfilling {len(CRYPTO_SYMBOLS)} crypto symbols, lookback {LOOKBACK_DAYS}d")
    # bucket_ts_sec → fields-dict for each (symbol, bucket)
    rows: dict[str, dict[int, dict]] = {}

    for i, base_sym in enumerate(CRYPTO_SYMBOLS):
        symbol = f"{base_sym}USDT"
        per_symbol: dict[int, dict] = defaultdict(lambda: {
            'funding_rate': None, 'open_interest': None, 'long_percent': None,
            'taker_ratio': None, 'top_trader_long_pct': None,
            'taker_buy_vol': None, 'taker_sell_vol': None,
        })

        # 1) funding rate (special — 8H cadence)
        fr_map = fetch_funding_rate(symbol)
        for bucket, rate in fr_map.items():
            per_symbol[bucket]['funding_rate'] = rate

        # 2) open interest history (4H buckets)
        oi = fetch_paginated(symbol, '/futures/data/openInterestHist')
        for d in oi:
            ts = bucket_4h(int(d['timestamp']))
            try:
                per_symbol[ts]['open_interest'] = float(d.get('sumOpenInterestValue') or d.get('sumOpenInterest') or 0)
            except (TypeError, ValueError):
                pass

        # 3) global long/short account ratio (4H)
        gls = fetch_paginated(symbol, '/futures/data/globalLongShortAccountRatio')
        for d in gls:
            ts = bucket_4h(int(d['timestamp']))
            try:
                per_symbol[ts]['long_percent'] = float(d['longAccount']) * 100  # store as %
            except (KeyError, TypeError, ValueError):
                pass

        # 4) top trader long/short position ratio (4H) — smart money
        tt = fetch_paginated(symbol, '/futures/data/topLongShortPositionRatio')
        for d in tt:
            ts = bucket_4h(int(d['timestamp']))
            try:
                per_symbol[ts]['top_trader_long_pct'] = float(d['longAccount']) * 100
            except (KeyError, TypeError, ValueError):
                pass

        # 5) taker buy/sell volume + ratio (4H)
        tk = fetch_paginated(symbol, '/futures/data/takerlongshortRatio')
        for d in tk:
            ts = bucket_4h(int(d['timestamp']))
            try:
                per_symbol[ts]['taker_ratio'] = float(d['buySellRatio'])
                per_symbol[ts]['taker_buy_vol'] = float(d['buyVol'])
                per_symbol[ts]['taker_sell_vol'] = float(d['sellVol'])
            except (KeyError, TypeError, ValueError):
                pass

        rows[symbol] = dict(per_symbol)
        non_null = sum(1 for v in per_symbol.values() if any(x is not None for x in v.values()))
        print(f"  [{i+1}/{len(CRYPTO_SYMBOLS)}] {symbol:>12s}: {len(per_symbol)} buckets, {non_null} with data")

    # Write SQL
    print(f"\nWriting SQL → {SQL_PATH}")
    total_inserts = 0
    with open(SQL_PATH, 'w') as f:
        for symbol, buckets in rows.items():
            for ts, fields in sorted(buckets.items()):
                # Only insert if at least one field has data
                if all(v is None for v in fields.values()):
                    continue
                # NULL-safe SQL formatting
                def sv(v):
                    return 'NULL' if v is None else f"{v:.10g}"
                f.write(
                    f"INSERT OR REPLACE INTO derivatives_history "
                    f"(symbol, timestamp, funding_rate, open_interest, long_percent, taker_ratio, "
                    f"top_trader_long_pct, taker_buy_vol, taker_sell_vol) VALUES "
                    f"('{symbol}', {ts}, {sv(fields['funding_rate'])}, {sv(fields['open_interest'])}, "
                    f"{sv(fields['long_percent'])}, {sv(fields['taker_ratio'])}, "
                    f"{sv(fields['top_trader_long_pct'])}, {sv(fields['taker_buy_vol'])}, {sv(fields['taker_sell_vol'])});\n"
                )
                total_inserts += 1

    print(f"  {total_inserts} INSERT statements written.")
    print(f"\nNext step:")
    print(f"  wrangler d1 execute marketscope-db --remote --file={SQL_PATH}")


if __name__ == '__main__':
    main()
