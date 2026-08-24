/**
 * Research harness (spec §19, §25).
 *
 * Every model runs against the SAME control set, automatically, and a headline metric alone never
 * constitutes a result. That rule is not procedural fussiness — it is the single thing that
 * distinguishes the findings in this vault that survived from the ones that did not:
 *
 *   T5   passed all 5 numbered criteria including an untouched holdout, then a lagged realised-vol
 *        rule beat the model outright. Killed by a control.
 *   T6   3 of 5 criteria passed, then equal-weight beat rotation and rotation tied random. Killed.
 *   T14  the permutation control INVERTED — shuffled histories scored better than real ones.
 *   T22  three validations passed on per-symbol AUC; the cross-sectional axis had collapsed −0.1021.
 *
 * In each case the numbered ship bar said yes. The controls said no, and the controls were right.
 */

import { discrimination, performance, turnover, applyCosts,
         type DiscriminationMetrics, type Observation, type PerformanceMetrics } from './metrics';

/** A named control that transforms a signal series into a null-hypothesis version of itself. */
export interface Control {
  readonly id: string;
  readonly rationale: string;
  transform(obs: readonly Observation[], seed: number): Observation[];
}

/**
 * Shuffled timing: distribution preserved, temporal ordering destroyed.
 *
 * The workhorse. If a strategy survives this, the benefit was never about *when* it acted — which
 * is what T14 discovered when permuted histories outperformed real ones.
 */
export const SHUFFLED_TIMING: Control = {
  id: 'shuffled-timing',
  rationale: 'score distribution preserved, timing destroyed — isolates whether timing carries information',
  transform(obs, seed) {
    const scores = obs.map(o => o.score);
    const perm = seededPermutation(scores.length, seed);
    return obs.map((o, i) => ({ ...o, score: scores[perm[i]] }));
  },
};

/**
 * Randomised labels: outcomes shuffled, scores untouched. Must collapse to AUC ≈ 0.50.
 *
 * This is the pipeline's own sanity check. A harness that cannot return 0.50 on random labels cannot
 * be trusted when it returns 0.76 on real ones.
 */
export const RANDOM_LABELS: Control = {
  id: 'random-labels',
  rationale: 'outcomes shuffled — the pipeline must be able to return chance, or its wins mean nothing',
  transform(obs, seed) {
    const outcomes = obs.map(o => o.outcome);
    const perm = seededPermutation(outcomes.length, seed);
    return obs.map((o, i) => ({ ...o, outcome: outcomes[perm[i]] }));
  },
};

/**
 * Lag the signal. T12 measured this precisely: a 30-day lag cut the crash overlay's Calmar from
 * 1.47 to 0.20, because the value IS the lead time. A strategy indifferent to lag is reading
 * something slow and probably already priced.
 */
export function lagControl(periods: number): Control {
  return {
    id: `lag-${periods}`,
    rationale: `signal delayed ${periods} periods — a strategy indifferent to lag is not using timing`,
    transform(obs) {
      const byAsset: Record<string, Observation[]> = {};
      for (const o of obs) (byAsset[o.asset] ??= []).push(o);
      const out: Observation[] = [];
      for (const rows of Object.values(byAsset)) {
        const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);
        for (let i = periods; i < sorted.length; i++) {
          out.push({ ...sorted[i], score: sorted[i - periods].score });
        }
      }
      return out;
    },
  };
}

/** Deterministic Fisher-Yates. Seeded so every control run is reproducible from the report. */
function seededPermutation(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000; };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

export const MANDATORY_CONTROLS: readonly Control[] = [SHUFFLED_TIMING, RANDOM_LABELS, lagControl(30)];

// ── evaluation ────────────────────────────────────────────────────────────────

export interface CostSweepRow { roundTripPercent: number; performance: PerformanceMetrics; }

export interface EvaluationReport {
  label: string;
  discrimination: DiscriminationMetrics;
  /** Present only when a return/weight series was supplied. */
  performance?: PerformanceMetrics;
  turnoverPerYear?: number;
  /** Spec §22: never report a single friction level. */
  costSweep?: CostSweepRow[];
  controls: Array<{
    id: string;
    rationale: string;
    discrimination: DiscriminationMetrics;
    /** Real minus control on each axis. Both, always. */
    deltaPerSymbolAuc: number;
    deltaWithinTimestampAuc: number;
  }>;
  /** Per-regime slices, so no result rests on a single historical episode (spec §25.5). */
  regimes?: Record<string, DiscriminationMetrics>;
  warnings: string[];
}

