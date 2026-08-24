/**
 * Position-sizing engine (spec §9, §10).
 *
 * ARCHITECTURAL RULE, enforced by the order of operations below: the model predicts, the risk engine
 * constrains. A high-confidence estimate can never produce an oversized position, because every hard
 * limit is applied AFTER the model's contribution and each one can only reduce.
 *
 * This matters more than it sounds. The convex structure this project validated wins 11.8% of the
 * time — nine losses in ten. A sizing path that scales with model confidence would concentrate risk
 * precisely where a long losing streak is most likely, and streaks of twenty are routine at that
 * hit rate (0.882^20 ≈ 8%).
 */

import type { CrashRisk, Direction, TradeCandidate } from './candidate';
import { riskPerUnit } from './candidate';
import { applyCrashOverlay, PLACEHOLDER_CURVE, type SizingCurve } from './crash-risk';

/** Hard limits. Independent of any model, and the model cannot raise them. */
export interface RiskLimits {
  readonly id: string;
  /** Max fraction of equity risked on one trade (loss if the stop fills). */
  maxRiskPerTrade: number;
  /** Max notional in one position, as a fraction of equity. Caps leverage. */
  maxPositionNotional: number;
  /** Max total notional across all positions. */
  maxPortfolioNotional: number;
  /** Max notional in any single asset, across candidates. */
  maxAssetConcentration: number;
  /** Max summed notional across positions whose pairwise correlation exceeds `correlationThreshold`. */
  maxCorrelatedNotional: number;
  correlationThreshold: number;
  /** Minimum 24h traded notional for an asset to be sizable at all. */
  minLiquidityUsd: number;
  /** Floor below which a position is not worth opening — rounds to NO TRADE. */
  minPositionFraction: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  id: 'default-2026-08-24',
  maxRiskPerTrade: 0.02,
  maxPositionNotional: 0.35,
  maxPortfolioNotional: 1.00,
  maxAssetConcentration: 0.35,
  maxCorrelatedNotional: 0.60,
  correlationThreshold: 0.70,
  minLiquidityUsd: 1_000_000,
  minPositionFraction: 0.0025,
};

export interface PortfolioState {
  equity: number;
  /** Open notional per asset, as a fraction of equity. */
  openNotionalByAsset: Record<string, number>;
  /** Pairwise correlations between assets, for the correlated-exposure limit. */
  correlations: Record<string, Record<string, number>>;
}

export interface SizingInput {
  asset: string;
  direction: Direction;
  entryPrice: number;
  stopPrice: number;
  /** Expected value in R. Sizing is NOT proportional to it — see `baseRiskFraction`. */
  expectedValueR: number;
  crashRisk: CrashRisk;
  liquidityUsd24h: number;
  portfolio: PortfolioState;
  limits?: RiskLimits;
  curve?: SizingCurve;
}

export interface SizingResult {
  /** Fraction of equity RISKED (loss at the stop), after everything. */
  riskFraction: number;
  /** Fraction of equity as position NOTIONAL. */
  notionalFraction: number;
  positionUsd: number;
  riskUsd: number;
  quantity: number;
  crashMultiplier: number;
  /** Every constraint that reduced the size, in application order. Surfaced so the UI can explain. */
  bindingConstraints: string[];
  curveId: string;
  limitsId: string;
}

/**
 * Base risk before any adjustment.
 *
 * Deliberately NOT proportional to expected value. T22's H4 tested exactly that: sizing ∝ p and ∝ p²
 * both LOST to a flat binary gate on return-per-unit-of-capital, in every fold. Expected value
 * decides WHETHER to trade; it does not decide how much.
 */
export function baseRiskFraction(expectedValueR: number, limits: RiskLimits): number {
  return expectedValueR > 0 ? limits.maxRiskPerTrade : 0;
}

