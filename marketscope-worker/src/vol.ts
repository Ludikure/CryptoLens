// Phase 1 (risk platform) — HAR-RV volatility forecaster.
// Predicts forward realized vol (4h/24h/72h) from trailing RV components (24h/7d/30d of
// 1H log-returns), then converts to calibrated price bands. Direction-AGNOSTIC: it answers
// "how big a move", never "which way". Gate-validated (ml-training/train_vol_v1.py): crypto
// 24h OOS R²=0.37 (> 0.35 gate), coverage near-calibrated; band multipliers are EMPIRICAL
// (separate 68/95/99 percentiles of |move|/σ) to handle crypto fat tails — Gaussian 1.96/2.58
// under-covers. Model coeffs + multipliers live in ml-vol-crypto.json. Crypto-only for now
// (stock RV needs a market-hours-aware window; not yet trained).
import cryptoVol from './ml-vol-crypto.json';

type HorizonModel = {
    beta: { intercept: number; rv_24h: number; rv_7d: number; rv_30d: number };
    band_mult: { s1: number; s2: number; s99: number };
};
const CV = cryptoVol as { comp_bars: Record<string, number>; horizon_bars: Record<string, number>;
                          horizons: Record<string, HorizonModel> };

/// Realized vol over the last `w` bars = sqrt(Σ logret²). Needs ≥ w+1 closes. null otherwise.
export function realizedVol(closes: number[], w: number): number | null {
    if (closes.length < w + 1) return null;
    const s = closes.slice(closes.length - w - 1);
    let sum = 0;
    for (let i = 1; i < s.length; i++) { const r = Math.log(s[i] / s[i - 1]); sum += r * r; }
    return Math.sqrt(sum);
}

/// HAR-RV forecast of forward realized vol (fractional) for a horizon, from the 3 components.
export function predictSigma(rv24: number, rv7d: number, rv30d: number, horizon: string): number | null {
    const m = CV.horizons[horizon];
    if (!m) return null;
    const b = m.beta;
    const s = b.intercept + b.rv_24h * rv24 + b.rv_7d * rv7d + b.rv_30d * rv30d;
    return s > 0 ? s : null;
}

export interface VolBand { sigma: number; s1: [number, number]; s2: [number, number]; s99: [number, number]; }
/// Convert a forecast σ (log-return scale) to price bands at `price`, using the horizon's
/// empirical multipliers. Bands are multiplicative (exp) since σ is in log-return units.
export function volBands(price: number, sigma: number, horizon: string): VolBand | null {
    const m = CV.horizons[horizon];
    if (!m || !(price > 0) || !(sigma > 0)) return null;
    const band = (mult: number): [number, number] =>
        [price * Math.exp(-mult * sigma), price * Math.exp(mult * sigma)];
    return { sigma, s1: band(m.band_mult.s1), s2: band(m.band_mult.s2), s99: band(m.band_mult.s99) };
}

export interface VolForecast { horizons: Record<string, VolBand>; rv: { h24: number; d7: number; d30: number }; }
/// Full forecast from a 1H close series (needs ≥ 721 closes for the 30d component) + current price.
/// Crypto-only (isCrypto must be true). Returns null on insufficient data / stocks.
export function forecastVol(closes1h: number[], isCrypto: boolean, price: number): VolForecast | null {
    if (!isCrypto) return null;
    const rv24 = realizedVol(closes1h, CV.comp_bars['24h']);
    const rv7d = realizedVol(closes1h, CV.comp_bars['7d']);
    const rv30 = realizedVol(closes1h, CV.comp_bars['30d']);
    if (rv24 == null || rv7d == null || rv30 == null) return null;
    const horizons: Record<string, VolBand> = {};
    for (const h of Object.keys(CV.horizons)) {
        const sig = predictSigma(rv24, rv7d, rv30, h);
        if (sig == null) continue;
        const b = volBands(price, sig, h);
        if (b) horizons[h] = b;
    }
    if (!Object.keys(horizons).length) return null;
    return { horizons, rv: { h24: rv24, d7: rv7d, d30: rv30 } };
}