export interface EvaluateInput {
  label: string;
  observations: readonly Observation[];
  /** Optional strategy return series, aligned with `weights`. */
  returns?: readonly number[];
  weights?: readonly number[];
  /** Named date ranges for the regime sweep. */
  regimes?: Record<string, { from: number; to: number }>;
  controls?: readonly Control[];
  costLevels?: readonly number[];
  seed?: number;
}

/**
 * Run a full evaluation. Warnings are emitted for the conditions that have previously produced
 * false findings here — they are not fatal, but an unwarned report is not the same as a clean one.
 */
export function evaluate(input: EvaluateInput): EvaluationReport {
  const seed = input.seed ?? 42;
  const controls = input.controls ?? MANDATORY_CONTROLS;
  const costs = input.costLevels ?? [0, 0.10, 0.25];
  const warnings: string[] = [];

  const real = discrimination(input.observations);

  if (real.timestampsEvaluated < 30) {
    warnings.push(`only ${real.timestampsEvaluated} timestamps had enough assets for a cross-sectional AUC — ` +
      `the within-timestamp figure is underpowered`);
  }
  if (Number.isNaN(real.withinTimestampAuc)) {
    warnings.push('within-timestamp AUC could not be computed: this evaluation covers ONE axis only, ' +
      'which is the configuration that let a bad prune pass three validations');
  }

  const controlReports = controls.map(c => {
    const d = discrimination(c.transform(input.observations, seed));
    return {
      id: c.id, rationale: c.rationale, discrimination: d,
      deltaPerSymbolAuc: real.perSymbolAuc - d.perSymbolAuc,
      deltaWithinTimestampAuc: real.withinTimestampAuc - d.withinTimestampAuc,
    };
  });

  const randomLabels = controlReports.find(c => c.id === 'random-labels');
  if (randomLabels && Math.abs(randomLabels.discrimination.perSymbolAuc - 0.5) > 0.03) {
    warnings.push(`random-label control returned AUC ${randomLabels.discrimination.perSymbolAuc.toFixed(3)} ` +
      `instead of ~0.500 — the pipeline itself may be leaking`);
  }

  const report: EvaluationReport = { label: input.label, discrimination: real, controls: controlReports, warnings };

  if (input.returns && input.returns.length) {
    report.performance = performance(input.returns);
    if (input.weights) {
      report.turnoverPerYear = turnover(input.weights);
      report.costSweep = costs.map(pct => ({
        roundTripPercent: pct,
        performance: performance(applyCosts(input.returns!, input.weights!, pct / 100)),
      }));
    }
  }

  if (input.regimes) {
    report.regimes = {};
    for (const [name, { from, to }] of Object.entries(input.regimes)) {
      const slice = input.observations.filter(o => o.timestamp >= from && o.timestamp <= to);
      if (slice.length) report.regimes[name] = discrimination(slice);
    }
  }

  return report;
}

/**
 * Does the result survive its controls?
 *
 * Deliberately requires BOTH axes to beat every control, because a model can beat shuffled timing on
 * per-symbol AUC while having no cross-sectional information at all — which is exactly the state a
 * pruned model reached before being reverted.
 */
export function survivesControls(report: EvaluationReport, minEdge = 0.02): { passes: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const c of report.controls) {
    if (c.id === 'random-labels') continue;   // this one is a pipeline check, not a competitor
    if (!(c.deltaPerSymbolAuc >= minEdge)) {
      failures.push(`${c.id}: per-symbol edge ${c.deltaPerSymbolAuc.toFixed(4)} < ${minEdge}`);
    }
    if (!Number.isNaN(c.deltaWithinTimestampAuc) && !(c.deltaWithinTimestampAuc >= minEdge)) {
      failures.push(`${c.id}: within-timestamp edge ${c.deltaWithinTimestampAuc.toFixed(4)} < ${minEdge}`);
    }
  }
  return { passes: failures.length === 0, failures };
}
