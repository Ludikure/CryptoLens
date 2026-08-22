#!/usr/bin/env python3
"""Backfill a historical policy-catalyst event list from Fed + SEC press-release archives.

Companion to docs/research/news-catalyst-test.md (design frozen BEFORE any result).

Why archives and not the RSS feeds the live collector uses: RSS carries only the last ~20-30
items. The yearly archive pages go back decades and encode the release DATE in every URL
(`/newsevents/pressreleases/monetary20241203a.htm`), so the event list is reconstructible
without parsing page bodies or guessing dates.

Only listing pages are fetched — one request per source-year, ~20 requests total. Article
bodies are never downloaded. Polite UA with contact, and a delay between requests.

Output: news_events.csv  (date,source,category,slug)
"""
import csv
import re
import sys
import time
import urllib.request
from pathlib import Path

UA = "MarketScope/1.0 (research; bmihovilovic83@gmail.com)"
OUT = Path(__file__).parent / "news_events.csv"
YEARS = range(2020, 2027)
DELAY_S = 1.0          # deliberate: these are public-good servers, and SEC publishes fair-access norms


def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def fed_year(year: int):
    """Fed yearly archive. Slugs look like monetary20241203a.htm / orders20240115b.htm."""
    url = f"https://www.federalreserve.gov/newsevents/pressreleases/{year}-press.htm"
    html = get(url)
    # category = the slug prefix (monetary | orders | bcreg | enforcement | other ...)
    for m in re.finditer(r"/newsevents/pressreleases/([a-z]+)(\d{8})([a-z]?)\.htm", html):
        cat, date, suffix = m.group(1), m.group(2), m.group(3)
        yield {
            "date": f"{date[:4]}-{date[4:6]}-{date[6:]}",
            "source": "fed",
            "category": cat,
            "slug": f"{cat}{date}{suffix}",
        }


def sec_year(year: int):
    """SEC press releases. The archive is paginated; the listing carries dated hrefs."""
    out = []
    for page in range(0, 10):                      # 10 pages x 10/page covers a year comfortably
        url = f"https://www.sec.gov/news/pressreleases?page={page}&year={year}"
        try:
            html = get(url)
        except Exception as e:
            print(f"  sec {year} page {page}: {e}", file=sys.stderr)
            break
        found = 0
        # Two shapes appear across years: /news/press-release/2024-123 and dated detail links.
        for m in re.finditer(r"/news/press-release/(\d{4})-(\d+)", html):
            out.append({"date": None, "source": "sec", "category": "pressrelease",
                        "slug": f"{m.group(1)}-{m.group(2)}"})
            found += 1
        # Dates in the listing table (YYYY-MM-DD or Month D, YYYY)
        for m in re.finditer(r"(\d{4}-\d{2}-\d{2})", html):
            out.append({"date": m.group(1), "source": "sec", "category": "date-hint",
                        "slug": m.group(1)})
            found += 1
        if found == 0:
            break
        time.sleep(DELAY_S)
    return out


def main():
    rows = []
    for year in YEARS:
        try:
            got = list(fed_year(year))
            rows.extend(got)
            print(f"fed {year}: {len(got)} release links")
        except Exception as e:
            print(f"fed {year}: FAILED {e}", file=sys.stderr)
        time.sleep(DELAY_S)

    if "--sec" in sys.argv:
        for year in YEARS:
            got = sec_year(year)
            rows.extend(got)
            print(f"sec {year}: {len(got)} rows")

    # Dedupe on (source, slug) — a release can be linked from several places on a listing page.
    seen, uniq = set(), []
    for r in rows:
        if not r["date"]:
            continue
        k = (r["source"], r["slug"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)
    uniq.sort(key=lambda r: (r["date"], r["source"], r["slug"]))

    with OUT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date", "source", "category", "slug"])
        w.writeheader()
        w.writerows(uniq)

    print(f"\nwrote {len(uniq)} unique events -> {OUT}")
    by_cat = {}
    for r in uniq:
        by_cat[(r["source"], r["category"])] = by_cat.get((r["source"], r["category"]), 0) + 1
    for k, v in sorted(by_cat.items(), key=lambda kv: -kv[1])[:10]:
        print(f"  {k[0]}/{k[1]}: {v}")


if __name__ == "__main__":
    main()
