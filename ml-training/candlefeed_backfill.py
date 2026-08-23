#!/usr/bin/env python3
"""Backfill CandleFeed derivatives history — including the liquidation events Binance never published.

WHY THIS EXISTS: our own websocket collector captured nothing between 2026-07-10 and 2026-08-22
(it dialed from the box's US IP, which Binance accepts and then serves no data to). Binance
publishes no liquidation archive — verified: no `liquidationSnapshot` on data.binance.vision in
daily or monthly, empty listing where an aggTrades control returns real keys, direct fetch 404s.
BUT third parties captured the same public stream all along, so the record exists even though the
source doesn't serve it. CandleFeed's tick-level Binance liquidations start March 2026, which
covers our entire gap.

HONEST LIMITS, so nothing downstream over-claims:
  - Tick-level CEX liquidations come from the SAME public stream, which Binance has capped at one
    event per second per symbol since 2021. This is a SAMPLE and every sum is a lower bound —
    identical to what our own collector would have produced. Coinglass shares the cap too.
  - Aggregated history is deep (Binance 2019 daily) but finer buckets are shallow: 12h from 2024,
    4h/6h/8h from 2025, 1h from late 2025. Use interval=1d for multi-year work.

DISCIPLINE: this only ACQUIRES. Any hypothesis it enables (cascade asymmetry, heatmap validation)
gets a pre-declared design in docs/research/ BEFORE measurement — see news-catalyst-test.md for
the pattern, and rejected-hypotheses.md for the cost of skipping it.

Setup:  export CANDLEFEED_API_KEY=...        (Builder tier or above for liquidations)
Usage:
  python3 candlefeed_backfill.py liquidations --symbols BTCUSDT,ETHUSDT --start 2026-03-01
  python3 candlefeed_backfill.py liquidations/aggregated --symbols BTCUSDT --start 2019-01-01 --interval 1d
  python3 candlefeed_backfill.py open-interest --symbols BTCUSDT --start 2020-01-01 --interval 1h
  python3 candlefeed_backfill.py --plan          # show the call budget for a full pull, fetch nothing

Resumable: each (dataset, symbol) writes one CSV and the run continues from the newest row it
already holds, so an interrupted or rate-limited run picks up where it stopped.
"""
import argparse
import csv
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://api.candlefeed.io/v1"
OUT_ROOT = Path(__file__).parent / "candlefeed"
KEY = os.environ.get("CANDLEFEED_API_KEY", "")
# Builder tier is 1,000 calls/day. Stop short of it so a long backfill never trips the limit and
# leaves a half-written day — the script is resumable, so stopping early is free.
DAILY_CALL_BUDGET = int(os.environ.get("CANDLEFEED_CALL_BUDGET", "900"))
PAGE_LIMIT = 1000
DELAY_S = 0.25

DATASETS = ["liquidations", "liquidations/aggregated", "open-interest", "funding-rates",
            "long-short-ratio", "taker-volume", "candles"]

calls_made = 0