/** Summed notional across assets correlated above the threshold with `asset`. */
export function correlatedExposure(asset: string, p: PortfolioState, threshold: number): number {
  const row = p.correlations[asset] ?? {};
  let total = 0;
  for (const [other, notional] of Object.entries(p.openNotionalByAsset)) {
    if (other === asset) { total += notional; continue; }
    if (Math.abs(row[other] ?? 0) >= threshold) total += notional;
  }
  return total;
}

/**
 * Size a candidate.
 *
 * Order is the contract: model contribution first, then crash overlay, then hard limits — each of
 * which can only reduce. Nothing downstream can restore size a constraint removed.
 */
export function sizePosition(input: SizingInput): SizingResult {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const curve = input.curve ?? PLACEHOLDER_CURVE;
  const binding: string[] = [];

  const empty = (why: string): SizingResult => {
    binding.push(why);
    return {
      riskFraction: 0, notionalFraction: 0, positionUsd: 0, riskUsd: 0, quantity: 0,
      crashMultiplier: 1, bindingConstraints: binding, curveId: curve.id, limitsId: limits.id,
    };
  };

  const stopDistance = riskPerUnit(input.entryPrice, input.stopPrice);
  if (!(stopDistance > 0)) return empty('invalid stop distance');
  if (input.liquidityUsd24h < limits.minLiquidityUsd) return empty('below minimum liquidity');

  // 1. model contribution — a binary go/no-go, not a confidence scalar
  let risk = baseRiskFraction(input.expectedValueR, limits);
  if (risk <= 0) return empty('non-positive expected value');

  // 2. crash overlay — can only scale down
  const overlay = applyCrashOverlay(risk, input.crashRisk, curve);
  if (overlay.multiplier < 1) binding.push(`crash ${input.crashRisk.regime} ×${overlay.multiplier.toFixed(2)}`);
  risk = overlay.fraction;
  if (risk <= 0) return { ...empty('crash overlay closed the position'), crashMultiplier: overlay.multiplier };

  // 3. hard limits, each capable only of reducing
  if (risk > limits.maxRiskPerTrade) { risk = limits.maxRiskPerTrade; binding.push('max risk per trade'); }

  let notional = risk / stopDistance;   // notional implied by risking `risk` with this stop
  if (notional > limits.maxPositionNotional) {
    notional = limits.maxPositionNotional; binding.push('max position notional');
  }

  const already = input.portfolio.openNotionalByAsset[input.asset] ?? 0;
  if (already + notional > limits.maxAssetConcentration) {
    notional = Math.max(0, limits.maxAssetConcentration - already); binding.push('asset concentration');
  }

  const corr = correlatedExposure(input.asset, input.portfolio, limits.correlationThreshold);
  if (corr + notional > limits.maxCorrelatedNotional) {
    notional = Math.max(0, limits.maxCorrelatedNotional - corr); binding.push('correlated exposure');
  }

  const totalOpen = Object.values(input.portfolio.openNotionalByAsset).reduce((a, b) => a + b, 0);
  if (totalOpen + notional > limits.maxPortfolioNotional) {
    notional = Math.max(0, limits.maxPortfolioNotional - totalOpen); binding.push('portfolio notional');
  }

  // recompute realised risk from the possibly-reduced notional
  risk = notional * stopDistance;
  if (risk <= 0 || notional <= 0) return { ...empty('constraints closed the position'), crashMultiplier: overlay.multiplier };
  if (notional < limits.minPositionFraction) {
    return { ...empty('below minimum position size'), crashMultiplier: overlay.multiplier };
  }

  const positionUsd = notional * input.portfolio.equity;
  return {
    riskFraction: risk,
    notionalFraction: notional,
    positionUsd,
    riskUsd: risk * input.portfolio.equity,
    quantity: positionUsd / input.entryPrice,
    crashMultiplier: overlay.multiplier,
    bindingConstraints: binding,
    curveId: curve.id,
    limitsId: limits.id,
  };
}

/** Convenience: attach a sizing result to a candidate. */
export function applySizing(candidate: TradeCandidate, sizing: SizingResult): TradeCandidate {
  return { ...candidate, recommendedPositionFraction: sizing.riskFraction };
}
