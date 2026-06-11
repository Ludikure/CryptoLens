// Phase 2 + 3 (risk platform) — pure risk math on top of the HAR-RV vol forecast.
// Stop quality (noise-hit first-passage), VaR / Expected Shortfall (Gaussian + fat-tail
// empirical), liquidation distance, fee-aware breakeven. All DIRECTION-AGNOSTIC — arithmetic
// on σ (the forecast vol) + the position the USER chooses. Unit-tested; no I/O.

// Standard normal CDF — Abramowitz & Stegun 7.1.26 (|err| < 7.5e-8).
export function normCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
}

// ── Phase 2 — Stop Quality ─────────────────────────────────────────────────
// P(stop touched by NOISE over the horizon), driftless first-passage. d = |log(stop/entry)|
// in return units; σ = horizon forecast vol. Reflection principle: P(min ≤ −d) = 2·Φ(−d/σ).
// Direction-agnostic: works for a long stop below or a short stop above.
export function noiseHitProb(entry: number, stop: number, sigma: number): number {
    if (!(entry > 0) || !(stop > 0) || !(sigma > 0)) return NaN;
    const d = Math.abs(Math.log(stop / entry));
    return Math.min(1, 2 * normCdf(-d / sigma));
}

export interface StopQuality {
    noiseHit: number;                       // 0..1 probability noise alone hits the stop
    rating: 'TIGHT' | 'OK' | 'WIDE';        // TIGHT = high noise-hit (bad), WIDE = safe
    distSigma: number;                      // stop distance in σ multiples
}
export function stopQuality(entry: number, stop: number, sigma: number): StopQuality {
    const noiseHit = noiseHitProb(entry, stop, sigma);
    const distSigma = sigma > 0 ? Math.abs(Math.log(stop / entry)) / sigma : Infinity;
    const rating = noiseHit >= 0.33 ? 'TIGHT' : noiseHit >= 0.15 ? 'OK' : 'WIDE';
    return { noiseHit, rating, distSigma };
}

// ── Phase 3 — VaR / Expected Shortfall ─────────────────────────────────────
// Gaussian quantiles for reference + EMPIRICAL fat-tail figures using the vol model's
// calibrated band multipliers (crypto 95%≈2.20σ / 99%≈3.51σ, well past Gaussian 1.645/2.326).
// The empirical numbers are the honest ones for crypto; Gaussian is shown as the (under-)bound.
export interface VaRResult {
    var95: number; var99: number; es95: number;        // Gaussian (reference)
    var95emp: number; var99emp: number;                // empirical fat-tail (primary for crypto)
}
export function valueAtRisk(positionValue: number, sigma: number,
                            mult: { s2: number; s99: number }): VaRResult {
    const pv = Math.abs(positionValue);
    return {
        var95: pv * sigma * 1.645,
        var99: pv * sigma * 2.326,
        es95: pv * sigma * 2.0623,                      // φ(1.645)/0.05
        var95emp: pv * sigma * mult.s2,
        var99emp: pv * sigma * mult.s99,
    };
}

// Liquidation price + distance in σ multiples for a leveraged position. Approximate
// (ignores maintenance-margin buffer / fees): long liq ≈ entry·(1−1/L), short ≈ entry·(1+1/L).
export function liqDistance(entry: number, leverage: number, sigma: number,
                            dir: 'long' | 'short'): { liqPrice: number; sigmaMult: number } {
    if (!(leverage > 0)) return { liqPrice: NaN, sigmaMult: NaN };
    const liqPrice = entry * (dir === 'long' ? 1 - 1 / leverage : 1 + 1 / leverage);
    const sigmaMult = sigma > 0 && liqPrice > 0 ? Math.abs(Math.log(liqPrice / entry)) / sigma : Infinity;
    return { liqPrice, sigmaMult };
}

// ── Phase 3 — Fee-aware breakeven ──────────────────────────────────────────
// Round-trip fee by venue (the project's most expensive lesson, operationalized). The
// breakeven move = the round-trip fee fraction. Keyed config, easily updated.
export const VENUE_FEES: Record<string, { roundTrip: number; label: string }> = {
    binance:      { roundTrip: 0.0010, label: 'Binance' },            // ~0.07–0.13% taker RT
    coinbase_adv: { roundTrip: 0.0026, label: 'Coinbase Adv' },       // 0.23–0.28%
    coinbase_intx:{ roundTrip: 0.0023, label: 'Coinbase Intro-1 perp' }, // user's venue
    robinhood:    { roundTrip: 0.0200, label: 'Robinhood (spread)' },  // 1–5%, conservative 2%
};
export function breakeven(venue: string): { roundTrip: number; label: string } | null {
    return VENUE_FEES[venue] ?? null;
}

// Full position risk report — combines the pieces given a vol σ (24h forecast) + position.
export interface PositionInput {
    entry: number; stop?: number; positionValue: number;
    leverage?: number; dir?: 'long' | 'short'; venue?: string;
}
export function positionRisk(p: PositionInput, sigma: number, mult: { s2: number; s99: number }) {
    const dir = p.dir ?? 'long';
    return {
        sigma,
        stop: p.stop != null ? stopQuality(p.entry, p.stop, sigma) : null,
        var: valueAtRisk(p.positionValue, sigma, mult),
        liq: p.leverage != null ? liqDistance(p.entry, p.leverage, sigma, dir) : null,
        fees: p.venue ? breakeven(p.venue) : null,
    };
}