def get(path: str, params: dict) -> dict:
    """One API call, with retry on transient failures. Counts against the daily budget."""
    global calls_made
    if calls_made >= DAILY_CALL_BUDGET:
        raise SystemExit(f"\nreached the {DAILY_CALL_BUDGET}-call budget — rerun tomorrow, it resumes where it stopped")
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    req = urllib.request.Request(f"{BASE}/{path}?{qs}", headers={
        "X-API-Key": KEY, "Accept": "application/json", "User-Agent": "MarketScope/1.0 (research)",
    })
    for attempt in range(4):
        try:
            calls_made += 1
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:200]
            if e.code in (401, 403):
                raise SystemExit(f"auth/tier error {e.code}: {body}\n"
                                 f"(liquidations need Builder tier or above; free tier is OHLCV + funding only)")
            if e.code == 429:
                wait = 5 * (attempt + 1)
                print(f"    rate-limited, sleeping {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            if attempt == 3:
                raise SystemExit(f"HTTP {e.code}: {body}")
            time.sleep(2 * (attempt + 1))
        except Exception as e:
            if attempt == 3:
                raise SystemExit(f"request failed: {e}")
            time.sleep(2 * (attempt + 1))
    return {}


def rows_of(payload) -> list:
    """Tolerate the common envelope shapes rather than assuming one."""
    if isinstance(payload, list):
        return payload
    for k in ("data", "results", "items", "liquidations", "candles"):
        v = payload.get(k)
        if isinstance(v, list):
            return v
    return []


def last_ts(path: Path):
    """Newest timestamp already stored, so the run resumes instead of refetching."""
    if not path.exists() or path.stat().st_size == 0:
        return None
    last = None
    with path.open() as f:
        for line in f:
            last = line
    if not last:
        return None
    try:
        return int(float(last.split(",", 1)[0]))
    except ValueError:
        return None


def backfill(dataset: str, symbol: str, start_ms: int, end_ms: int, interval):
    out_dir = OUT_ROOT / dataset.replace("/", "_")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{symbol}.csv"
    cursor = last_ts(out)
    if cursor:
        print(f"  {symbol}: resuming from {dt.datetime.utcfromtimestamp(cursor/1000):%Y-%m-%d %H:%M}")
        start_ms = cursor + 1
    total, header = 0, None
    t0 = time.time()
    with out.open("a", newline="") as f:
        w = csv.writer(f)
        while start_ms < end_ms:
            payload = get(dataset, {"symbol": symbol, "exchange": "binance", "interval": interval,
                                    "start": start_ms, "end": end_ms, "limit": PAGE_LIMIT})
            rows = rows_of(payload)
            if not rows:
                break
            if header is None and isinstance(rows[0], dict):
                header = list(rows[0].keys())
            newest = start_ms
            for r in rows:
                if isinstance(r, dict):
                    vals = [r.get(k) for k in header]
                    ts = r.get("timestamp") or r.get("time") or r.get("t") or vals[0]
                else:
                    vals, ts = r, r[0]
                try:
                    newest = max(newest, int(float(ts)))
                except (TypeError, ValueError):
                    pass
                w.writerow(vals)
                total += 1
            f.flush()
            if len(rows) < PAGE_LIMIT:
                break
            if newest <= start_ms:      # no forward progress — stop rather than loop forever
                break
            start_ms = newest + 1
            time.sleep(DELAY_S)
    mb = out.stat().st_size / 1e6
    print(f"  {symbol}: +{total:,} rows -> {mb:.1f}MB  [{time.time()-t0:.0f}s, {calls_made} calls used]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", nargs="?", choices=DATASETS)
    ap.add_argument("--symbols", default="BTCUSDT,ETHUSDT")
    ap.add_argument("--start", default="2026-03-01")
    ap.add_argument("--end", default=dt.date.today().isoformat())
    ap.add_argument("--interval", default=None, help="e.g. 1d for aggregated, 1h for OI; omit for tick data")
    ap.add_argument("--plan", action="store_true", help="print the call budget and exit without fetching")
    a = ap.parse_args()

    syms = [s.strip().upper() for s in a.symbols.split(",") if s.strip()]
    if a.plan:
        print("Call budget guide (Builder = 1,000/day):")
        print("  tick liquidations, 1 symbol, Mar->Aug 2026 : ~50-300 calls depending on event density")
        print("  aggregated 1d, 1 symbol, 2019->now         : ~3 calls (2,400 rows at 1,000/page)")
        print("  open-interest 1h, 1 symbol, 2020->now       : ~50 calls")
        print("\nSo a full pull for ~10 majors is comfortably inside one day for the aggregated and")
        print("OI series; tick liquidations are the expensive one — run them symbol by symbol.")
        return
    if not a.dataset:
        raise SystemExit("pick a dataset (or use --plan). Options: " + ", ".join(DATASETS))
    if not KEY:
        raise SystemExit("set CANDLEFEED_API_KEY first")

    to_ms = lambda d: int(dt.datetime.fromisoformat(d).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    print(f"{a.dataset}: {len(syms)} symbol(s), {a.start} -> {a.end}"
          + (f", interval={a.interval}" if a.interval else " (tick)"))
    for s in syms:
        backfill(a.dataset, s, to_ms(a.start), to_ms(a.end), a.interval)
    print(f"\ndone — {calls_made} API calls used of the {DAILY_CALL_BUDGET} budget")


if __name__ == "__main__":
    main()
