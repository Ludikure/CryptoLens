/**
 * Trade-candidate generation (spec §15).
 *
 * For each asset: build a LONG candidate, build a SHORT candidate, estimate payoff, apply crash
 * sizing, apply portfolio constraints, and — importantly — be willing to return NO TRADE.
 *
 * TWO DESIGN CHOICES CARRY EVIDENCE, and both run against the intuitive option:
 *
 * 1. **The target multiple is FIXED, not predicted.** T4 tested per-bar dynamic target selection
 *    and it lost in every fold (+0.0911R dynamic vs +0.4261R fixed at 1:5), because predicted
 *    excursions regress to the mean and the model kept picking tight targets — the worst option in
 *    its own table. Payoff structure should be fixed and wide.
 *
 * 2. **The stop is checked against NOISE, not just against a level.** `noiseHitProb` (risk-engine)
 *    gives P(the stop is wicked purely by volatility within the horizon). A stop inside the noise
 *    band converts a sound thesis into a coin flip on tick sequencing, and the 2026-07-02 insight
 *    batch added this measure precisely because tight stops were the recurring failure.
 */

import { noiseHitProb } from '../risk-engine';
import type { CrashRisk, Direction, Provenance, TradeCandidate } from './candidate';
import { isValidGeometry, noTrade, structureR } from './candidate';
import { assertNoLookahead } from './provenance';
import { buildPayoff, opportunityScore, chooseDirection, DEFAULT_SCORING, type ScoringConfig } from './opportunity';
import { sizePosition, DEFAULT_LIMITS, type PortfolioState, type RiskLimits } from './sizing';
import { PLACEHOLDER_CURVE, type SizingCurve } from './crash-risk';
import { probabilityOfReaching, type ExcursionCurve } from './payoff';

/** Frozen structural parameters. Changing any of these must change the id. */
export interface StructureConfig {
  readonly id: string;
  /** Stop distance in ATR multiples. 1.0 = the validated convex structure. */
  stopAtrMultiple: number;
  /** Target in R. FIXED by design — see the header. */
  targetR: number;
  holdingHorizonHours: number;
  /** Reject a stop whose noise-hit probability exceeds this. */
  maxNoiseHitProbability: number;
  /** Round-trip cost as a percentage of notional. */
  roundTripPercent: number;
}

/**
 * Default structure: the 1R-stop / 5R-target / 72h convex trade this project actually validated
 * (+0.151R gross), with the user's measured Coinbase Advanced 2 derivatives cost.
 *
 * The 0.171% is 0.070% taker × 2 plus the flat $0.12/contract expressed against a nano-BTC notional
 * (~0.031% round trip). Nano ETH is materially worse — the same $0.12 against a third of the
 * notional is ~0.098% — so contract choice belongs in this config, not in a comment.
 */
export const DEFAULT_STRUCTURE: StructureConfig = {
  id: 'convex-1r5r-72h-2026-08-24',
  stopAtrMultiple: 1.0,
  targetR: 5.0,
  holdingHorizonHours: 72,
  maxNoiseHitProbability: 0.45,
  roundTripPercent: 0.171,
};

export interface GenerateInput {
  asset: string;
  price: number;
  /** ATR in PRICE units at the structure's timeframe. */
  atr: number;
  /**
   * Forward volatility over the holding horizon as a LOG-RETURN fraction (e.g. 0.03 = 3%), matching
   * `risk-engine.noiseHitProb`, which compares it against |log(stop/entry)|. Passing price units
   * here silently makes every stop look like noise — the units are load-bearing.
   */
  sigma: number;
  liquidityUsd24h: number;
  crashRisk: CrashRisk;
  /** Excursion curve per side. Direction-specific because the two are not required to be symmetric. */
  curves: { LONG: ExcursionCurve; SHORT: ExcursionCurve };
  /** Model confidence on [0,1], per side. */
  confidence: { LONG: number; SHORT: number };
  portfolio: PortfolioState;
  provenance: Provenance;
  structure?: StructureConfig;
  limits?: RiskLimits;
  sizingCurve?: SizingCurve;
  scoring?: ScoringConfig;
}

export interface GenerateResult {
  /** The selected candidate, or a NO TRADE. */
  candidate: TradeCandidate;
  /**
   * True when BOTH sides carry positive expected value and neither has a directional edge.
   *
   * This is not a degenerate case — it is the validated one. The convex structure measured at
   * +0.151R gross is explicitly direction-agnostic: its edge lives in excursion probability and
   * payoff geometry, and T5 simulated both sides with near-identical results (long −0.1033R,
   * short +0.0151R ungated). Refusing to trade it because the model cannot pick a side would
   * discard the one edge this project actually validated.
   *
   * The returned candidate carries a nominal direction so it is executable; the flag tells the UI
   * to present the choice as immaterial rather than implying a view it does not have.
   */
  directionAgnostic: boolean;
  /** Both sides, for transparency in the UI and the journal. */
  considered: { long: TradeCandidate | null; short: TradeCandidate | null };
  /** Why nothing was selected, when nothing was. */
  rejectionReasons: string[];
}

