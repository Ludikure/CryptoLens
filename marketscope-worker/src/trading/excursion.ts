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
  // A head that failed its pre-declared bar contributes nothing: return the measured base rate.
  if (!headIsShippable(side)) return head.baseCurve[String(MODEL.primaryR)] ?? head.baseCurve['5'];
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
/**
 * The head for a side, or a throw if that head did not clear its pre-declared bar.
 *
 * The 2026-08-26 blanket quarantine is LIFTED: labels were rebuilt at `anchor='bar_close'` in Phase
 * 1.4, so the 4-hour lookahead is gone and the leak was measurably PESSIMISTIC (the 5R hit rate went
 * 6.64% -> 7.62% once corrected).
 *
 * What replaced it is narrower and per-head, because the retrain SPLIT BY SIDE:
 *
 *   SHORT  ships. All five criteria pass — AUC 0.6302 per-symbol / 0.6220 cross-sectional, controls
 *          beaten by ~+0.13, calibration monotone, incumbent beaten in all three folds.
 *   LONG   does NOT ship. Cross-sectional AUC 0.5421 is under the 0.55 floor, calibration has two
 *          inversions, and — the disqualifying one — a 30-bar-LAGGED model scores 0.5427 on that
 *          axis, so the head adds nothing over stale information cross-sectionally.
 *
 * A refused head falls back to `baseExcursionCurve` — the MEASURED hit rate, which carries no model
 * claim and has no bar to clear. That is the same fallback the service already uses when features
 * are missing, and it is the honest answer here: the model has nothing trustworthy to add on this
 * side, so report what was observed and no more. It does NOT throw, because the only consumer is a
 * read-only research endpoint and taking it down for one side would trade a small wrong number for a
 * large outage. `excursionModelInfo()` reports the verdict per head so a caller can tell which it
 * got.
 *
 * This is the same direction-dependence the envelope programme found in `alignment_not_full` (C3),
 * the ML floor (C4) and the envelope as a whole (C5). It shows up here independently, on a different
 * target, which is the closest thing to a replication this project has produced.
 */
export function headIsShippable(side: 'LONG' | 'SHORT'): boolean {
  const h = (side === 'LONG' ? MODEL.heads.long : MODEL.heads.short) as { shippable?: boolean };
  return h.shippable !== false;
}

export function excursionCurve(
  features: Record<string, number>,
  side: 'LONG' | 'SHORT',
  horizonHours = 72,
): ExcursionCurve {
  // A refused head degrades to the measured curve — see `headIsShippable`. `ratio` would be 1.0
  // anyway once `excursionProbability` returns the base rate, but saying it here keeps the intent
  // legible rather than relying on an arithmetic coincidence.
  if (!headIsShippable(side)) return baseExcursionCurve(side, horizonHours);
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
  // Deliberately NOT gated on the ship verdict: this is the observed hit rate, so it makes no model
  // claim and has no bar to clear. It is what a refused head falls back TO.
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

/** The ship verdict a head carries, so a caller can ask before it calls. */
function pick(head: unknown) {
  const h = head as { shippable?: boolean; reason?: string; holdoutAuc?: number };
  return { shippable: h.shippable ?? null, holdoutAuc: h.holdoutAuc, reason: h.reason ?? null };
}

export function excursionModelInfo() {
  return {
    version: EXCURSION_MODEL_VERSION,
    primaryR: MODEL.primaryR,
    features: MODEL.features.length,
    longAuc: MODEL.heads.long.holdoutAuc,
    shortAuc: MODEL.heads.short.holdoutAuc,
    description: MODEL.description,
    // QUARANTINE LIFTED 2026-08-26 (Phase 3). Retrained on labels rebuilt at `anchor='bar_close'`;
    // the 4-hour lookahead below is gone. It is replaced by a PER-HEAD verdict — see
    // `headIsShippable`: SHORT clears all five pre-declared criteria and serves, LONG fails
    // three of five and throws. Historical note on what the quarantine was for:
    //
    // ORIGINAL DEFECT. Both the trained head AND the measured base curve came from
    // `excursion_dataset.pkl.gz`, whose barrier labels (`excursion_labels.py:64-92`) were built
    // from `base+1` — one hour after the row's timestamp — while the row is actually evaluated at
    // the 4H bar's CLOSE, T+4h. So the label span includes up to 3h of price that had already
    // happened when the entry price was set. Worse than a shifted window: that pre-entry span sits
    // inside the very 4H bar whose OHLC is in the feature vector, so the leak has a feature-side
    // handle (`atrPercent`, `bodyWickRatio`, `hBBPercentB`) and is learnable.
    //
    // `baseExcursionCurve` is NOT a clean fallback — `excursion_export.py:62` computes it as the
    // mean of the same leaked labels.
    //
    // Not ripped out because it reaches neither the LLM prompt nor the iOS app: its only consumer
    // is `/opportunities`, a read-only research endpoint with no client since OpportunityFeedCard
    // was deleted. The flag is here so nobody reads those numbers as valid in the meantime.
    // Retrain on corrected labels is Phase 3 of ~/.claude/plans/jolly-crunching-crown.md.
    contaminated: false,
    labelAnchor: (MODEL as unknown as { labelAnchor?: string }).labelAnchor ?? 'unknown',
    heads: {
      long: pick(MODEL.heads.long),
      short: pick(MODEL.heads.short),
    },
  };
}
