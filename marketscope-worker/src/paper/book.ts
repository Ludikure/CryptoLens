// A level-2 order book, fed by Coinbase's `level2` channel (snapshot + incremental updates), that
// can be WALKED: "sell N contracts into the bids right now" returns the volume-weighted fill and how
// many levels it consumed. That walk is the whole point of the paper trader — a fill priced off a
// candle close assumes infinite depth at one price, and the backtest's two blind spots are spread
// and depth. Pure; no I/O.

export interface Level { price: number; qty: number }

export interface WalkResult {
  /** Contracts actually filled (may be less than requested on a thin book). */
  filled: number;
  /** Volume-weighted average fill price over `filled`; NaN when nothing filled. */
  avgPrice: number;
  /** Price of the last level touched. */
  worstPrice: number;
  levels: number;
  /** Requested minus filled. */
  shortfall: number;
}

export class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  updatedAt = 0;
  ready = false;

  /** Coinbase sends a full snapshot on subscribe (and after reconnect); it replaces everything. */
  applySnapshot(updates: Array<{ side: string; price_level: string; new_quantity: string }>, atMs: number): void {
    this.bids.clear(); this.asks.clear();
    this.applyUpdate(updates, atMs);
    this.ready = true;
  }

  /** Incremental update: `new_quantity` is the ABSOLUTE size at that level; 0 removes it. */
  applyUpdate(updates: Array<{ side: string; price_level: string; new_quantity: string }>, atMs: number): void {
    for (const u of updates) {
      const p = Number(u.price_level), q = Number(u.new_quantity);
      if (!(p > 0) || !Number.isFinite(q)) continue;
      const m = u.side === 'bid' ? this.bids : this.asks;
      if (q <= 0) m.delete(p); else m.set(p, q);
    }
    this.updatedAt = atMs;
  }

  bestBid(): number | null { let b: number | null = null; for (const p of this.bids.keys()) if (b == null || p > b) b = p; return b; }
  bestAsk(): number | null { let a: number | null = null; for (const p of this.asks.keys()) if (a == null || p < a) a = p; return a; }
  mid(): number | null {
    const b = this.bestBid(), a = this.bestAsk();
    return b != null && a != null ? (a + b) / 2 : null;
  }
  spreadBps(): number | null {
    const b = this.bestBid(), a = this.bestAsk(), m = this.mid();
    return b != null && a != null && m ? (a - b) / m * 1e4 : null;
  }

  /**
   * Fill `qty` contracts against one side. A SELL walks the bids (best first, descending); a BUY
   * walks the asks (ascending). The book is not mutated: a paper order removes nothing from the
   * real market, which is the one way this simulation is optimistic and is stated as such.
   */
  walk(side: 'buy' | 'sell', qty: number): WalkResult {
    const m = side === 'sell' ? this.bids : this.asks;
    const levels = [...m.entries()].sort((x, y) => side === 'sell' ? y[0] - x[0] : x[0] - y[0]);
    let remaining = qty, cost = 0, filled = 0, n = 0, worst = NaN;
    for (const [price, avail] of levels) {
      if (remaining <= 0) break;
      const take = Math.min(avail, remaining);
      cost += take * price; filled += take; remaining -= take; n++; worst = price;
    }
    return { filled, avgPrice: filled > 0 ? cost / filled : NaN, worstPrice: worst, levels: n, shortfall: remaining };
  }

  /** USD depth within `pct` of mid on one side — the liquidity read the depth snapshots use. */
  depthUsd(side: 'bid' | 'ask', pct: number, contractSize: number): number {
    const mid = this.mid(); if (!mid) return 0;
    const m = side === 'bid' ? this.bids : this.asks;
    let usd = 0;
    for (const [p, q] of m) {
      if (Math.abs(p - mid) / mid <= pct) usd += p * q * contractSize;
    }
    return usd;
  }

  size(): { bids: number; asks: number } { return { bids: this.bids.size, asks: this.asks.size }; }
}
