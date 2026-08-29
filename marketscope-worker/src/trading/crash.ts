/**
 * Crash / drawdown-risk model — the one signal in this project that survived every control.
 *
 * Target: `P(price falls >= 10% below this level at any point in the next 10 days)`. It never
 * predicts direction, only whether drawdown risk is elevated.
 *
 * WHY IT SHIPS (docs/research/crash-overlay.md, tests T8-T17):
 *   - cuts BTC max drawdown from **-76.6% to -40.4%**, Calmar 1.74 vs 0.48;
 *   - beats shuffled-signal, 30-day-lag, realised-vol and 200D-MA controls — shuffling collapses
 *     Calmar to roughly buy-and-hold's 0.08, so the value is in the TIMING, not in merely holding
 *     less;
 *   - **replicates leave-one-symbol-out** on ETH/SOL/XRP with placebos collapsing to ~0.05, so it is
 *     not one correlated bet counted four times: 9 of 15 crash clusters are asset-specific.
 *
 * AND ITS LIMITS, WHICH TRAVEL WITH IT:
 *   - protection is **EPISODIC** — absent through five separate 20-28% drawdowns in 2023-25;
 *   - value is **ANTICIPATORY**, living in a 20-30 day lead that any confirmation filter destroys;
 *   - **~35x/year turnover is structural**, not tunable: confirmation, new-capital-only, a floor and
 *     continuous sizing were each tried and each removed the benefit in proportion.
 *
 * So this is a RISK GAUGE for sizing and warning. It is not an entry signal, and nothing here
 * should ever be read as one.
 */

import crashModel from '../ml-model-crash-crypto.json';
import type { SizingCurve } from './crash-risk';

interface TreeNode {
  nodeid: number;
  split?: string;
  split_condition?: number;
  yes?: number;
  no?: number;
  children?: TreeNode[];
  leaf?: number;
}

const MODEL = crashModel as unknown as {
  features: string[];
  trees: TreeNode[];
  version: number;
  horizonDays: number;
  baseRate: number;
  walkForwardAuc: number[];
  calibration: { x: number[]; y: number[]; cap: number; floor: number };
  supportedCeiling: number;
  description: string;
};

export const CRASH_MODEL_VERSION = `crash-v${MODEL.version}-2026-08-24`;

/**
 * The sizing curve T8 actually validated (arm D, "defensive").
 *
 * Replaces `PLACEHOLDER_CURVE`, which was explicitly marked NOT fitted and NOT validated. All three
 * measured arms passed all seven pre-declared criteria; D won on every metric — Calmar 1.47 against
 * buy-and-hold's 0.08, drawdown cut 55%, and 789% of the benchmark's return retained.
 *
 * **The zero at high probability is deliberate and evidence-backed.** T15 tested adding an exposure
 * floor and it removed the benefit in proportion, so a "safer-looking" floor would be a change that
 * the measurement says makes the overlay worse.
 */
export const VALIDATED_CURVE: SizingCurve = {
  id: 'crash-t8-arm-d-2026-08-24',
  description: 'T8 arm D (defensive), the measured winner: Calmar 1.47 vs B&H 0.08, drawdown cut 55%. '
    + 'No exposure floor — T15 measured that a floor removes the benefit.',
  points: [
    { atProbability: 0.00, multiplier: 1.00, regime: 'LOW' },
    { atProbability: 0.30, multiplier: 1.00, regime: 'LOW' },
    { atProbability: 0.3001, multiplier: 0.50, regime: 'ELEVATED' },
    { atProbability: 0.50, multiplier: 0.50, regime: 'HIGH' },
    { atProbability: 0.5001, multiplier: 0.00, regime: 'EXTREME' },
    { atProbability: 1.00, multiplier: 0.00, regime: 'EXTREME' },
  ],
};

function evaluateTree(node: TreeNode, input: Record<string, number>): number {
  if (node.leaf !== undefined) return node.leaf;
  if (!node.split || node.split_condition === undefined) return 0;
  const goLeft = (input[node.split] ?? 0) < node.split_condition;
  const next = (node.children ?? []).find(c => c.nodeid === (goLeft ? node.yes : node.no));
  return next ? evaluateTree(next, input) : 0;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Calibrated P(>=10% drawdown within 10 days), clamped to the ceiling real data supports. */
export function crashProbability(features: Record<string, number>): number {
  const raw = sigmoid(MODEL.trees.reduce((s, t) => s + evaluateTree(t, features), 0));
  const { x, y, floor } = MODEL.calibration;
  const ceil = MODEL.supportedCeiling ?? MODEL.calibration.cap;
  if (x.length < 2) return Math.min(raw, ceil);
  if (raw <= x[0]) return Math.min(y[0], ceil);
  if (raw >= x[x.length - 1]) return Math.min(y[y.length - 1], ceil);
  let lo = 0;
  for (let i = 1; i < x.length; i++) { if (x[i] > raw) { lo = i - 1; break; } }
  const t = (raw - x[lo]) / (x[lo + 1] - x[lo]);
  return Math.min(Math.max(floor, y[lo] + t * (y[lo + 1] - y[lo])), ceil);
}

/**
 * Plain-language warning for a probability, or null when there is nothing to say.
 *
 * The episodic caveat is included at every level that triggers action, because a user who sees this
 * fire twice and then sit silent through a 25% drawdown would reasonably conclude it was broken —
 * when in fact absence-of-warning is a documented property, not a malfunction.
 */
/**
 * WARNING thresholds are RELATIVE TO THE BASE RATE, and deliberately not the sizing thresholds.
 *
 * The sizing curve fires at 0.30/0.50 because that is what T8 validated — those stay. But reusing
 * them for user-facing warnings was a mistake: the base rate is 41%, so nearly every symbol clears
 * 0.30 on an ordinary day. The first live screen showed SIX warnings reading 41/41/43/41/50/39%
 * against a 41% base — five of them were "today is a normal day" dressed as an alert, which trains
 * the user to ignore the one that matters.
 *
 * A warning has to mean "this is unusual", so it fires on the MARGIN over the base rate.
 */
const WARN_MARGIN = 0.08;      // ~49% absolute — noticeably above an average day
const HIGH_MARGIN = 0.18;      // ~59% absolute — rare

export function crashWarning(p: number): { level: 'ELEVATED' | 'HIGH'; message: string } | null {
  const base = MODEL.baseRate;
  const over = Math.round((p - base) * 100);
  const pct = (p * 100).toFixed(0);

  if (p >= base + HIGH_MARGIN) {
    return {
      level: 'HIGH',
      message: `A 10%+ drop in the next ${MODEL.horizonDays} days looks ${pct}% likely — ${over} points above `
        + `a normal day. Position sizes are cut. Note this gauge misses some big falls entirely, so a `
        + `quiet reading is never a green light.`,
    };
  }
  if (p >= base + WARN_MARGIN) {
    return {
      level: 'ELEVATED',
      message: `A 10%+ drop in the next ${MODEL.horizonDays} days looks ${pct}% likely — ${over} points above `
        + `a normal day. Position sizes are reduced.`,
    };
  }
  return null;    // at or near the base rate there is nothing to say
}

export function crashModelInfo() {
  return {
    version: CRASH_MODEL_VERSION,
    horizonDays: MODEL.horizonDays,
    baseRate: MODEL.baseRate,
    walkForwardAuc: MODEL.walkForwardAuc,
    features: MODEL.features.length,
    description: MODEL.description,
  };
}