function buildSide(direction: Direction, i: GenerateInput, s: StructureConfig): { candidate: TradeCandidate | null; reason?: string } {
  const stopDistance = s.stopAtrMultiple * i.atr;
  if (!(stopDistance > 0)) return { candidate: null, reason: `${direction}: non-positive ATR` };

  const entry = i.price;
  const stop = direction === 'LONG' ? entry - stopDistance : entry + stopDistance;
  const target = direction === 'LONG' ? entry + s.targetR * stopDistance : entry - s.targetR * stopDistance;

  if (!isValidGeometry({ direction, entryPrice: entry, stopPrice: stop, targetPrice: target })) {
    return { candidate: null, reason: `${direction}: invalid geometry` };
  }

  // Is the stop merely inside the noise? A stop that volatility alone will reach is not a stop.
  const noise = noiseHitProb(entry, stop, i.sigma);
  if (noise > s.maxNoiseHitProbability) {
    return { candidate: null, reason: `${direction}: stop inside the noise band (P=${(noise * 100).toFixed(0)}%)` };
  }

  const winProbability = probabilityOfReaching(i.curves[direction], s.targetR);
  const payoff = buildPayoff({
    winProbability,
    entryPrice: entry, stopPrice: stop, targetPrice: target,
    direction, confidence: i.confidence[direction], roundTripPercent: s.roundTripPercent,
  });

  if (payoff.expectedValueR <= 0) {
    return { candidate: null, reason: `${direction}: non-positive expected value (${payoff.expectedValueR.toFixed(3)}R)` };
  }

  return {
    candidate: {
      asset: i.asset, direction,
      entryPrice: entry, stopPrice: stop, targetPrice: target,
      holdingHorizonHours: s.holdingHorizonHours,
      payoff, crashRisk: i.crashRisk,
      signalStrength: winProbability,
      riskAdjustedScore: 0,
      recommendedPositionFraction: 0,
      provenance: { ...i.provenance, sizingConfigId: s.id },
    },
  };
}

/**
 * Generate the best candidate for one asset, or NO TRADE.
 *
 * Lookahead is asserted at the top: a candidate whose features postdate its decision must never
 * reach sizing, and this project has shipped that bug twice.
 */
export function generateCandidate(input: GenerateInput): GenerateResult {
  assertNoLookahead(input.provenance);

  const s = input.structure ?? DEFAULT_STRUCTURE;
  const scoring = input.scoring ?? DEFAULT_SCORING;
  const reasons: string[] = [];

  const L = buildSide('LONG', input, s);
  const S = buildSide('SHORT', input, s);
  if (L.reason) reasons.push(L.reason);
  if (S.reason) reasons.push(S.reason);

  let chosen = chooseDirection(L.candidate, S.candidate);
  let directionAgnostic = false;

  if (!chosen && L.candidate && S.candidate) {
    // Both sides positive-EV with no edge either way. Trade it, and say so — see the field docs.
    directionAgnostic = true;
    chosen = L.candidate;
    reasons.push('no directional edge — structure is positive-EV on either side');
  }

  if (!chosen) {
    return {
      candidate: noTrade(input.asset, input.provenance),
      considered: { long: L.candidate, short: S.candidate },
      rejectionReasons: reasons,
      directionAgnostic: false,
    };
  }

  const sizing = sizePosition({
    asset: input.asset,
    direction: chosen.direction,
    entryPrice: chosen.entryPrice,
    stopPrice: chosen.stopPrice,
    expectedValueR: chosen.payoff.expectedValueR,
    crashRisk: input.crashRisk,
    liquidityUsd24h: input.liquidityUsd24h,
    portfolio: input.portfolio,
    limits: input.limits ?? DEFAULT_LIMITS,
    curve: input.sizingCurve ?? PLACEHOLDER_CURVE,
  });

  if (sizing.riskFraction <= 0) {
    reasons.push(...sizing.bindingConstraints);
    return {
      candidate: noTrade(input.asset, input.provenance),
      considered: { long: L.candidate, short: S.candidate },
      rejectionReasons: reasons,
      directionAgnostic,
    };
  }

  const sized: TradeCandidate = {
    ...chosen,
    recommendedPositionFraction: sizing.riskFraction,
    riskAdjustedScore: opportunityScore(chosen.payoff, input.crashRisk.probability, scoring),
    provenance: { ...chosen.provenance, sizingConfigId: `${s.id}|${sizing.curveId}|${sizing.limitsId}` },
  };

  return { candidate: sized, considered: { long: L.candidate, short: S.candidate }, rejectionReasons: reasons, directionAgnostic };
}

/** Structural reward-to-risk of the default config — a sanity value for the UI. */
export function defaultStructureR(s: StructureConfig = DEFAULT_STRUCTURE): number {
  return structureR(100, 100 - s.stopAtrMultiple, 100 + s.targetR * s.stopAtrMultiple, 'LONG');
}
