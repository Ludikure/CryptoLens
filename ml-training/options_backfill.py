"""
Backfill historical EOD options-derived features from MarketData.app.

For each (symbol, trading_date), pulls the full options chain in one API call,
computes 5 features, writes to ml-training/options_history.json.

Features (mirrors marketscope-worker/src/options-features.ts):
  - atmIv         : ATM IV in front-month (closest expiry >= 7 DTE)
  - ivRank        : percentile of today's atmIv vs trailing 252-day window (0-1)
  - ivSkew25d     : 25-delta put IV minus 25-delta call IV in front-month
  - ivTermSlope   : 60-day-out ATM IV minus front-month ATM IV
  - pcOiRatio     : sum(put OI) / sum(call OI), strikes within ±10% of spot, front-month

Inputs:
  - ml-training/csv_exports_v11/*.csv : provides symbol list + per-(symbol, date) spot prices
  - MARKETDATA_TOKEN env var : MarketData.app trader trial bearer token
  - First arg (optional)    : start date YYYY-MM-DD (default 2020-01-02)
  - Second arg (optional)   : end date YYYY-MM-DD (default today)

Output:
  - ml-training/options_history.json : { "AAPL": [{date, atmIv, ivRank, ivSkew25d, ivTermSlope, pcOiRatio}, ...], ... }
  - ml-training/options_backfill_progress.json : resumability state

Resumability:
  - Each symbol's completed dates are saved after each successful symbol.
  - Re-running picks up where it left off.

Rate limit awareness:
  - 100K credits/day on Trader tier. 1 credit per chain call (cached mode).
  - Default delay: 0.3s between calls (~3 req/sec) - safe under any per-second cap.
  - Will sleep until next UTC day if 100K cap is hit.

Usage:
  export MARKETDATA_TOKEN=your_trial_token_here
  python3 ml-training/options_backfill.py [start_date] [end_date]
"""

import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Optional
import urllib.request
import urllib.parse
import urllib.error

from black_scholes import iv_from_price, delta as bs_delta

ROOT = '/Users/bojanmihovilovic/CryptoLens'
CSV_DIR = f'{ROOT}/ml-training/csv_exports_v11'
OUT_PATH = f'{ROOT}/ml-training/options_history.json'
PROGRESS_PATH = f'{ROOT}/ml-training/options_backfill_progress.json'
TOKEN = os.environ.get('MARKETDATA_TOKEN', '')

# Risk-free rate and dividend yield assumptions (must match TS port).
R = 0.05
Q = 0.0

# Pacing
REQ_DELAY_SEC = 0.0  # parallelism handles throughput; per-call sleep is wasteful
WORKERS = 8           # concurrent requests per symbol's date loop
DAILY_CREDIT_CAP = 100_000

# Known-bad dates: trial's "1 year" boundary slips a couple days; these always 402.
# Skip them rather than waste calls + retries.
SKIP_DATES = {'2025-05-01', '2025-05-02'}

# 159 symbols from v11 (SQ and X excluded due to data unavailability).
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


# ============================================================
# MarketData.app API
# ============================================================

def fetch_chain(symbol: str, date_str: str) -> Optional[dict]:
    """Fetch full options chain for symbol on date_str (YYYY-MM-DD).
    Returns parsed JSON dict or None on error/no_data.
    Uses cached mode (1 credit) by relying on the date param being a past date."""
    url = (f"https://api.marketdata.app/v1/options/chain/{symbol}/"
           f"?date={date_str}&expiration=all")
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get('s') == 'ok':
                return data
            # 'no_data' is normal for dates with no options activity
            return None
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print(f"  RATE LIMITED on {symbol} {date_str} — sleeping 60s")
            time.sleep(60)
            return fetch_chain(symbol, date_str)
        print(f"  HTTP {e.code} on {symbol} {date_str}: {e.reason}")
        return None
    except Exception as e:
        print(f"  Error fetching {symbol} {date_str}: {e}")
        return None


# ============================================================
# Feature computation per (symbol, date)
# ============================================================

def _select_front_month(unique_dtes: list[int]) -> Optional[int]:
    """Closest expiry >= 7 DTE."""
    candidates = [d for d in unique_dtes if d >= 7]
    return min(candidates) if candidates else None


