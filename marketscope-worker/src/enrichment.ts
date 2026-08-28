// Enrichment builders for POST /full-analysis — faithful TS ports of the iOS enrichment so the
// worker can populate buildUserPrompt's optional inputs. Currently: crypto derivatives +
// positioning (DerivativesService + PositioningAnalyzer) and macro (FRED via the /macro cache).
// Stock fundamentals / sentiment / cross-asset / economic events are layered in subsequently.

import type { DerivativesData, PositioningSnapshot, MacroSnapshot, SpotPressure, CoinInfo, CrossAssetContext, StockInfo, StockSentimentData } from './prompt';
import { emaArray, sectorETFForSymbol } from './scoring-full';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// 1-day % return from a daily-close series (last vs prior). null when insufficient data.
function pct1d(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const a = closes[closes.length - 2], b = closes[closes.length - 1];
  return a > 0 ? (b - a) / a * 100 : null;
}

// Local structural view of the real `Env`. `FINNHUB_API_KEY` was READ below but not declared
// here, so a typo or a removed binding would have been invisible — and a missing key is
// exactly what left the Finnhub badge stuck red on 2026-07-14. Optional because the box may
// legitimately run without it; the call sites already guard.
interface Env { ALERTS: KVNamespace; FINNHUB_API_KEY?: string; }

const YAHOO = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

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

// Finnhub GET with a 12h KV cache. Best-effort — null on any failure or when unconfigured.
async function fetchFinnhubJSON(env: Env, pathAndQuery: string): Promise<any> {
  if (!env.FINNHUB_API_KEY) return null;
  const cacheKey = `cache:fhenrich:${pathAndQuery}`;
  try {
    const cached = await env.ALERTS.get(cacheKey);
    if (cached) { const p = JSON.parse(cached); if (Date.now() - p.timestamp < 43200_000) return p.data; }
  } catch { /* ignore */ }
  try {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const r = await fetch(`${FINNHUB_BASE}${pathAndQuery}${sep}token=${env.FINNHUB_API_KEY}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const data = await r.json();
    try { await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 43200 }); } catch { /* ignore */ }
    return data;
  } catch { return null; }
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
  // Sign-aware trend compare (2026-07-02): the old multiplicative compare (second > first*1.2)
  // mis-signed for NEGATIVE CVD — with firstHalf = -500, a WORSENING -590 satisfied
  // -590 > -600 → "Rising", and the Flat band was empty for negatives. Compare by difference
  // against a 20%-of-magnitude threshold instead (feeds cvd_divergence_* exhaustion signals,
  // WHALE TRAP cvdAgainst, and the LIQUIDATION_SETUP risk state).
  const cvdThr = 0.2 * Math.abs(firstHalf);
  const cvdTrend = secondHalf - firstHalf > cvdThr ? 'Rising' : firstHalf - secondHalf > cvdThr ? 'Falling' : 'Flat';
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
// Instrumented fetch so a spot-pressure MISS is diagnosable instead of silent. We log the failure
// CLASS so the box logs reveal WHY CVD/spot gaps happen and which fix is warranted:
//   http:429 / http:418 → Binance IP rate-limit/ban  → a second VPN exit doubles the weight budget
//   http:451             → geoblock                    → PROXIED_HOSTS routing is wrong (config)
//   net:<code>           → timeout / connection reset  → retry + backoff, NOT a VPN problem
//   shape / empty        → upstream returned no data    → not a reachability issue
// Behavior is UNCHANGED — still returns null on any miss; this only adds a console line per failure
// (failure-only, so log volume == the real failure rate we want to measure). No fix yet: measure first.
async function fetchSpotJson(url: string, label: string, symbol: string): Promise<any | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) { console.log(`[spot] ${symbol} ${label} miss: http:${r.status}`); return null; }
    const data = await r.json().catch(() => null);
    if (data == null) { console.log(`[spot] ${symbol} ${label} miss: shape:non-json`); return null; }
    return data;
  } catch (e: any) {
    const cause = String(e?.cause?.code || e?.code || e?.name || e?.message || e).slice(0, 60);
    console.log(`[spot] ${symbol} ${label} miss: net:${cause}`);
    return null;
  }
}

export async function fetchSpotPressureEnrichment(symbol: string): Promise<SpotPressure | null> {
  // klines is row-critical (CVD + taker ratio); depth is optional (computeSpotPressure tolerates null).
  const [klines, depth] = await Promise.all([
    fetchSpotJson(`${BINANCE_DATA}/klines?symbol=${symbol}&interval=1h&limit=24`, 'klines', symbol),
    fetchSpotJson(`${BINANCE_DATA}/depth?symbol=${symbol}&limit=20`, 'depth', symbol),
  ]);
  if (!Array.isArray(klines)) {
    if (klines != null) console.log(`[spot] ${symbol} klines miss: shape:not-array`);  // null already logged
    return null;
  }
  if (klines.length === 0) { console.log(`[spot] ${symbol} klines miss: empty`); return null; }
  return computeSpotPressure(klines, depth);
}

// ── Sentiment (CoinInfo, crypto) — CoinGecko coin market_data → the 4 fields the prompt prints ──
const GECKO_IDS: Record<string, string> = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', xrp: 'ripple', bnb: 'binancecoin', ada: 'cardano', doge: 'dogecoin', avax: 'avalanche-2', dot: 'polkadot', link: 'chainlink' };
export function parseCoinInfo(coinGecko: any): CoinInfo | null {
  const md = coinGecko?.market_data;
  if (!md) return null;
  const ath = num(md.ath_change_percentage?.usd);
  return {
    athChangePercentage: ath ?? 0,
    priceChangePercentage24h: num(md.price_change_percentage_24h),
    priceChangePercentage7d: num(md.price_change_percentage_7d),
    priceChangePercentage30d: num(md.price_change_percentage_30d),
  };
}
export async function fetchSentimentEnrichment(env: Env, symbol: string): Promise<CoinInfo | null> {
  const cacheKey = `cache:sentiment:${symbol}`;
  try {
    const cached = await env.ALERTS.get(cacheKey);
    if (cached) { const p = JSON.parse(cached); if (Date.now() - p.timestamp < 600_000) return parseCoinInfo(p.data); }
  } catch { /* ignore */ }
  try {
    const coinId = symbol.replace('USDT', '').toLowerCase();
    const geckoId = GECKO_IDS[coinId] || coinId;
    const resp = await fetch(`https://api.coingecko.com/api/v3/coins/${geckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`);
    if (!resp.ok) return null;
    const data = await resp.json();
    try { await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 }); } catch { /* ignore */ }
    return parseCoinInfo(data);
  } catch { return null; }
}

