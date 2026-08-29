// Which Coinbase Derivatives (US, venue "cde") contract stands in for a MarketScope symbol.
//
// Verified against the public products API on 2026-08-28: BTC and ETH have the 2030-dated
// perpetual-style nanos (BIP-20DEC30-CDE = 0.01 BTC, ETP-20DEC30-CDE = 0.1 ETH); SOL, XRP and ADA
// exist only as MONTHLY dated futures (SOL x5, XRP x500, ADA x1000); DOGE has no US product at
// all. The true perps for all six live on INTX, which is not open to US persons, so the paper
// trader trades what the user can actually trade. Pure; the caller fetches the product list.

export interface ContractSpec {
  symbol: string;          // MarketScope symbol, e.g. SOLUSDT
  productId: string;       // Coinbase product id, e.g. SOL-25SEP26-CDE
  contractSize: number;    // units of underlying per contract
  tick: number;            // quote increment
  expiryMs: number | null; // null for the 2030 perp-style (treated as non-expiring within any hold)
  perpStyle: boolean;
}

const UNDERLYING: Record<string, string> = {
  BTCUSDT: 'BTC', ETHUSDT: 'ETH', SOLUSDT: 'SOL', XRPUSDT: 'XRP', ADAUSDT: 'ADA', DOGEUSDT: 'DOGE',
};

/** Product-id prefixes per underlying on the US venue. First match wins in this order. */
const PREFIXES: Record<string, RegExp[]> = {
  BTC: [/^BIP-/, /^BIT-/],
  ETH: [/^ETP-/, /^ET-/],
  SOL: [/^SOL-/],
  XRP: [/^XRP-/],
  ADA: [/^ADA-/],
  DOGE: [/^DOGE-/],
};

const PERP_STYLE = /^(BIP|ETP)-/;

/**
 * Pick one tradeable contract per symbol. A dated contract must expire at least `holdMs + buffer`
 * after `nowMs`, so a position can never be forced to roll inside its own holding window; among
 * eligible dated contracts the FRONT month wins (deepest book). Returns null for a symbol with no
 * usable US product — the caller reports it as untradeable rather than silently dropping it.
 */
export function resolveContracts(
  products: any[], symbols: string[], nowMs: number, holdMs: number, bufferMs = 24 * 3600_000,
): Record<string, ContractSpec | null> {
  const out: Record<string, ContractSpec | null> = {};
  for (const sym of symbols) {
    const und = UNDERLYING[sym];
    const prefixes = und ? PREFIXES[und] : undefined;
    if (!prefixes) { out[sym] = null; continue; }
    let pick: ContractSpec | null = null;
    for (const re of prefixes) {
      const cands: ContractSpec[] = [];
      for (const p of products) {
        const id: string = p?.product_id ?? '';
        if (!re.test(id) || !id.endsWith('-CDE')) continue;
        const fd = p.future_product_details ?? {};
        const size = Number(fd.contract_size), tick = Number(p.quote_increment);
        if (!(size > 0) || !(tick > 0)) continue;
        const perp = PERP_STYLE.test(id);
        const expiryMs = fd.contract_expiry ? Date.parse(fd.contract_expiry) : NaN;
        if (!perp) {
          if (!Number.isFinite(expiryMs) || expiryMs < nowMs + holdMs + bufferMs) continue;
        }
        cands.push({ symbol: sym, productId: id, contractSize: size, tick, expiryMs: perp ? null : expiryMs, perpStyle: perp });
      }
      if (cands.length) {
        cands.sort((a, b) => (a.expiryMs ?? Infinity) - (b.expiryMs ?? Infinity));   // front month first
        pick = cands[0];
        break;
      }
    }
    out[sym] = pick;
  }
  return out;
}
