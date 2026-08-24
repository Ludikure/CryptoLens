/**
 * Wires the trading pipeline to real market data (Phase 6 groundwork).
 *
 * ADDITIVE BY DESIGN. This runs alongside the existing analysis path and changes nothing about it:
 * no cron behaviour, no notifications, no model serving. The pipeline is read-only until it has been
 * validated against live output.
 *
 * ⚠️ THE EXCURSION MODEL IS PROVISIONAL, AND THIS IS THE HONEST GAP.
 *
 * `generateCandidate` needs `P(reach +NR before −1R)` per side. No such model has been trained and
 * shipped. What EXISTS is `ML_WIN` = `P(fwdMaxFavR >= 1.5 ATR within 24h)` — a genuine excursion
 * probability, but at ONE point (1.5R), on a 24h horizon, and direction-agnostic.
 *
 * So `provisionalCurve()` anchors on that real number and interpolates toward the random-walk tail.
 * It is explicitly NOT a trained model, every response says so, and `modelVersion` carries
 * `provisional-` so no journal entry can later be mistaken for one produced by a real tail model.
 *
 * Fabricating a confident curve here would have been easy and would have poisoned the OOS record
 * the journal exists to protect.
 */

import { forecastVol } from '../vol';
import type { CrashRisk, Provenance } from './candidate';
import { crashRegime, PLACEHOLDER_CURVE } from './crash-risk';
import { generateCandidate, DEFAULT_STRUCTURE, type StructureConfig } from './generator';
import { rankCandidates } from './opportunity';
import { allocatePortfolio, type AllocationResult } from './portfolio';
import type { ExcursionCurve } from './payoff';
import type { PortfolioState } from './sizing';

export const PROVISIONAL_MODEL_VERSION = 'provisional-mlwin-anchored-2026-08-24';

/**
 * Build an excursion curve from the one real anchor available.
 *
 * `mlWin` is P(≥1.5 ATR favourable move in 24h). Beyond that anchor the curve decays toward the
 * driftless barrier result 1/(1+R), scaled by how much the anchor already exceeds it — so an asset
 * whose measured 1.5R rate merely matches random walk gets a random-walk tail, and one that exceeds
 * it keeps a proportional edge further out.
 *
 * This is an assumption about tail SHAPE, not a measurement. The vault's tail-gated corpus figure
 * (~30% at 5R against 16.7% theory) is the number a trained model should reproduce; this
 * interpolation should not be mistaken for it.
 */
export function provisionalCurve(mlWin: number, horizonHours: number): ExcursionCurve {
  const anchorR = 1.5;
  const rwAtAnchor = 1 / (1 + anchorR);                       // 0.40
  const edgeRatio = rwAtAnchor > 0 ? Math.max(0, mlWin / rwAtAnchor) : 1;
  const points = [1, 1.5, 2, 3, 5, 8].map(r => {
    const rw = 1 / (1 + r);
    // Damp the edge as R grows: an edge measured at 1.5R is weakest evidence about 8R.
    const damped = 1 + (edgeRatio - 1) * Math.exp(-(r - anchorR) / 3);
    return { atR: r, probability: Math.min(0.95, Math.max(0.001, rw * damped)) };
  });
  // Enforce the monotonicity `validate()` requires; damping can otherwise cross over.
  for (let i = 1; i < points.length; i++) {
    points[i].probability = Math.min(points[i].probability, points[i - 1].probability);
  }
  return { horizonHours, points };
}

export interface AssetInput {
  asset: string;
  closes1h: number[];
  price: number;
  /** ATR in price units at the structure timeframe. */
  atr: number;
  /** ML_WIN from the existing model — the only real excursion anchor available. */
  mlWin: number | null;
  /** Crash probability, when a crash model is available. Absent means no overlay is applied. */
  crashProbability: number | null;
  liquidityUsd24h: number;
  isCrypto: boolean;
  dataTimestamp: number;
}

