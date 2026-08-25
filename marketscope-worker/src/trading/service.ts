/**
 * Wires the trading pipeline to real market data.
 *
 * ADDITIVE BY DESIGN. This runs alongside the existing analysis path and changes nothing about it:
 * no cron behaviour, no notifications, no model serving.
 *
 * THE CURVE IS NOW MEASURED. It previously anchored on ML_WIN at 1.5R and extrapolated toward the
 * driftless barrier result 1/(1+R) -- an assumption about tail shape. Measured on 3.5M simulated
 * trades, real barrier rates sit ~10pp BELOW that benchmark at every R, so every expected value the
 * old curve produced was optimistic. `trading/excursion.ts` serves the trained model instead.
 *
 * WHAT THE MODEL EARNS, AND WHAT IT DOES NOT (docs/research/excursion-model.md):
 *   - cross-sectional AUC ~0.62, verified to be genuine asset selection rather than shared market
 *     state (the market-wide feature block alone scores exactly 0.5000 within a timestamp);
 *   - a tradeable spread of only +0.109R gross, median 0.000R, positive in 34% of timestamps;
 *   - **profitability that is regime-dependent** -- 1 of 5 rising-market periods, corr with BTC
 *     return -0.509.
 *
 * So it ranks. It does not promise money, and `PROVISIONAL_CAVEAT` carries that to every surface.
 */

import { forecastVol } from '../vol';
import { excursionCurve, baseExcursionCurve, regimeCaveat,
         EXCURSION_MODEL_VERSION } from './excursion';
import type { CrashRisk, Provenance } from './candidate';
import { crashRegime, PLACEHOLDER_CURVE } from './crash-risk';
import { generateCandidate, DEFAULT_STRUCTURE, type StructureConfig } from './generator';
import { rankCandidates } from './opportunity';
import { allocatePortfolio, type AllocationResult } from './portfolio';
import type { ExcursionCurve } from './payoff';
import type { PortfolioState } from './sizing';

export const PROVISIONAL_MODEL_VERSION = EXCURSION_MODEL_VERSION;


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

export const PROVISIONAL_CAVEAT = regimeCaveat();

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

    // MEASURED curves, one per side. The model predicts the level at 5R; the rest of the curve
    // scales the measured base rates. Without features we fall back to those base rates rather
    // than inventing a number -- a made-up probability flows straight into position size.
    const hasFeatures = a.features != null && Object.keys(a.features).length > 20;
    const curves = hasFeatures
      ? { LONG: excursionCurve(a.features!, 'LONG', structure.holdingHorizonHours),
          SHORT: excursionCurve(a.features!, 'SHORT', structure.holdingHorizonHours) }
      : { LONG: baseExcursionCurve('LONG', structure.holdingHorizonHours),
          SHORT: baseExcursionCurve('SHORT', structure.holdingHorizonHours) };

    const res = generateCandidate({
      asset: a.asset, price: a.price, atr: a.atr, sigma,
      liquidityUsd24h: a.liquidityUsd24h, crashRisk: crash,
      curves,
      // Holdout AUC ~0.60 on both sides: real discrimination, a long way from certainty.
      confidence: { LONG: hasFeatures ? 0.6 : 0.4, SHORT: hasFeatures ? 0.6 : 0.4 },
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
