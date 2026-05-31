// Enrichment builders for POST /full-analysis — faithful TS ports of the iOS enrichment so the
// worker can populate buildUserPrompt's optional inputs. Currently: crypto derivatives +
// positioning (DerivativesService + PositioningAnalyzer) and macro (FRED via the /macro cache).
// Stock fundamentals / sentiment / cross-asset / economic events are layered in subsequently.

import type { DerivativesData, PositioningSnapshot, MacroSnapshot, SpotPressure } from './prompt';

interface Env { ALERTS: KVNamespace; }

const FAPI = 'https://fapi.binance.com';
const num = (s: unknown): number | null => { const v = typeof s === 'string' ? parseFloat(s) : typeof s === 'number' ? s : NaN; return isNaN(v) ? null : v; };

// ── DerivativesService.parseBinance* + buildResult ──
function parseLS(data: any): { long: number; short: number } {
  const first = Array.isArray(data) ? data[0] : null;
  const l = num(first?.longAccount), s = num(first?.shortAccount);
  if (l == null || s == null) return { long: 50, short: 50 };
  return { long: l * 100, short: s * 100 };
}
function parseTaker(data: any): { ratio: number; buy: number; sell: number } {
  const first = Array.isArray(data) ? data[0] : null;
  const ratio = num(first?.buySellRatio), buy = num(first?.buyVol), sell = num(first?.sellVol);
  if (ratio == null || buy == null || sell == null) return { ratio: 1.0, buy: 0, sell: 0 };
  return { ratio, buy, sell };
}
function parseOIHistory(oih: any): { change4h: number | null; change24h: number | null } {
  if (!Array.isArray(oih) || oih.length < 2) return { change4h: null, change24h: null };
  let change4h: number | null = null, change24h: number | null = null;
  const latest = num(oih[oih.length - 1]?.sumOpenInterest), prev = num(oih[oih.length - 2]?.sumOpenInterest);
  if (latest != null && prev != null && prev > 0) change4h = (latest - prev) / prev * 100;
  if (oih.length >= 6) {
    const first = num(oih[0]?.sumOpenInterest);
    if (latest != null && first != null && first > 0) change24h = (latest - first) / first * 100;
  }
  return { change4h, change24h };
}

// raw = { premiumIndex, fundingHistory, openInterest, oiHistory, globalLS, topTraderLS, takerRatio }
export function parseDerivatives(raw: any): DerivativesData | null {
  const pi = raw?.premiumIndex;
  const fr = num(pi?.lastFundingRate), mp = num(pi?.markPrice), ip = num(pi?.indexPrice);
  if (fr == null || mp == null || ip == null) return null;
  const oiVal = num(raw?.openInterest?.openInterest);
  if (oiVal == null) return null;
  const fh: number[] = Array.isArray(raw?.fundingHistory)
    ? raw.fundingHistory.map((e: any) => num(e?.fundingRate)).filter((x: number | null): x is number => x != null) : [];
  const avgFR = fh.length ? fh.reduce((a, b) => a + b, 0) / fh.length : fr;
  const oiH = parseOIHistory(raw?.oiHistory);
  const gls = parseLS(raw?.globalLS), ttls = parseLS(raw?.topTraderLS), taker = parseTaker(raw?.takerRatio);
  return {
    fundingRatePercent: fr * 100,
    avgFundingRate: avgFR,
    openInterestUSD: oiVal * mp,
    oiChange4h: oiH.change4h,
    oiChange24h: oiH.change24h,
    globalLongPercent: gls.long,
    globalShortPercent: gls.short,
    topTraderLongPercent: ttls.long,
    topTraderShortPercent: ttls.short,
    takerBuySellRatio: taker.ratio,
    takerBuyVolume: taker.buy,
  };
}