export interface OpportunityResult {
  allocation: AllocationResult;
  /** Assets whose structure pays on either side — the validated convex case, not a failure. */
  directionAgnosticAssets: string[];
  /** Assets that produced no candidate, with the reason. */
  skipped: Array<{ asset: string; reasons: string[] }>;
  provisional: true;
  /** Stated on every response so a caller cannot treat this as a validated pipeline. */
  caveat: string;
  modelVersion: string;
}

export const PROVISIONAL_CAVEAT =
  'PROVISIONAL: no trained excursion model exists. Curves are anchored on ML_WIN at 1.5R and ' +
  'interpolated toward the random-walk tail — an assumption about shape, not a measurement. ' +
  'Expected values are illustrative and must not be traded or journalled as model output.';

/**
 * Run the full pipeline over a set of assets and return a ranked, sized, constrained book.
 *
 * Assets missing an ML_WIN are skipped rather than defaulted: a made-up excursion probability would
 * flow straight into expected value and position size.
 */
export function computeOpportunities(
  assets: readonly AssetInput[],
  portfolio: PortfolioState,
  decisionTimestamp: number,
  structure: StructureConfig = DEFAULT_STRUCTURE,
): OpportunityResult {
  const candidates = [];
  const skipped: OpportunityResult['skipped'] = [];
  const agnostic: string[] = [];
  const liquidityByAsset: Record<string, number> = {};

  for (const a of assets) {
    liquidityByAsset[a.asset] = a.liquidityUsd24h;

    if (a.mlWin == null) { skipped.push({ asset: a.asset, reasons: ['no ML_WIN available'] }); continue; }
    if (!(a.atr > 0) || !(a.price > 0)) { skipped.push({ asset: a.asset, reasons: ['missing price or ATR'] }); continue; }

    const vf = forecastVol(a.closes1h, a.isCrypto, a.price);
    const sigma = vf?.rv?.h24;
    if (!(sigma && sigma > 0)) { skipped.push({ asset: a.asset, reasons: ['no volatility forecast'] }); continue; }

    const crash: CrashRisk = a.crashProbability == null
      ? { probability: 0, regime: 'LOW', confidence: 0, horizonDays: 0 }   // no model => no overlay
      : { probability: a.crashProbability, regime: crashRegime(a.crashProbability, PLACEHOLDER_CURVE),
          confidence: 0.5, horizonDays: 10 };

    const provenance: Provenance = {
      dataTimestamp: a.dataTimestamp,
      featureTimestamp: a.dataTimestamp,
      decisionTimestamp,
      modelVersion: PROVISIONAL_MODEL_VERSION,
      crashModelVersion: a.crashProbability == null ? 'none' : 'crash-v1',
      sizingConfigId: structure.id,
    };

    const curve = provisionalCurve(a.mlWin, structure.holdingHorizonHours);
    const res = generateCandidate({
      asset: a.asset, price: a.price, atr: a.atr, sigma,
      liquidityUsd24h: a.liquidityUsd24h, crashRisk: crash,
      curves: { LONG: curve, SHORT: curve },   // direction-agnostic: the anchor has no side
      confidence: { LONG: 0.5, SHORT: 0.5 },
      portfolio, provenance, structure,
    });

    if (res.candidate.recommendedPositionFraction > 0) {
      candidates.push(res.candidate);
      if (res.directionAgnostic) agnostic.push(a.asset);
    } else {
      skipped.push({ asset: a.asset, reasons: res.rejectionReasons });
    }
  }

  return {
    allocation: allocatePortfolio({ ranked: rankCandidates(candidates), state: portfolio, liquidityByAsset }),
    directionAgnosticAssets: agnostic,
    skipped,
    provisional: true,
    caveat: PROVISIONAL_CAVEAT,
    modelVersion: PROVISIONAL_MODEL_VERSION,
  };
}
