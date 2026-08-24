/**
 * Cash-and-carry basis monitor (Coinbase Derivatives).
 *
 * WHY THIS EXISTS. Every directional strategy this project has tested measures as a coin flip
 * (docs/research/rejected-hypotheses.md), and the one candidate that survived does so precisely
 * because it needs no forecast: sell a dated future against spot already held, and collect the
 * premium as the contract converges to spot at expiry. Convergence is contractual, not predicted —
 * settlement is defined against the index price, so the gap closes whatever the market does.
 *
 * The trade is worth doing only SOMETIMES. Measured on BTC 2020-2026 the annualised carry ranges
 * from ~4% in bear regimes to 30-40%+ in leverage manias, and it is NEGATIVE about 14% of the time.
 * A monitor is therefore the product, not an execution bot: roughly four trades a year, and the
 * hard part is noticing when the premium is actually there.
 *
 * READ-ONLY BY DESIGN. This module places no orders and holds no trade-enabled credentials. It
 * reads public Coinbase market data only.
 */

/** A dated futures contract priced against spot. */
export interface BasisRow {
  productId: string;
  underlying: 'BTC' | 'ETH';
  futuresPrice: number;
  spotPrice: number;
  /** Raw premium of the future over spot, as a fraction (0.0107 = 1.07%). */
  basis: number;
  daysToExpiry: number;
  /** Premium annualised by compounding to a full year. */
  annualized: number;
  contractSize: number;
  /** Notional USD controlled by ONE contract, at spot. */
  notionalPerContract: number;
  volume24h: number | null;
  expiry: string;
}

/**
 * Annualise a raw basis over a holding period.
 *
 * Compounded rather than simple, because the position is rollable — capturing 1.07% over 33 days
 * repeatedly is a compounding process, and simple scaling would understate a short-dated contract.
 * Returns null for degenerate inputs rather than Infinity, so a same-day expiry cannot produce a
 * headline number that looks like an opportunity.
 */
export function annualizeBasis(spot: number, futuresPrice: number, daysToExpiry: number): number | null {
  if (!(spot > 0) || !(futuresPrice > 0) || !(daysToExpiry > 0.5)) return null;
  const basis = futuresPrice / spot - 1;
  // Guard the exponent: a sub-day expiry compounds an execution artifact into a fantasy rate.
  const periods = 365 / daysToExpiry;
  if (periods > 400) return null;
  return Math.pow(1 + basis, periods) - 1;
}

/**
 * Net the gross basis down to what actually reaches the user.
 *
 * `feePerSide` defaults to **0.0007** — the user's actual Coinbase **Advanced 2** derivatives taker
 * rate (0.070%; maker is 0.065%). This replaces an earlier 0.001 placeholder taken from a generic
 * retail tier, which understated the carry.
 *
 * NOT included and worth knowing: Coinbase charges a FLAT **$0.12 per contract** for NFA/exchange/
 * clearing. That is size-dependent, so it cannot live in a percentage: on a nano BTC contract
 * (0.01 BTC ~ $773) it is 0.0155% per side, but on a nano ETH contract (0.1 ETH ~ $244) it is
 * 0.049% per side — three times heavier. Subtract ~0.03% (BTC) or ~0.10% (ETH) round trip from any
 * net figure here.
 *
 * The covered form still nets best (futures legs only). But buying the spot leg is NOT dead at this
 * tier: spot maker is 0.125%, so a bought-spot carry still clears ~9% annualized against a ~1.2%
 * basis. See docs/research/funding-carry.md.
 */
export function netAnnualized(
  spot: number,
  futuresPrice: number,
  daysToExpiry: number,
  feePerSide = 0.0007,
): number | null {
  if (!(spot > 0) || !(futuresPrice > 0) || !(daysToExpiry > 0.5)) return null;
  const gross = futuresPrice / spot - 1;
  const net = gross - 2 * feePerSide;
  const periods = 365 / daysToExpiry;
  if (periods > 400) return null;
  // A net loss cannot be compounded through a fractional power — report the linear rate instead.
  if (net <= -1) return null;
  return net < 0 ? net * periods : Math.pow(1 + net, periods) - 1;
}

/**
 * Distance (as a fraction of spot) that price may rally before the short futures leg is liquidated.
 *
 * This is the ONE way a correctly-hedged carry loses money: the futures leg and the spot leg sit in
 * separate accounts and are not cross-margined, so a rally drains futures margin while the
 * offsetting spot gain is unreachable. At Coinbase's ~28.9% overnight short margin rate the buffer
 * is roughly a 29% rally — close enough to matter in crypto, and the reason this is monitored.
 */
