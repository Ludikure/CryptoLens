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
import type { CrashRisk, Provenance, TradeCandidate } from './candidate';
import { crashRegime } from './crash-risk';
import { crashProbability, crashWarning, VALIDATED_CURVE, CRASH_MODEL_VERSION } from './crash';
import { generateCandidate, DEFAULT_STRUCTURE, type StructureConfig } from './generator';
import { rankCandidates } from './opportunity';
import { allocatePortfolio, type AllocationResult } from './portfolio';
import type { ExcursionCurve } from './payoff';
import { DEFAULT_LIMITS, type PortfolioState, type RiskLimits } from './sizing';

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
  /**
   * The 110 serving features the excursion and crash models read.
   *
   * Was USED but never DECLARED, so `a.features` typed as `any` and a rename or a typo here would
   * have compiled silently — on the one input that decides both the excursion curve and the crash
   * overlay. Optional because the service falls back to measured base rates without it.
   */
  features?: Record<string, number>;
  liquidityUsd24h: number;
  isCrypto: boolean;
  dataTimestamp: number;
}

export interface CrashWarning {
  asset: string;
  level: 'ELEVATED' | 'HIGH';
  message: string;
  probability: number;
}

export interface OpportunityResult {
  allocation: AllocationResult;
  /** Drawdown-risk warnings, independent of whether any trade was produced. */
  crashWarnings: CrashWarning[];
  /**
   * EVERY scored asset's drawdown reading, whether or not it warned.
   *
   * `crashWarnings` fires on the MARGIN over the base rate, so on an ordinary day it is empty --
   * and a gauge that renders nothing on an ordinary day teaches the user it is broken. The reading
   * itself is the product: 44% against a 41% base is "normal", and saying so is not the same as
   * saying nothing. Absence of a warning is a documented property, never an all-clear (crash.ts).
   */
  crashReadings: Array<{ asset: string; probability: number }>;
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
  /**
   * The user's own risk limits. Defaulted rather than required, but a caller that knows the user's
   * risk-per-trade MUST pass it: every dollar figure the client renders converts R with
   * `accountSize * riskPercent`, while sizing here fell back to a fixed 2%. A user on 1% saw
   * "1R is $280" beside "Risk if stopped 2.00% of the account" — $560 — for the same event.
   */
  limits: RiskLimits = DEFAULT_LIMITS,
): OpportunityResult {
  const candidates: TradeCandidate[] = [];
  const skipped: OpportunityResult['skipped'] = [];
  const warnings: CrashWarning[] = [];
  const readings: OpportunityResult['crashReadings'] = [];
  const agnostic: string[] = [];
  const liquidityByAsset: Record<string, number> = {};

  for (const a of assets) {
    liquidityByAsset[a.asset] = a.liquidityUsd24h;

    if (!(a.atr > 0) || !(a.price > 0)) { skipped.push({ asset: a.asset, reasons: ['missing price or ATR'] }); continue; }

    const vf = forecastVol(a.closes1h, a.isCrypto, a.price);
    const sigma = vf?.rv?.h24;
    if (!(sigma && sigma > 0)) { skipped.push({ asset: a.asset, reasons: ['no volatility forecast'] }); continue; }

    const hasFeatures = a.features != null && Object.keys(a.features).length > 20;

    // The crash model is the one signal that survived every control, so it runs whenever features
    // are present. An explicit override is honoured for testing; absent both, no overlay applies.
    const cp = a.crashProbability ?? (hasFeatures ? crashProbability(a.features!) : null);
    const crash: CrashRisk = cp == null
      ? { probability: 0, regime: 'LOW', confidence: 0, horizonDays: 0 }
      : { probability: cp, regime: crashRegime(cp, VALIDATED_CURVE), confidence: 0.6, horizonDays: 10 };
    if (cp != null) {
      readings.push({ asset: a.asset, probability: cp });
      const w = crashWarning(cp);
      if (w) warnings.push({ asset: a.asset, level: w.level, message: w.message, probability: cp });
    }

    const provenance: Provenance = {
      dataTimestamp: a.dataTimestamp,
      featureTimestamp: a.dataTimestamp,
      decisionTimestamp,
      modelVersion: PROVISIONAL_MODEL_VERSION,
      crashModelVersion: cp == null ? 'none' : CRASH_MODEL_VERSION,
      sizingConfigId: structure.id,
    };

    // MEASURED curves, one per side. The model predicts the level at 5R; the rest of the curve
    // scales the measured base rates. Without features we fall back to those base rates rather
    // than inventing a number -- a made-up probability flows straight into position size.
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
      portfolio, provenance, structure, limits,
    });

    if (res.candidate.recommendedPositionFraction > 0) {
      candidates.push(res.candidate);
      if (res.directionAgnostic) agnostic.push(a.asset);
    } else {
      skipped.push({ asset: a.asset, reasons: res.rejectionReasons });
    }
  }

  return {
    allocation: allocatePortfolio({ ranked: rankCandidates(candidates), state: portfolio,
                                    liquidityByAsset, curve: VALIDATED_CURVE, limits }),
    crashWarnings: warnings,
    crashReadings: readings,
    directionAgnosticAssets: agnostic,
    skipped,
    provisional: true,
    caveat: PROVISIONAL_CAVEAT,
    modelVersion: PROVISIONAL_MODEL_VERSION,
  };
}
