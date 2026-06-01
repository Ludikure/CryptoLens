// Enrichment builders for POST /full-analysis — faithful TS ports of the iOS enrichment so the
// worker can populate buildUserPrompt's optional inputs. Currently: crypto derivatives +
// positioning (DerivativesService + PositioningAnalyzer) and macro (FRED via the /macro cache).
// Stock fundamentals / sentiment / cross-asset / economic events are layered in subsequently.

import type { DerivativesData, PositioningSnapshot, MacroSnapshot, SpotPressure, CoinInfo, CrossAssetContext } from './prompt';
import { emaArray } from './scoring-full';

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
