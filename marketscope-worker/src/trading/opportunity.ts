/**
 * Opportunity scoring and ranking (spec §3, §8).
 *
 * The ranking metric is NOT model probability. Spec §8 says so, and the research says why: T20 found
 * the ML model beats a one-line realised-volatility rule by +0.022 AUC on fresh assets — real, and
 * far too small to rank trades by. What CAN be ranked honestly is expected value, which is dominated
 * by payoff geometry (deterministic) and excursion probability (partly predictable), with direction
 * contributing very little.
 *
 * A worked illustration of why probability alone is the wrong metric — spec §3's four cases:
 *
 *   P(win)  win_R  loss_R   EV        which is "better"?
 *    0.70    1.0     1.0   +0.40      high probability, poor payoff
 *    0.20    5.0     1.0   +0.20      low probability, excellent payoff
 *    0.55    2.0     1.0   +0.65      the actual winner
 *    0.35    1.2     1.0   −0.23      negative despite a decent-looking hit rate
 *
 * Ranking by probability puts the 0.70 first. Ranking by EV puts the 0.55 first, which is correct.
 */

import type { PayoffEstimate, TradeCandidate } from './candidate';
import { structureR, isValidGeometry, type Direction } from './candidate';

/** Expected value in R. Never assumes a 1:1 payoff (spec §3). */
export function expectedValueR(winProbability: number, averageWinR: number, averageLossR: number): number {
  const p = Math.min(Math.max(winProbability, 0), 1);
  return p * averageWinR - (1 - p) * averageLossR;
}

/**
 * Net expected value after round-trip cost, converted from percent-of-notional into R.
 *
 * The conversion is the part that matters and is easy to get wrong: a 0.171% round trip costs far
 * more in R terms when the stop is tight. With a 1% stop it is 0.171R; with a 5% stop, 0.034R. This
 * is why the same fee schedule kills some structures and not others.
 */
export function netExpectedValueR(
  grossEvR: number,
  roundTripPercent: number,
  stopDistancePercent: number,
): number {
  if (!(stopDistancePercent > 0)) return grossEvR;
  return grossEvR - roundTripPercent / stopDistancePercent;
}

/** Build a payoff estimate from a structure plus an excursion probability. */
export function buildPayoff(args: {
  winProbability: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  direction: Direction;
  confidence: number;
  roundTripPercent: number;
}): PayoffEstimate {
  const winR = structureR(args.entryPrice, args.stopPrice, args.targetPrice, args.direction);
  const lossR = 1;                               // by definition: one R is the stop
  const stopPct = Math.abs(args.entryPrice - args.stopPrice) / args.entryPrice * 100;
  const gross = expectedValueR(args.winProbability, winR, lossR);
  return {
    winProbability: args.winProbability,
    averageWinR: winR,
    averageLossR: lossR,
    expectedValueR: netExpectedValueR(gross, args.roundTripPercent, stopPct),
    payoffAsymmetry: winR / lossR,
    confidence: args.confidence,
  };
}

/**
 * Scoring weights. Isolated and configurable per spec §8, and versioned so a change is visible in
 * the trade journal rather than silently altering historical comparability.
 */
export interface ScoringConfig {
  readonly id: string;
  /** Multiplies EV. The dominant term by design. */
  evWeight: number;
  /** Rewards lopsided structures independently of probability — convexity survives fee drag better. */
  asymmetryWeight: number;
  /** Discounts low-confidence estimates without letting confidence create an opportunity. */
  confidenceWeight: number;
  /** Penalty per unit of crash probability. Ranking-only; sizing handles the real reduction. */
  crashPenalty: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  id: 'default-2026-08-24',
  evWeight: 1.0,
  asymmetryWeight: 0.05,
  confidenceWeight: 0.15,
  crashPenalty: 0.10,
};

/**
 * The ranking score.
 *
 * Anchored on expected value so it stays interpretable in R. The other terms are deliberately small:
 * they break ties between similar EVs rather than overriding them, because none of them has
 * independent evidence of predicting returns.
 *
 * Crash risk appears here only as a mild ranking penalty. The material reduction happens in sizing
 * (spec §7) — double-counting it would let a risk signal suppress an opportunity it should merely
 * shrink.
 */
export function opportunityScore(
  payoff: PayoffEstimate,
  crashProbability: number,
  cfg: ScoringConfig = DEFAULT_SCORING,
): number {
  if (payoff.expectedValueR <= 0) return payoff.expectedValueR;
  return payoff.expectedValueR * cfg.evWeight
    + (payoff.payoffAsymmetry - 1) * cfg.asymmetryWeight
    + (payoff.confidence - 0.5) * cfg.confidenceWeight
    - crashProbability * cfg.crashPenalty;
}

/**
 * Rank candidates. Anything with non-positive expected value is dropped, not ranked last — the
 * system must be comfortable returning an empty list (spec §15).
 */
export function rankCandidates(
  candidates: TradeCandidate[],
  cfg: ScoringConfig = DEFAULT_SCORING,
): TradeCandidate[] {
  return candidates
    .filter(c => isValidGeometry(c) && c.payoff.expectedValueR > 0 && c.recommendedPositionFraction > 0)
    .map(c => ({ ...c, riskAdjustedScore: opportunityScore(c.payoff, c.crashRisk.probability, cfg) }))
    .sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);
}

/**
 * Pick a side when both directions are viable.
 *
 * Returns null on a near-tie ON PURPOSE. Given a measured coin-flip on direction, a marginal EV gap
 * between LONG and SHORT is noise, and presenting it as a choice would manufacture false confidence.
 * The caller should treat null as "no directional view" rather than as an error.
 */
export function chooseDirection(
  longCandidate: TradeCandidate | null,
  shortCandidate: TradeCandidate | null,
  minEdgeR = 0.05,
): TradeCandidate | null {
  if (!longCandidate) return shortCandidate;
  if (!shortCandidate) return longCandidate;
  const gap = longCandidate.payoff.expectedValueR - shortCandidate.payoff.expectedValueR;
  if (Math.abs(gap) < minEdgeR) return null;
  return gap > 0 ? longCandidate : shortCandidate;
}
