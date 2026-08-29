/**
 * Evaluation metrics for the research harness (spec §19, §24).
 *
 * Two families, and the separation is deliberate:
 *
 *   PERFORMANCE   what a return series did — CAGR, drawdown, Calmar, Sharpe, Sortino, turnover.
 *   DISCRIMINATION whether a score ranked outcomes correctly — AUC, and specifically BOTH axes.
 *
 * ⚠️ THE STANDING REQUIREMENT. On 2026-08-24 a pruned model was validated three separate times on
 * **per-symbol time-series AUC** (+0.0015, non-inferior) and shipped, then reverted within the hour:
 * its **within-timestamp AUC** had collapsed from 0.7607 to 0.6586 — a −0.1021 loss, roughly 70× the
 * per-symbol gain. Cross-sectional spread halved.
 *
 * The app ranks ~76 symbols side by side, so within-timestamp discrimination is the axis the product
 * depends on, and nothing in the standard metric set measured it. `discrimination()` therefore
 * returns both, and the harness reports both. A model change evaluated on only one of them has not
 * been evaluated.
 */

// ── performance ───────────────────────────────────────────────────────────────

export interface PerformanceMetrics {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  calmar: number;
  sharpe: number;
  sortino: number;
  volatility: number;
  /** Fraction of periods spent below a prior equity peak. */
  timeUnderwater: number;
  /** Longest run of periods below a prior peak. */
  longestDrawdownPeriods: number;
  periods: number;
}

const PERIODS_PER_YEAR = 365.25;

export function performance(returns: readonly number[], periodsPerYear = PERIODS_PER_YEAR): PerformanceMetrics {
  const n = returns.length;
  if (n === 0) {
    return { totalReturn: 0, cagr: NaN, maxDrawdown: NaN, calmar: NaN, sharpe: NaN,
             sortino: NaN, volatility: NaN, timeUnderwater: NaN, longestDrawdownPeriods: 0, periods: 0 };
  }

  let equity = 1, peak = 1, maxDd = 0, underwater = 0, run = 0, longestRun = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) { peak = equity; run = 0; }
    else { run++; longestRun = Math.max(longestRun, run); underwater++; }
    maxDd = Math.min(maxDd, equity / peak - 1);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const downside = returns.filter(r => r < 0);
  // Downside deviation uses the root-mean-square of NEGATIVE returns only, and is defined for a
  // single observation — requiring n>1 silently returned NaN for low-drawdown series.
  const downsideSd = downside.length > 0
    ? Math.sqrt(downside.reduce((a, b) => a + b ** 2, 0) / downside.length)
    : 0;

  const years = n / periodsPerYear;
  const cagr = equity > 0 && years > 0 ? equity ** (1 / years) - 1 : NaN;

  return {
    totalReturn: equity - 1,
    cagr,
    maxDrawdown: maxDd,
    // Calmar is undefined without a drawdown; NaN is the honest answer, not Infinity.
    calmar: maxDd < 0 ? cagr / Math.abs(maxDd) : NaN,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : NaN,
    sortino: downsideSd > 0 ? (mean / downsideSd) * Math.sqrt(periodsPerYear) : NaN,
    volatility: sd * Math.sqrt(periodsPerYear),
    timeUnderwater: underwater / n,
    longestDrawdownPeriods: longestRun,
    periods: n,
  };
}

/** Annualised turnover from a weight series: sum |Δw| scaled to a year. */
export function turnover(weights: readonly number[], periodsPerYear = PERIODS_PER_YEAR): number {
  if (weights.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < weights.length; i++) sum += Math.abs(weights[i] - weights[i - 1]);
  return sum / (weights.length / periodsPerYear);
}

/**
 * Apply a round-trip cost to a weight series (spec §22).
 *
 * Charged on the CHANGE in exposure, which is what actually trades. Reporting a strategy at a single
 * friction level is how the T8-era numbers looked better than they were; the harness sweeps.
 */
