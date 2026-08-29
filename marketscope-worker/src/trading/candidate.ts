/**
 * TradeCandidate — the canonical object every part of the trading pipeline passes around.
 *
 * DESIGN NOTE, and it is the load-bearing one. The refactor spec asks the opportunity model to
 * estimate `P(win)` for a LONG-vs-SHORT candidate. Taken literally that is directional prediction,
 * which this project has measured as a coin flip across 12 primitives, 2 dedicated models, 8
 * conditional states and every horizon from 4h to 30d (docs/research/what-we-tried.md, mode 1).
 *
 * So the interfaces below deliberately do NOT assume a directional edge. `winProbability` is defined
 * as **P(the payoff structure resolves favourably)** — dominated by excursion probability and stop
 * placement, not by knowing which way price goes. A model that genuinely cannot pick a side still
 * produces a valid candidate: the edge lives in `expectedValueR`, which is driven by payoff geometry
 * and tail probability. Direction selects a side of an inherently two-sided setup.
 *
 * This is the convex structure that measured +0.151R gross (docs/research/strategy-breakeven.md) —
 * expressed as a type so no downstream component can quietly reintroduce a directional claim.
 */

export type Direction = 'LONG' | 'SHORT';

/**
 * Provenance. Every displayed trade must be traceable to the exact data and model that produced it,
 * and every timestamp exists so the anti-lookahead invariant can be CHECKED rather than assumed.
 * See `assertNoLookahead` in ./provenance.
 */
export interface Provenance {
  /** When the underlying market data was observed. */
  dataTimestamp: number;
  /** When the feature vector was computed. Must be <= decisionTimestamp. */
  featureTimestamp: number;
  /** When the trade decision was made — the moment a real trader could have acted. */
  decisionTimestamp: number;
  /** Identifier of the model that produced the opportunity estimate. */
  modelVersion: string;
  /** Identifier of the crash model, tracked separately: it versions independently. */
  crashModelVersion: string;
  /** Named, frozen config used for sizing. Changing it must change this string. */
  sizingConfigId: string;
}

/** What the opportunity model believes about the payoff distribution. */
export interface PayoffEstimate {
  /**
   * P(the structure resolves favourably) — NOT P(price goes up). See the file header.
   * Kept explicitly separate from direction so the two cannot be conflated.
   */
  winProbability: number;
  /** Average favourable outcome in R, conditional on winning. Never assume 1:1. */
  averageWinR: number;
  /** Average adverse outcome in R, conditional on losing. Positive number. */
  averageLossR: number;
  /** winProbability*averageWinR - (1-winProbability)*averageLossR, net of costs. */
  expectedValueR: number;
  /** averageWinR / averageLossR — how lopsided the structure is, independent of probability. */
  payoffAsymmetry: number;
  /**
   * The model's own confidence, on [0,1]. Deliberately distinct from winProbability: a well-
   * calibrated 0.5 with high confidence is a different object from an uncertain 0.5.
   */
  confidence: number;
}

/** Forward extreme-drawdown risk. A SIZING input — never a reason to open or flip a trade. */
export interface CrashRisk {
  probability: number;
  regime: 'LOW' | 'ELEVATED' | 'HIGH' | 'EXTREME';
  confidence: number;
  /** Days over which the estimate applies — the model's label horizon, not a guess. */
  horizonDays: number;
}

export interface TradeCandidate {
  asset: string;
  direction: Direction;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  holdingHorizonHours: number;

  payoff: PayoffEstimate;
  crashRisk: CrashRisk;

  /** Raw model output before any risk adjustment — kept for provenance and debugging. */
  signalStrength: number;
  /** The ranking metric. NOT a probability, and never displayed as one. See ./opportunity. */
  riskAdjustedScore: number;
  /** Fraction of equity to risk, after sizing and portfolio constraints. 0 means NO TRADE. */
  recommendedPositionFraction: number;

  provenance: Provenance;
}

/** Distance from entry to stop, as a positive fraction of entry. One R. */
export function riskPerUnit(entry: number, stop: number): number {
  if (!(entry > 0)) return 0;
  return Math.abs(entry - stop) / entry;
}

/**
 * Reward-to-risk of the structure itself, in R. Pure geometry — no model involved.
 *
 * This is deliberately separable from any prediction: given a coin-flip direction, this number and
 * the excursion probability are what determine expected value. Isolating it keeps the two sources
 * of edge distinguishable when the system is later evaluated.
 */
export function structureR(entry: number, stop: number, target: number, direction: Direction): number {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return 0;
  const reward = direction === 'LONG' ? target - entry : entry - target;
  return reward / risk;
}

/** True when the stop and target sit on the correct sides of entry for the stated direction. */
export function isValidGeometry(c: Pick<TradeCandidate, 'direction' | 'entryPrice' | 'stopPrice' | 'targetPrice'>): boolean {
  const { direction, entryPrice: e, stopPrice: s, targetPrice: t } = c;
  if (!(e > 0) || !(s > 0) || !(t > 0)) return false;
  return direction === 'LONG' ? s < e && t > e : s > e && t < e;
}

/** The explicit no-trade result. The system must be comfortable producing this (spec §15). */
export function noTrade(asset: string, provenance: Provenance): TradeCandidate {
  return {
    asset, direction: 'LONG',
    entryPrice: 0, stopPrice: 0, targetPrice: 0, holdingHorizonHours: 0,
    payoff: { winProbability: 0, averageWinR: 0, averageLossR: 0, expectedValueR: 0, payoffAsymmetry: 0, confidence: 0 },
    crashRisk: { probability: 0, regime: 'LOW', confidence: 0, horizonDays: 0 },
    signalStrength: 0, riskAdjustedScore: 0, recommendedPositionFraction: 0,
    provenance,
  };
}

export function isNoTrade(c: TradeCandidate): boolean {
  return c.recommendedPositionFraction <= 0 || c.entryPrice <= 0;
}