export function rallyToMarginCall(marginRate: number, cushionMultiple = 1): number | null {
  if (!(marginRate > 0) || !(cushionMultiple > 0)) return null;
  return marginRate * cushionMultiple;
}

const CB_PRODUCTS = 'https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&limit=250';
const CB_TICKER = (p: string) => `https://api.exchange.coinbase.com/products/${p}/ticker`;
const UA = 'MarketScope/1.0';

/** Product-id prefixes Coinbase uses for the nano contracts. `BIP`/`ETP` are the 2030 perp-style. */
function underlyingOf(productId: string): 'BTC' | 'ETH' | null {
  if (/^BI[TP]-/.test(productId)) return 'BTC';
  if (/^ETP?-/.test(productId)) return 'ETH';
  return null;
}

async function getJson(url: string, timeoutMs = 10_000): Promise<any> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Build the live basis table.
 *
 * Deliberately excludes the perp-style 2030 contracts: their expiry is far enough out that
 * annualising their premium is meaningless, and Coinbase publishes no funding rate for them
 * (`funding_rate` comes back empty), so their true carry is not observable from public data.
 */
export async function fetchBasisRows(nowMs: number): Promise<BasisRow[]> {
  const [spotBtc, spotEth, products] = await Promise.all([
    getJson(CB_TICKER('BTC-USD')).then((d: any) => Number(d.price)).catch(() => NaN),
    getJson(CB_TICKER('ETH-USD')).then((d: any) => Number(d.price)).catch(() => NaN),
    getJson(CB_PRODUCTS).then((d: any) => d.products ?? []).catch(() => []),
  ]);
  const spot: Record<string, number> = { BTC: spotBtc, ETH: spotEth };
  const rows: BasisRow[] = [];

  for (const p of products as any[]) {
    const und = underlyingOf(p.product_id ?? '');
    const fd = p.future_product_details ?? {};
    const px = Number(p.price);
    const s = und ? spot[und] : NaN;
    if (!und || !fd.contract_expiry || !(px > 0) || !(s > 0)) continue;

    const expMs = Date.parse(fd.contract_expiry);
    if (!Number.isFinite(expMs)) continue;
    const days = (expMs - nowMs) / 86_400_000;
    // Skip expired, same-day (execution noise dominates) and the 2030 perp-style contracts.
    if (days <= 1 || days > 400) continue;

    const annualized = annualizeBasis(s, px, days);
    if (annualized == null) continue;
    const size = Number(fd.contract_size) || 0;
    rows.push({
      productId: p.product_id,
      underlying: und,
      futuresPrice: px,
      spotPrice: s,
      basis: px / s - 1,
      daysToExpiry: days,
      annualized,
      contractSize: size,
      notionalPerContract: size * s,
      volume24h: p.volume_24h != null ? Number(p.volume_24h) : null,
      expiry: fd.contract_expiry,
    });
  }
  return rows.sort((a, b) => b.annualized - a.annualized);
}

export interface BasisAlert {
  row: BasisRow;
  netAnnual: number;
  reason: string;
}

/**
 * Decide whether any contract is paying enough to be worth acting on.
 *
 * Gated on the NET rate, and on liquidity — an attractive-looking premium on a contract with no
 * volume is a stale print, not an opportunity, and crossing a wide spread to reach it would give
 * back most of the edge. `minVolume` is deliberately conservative for that reason.
 */
export function findBasisOpportunities(
  rows: BasisRow[],
  minNetAnnual = 0.10,
  minVolume = 1000,
  feePerSide = 0.001,
): BasisAlert[] {
  const out: BasisAlert[] = [];
  for (const r of rows) {
    if (r.volume24h != null && r.volume24h < minVolume) continue;
    const net = netAnnualized(r.spotPrice, r.futuresPrice, r.daysToExpiry, feePerSide);
    if (net == null || net < minNetAnnual) continue;
    out.push({
      row: r,
      netAnnual: net,
      reason: `${r.underlying} ${(net * 100).toFixed(1)}% net annualized `
        + `(${(r.basis * 100).toFixed(2)}% over ${Math.round(r.daysToExpiry)}d)`,
    });
  }
  return out;
}
