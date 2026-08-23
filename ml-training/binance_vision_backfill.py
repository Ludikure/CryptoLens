#!/usr/bin/env python3
"""Backfill Binance Vision daily futures archives — the history our own collectors don't have.

WHY: the forced-liquidation stream cannot be backfilled at all (verified 2026-08-22 — there is no
`liquidationSnapshot` dataset on Vision in daily or monthly, the listing is empty and a direct
fetch 404s, while an aggTrades control returns real keys). But two archived datasets cover most of
what the liquidation series was FOR, and they reach back to 2020:

  metrics    5-min open interest (contracts + USD), top-trader long/short ratios, taker buy/sell
             ratio. From 2020-09-01. ~12KB/day/symbol.
             - A sharp OI DROP on an adverse price move IS a cascade: forced closes remove open
               interest. That is a usable proxy for the cascade study the liquidation feed was
               being collected for, with six years of history instead of six weeks.
             - It also fills a REAL hole in training: the v14 coverage audit found `oiChangePct`
               populated on 0% of 2020 bars and 8.4% of 2021 bars for BTC (Binance's REST OI
               window is only 30 days). This dataset covers exactly that gap.

  bookDepth  Order-book depth/notional at +-1..5% from mid, roughly every 25s. ~568KB/day/symbol —
             ~45x heavier than metrics, so pull it for majors only. Our own `depth_snapshots` has
             a ~20-min cadence and starts 2026-07-10; this is denser AND historical.

DISCIPLINE: this script only ACQUIRES data. Any hypothesis it enables (cascade asymmetry, heatmap
validation) gets a pre-declared design in docs/research/ BEFORE it is measured — see
news-catalyst-test.md for the pattern and rejected-hypotheses.md for why.

Usage:
  python3 binance_vision_backfill.py metrics --symbols BTCUSDT,ETHUSDT --start 2020-09-01
  python3 binance_vision_backfill.py bookDepth --symbols BTCUSDT --start 2026-01-01

Resumable: a symbol's output CSV is appended to, and days already present are skipped, so an
interrupted run continues where it stopped.
"""
import argparse
import csv
import datetime as dt
import io
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

BASE = "https://data.binance.vision/data/futures/um/daily"
OUT_ROOT = Path(__file__).parent / "vision_backfill"
UA = "MarketScope/1.0 (research; bmihovilovic83@gmail.com)"
DELAY_S = 0.15          # polite; Vision is a public CDN but there is no reason to hammer it
MAX_RETRIES = 3

# bookDepth is ~45x the size of metrics. Reduce it on the fly rather than storing raw: keep one
# row per (snapshot, percentage) but only the bands that matter, so a symbol-year stays tractable.
BOOKDEPTH_BANDS = {"-2.00", "-1.00", "1.00", "2.00"}


def day_range(start: dt.date, end: dt.date):
    d = start
    while d <= end:
        yield d
        d += dt.timedelta(days=1)


def fetch_day(dataset: str, symbol: str, day: dt.date):
    """Return list-of-rows for one day, or None if that day isn't published."""
    url = f"{BASE}/{dataset}/{symbol}/{symbol}-{dataset}-{day.isoformat()}.zip"
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                blob = r.read()
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                name = z.namelist()[0]
                text = z.read(name).decode("utf-8", errors="replace")
            rows = list(csv.reader(io.StringIO(text)))
            if rows and rows[0] and not rows[0][0].replace("-", "").replace(":", "").replace(" ", "").isdigit():
                rows = rows[1:]                      # drop header when present
            return rows
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None                          # not published for this day — normal at edges
            if attempt == MAX_RETRIES - 1:
                print(f"    {day} HTTP {e.code}", file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                print(f"    {day} {e}", file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def existing_days(path: Path) -> set:
    """Days already written, so a rerun resumes instead of duplicating."""
    if not path.exists():
        return set()
    days = set()
    with path.open() as f:
        for line in f:
            ts = line.split(",", 1)[0]
            if len(ts) >= 10:
                days.add(ts[:10])
    return days


def run(dataset: str, symbols, start: dt.date, end: dt.date):
    out_dir = OUT_ROOT / dataset
    out_dir.mkdir(parents=True, exist_ok=True)
    for symbol in symbols:
        out = out_dir / f"{symbol}.csv"
        have = existing_days(out)
        wrote = skipped = missing = 0
        t0 = time.time()
        with out.open("a", newline="") as f:
            w = csv.writer(f)
            for day in day_range(start, end):
                iso = day.isoformat()
                if iso in have:
                    skipped += 1
                    continue
                rows = fetch_day(dataset, symbol, day)
                time.sleep(DELAY_S)
                if rows is None:
                    missing += 1
                    continue
                if dataset == "bookDepth":
                    rows = [r for r in rows if len(r) >= 4 and r[1] in BOOKDEPTH_BANDS]
                w.writerows(rows)
                wrote += len(rows)
                f.flush()
        mb = out.stat().st_size / 1e6 if out.exists() else 0
        print(f"{symbol:<12} +{wrote:>9,} rows  (skipped {skipped} days already held, "
              f"{missing} not published)  -> {mb:.1f}MB  [{time.time()-t0:.0f}s]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", choices=["metrics", "bookDepth"])
    ap.add_argument("--symbols", required=True, help="comma-separated, e.g. BTCUSDT,ETHUSDT")
    ap.add_argument("--start", default="2020-09-01")
    ap.add_argument("--end", default=(dt.date.today() - dt.timedelta(days=1)).isoformat())
    a = ap.parse_args()
    syms = [s.strip().upper() for s in a.symbols.split(",") if s.strip()]
    start, end = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    days = (end - start).days + 1
    print(f"{a.dataset}: {len(syms)} symbol(s) x {days} days "
          f"(~{len(syms)*days*DELAY_S/60:.0f} min of request delay alone)\n")
    run(a.dataset, syms, start, end)


if __name__ == "__main__":
    main()