// ── Cross-asset (crypto, BTC perspective) — AnalysisService.buildCrossAssetContext port ──
// DXY + SPY daily directional signal vs EMA20; DXY is INVERTED (DXY up = bearish for BTC).
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
export function directionalSignal(closes: number[]): { signal: number; trend: string; price: number; ema20: number } {
  const ema = emaArray(closes, 20);
  const price = closes[closes.length - 1], ema20 = ema[ema.length - 1];
  if (price == null || ema20 == null || !(price > 0)) return { signal: 0, trend: 'unknown', price: 0, ema20: 0 };
  const distPct = (price - ema20) / ema20 * 100;
  const recent = ema.slice(-5);
  if (distPct > 0.5) {
    const rising = recent.length >= 2 && recent[recent.length - 1] > recent[0];
    return rising ? { signal: 1, trend: 'up', price, ema20 } : { signal: 0, trend: 'flat', price, ema20 };
  } else if (distPct < -0.5) {
    const falling = recent.length >= 2 && recent[recent.length - 1] < recent[0];
    return falling ? { signal: -1, trend: 'down', price, ema20 } : { signal: 0, trend: 'flat', price, ema20 };
  }
  return { signal: 0, trend: 'flat', price, ema20 };
}
export function buildCrossAsset(dxyCloses: number[], spyCloses: number[]): CrossAssetContext | null {
  if (dxyCloses.length < 25 || spyCloses.length < 25) return null;
  const dxy = directionalSignal(dxyCloses), spy = directionalSignal(spyCloses);
  const dxySignal = -dxy.signal, spySignal = spy.signal;
  const combined = Math.max(-2, Math.min(2, dxySignal + spySignal));
  const parts: string[] = [];
  if (dxySignal !== 0) parts.push(`DXY ${dxy.trend} (${dxySignal > 0 ? 'tailwind' : 'headwind'})`);
  if (spySignal !== 0) parts.push(`SPY ${spy.trend} (${spySignal > 0 ? 'risk-on' : 'risk-off'})`);
  const summary = parts.length === 0 ? 'Cross-asset: neutral'
    : `Cross-asset: ${parts.join(', ')} → ${combined > 0 ? '+' : ''}${combined} for BTC`;
  return { summary, dxyPrice: dxy.price, dxyEma20: dxy.ema20, dxyTrend: dxy.trend, spyPrice: spy.price, spyEma20: spy.ema20, spyTrend: spy.trend };
}
async function fetchYahooDailyCloses(symbol: string): Promise<number[]> {
  try {
    const r = await fetch(`${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=1d&range=3mo`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    if (!r.ok) return [];
    const j = await r.json() as any;
    const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    return Array.isArray(closes) ? closes.filter((c: any) => typeof c === 'number' && !isNaN(c)) : [];
  } catch { return []; }
}
export async function fetchCrossAssetEnrichment(): Promise<CrossAssetContext | null> {
  const [dxy, spy] = await Promise.all([fetchYahooDailyCloses('DX-Y.NYB'), fetchYahooDailyCloses('SPY')]);
  return buildCrossAsset(dxy, spy);
}

// ── Economic calendar (FairEconomy) — port of EconomicCalendarService ──
// The server prompt was blind to macro events (ISM/CPI/Fed/NFP), so it missed the Macro Risk
// flag + macro_event_within_4h kill that iOS computes. This restores parity for BOTH markets.
export interface EconomicEventOut {
  title: string; country: string; impact: string;
  isHighImpact: boolean; isUpcoming: boolean; isRecentlyReleased: boolean;
  date: number; actual: string | null; forecast: string | null; previous: string | null; surprise: string | null;
}
// ms of ET-midnight-today: subtract the ET wall-clock elapsed-since-midnight from now (tz-safe).
function etStartOfDayMs(nowMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = dtf.formatToParts(new Date(nowMs));
  const get = (t: string) => +p.find(x => x.type === t)!.value;
  let hh = get('hour'); if (hh === 24) hh = 0;
  return nowMs - ((hh * 3600 + get('minute') * 60 + get('second')) * 1000);
}
function surpriseOf(actual: string | null, forecast: string | null): string | null {
  if (!actual || !forecast) return null;
  const a = parseFloat(actual.replace(/%/g, '').replace(/K/g, ''));
  const e = parseFloat(forecast.replace(/%/g, '').replace(/K/g, ''));
  if (isNaN(a) || isNaN(e)) return null;
  if (a > e * 1.01) return 'BEAT';
  if (a < e * 0.99) return 'MISS';
  return 'IN-LINE';
}
export async function fetchEconomicEvents(nowMs: number): Promise<EconomicEventOut[]> {
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    if (!r.ok) return [];
    const arr = await r.json() as any[];
    if (!Array.isArray(arr)) return [];
    const etMidnight = etStartOfDayMs(nowMs);
    const out: EconomicEventOut[] = [];
    for (const it of arr) {
      const title = it?.title, dateStr = it?.date, impact = it?.impact, country = it?.country;
      if (!title || !dateStr || !impact || !country) continue;
      const date = Date.parse(dateStr);
      if (isNaN(date)) continue;
      const delta = date - nowMs;
      const isUpcoming = delta > 0 && delta < 48 * 3600 * 1000;
      const isRecentlyReleased = delta <= 0 && date >= etMidnight;
      if (!(isRecentlyReleased || isUpcoming || delta > 0)) continue;   // released-today or upcoming only
      const forecast = it.forecast ?? null, previous = it.previous ?? null, actual = it.actual ?? null;
      out.push({
        title, country, impact, isHighImpact: impact === 'High', isUpcoming, isRecentlyReleased, date,
        actual: actual || null, forecast: forecast || null, previous: previous || null, surprise: surpriseOf(actual || null, forecast || null),
      });
    }
    out.sort((a, b) => a.date - b.date);
    return out;
  } catch { return []; }
}

