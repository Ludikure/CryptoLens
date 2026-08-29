#!/usr/bin/env python3
"""Does policy-catalyst proximity predict goodR? — runs the design frozen in
docs/research/news-catalyst-test.md. Do not edit the thresholds here; they are pre-declared.

Conservative by construction: an event dated D is timestamped 23:59:59 UTC on D, so only bars
OPENING AFTER that are counted post-catalyst. The same-day repricing is therefore invisible and
every measured effect is a LOWER bound — the trade made deliberately to render lookahead impossible.
"""
import csv
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
EVENTS = HERE / "news_events.csv"
CSV_DIR = HERE / "csv_exports_v14"

GOODR = 1.5
H = 3600.0
WINDOWS = [("0-24h", 0, 24), ("24-48h", 24, 48), ("48-72h", 48, 72)]
BASELINE_EXCLUDE_H = 72

# Pre-declared ship bar (docs/research/news-catalyst-test.md)
BAR_LIFT_PP = 3.0
BAR_YEARS = 5
BAR_MIN_N = 200


def load_events(categories=None):
    """Event epoch-seconds at 23:59:59 UTC of the release date."""
    out = []
    with EVENTS.open() as f:
        for r in csv.DictReader(f):
            if categories and r["category"] not in categories:
                continue
            d = datetime.strptime(r["date"], "%Y-%m-%d").replace(
                hour=23, minute=59, second=59, tzinfo=timezone.utc)
            out.append(d.timestamp())
    return sorted(set(out))


def load_bars(symbol):
    p = CSV_DIR / f"{symbol}.csv"
    if not p.exists():
        return []
    bars = []
    with p.open() as f:
        for r in csv.DictReader(f):
            try:
                ts = float(r["timestamp"])
                fav = r.get("fwdMaxFavR", "")
                if fav in ("", "nan", "NaN"):
                    continue
                ts = ts / 1000.0 if ts > 1e11 else ts
                bars.append({
                    "ts": ts,
                    "good": 1 if float(fav) >= GOODR else 0,
                    "fav": float(fav),
                    "up": float(r["fwdMaxUp24H"]) if r.get("fwdMaxUp24H") not in ("", "nan", None) else None,
                    "dn": float(r["fwdMaxDown24H"]) if r.get("fwdMaxDown24H") not in ("", "nan", None) else None,
                    "year": datetime.fromtimestamp(ts, timezone.utc).year,
                })
            except (ValueError, KeyError):
                continue
    return sorted(bars, key=lambda b: b["ts"])


def hours_since_prev_event(bar_ts, events):
    """Hours since the most recent event strictly BEFORE this bar (None if none)."""
    lo, hi = 0, len(events)
    while lo < hi:                       # rightmost event < bar_ts
        mid = (lo + hi) // 2
        if events[mid] < bar_ts:
            lo = mid + 1
        else:
            hi = mid
    if lo == 0:
        return None
    return (bar_ts - events[lo - 1]) / H


def ztest(k1, n1, k2, n2):
    """Two-proportion z. Only meaningful for INDEPENDENT bars (single symbol)."""
    if n1 == 0 or n2 == 0:
        return float("nan")
    p1, p2 = k1 / n1, k2 / n2
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    return (p1 - p2) / se if se > 0 else float("nan")


