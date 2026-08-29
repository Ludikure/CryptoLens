// Scanner rows → paper intents. Pure, so the exact gate the bot applies is testable without a
// book or a network. Mirrors what the APP shows the user: the display floor (`MIN_DISPLAY_EV_R`),
// and the mood cancel the app applies client-side (a SHORT in greed is withheld, §6 — the one mood
// where the short edge measured negative). Anything the app would not have shown, the bot does
// not trade; the paper record must be a record of the product, not of a looser cousin.

import type { Intent } from './sim';

export interface AcceptedRowLike {
  candidate: {
    asset: string; direction: string; entryPrice: number; stopPrice: number; targetPrice: number;
    payoff: { expectedValueR: number };
  };
  sizing: { riskFraction: number };
}

export interface IntentGate { minEv: number; greedAbove: number; holdHours: number }
export const DEFAULT_INTENT_GATE: IntentGate = { minEv: 0.05, greedAbove: 60, holdHours: 72 };

export function intentsFromBook(
  accepted: AcceptedRowLike[],
  fearGreed: number | null,
  equity: number,
  gate: IntentGate = DEFAULT_INTENT_GATE,
): { intents: Intent[]; skipped: Array<{ symbol: string; reason: string }> } {
  const intents: Intent[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];
  for (const a of accepted) {
    const c = a.candidate;
    if (c.direction !== 'SHORT') { skipped.push({ symbol: c.asset, reason: `${c.direction}: only SHORT is validated` }); continue; }
    if (!(c.payoff.expectedValueR >= gate.minEv)) { skipped.push({ symbol: c.asset, reason: `EV ${c.payoff.expectedValueR.toFixed(3)}R under the ${gate.minEv}R floor` }); continue; }
    if (fearGreed != null && fearGreed > gate.greedAbove) { skipped.push({ symbol: c.asset, reason: `mood is greed (${fearGreed}) — short edge measured negative there` }); continue; }
    const stopDistance = Math.abs(c.stopPrice - c.entryPrice);
    const targetDistance = Math.abs(c.entryPrice - c.targetPrice);
    const riskUsd = equity * a.sizing.riskFraction;
    if (!(stopDistance > 0) || !(targetDistance > 0) || !(riskUsd > 0)) { skipped.push({ symbol: c.asset, reason: 'degenerate geometry or zero size' }); continue; }
    intents.push({
      symbol: c.asset, direction: 'SHORT', stopDistance, targetDistance, riskUsd,
      holdMs: gate.holdHours * 3600_000, expectedValueR: c.payoff.expectedValueR, source: 'scanner',
    });
  }
  return { intents, skipped };
}