def _select_60d_expiry(unique_dtes: list[int]) -> Optional[int]:
    """Closest expiry to 60 DTE, must be >= 30 DTE."""
    candidates = [d for d in unique_dtes if d >= 30]
    if not candidates:
        return None
    return min(candidates, key=lambda d: abs(d - 60))


def _atm_iv_for_expiry(rows: list[dict], spot: float) -> Optional[float]:
    """For rows in a single expiry, find IV at strike closest to spot.
    Averages call and put IV at that strike if both exist."""
    if not rows:
        return None
    # Group by strike
    by_strike: dict[float, dict] = {}
    for r in rows:
        s = r['strike']
        by_strike.setdefault(s, {})
        by_strike[s][r['side']] = r
    # Find strike closest to spot
    closest_k = min(by_strike.keys(), key=lambda k: abs(k - spot))
    contracts = by_strike[closest_k]
    ivs = [c['iv'] for c in contracts.values() if c.get('iv') is not None and c['iv'] > 0]
    if not ivs:
        return None
    return sum(ivs) / len(ivs)


def _interp_iv_at_delta(rows: list[dict], target_delta: float, spot: float, T: float) -> Optional[float]:
    """Interpolate IV at a target delta within rows of one side (calls or puts) of one expiry.
    Computes our own delta from each contract's IV via BS, sorts by delta, interpolates linearly."""
    contracts = []
    for r in rows:
        if r.get('iv') is None or r['iv'] <= 0:
            continue
        is_call = r['side'] == 'call'
        d = bs_delta(spot, r['strike'], T, R, Q, r['iv'], is_call)
        contracts.append((d, r['iv']))
    if len(contracts) < 2:
        return None
    contracts.sort(key=lambda x: x[0])
    # Find bracketing pair around target_delta
    for i in range(len(contracts) - 1):
        d1, iv1 = contracts[i]
        d2, iv2 = contracts[i + 1]
        if (d1 <= target_delta <= d2) or (d2 <= target_delta <= d1):
            if d2 == d1:
                return iv1
            t = (target_delta - d1) / (d2 - d1)
            return iv1 + t * (iv2 - iv1)
    # Out of range — return nearest
    closest = min(contracts, key=lambda c: abs(c[0] - target_delta))
    return closest[1]