def analyse(symbols, events, label, show_years=True):
    buckets = {w[0]: {"k": 0, "n": 0, "fav": [], "up": [], "dn": []} for w in WINDOWS}
    base = {"k": 0, "n": 0, "fav": []}
    per_year = defaultdict(lambda: {"ek": 0, "en": 0, "bk": 0, "bn": 0})

    for sym in symbols:
        for b in load_bars(sym):
            hs = hours_since_prev_event(b["ts"], events)
            placed = None
            if hs is not None:
                for name, lo, hi in WINDOWS:
                    if lo <= hs < hi:
                        placed = name
                        break
            if placed:
                d = buckets[placed]
                d["k"] += b["good"]; d["n"] += 1; d["fav"].append(b["fav"])
                if b["up"] is not None:
                    d["up"].append(b["up"]); d["dn"].append(b["dn"])
                if placed == "0-24h":
                    y = per_year[b["year"]]; y["ek"] += b["good"]; y["en"] += 1
            elif hs is None or hs >= BASELINE_EXCLUDE_H:
                base["k"] += b["good"]; base["n"] += 1; base["fav"].append(b["fav"])
                y = per_year[b["year"]]; y["bk"] += b["good"]; y["bn"] += 1

    bp = base["k"] / base["n"] * 100 if base["n"] else float("nan")
    print(f"\n{'='*74}\n{label}\n{'='*74}")
    print(f"baseline (>{BASELINE_EXCLUDE_H}h from any event): {bp:5.1f}% goodR   n={base['n']:,}")
    lifts = {}
    for name, _, _ in WINDOWS:
        d = buckets[name]
        if not d["n"]:
            continue
        p = d["k"] / d["n"] * 100
        lift = p - bp
        lifts[name] = lift
        z = ztest(d["k"], d["n"], base["k"], base["n"])
        favm = sum(d["fav"]) / len(d["fav"])
        skew = ""
        if d["up"]:
            skew = f"  |  up {sum(d['up'])/len(d['up']):+.2f}% dn {sum(d['dn'])/len(d['dn']):+.2f}%"
        print(f"  {name:>7}: {p:5.1f}% goodR  ({lift:+.1f}pp)  n={d['n']:>6,}  z={z:+.2f}  meanFavR={favm:.2f}{skew}")

    if show_years:
        print("  walk-forward (0-24h lift vs same-year baseline):")
        pos = 0; yrs = 0
        for y in sorted(per_year):
            v = per_year[y]
            if v["en"] < 20 or v["bn"] < 100:
                continue
            l = v["ek"] / v["en"] * 100 - v["bk"] / v["bn"] * 100
            pos += 1 if l > 0 else 0; yrs += 1
            print(f"    {y}: {l:+5.1f}pp   (event n={v['en']:,})")
        print(f"    -> positive in {pos}/{yrs} years")
        return lifts, buckets, pos, yrs
    return lifts, buckets, 0, 0


def main():
    all_ev = load_events()
    mon_ev = load_events({"monetary"})
    print(f"events loaded: FED_ALL={len(all_ev)}  FED_MONETARY={len(mon_ev)}")

    btc = ["BTCUSDT"]
    majors = [s for s in ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT", "XRPUSDT",
                          "LINKUSDT", "AVAXUSDT", "DOTUSDT"] if (CSV_DIR / f"{s}.csv").exists()]

    lifts, buckets, pos, yrs = analyse(btc, mon_ev, "H2 PRIMARY — FED_MONETARY vs BTC (independent bars)")
    analyse(btc, all_ev, "FED_ALL vs BTC (broad/noisy set)")
    analyse(majors, mon_ev,
            f"POOLED {len(majors)} majors — FED_MONETARY  [effect size only: crypto moves together,\n"
            f"so these bars are NOT independent and the z-values are inflated. Do not read them as p-values.]",
            show_years=False)

    # Pre-declared verdict on the PRIMARY test only.
    l24 = lifts.get("0-24h", float("nan"))
    n24 = buckets["0-24h"]["n"]
    l48 = lifts.get("24-48h", float("nan"))
    print(f"\n{'='*74}\nPRE-DECLARED SHIP BAR (docs/research/news-catalyst-test.md)\n{'='*74}")
    c1 = l24 >= BAR_LIFT_PP
    c2 = pos >= BAR_YEARS
    c3 = n24 >= BAR_MIN_N
    c4 = not (l48 > l24)
    print(f"  1. 0-24h lift >= +{BAR_LIFT_PP}pp .............. {l24:+.1f}pp   {'PASS' if c1 else 'FAIL'}")
    print(f"  2. positive in >= {BAR_YEARS} years ............. {pos}/{yrs}      {'PASS' if c2 else 'FAIL'}")
    print(f"  3. n >= {BAR_MIN_N} post-event bars ........... {n24:,}     {'PASS' if c3 else 'FAIL'}")
    print(f"  4. 24-48h lift does not exceed 0-24h ..... {l48:+.1f} vs {l24:+.1f}  {'PASS' if c4 else 'FAIL'}")
    print(f"\n  VERDICT: {'SUPPORTED — v15 feature candidate' if all([c1,c2,c3,c4]) else 'NOT SUPPORTED — file in rejected-hypotheses.md'}")


if __name__ == "__main__":
    main()
