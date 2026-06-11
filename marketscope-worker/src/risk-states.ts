// Phase 5 (risk platform) — Risk states. Packages signals the worker already computes into
// discrete, first-class, direction-agnostic risk conditions: {state, severity, detail, validated}.
//
// HONESTY GATE: a state is `validated: true` only if it's grounded in the vol-clustering finding
// (low ATR / band extremes genuinely precede elevated realized vol — AUC 0.82). LIQUIDATION_SETUP
// and SQUEEZE_RISK are `validated: false` and capped at MEDIUM: ml-training/liq_bigmove_test.py
// proved liquidation positioning does NOT predict big moves beyond what ATR/vol already say, so
// they are RISK-MAP CONTEXT ("where a cascade could fire IF price gets there"), never vol forecasts.

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export interface RiskState { state: string; severity: Severity; detail: string; validated: boolean; }

export interface RiskStateInputs {
  atrPercentile?: number | null;        // daily ATR percentile 0–100
  bbSqueeze4h?: boolean; bbSqueezeDaily?: boolean;
  bbPercentBDaily?: number | null;      // daily Bollinger %B
  longPct?: number | null;              // crowding 0–100 (crypto)
  fundingZ?: number | null;             // funding z-score
  oiChangePct?: number | null;          // OI build (>0 = building)
  cvdFalling?: boolean;
  cascadeWithin2ATR?: boolean;
  macroImminent?: boolean;              // major event within stop-relevant horizon
  isCrypto?: boolean;
}

export function computeRiskStates(i: RiskStateInputs): RiskState[] {
  const out: RiskState[] = [];

  // COMPRESSION — VALIDATED: low ATR precedes vol expansion (vol clusters).
  if (i.atrPercentile != null && i.atrPercentile < 10) {
    const sq = !!(i.bbSqueeze4h && i.bbSqueezeDaily);
    const severity: Severity = i.atrPercentile < 5 ? 'HIGH' : sq ? 'MEDIUM' : 'LOW';
    out.push({ state: 'COMPRESSION', severity, validated: true,
      detail: `ATR percentile ${Math.round(i.atrPercentile)}%${sq ? ' + BB squeeze 4H & Daily' : ''} — vol compressed, a sharp expansion is structurally more likely` });
  }

  // EXTREME_BAND — VALIDATED: band blow-out is a continuation signal (fading is −EV).
  if (i.bbPercentBDaily != null && (i.bbPercentBDaily < 0 || i.bbPercentBDaily > 1)) {
    out.push({ state: 'EXTREME_BAND', severity: 'MEDIUM', validated: true,
      detail: `Daily %B ${i.bbPercentBDaily.toFixed(2)} (outside the band) — treat as continuation; fading band touches is −EV` });
  }

  // EVENT_WINDOW — VALIDATED: event vol can dominate the forecast.
  if (i.macroImminent) {
    out.push({ state: 'EVENT_WINDOW', severity: 'HIGH', validated: true,
      detail: 'Major event within the stop-relevant horizon — event-driven vol can dominate; widen or stand aside' });
  }

  // SQUEEZE_RISK — CONTEXT (crypto): crowded side + funding extreme + OI building.
  if (i.isCrypto && i.longPct != null && i.fundingZ != null && (i.oiChangePct ?? 0) > 0) {
    const crowdedLong = i.longPct > 65 && i.fundingZ > 2;
    const crowdedShort = i.longPct < 35 && i.fundingZ < -2;
    if (crowdedLong || crowdedShort) {
      const side = crowdedLong ? 'long' : 'short';
      out.push({ state: 'SQUEEZE_RISK', severity: 'MEDIUM', validated: false,
        detail: `Crowded ${side} (${Math.round(i.longPct)}% long, funding z ${i.fundingZ.toFixed(1)}) + OI building — squeeze fuel stacked on the ${side} side (positioning context)` });
    }
  }

  // LIQUIDATION_SETUP — CONTEXT (crypto): NOT a validated vol predictor (capped MEDIUM).
  if (i.isCrypto && i.longPct != null) {
    const conds = [i.longPct > 65, i.cvdFalling === true, i.cascadeWithin2ATR === true].filter(Boolean).length;
    if (conds >= 2) {
      out.push({ state: 'LIQUIDATION_SETUP', severity: conds === 3 ? 'MEDIUM' : 'LOW', validated: false,
        detail: `${Math.round(i.longPct)}% long${i.cvdFalling ? ' + CVD falling' : ''}${i.cascadeWithin2ATR ? ' + cascade zone within 2× ATR' : ''} — cascade fuel below (risk map: where it could accelerate IF support breaks, not a vol forecast)` });
    }
  }

  // Rank: HIGH first, validated before context.
  const sevRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || Number(b.validated) - Number(a.validated));
}
