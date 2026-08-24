/**
 * Portfolio allocation across a ranked candidate list (spec §10, Phase 3).
 *
 * `sizePosition` enforces limits for ONE candidate against a fixed portfolio state. That is not
 * enough: allocating a ranked list requires the state to evolve as each position is taken, or the
 * limits are computed against a portfolio that no longer exists by the time the third candidate is
 * sized.
 *
 * WHY THIS MATTERS MORE IN CRYPTO THAN IT SOUNDS. T7 measured mean pairwise correlation across the
 * twelve liquid crypto symbols at **0.62**, versus 0.32 for a mixed multi-asset universe. A
 * portfolio of "five different crypto trades" is closer to one bet held five times, and that is
 * precisely how the regime-hold test ended up with an −82% drawdown while looking diversified. The
 * correlated-exposure limit is the mechanism that prevents the ranking from quietly rebuilding that
 * concentration, one high-scoring candidate at a time.
 */

import type { TradeCandidate } from './candidate';
import { sizePosition, DEFAULT_LIMITS, type PortfolioState, type RiskLimits, type SizingResult } from './sizing';
import { PLACEHOLDER_CURVE, type SizingCurve } from './crash-risk';

export interface Allocation {
  candidate: TradeCandidate;
  sizing: SizingResult;
}

export interface AllocationResult {
  accepted: Allocation[];
  /** Candidates the portfolio could not fit, each with the constraint that stopped it. */
  rejected: Array<{ candidate: TradeCandidate; reasons: string[] }>;
  /** Portfolio state after all allocations — the caller's new baseline. */
  finalState: PortfolioState;
  totals: {
    riskFraction: number;
    notionalFraction: number;
    positions: number;
    /** Correlation-weighted exposure: what the book is really worth as a single bet. */
    effectiveBets: number;
  };
}

export interface AllocateInput {
  /** Ranked, best first. `rankCandidates` produces this ordering. */
  ranked: readonly TradeCandidate[];
  state: PortfolioState;
  liquidityByAsset: Record<string, number>;
  limits?: RiskLimits;
  curve?: SizingCurve;
}

/**
 * Effective number of independent bets, given average pairwise correlation.
 *
 * n / (1 + (n−1)·ρ̄) — the standard diversification-ratio result. At ρ̄ = 0.62 (T7's measured crypto
 * figure) five positions are worth about 1.5 independent bets. Surfaced so the UI can say that
 * rather than implying five.
 */
export function effectiveBets(assets: readonly string[], correlations: PortfolioState['correlations']): number {
  const n = assets.length;
  if (n <= 1) return n;
  let sum = 0, pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sum += Math.abs(correlations[assets[i]]?.[assets[j]] ?? 0);
      pairs++;
    }
  }
  const avg = pairs > 0 ? sum / pairs : 0;
  const denom = 1 + (n - 1) * avg;
  return denom > 0 ? n / denom : n;
}

/**
 * Allocate down the ranked list, updating portfolio state after every accepted position.
 *
 * Order matters and is deliberately the ranking order: the best opportunity gets first claim on the
 * shared limits. A candidate rejected here is not a bad trade — it is a trade the book cannot
 * currently hold — and the reasons are preserved so the UI can distinguish the two.
 */
export function allocatePortfolio(input: AllocateInput): AllocationResult {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const curve = input.curve ?? PLACEHOLDER_CURVE;

  // Work on a copy: allocation must never mutate the caller's state.
  const state: PortfolioState = {
    equity: input.state.equity,
    openNotionalByAsset: { ...input.state.openNotionalByAsset },
    correlations: input.state.correlations,
  };

  const accepted: Allocation[] = [];
  const rejected: AllocationResult['rejected'] = [];

  for (const candidate of input.ranked) {
    const sizing = sizePosition({
      asset: candidate.asset,
      direction: candidate.direction,
      entryPrice: candidate.entryPrice,
      stopPrice: candidate.stopPrice,
      expectedValueR: candidate.payoff.expectedValueR,
      crashRisk: candidate.crashRisk,
      liquidityUsd24h: input.liquidityByAsset[candidate.asset] ?? 0,
      portfolio: state,
      limits,
      curve,
    });

    if (sizing.riskFraction <= 0) {
      rejected.push({ candidate, reasons: sizing.bindingConstraints });
      continue;
    }

    // Commit before sizing the next candidate, so shared limits are computed against reality.
    state.openNotionalByAsset[candidate.asset] =
      (state.openNotionalByAsset[candidate.asset] ?? 0) + sizing.notionalFraction;

    accepted.push({
      candidate: { ...candidate, recommendedPositionFraction: sizing.riskFraction },
      sizing,
    });
  }

  const assets = accepted.map(a => a.candidate.asset);
  return {
    accepted,
    rejected,
    finalState: state,
    totals: {
      riskFraction: accepted.reduce((a, x) => a + x.sizing.riskFraction, 0),
      notionalFraction: accepted.reduce((a, x) => a + x.sizing.notionalFraction, 0),
      positions: accepted.length,
      effectiveBets: effectiveBets(assets, state.correlations),
    },
  };
}

/**
 * Total portfolio loss if every open stop fills at once.
 *
 * Not a tail scenario in crypto — correlated assets gap together, which is exactly what a
 * correlation-blind book discovers the hard way. Reported so the sum is visible before it happens
 * rather than after.
 */
export function simultaneousStopLoss(accepted: readonly Allocation[]): number {
  return accepted.reduce((a, x) => a + x.sizing.riskFraction, 0);
}
