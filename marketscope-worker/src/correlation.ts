// Phase 7 (risk platform) — portfolio correlation. Pairwise daily-return correlations across a
// watchlist + effective number of INDEPENDENT positions + net beta to a benchmark (BTC for
// crypto). Direction-agnostic concentration risk: "your 5 alts are 0.9 correlated to BTC →
// effective positions 1.3 → your aggregate VaR is far bigger than the per-position numbers say."

export function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return NaN;
  const A = a.slice(a.length - n), B = b.slice(b.length - n);
  const ma = A.reduce((s, x) => s + x, 0) / n, mb = B.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = A[i] - ma, db = B[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
}

// β of asset returns vs benchmark returns (slope of asset on benchmark).
export function beta(asset: number[], bench: number[]): number {
  const n = Math.min(asset.length, bench.length);
  if (n < 5) return NaN;
  const A = asset.slice(asset.length - n), B = bench.slice(bench.length - n);
  const ma = A.reduce((s, x) => s + x, 0) / n, mb = B.reduce((s, x) => s + x, 0) / n;
  let cov = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (A[i] - ma) * (B[i] - mb); vb += (B[i] - mb) ** 2; }
  return vb > 0 ? cov / vb : NaN;
}

// Effective independent positions for an equal-weight book with average pairwise correlation ρ:
// N_eff = N / (1 + (N−1)·ρ). ρ→1 collapses N positions to ~1; ρ→0 keeps them independent.
export function effectivePositions(avgCorr: number, n: number): number {
  if (n <= 1) return n;
  const denom = 1 + (n - 1) * Math.max(0, Math.min(1, avgCorr));
  return denom > 0 ? n / denom : n;
}

// Build the full report from per-symbol close arrays. `benchmark` (e.g. BTCUSDT) drives β + the
// "avg correlation to benchmark" headline; falls back to the first symbol.
export interface CorrReport {
  benchmark: string;
  symbols: string[];
  matrix: number[][];                              // pairwise correlation matrix (rounded)
  avgCorrToBenchmark: number;
  avgPairwise: number;
  effectivePositions: number;
  betaToBenchmark: Record<string, number>;
}
export function correlationReport(closesBySymbol: Record<string, number[]>, benchmark: string): CorrReport | null {
  const symbols = Object.keys(closesBySymbol).filter(s => logReturns(closesBySymbol[s]).length >= 5);
  if (symbols.length < 2) return null;
  const bench = symbols.includes(benchmark) ? benchmark : symbols[0];
  const rets: Record<string, number[]> = {};
  for (const s of symbols) rets[s] = logReturns(closesBySymbol[s]);
  const matrix = symbols.map(a => symbols.map(b => Math.round(pearson(rets[a], rets[b]) * 1000) / 1000));
  const benchIdx = symbols.indexOf(bench);
  const others = symbols.filter(s => s !== bench);
  const avgCorrToBenchmark = others.length
    ? others.reduce((s, o) => s + (matrix[benchIdx][symbols.indexOf(o)] || 0), 0) / others.length : 1;
  // average of off-diagonal pairwise correlations
  let sum = 0, cnt = 0;
  for (let i = 0; i < symbols.length; i++) for (let j = i + 1; j < symbols.length; j++) { sum += matrix[i][j]; cnt++; }
  const avgPairwise = cnt ? sum / cnt : 1;
  const betaToBenchmark: Record<string, number> = {};
  for (const s of symbols) betaToBenchmark[s] = Math.round(beta(rets[s], rets[bench]) * 100) / 100;
  return {
    benchmark: bench, symbols, matrix,
    avgCorrToBenchmark: Math.round(avgCorrToBenchmark * 1000) / 1000,
    avgPairwise: Math.round(avgPairwise * 1000) / 1000,
    effectivePositions: Math.round(effectivePositions(avgPairwise, symbols.length) * 100) / 100,
    betaToBenchmark,
  };
}
