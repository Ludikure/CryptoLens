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

Setup (either one; the file keeps the key out of shell history and out of chat transcripts):
        echo 'YOUR_KEY' > ml-training/.candlefeed_key      # gitignored
        export CANDLEFEED_API_KEY=...                       # Builder tier or above for liquidations
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

# NB: the docs print api.candlefeed.io — that host has no DNS record at all. The live
# API is api.candlefeed.ai (verified: resolves, returns a proper 401 envelope without a key).
BASE = "https://api.candlefeed.ai/v1"
OUT_ROOT = Path(__file__).parent / "candlefeed"
def _load_key() -> str:
    """Env var first, then a gitignored key file.

    The file path exists so the key never has to be pasted into a chat or a shell history: write
    it once with `echo 'KEY' > ml-training/.candlefeed_key` and nothing downstream ever echoes it.
    """
    v = os.environ.get("CANDLEFEED_API_KEY", "").strip()
    if v:
        return v
    f = Path(__file__).parent / ".candlefeed_key"
    if f.exists():
        return f.read_text().strip()
    return ""


KEY = _load_key()
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


def to_dt(v):
    """Parse a timestamp that may arrive as ISO 8601 or epoch (s or ms). Returns aware UTC."""
    if v is None:
        return None
    if isinstance(v, (int, float)) or (isinstance(v, str) and v.replace(".", "").isdigit()):
        n = float(v)
        if n > 1e12:
            n /= 1000.0
        return dt.datetime.fromtimestamp(n, dt.timezone.utc)
    try:
        return dt.datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except ValueError:
        return None


def iso(d: dt.datetime) -> str:
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    return to_dt(last.split(",", 1)[0].strip().strip('"'))


def backfill(dataset: str, symbol: str, start: dt.datetime, end: dt.datetime, interval):
    out_dir = OUT_ROOT / dataset.replace("/", "_")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{symbol}.csv"
    cursor = last_ts(out)
    if cursor:
        print(f"  {symbol}: resuming from {cursor:%Y-%m-%d %H:%M}")
        start = cursor + dt.timedelta(seconds=1)
    total, header = 0, None
    t0 = time.time()
    with out.open("a", newline="") as f:
        w = csv.writer(f)
        while start < end:
            # The API takes ISO 8601, not epoch ms — its 400 says so explicitly, and the docs'
            # own base URL (api.candlefeed.io) has no DNS record either. Trust the API over the docs.
            payload = get(dataset, {"symbol": symbol, "exchange": "binance", "interval": interval,
                                    "start": iso(start), "end": iso(end), "limit": PAGE_LIMIT})
            rows = rows_of(payload)
            if not rows:
                break
            if header is None and isinstance(rows[0], dict):
                header = list(rows[0].keys())
                w.writerow(header)          # keep the column names; these schemas are new to us
            newest = start
            for r in rows:
                if isinstance(r, dict):
                    vals = [r.get(k) for k in header]
                    ts = r.get("timestamp") or r.get("time") or r.get("t") or r.get("start_time") or vals[0]
                else:
                    vals, ts = r, r[0]
                d = to_dt(ts)
                if d and d > newest:
                    newest = d
                w.writerow(vals)
                total += 1
            f.flush()
            if len(rows) < PAGE_LIMIT:
                break
            if newest <= start:             # no forward progress — stop rather than loop forever
                break
            start = newest + dt.timedelta(seconds=1)
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
        raise SystemExit("no API key — write it to ml-training/.candlefeed_key or set CANDLEFEED_API_KEY")

    as_dt = lambda d: dt.datetime.fromisoformat(d).replace(tzinfo=dt.timezone.utc)
    print(f"{a.dataset}: {len(syms)} symbol(s), {a.start} -> {a.end}"
          + (f", interval={a.interval}" if a.interval else " (tick)"))
    for s in syms:
        backfill(a.dataset, s, as_dt(a.start), as_dt(a.end), a.interval)
    print(f"\ndone — {calls_made} API calls used of the {DAILY_CALL_BUDGET} budget")


if __name__ == "__main__":
    main()
