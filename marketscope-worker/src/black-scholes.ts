// Black-Scholes pricing, implied volatility inversion, and delta.
//
// Used by:
//   - options-features.ts (compute features from Yahoo chains in worker cron)
//
// Mirrors ml-training/black_scholes.py — identical formulas so that features
// computed live by the worker match features computed during backfill.
//
// Conventions:
//   - All times in years (e.g., 30 days = 30/365.25)
//   - All rates as decimals (5% = 0.05)
//   - sigma is annualized volatility
//   - isCall: true for call, false for put

/** Error function via Abramowitz-Stegun 7.1.26 approximation (max err ~1.5e-7). */
function erf(x: number): number {
    const sign = x >= 0 ? 1 : -1;
    const ax = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * ax);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return sign * y;
}

function normCdf(x: number): number {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normPdf(x: number): number {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function bsPrice(S: number, K: number, T: number, r: number, q: number, sigma: number, isCall: boolean): number {
    if (T <= 0 || sigma <= 0) {
        return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    }
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    if (isCall) {
        return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
    }
    return K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
}

export function delta(S: number, K: number, T: number, r: number, q: number, sigma: number, isCall: boolean): number {
    if (T <= 0 || sigma <= 0) {
        if (isCall) return S > K ? 1 : 0;
        return S < K ? -1 : 0;
    }
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    if (isCall) return Math.exp(-q * T) * normCdf(d1);
    return Math.exp(-q * T) * (normCdf(d1) - 1);
}

export function vega(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
    if (T <= 0 || sigma <= 0) return 0;
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    return S * Math.exp(-q * T) * sqrtT * normPdf(d1);
}

/** Newton-Raphson IV inversion with bisection fallback. Returns null on failure. */
export function ivFromPrice(
    marketPrice: number,
    S: number,
    K: number,
    T: number,
    r: number,
    q: number,
    isCall: boolean,
    initialSigma: number = 0.3,
    tol: number = 1e-6,
    maxIter: number = 50,
): number | null {
    const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    if (marketPrice < intrinsic - 1e-6) return null;
    if (T <= 0) return null;

    let sigma = initialSigma;
    for (let i = 0; i < maxIter; i++) {
        const price = bsPrice(S, K, T, r, q, sigma, isCall);
        const diff = price - marketPrice;
        if (Math.abs(diff) < tol) return sigma;
        const v = vega(S, K, T, r, q, sigma);
        if (v < 1e-10) break;
        sigma = sigma - diff / v;
        if (sigma <= 0 || sigma > 5.0) break;
    }

    // Bisection fallback over [0.001, 5.0]
    let lo = 0.001, hi = 5.0;
    for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        const price = bsPrice(S, K, T, r, q, mid, isCall);
        if (Math.abs(price - marketPrice) < tol) return mid;
        if (price < marketPrice) lo = mid; else hi = mid;
        if (hi - lo < 1e-8) return mid;
    }
    return null;
}