// Implied volatility from Deribit's DVOL index (30-day annualized IV, %). Public market data, no
// auth (US-accessible for DATA even though Deribit doesn't serve US *trading*). BTC/ETH only —
// the only liquid crypto options markets. Feeds the VOLATILITY PRICING read: the app's own move
// FORECAST (HAR-RV) vs what options are PRICING → is a coming move cheap (long-gamma favorable) or
// already expensive (rich vol, the move is expected). This is how you monetize a direction-agnostic
// volatility edge with a direction-agnostic instrument.
export async function fetchImpliedVol(currency: 'BTC' | 'ETH'): Promise<number | null> {
  const end = Date.now(), start = end - 6 * 3600 * 1000;
  const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=3600`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const j = await r.json() as any;
    const data = j?.result?.data;
    if (!Array.isArray(data) || !data.length) return null;
    const last = data[data.length - 1];   // [timestamp, open, high, low, close]
    const dvol = Array.isArray(last) ? Number(last[4]) : null;
    return (dvol != null && isFinite(dvol) && dvol > 0) ? dvol : null;
  } catch { return null; }
}

// Crypto Fear & Greed index (alternative.me). Returns {value 0-100, label}.
export async function fetchFearGreed(): Promise<{ value: number; label: string } | null> {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1');
    if (!r.ok) return null;
    const j = await r.json() as any;
    const d = j?.data?.[0];
    if (!d) return null;
    const v = parseInt(d.value, 10);
    return isNaN(v) ? null : { value: v, label: String(d.value_classification ?? '') };
  } catch { return null; }
}

// ── Stock fundamentals + sentiment (Yahoo quoteSummary) — port of YahooFinanceService ──
// Shares the same yahoo-crumb KV cache the /yahoo/summary endpoint uses.
async function getYahooCrumb(env: Env): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const cached = await env.ALERTS.get('cache:yahoo-crumb');
    if (cached) { const p = JSON.parse(cached); if (Date.now() - p.timestamp < 1800_000) return p.data; }
  } catch { /* ignore */ }
  try {
    const fc = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const a3 = (fc.headers.get('set-cookie') || '').match(/A3=([^;]+)/);
    if (!a3) return null;
    const cookie = `A3=${a3[1]}`;
    const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': cookie } });
    if (!cr.ok) return null;
    const crumb = await cr.text();
    if (!crumb || crumb.includes('Unauthorized')) return null;
    const result = { cookie, crumb };
    try { await env.ALERTS.put('cache:yahoo-crumb', JSON.stringify({ data: result, timestamp: Date.now() }), { expirationTtl: 1800 }); } catch { /* ignore */ }
    return result;
  } catch { return null; }
}
const rawNum = (n: any): number | null => { const v = n?.raw ?? n; return typeof v === 'number' && !isNaN(v) ? v : null; };
const vixLabel = (vix: number): string => vix > 30 ? 'High' : vix > 20 ? 'Elevated' : vix < 15 ? 'Low' : 'Normal';

export async function fetchStockEnrichment(env: Env, symbol: string): Promise<{ stockInfo: StockInfo; stockSentiment: StockSentimentData } | null> {
  const modules = 'price,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,assetProfile';
  const cacheKey = `cache:yahoo-summary:${symbol}:${modules}`;
  let qs: any = null;
  try {
    const cached = await env.ALERTS.get(cacheKey);
    if (cached) { const p = JSON.parse(cached); if (Date.now() - p.timestamp < 300_000) qs = p.data; }
  } catch { /* ignore */ }
  if (!qs) {
    const auth = await getYahooCrumb(env);
    const headers: Record<string, string> = { 'User-Agent': UA };
    if (auth) headers['Cookie'] = auth.cookie;
    const crumbParam = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : '';
    try {
      const r = await fetch(`${YAHOO}/v10/finance/quoteSummary/${symbol}?modules=${modules}${crumbParam}`, { headers });
      if (!r.ok) return null;
      qs = await r.json();
      try { await env.ALERTS.put(cacheKey, JSON.stringify({ data: qs, timestamp: Date.now() }), { expirationTtl: 600 }); } catch { /* ignore */ }
    } catch { return null; }
  }
  const res = qs?.quoteSummary?.result?.[0];
  if (!res) return null;
  const price = res.price ?? {}, sd = res.summaryDetail ?? {}, ks = res.defaultKeyStatistics ?? {}, fd = res.financialData ?? {}, ce = res.calendarEvents ?? {}, ap = res.assetProfile ?? {};

  const ms = price.marketState as string | undefined;
  const marketState = ms === 'REGULAR' ? 'OPEN' : (ms || 'CLOSED');
  const low = rawNum(sd.fiftyTwoWeekLow), high = rawNum(sd.fiftyTwoWeekHigh);
  const curPrice = rawNum(price.regularMarketPrice) ?? rawNum(fd.currentPrice);
  const earningsArr = ce?.earnings?.earningsDate;
  const earningsSec = Array.isArray(earningsArr) && earningsArr.length ? rawNum(earningsArr[0]) : null;
  const exDivSec = rawNum(ce.exDividendDate) ?? rawNum(sd.exDividendDate);
  const dy = rawNum(sd.dividendYield);
  const revG = rawNum(fd.revenueGrowth), earnG = rawNum(fd.earningsGrowth);

  // Relative strength + sector + insider + news (2026-07-02): these revive the backtest-validated
  // LONG_CONFIRMATION gate (needs relativeStrength1d) + Sector Strength, News-Thesis Conflict, and
  // Insider Cluster prompt sections — all previously dead because fetchStockEnrichment never
  // populated them. All best-effort and parallel; any failure just leaves that field null.
  const sectorETF = sectorETFForSymbol(symbol);
  const symChangePct = rawNum(price.regularMarketChangePercent);
  // recommendationRaw added 2026-07-25: the analyst buy/hold/sell breakdown was the last field the
  // iOS client still had to fetch itself, and it was doing so with FIVE separate /finnhub/* worker
  // calls per stock (recommendation/metric/earnings/news/insider). Every one of those counted
  // against the 60/min per-device budget — even when the worker served it from its own 1-24h cache,
  // because the rate gate runs BEFORE endpoint routing. Serving the breakdown from here lets stocks
  // use the single /market call crypto already uses: 7 worker requests per stock refresh down to 3.
  const [spyCloses, sectorCloses, insiderRaw, newsRaw, recommendationRaw] = await Promise.all([
    fetchYahooDailyCloses('SPY'),
    sectorETF ? fetchYahooDailyCloses(sectorETF) : Promise.resolve([] as number[]),
    fetchFinnhubJSON(env, `/stock/insider-transactions?symbol=${symbol}`),
    fetchFinnhubJSON(env, `/company-news?symbol=${symbol}&from=${new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`),
    fetchFinnhubJSON(env, `/stock/recommendation?symbol=${symbol}`),
  ]);
  // Finnhub returns newest-first; strongBuy/strongSell fold into buy/sell the way the iOS client
  // did it, with strongBuy kept separately for the "N Strong Buy" line.
  const recTop = Array.isArray(recommendationRaw) && recommendationRaw.length ? recommendationRaw[0] : null;
  const finnhubStrongBuy = recTop ? (rawNum(recTop.strongBuy) ?? 0) : null;
  const finnhubBuy = recTop ? (rawNum(recTop.buy) ?? 0) + (finnhubStrongBuy ?? 0) : null;
  const finnhubHold = recTop ? rawNum(recTop.hold) : null;
  const finnhubSell = recTop ? (rawNum(recTop.sell) ?? 0) + (rawNum(recTop.strongSell) ?? 0) : null;
  const spyPct = pct1d(spyCloses);
  const relativeStrength1d = (symChangePct != null && spyPct != null) ? symChangePct - spyPct : null;
  const sectorPct = pct1d(sectorCloses);
  const outperformingSector = (symChangePct != null && sectorPct != null) ? symChangePct > sectorPct : null;

  // Insider transactions → InsiderTx[] (Finnhub returns change<0 = sell). Last ~6 months.
  let insiderTransactions: Array<{ date: number; isBuy: boolean; name: string; shares: number; value: number }> | null = null;
  let insiderBuyCount6m: number | null = null, insiderSellCount6m: number | null = null;
  if (Array.isArray(insiderRaw?.data)) {
    const cutoff = Date.now() - 182 * 86400_000;
    const txs = insiderRaw.data
      .map((t: any) => {
        const dateMs = t.transactionDate ? Date.parse(t.transactionDate) : NaN;
        const change = rawNum(t.change) ?? 0, priceP = rawNum(t.transactionPrice) ?? 0;
        return { date: dateMs, isBuy: change > 0, name: String(t.name ?? '').slice(0, 40), shares: Math.abs(change), value: Math.abs(change) * priceP };
      })
      .filter((t: any) => Number.isFinite(t.date) && t.date >= cutoff && t.shares > 0);
    if (txs.length) {
      insiderTransactions = txs.slice(0, 40);
      insiderBuyCount6m = txs.filter((t: any) => t.isBuy).length;
      insiderSellCount6m = txs.filter((t: any) => !t.isBuy).length;
    }
  }
  const newsHeadlines: string[] | null = Array.isArray(newsRaw)
    ? newsRaw.slice(0, 8).map((n: any) => String(n?.headline ?? '').slice(0, 140)).filter(Boolean)
    : null;

  const stockInfo: StockInfo = {
    marketState,
    peRatio: rawNum(sd.trailingPE),
    eps: rawNum(ks.trailingEps),
    dividendYield: dy != null ? dy * 100 : null,
    fiftyTwoWeekLow: low ?? 0,
    fiftyTwoWeekHigh: high ?? 0,
    sector: ap.sector ?? null,
    earningsDate: earningsSec != null ? earningsSec * 1000 : null,
    analystTargetMean: rawNum(fd.targetMeanPrice),
    analystCount: rawNum(fd.numberOfAnalystOpinions),
    analystRating: fd.recommendationKey ?? null,
    revenueGrowthYoY: revG != null ? revG * 100 : null,
    earningsGrowthYoY: earnG != null ? earnG * 100 : null,
    beta: rawNum(sd.beta) ?? rawNum(ks.beta),
    exDividendDate: exDivSec != null ? exDivSec * 1000 : null,
    dividendRate: rawNum(sd.dividendRate),
    exDividendWarning: exDivSec != null ? (exDivSec * 1000 - Date.now()) / 86400000 <= 5 && exDivSec * 1000 >= Date.now() : null,
    // 2026-07-02 additions — revive LONG_CONFIRMATION + Sector Strength + Insider + News.
    sectorETF, relativeStrength1d, outperformingSector,
    insiderTransactions, insiderBuyCount6m, insiderSellCount6m,
    insiderNetBuying: (insiderBuyCount6m != null && insiderSellCount6m != null) ? insiderBuyCount6m > insiderSellCount6m : null,
    newsHeadlines,
    // 2026-07-25 — the last two fields that kept iOS on its own /finnhub/* fan-out. marketCap comes
    // free from the Yahoo `price` module already fetched above; no extra call for it.
    finnhubBuy, finnhubHold, finnhubSell, finnhubStrongBuy,
    marketCap: rawNum(price.marketCap),
  };

  // VIX from the macro cache; 52w position + short interest from Yahoo.
  const macro = await fetchMacroEnrichment(env);
  const pos = (curPrice != null && low != null && high != null && high > low) ? (curPrice - low) / (high - low) * 100 : 0;
  const shortPct = rawNum(ks.shortPercentOfFloat);
  const stockSentiment: StockSentimentData = {
    vix: macro?.vix ?? null,
    vixLevel: macro?.vix != null ? vixLabel(macro.vix) : 'Normal',
    vixChange: null,
    shortPercentOfFloat: shortPct != null ? shortPct * 100 : null,
    shortRatio: rawNum(ks.shortRatio),
    fiftyTwoWeekPosition: pos,
    putCallRatio: null,   // needs the options chain — omitted for v1
  };
  return { stockInfo, stockSentiment };
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