// ── PositioningAnalyzer.analyze ──
export function analyzePositioning(d: DerivativesData): PositioningSnapshot {
  const crowdingCode = d.globalLongPercent > 60 ? 'crowdedLong' : d.globalShortPercent > 60 ? 'crowdedShort' : 'balanced';
  const crowding = crowdingCode === 'crowdedLong' ? 'Crowded Long' : crowdingCode === 'crowdedShort' ? 'Crowded Short' : 'Balanced';
  const fr = d.fundingRatePercent;
  const fundingSentiment = fr > 0.05 ? 'Elevated positive (longs paying)' : fr > 0.01 ? 'Positive (normal)'
    : fr < -0.05 ? 'Elevated negative (shorts paying)' : fr < -0.01 ? 'Negative (slight short bias)' : 'Neutral';
  const oiTrend = d.oiChange4h != null ? (d.oiChange4h > 3 ? 'Building' : d.oiChange4h < -3 ? 'Unwinding' : 'Stable') : 'Stable';
  const smartMoneyBias = d.topTraderLongPercent > 55 ? 'Leaning long' : d.topTraderShortPercent > 55 ? 'Leaning short' : 'Neutral';
  const takerPressure = d.takerBuySellRatio > 1.3 ? 'Strong buy pressure' : d.takerBuySellRatio > 1.1 ? 'Slight buy pressure'
    : d.takerBuySellRatio < 0.7 ? 'Strong sell pressure' : d.takerBuySellRatio < 0.9 ? 'Slight sell pressure' : 'Balanced';

  let squeezeRisk = { level: 'NONE', direction: '' };
  if (crowdingCode === 'crowdedLong' && fr > 0.05 && oiTrend === 'Building') squeezeRisk = { level: 'HIGH', direction: 'LONG SQUEEZE' };
  else if (crowdingCode === 'crowdedShort' && fr < -0.05 && oiTrend === 'Building') squeezeRisk = { level: 'HIGH', direction: 'SHORT SQUEEZE' };
  else if (crowdingCode === 'crowdedLong' && fr > 0.03) squeezeRisk = { level: 'MODERATE', direction: 'LONG SQUEEZE' };
  else if (crowdingCode === 'crowdedShort' && fr < -0.03) squeezeRisk = { level: 'MODERATE', direction: 'SHORT SQUEEZE' };

  const signals: Array<{ strength: string; message: string }> = [];
  if (squeezeRisk.level === 'HIGH') {
    const pct = Math.trunc(Math.max(d.globalLongPercent, d.globalShortPercent));
    signals.push({ strength: 'Strong', message: `${squeezeRisk.direction} risk — ${pct}% on one side with ${fr > 0 ? 'positive' : 'negative'} funding and ${oiTrend.toLowerCase()} OI` });
  }
  const retailLong = d.globalLongPercent > 55, smartLong = d.topTraderLongPercent > 55;
  if (retailLong !== smartLong) {
    signals.push({ strength: 'Moderate', message: `Smart money divergence — top traders ${smartMoneyBias.toLowerCase()} while retail ${retailLong ? 'long' : 'short'}` });
  }
  if (d.takerBuySellRatio > 1.3 || d.takerBuySellRatio < 0.7) {
    signals.push({ strength: 'Moderate', message: `Aggressive ${d.takerBuySellRatio > 1 ? 'buying' : 'selling'} — taker ratio ${d.takerBuySellRatio.toFixed(2)}` });
  }
  return { fundingSentiment, oiTrend, crowding, crowdingCode, smartMoneyBias, takerPressure, squeezeRisk, signals };
}

