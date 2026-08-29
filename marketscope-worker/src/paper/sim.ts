// The paper-trading state machine. Pure: it is driven by book updates and trade prints the Node
// process feeds it, and it never touches the network or the database itself.
//
// Fill rules — every one chosen to be conservative, because a paper trade can only flatter itself:
//   ENTRY   a SHORT sells into the BIDS, walking the live book to size at the moment of the signal.
//   STOP    armed above entry; TRIGGERS on the first trade print at or above it (not on a quote),
//           and FILLS by walking the ASKS as they stand — so a stop run through thin liquidity
//           costs what it would cost.
//   TARGET  a resting buy below entry; fills only once prints at or below the target price have
//           accumulated OUR size. A touch is not a fill: the real order would sit in a queue.
//   TIME    at the horizon the position is closed by walking the asks.
//   FEES    the user's measured 0.07% taker per side, plus Coinbase's flat $0.12 per contract per
//           side (NFA/exchange fee, basis.ts:61) — the part a percentage model forgets on cheap
//           contracts.
// What it cannot model, stated: the paper order removes no liquidity and holds no queue priority.

export interface Intent {
  symbol: string;
  direction: 'SHORT';
  /** The scanner's prices in the UNDERLYING's units; the sim re-anchors to the contract's book. */
  stopDistance: number;        // price units above entry
  targetDistance: number;      // price units below entry
  riskUsd: number;             // dollars at risk if the stop fills at its level
  holdMs: number;
  expectedValueR: number;
  source: string;              // e.g. 'scanner'
}

export interface Position {
  id: string;
  symbol: string;
  productId: string;
  contractSize: number;
  contracts: number;
  entryPrice: number;          // avg fill
  entryLevels: number;         // levels walked on entry (a slippage tell)
  entrySlippageBps: number;    // vs best bid at the time
  stopPrice: number;
  targetPrice: number;
  riskUsd: number;             // contracts * size * (stop - entry)
  openedAt: number;
  expiresAt: number;
  feesUsd: number;
  targetFilledQty: number;     // prints accumulated at/under the target so far
  status: 'open' | 'closed';
  exitPrice?: number;
  exitAt?: number;
  exitReason?: 'stop' | 'target' | 'time' | 'manual';
  pnlUsd?: number;             // net of fees
  realizedR?: number;          // pnlUsd / riskUsd
  intent: Intent;
}

export interface Fees { takerRate: number; perContractUsd: number }
export const DEFAULT_FEES: Fees = { takerRate: 0.0007, perContractUsd: 0.12 };

export interface SimLimits { maxOpen: number; onePerSymbol: boolean }
export const DEFAULT_SIM_LIMITS: SimLimits = { maxOpen: 3, onePerSymbol: true };

export interface BookLike {
  ready: boolean;
  bestBid(): number | null;
  bestAsk(): number | null;
  walk(side: 'buy' | 'sell', qty: number): { filled: number; avgPrice: number; levels: number; shortfall: number };
}

export type SimEvent =
  | { kind: 'opened'; position: Position }
  | { kind: 'closed'; position: Position }
  | { kind: 'rejected'; symbol: string; reason: string };

export class PaperSim {
  positions: Position[] = [];
  closed: Position[] = [];
  private seq = 0;

  constructor(public fees: Fees = DEFAULT_FEES, public limits: SimLimits = DEFAULT_SIM_LIMITS) {}

  get open(): Position[] { return this.positions.filter(p => p.status === 'open'); }

  /** Restore from persistence. Positions come back verbatim; the sim holds no other state. */
  load(open: Position[]): void { this.positions = open.filter(p => p.status === 'open'); }

  /**
   * Try to open a SHORT for an intent against the contract's live book. Size = whole contracts
   * from the risk budget at the FILLED entry (so a bad fill shrinks the position rather than the
   * stop). Returns the event; a rejection carries a plain reason.
   */
  openShort(
    intent: Intent, productId: string, contractSize: number, book: BookLike, nowMs: number, idSeed?: string,
  ): SimEvent {
    if (this.open.length >= this.limits.maxOpen) return { kind: 'rejected', symbol: intent.symbol, reason: `max ${this.limits.maxOpen} open positions` };
    if (this.limits.onePerSymbol && this.open.some(p => p.symbol === intent.symbol)) return { kind: 'rejected', symbol: intent.symbol, reason: 'already in a position on this symbol' };
    if (!book.ready) return { kind: 'rejected', symbol: intent.symbol, reason: 'no order book yet' };
    const bid = book.bestBid();
    if (bid == null || !(bid > 0)) return { kind: 'rejected', symbol: intent.symbol, reason: 'empty bid side' };
    if (!(intent.stopDistance > 0) || !(intent.riskUsd > 0)) return { kind: 'rejected', symbol: intent.symbol, reason: 'invalid intent geometry' };

    // Provisional size from the best bid, then re-derived from the actual average fill.
    let contracts = Math.max(1, Math.floor(intent.riskUsd / (contractSize * intent.stopDistance)));
    const w = book.walk('sell', contracts);
    if (w.filled < 1) return { kind: 'rejected', symbol: intent.symbol, reason: 'book too thin to fill one contract' };
    contracts = Math.floor(w.filled);
    const entry = w.avgPrice;
    const stop = entry + intent.stopDistance;
    const target = entry - intent.targetDistance;
    if (!(target > 0)) return { kind: 'rejected', symbol: intent.symbol, reason: 'target below zero' };
    const riskUsd = contracts * contractSize * intent.stopDistance;
    const fees = this.feeFor(contracts, contractSize, entry);
    const pos: Position = {
      id: idSeed ?? `paper-${nowMs}-${++this.seq}`,
      symbol: intent.symbol, productId, contractSize, contracts,
      entryPrice: entry, entryLevels: w.levels, entrySlippageBps: (bid - entry) / bid * 1e4,
      stopPrice: stop, targetPrice: target, riskUsd,
      openedAt: nowMs, expiresAt: nowMs + intent.holdMs, feesUsd: fees, targetFilledQty: 0,
      status: 'open', intent,
    };
    this.positions.push(pos);
    return { kind: 'opened', position: pos };
  }

