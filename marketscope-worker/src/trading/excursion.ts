/**
 * Excursion model: P(reach +R x risk before -1 x risk within 72h), per side.
 *
 * This replaces `provisionalCurve`, which anchored on ML_WIN at 1.5R and extrapolated toward the
 * driftless barrier result 1/(1+R). That benchmark turned out to be the wrong target entirely:
 * measured on 3.5M simulated trades over 24 symbols, real barrier rates sit **~10pp BELOW it at
 * every R** (5R: 6.6% against 16.7%), because 1/(1+R) assumes infinite time and a 72h horizon
 * truncates. Every expected value the pipeline produced under the old curve was optimistic.
 *
 * WHAT THIS MODEL IS, STATED PLAINLY (docs/research/excursion-model.md):
 *   - Cross-sectional AUC ~0.62, and that IS genuine asset selection: trained on the 29 market-wide
 *     features alone the within-timestamp AUC is exactly 0.5000, as it must be.
 *   - The tradeable within-timestamp spread is **+0.109R gross, median 0.000R, positive in only 34%
 *     of timestamps**. Mostly nothing, occasionally a large hit.
 *   - **Profitability is REGIME-DEPENDENT**: profitable in 1 of 5 rising-market periods, with
 *     corr(EV, BTC return) = -0.509. Ranking survives regime; the money does not.
 *
 * So this is a legitimate INPUT to ranking and sizing. It is not a signal to trade on, and
 * `regimeCaveat()` exists so no surface can quietly present it as one.
 */

import excursionModel from '../ml-model-excursion-crypto.json';
import type { ExcursionCurve } from './payoff';

interface TreeNode {
  nodeid: number;
  split?: string;
  split_condition?: number;
  yes?: number;
  no?: number;
  children?: TreeNode[];
  leaf?: number;
}

interface Head {
  trees: TreeNode[];
  calibration: { x: number[]; y: number[]; cap: number; floor: number };
  baseCurve: Record<string, number>;
  holdoutAuc: number;
  supportedCeiling: number;
}

const MODEL = excursionModel as unknown as {
  features: string[];
  version: number;
  primaryR: number;
  rGrid: number[];
  heads: { long: Head; short: Head };
  description: string;
};

export const EXCURSION_MODEL_VERSION = `excursion-v${MODEL.version}-2026-08-24`;

/** Same traversal as `ml-predict.ts` — LightGBM dumped into the XGBoost node shape. */
function evaluateTree(node: TreeNode, input: Record<string, number>): number {
  if (node.leaf !== undefined) return node.leaf;
  if (!node.split || node.split_condition === undefined) return 0;
  const goLeft = (input[node.split] ?? 0) < node.split_condition;
  const next = (node.children ?? []).find(c => c.nodeid === (goLeft ? node.yes : node.no));
  return next ? evaluateTree(next, input) : 0;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Piecewise-linear isotonic apply, clamped to the fitted ends.
 *
 * The ceiling is not cosmetic. The first export let isotonic's top grid point reach 0.60 — nine
 * times the 0.066 base rate, resting on a single sparse bucket — which would have produced a +3R
 * expected value out of one under-supported point. The exporter now caps at the highest rate a
 * 500-sample bucket actually realised (~2.1x base), and this re-applies that ceiling at serve time
 * so a future model file cannot reintroduce the problem silently.
 */
function applyCal(raw: number, head: Head): number {
  const { x, y } = head.calibration;
  const ceil = head.supportedCeiling ?? head.calibration.cap;
  if (x.length < 2) return Math.min(raw, ceil);
  if (raw <= x[0]) return Math.min(y[0], ceil);
  if (raw >= x[x.length - 1]) return Math.min(y[y.length - 1], ceil);
  let lo = 0;
  for (let i = 1; i < x.length; i++) { if (x[i] > raw) { lo = i - 1; break; } }
  const t = (raw - x[lo]) / (x[lo + 1] - x[lo]);
  return Math.min(Math.max(head.calibration.floor, y[lo] + t * (y[lo + 1] - y[lo])), ceil);
}

/** Calibrated P(reach the primary target before the stop) for one side. */
export function excursionProbability(features: Record<string, number>, side: 'LONG' | 'SHORT'): number {
  const head = side === 'LONG' ? MODEL.heads.long : MODEL.heads.short;
  const margin = head.trees.reduce((sum, t) => sum + evaluateTree(t, features), 0);
  return applyCal(sigmoid(margin), head);
}

/**
 * The full curve for one side.
 *
 * The model predicts the LEVEL at the primary target (5R). Other R values scale the MEASURED base
 * curve by that same ratio — one stated assumption (shape is shared across assets, level is
 * predicted) replacing the old extrapolation toward a benchmark the data sits well below. Training
 * a separate model per R would remove even this assumption; it is a follow-up, not a blocker.
 *
 * Ratios are capped at 3x so a single confident prediction cannot imply an implausible 1R rate, and
 * every point is clamped below 1.
 */
export function excursionCurve(
  features: Record<string, number>,
  side: 'LONG' | 'SHORT',
  horizonHours = 72,
): ExcursionCurve {
  const head = side === 'LONG' ? MODEL.heads.long : MODEL.heads.short;
  const baseAtPrimary = head.baseCurve[String(MODEL.primaryR)] ?? 0.066;
  const predicted = excursionProbability(features, side);
  const ratio = Math.min(3, baseAtPrimary > 0 ? predicted / baseAtPrimary : 1);

  const points = MODEL.rGrid.map(r => ({
    atR: r,
    probability: Math.min(0.95, Math.max(0.001, (head.baseCurve[String(r)] ?? 0) * ratio)),
  }));
  // Monotone non-increasing in R, which `payoff.validate` requires.
  for (let i = 1; i < points.length; i++) {
    points[i].probability = Math.min(points[i].probability, points[i - 1].probability);
  }
  return { horizonHours, points };
}

/** The measured base curve, with no model applied — the honest fallback when features are missing. */
export function baseExcursionCurve(side: 'LONG' | 'SHORT', horizonHours = 72): ExcursionCurve {
  const head = side === 'LONG' ? MODEL.heads.long : MODEL.heads.short;
  return {
    horizonHours,
    points: MODEL.rGrid.map(r => ({ atR: r, probability: head.baseCurve[String(r)] ?? 0.001 })),
  };
}

/**
 * The caveat every surface showing these numbers must carry.
 *
 * Deliberately a function rather than a comment: the measurement says ranking survives regime and
 * profitability does not, and a UI that renders EV without saying so is presenting a regime bet as
 * a model output — the exact mistake [[regime-hold]] documents.
 */
export function regimeCaveat(): string {
  return 'Ranking is measured and regime-independent; PROFITABILITY is not. This structure was '
    + 'profitable in only 1 of 5 rising-market periods tested (corr with BTC return −0.51), and its '
    + 'edge is +0.109R gross with a median of zero — mostly nothing, occasionally a large hit.';
}

export function excursionModelInfo() {
  return {
    version: EXCURSION_MODEL_VERSION,
    primaryR: MODEL.primaryR,
    features: MODEL.features.length,
    longAuc: MODEL.heads.long.holdoutAuc,
    shortAuc: MODEL.heads.short.holdoutAuc,
    description: MODEL.description,
  };
}