// Fetch raw derivatives (reuse the /derivatives 5-min cache; fetch + cache on miss), then build
// the DerivativesData + PositioningSnapshot pair. Returns null for non-crypto or on failure.
export async function fetchDerivativesEnrichment(env: Env, symbol: string): Promise<{ derivatives: DerivativesData; positioning: PositioningSnapshot } | null> {
  const cacheKey = `cache:deriv:${symbol}`;
  let raw: any = null;
  try {
    const cached = await env.ALERTS.get(cacheKey);
    if (cached) { const p = JSON.parse(cached); if (Date.now() - p.timestamp < 300_000) raw = p.data; }
  } catch { /* ignore */ }
  if (!raw) {
    try {
      const [pi, fh, oi, oih, gls, ttls, tr] = await Promise.all([
        fetch(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=10`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=6`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${FAPI}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=1`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=1`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      raw = { premiumIndex: pi, fundingHistory: fh, openInterest: oi, oiHistory: oih, globalLS: gls, topTraderLS: ttls, takerRatio: tr };
      if (pi) { try { await env.ALERTS.put(cacheKey, JSON.stringify({ data: raw, timestamp: Date.now() }), { expirationTtl: 300 }); } catch { /* ignore */ } }
    } catch { return null; }
  }
  const derivatives = parseDerivatives(raw);
  if (!derivatives) return null;
  return { derivatives, positioning: analyzePositioning(derivatives) };
}

// ── SpotPressureAnalyzer.analyze (crypto) — faithful port ──
// Taker buy ratio + CVD from 24×1h klines (kline[9] = taker buy base vol), order-book
// imbalance from depth. Fetches its own data from Binance (same source as iOS).
const BINANCE_DATA = 'https://data-api.binance.vision/api/v3';
export function computeSpotPressure(klines: any[], depth: any): SpotPressure | null {
  let totalVolume = 0, totalTakerBuy = 0;
  const deltas: number[] = [];
  for (const k of klines) {
    if (!Array.isArray(k) || k.length < 10) continue;
    const vol = num(k[5]), tb = num(k[9]);
    if (vol == null || tb == null) continue;
    totalVolume += vol; totalTakerBuy += tb;
    deltas.push(tb - (vol - tb));
  }
  if (!(totalVolume > 0) || deltas.length === 0) return null;
  const buyRatio = totalTakerBuy / totalVolume;
  const buyLabel = buyRatio > 0.55 ? 'Aggressive Buying' : buyRatio < 0.45 ? 'Aggressive Selling' : 'Neutral';
  const cvd = deltas.reduce((a, b) => a + b, 0);
  const half = Math.floor(deltas.length / 2);
  const firstHalf = deltas.slice(0, half).reduce((a, b) => a + b, 0);
  const secondHalf = deltas.slice(deltas.length - half).reduce((a, b) => a + b, 0);
  const cvdTrend = secondHalf > firstHalf * 1.2 ? 'Rising' : secondHalf < firstHalf * 0.8 ? 'Falling' : 'Flat';
  let bookRatio: number | null = null, bookLabel: string | null = null;
  const bids = depth?.bids, asks = depth?.asks;
  if (Array.isArray(bids) && Array.isArray(asks)) {
    const bidQty = bids.reduce((a: number, b: any) => a + (num(b?.[1]) ?? 0), 0);
    const askQty = asks.reduce((a: number, b: any) => a + (num(b?.[1]) ?? 0), 0);
    const total = bidQty + askQty;
    if (total > 0) {
      bookRatio = bidQty / total;
      bookLabel = bookRatio > 0.6 ? 'Strong Bid Support' : bookRatio < 0.4 ? 'Heavy Ask Pressure' : 'Balanced';
    }
  }
  return { takerBuyRatio: buyRatio, takerBuyLabel: buyLabel, cvd24h: cvd, cvdTrend, bookRatio, bookLabel };
}
export async function fetchSpotPressureEnrichment(symbol: string): Promise<SpotPressure | null> {
  try {
    const [klines, depth] = await Promise.all([
      fetch(`${BINANCE_DATA}/klines?symbol=${symbol}&interval=1h&limit=24`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${BINANCE_DATA}/depth?symbol=${symbol}&limit=20`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    if (!Array.isArray(klines)) return null;
    return computeSpotPressure(klines, depth);
  } catch { return null; }
}

// Macro snapshot from the /macro cache (FRED + DXY). Best-effort — returns null if uncached.
export async function fetchMacroEnrichment(env: Env): Promise<MacroSnapshot | null> {
  try {
    const cached = await env.ALERTS.get('cache:macro:v3');
    if (!cached) return null;
    const { data } = JSON.parse(cached) as { data: Record<string, any> };
    if (!data) return null;
    return {
      vix: data.vix ?? null, treasury10Y: data.treasury10Y ?? null, treasury2Y: data.treasury2Y ?? null,
      yieldSpread: data.yieldSpread ?? null, fedFundsRate: data.fedFundsRate ?? null, usdIndex: data.usdIndex ?? null,
      macroRegime: data.macroRegime ?? null,
    };
  } catch { return null; }
}