  /** A public trade printed on `productId`. Drives stop triggers and target accumulation. */
  onTrade(productId: string, price: number, size: number, atMs: number, book: BookLike): SimEvent[] {
    const out: SimEvent[] = [];
    for (const p of this.open) {
      if (p.productId !== productId) continue;
      if (price >= p.stopPrice) {
        // Stop triggered: cover by walking the asks as they stand this instant.
        // Never better than the triggering print: that print proves the market traded at `price`,
        // so a book still showing asks below it is stale, not an opportunity.
        const w = book.walk('buy', p.contracts);
        const fill = Math.max(Number.isFinite(w.avgPrice) ? w.avgPrice : price, price);
        out.push(this.close(p, fill, atMs, 'stop'));
        continue;
      }
      if (price <= p.targetPrice) {
        p.targetFilledQty += size;
        if (p.targetFilledQty >= p.contracts) out.push(this.close(p, p.targetPrice, atMs, 'target'));
      }
    }
    return out;
  }

  /** Wall-clock: time exits. Called on every tick; books are looked up per product. */
  onClock(nowMs: number, books: (productId: string) => BookLike | undefined): SimEvent[] {
    const out: SimEvent[] = [];
    for (const p of this.open) {
      if (nowMs < p.expiresAt) continue;
      const b = books(p.productId);
      const ask = b?.bestAsk();
      if (!b || !b.ready || ask == null) continue;              // wait for a book; the clock will come back
      const w = b.walk('buy', p.contracts);
      out.push(this.close(p, Number.isFinite(w.avgPrice) ? w.avgPrice : ask, nowMs, 'time'));
    }
    return out;
  }

  closeManual(id: string, book: BookLike, nowMs: number): SimEvent | null {
    const p = this.open.find(x => x.id === id);
    if (!p) return null;
    const w = book.walk('buy', p.contracts);
    const ask = book.bestAsk();
    if (!Number.isFinite(w.avgPrice) && ask == null) return null;
    return this.close(p, Number.isFinite(w.avgPrice) ? w.avgPrice : (ask as number), nowMs, 'manual');
  }

  /** Mark-to-market at the best ask (what covering would cost right now). */
  unrealizedUsd(p: Position, book: BookLike | undefined): number | null {
    const ask = book?.bestAsk();
    if (ask == null) return null;
    return (p.entryPrice - ask) * p.contracts * p.contractSize - p.feesUsd;
  }

  private feeFor(contracts: number, contractSize: number, price: number): number {
    return contracts * contractSize * price * this.fees.takerRate + contracts * this.fees.perContractUsd;
  }

  private close(p: Position, exit: number, atMs: number, reason: Position['exitReason']): SimEvent {
    p.feesUsd += this.feeFor(p.contracts, p.contractSize, exit);
    p.exitPrice = exit; p.exitAt = atMs; p.exitReason = reason; p.status = 'closed';
    p.pnlUsd = (p.entryPrice - exit) * p.contracts * p.contractSize - p.feesUsd;
    p.realizedR = p.riskUsd > 0 ? p.pnlUsd / p.riskUsd : 0;
    this.positions = this.positions.filter(x => x.id !== p.id);
    this.closed.push(p);
    return { kind: 'closed', position: p };
  }
}

/** Summary statistics over closed positions — Tier 1 only (§25). */
export function paperStats(closed: Position[], startEquity: number) {
  const rs = closed.map(p => p.realizedR ?? 0);
  const pnl = closed.map(p => p.pnlUsd ?? 0);
  const wins = pnl.filter(x => x > 0), losses = pnl.filter(x => x < 0);
  const sumW = wins.reduce((a, b) => a + b, 0), sumL = Math.abs(losses.reduce((a, b) => a + b, 0));
  let eq = startEquity, peak = startEquity, maxDd = 0;
  for (const x of [...closed].sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0))) {
    eq += x.pnlUsd ?? 0; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq);
  }
  const byReason: Record<string, number> = {};
  for (const p of closed) byReason[p.exitReason ?? '?'] = (byReason[p.exitReason ?? '?'] ?? 0) + 1;
  return {
    n: closed.length,
    meanR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    winRate: rs.length ? rs.filter(r => r > 0).length / rs.length : null,
    profitFactor: sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : null),
    pnlUsd: pnl.reduce((a, b) => a + b, 0),
    feesUsd: closed.reduce((a, p) => a + p.feesUsd, 0),
    maxDrawdownUsd: maxDd,
    equity: eq,
    byReason,
    avgEntrySlippageBps: closed.length ? closed.reduce((a, p) => a + p.entrySlippageBps, 0) / closed.length : null,
  };
}