def compute_features(chain: dict, spot: float) -> Optional[dict]:
    """Compute the 5 raw features (atmIv, ivSkew25d, ivTermSlope, pcOiRatio, plus front DTE) from one chain.
    Does NOT compute ivRank — that's a second pass. Returns None if chain is unusable."""
    n = len(chain.get('strike', []))
    if n == 0:
        return None
    # Build rows: parallel arrays → list of dicts
    iv_field = chain.get('iv', [None] * n)
    bid_field = chain.get('bid', [None] * n)
    ask_field = chain.get('ask', [None] * n)
    mid_field = chain.get('mid', [None] * n)
    rows = []
    for i in range(n):
        bid = bid_field[i] if bid_field[i] is not None else 0.0
        ask = ask_field[i] if ask_field[i] is not None else 0.0
        mid = mid_field[i] if mid_field[i] is not None else (bid + ask) / 2.0 if (bid > 0 and ask > 0) else 0.0
        rows.append({
            'strike': chain['strike'][i],
            'side': chain['side'][i],
            'dte': chain['dte'][i],
            'iv': iv_field[i],
            'bid': bid,
            'ask': ask,
            'mid': mid,
            'oi': chain.get('openInterest', [0] * n)[i] or 0,
        })

    # If MarketData IV is missing/zero, compute our own from mid via BS
    for r in rows:
        if r['iv'] is None or r['iv'] <= 0:
            if r['mid'] > 0 and r['dte'] > 0:
                T = r['dte'] / 365.25
                is_call = r['side'] == 'call'
                r['iv'] = iv_from_price(r['mid'], spot, r['strike'], T, R, Q, is_call)

    unique_dtes = sorted(set(r['dte'] for r in rows if r['dte'] > 0))
    front_dte = _select_front_month(unique_dtes)
    sixty_dte = _select_60d_expiry(unique_dtes)
    if front_dte is None:
        return None

    front_rows = [r for r in rows if r['dte'] == front_dte]
    sixty_rows = [r for r in rows if r['dte'] == sixty_dte] if sixty_dte else []

    # ATM IV (front)
    atm_iv = _atm_iv_for_expiry(front_rows, spot)
    if atm_iv is None:
        return None

    # ATM IV (60d)
    atm_iv_60 = _atm_iv_for_expiry(sixty_rows, spot) if sixty_rows else None

    # 25-delta skew: front month
    T_front = front_dte / 365.25
    front_calls = [r for r in front_rows if r['side'] == 'call']
    front_puts = [r for r in front_rows if r['side'] == 'put']
    iv_25d_call = _interp_iv_at_delta(front_calls, 0.25, spot, T_front)
    iv_25d_put = _interp_iv_at_delta(front_puts, -0.25, spot, T_front)
    iv_skew = (iv_25d_put - iv_25d_call) if (iv_25d_call is not None and iv_25d_put is not None) else 0.0

    # Term slope
    iv_term_slope = (atm_iv_60 - atm_iv) if atm_iv_60 is not None else 0.0

    # P/C OI ratio: front month, ±10% of spot
    band_lo, band_hi = spot * 0.9, spot * 1.1
    put_oi = sum(r['oi'] for r in front_puts if band_lo <= r['strike'] <= band_hi)
    call_oi = sum(r['oi'] for r in front_calls if band_lo <= r['strike'] <= band_hi)
    pc_oi = (put_oi / call_oi) if call_oi > 0 else 1.0
    # Cap to avoid extreme values from one-sided liquidity
    pc_oi = max(0.1, min(10.0, pc_oi))

    return {
        'atmIv': atm_iv,
        'ivSkew25d': iv_skew,
        'ivTermSlope': iv_term_slope,
        'pcOiRatio': pc_oi,
    }


# ============================================================
# IV rank (second pass)
# ============================================================

def compute_iv_ranks(symbol_records: list[dict]) -> list[dict]:
    """Add ivRank field to each record — percentile of current atmIv vs prior 252 days.
    Returns 0.5 (neutral) for first 252 days where there's insufficient history."""
    out = []
    for i, rec in enumerate(symbol_records):
        prior = [r['atmIv'] for r in symbol_records[max(0, i - 252):i] if r.get('atmIv')]
        if len(prior) < 60:  # need at least 60 days for a meaningful rank
            rank = 0.5
        else:
            count_below = sum(1 for v in prior if v < rec['atmIv'])
            rank = count_below / len(prior)
        out.append({**rec, 'ivRank': round(rank, 4)})
    return out


# ============================================================
# Spot prices from existing CSV exports
# ============================================================

def load_spot_prices(symbol: str) -> dict[str, float]:
    """Fetch daily closes from Yahoo Finance directly. Returns {YYYY-MM-DD: close}.
    Uses Yahoo's daily endpoint (no 730-day cap; full history available).
    Retries up to 3x with backoff on transient connection errors — earlier run lost 26 symbols
    to "Errno 61 Connection refused" without retry."""
    out: dict[str, float] = {}
    period1 = int(time.time()) - 3 * 365 * 86400
    period2 = int(time.time())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?interval=1d&period1={period1}&period2={period2}")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    data = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            break
        except Exception as e:
            if attempt == 2:
                print(f"  WARN: {symbol} Yahoo daily fetch failed after 3 attempts: {e}")
                return {}
            time.sleep(2 ** attempt)  # 1s, 2s backoff
    try:
        result = data.get('chart', {}).get('result', [{}])[0]
        timestamps = result.get('timestamp', [])
        quote = result.get('indicators', {}).get('quote', [{}])[0]
        closes = quote.get('close', [])
        for ts, close in zip(timestamps, closes):
            if close is None:
                continue
            date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d')
            out[date_str] = float(close)
    except Exception as e:
        print(f"  WARN: {symbol} Yahoo daily parse failed: {e}")
    return out


# ============================================================
# Progress tracking + main loop
# ============================================================

def load_progress() -> dict:
    if os.path.isfile(PROGRESS_PATH):
        with open(PROGRESS_PATH) as f:
            return json.load(f)
    return {'completed_symbols': [], 'credits_used_today': 0, 'credits_date': ''}


