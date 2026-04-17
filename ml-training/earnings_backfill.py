"""
Download historical earnings dates per stock symbol using yfinance.
Output: ml-training/earnings_history.json  (symbol → sorted list of YYYY-MM-DD)

yfinance returns full earnings history (typically 4-20 years) via the `earnings_dates`
property. Finnhub free tier was too restrictive — only current-week window.

Usage:
    python3 ml-training/earnings_backfill.py
"""

import json
from datetime import datetime, timezone

import yfinance as yf

STOCK_SYMBOLS = [
    # Mega-cap tech
    'AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN',
    'CRM', 'NFLX', 'AMD', 'ORCL', 'ADBE', 'INTC', 'CSCO',
    # Semiconductors
    'AVGO', 'QCOM', 'MU', 'AMAT', 'LRCX', 'MRVL',
    # High-beta growth
    'PLTR', 'ROKU', 'SHOP', 'SQ', 'SNAP', 'COIN', 'RBLX',
    # High short-interest / meme
    'BYND', 'GME',
    # Financials
    'JPM', 'GS', 'MS', 'BAC', 'WFC', 'BLK', 'SCHW',
    # Healthcare / pharma
    'UNH', 'LLY', 'ABBV', 'JNJ', 'PFE', 'MRK', 'TMO',
    # Biotech
    'REGN', 'VRTX', 'GILD', 'BIIB',
    # Consumer
    'HD', 'MA', 'V', 'DIS', 'NKE', 'SBUX', 'MCD', 'WMT', 'COST',
    # Cyclicals
    'CAT', 'DE', 'X', 'BA',
    # Energy
    'XOM', 'OXY', 'FANG', 'CVX', 'SLB',
    # Defense / aerospace
    'LMT', 'RTX', 'GD',
    # Transport
    'UNP', 'FDX', 'DAL',
    # Telecom / media
    'T', 'VZ', 'CMCSA',
    # REITs
    'SPG', 'O',
    # ETFs (no earnings — feature will default to 0)
    'SPY', 'QQQ', 'IWM', 'XLE', 'XLF', 'XLK', 'XLV', 'GLD', 'TLT',
]

OUTPUT = '/Users/bojanmihovilovic/CryptoLens/ml-training/earnings_history.json'
MIN_DATE = '2019-01-01'  # stock training starts 2020; 1-year warmup buffer


def fetch_earnings(symbol: str) -> list[str]:
    """Return sorted YYYY-MM-DD earnings dates since 2019 for symbol."""
    try:
        ticker = yf.Ticker(symbol)
        # earnings_dates returns a DataFrame indexed by datetime; includes past + upcoming
        df = ticker.earnings_dates
        if df is None or df.empty:
            return []
        # Index is timezone-aware datetime; convert to UTC date strings
        dates = set()
        for ts in df.index:
            if ts is None:
                continue
            date_str = ts.strftime('%Y-%m-%d')
            if date_str >= MIN_DATE:
                dates.add(date_str)
        return sorted(dates)
    except Exception as e:
        print(f"  {symbol}: error {e}")
        return []


def main():
    out = {}
    for sym in STOCK_SYMBOLS:
        dates = fetch_earnings(sym)
        out[sym] = dates
        first = dates[0] if dates else '—'
        last = dates[-1] if dates else '—'
        print(f"  {sym:6s}: {len(dates):3d} earnings dates  ({first} → {last})")
    with open(OUTPUT, 'w') as f:
        json.dump(out, f, indent=2)
    print(f"\nWrote {OUTPUT}")


if __name__ == '__main__':
    main()