export function applyCosts(
  returns: readonly number[],
  weights: readonly number[],
  roundTripFraction: number,
): number[] {
  return returns.map((r, i) => {
    const delta = i === 0 ? Math.abs(weights[0] ?? 0) : Math.abs((weights[i] ?? 0) - (weights[i - 1] ?? 0));
    return r - delta * roundTripFraction;
  });
}

// ── discrimination ────────────────────────────────────────────────────────────

export interface Observation {
  timestamp: number;
  asset: string;
  score: number;
  outcome: 0 | 1;
}

export function auc(scores: readonly number[], outcomes: readonly (0 | 1)[]): number {
  const pos = scores.filter((_, i) => outcomes[i] === 1);
  const neg = scores.filter((_, i) => outcomes[i] === 0);
  if (pos.length === 0 || neg.length === 0) return NaN;
  // Mann-Whitney U with tie handling: rank the pooled sample.
  const all = scores.map((s, i) => ({ s, o: outcomes[i] })).sort((a, b) => a.s - b.s);
  const ranks = new Array(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].s === all[i].s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let rankSumPos = 0;
  all.forEach((x, idx) => { if (x.o === 1) rankSumPos += ranks[idx]; });
  const nP = pos.length, nN = neg.length;
  return (rankSumPos - (nP * (nP + 1)) / 2) / (nP * nN);
}

export interface DiscriminationMetrics {
  /** Mean AUC computed WITHIN each asset's time series. The conventional metric. */
  perSymbolAuc: number;
  /**
   * Mean AUC computed WITHIN each timestamp, across assets. The axis a ranking product depends on,
   * and the one whose absence let a bad prune pass three validations.
   */
  withinTimestampAuc: number;
  /** Mean cross-sectional standard deviation of scores — can the model tell assets apart at all? */
  crossSectionalSpread: number;
  /** Realised positive rate in the top decile of score. */
  topDecilePrecision: number;
  perSymbol: Record<string, number>;
  timestampsEvaluated: number;
}

/**
 * Both axes, always. `minPerGroup` guards against reading a 2-observation "AUC" as information.
 */
export function discrimination(obs: readonly Observation[], minPerGroup = 5): DiscriminationMetrics {
  const byAsset: Record<string, Observation[]> = {};
  const byTime: Record<number, Observation[]> = {};
  for (const o of obs) {
    (byAsset[o.asset] ??= []).push(o);
    (byTime[o.timestamp] ??= []).push(o);
  }

  const perSymbol: Record<string, number> = {};
  for (const [asset, rows] of Object.entries(byAsset)) {
    if (rows.length < minPerGroup) continue;
    const a = auc(rows.map(r => r.score), rows.map(r => r.outcome));
    if (!Number.isNaN(a)) perSymbol[asset] = a;
  }

  const tsAucs: number[] = [];
  const spreads: number[] = [];
  for (const rows of Object.values(byTime)) {
    if (rows.length < minPerGroup) continue;
    const a = auc(rows.map(r => r.score), rows.map(r => r.outcome));
    if (!Number.isNaN(a)) tsAucs.push(a);
    const scores = rows.map(r => r.score);
    const m = scores.reduce((x, y) => x + y, 0) / scores.length;
    spreads.push(Math.sqrt(scores.reduce((x, y) => x + (y - m) ** 2, 0) / scores.length));
  }

  const sorted = [...obs].sort((a, b) => b.score - a.score);
  const topN = Math.max(1, Math.floor(sorted.length * 0.1));
  const top = sorted.slice(0, topN);

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    perSymbolAuc: mean(Object.values(perSymbol)),
    withinTimestampAuc: mean(tsAucs),
    crossSectionalSpread: mean(spreads),
    topDecilePrecision: top.reduce((a, b) => a + b.outcome, 0) / top.length,
    perSymbol,
    timestampsEvaluated: tsAucs.length,
  };
}