def save_progress(p: dict):
    with open(PROGRESS_PATH, 'w') as f:
        json.dump(p, f, indent=2)


def load_output() -> dict:
    if os.path.isfile(OUT_PATH):
        with open(OUT_PATH) as f:
            return json.load(f)
    return {}


def save_output(out: dict):
    with open(OUT_PATH, 'w') as f:
        json.dump(out, f)


def main():
    if not TOKEN:
        print("ERROR: Set MARKETDATA_TOKEN env var.")
        sys.exit(1)

    start_date = sys.argv[1] if len(sys.argv) > 1 else '2020-01-02'
    end_date = sys.argv[2] if len(sys.argv) > 2 else datetime.now(timezone.utc).strftime('%Y-%m-%d')
    print(f"Backfill window: {start_date} → {end_date}")

    progress = load_progress()
    output = load_output()

    today_utc = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    if progress.get('credits_date') != today_utc:
        progress['credits_used_today'] = 0
        progress['credits_date'] = today_utc

    for sym_idx, symbol in enumerate(STOCK_SYMBOLS):
        if symbol in progress['completed_symbols']:
            print(f"[{sym_idx + 1}/{len(STOCK_SYMBOLS)}] {symbol}: already done, skip")
            continue

        spot_prices = load_spot_prices(symbol)
        if not spot_prices:
            print(f"[{sym_idx + 1}/{len(STOCK_SYMBOLS)}] {symbol}: no spot price CSV, skip")
            progress['completed_symbols'].append(symbol)
            save_progress(progress)
            continue

        # Filter to dates in our window, skipping known-bad edges
        target_dates = sorted(
            d for d in spot_prices.keys()
            if start_date <= d <= end_date and d not in SKIP_DATES
        )
        print(f"[{sym_idx + 1}/{len(STOCK_SYMBOLS)}] {symbol}: {len(target_dates)} dates (parallel {WORKERS})")

        # Daily credit cap check (rough — we'll add target_dates count up front)
        if progress['credits_used_today'] + len(target_dates) >= DAILY_CREDIT_CAP - 100:
            now = datetime.now(timezone.utc)
            tomorrow = now.replace(hour=0, minute=5, second=0, microsecond=0)
            if tomorrow <= now:
                tomorrow = tomorrow.replace(day=tomorrow.day + 1)
            wait_sec = (tomorrow - now).total_seconds()
            print(f"  Daily cap would be hit. Sleeping {wait_sec/3600:.1f}h until next UTC day.")
            time.sleep(wait_sec)
            progress['credits_used_today'] = 0
            progress['credits_date'] = datetime.now(timezone.utc).strftime('%Y-%m-%d')

        # Parallel fetch the chain for each date, then sequentially compute features.
        # Thread pool because the bottleneck is HTTP I/O (urllib.request releases GIL on socket reads).
        chain_results: dict[str, Optional[dict]] = {}
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futures = {ex.submit(fetch_chain, symbol, d): d for d in target_dates}
            for fut in as_completed(futures):
                date_str = futures[fut]
                try:
                    chain_results[date_str] = fut.result()
                except Exception as e:
                    print(f"  Error fetching {symbol} {date_str}: {e}")
                    chain_results[date_str] = None

        records = []
        for date_str in target_dates:
            chain = chain_results.get(date_str)
            if chain is None:
                continue
            spot = spot_prices[date_str]
            feats = compute_features(chain, spot)
            if feats is None:
                continue
            records.append({'date': date_str, **feats})

        progress['credits_used_today'] += len(target_dates)

        # Compute IV rank as second pass per symbol
        records_with_rank = compute_iv_ranks(records)
        output[symbol] = records_with_rank
        progress['completed_symbols'].append(symbol)
        save_output(output)
        save_progress(progress)
        print(f"  → {len(records_with_rank)}/{len(target_dates)} records, credits used today: {progress['credits_used_today']}")

    print(f"\nDONE. Output: {OUT_PATH}")
    print(f"Total symbols completed: {len(progress['completed_symbols'])}")


if __name__ == '__main__':
    main()
