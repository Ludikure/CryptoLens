// Live ML calibration refit (2026-08-21) — the honest replacement for the 35/65 bucket blend.
//
// The model JSONs ship a STATIC isotonic calibration fit at training time. It drifts: by
// Aug 2026 the live forward-graded curve (ml_calibration D1) was compressed to ~41→69%
// while predictions spanned 25→77% — the 30-50% bucket was realizing ~60%. The interim
// 35/65 blend (2026-07-02 → 2026-08-14) corrected per coarse bucket but kept 35% of the
// stale raw scale, so a raw 39% still gated as ~52% when the live truth was ~60%.
//
// This module fits a fresh monotone mapping raw → realized on the live forward data:
// weighted PAV (pool-adjacent-violators) over fine (5pp) prediction buckets, applied via
// piecewise-linear interpolation. Self-updating — refit from D1 on every use, so regime
// shifts are absorbed without retraining. Pure math here; the D1 bucket query lives in
// index.ts (fetchLiveCalBuckets).
//
// Honesty note: the mapping CLAMPS at the top bucket's realized rate. If the live curve's
// best bucket only realizes ~69%, no raw score maps above ~69% — a threshold set at 70
// then never passes. That is the honest read, not a bug; the threshold is the dial.

/** One fine prediction bucket from ml_calibration D1. Rates are 0-1. */
export interface CalBucket { predMean: number; realized: number; n: number }

/** A fitted curve point: raw prediction x maps to realized rate y (both 0-1). */
export interface CalPoint { x: number; y: number; n: number }

/** Buckets thinner than this are noise — dropped before the fit. */
export const CAL_MIN_BUCKET_N = 40;
/** Below this many total graded samples the live curve isn't trustworthy — fit returns null
 *  and callers fall back to the raw (embedded-calibration) probability. */
export const CAL_MIN_TOTAL_N = 300;

/**
 * Weighted PAV isotonic fit: enforce realized nondecreasing in predicted by pooling
 * adjacent violating buckets (n-weighted means). Returns null when the data is too thin
 * (< 2 usable buckets or < CAL_MIN_TOTAL_N samples) — callers then serve raw unchanged.
 */
export function fitCalibrationCurve(buckets: CalBucket[]): CalPoint[] | null {
  const pts = buckets
    .filter(b => b.n >= CAL_MIN_BUCKET_N && Number.isFinite(b.predMean) && Number.isFinite(b.realized))
    .sort((a, b) => a.predMean - b.predMean);
  const total = pts.reduce((s, b) => s + b.n, 0);
  if (pts.length < 2 || total < CAL_MIN_TOTAL_N) return null;
  // Stack-based PAV on (sum-x, sum-y, n) blocks; a block's value is its weighted mean.
  const stack: Array<{ sx: number; sy: number; n: number }> = [];
  for (const p of pts) {
    stack.push({ sx: p.predMean * p.n, sy: p.realized * p.n, n: p.n });
    while (stack.length >= 2) {
      const b = stack[stack.length - 1], a = stack[stack.length - 2];
      if (a.sy / a.n <= b.sy / b.n) break;          // monotone — done pooling
      stack.pop(); stack.pop();
      stack.push({ sx: a.sx + b.sx, sy: a.sy + b.sy, n: a.n + b.n });
    }
  }
  return stack.map(b => ({ x: b.sx / b.n, y: b.sy / b.n, n: b.n }));
}

/**
 * Map a raw (embedded-calibration) probability through the fitted live curve.
 * Piecewise-linear between fitted points; clamped to the end points outside the fitted
 * range — extrapolating beyond observed data would claim precision the data doesn't have.
 */
export function applyCalibration(curve: CalPoint[], raw: number): number {
  if (!curve.length) return raw;
  if (raw <= curve[0].x) return curve[0].y;
  const last = curve[curve.length - 1];
  if (raw >= last.x) return last.y;
  for (let i = 1; i < curve.length; i++) {
    if (raw <= curve[i].x) {
      const a = curve[i - 1], b = curve[i];
      const t = (raw - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return last.y;   // unreachable, but keeps the function total
}
