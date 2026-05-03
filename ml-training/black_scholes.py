"""
Black-Scholes pricing, implied volatility inversion, and delta.

Used by:
  - options_backfill.py (compute features from MarketData.app EOD chains)
  - validate_options_features.py (Phase 3 gate)

Mirrors marketscope-worker/src/black-scholes.ts — identical formulas so that
features computed during backfill match features computed live by the worker.

Conventions:
  - All times in years (e.g., 30 days = 30/365.25)
  - All rates as decimals (5% = 0.05)
  - sigma is annualized volatility
  - is_call: True for call, False for put
"""

import math


def _norm_cdf(x: float) -> float:
    """Standard normal CDF using math.erf (same value-domain as TS Abramowitz-Stegun)."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    """Standard normal PDF."""
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bs_price(S: float, K: float, T: float, r: float, q: float, sigma: float, is_call: bool) -> float:
    """Black-Scholes price for a European call or put with continuous dividend yield q."""
    if T <= 0 or sigma <= 0:
        return max(0.0, S - K) if is_call else max(0.0, K - S)
    sqrtT = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT
    if is_call:
        return S * math.exp(-q * T) * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)
    return K * math.exp(-r * T) * _norm_cdf(-d2) - S * math.exp(-q * T) * _norm_cdf(-d1)


def delta(S: float, K: float, T: float, r: float, q: float, sigma: float, is_call: bool) -> float:
    """Black-Scholes delta. Calls in [0, exp(-qT)], puts in [-exp(-qT), 0]."""
    if T <= 0 or sigma <= 0:
        if is_call:
            return 1.0 if S > K else 0.0
        return -1.0 if S < K else 0.0
    sqrtT = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    if is_call:
        return math.exp(-q * T) * _norm_cdf(d1)
    return math.exp(-q * T) * (_norm_cdf(d1) - 1.0)


def vega(S: float, K: float, T: float, r: float, q: float, sigma: float) -> float:
    """Black-Scholes vega = dPrice/dSigma. Same for calls and puts."""
    if T <= 0 or sigma <= 0:
        return 0.0
    sqrtT = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    return S * math.exp(-q * T) * sqrtT * _norm_pdf(d1)


def iv_from_price(
    market_price: float,
    S: float,
    K: float,
    T: float,
    r: float,
    q: float,
    is_call: bool,
    initial_sigma: float = 0.3,
    tol: float = 1e-6,
    max_iter: int = 50,
) -> float | None:
    """Invert Black-Scholes for implied volatility via Newton-Raphson.
    Falls back to bisection if Newton diverges or vega vanishes.
    Returns None if inversion fails (e.g., price below intrinsic value).
    """
    # Sanity: option price must be at or above intrinsic value
    intrinsic = max(0.0, S - K) if is_call else max(0.0, K - S)
    if market_price < intrinsic - 1e-6:
        return None
    if T <= 0:
        return None

    sigma = initial_sigma
    for _ in range(max_iter):
        price = bs_price(S, K, T, r, q, sigma, is_call)
        diff = price - market_price
        if abs(diff) < tol:
            return sigma
        v = vega(S, K, T, r, q, sigma)
        if v < 1e-10:
            break  # fall through to bisection
        sigma = sigma - diff / v
        if sigma <= 0 or sigma > 5.0:
            break  # diverged

    # Bisection fallback over [0.001, 5.0]
    lo, hi = 0.001, 5.0
    for _ in range(100):
        mid = (lo + hi) / 2.0
        price = bs_price(S, K, T, r, q, mid, is_call)
        if abs(price - market_price) < tol:
            return mid
        if price < market_price:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-8:
            return mid
    return None


# ============================================================
# Round-trip test: known inputs -> price -> invert -> match sigma
# Run: python3 ml-training/black_scholes.py
# ============================================================
if __name__ == '__main__':
    # Test 1: ATM call, 90 days
    S, K, T, r, q = 100.0, 100.0, 0.25, 0.05, 0.0
    sigma_true = 0.20
    p_call = bs_price(S, K, T, r, q, sigma_true, True)
    p_put = bs_price(S, K, T, r, q, sigma_true, False)
    iv_call = iv_from_price(p_call, S, K, T, r, q, True)
    iv_put = iv_from_price(p_put, S, K, T, r, q, False)
    print(f"Test 1 ATM 90d: call_price={p_call:.6f}, put_price={p_put:.6f}")
    print(f"  iv_call={iv_call:.6f} (target {sigma_true}), iv_put={iv_put:.6f}")
    assert abs(iv_call - sigma_true) < 1e-5
    assert abs(iv_put - sigma_true) < 1e-5

    # Test 2: OTM put, 30 days, high vol
    S, K, T, r, q = 100.0, 95.0, 30/365.25, 0.05, 0.0
    sigma_true = 0.40
    p = bs_price(S, K, T, r, q, sigma_true, False)
    iv = iv_from_price(p, S, K, T, r, q, False)
    print(f"Test 2 OTM put 30d: price={p:.6f}, iv={iv:.6f} (target {sigma_true})")
    assert abs(iv - sigma_true) < 1e-5

    # Test 3: Delta sanity
    d_call_atm = delta(100, 100, 0.25, 0.05, 0, 0.20, True)
    d_put_atm = delta(100, 100, 0.25, 0.05, 0, 0.20, False)
    print(f"Test 3 ATM delta: call={d_call_atm:.4f} (~0.55), put={d_put_atm:.4f} (~-0.45)")
    assert 0.50 < d_call_atm < 0.65
    assert -0.50 < d_put_atm < -0.35

    # Test 4: Find 25-delta put strike (used in skew computation)
    S, T, r, q, sigma = 100.0, 30/365.25, 0.05, 0.0, 0.25
    for K in [88, 90, 92, 94, 96]:
        d = delta(S, K, T, r, q, sigma, False)
        print(f"  K={K}: put delta = {d:.4f}")

    print("\nAll Python BS tests passed.")
