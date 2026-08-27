// MarketScope Worker — Secure proxy with per-device isolation
// All API keys stay server-side. Device auth via signed tokens.

import { type Candle as ScoreCandle } from './scoring';
import { fitCalibrationCurve, applyCalibration, coverageCut, type CalBucket, type CalPoint } from './calibration';
import { mlPredict, mlPredictH72, mlPredictMeta, mlPredictQuantile, mlConfident, mlPredictDirection, mlPredictTail, tailRiskBucket, tailRiskInfo, buildMLInput } from './ml-predict';
import { computeAllFeatures, sectorETFForSymbol, type Candle as FullCandle, type FullFeatures } from './scoring-full';
import { aggregate1HTo4H_ET } from './aggregation';
import { computeFullIndicators } from './indicators-full';
import { buildUserPrompt, systemPrompt, parseSetups, type PromptIndicator, type PromptState } from './prompt';
import { registerTrackedSetups, resolveTrackedSetups, readActiveSetupsForPrompt, readTrackedSetups, voidInvalidGeometrySetups } from './outcome-tracking';
import { forecastVol, bandMultipliers } from './vol';
import { positionRisk } from './risk-engine';
import { computeRiskStates } from './risk-states';
import { correlationReport } from './correlation';
import { pollNewsFeeds, fetchRecentNews } from './news';
import { fetchBasisRows, findBasisOpportunities, netAnnualized } from './basis';
import { computeOpportunities, PROVISIONAL_CAVEAT, type AssetInput } from './trading/service';
import { excursionModelInfo } from './trading/excursion';
import { crashModelInfo, crashProbability } from './trading/crash';
import { DEFAULT_STRUCTURE } from './trading/generator';
import { payoffBranches } from './trading/opportunity';

/** `forecastVol` needs comp_bars['30d'] = 720 one-hour bars and returns null if any component is
 *  short. Named so the requirement is visible rather than buried in a magic 800. */
const VOL_MIN_1H_BARS = 720;

/**
 * Minimum expected value before a trade is worth showing.
 *
 * `generateCandidate` only requires EV > 0, which let a +0.01R candidate onto the card — about TWO
 * DOLLARS of expected value on a 28k account, presented in the same shape as a real opportunity.
 * Anything under this is noise dressed as a decision.
 */
const MIN_DISPLAY_EV_R = 0.05;

/**
 * Pairwise Pearson correlation of 1h LOG RETURNS across the fetched assets.
 *
 * Returns, not prices: two assets in a shared uptrend have near-1.0 price correlation regardless of
 * whether they actually move together, which would overstate concentration everywhere. Series are
 * truncated to their common length and aligned from the END, so the most recent overlapping window
 * is compared rather than misaligning a shorter history against a longer one.
 */
function pairwiseCorrelations(closes: Record<string, number[]>): Record<string, Record<string, number>> {
  const syms = Object.keys(closes);
  const out: Record<string, Record<string, number>> = {};
  if (syms.length < 2) return out;

  const rets: Record<string, number[]> = {};
  for (const s of syms) {
    const c = closes[s];
    const r: number[] = [];
    for (let i = 1; i < c.length; i++) {
      if (c[i] > 0 && c[i - 1] > 0) r.push(Math.log(c[i] / c[i - 1]));
    }
    rets[s] = r;
  }

  const corr = (a: number[], b: number[]): number => {
    const n = Math.min(a.length, b.length);
    if (n < 30) return 0;                       // too little overlap to mean anything
    const x = a.slice(a.length - n), y = b.slice(b.length - n);
    const mx = x.reduce((p, q) => p + q, 0) / n, my = y.reduce((p, q) => p + q, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    const d = Math.sqrt(sxx * syy);
    return d > 0 ? sxy / d : 0;
  };

  for (const a of syms) {
    out[a] = {};
    for (const b of syms) if (a !== b) out[a][b] = corr(rets[a], rets[b]);
  }
  return out;
}
import { fetchDerivativesEnrichment, fetchMacroEnrichment, fetchSpotPressureEnrichment, fetchSentimentEnrichment, fetchCrossAssetEnrichment, fetchFearGreed, fetchEconomicEvents, fetchStockEnrichment, fetchImpliedVol } from './enrichment';

// Drop the most recent candle if it is still in-progress (closeTime > now).
// Without this, every minute's cron sees a different "current" close (the live tick),
// which mutates indicator values and ML features even though no candle has actually closed.
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};
function dropInProgress<T extends { time: number }>(candles: T[], interval: string): T[] {
  if (!candles.length) return candles;
  const ms = INTERVAL_MS[interval];
  if (!ms) return candles;
  const last = candles[candles.length - 1];
  return last.time + ms > Date.now() ? candles.slice(0, -1) : candles;
}

export interface Env {
  ALERTS: KVNamespace;       // Hot cache for market data
  DB: D1Database;            // Persistent state + candle archive
  MODELS: R2Bucket;          // ML models + archives
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_BUNDLE_ID: string;
  CLAUDE_API_KEY: string;
  GEMINI_API_KEY: string;
  DEEPSEEK_API_KEY: string;
  TWELVE_DATA_API_KEY: string;
  TWELVE_DATA_API_KEY_2?: string;
  FINNHUB_API_KEY: string;
  FRED_API_KEY: string;
  TIINGO_API_KEY: string;
  ALPHAVANTAGE_API_KEY: string;
}


interface DeviceRegistration {
  token: string;
  updatedAt: number;
}

const BINANCE_SPOT = 'https://data-api.binance.vision/api/v3';
const YAHOO_BASE = 'https://query1.finance.yahoo.com';
const TWELVE_DATA_BASE = 'https://api.twelvedata.com';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const TIINGO_IEX = 'https://api.tiingo.com/iex';
const TIINGO_DAILY = 'https://api.tiingo.com/tiingo/daily';
const ALPHAVANTAGE_BASE = 'https://www.alphavantage.co/query';

// Wildcard origin: the API is token-authed via the X-Auth-Token *header* (no cookies), so
// CORS '*' carries no CSRF risk — a cross-origin site still can't act without a valid token.
// Needed so the browser web app (marketscope-web.pages.dev) and the iOS capacitor app can
// both call the Worker. iOS was the only origin before; the hardcoded capacitor value
// blocked the web app entirely.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Device-ID, X-Auth-Token, X-App-ID',
};

// Limits
const RATE_LIMIT_ANALYZE = 30;   // AI calls per device per hour
const MAX_ALERTS = 50;           // Max alerts per device
const MAX_PROMPT_CHARS = 200_000; // ~50K tokens per field; fits within 1M context beta with room for thinking + output
const MAX_BODY_BYTES = 600_000;   // Max request body size (600KB) — covers system + user prompt + JSON wrapper headroom
const MAX_NOTE_LENGTH = 500;     // Max alert note length
const DEVICE_ID_REGEX = /^[a-zA-Z0-9-]{1,128}$/;
const ALLOWED_MODELS = ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];
// Adaptive-thinking family: Sonnet 5 + Opus 4.7/4.8 REJECT manual `thinking:{budget_tokens}` AND
// non-default `temperature`/`top_p`/`top_k` with a 400. They use adaptive thinking + the `effort`
// knob instead. (Sonnet 4.6 / Opus 4.6 / Haiku 4.5 still accept the legacy budget_tokens path.)
const EFFORT_MODELS = new Set(['claude-sonnet-5', 'claude-opus-4-7', 'claude-opus-4-8']);
const DEEPSEEK_MODELS = ['deepseek-reasoner', 'deepseek-chat'];
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];

// Single multi-provider LLM call. Routes to Claude / Gemini / DeepSeek (model allowlisted per
// provider, falling back to that provider's default), normalizes each response to plain text, and
// returns the resolved model. Both /analyze and /full-analysis share this so provider selection
// works identically on the thin client (server-side analysis) and the legacy local-prompt path.
// thinkingBudget applies to Claude only (Anthropic extended thinking); ignored by the others.
type LLMOutcome = { ok: true; text: string; model: string } | { ok: false; status: number; error: string };
async function callLLM(env: Env, opts: { provider?: string; model?: string; system: string; prompt: string; thinkingBudget?: number | null }): Promise<LLMOutcome> {
  const provider = opts.provider || 'claude';
  const httpErr = (code: number): LLMOutcome =>
    code === 429 ? { ok: false, status: 429, error: 'AI service busy. Try again shortly.' }
    : code >= 500 ? { ok: false, status: 502, error: 'AI service temporarily unavailable' }
    : { ok: false, status: code, error: `AI error (${code})` };

  if (provider === 'deepseek') {
    if (!env.DEEPSEEK_API_KEY) return { ok: false, status: 503, error: 'DeepSeek not configured' };
    const model = DEEPSEEK_MODELS.includes(opts.model ?? '') ? opts.model! : 'deepseek-reasoner';
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 8000, temperature: 0, messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.prompt }] }),
    });
    if (!resp.ok) return httpErr(resp.status);
    const r = await resp.json() as any;
    return { ok: true, text: r?.choices?.[0]?.message?.content || '', model };
  }

  if (provider === 'gemini') {
    if (!env.GEMINI_API_KEY) return { ok: false, status: 503, error: 'Gemini not configured' };
    const model = GEMINI_MODELS.includes(opts.model ?? '') ? opts.model! : 'gemini-2.5-flash';
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // maxOutputTokens covers Gemini 2.5's built-in thinking + the answer, so it needs headroom
      // (the legacy /analyze used 2500, which can truncate the full analysis).
      body: JSON.stringify({ system_instruction: { parts: [{ text: opts.system }] }, contents: [{ parts: [{ text: opts.prompt }] }], generationConfig: { maxOutputTokens: 8000, temperature: 0 } }),
    });
    if (!resp.ok) return httpErr(resp.status);
    const r = await resp.json() as any;
    return { ok: true, text: r?.candidates?.[0]?.content?.parts?.[0]?.text || '', model };
  }

  // Claude (default)
  if (!env.CLAUDE_API_KEY) return { ok: false, status: 503, error: 'AI not configured' };
  const model = ALLOWED_MODELS.includes(opts.model ?? '') ? opts.model! : 'claude-sonnet-4-6';
  // `thinkingBudget` from the client is now just an ON/OFF signal for thinking (>=1024 = on). On the
  // legacy models the number is still used as the literal budget; on the effort family it only
  // decides adaptive-on vs disabled (depth is set by `effort`).
  const wantThinking = !!(opts.thinkingBudget && opts.thinkingBudget >= 1024);
  const reqBody: Record<string, unknown> = {
    model,
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
  };
  if (EFFORT_MODELS.has(model)) {
    // Sonnet 5 / Opus 4.7-4.8: adaptive thinking + effort. No temperature (400 if non-default),
    // no budget_tokens (400). `high` effort ≈ the old "extended thinking" depth (deep on hard
    // bars, skipped on trivial ones). max_tokens is a HARD cap on thinking+text. 16k (not 32k):
    // the analysis is ≤300 words + a few k thinking tokens; a non-streaming generation much
    // beyond that risks undici's ~300s headers timeout (the response only starts once
    // generation COMPLETES), which would fail exactly the deepest runs.
    reqBody.thinking = { type: wantThinking ? 'adaptive' : 'disabled' };
    reqBody.output_config = { effort: wantThinking ? 'high' : 'medium' };
    reqBody.max_tokens = wantThinking ? 16000 : 8000;
  } else {
    // Legacy family (Sonnet 4.6 / Opus 4.6 / Haiku 4.5): manual budget_tokens still accepted.
    const thinkingBudget = wantThinking ? opts.thinkingBudget! : null;
    reqBody.max_tokens = thinkingBudget ? thinkingBudget + 4000 : 4000;
    reqBody.temperature = thinkingBudget ? 1 : 0;
    if (thinkingBudget) reqBody.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'context-1m-2025-08-07', 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  if (!resp.ok) {
    // Log the error BODY — without it a 400 from a param mistake on a new model family is
    // indistinguishable from any other failure (this hid the Opus 4.7 budget_tokens 400s).
    try { console.error(`[llm] ${model} ${resp.status}: ${(await resp.text()).slice(0, 500)}`); } catch { /* ignore */ }
    return httpErr(resp.status);
  }
  const r = await resp.json() as any;
  const text = (Array.isArray(r?.content) ? r.content.find((c: any) => c.type === 'text')?.text : '') || '';
  return { ok: true, text, model };
}

// The full-analysis pipeline end-to-end: candles → indicators → ML overlay → enrichment → STATEFUL
// prompt (buildUserPrompt, KV-backed regime/kill/POC state) → LLM → parsed setups → result object.
// Extracted so BOTH the synchronous /full-analysis (web app) and the detached /full-analysis/async
// (iOS fire-and-forget) share one code path. Returns a typed ok/error union for expected conditions;
// throws on unexpected failures (callers wrap). Does NOT rate-limit or serialize — callers do.
type CoreResult = { ok: true; result: any } | { ok: false; status: number; error: string };
// Observed forced-liquidation flow for a symbol (from the box collector's `liquidations`
// table — see server/liquidations.ts). Null when the table is missing/empty so the prompt
// line simply doesn't render. Sampled feed: sums are lower bounds.
export async function fetchLiquidationSummary(env: Env, symbol: string):
  Promise<{ h1LongUsd: number; h1ShortUsd: number; h24LongUsd: number; h24ShortUsd: number } | null> {
  try {
    const now = Date.now();
    const res = await env.DB.prepare(
      `SELECT side,
              SUM(CASE WHEN ts >= ? THEN notional ELSE 0 END) AS h1,
              SUM(notional) AS h24
       FROM liquidations WHERE symbol = ? AND ts >= ? GROUP BY side`
    ).bind(now - 3_600_000, symbol, now - 86_400_000).all();
    const rows = (res.results || []) as any[];
    if (!rows.length) return null;
    const out = { h1LongUsd: 0, h1ShortUsd: 0, h24LongUsd: 0, h24ShortUsd: 0 };
    for (const r of rows) {
      if (r.side === 'long') { out.h1LongUsd = r.h1 ?? 0; out.h24LongUsd = r.h24 ?? 0; }
      else if (r.side === 'short') { out.h1ShortUsd = r.h1 ?? 0; out.h24ShortUsd = r.h24 ?? 0; }
    }
    return out;
  } catch { return null; }   // table not created yet (collector never ran) — fine
}

// Live ML calibration (2026-08-21 refit — replaces the 2026-07-02 35/65 bucket blend).
// The static isotonic calibration in the model JSONs drifts; the live forward-graded curve
// (ml_calibration D1) is the truth. The interim blend corrected per coarse bucket but kept
// 35% of the stale raw scale, which held a raw 39% at ~52% while the live realized rate was
// ~60% — one of the two causes of the missed Aug-2026 62k→80k BTC run. Now: fine (5pp)
// prediction buckets per market → weighted PAV monotone fit → piecewise-linear apply
// (calibration.ts). Self-updating from D1 on every use, so regime shifts are absorbed
// without touching the model. Shared by runFullAnalysisCore, the notification envelope
// precheck, and the symbol pass's notify threshold — one mapping gates every decision.
const CAL_WINDOW_DAYS = 90;

/**
 * Selectivity of the envelope's hard ML floor, as a FRACTION OF LIVE BARS REJECTED.
 *
 * This is the gate's original design intent, recovered — NOT a fitted value, and it must never be
 * re-optimised. `envelope.ts`'s `< 50` floor was designed against v14's training distribution, where
 * it rejected ~45%; by 2026-08-21 it rejected 8.0%, because the PAV curve kept moving under a cutoff
 * expressed as a fixed level. C6 measured that walk-forward fitting of this threshold DESTROYS it —
 * on SHORT the out-of-sample result swung across a 0.34R range on a signal whose whole size is
 * 0.05R, and on LONG the optimizer picked the loosest threshold available every single time.
 *
 * Setting this to null restores the level-based gate exactly. See docs/research/ml-floor-coverage.md.
 */
const COVERAGE_FLOOR: number | null = 0.45;

/** Per-market cut, memoized for one cron pass — inverting the distribution twice per bar is waste. */
let coverageCutCache: { crypto: number | null; stock: number | null; at: number } | null = null;

async function mlCoverageCutFor(env: Env, isCrypto: boolean): Promise<number | null> {
  if (COVERAGE_FLOOR == null) return null;
  const fresh = coverageCutCache && Date.now() - coverageCutCache.at < 300_000;
  if (!fresh) {
    // Per market: crypto and stock prediction distributions differ, and gating one on the other's
    // percentile is the defect that got the Part 11 version reverted.
    const [c, st] = await Promise.all([
      fetchLiveCalBuckets(env, true).then(b => coverageCut(b, COVERAGE_FLOOR!)).catch(() => null),
      fetchLiveCalBuckets(env, false).then(b => coverageCut(b, COVERAGE_FLOOR!)).catch(() => null),
    ]);
    coverageCutCache = { crypto: c, stock: st, at: Date.now() };
  }
  return isCrypto ? coverageCutCache!.crypto : coverageCutCache!.stock;
}

async function fetchLiveCalBuckets(env: Env, isCrypto: boolean): Promise<CalBucket[]> {
  try {
    const res = await env.DB.prepare(
      `SELECT CAST(predicted_prob * 20 AS INTEGER) AS b, COUNT(*) AS n,
              AVG(predicted_prob) AS pm, AVG(good_r) AS realized
         FROM ml_calibration
        WHERE resolved = 1 AND is_crypto = ? AND logged_at > ?
        GROUP BY b ORDER BY b`
    ).bind(isCrypto ? 1 : 0, Date.now() - CAL_WINDOW_DAYS * 86400_000).all();
    return ((res.results || []) as any[])
      .filter(r => r.pm != null && r.realized != null)
      .map(r => ({ predMean: r.pm as number, realized: r.realized as number, n: r.n as number }));
  } catch { return []; }   // calibration best-effort — callers fall back to raw
}

async function fetchMlCalibration(env: Env, curWin: number | null, isCrypto: boolean):
  Promise<{ mlCalibration: { n: number; realizedPct: number; windowDays: number; bucketLabel: string } | null; calibratedMlWin: number | null }> {
  if (curWin == null) return { mlCalibration: null, calibratedMlWin: null };
  const buckets = await fetchLiveCalBuckets(env, isCrypto);
  // Display metadata for the prompt's "ML Calibration (live, audited)" line: the raw realized
  // rate of the coarse bucket containing this prediction (pre-PAV — the audit, not the fit).
  let mlCalibration: { n: number; realizedPct: number; windowDays: number; bucketLabel: string } | null = null;
  const bounds: Array<[number, number, string]> = [[0, 0.3, '<30%'], [0.3, 0.5, '30-50%'], [0.5, 0.6, '50-60%'], [0.6, 0.7, '60-70%'], [0.7, 1.01, '70%+']];
  const [lo, hi, label] = bounds.find(([l, h]) => curWin >= l && curWin < h) ?? bounds[bounds.length - 1];
  const inBucket = buckets.filter(b => b.predMean >= lo && b.predMean < hi);
  const n = inBucket.reduce((s, b) => s + b.n, 0);
  if (n > 0) {
    const realized = inBucket.reduce((s, b) => s + b.realized * b.n, 0) / n;
    mlCalibration = { n, realizedPct: realized * 100, windowDays: CAL_WINDOW_DAYS, bucketLabel: label };
  }
  const curve = fitCalibrationCurve(buckets);
  const calibratedMlWin = curve ? applyCalibration(curve, curWin) : null;
  // Top of the fitted curve — applyCalibration clamps here, so this is the highest calibrated
  // value ANY bar can reach. The prompt floors the mandate windows' 70 gate at it (see
  // the notify gate itself unreachable — surfaced by the cron guard log rather than used by the
  // prompt (the mandate tier reads the RAW scale, so it cannot be killed by curve compression).
  const calibrationCeiling = curve ? curve[curve.length - 1].y : null;
  return { mlCalibration, calibratedMlWin, calibrationCeiling };
}

// ── Notification envelope precheck (2026-07-11) ────────────────────────────────────────────
// "Don't page me into an auto-FLAT analysis": an ML rising-edge alone isn't a reason to
// notify if the Conviction Envelope would immediately auto-FLAT the setup (chase into an
// extended trend, kills active, macro IMMINENT, mixed biases below the calibrated gate...).
// Zero-drift by construction: instead of re-implementing the envelope, build the REAL prompt
// (the cron already has all three candle sets) and parse its `auto_FLAT_active:` line.
//
// The precheck runs WITHOUT enrichment (no derivatives/stock inputs), so enrichment-dependent
// auto-FLAT contributors (e.g. the funding kill) cannot fire here — it can only UNDER-suppress
// (an occasional still-flat notification), never over-suppress. Errors fail OPEN (notify).

/** Extract the envelope's auto-FLAT reasons from a built prompt. Empty = would not auto-FLAT. */
export function parseAutoFlatReasons(prompt: string): string[] {
  const m = prompt.match(/^\s*auto_FLAT_active:\s*(.+)$/m);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

/** Defer-not-drop suppression transition (the 2026-05-30 notify-window lesson: silently
 *  DROPPING off-window crosses lost most signals — so a suppressed cross stays pending and
 *  fires when the envelope clears while ML is still elevated).
 *  flat=null means the precheck itself failed → fail open. */
export function nextSuppressionState(args: { crossed: boolean; wasSuppressed: boolean; flat: boolean | null }):
  { effectiveCross: boolean; suppressed: boolean } {
  if (args.flat === true) return { effectiveCross: false, suppressed: true };
  return { effectiveCross: args.crossed || args.wasSuppressed, suppressed: false };
}

/** Build the real prompt from the cron's candles and return its auto-FLAT reasons
 *  (null = precheck failed, fail open). READ-ONLY: buildUserPrompt's newState is discarded —
 *  the SINCE-LAST-ANALYSIS baseline and kill-duration state only advance on real analyses. */
/**
 * The most recent verdict `envelopePrecheck` computed, for the forward logger.
 *
 * Module-scope rather than a return value because the precheck is memoized and called from three
 * push paths that all want only the boolean; widening its contract for one consumer would make every
 * caller carry a shape it does not use.
 */
let lastEnvelopeVerdict: {
  symbol: string; maxAllowed: string; mlPct: number | null; rawMlPct: number | null;
  alignedDirection: string | null; autoFlat: string; highBlocks: string; moderateBlocks: string;
} | null = null;

async function envelopePrecheck(env: Env, symbol: string, isCrypto: boolean, mlProb: number,
  daily: ScoreCandle[], fourH: FullCandle[], oneH: FullCandle[],
  economicEvents: any[], cal?: { calibratedMlWin: number | null }): Promise<string[] | null> {
  try {
    const indicators: PromptIndicator[] = [computeFullIndicators(daily as unknown as FullCandle[], { timeframe: '1d', label: 'Daily', isCrypto }) as unknown as PromptIndicator];
    if (fourH.length) indicators.push(computeFullIndicators(fourH, { timeframe: '4h', label: '4H', isCrypto }) as unknown as PromptIndicator);
    if (fourH.length && oneH.length) indicators.push(computeFullIndicators(oneH, { timeframe: '1h', label: '1H', isCrypto }) as unknown as PromptIndicator);
    (indicators[0] as any).mlWinProbability = mlProb;
    // The symbol pass already fitted the curve once for this cron — reuse it rather than
    // re-running the 90-day ml_calibration GROUP BY per symbol per minute (that aggregate is a
    // SYNCHRONOUS better-sqlite3 call on the box, so it blocks the event loop serving
    // /full-analysis). Falls back to its own fetch when called without one.
    const { calibratedMlWin } = cal ?? await fetchMlCalibration(env, mlProb, isCrypto);
    let prevState: PromptState = {};
    try { const s = await env.ALERTS.get(`prompt:${symbol}`); if (s) prevState = JSON.parse(s) as PromptState; } catch { /* fresh */ }
    const built = buildUserPrompt({ symbol, nowMs: Date.now(), indicators, prevState, economicEvents, calibratedMlWin,
      mlCoverageCut: await mlCoverageCutFor(env, isCrypto) });
    // The full verdict is stashed for the forward logger, which needs `max_allowed` and the block
    // lists — three of the four are rendered only on non-FLAT bars, so parsing the prose would be
    // blind on exactly the bars a gate study is about. The return contract is unchanged.
    lastEnvelopeVerdict = built.envelope
      ? { symbol, maxAllowed: built.envelope.maxAllowed, mlPct: built.envelope.mlPct,
          rawMlPct: built.envelope.rawMlPct,
          alignedDirection: built.envelopeInput?.alignedDirection ?? null,
          autoFlat: built.envelope.autoFlat.join('|'),
          highBlocks: built.envelope.highBlocks.join('|'),
          moderateBlocks: built.envelope.moderateBlocks.join('|') }
      : null;
    return parseAutoFlatReasons(built.prompt);
  } catch (e) {
    console.log(`[notify] envelope precheck failed ${symbol}: ${e}`);
    return null;
  }
}

async function runFullAnalysisCore(env: Env, symbol: string, isCrypto: boolean, body: any, deviceId: string): Promise<CoreResult> {
  const { daily, fourH, oneH } = await fetchAllTimeframesCached(env, symbol, isCrypto);
  if (!daily.length) return { ok: false, status: 404, error: 'No candles' };
  const indicators: PromptIndicator[] = [computeFullIndicators(daily as FullCandle[], { timeframe: '1d', label: 'Daily', isCrypto }) as unknown as PromptIndicator];
  if (fourH.length) indicators.push(computeFullIndicators(fourH as FullCandle[], { timeframe: '4h', label: '4H', isCrypto }) as unknown as PromptIndicator);
  // The indicators array is POSITIONAL ([daily, 4H, 1H]) — if the 4H fetch failed but 1H
  // succeeded, appending 1H would land at index 1 and be consumed as 4H everywhere
  // (riskStates.bbSqueeze4h, bias.fourH, the prompt's fourH local). Skip 1H in that rare case.
  if (fourH.length && oneH.length) indicators.push(computeFullIndicators(oneH as FullCandle[], { timeframe: '1h', label: '1H', isCrypto }) as unknown as PromptIndicator);

  // Live price for the prompt: every candle/indicator above is CLOSED-bar (training parity),
  // so without this the LLM believes price = the last closed 4H bar (up to 4h stale) and writes
  // triggers that are already past ("if price holds over 62,900" while live is 63,700).
  let livePrice: number | null = null;
  try { livePrice = await fetchLivePrice(symbol, isCrypto); } catch { /* best-effort */ }

  // Phase 1: HAR-RV expected-range forecast (crypto-only; needs 721+ 1H closes for rv_30d). Best-effort.
  let volForecast = null;
  if (isCrypto) {
    try {
      const closes1h = await fetchFapiCloses(symbol, 750);
      volForecast = forecastVol(closes1h, true, closes1h[closes1h.length - 1] ?? indicators[0].price);
    } catch { /* vol forecast best-effort */ }
  }

  // ML overlay onto the daily indicator (cron-cached ml_preds:all; best-effort). The same blob
  // also supplies the BTC regime context for alt analyses (zero extra reads).
  let btcContext: { mlWin: number | null; bigMoveBucket: string | null; persistence: number | null } | null = null;
  try {
    const cached = await env.ALERTS.get('ml_preds:all');
    if (cached) {
      const all = JSON.parse(cached) as Record<string, any>;
      const e = all[symbol];
      if (e) {
        const d = indicators[0];
        d.mlWinProbability = e.probability ?? null;
        d.mlPersistenceProbability = e.probabilityH72 ?? null;
        d.mlBigMoveProb = e.bigMoveProb ?? null;
        d.mlDirectionUp = e.pUp ?? null;
        d.mlConfident = e.confident ?? null;
        d.mlMetaDirection = e.metaDirection ?? null;
        d.mlMetaProbability = e.probabilityMeta ?? null;
        d.mlQ75 = e.q75 ?? null;
        // Crash/drawdown risk from the validated model. Crypto-only (that is what was trained and
        // replicated leave-one-symbol-out). Best-effort: a failure leaves the line off the prompt
        // rather than blocking the analysis.
        if (isCrypto && e.features) {
          try { d.mlCrashProb = crashProbability(e.features as Record<string, number>); }
          catch { d.mlCrashProb = null; }
        }
      }
      if (isCrypto && symbol !== 'BTCUSDT') {
        const btc = all['BTCUSDT'];
        if (btc) btcContext = { mlWin: btc.probability ?? null, bigMoveBucket: tailRiskBucket(btc.bigMoveProb ?? null), persistence: btc.probabilityH72 ?? null };
      }
    }
  } catch { /* ML overlay best-effort — prompt degrades gracefully without it */ }

  // Insight enrichments (2026-07-02), both best-effort:
  // (a) live calibration — the realized goodR rate for the CURRENT prediction's bucket over the
  //     last 90d (ml_calibration D1, universe-wide) so the prompt cites an audited number;
  // (b) ML_WIN trajectory — the last-24h path from this device's score_history (cron writes a row
  //     per minute for watchlisted symbols), downsampled to ~6 points.
  const curWin = indicators[0].mlWinProbability;
  const { mlCalibration, calibratedMlWin } = await fetchMlCalibration(env, curWin ?? null, isCrypto);
  let mlTrajectory: { points: number[]; hours: number } | null = null;
  try {
    const res = await env.DB.prepare(
      `SELECT ml_probability FROM score_history
       WHERE device_id = ? AND symbol = ? AND ml_probability IS NOT NULL AND timestamp >= datetime('now', '-24 hours')
       ORDER BY timestamp ASC`
    ).bind(deviceId, symbol).all();
    const rows = (res.results as any[]).map(r => r.ml_probability as number);
    if (rows.length >= 3) {
      const N = 6;
      const points = rows.length <= N ? rows : Array.from({ length: N }, (_, i) => rows[Math.round(i * (rows.length - 1) / (N - 1))]);
      mlTrajectory = { points, hours: 24 };
    }
  } catch { /* trajectory best-effort */ }

  // Volatility pricing (BTC/ETH only — the liquid crypto options markets). Compare the model's own
  // 24h move forecast (HAR-RV σ) against options-implied move (Deribit DVOL) to flag cheap/rich vol.
  let volPricing: { dvol: number; impliedMovePct: number; forecastMovePct: number } | null = null;
  const ivCurrency = symbol === 'BTCUSDT' ? 'BTC' : symbol === 'ETHUSDT' ? 'ETH' : null;
  const forecastSigma = volForecast?.horizons?.['24h']?.sigma;
  if (ivCurrency && forecastSigma && forecastSigma > 0) {
    try {
      const dvol = await fetchImpliedVol(ivCurrency);
      if (dvol) {
        const impliedMovePct = dvol * Math.sqrt(1 / 365);   // annualized IV → 1-day 1σ move %
        volPricing = { dvol, impliedMovePct, forecastMovePct: forecastSigma * 100 };
      }
    } catch { /* IV best-effort */ }
  }

  // Outcome feedback loop — last resolved trades for this device+symbol. The model_version filter
  // matches EVERY version ever stamped (crypto: 10 legacy → 14 current; stock: 12/13/14) —
  // pre-2026-07-01 this filtered on 11/13, which matched NOTHING iOS wrote, so outcomeHistory was
  // always [] and the LLM never saw the trade record. Since the 2026-07-09 cutover new outcomes
  // are written by the cron resolver with outcome-tracking.ts's TRACKED_MODEL_VERSION — that
  // constant is the registry of record; keep it, this IN-list, and the model JSON `version`
  // fields in sync on retrains.
  let outcomeHistory: Array<{ direction: string; entry: number; outcome: string; mlProb?: number | null; conviction?: string | null }> = [];
  try {
    const versions = isCrypto ? [10, 11, 12, 14] : [12, 13, 14];
    const res = await env.DB.prepare(
      `SELECT direction, entry_price, outcome, ml_probability, conviction FROM trade_outcomes
       WHERE device_id = ? AND symbol = ? AND model_version IN (${versions.map(() => '?').join(',')}) AND outcome IS NOT NULL
       ORDER BY opened_at DESC LIMIT 10`
    ).bind(deviceId, symbol, ...versions).all();
    outcomeHistory = (res.results as any[]).map(r => ({ direction: r.direction, entry: r.entry_price, outcome: r.outcome, mlProb: r.ml_probability, conviction: r.conviction }));
  } catch { /* best-effort */ }

  // Enrichment (additive, best-effort, parallel).
  const nowMs = Date.now();
  const [deriv, macro, spotPressure, sentiment, crossAsset, economicEvents, stock, news] = await Promise.all([
    isCrypto ? fetchDerivativesEnrichment(env, symbol).catch(() => null) : Promise.resolve(null),
    fetchMacroEnrichment(env).catch(() => null),
    isCrypto ? fetchSpotPressureEnrichment(symbol).catch(() => null) : Promise.resolve(null),
    isCrypto ? fetchSentimentEnrichment(env, symbol).catch(() => null) : Promise.resolve(null),
    isCrypto ? fetchCrossAssetEnrichment().catch(() => null) : Promise.resolve(null),
    fetchEconomicEvents(nowMs).catch(() => []),
    !isCrypto ? fetchStockEnrichment(env, symbol).catch(() => null) : Promise.resolve(null),
    // Policy/macro catalyst headlines (2026-08-22) — a D1 read of what the cron already polled,
    // so it costs no upstream request. Crypto sees macro + crypto scope; stocks see macro only.
    // `noNews: true` suppresses the block — used ONLY by the A/B inertness test, which asks
    // whether the headlines change the model's output at all. An input the output never reacts to
    // is decoration, and that failure has already bitten twice (the mandate's JSON contract, the
    // news block's missing output instruction).
    body.noNews === true ? Promise.resolve(null) : fetchRecentNews(env, { isCrypto, nowMs, symbol }).catch(() => null),
  ]);

  // Observed liquidation flow (crypto) — best-effort, from the box collector's archive.
  const liquidations = isCrypto ? await fetchLiquidationSummary(env, symbol) : null;

  // Stateful prompt build — KV-backed prevState (regime staleness, kill durations, naked POC).
  const stateKey = `prompt:${symbol}`;
  let prevState: PromptState = {};
  try { const s = await env.ALERTS.get(stateKey); if (s) prevState = JSON.parse(s) as PromptState; } catch { /* fresh state */ }
  const settings = {
    accountSize: Number.isFinite(body.accountSize) && body.accountSize > 0 ? body.accountSize : undefined,
    riskPercent: Number.isFinite(body.riskPercent) && body.riskPercent > 0 ? Math.min(body.riskPercent, 100) : undefined,
    conformalGateEnabled: body.conformalGateEnabled === true,
  };
  // Active Trade State comes from the server's own tracked_setups (resolved by the cron) —
  // the request-body path is a transition fallback for app builds that still send it, removed
  // once iOS is fully cut over.
  let activeSetups: any[] = [];
  try { activeSetups = await readActiveSetupsForPrompt(env, deviceId, symbol); } catch { /* best-effort */ }
  if (!activeSetups.length && Array.isArray(body.activeSetups)) activeSetups = body.activeSetups;
  const riskStates = computeRiskStates({
    isCrypto,
    atrPercentile: indicators[0].atrPercentile,
    bbSqueezeDaily: indicators[0].bollingerBands?.squeeze, bbSqueeze4h: indicators[1]?.bollingerBands?.squeeze,
    bbPercentBDaily: indicators[0].bollingerBands?.percentB ?? null,
    longPct: deriv?.derivatives?.globalLongPercent ?? null,
    fundingZ: deriv?.derivatives ? deriv.derivatives.fundingRatePercent / 0.025 : null,
    oiChangePct: deriv?.derivatives?.oiChange4h ?? null,
    cvdFalling: spotPressure?.cvdTrend === 'Falling',
  });
  const { prompt, newState } = buildUserPrompt({
    symbol, nowMs, indicators, livePrice, outcomeHistory, prevState, settings, economicEvents, activeSetups, volForecast, riskStates,
    mlCalibration, calibratedMlWin, mlTrajectory, btcContext, volPricing, liquidations, news,
    // Same cut the notify precheck uses, from the same function — the zero-drift-by-construction
    // property only holds if both paths read one implementation.
    mlCoverageCut: await mlCoverageCutFor(env, isCrypto),
    derivatives: deriv?.derivatives ?? null, positioning: deriv?.positioning ?? null, macro, spotPressure, sentiment, crossAsset,
    stockInfo: stock?.stockInfo ?? null, stockSentiment: stock?.stockSentiment ?? null,
  });
  // Persist the regime/kill/POC state now, but CARRY OVER the prior #6 baseline
  // (prevMlWin/prevBottomLine/prevAnalysisMs): only a successful LLM run below may advance it.
  // Pre-2026-07-01 this put persisted the fresh baseline unconditionally, so a 413 / provider
  // error / promptOnly dry-run re-baselined SINCE LAST ANALYSIS and the next real run
  // under-reported what changed.
  const stateCarry = { ...newState, prevMlWin: prevState.prevMlWin ?? null, prevBottomLine: prevState.prevBottomLine ?? null, prevAnalysisMs: prevState.prevAnalysisMs ?? null };
  try { await env.ALERTS.put(stateKey, JSON.stringify(stateCarry), { expirationTtl: 86400 * 7 }); } catch { /* state persist best-effort */ }

  // Dry-run: return the built prompt (no LLM call) for parity inspection.
  if (body.promptOnly === true) {
    const sections = (prompt.match(/^=== .* ===$/gm) || []).map(s => s.replace(/=/g, '').trim());
    return { ok: true, result: { symbol, isCrypto, length: prompt.length, sectionCount: sections.length, sections, prompt } };
  }

  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, status: 413, error: 'Prompt too large' };
  const system = systemPrompt(isCrypto);
  const provider = typeof body.provider === 'string' ? body.provider : 'claude';
  const thinkingBudget = body.thinkingBudget === 0 ? 0
    : (Number.isFinite(body.thinkingBudget) && body.thinkingBudget >= 1024 ? body.thinkingBudget : 8000);
  const llm = await callLLM(env, { provider, model: body.model, system, prompt, thinkingBudget });
  if (!llm.ok) return { ok: false, status: llm.status, error: llm.error };
  const setups = parseSetups(llm.text);

  // Mandate observability (2026-08-21). The prompt tells the model a setup is MANDATORY inside a
  // conviction window; nothing downstream could tell whether that was honoured, so a recurrence of
  // the "stay put through a rally" failure would again need a hand-written replay script to
  // diagnose. This is the one place holding both the envelope input and the parsed outcome, so it
  // is where the two are compared. Distinguishes the two indistinguishable-downstream causes as far
  // as it can: a prose Entry table with an empty JSON array means the model obeyed the directive
  // but the machine-readable contract dropped it.
  if (prompt.includes('HIGH_CONVICTION_WINDOW:') || prompt.includes('MIXED_HIGH_ML_WINDOW:')) {
    if (setups.length === 0) {
      const prosaicTable = /\bstop\s*loss\b|\bTP1\b|\bentry\b/i.test(llm.text) && /\|/.test(llm.text);
      console.log(`[mandate-violation] ${symbol} conviction window active but 0 setups parsed — ${prosaicTable ? 'prose table present, JSON block empty (contract drop)' : 'model declined outright'}`);
    } else {
      console.log(`[mandate-ok] ${symbol} conviction window active, ${setups.length} setup(s) parsed`);
    }
  }

  // Server-side outcome tracking (2026-07-09 thin-client cutover): register this analysis's
  // setups (or its FLAT decision) in tracked_setups — the cron resolves them from here on,
  // no phone involvement. Best-effort: registration failure must never fail the analysis.
  try {
    await registerTrackedSetups(env, { deviceId, symbol, isCrypto, setups, analysisText: llm.text, livePrice, indicators });
  } catch (e) {
    console.log(`[tracked] register failed ${symbol}: ${e}`);
  }

  // ── Notify on SETUP CREATION, from the one place every analysis passes through (2026-08-06) ──
  //
  // User requirement, verbatim: "I want notification sent whenever the app creates a setup."
  //
  // Until now the only push came from `runAutoAnalysis`, i.e. the far end of a ten-link chain:
  // push token → symbol in the synced watchlist → ML ≥ 70 → decisive direction primitive →
  // envelope not flat → notif_claims won → autorun guard free → analysis succeeds → setup produced
  // → APNs delivers. Any one link breaking meant silence, and several of them (ML ≥ 70 in
  // particular, ~6.3% of bars) are unrelated to whether a setup actually exists. A setup produced
  // by a manual analysis never notified at all, because that path isn't the cron's.
  //
  // This is the choke point instead: `runFullAnalysisCore` is what `/full-analysis`,
  // `/full-analysis/async` AND `runAutoAnalysis` all call, and `parseSetups` above has already
  // applied the geometry gate. So "a setup exists" is now the whole trigger — the condition the
  // user actually cares about — and everything upstream only affects HOW OFTEN we look.
  //
  // Deduped on the setup's own identity (symbol + direction + rounded entry/stop) rather than on
  // time, so re-running an analysis that yields the same setup stays silent while a genuinely
  // different setup always pages. 6h TTL comfortably outlives the 12h pending window's useful life
  // without letting a same-day repeat through twice.
  if (setups.length > 0) {
    void notifySetupCreated(env, deviceId, symbol, setups, llm.text);
  }

  // #6 — the LLM run succeeded: NOW advance the SINCE LAST ANALYSIS baseline (fresh ML + timestamp
  // from newState) and persist the fresh Bottom Line. Unconditional on llm.ok — even if the Bottom
  // Line regex misses, the ML/timestamp baseline must still advance.
  try {
    const m = llm.text.match(/##\s*Bottom Line\s*\n([\s\S]*?)(?:\n##\s|\n---|\n```|$)/i);
    const bl = m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 320) : null;
    await env.ALERTS.put(stateKey, JSON.stringify({ ...newState, prevBottomLine: bl ?? prevState.prevBottomLine ?? null }), { expirationTtl: 86400 * 7 });
  } catch { /* best-effort */ }

  return { ok: true, result: {
    symbol, isCrypto, timestamp: Date.now(), model: llm.model, analysis: llm.text, setups,
    ml: { win: indicators[0].mlWinProbability ?? null, persistence: indicators[0].mlPersistenceProbability ?? null, directionUp: indicators[0].mlDirectionUp ?? null, bigMove: tailRiskInfo(indicators[0].mlBigMoveProb) },
    vol: volForecast,
    riskStates,
    bias: { daily: indicators[0].bias, fourH: indicators[1]?.bias ?? null, oneH: indicators[2]?.bias ?? null },
  } };
}

// Yahoo crumb/cookie auth. At module scope so BOTH the fetch handler and the
// archiveShortInterest cron can call it — it was previously nested inside fetch(), which made
// the cron's call a ReferenceError (short-interest archiving never worked; logged every tick).
async function getYahooCrumb(env: Env): Promise<{cookie: string; crumb: string} | null> {
  const cacheKey = 'cache:yahoo-crumb';
  const cached = await env.ALERTS.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (Date.now() - parsed.timestamp < 1800_000) return parsed.data;
  }
  try {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
    const fcResp = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': ua }, redirect: 'manual' });
    const setCookie = fcResp.headers.get('set-cookie') || '';
    const a3Match = setCookie.match(/A3=([^;]+)/);
    if (!a3Match) return null;
    const cookie = `A3=${a3Match[1]}`;
    const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': ua, 'Cookie': cookie },
    });
    if (!crumbResp.ok) return null;
    const crumb = await crumbResp.text();
    if (!crumb || crumb.includes('Unauthorized')) return null;
    const result = { cookie, crumb };
    await env.ALERTS.put(cacheKey, JSON.stringify({ data: result, timestamp: Date.now() }), { expirationTtl: 1800 });
    return result;
  } catch { return null; }
}

// Bounded-concurrency map — runs `fn` over items with at most `limit` in flight. One Node thread
// handles this fine (the work is network-I/O wait, not CPU); the cap keeps us under Binance's
// per-IP rate limit through the single VPN exit.
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

// A "whale" aggTrade = at least this much USD notional in one print, uniform across all symbols.
// Shared definition with the historical backfill (scripts/backfill-whale-trades.ts) so archived
// live data and backfilled history are directly comparable.
export const WHALE_NOTIONAL_USD = 100_000;

// Order-book depth snapshot summarizer (2026-07-10). Sums USD-notional resting liquidity within
// +/-0.5% / 1% / 2% of mid, per side, from a fapi depth response (bids desc, asks asc). The
// fetched book (limit=500 levels/side) may not REACH a band on thick-tick symbols, so each
// side's actual span is recorded — a sum whose span < band is a truncated lower bound, and the
// data stays self-describing. Exported for unit tests.
export function summarizeDepth(bids: Array<[string, string]>, asks: Array<[string, string]>): {
  mid: number; bestBid: number; bestAsk: number;
  bid05: number; ask05: number; bid1: number; ask1: number; bid2: number; ask2: number;
  bidSpanPct: number; askSpanPct: number;
} | null {
  if (!bids?.length || !asks?.length) return null;
  const bestBid = parseFloat(bids[0][0]), bestAsk = parseFloat(asks[0][0]);
  if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk < bestBid) return null;
  const mid = (bestBid + bestAsk) / 2;
  const out = { mid, bestBid, bestAsk, bid05: 0, ask05: 0, bid1: 0, ask1: 0, bid2: 0, ask2: 0, bidSpanPct: 0, askSpanPct: 0 };
  for (const [ps, qs] of bids) {
    const p = parseFloat(ps), q = parseFloat(qs);
    if (!(p > 0) || !(q > 0)) continue;
    const distPct = (mid - p) / mid * 100;
    if (distPct > 2) break;                    // bids are sorted best->worse
    const usd = p * q;
    if (distPct <= 0.5) out.bid05 += usd;
    if (distPct <= 1) out.bid1 += usd;
    out.bid2 += usd;
    out.bidSpanPct = distPct;
  }
  for (const [ps, qs] of asks) {
    const p = parseFloat(ps), q = parseFloat(qs);
    if (!(p > 0) || !(q > 0)) continue;
    const distPct = (p - mid) / mid * 100;
    if (distPct > 2) break;
    const usd = p * q;
    if (distPct <= 0.5) out.ask05 += usd;
    if (distPct <= 1) out.ask1 += usd;
    out.ask2 += usd;
    out.askSpanPct = distPct;
  }
  return out;
}

// Fetch the 7 live fapi/binance derivative endpoints for one symbol concurrently and parse them
// into the raw values the ML uses. Shared by the cron's bounded-parallel pre-warm and the
// in-loop cache-miss fallback. Returns 0 for any endpoint that failed (same as the original
// serial behavior). No OI-delta here — that needs prevOI and is computed in the symbol loop.
async function fetchLiveDerivatives(symbol: string): Promise<any> {
  const FAPI = 'https://fapi.binance.com';
  const J = async (u: string): Promise<any> => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } };
  const [fr, tlsp, tls, oih, glsa, pi, at] = await Promise.all([
    J(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`),
    J(`${FAPI}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=4h&limit=1`),
    J(`${FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=4h&limit=1`),
    J(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=1`),
    J(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=4h&limit=1`),
    J(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`),
    // FUTURES aggTrades (was spot): whales trade perps, and this is the venue the rest of the
    // derivatives signals come from. See WHALE_NOTIONAL_USD for the "large" definition.
    J(`${FAPI}/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`),
  ]);
  let fundingRate = 0, topTraderLongPct = 0, takerBuyVol = 0, takerSellVol = 0, takerRatio = 0;
  let openInterest = 0, markPrice = 0, indexPrice = 0, longPct = 0, basisPct = 0;
  let largeBuyVol = 0, largeSellVol = 0, largeBuyCount = 0, largeSellCount = 0;
  if (fr && fr.length) fundingRate = parseFloat(fr[0].fundingRate) * 100;
  if (tlsp && tlsp.length) topTraderLongPct = parseFloat(tlsp[0].longAccount) * 100;
  if (tls && tls.length) { takerBuyVol = parseFloat(tls[0].buyVol); takerSellVol = parseFloat(tls[0].sellVol); takerRatio = parseFloat(tls[0].buySellRatio); }
  if (oih && oih.length) openInterest = parseFloat(oih[0].sumOpenInterest);
  if (glsa && glsa.length) longPct = parseFloat(glsa[0].longAccount) * 100;
  if (pi) {
    markPrice = parseFloat(pi.markPrice); indexPrice = parseFloat(pi.indexPrice);
    if (indexPrice > 0) basisPct = (markPrice - indexPrice) / indexPrice * 100;
  }
  if (at && at.length) {
    // "Whale" = fixed $100k notional per aggTrade, consistent across symbols. The previous
    // threshold (0.5 × price = 0.5 UNITS of the asset) meant ~$30k for BTC but literal cents for
    // DOGE-class alts — not a whale definition at all. Zero counts on illiquid alts are honest
    // signal (no whale prints), not a bug. Keep in sync with scripts/backfill-whale-trades.ts.
    for (const t of at) {
      const notional = parseFloat(t.q) * parseFloat(t.p);
      if (notional < WHALE_NOTIONAL_USD) continue;
      if (t.m) { largeSellVol += notional; largeSellCount++; } else { largeBuyVol += notional; largeBuyCount++; }
    }
  }
  return { fundingRate, openInterest, topTraderLongPct, takerBuyVol, takerSellVol, takerRatio, longPct, markPrice, indexPrice, basisPct, largeBuyVol, largeSellVol, largeBuyCount, largeSellCount };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    setProxyConfig(env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check — no KV, no auth
    if (path === '/' || path === '/health') {
      // `build` = the git SHA baked into the image (GIT_SHA build-arg) — lets anyone verify
      // which commit the box is ACTUALLY running after a TrueNAS pull-and-restart.
      const build = (globalThis as any).process?.env?.GIT_SHA ?? 'unknown';
      // Report which optional provider keys are present (booleans only — never the values) so a
      // missing-secret misconfig (e.g. the app's Finnhub badge going red) is diagnosable remotely
      // without auth. A red badge + finnhub:false here = the key wasn't carried to the box env.
      // `/health?probe=liquidations` runs the collector's network diagnostic ON THE BOX: REST and
      // websocket, each with and without the proxy, plus the egress country. It distinguishes
      // "rejected at upgrade" (proxy can't carry Upgrade: -> use gluetun's network directly) from
      // "opens then stays mute" (exit region geoblocked -> change exit country). Guessing between
      // those two cost six weeks of a non-backfillable series.
      if (url.searchParams.get('probe') === 'liquidations') {
        const probe = (globalThis as any).__marketscopeLiqProbe;
        if (!probe) return json({ error: 'collector not running in this runtime' }, 503);
        try { return json(await probe()); } catch (e) { return json({ error: String(e) }, 500); }
      }
      const providers = { finnhub: !!env.FINNHUB_API_KEY };
      // Liquidation collector state. Surfaced here because that series CANNOT be backfilled, so a
      // dead collector must be visible without reading container logs — `/liquidations` returning
      // an empty array is indistinguishable from a quiet market, which is how six weeks of loss
      // went unnoticed (2026-08-22). `healthy` is judged on DATA FLOW, not connection state: the
      // actual failure was a socket that opened and then delivered nothing, forever.
      let liquidations: any = null;
      try { liquidations = (globalThis as any).__marketscopeLiqStatus?.() ?? null; } catch { /* never fail /health */ }
      // `/health?probe=finnhub` does ONE live market-status ping and returns the upstream HTTP
      // status (cached 60s) — so "key present but badge still red" is diagnosable in one curl:
      //   403 = market-status is a premium endpoint (free-tier key) · 401 = bad key · 429 = rate limit.
      if (url.searchParams.get('probe') === 'finnhub') {
        let probe: any = { configured: !!env.FINNHUB_API_KEY };
        if (env.FINNHUB_API_KEY) {
          try {
            const cached = await env.ALERTS.get('cache:fh:probe');
            if (cached) probe = JSON.parse(cached);
            else {
              // Ping every endpoint FinnhubProvider (which drives the app's badge) actually calls,
              // for a sample stock — so we see WHICH one 403s (premium) / 429s (rate limit) while
              // market-status is 200. That's what makes the badge stick red.
              const eps: Record<string, string> = {
                'market-status': '/stock/market-status?exchange=US',
                recommendation: '/stock/recommendation?symbol=AAPL',
                metric: '/stock/metric?symbol=AAPL&metric=all',
                earnings: '/calendar/earnings?symbol=AAPL',
                news: `/company-news?symbol=AAPL&from=${new Date(Date.now()-7*86400_000).toISOString().split('T')[0]}&to=${new Date().toISOString().split('T')[0]}`,
                insider: '/stock/insider-transactions?symbol=AAPL',
              };
              const statuses: Record<string, number | string> = {};
              for (const [name, p] of Object.entries(eps)) {
                try { const r = await fetch(`${FINNHUB_BASE}${p}`, { headers: { 'X-Finnhub-Token': env.FINNHUB_API_KEY } }); statuses[name] = r.status; }
                catch (e) { statuses[name] = `err:${e}`; }
              }
              probe = { configured: true, statuses };
              await env.ALERTS.put('cache:fh:probe', JSON.stringify(probe), { expirationTtl: 60 });
            }
          } catch (e) { probe = { configured: true, error: `${e}` }; }
        }
        return json({ status: 'ok', build, finnhub: probe });
      }
      return json({ status: 'ok', build, providers, ...(liquidations ? { liquidations } : {}) });
    }

    // Dead-man's-switch for the cron pipeline. Public (no auth) so an external uptime
    // monitor can poll it. Returns 503 when the cron heartbeat is stale (> 10 min, i.e.
    // several missed minute-crons) — the whole ML + notification pipeline is down.
    if (path === '/cron-health') {
      const hb = await env.ALERTS.get('cron:heartbeat');
      const ageMs = hb ? Date.now() - Number(hb) : null;
      const stale = ageMs === null || ageMs > 10 * 60 * 1000;
      return json({ ok: !stale, heartbeatAgeSec: ageMs === null ? null : Math.round(ageMs / 1000) },
                  stale ? 503 : 200);
    }

    // Block non-app traffic — require app identifier header on all endpoints
    const appId = request.headers.get('X-App-ID');
    if (appId !== 'marketscope-ios') {
      return json({ error: 'Forbidden' }, 403);
    }

    // Enforce body size limits on bodied requests. Content-Length is REQUIRED (411 otherwise):
    // a chunked-encoding request carries no length header, and pre-2026-07-02 that parsed to 0
    // and sailed past the cap — on Cloudflare the platform capped bodies anyway, but on the box
    // request.json() would buffer an unbounded stream into RAM (memory-exhaustion DoS). Every
    // legitimate client (iOS URLSession, browser fetch) always sends Content-Length.
    // /history (candle uploads) is exempt from MAX_BODY_BYTES but still hard-capped.
    if (request.method === 'POST' || request.method === 'PUT') {
      const lenHeader = request.headers.get('Content-Length');
      if (lenHeader === null) return json({ error: 'Length Required' }, 411);
      const contentLength = parseInt(lenHeader);
      const cap = path === '/history' ? 10_000_000 : MAX_BODY_BYTES;
      if (!Number.isFinite(contentLength) || contentLength > cap) {
        return json({ error: 'Request body too large' }, 413);
      }
    }

    // Device auth: server-issued token stored in X-Auth-Token header
    const deviceId = request.headers.get('X-Device-ID') || '';
    const authToken = request.headers.get('X-Auth-Token') || '';

    // Validate deviceId format to prevent KV key abuse
    if (deviceId && !DEVICE_ID_REGEX.test(deviceId)) {
      return json({ error: 'Invalid device ID format' }, 400);
    }

    // === Device registration — issues an auth token (D1) ===
    if (path === '/register' && request.method === 'POST') {
      try {
        const body = await request.json() as { deviceToken?: string };
        if (!deviceId) return json({ error: 'Missing device ID' }, 400);

        // Check D1 first, then KV fallback for legacy devices
        const device = await env.DB.prepare('SELECT auth_token FROM devices WHERE device_id = ?').bind(deviceId).first();
        const existing = (device?.auth_token as string) || await env.ALERTS.get(`auth:${deviceId}`);

        if (existing) {
          const providedToken = request.headers.get('X-Auth-Token') || '';
          if (!timingSafeEqual(providedToken, existing)) return json({ error: 'Unauthorized' }, 401);

          // Update push token + last_seen in D1
          await env.DB.prepare(
            'INSERT OR REPLACE INTO devices (device_id, push_token, auth_token, last_seen) VALUES (?, ?, ?, ?)'
          ).bind(deviceId, body.deviceToken || null, existing, new Date().toISOString()).run();
          return json({ ok: true });
        }

        // New device — rate limit by IP
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        // 20/24h per IP (was 3). The web app registers once per browser and persists the
        // token, but cache-clears / multiple browsers / a shared household IP made 3 too tight
        // — a single afternoon of testing exhausted it. Still anti-abuse, just web-friendly.
        const ipLimited = await checkRateLimit(env, `reg-ip:${ip}`, 20, 86400);
        if (ipLimited) return json({ error: 'Too many registrations. Try again tomorrow.' }, 429);

        const token = crypto.randomUUID() + '-' + crypto.randomUUID();
        // Write to D1 (primary) + KV (backward compat during migration)
        await env.DB.prepare(
          'INSERT INTO devices (device_id, push_token, auth_token) VALUES (?, ?, ?)'
        ).bind(deviceId, body.deviceToken || null, token).run();
        await env.ALERTS.put(`auth:${deviceId}`, token, { expirationTtl: 86400 * 90 });

        return json({ ok: true, authToken: token });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // All endpoints require a valid auth token EXCEPT the deliberately-public set below
    // (/register bootstraps auth; /bls, /derivatives, /spot, /candles/crypto, /sentiment,
    // /darkpool are public read-only proxies with their own caching/IP limits).
    // 2026-07-02: /debug/*, /twelvedata/*, /finnhub/* moved BEHIND the gate — they were
    // exempt (contradicting this doc's endpoint table), leaving upstream API quota burnable
    // and /debug/backfill-derivatives usable as a DoS lever with only the public X-App-ID.
    // iOS FinnhubProvider already sends auth headers; nothing calls /twelvedata or /debug.
    if (path !== '/register' && path !== '/bls/actuals' && path !== '/derivatives' && path !== '/spot' && path !== '/candles/crypto' && path !== '/sentiment' && path !== '/darkpool') {
      if (!deviceId || !authToken) return json({ error: 'Unauthorized' }, 401);
      // Check D1 first, then KV fallback
      const device = await env.DB.prepare('SELECT auth_token FROM devices WHERE device_id = ?').bind(deviceId).first();
      const storedToken = (device?.auth_token as string) || await env.ALERTS.get(`auth:${deviceId}`);
      if (!storedToken || !timingSafeEqual(storedToken, authToken)) return json({ error: 'Unauthorized' }, 401);

      // Migrate legacy KV device to D1 on successful auth
      if (!device && storedToken) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO devices (device_id, auth_token) VALUES (?, ?)'
        ).bind(deviceId, storedToken).run();
      }

      // /full-analysis/result is exempt from the global budget: the client polls it every 3s
      // (20/min) during an analysis, which combined with a refresh cycle (indicators + market +
      // ml-predict + macro + per-favorite prefetch) blew the 60/min cap — and a rate-limited
      // POLL killed the analysis UI while the detached job was still running fine. The poll is
      // a single KV read, still auth-gated, with a per-job ownership check.
      // 300/min since 2026-07-25 (was 60). 60 was a Cloudflare-era number, chosen when every
      // request cost quota against the free Workers tier. The backend is now a Node process on the
      // user's own hardware with no per-request cost and no upstream cap, serving ONE user — so the
      // gate's only real job is to stop a runaway client loop, which 300 does just as well.
      //
      // 60 was actively harmful: stocks cost ~7 requests per refresh (see fetchStockEnrichment's
      // note on the /finnhub/* fan-out that this release removes), so touching ~8 stocks inside a
      // minute produced a 429 storm on the *stock* path only. Note the gate runs BEFORE endpoint
      // routing, so a response served entirely from the worker's own 1-24h cache costs exactly as
      // much budget as a cold one — the caching gave no protection against the limit it caused.
      if (path !== '/full-analysis/result') {
        const globalLimited = await checkRateLimit(env, `global:${deviceId}`, 300, 60);
        if (globalLimited) return json({ error: 'Rate limited. Try again in a minute.' }, 429);
      }
    }

            
    // === /pending-setups: REMOVED 2026-07-24 ===
    // These three handlers (POST/GET/DELETE) were the legacy iOS registration path for conditional
    // setups. iOS stopped calling them at the 2026-07-09 server-side cutover (WorkerPendingSetupService
    // was deleted then), registration moved into registerTrackedSetups, and the entry-zone-touch
    // notification now reads `tracked_setups` (state='pending') directly — so the `pending_setups`
    // table was a pure duplicate of rows that already existed. Nothing in iOS or web/ references the
    // endpoints (grep-verified). The deployed table and its rows are left in place, harmless and
    // unread; drop it by hand once you're satisfied nothing regressed:
    //     DROP TABLE pending_setups;

    // === AI Analysis Proxy ===
    if (path === '/analyze' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);

      // Rate limit per device
      const limited = await checkRateLimit(env, `analyze:${deviceId}`, RATE_LIMIT_ANALYZE);
      if (limited) return json({ error: 'Rate limited. Max 10 analyses per hour.' }, 429);

      try {
        const body = await request.json() as { model: string; system: string; prompt: string; provider?: string; thinkingBudget?: number };
        if (!body.prompt || !body.system) return json({ error: 'Missing prompt or system' }, 400);

        // Validate prompt size
        if (body.prompt.length > MAX_PROMPT_CHARS || body.system.length > MAX_PROMPT_CHARS) {
          return json({ error: 'Prompt too large' }, 413);
        }

        const provider = body.provider || 'claude';

        if (provider === 'deepseek') {
          // DeepSeek (OpenAI-compatible API). Models: deepseek-reasoner (R1) + deepseek-chat (V3).
          // R1 returns a `reasoning_content` field with its thinking, then `content` with the
          // final answer — we keep only `content` and normalize to Claude's response shape.
          if (!env.DEEPSEEK_API_KEY) return json({ error: 'DeepSeek not configured' }, 503);
          const DEEPSEEK_MODELS = ['deepseek-reasoner', 'deepseek-chat'];
          const model = DEEPSEEK_MODELS.includes(body.model) ? body.model : 'deepseek-reasoner';

          const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 8000,  // R1's reasoning + answer can be long
              temperature: 0,
              messages: [
                { role: 'system', content: body.system },
                { role: 'user', content: body.prompt },
              ],
            }),
          });

          if (!resp.ok) {
            const code = resp.status;
            if (code === 429) return json({ error: 'AI service busy. Try again shortly.' }, 429);
            if (code >= 500) return json({ error: 'AI service temporarily unavailable' }, 502);
            return json({ error: `AI error (${code})` }, code);
          }

          const dsResult = await resp.json() as any;
          const text = dsResult?.choices?.[0]?.message?.content || '';
          // Normalize to Claude's content envelope so iOS clients parse uniformly.
          return json({ content: [{ type: 'text', text }] });

        } else if (provider === 'gemini') {
          // Gemini
          if (!env.GEMINI_API_KEY) return json({ error: 'Gemini not configured' }, 503);
          const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];
          const model = GEMINI_MODELS.includes(body.model) ? body.model : 'gemini-2.5-flash';

          // Note: Gemini requires API key in URL (no header auth). Server-to-server only.
          const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: body.system }] },
              contents: [{ parts: [{ text: body.prompt }] }],
              generationConfig: { maxOutputTokens: 2500, temperature: 0 },
            }),
          });

          if (!resp.ok) {
            const code = resp.status;
            if (code === 429) return json({ error: 'AI service busy. Try again shortly.' }, 429);
            if (code >= 500) return json({ error: 'AI service temporarily unavailable' }, 502);
            return json({ error: `AI error (${code})` }, code);
          }

          // Normalize Gemini response to Claude format for the app
          const gemResult = await resp.json() as any;
          const text = gemResult?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          return json({ content: [{ type: 'text', text }] });

        } else {
          // Claude (default)
          if (!env.CLAUDE_API_KEY) return json({ error: 'AI not configured' }, 503);
          const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'claude-sonnet-4-6';

          // Extended thinking: opt-in via thinkingBudget. Anthropic API requires
          // budget_tokens >= 1024 and < max_tokens. When enabled we bump max_tokens to
          // accommodate both thinking budget AND the response budget. temperature must be
          // 1.0 when thinking is enabled (per Anthropic API requirements).
          const thinkingBudget = body.thinkingBudget && body.thinkingBudget >= 1024 ? body.thinkingBudget : null;
          const requestBody: Record<string, unknown> = {
            model,
            max_tokens: thinkingBudget ? thinkingBudget + 4000 : 4000,
            temperature: thinkingBudget ? 1 : 0,
            system: body.system,
            messages: [{ role: 'user', content: body.prompt }],
          };
          if (thinkingBudget) {
            requestBody.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
          }

          // Sonnet 4.6 defaults to 200K context; the analysis prompt + indicator series
          // + economic events + news can push past that on busy macro days. The
          // `context-1m-2025-08-07` beta unlocks 1M context (input + thinking + output).
          // Cheap header, no behaviour change for smaller prompts.
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': env.CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'context-1m-2025-08-07',
              'content-type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          if (!resp.ok) {
            const code = resp.status;
            if (code === 429) return json({ error: 'AI service busy. Try again shortly.' }, 429);
            if (code >= 500) return json({ error: 'AI service temporarily unavailable' }, 502);
            return json({ error: `AI error (${code})` }, code);
          }

          const result = await resp.json();
          return json(result);
        }
      } catch (e) {
        return json({ error: 'Analysis failed' }, 500);
      }
    }

    // === Tiingo Candles (cached 5min, shared) ===
    if (path === '/tiingo/candles') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval') || '1hour';  // 1hour or 1day
      const days = url.searchParams.get('days') || '60';
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.TIINGO_API_KEY) return json({ error: 'Tiingo not configured' }, 503);

      const cacheKey = `cache:tiingo:${symbol}:${interval}:${days}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        // Support explicit startDate/endDate params (for optimizer/backtester) or days-based
        const explicitStart = url.searchParams.get('startDate');
        const explicitEnd = url.searchParams.get('endDate');
        const startDate = explicitStart || new Date(Date.now() - parseInt(days) * 86400_000).toISOString().split('T')[0];
        const endParam = explicitEnd ? `&endDate=${explicitEnd}` : '';
        let apiUrl: string;
        if (interval === '1day') {
          apiUrl = `${TIINGO_DAILY}/${symbol}/prices?startDate=${startDate}${endParam}&token=${env.TIINGO_API_KEY}`;
        } else {
          apiUrl = `${TIINGO_IEX}/${symbol}/prices?startDate=${startDate}${endParam}&resampleFreq=${interval}&columns=open,high,low,close,volume&token=${env.TIINGO_API_KEY}`;
        }
        const resp = await fetch(apiUrl, {
          headers: { 'Content-Type': 'application/json' },
        });
        if (!resp.ok) return json({ error: `Tiingo ${resp.status}` }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Tiingo fetch failed' }, 502);
      }
    }

    // === Alpha Vantage Intraday (proxied, API key server-side) ===
    if (path === '/alphavantage/intraday') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval') || '60min';
      const month = url.searchParams.get('month') || '';
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.ALPHAVANTAGE_API_KEY) return json({ error: 'Alpha Vantage not configured' }, 503);

      try {
        const apiUrl = `${ALPHAVANTAGE_BASE}?function=TIME_SERIES_INTRADAY&symbol=${symbol}&interval=${interval}&month=${month}&outputsize=full&apikey=${env.ALPHAVANTAGE_API_KEY}`;
        const resp = await fetch(apiUrl);
        if (!resp.ok) return json({ error: `Alpha Vantage ${resp.status}` }, 502);
        const data = await resp.json();
        return json(data);
      } catch {
        return json({ error: 'Alpha Vantage fetch failed' }, 502);
      }
    }

    // === Twelve Data Candles (cached 5min, shared) ===
    if (path === '/twelvedata/candles') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval')?.replace(/[^0-9a-zA-Z]/g, '') || '1day';
      const startDate = url.searchParams.get('start_date')?.replace(/[^0-9\-\s:]/g, '') || '';
      const endDate = url.searchParams.get('end_date')?.replace(/[^0-9\-\s:]/g, '') || '';
      const outputsize = Math.min(parseInt(url.searchParams.get('outputsize') || '50'), 5000);
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.TWELVE_DATA_API_KEY) return json({ error: 'Twelve Data not configured' }, 503);

      const cacheKey = `cache:td:${symbol}:${interval}:${startDate || outputsize}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        // Round-robin between two API keys to double rate limit (16 req/min)
        const tdKeys = [env.TWELVE_DATA_API_KEY, env.TWELVE_DATA_API_KEY_2].filter(Boolean) as string[];
        const tdKey = tdKeys[Math.floor(Math.random() * tdKeys.length)];
        let apiUrl = `${TWELVE_DATA_BASE}/time_series?symbol=${symbol}&interval=${interval}&apikey=${tdKey}`;
        if (startDate && endDate) {
          apiUrl += `&start_date=${startDate}&end_date=${endDate}&outputsize=5000`;
        } else {
          apiUrl += `&outputsize=${outputsize}`;
        }
        const resp = await fetch(apiUrl);
        if (!resp.ok) return json({ error: `Twelve Data ${resp.status}` }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Twelve Data fetch failed' }, 502);
      }
    }

    // === Twelve Data Quote (cached 60s) ===
    if (path === '/twelvedata/quote') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.TWELVE_DATA_API_KEY) return json({ error: 'Twelve Data not configured' }, 503);

      const cacheKey = `cache:td-quote:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        const tdKeys2 = [env.TWELVE_DATA_API_KEY, env.TWELVE_DATA_API_KEY_2].filter(Boolean) as string[];
        const tdKey2 = tdKeys2[Math.floor(Math.random() * tdKeys2.length)];
        const resp = await fetch(`${TWELVE_DATA_BASE}/quote?symbol=${symbol}&apikey=${tdKey2}`);
        if (!resp.ok) return json({ error: `Twelve Data ${resp.status}` }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Twelve Data fetch failed' }, 502);
      }
    }

    // === Finnhub Enrichment (cached 24h for fundamentals, 1h for dynamic) ===
    // === Finnhub Market Status (special case — no symbol needed) ===
    if (path === '/finnhub/market-status') {
      if (!env.FINNHUB_API_KEY) return json({ error: 'Finnhub not configured' }, 503);
      const exchange = url.searchParams.get('symbol') || 'US';
      const cacheKey = `cache:fh:market-status:${exchange}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }
      try {
        const resp = await fetch(`${FINNHUB_BASE}/stock/market-status?exchange=${exchange}`, {
          headers: { 'X-Finnhub-Token': env.FINNHUB_API_KEY },
        });
        if (!resp.ok) return json({ error: `Finnhub ${resp.status}` }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Finnhub fetch failed' }, 502);
      }
    }

    // === BLS Economic Actuals (no auth — public data, cached 1h) ===
    if (path === '/bls/actuals') {
      const cacheKey = 'cache:bls:actuals:v2';
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 3600_000) return json(parsed.data);
      }

      // BLS v2 POST — all series in one request (no key needed, 25 req/day limit)
      const seriesIds = ['CUSR0000SA0', 'CUSR0000SA0L1E', 'LNS14000000', 'CES0000000001'];
      const actuals: Record<string, string> = {};

      try {
        const resp = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seriesid: seriesIds }),
        });
        if (!resp.ok) return json({ error: `BLS ${resp.status}` }, 502);
        const data = await resp.json() as any;
        const allSeries = data?.Results?.series || [];

        for (const s of allSeries) {
          const id = s.seriesID;
          const obs = s.data; // newest first
          if (!obs || obs.length < 2) continue;

          const latest = parseFloat(obs[0].value);
          const prev = parseFloat(obs[1].value);
          if (isNaN(latest) || isNaN(prev) || latest <= 0 || prev <= 0) continue;

          if (id === 'CUSR0000SA0') {
            actuals['CPI m/m'] = ((latest - prev) / prev * 100).toFixed(1) + '%';
            if (obs.length >= 13) {
              const yoy = parseFloat(obs[12].value);
              if (!isNaN(yoy) && yoy > 0) actuals['CPI y/y'] = ((latest - yoy) / yoy * 100).toFixed(1) + '%';
            }
          } else if (id === 'CUSR0000SA0L1E') {
            actuals['Core CPI m/m'] = ((latest - prev) / prev * 100).toFixed(1) + '%';
          } else if (id === 'LNS14000000') {
            actuals['Unemployment Rate'] = latest.toFixed(1) + '%';
          } else if (id === 'CES0000000001') {
            const diff = latest - prev;
            actuals['Non-Farm Employment Change'] = (diff >= 0 ? '+' : '') + diff.toFixed(0) + 'K';
          }
        }
      } catch { /* skip */ }

      const result = { actuals, fetchedAt: new Date().toISOString(), count: Object.keys(actuals).length };
      if (Object.keys(actuals).length > 0) {
        await env.ALERTS.put(cacheKey, JSON.stringify({ data: result, timestamp: Date.now() }), { expirationTtl: 3600 });
      }
      return json(result);
    }

    if (path.startsWith('/finnhub/')) {
      const endpoint = path.replace('/finnhub/', '');
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      if (!env.FINNHUB_API_KEY) return json({ error: 'Finnhub not configured' }, 503);

      // Map endpoints to Finnhub URLs and cache TTLs
      const endpointMap: Record<string, { path: string; ttl: number; params?: string }> = {
        'recommendation': { path: '/stock/recommendation', ttl: 86400_000 },
        'metric': { path: '/stock/metric', ttl: 86400_000, params: '&metric=all' },
        'quote': { path: '/quote', ttl: 300_000 },
        'earnings': { path: '/calendar/earnings', ttl: 43200_000, params: `&from=${new Date(Date.now() - 30*86400_000).toISOString().split('T')[0]}&to=${new Date(Date.now() + 60*86400_000).toISOString().split('T')[0]}` },
        'news': { path: '/company-news', ttl: 3600_000, params: `&from=${new Date(Date.now() - 7*86400_000).toISOString().split('T')[0]}&to=${new Date().toISOString().split('T')[0]}` },
        'peers': { path: '/stock/peers', ttl: 86400_000 },
        'profile': { path: '/stock/profile2', ttl: 86400_000 },
        'insider': { path: '/stock/insider-transactions', ttl: 43200_000, params: '' },
      };

      const config = endpointMap[endpoint];
      if (!config) return json({ error: 'Unknown Finnhub endpoint' }, 404);

      // Optional from/to passthrough for endpoints that support date ranges (e.g., insider).
      // Keeps existing per-endpoint defaults (earnings/news) but lets callers override or add ranges.
      const fromParam = url.searchParams.get('from');
      const toParam = url.searchParams.get('to');
      const dateRangeStr = (fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam)) && (toParam && /^\d{4}-\d{2}-\d{2}$/.test(toParam))
        ? `&from=${fromParam}&to=${toParam}`
        : '';
      // Per-endpoint cache key includes from/to so different ranges don't collide.
      const rangeCacheKey = dateRangeStr ? `:${fromParam}:${toParam}` : '';
      const fullCacheKey = `cache:fh:${endpoint}:${symbol}${rangeCacheKey}`;
      const cachedRange = await env.ALERTS.get(fullCacheKey);
      if (cachedRange) {
        const parsed = JSON.parse(cachedRange);
        if (Date.now() - parsed.timestamp < config.ttl) return json(parsed.data);
      }

      try {
        // dateRangeStr (if provided) overrides config.params for endpoints that don't have hardcoded dates.
        const paramsToUse = dateRangeStr || (config.params || '');
        const finnhubUrl = `${FINNHUB_BASE}${config.path}?symbol=${symbol}${paramsToUse}`;
        const resp = await fetch(finnhubUrl, {
          headers: { 'X-Finnhub-Token': env.FINNHUB_API_KEY },
        });
        if (!resp.ok) return json({ error: `Finnhub ${resp.status}` }, 502);
        const data = await resp.json();
        const kvTtl = Math.max(Math.ceil(config.ttl / 1000), 60);
        await env.ALERTS.put(fullCacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: kvTtl });
        return json(data);
      } catch {
        return json({ error: 'Finnhub fetch failed' }, 502);
      }
    }

    // === Macro Data — now powered by FRED (cached 5m, shared) ===
    if (path === '/macro') {
      const cacheKey = 'cache:macro:v3';  // bumped to clear stale DXY data
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) {
          return json(parsed.data);
        }
      }

      const data: Record<string, any> = {};

      // FRED API — authoritative source for all macro data
      if (env.FRED_API_KEY) {
        const series: [string, string][] = [
          ['vix', 'VIXCLS'],
          ['treasury10Y', 'DGS10'],
          ['treasury2Y', 'DGS2'],
          ['fedFundsRate', 'FEDFUNDS'],
        ];
        for (const [key, seriesId] of series) {
          try {
            // FRED requires API key in URL. Server-to-server only.
            const resp = await fetch(`${FRED_BASE}?series_id=${seriesId}&sort_order=desc&limit=2&api_key=${env.FRED_API_KEY}&file_type=json`);
            if (resp.ok) {
              const result = await resp.json() as any;
              const obs = result?.observations;
              if (obs && obs.length > 0) {
                // Skip "." values (FRED uses "." for missing/unreported)
                const latest = obs.find((o: any) => o.value !== '.');
                if (latest) {
                  const val = parseFloat(latest.value);
                  data[key] = isNaN(val) ? null : val;
                  data[`${key}Date`] = latest.date;
                }
              }
            }
          } catch { /* skip */ }
        }
      }

      // USD Index (DXY) from Yahoo Finance — ICE US Dollar Index, same as TradingView
      try {
        const dxyResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/DX-Y.NYB?interval=1d&range=5d`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        });
        if (dxyResp.ok) {
          const dxyData = await dxyResp.json() as any;
          const meta = dxyData?.chart?.result?.[0]?.meta;
          const price = meta?.regularMarketPrice ?? meta?.previousClose;
          if (price != null && !isNaN(price) && price > 70 && price < 130) {
            data['usdIndex'] = Math.round(price * 100) / 100;
          }
        }
      } catch { /* skip */ }

      // Compute yield spread
      if (data.treasury10Y != null && data.treasury2Y != null) {
        data.yieldSpread = Math.round((data.treasury10Y - data.treasury2Y) * 100) / 100;
      }

      await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
      return json(data);
    }

    // === Yahoo Crumb Auth (cached 30 min) ===
    // getYahooCrumb moved to module scope (defined above export default) so the cron can call it.

    // === Yahoo Proxies (cached) ===
    if (path === '/yahoo/quote') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:yahoo:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 30_000) return json(parsed.data);
      }

      try {
        const resp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=5d`);
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 60 });
        return json(data);
      } catch {
        return json({ error: 'Fetch failed' }, 502);
      }
    }

    if (path === '/yahoo/summary') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const modules = url.searchParams.get('modules')?.replace(/[^a-zA-Z,]/g, '') || 'defaultKeyStatistics,price';
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:yahoo-summary:${symbol}:${modules}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        let auth = await getYahooCrumb(env);
        const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
        let crumbParam = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : '';
        let headers: Record<string, string> = { 'User-Agent': ua };
        if (auth) headers['Cookie'] = auth.cookie;
        let resp = await fetch(`${YAHOO_BASE}/v10/finance/quoteSummary/${symbol}?modules=${modules}${crumbParam}`, { headers });
        // Retry with fresh crumb on 401
        if (resp.status === 401 && auth) {
          await env.ALERTS.delete('cache:yahoo-crumb');
          auth = await getYahooCrumb(env);
          crumbParam = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : '';
          headers = { 'User-Agent': ua };
          if (auth) headers['Cookie'] = auth.cookie;
          resp = await fetch(`${YAHOO_BASE}/v10/finance/quoteSummary/${symbol}?modules=${modules}${crumbParam}`, { headers });
        }
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Fetch failed' }, 502);
      }
    }

    if (path === '/yahoo/options') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:yahoo-options:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data);
      }

      try {
        let auth = await getYahooCrumb(env);
        const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
        let crumbParam = auth ? `?crumb=${encodeURIComponent(auth.crumb)}` : '';
        let headers: Record<string, string> = { 'User-Agent': ua };
        if (auth) headers['Cookie'] = auth.cookie;
        let resp = await fetch(`${YAHOO_BASE}/v7/finance/options/${symbol}${crumbParam}`, { headers });
        if (resp.status === 401 && auth) {
          await env.ALERTS.delete('cache:yahoo-crumb');
          auth = await getYahooCrumb(env);
          crumbParam = auth ? `?crumb=${encodeURIComponent(auth.crumb)}` : '';
          headers = { 'User-Agent': ua };
          if (auth) headers['Cookie'] = auth.cookie;
          resp = await fetch(`${YAHOO_BASE}/v7/finance/options/${symbol}${crumbParam}`, { headers });
        }
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Fetch failed' }, 502);
      }
    }

    // === Watchlist Sync (D1) ===
    if (path === '/watchlist' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const body = await request.json() as any;
      // Normalize through sanitizeSymbol + uppercase. The cron archive set and most
      // KV/prediction keys are uppercase by convention; a lowercase `btcusdt` from
      // a misbehaving client would otherwise create a parallel `btcusdt` archive
      // shadow and miss the shared `BTCUSDT` ARCHIVE_CRYPTO processing path.
      const symbols = (body.symbols || []).slice(0, 20)
        .map((s: any) => {
          if (typeof s !== 'string') return null;
          const clean = sanitizeSymbol(s);
          return clean ? clean.toUpperCase() : null;
        })
        .filter((s: string | null): s is string => s !== null);
      const cryptoThreshold = body.cryptoThreshold || 5;
      const stockThreshold = body.stockThreshold || 3;
      // Write to D1
      const stmts = [env.DB.prepare('DELETE FROM watchlist WHERE device_id = ?').bind(deviceId)];
      for (const s of symbols) {
        stmts.push(env.DB.prepare(
          'INSERT INTO watchlist (device_id, symbol, crypto_threshold, stock_threshold) VALUES (?, ?, ?, ?)'
        ).bind(deviceId, s, cryptoThreshold, stockThreshold));
      }
      // Refresh last_seen on this app-launch sync so the daily stale-device sweep
      // (deletes last_seen > 30d) doesn't orphan an actively-used device. Previously
      // last_seen was set ONLY on /register, which an authed app never calls again — so
      // every device got swept after 30 days, invalidating its token → blank ML "suddenly".
      stmts.push(env.DB.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?')
        .bind(new Date().toISOString(), deviceId));
      await env.DB.batch(stmts);
      // Also keep KV during migration (cron reads from KV)
      await env.ALERTS.put(`watchlist:${deviceId}`, JSON.stringify({
        symbols, cryptoThreshold, stockThreshold, updatedAt: Date.now()
      }), { expirationTtl: 86400 * 30 });
      return json({ ok: true, symbols: symbols.length });
    }

    // === ML Model Version (R2) ===
    // === ML Prediction Read (cron-cached) ===
    // Returns the latest cached ML probability + features for a symbol. Cache is populated
    // by the per-minute cron via a single `ml_preds:all` KV blob (5-min TTL) that maps
    // symbol → {symbol, probability, features, timestamp, isCrypto}. Was 76 separate
    // `ml_pred:<symbol>` keys; batching cut KV writes from ~3.3M/month to ~43K/month
    // (the dominant Cloudflare cost). Auth-gated via the standard header check above.
    if (path === '/ml-predict' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const cached = await env.ALERTS.get('ml_preds:all');
      if (!cached) return json({ error: 'No cached prediction', symbol }, 404);
      const entry = (JSON.parse(cached) as Record<string, any>)[symbol];
      if (!entry) return json({ error: 'No cached prediction', symbol }, 404);
      // Attach display-ready big-move risk (bucket + x-base multiple) so clients don't
      // each hardcode the thresholds. Raw bigMoveProb stays for back-compat.
      //
      // CALIBRATED ML (2026-08-26). `probability` is the RAW model output, but every gate keys on
      // the LIVE-CALIBRATED value (`prompt.ts` Phase C10), and the two have drifted apart: the live
      // base rate runs ~58% against v14's 50.5% training base, so the PAV curve lifts raw upward.
      // Measured 2026-08-21: the auto-FLAT at calibrated 50 corresponds to raw < 30.3%.
      //
      // The app was showing `probability` while the app's own decision used the calibrated number,
      // so a user seeing "ML 31" next to a permitted setup had no way to reconcile the two — the
      // display and the decision were on different scales. Both now ship, explicitly named.
      let calibrated: number | null = null;
      try {
        const c = await fetchMlCalibration(env, entry.probability, !!entry.isCrypto);
        calibrated = c.calibratedMlWin;
      } catch { /* display-only; a calibration failure must not 500 the prediction */ }
      return json({
        ...entry,
        bigMove: tailRiskInfo(entry.bigMoveProb),
        probabilityCalibrated: calibrated,
        gatedOn: calibrated != null ? 'calibrated' : 'raw',
      });
    }

    // Phase 1: HAR-RV expected-range forecast (direction-agnostic). No LLM, lightweight —
    // powers the "Expected 24h range" UI line independent of a full analysis. Crypto-only.
    if (path === '/vol' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const isCrypto = symbol.endsWith('USDT');
      if (!isCrypto) return json({ error: 'Vol forecast is crypto-only for now', symbol }, 400);
      try {
        const [closes, live] = await Promise.all([fetchFapiCloses(symbol, 750), fetchLivePrice(symbol, true).catch(() => null)]);
        const price = live ?? closes[closes.length - 1];
        if (!price) return json({ error: 'No price', symbol }, 404);
        const vf = forecastVol(closes, true, price);
        if (!vf) return json({ error: 'Insufficient history for vol forecast', symbol }, 404);
        return json({ symbol, price, ...vf, ts: Date.now() });
      } catch (e) {
        return json({ error: 'Vol forecast failed', symbol, detail: String(e) }, 500);
      }
    }

    // Phase 2+3: position risk calculator — stop quality (noise-hit), VaR/ES (fat-tail),
    // liquidation distance, fee-aware breakeven. Combines the live 24h vol σ with a
    // user-supplied position. Direction-agnostic. Crypto-only (needs the vol forecast).
    if (path === '/risk' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol || !symbol.endsWith('USDT')) return json({ error: 'crypto symbol required' }, 400);
      const num = (k: string) => { const v = parseFloat(url.searchParams.get(k) || ''); return isFinite(v) ? v : undefined; };
      try {
        const [closes, live] = await Promise.all([fetchFapiCloses(symbol, 750), fetchLivePrice(symbol, true).catch(() => null)]);
        const price = live ?? closes[closes.length - 1];
        if (!price) return json({ error: 'No price', symbol }, 404);
        const vf = forecastVol(closes, true, price);
        const mult = bandMultipliers('24h');
        if (!vf || !mult) return json({ error: 'Insufficient history', symbol }, 404);
        const sigma = vf.horizons['24h'].sigma;
        const entry = num('entry') ?? price;
        const risk = positionRisk({
          entry, stop: num('stop'), positionValue: num('size') ?? 0,
          leverage: num('leverage'), dir: (url.searchParams.get('dir') as 'long' | 'short') ?? 'long',
          venue: url.searchParams.get('venue') ?? undefined,
        }, sigma, mult);
        return json({ symbol, price, entry, horizon: '24h', range: vf.horizons['24h'], risk, ts: Date.now() });
      } catch (e) {
        return json({ error: 'Risk calc failed', symbol, detail: String(e) }, 500);
      }
    }

    // Phase 5: current risk states for a symbol (cron-cached, no LLM). Powers state chips.
    if (path === '/risk-states' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const cached = await env.ALERTS.get('risk_states:all');
      const all = cached ? JSON.parse(cached) as Record<string, any> : {};
      return json({ symbol, ...(all[symbol] ?? { names: [], high: [], detail: {} }), ts: Date.now() });
    }

    // Phase 7: portfolio correlation — concentration risk across a watchlist. 90d daily-return
    // pairwise correlations + effective independent positions + β to benchmark (BTC for crypto).
    if (path === '/correlation' && request.method === 'GET') {
      const raw = (url.searchParams.get('symbols') || '').split(',').map(s => sanitizeSymbol(s)).filter(Boolean).slice(0, 15);
      if (raw.length < 2) return json({ error: 'need ≥2 symbols' }, 400);
      try {
        const results = await Promise.all(raw.map(async s => {
          const c = await fetchBinanceKlines(s!, '1d', 90);
          return [s!, c.map(k => k.close)] as [string, number[]];
        }));
        const closesBySymbol: Record<string, number[]> = {};
        for (const [s, closes] of results) if (closes.length >= 10) closesBySymbol[s] = closes;
        const benchmark = raw.includes('BTCUSDT') ? 'BTCUSDT' : raw.find(s => s!.endsWith('USDT')) ? raw.find(s => s!.endsWith('USDT'))! : raw[0]!;
        const report = correlationReport(closesBySymbol, benchmark);
        if (!report) return json({ error: 'insufficient data' }, 404);
        return json({ ...report, ts: Date.now() });
      } catch (e) {
        return json({ error: 'correlation failed', detail: String(e) }, 500);
      }
    }

    // Full display indicators across daily/4H/1H — the shared analysis brain (no LLM). Both
    // the web app and (Phase 4) iOS render from this single implementation. crossAsset +
    // derivatives default to 0 here; /full-analysis supplies them for exact daily-crypto bias.
    if (path === '/indicators' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const isCrypto = symbol.endsWith('USDT');
      try {
        const [{ daily, fourH, oneH }, livePrice] = await Promise.all([
          fetchAllTimeframesCached(env, symbol, isCrypto),
          fetchLivePrice(symbol, isCrypto).catch(() => null),
        ]);
        if (!daily.length) return json({ error: 'No candles', symbol }, 404);
        return json({
          symbol, isCrypto, timestamp: Date.now(), livePrice,
          daily: computeFullIndicators(daily as FullCandle[], { timeframe: '1d', label: 'Daily', isCrypto }),
          fourH: fourH.length ? computeFullIndicators(fourH as FullCandle[], { timeframe: '4h', label: '4H', isCrypto }) : null,
          oneH: oneH.length ? computeFullIndicators(oneH as FullCandle[], { timeframe: '1h', label: '1H', isCrypto }) : null,
        });
      } catch (e) {
        return json({ error: `Indicator compute failed: ${e}`, symbol }, 502);
      }
    }

    // Market data bundle — the parsed enrichment (no LLM, no indicators) that powers the web
    // app's Market tab: derivatives positioning, spot pressure, sentiment, cross-asset, macro,
    // Fear & Greed. Reuses the same enrichment.ts builders /full-analysis uses. All best-effort
    // + parallel; crypto-only fields are null for stocks.
    if (path === '/market' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const isCrypto = symbol.endsWith('USDT');
      const [deriv, spotPressure, sentiment, crossAsset, macro, fearGreed, economicEvents, stock] = await Promise.all([
        isCrypto ? fetchDerivativesEnrichment(env, symbol).catch(() => null) : Promise.resolve(null),
        isCrypto ? fetchSpotPressureEnrichment(symbol).catch(() => null) : Promise.resolve(null),
        isCrypto ? fetchSentimentEnrichment(env, symbol).catch(() => null) : Promise.resolve(null),
        isCrypto ? fetchCrossAssetEnrichment().catch(() => null) : Promise.resolve(null),
        fetchMacroEnrichment(env).catch(() => null),
        isCrypto ? fetchFearGreed().catch(() => null) : Promise.resolve(null),
        fetchEconomicEvents(Date.now()).catch(() => []),
        !isCrypto ? fetchStockEnrichment(env, symbol).catch(() => null) : Promise.resolve(null),
      ]);
      return json({
        symbol, isCrypto, timestamp: Date.now(),
        derivatives: deriv?.derivatives ?? null, positioning: deriv?.positioning ?? null,
        spotPressure, sentiment, crossAsset, macro, fearGreed, economicEvents,
        stockInfo: stock?.stockInfo ?? null, stockSentiment: stock?.stockSentiment ?? null,
      });
    }

    // Full analysis — the shared brain end-to-end: candles → indicators → STATEFUL prompt
    // (buildUserPrompt, KV-backed regime/kill-duration/nakedPOC state) → LLM via the AI Gateway
    // → parsed setups. Both the web app and (Phase 4) iOS call this instead of building the
    // prompt client-side. v1 supplies the ML overlay + outcome history; richer enrichment
    // (derivatives/sentiment/macro/stockInfo) is layered in next — all optional in the builder.
    if (path === '/full-analysis' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const limited = await checkRateLimit(env, `analyze:${deviceId}`, RATE_LIMIT_ANALYZE);
      if (limited) return json({ error: 'Rate limited. Max 30 analyses per hour.' }, 429);

      let body: any = {};
      try { body = await request.json(); } catch { /* allow empty body; symbol may be in query */ }
      const symbol = sanitizeSymbol(body.symbol || url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const isCrypto = symbol.endsWith('USDT');

      try {
        const r = await runFullAnalysisCore(env, symbol, isCrypto, body, deviceId);
        return r.ok ? json(r.result) : json({ error: r.error, symbol }, r.status);
      } catch (e) {
        return json({ error: `Full analysis failed: ${e}`, symbol }, 500);
      }
    }

    // Fire-and-forget analysis: mint a jobId, run the (~30-90s) pipeline DETACHED on the box's Node
    // event loop (which keeps it alive after this response returns — no ctx.waitUntil needed since
    // the box is a persistent process, not a Worker isolate), and immediately return {jobId}. The
    // phone can lock its screen / background the app without killing the analysis; it polls
    // /full-analysis/result and, as a backstop, gets an APNs "ready" push. This is the permanent fix
    // for "analysis fails when the screen turns off mid-call".
    if (path === '/full-analysis/async' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const limited = await checkRateLimit(env, `analyze:${deviceId}`, RATE_LIMIT_ANALYZE);
      if (limited) return json({ error: 'Rate limited. Max 30 analyses per hour.' }, 429);

      let body: any = {};
      try { body = await request.json(); } catch { /* allow empty body */ }
      const symbol = sanitizeSymbol(body.symbol || url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const isCrypto = symbol.endsWith('USDT');
      const jobId = crypto.randomUUID();
      const jobKey = `analysis_job:${jobId}`;
      // deviceId is stored so /full-analysis/result can verify ownership — without it, any valid
      // token + a leaked jobId UUID could read another device's analysis.
      await env.ALERTS.put(jobKey, JSON.stringify({ status: 'pending', symbol, createdAt: Date.now(), deviceId }), { expirationTtl: 3600 });

      // Detached: continues on the event loop after we respond.
      void (async () => {
        const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
        try {
          const r = await runFullAnalysisCore(env, symbol, isCrypto, body, deviceId);
          const done = r.ok
            ? { status: 'done', symbol, result: r.result, finishedAt: Date.now(), claimed: false, deviceId }
            : { status: 'error', symbol, error: r.error, code: r.status, finishedAt: Date.now(), claimed: false, deviceId };
          await env.ALERTS.put(jobKey, JSON.stringify(done), { expirationTtl: 3600 });

          // APNs backstop. Wait a few seconds first: if the app is in the foreground and polling, its
          // GET /full-analysis/result marks the job `claimed`, and we suppress the push (no redundant
          // banner). If the screen is locked (poll suspended), it stays unclaimed → the push fires and
          // the user gets the Bottom Line + a tap-to-open. Best-effort throughout.
          await sleep(5000);
          try {
            const cur = await env.ALERTS.get(jobKey);
            const claimed = cur ? (JSON.parse(cur).claimed === true) : true;
            const pushToken = claimed ? null : await getPushToken(env, deviceId);
            if (pushToken) {
              const title = r.ok ? `${symbol} analysis ready` : `${symbol} analysis failed`;
              let bodyTxt = 'Tap to view';
              if (r.ok) {
                const bl = String(r.result?.analysis || '').match(/##\s*Bottom Line\s*\n([^\n]+)/i);
                if (bl) bodyTxt = bl[1].trim().slice(0, 160);
              } else { bodyTxt = r.error || 'Try again'; }
              await sendAPNs(env, pushToken, title, bodyTxt);
            }
          } catch { /* push best-effort */ }
        } catch (e) {
          await env.ALERTS.put(jobKey, JSON.stringify({ status: 'error', symbol, error: `${e}`, finishedAt: Date.now(), claimed: false, deviceId }), { expirationTtl: 3600 }).catch(() => {});
        }
      })();

      return json({ jobId, status: 'pending', symbol });
    }

    // Poll an async analysis job. Returns {status: pending|done|error, result?|error?}. The first
    // time it returns a finished job it flips `claimed` so the completion push is suppressed (the app
    // is clearly foregrounded and watching).
    if (path === '/full-analysis/result' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const jobId = url.searchParams.get('jobId') || '';
      if (!/^[a-f0-9-]{16,64}$/i.test(jobId)) return json({ error: 'Bad jobId' }, 400);
      const raw = await env.ALERTS.get(`analysis_job:${jobId}`);
      if (!raw) return json({ status: 'expired' }, 404);
      const job = JSON.parse(raw);
      // Ownership: a job is only readable by the device that started it (jobs created before
      // this check carry no deviceId — allowed through for back-compat during rollout).
      if (job.deviceId && job.deviceId !== deviceId) return json({ status: 'expired' }, 404);
      // Stuck-pending: a process restart mid-job strands the record at 'pending' until the 1h
      // KV TTL — the client would poll "pending" forever. Past 10 min, report it as failed so
      // the client can restart cleanly.
      if (job.status === 'pending' && Date.now() - (job.createdAt ?? 0) > 10 * 60_000) {
        return json({ status: 'error', symbol: job.symbol, error: 'Analysis job lost (server restarted) — retry' });
      }
      if ((job.status === 'done' || job.status === 'error') && job.claimed !== true) {
        job.claimed = true;
        await env.ALERTS.put(`analysis_job:${jobId}`, JSON.stringify(job), { expirationTtl: 3600 }).catch(() => {});
      }
      return json(job);
    }

    // Serves the result of a server-side auto-analysis (`runAutoAnalysis` caches it under
    // `autoanalysis:<symbol>`, 1h TTL) so tapping the push shows the analysis that PRODUCED the push
    // instead of paying for a second identical LLM run. Added 2026-07-24: the cache had been written
    // since 2026-07-14 with no endpoint and no reader, so it was pure waste — the app always re-ran.
    // Shape matches /full-analysis exactly (analysis/setups/ml/bias) so the client reuses one
    // decoder; `at` is added for the caller's own freshness check. Read-only — no claim/delete, so a
    // failed client decode can't lose the result; the client tracks what it has consumed locally.
    if (path === '/auto-analysis' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const raw = await env.ALERTS.get(`autoanalysis:${symbol}`);
      if (!raw) return json({ error: 'No cached auto-analysis' }, 404);
      try {
        const blob = JSON.parse(raw);
        if (!blob?.result?.analysis) return json({ error: 'No cached auto-analysis' }, 404);
        return json({ ...blob.result, at: blob.at ?? null });
      } catch {
        return json({ error: 'No cached auto-analysis' }, 404);
      }
    }

    // Why am I not getting notified? Answers it with the cron's OWN recorded decisions rather than
    // a re-derivation, and adds the per-device gates the symbol pass can't see (push token, claim,
    // autorun guard). Every remaining hypothesis becomes an observation.
    if (path === '/notify-debug' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const pushToken = await getPushToken(env, deviceId);
      let symbolGates: Record<string, any> = {};
      try { const raw = await env.ALERTS.get('notify_debug:all'); if (raw) symbolGates = JSON.parse(raw); } catch { /* none yet */ }

      // The device's synced watchlist — the trigger loop iterates exactly this, so an empty list
      // means zero notifications regardless of how good the signals are.
      let watchlist: string[] = [];
      try {
        const rows = await env.DB.prepare('SELECT symbol FROM watchlist WHERE device_id = ?').bind(deviceId).all();
        watchlist = (rows.results || []).map((r: any) => r.symbol);
      } catch { /* table may be empty */ }

      const filter = sanitizeSymbol(url.searchParams.get('symbol'));
      const symbols = filter ? [filter] : (watchlist.length ? watchlist : Object.keys(symbolGates));
      const perSymbol = await Promise.all(symbols.map(async (sym) => {
        const g = symbolGates[sym] ?? null;
        let claimExpiresAt: number | null = null;
        if (pushToken) {
          try {
            const row = await env.DB.prepare('SELECT expires_at FROM notif_claims WHERE push_token = ? AND symbol = ?')
              .bind(pushToken, sym).first() as any;
            claimExpiresAt = row?.expires_at ?? null;
          } catch { /* ignore */ }
        }
        const autorunHeld = !!(await env.ALERTS.get(`autorun:${sym}`).catch(() => null));
        const now = Date.now();
        const claimHeld = claimExpiresAt != null && claimExpiresAt > now;
        // The FIRST failing gate, in evaluation order — the actionable answer.
        let blockedBy: string | null = null;
        if (!pushToken) blockedBy = 'no_push_token';
        else if (!watchlist.length) blockedBy = 'empty_watchlist';
        else if (!g) blockedBy = 'symbol_not_processed_by_cron';
        // Print the CALIBRATED number — mlPasses is calibrated-based, so quoting raw here produced
        // arithmetic impossibilities like "ml_below_threshold (72% < 65%)".
        else if (!g.mlPasses) blockedBy = `ml_below_threshold (calibrated ${g.mlCalibrated}% < ${g.mlThreshold}%, raw ${g.ml}%)`;
        else if (!g.directionPasses) blockedBy = 'direction_ambiguous (bias vs Stoch conflict)';
        else if (g.envelopeFlat === true) blockedBy = `envelope_auto_flat (${(g.envelopeReasons || []).join(', ')})`;
        else if (claimHeld) blockedBy = 'notify_cooldown_held';
        else if (autorunHeld) blockedBy = 'autorun_guard_held';
        return {
          symbol: sym, ...(g ?? {}),
          claimHeld, claimExpiresInSec: claimHeld ? Math.round((claimExpiresAt! - now) / 1000) : 0,
          autorunHeld,
          blockedBy,   // null = every gate open; a push fires if the analysis yields a setup
        };
      }));

      return json({
        deviceId, hasPushToken: !!pushToken, watchlist,
        mlThresholdPct: ML_THRESHOLD * 100,
        note: 'blockedBy = the FIRST gate that would stop a notification. null means all gates open.',
        symbols: perSymbol,
      });
    }

    if (path === '/ml-models/version') {
      try {
        const cryptoMeta = await env.MODELS.head('crypto/model-v3.json');
        const stockMeta = await env.MODELS.head('stock/model-v3.json');
        return json({
          crypto: { version: 'v3', features: 51, trees: 150, uploaded: cryptoMeta?.uploaded?.toISOString() },
          stock: { version: 'v3', features: 51, trees: 150, uploaded: stockMeta?.uploaded?.toISOString() }
        });
      } catch {
        return json({ error: 'Model info unavailable' }, 502);
      }
    }

    // === Derivatives Proxy (Binance fapi via Smart Placement) ===
    if (path === '/derivatives') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:deriv:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 300_000) return json(parsed.data); // 5min cache
      }

      const FAPI = 'https://fapi.binance.com';
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

        const data = { premiumIndex: pi, fundingHistory: fh, openInterest: oi, oiHistory: oih, globalLS: gls, topTraderLS: ttls, takerRatio: tr };

        // Only cache if we got meaningful data (premiumIndex is required)
        if (pi) {
          await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 300 });
        }
        return json(data);
      } catch {
        return json({ error: 'Derivatives fetch failed' }, 502);
      }
    }

    // === Spot Pressure Proxy (Binance order book + trades) ===
    if (path === '/spot') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:spot:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 60_000) return json(parsed.data); // 1min cache
      }

      try {
        const [depth, trades] = await Promise.all([
          fetch(`${BINANCE_SPOT}/depth?symbol=${symbol}&limit=20`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${BINANCE_SPOT}/trades?symbol=${symbol}&limit=200`).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        const data = { depth, trades };
        if (depth) {
          await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 60 });
        }
        return json(data);
      } catch {
        return json({ error: 'Spot fetch failed' }, 502);
      }
    }

    // === Crypto Candles Proxy (Binance via Smart Placement + D1 archive) ===
    if (path === '/candles/crypto') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval') || '1d';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '300'), 1000);
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:candles:${symbol}:${interval}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < (interval === '1d' ? 3600_000 : interval === '4h' ? 900_000 : 300_000)) {
          return json(parsed.data);
        }
      }

      try {
        const resp = await fetch(`${BINANCE_SPOT}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const raw = await resp.json() as any[];
        const candles = raw.map((k: any) => ({
          time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
        }));
        const ttl = interval === '1d' ? 3600 : interval === '4h' ? 900 : 300;
        await env.ALERTS.put(cacheKey, JSON.stringify({ data: candles, timestamp: Date.now() }), { expirationTtl: ttl });
        // Archive to D1
        archiveCandlesToD1(env, symbol, interval, candles).catch(() => {});
        return json(candles);
      } catch {
        return json({ error: 'Candle fetch failed' }, 502);
      }
    }

    // === Sentiment Proxy (CoinGecko) ===
    if (path === '/sentiment') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      const cacheKey = `cache:sentiment:${symbol}`;
      const cached = await env.ALERTS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 600_000) return json(parsed.data); // 10min
      }

      try {
        const coinId = symbol.replace('USDT', '').toLowerCase();
        const ids: Record<string, string> = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', xrp: 'ripple', bnb: 'binancecoin', ada: 'cardano', doge: 'dogecoin', avax: 'avalanche-2', dot: 'polkadot', link: 'chainlink' };
        const geckoId = ids[coinId] || coinId;
        const resp = await fetch(`https://api.coingecko.com/api/v3/coins/${geckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`);
        if (!resp.ok) return json({ error: 'Upstream error' }, 502);
        const data = await resp.json();
        await env.ALERTS.put(cacheKey, JSON.stringify({ data, timestamp: Date.now() }), { expirationTtl: 600 });
        return json(data);
      } catch {
        return json({ error: 'Sentiment fetch failed' }, 502);
      }
    }

    // === Debug: dump cron features ===
    if (path === '/debug/features') {
      const sym = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
      const raw = await env.ALERTS.get(`debug:${sym.toLowerCase()}_features`);
      if (raw) return json(JSON.parse(raw));
      return json({ error: 'No debug data yet' });
    }

    // === One-shot admin: backfill 1 year of derivatives history for a single crypto symbol ===
    // Only callable from the Mac (X-App-ID gate already filters non-app traffic). Used by
    // ml-training/backfill_derivatives.py since Binance fapi geo-blocks US IPs but the
    // Cloudflare worker reaches it fine from non-US edge nodes.
    if (path === '/debug/backfill-derivatives') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      // Clamped to [1, 400]: unclamped, days=10000000 meant ~340k paginated Binance windows ×5
      // endpoints through the VPN + unbounded D1 writes on a request thread (DoS lever). Binance
      // derivatives history only goes back ~30 days for most futures/data endpoints anyway.
      const days = Math.min(400, Math.max(1, parseInt(url.searchParams.get('days') || '365') || 365));
      const FAPI = 'https://fapi.binance.com';
      const BUCKET_MS = 4 * 3600 * 1000;
      const endMs = Date.now();
      const startMs = endMs - days * 86400 * 1000;

      // Bucket-aligned aggregator: bucketSec → field-map
      const buckets: Map<number, Record<string, number | null>> = new Map();
      const get = (ts: number) => {
        const k = Math.floor(ts / BUCKET_MS) * BUCKET_MS / 1000;  // sec
        if (!buckets.has(k)) {
          buckets.set(k, {
            funding_rate: null, open_interest: null, long_percent: null,
            taker_ratio: null, top_trader_long_pct: null,
            taker_buy_vol: null, taker_sell_vol: null,
          });
        }
        return buckets.get(k)!;
      };

      // 1) Funding rate (8h cadence — average to 4h bucket)
      const fundingRates: Map<number, number[]> = new Map();
      let curStart = startMs;
      while (curStart < endMs) {
        const r = await fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${curStart}&limit=1000`);
        if (!r.ok) break;
        const data = await r.json() as Array<{ fundingTime: number; fundingRate: string }>;
        if (!data.length) break;
        for (const d of data) {
          const k = Math.floor(d.fundingTime / BUCKET_MS) * BUCKET_MS / 1000;
          if (!fundingRates.has(k)) fundingRates.set(k, []);
          fundingRates.get(k)!.push(parseFloat(d.fundingRate));
        }
        const lastTs = Math.max(...data.map(d => d.fundingTime));
        if (lastTs <= curStart) break;
        curStart = lastTs + 1;
        if (data.length < 1000) break;
      }
      for (const [k, rates] of fundingRates) {
        get(k * 1000).funding_rate = rates.reduce((a, b) => a + b, 0) / rates.length;
      }

      // Helper: paginated 4h fetch. Binance /futures/data/* endpoints cap at 30 days per request,
      // so we walk back in 30-day windows providing explicit startTime + endTime.
      const WINDOW_DAYS = 29;  // 1 day buffer under the 30-day cap
      const WINDOW_MS = WINDOW_DAYS * 86400 * 1000;
      async function paginate4h(path: string): Promise<Array<{ timestamp: number; [k: string]: any }>> {
        const out: any[] = [];
        let winEnd = endMs;
        while (winEnd > startMs) {
          const winStart = Math.max(startMs, winEnd - WINDOW_MS);
          const url = `${FAPI}${path}?symbol=${symbol}&period=4h&startTime=${winStart}&endTime=${winEnd}&limit=500`;
          const r = await fetch(url);
          if (!r.ok) break;
          const data = await r.json() as any[];
          if (data.length) out.push(...data);
          if (winStart <= startMs) break;
          winEnd = winStart - 1;
        }
        return out;
      }

      // 2) Open interest history
      for (const d of await paginate4h('/futures/data/openInterestHist')) {
        const v = parseFloat(d.sumOpenInterestValue || d.sumOpenInterest || '0');
        if (v) get(+d.timestamp).open_interest = v;
      }
      // 3) Global long/short account ratio
      for (const d of await paginate4h('/futures/data/globalLongShortAccountRatio')) {
        const v = parseFloat(d.longAccount || '0');
        if (v) get(+d.timestamp).long_percent = v * 100;
      }
      // 4) Top trader long/short (smart money)
      for (const d of await paginate4h('/futures/data/topLongShortPositionRatio')) {
        const v = parseFloat(d.longAccount || '0');
        if (v) get(+d.timestamp).top_trader_long_pct = v * 100;
      }
      // 5) Taker buy/sell ratio + volumes
      for (const d of await paginate4h('/futures/data/takerlongshortRatio')) {
        const slot = get(+d.timestamp);
        slot.taker_ratio = parseFloat(d.buySellRatio || '0') || null;
        slot.taker_buy_vol = parseFloat(d.buyVol || '0') || null;
        slot.taker_sell_vol = parseFloat(d.sellVol || '0') || null;
      }

      // Insert into D1 in batches of 50 (D1 batch limit)
      let inserted = 0;
      const entries = Array.from(buckets.entries())
        .filter(([_, f]) => Object.values(f).some(v => v !== null))
        .sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < entries.length; i += 50) {
        const batch = entries.slice(i, i + 50);
        try {
          await env.DB.batch(batch.map(([ts, f]) => env.DB.prepare(
            'INSERT OR REPLACE INTO derivatives_history (symbol, timestamp, funding_rate, open_interest, long_percent, taker_ratio, top_trader_long_pct, taker_buy_vol, taker_sell_vol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(symbol, ts, f.funding_rate, f.open_interest, f.long_percent, f.taker_ratio, f.top_trader_long_pct, f.taker_buy_vol, f.taker_sell_vol)));
          inserted += batch.length;
        } catch (e) {
          // continue on partial failure
        }
      }
      return json({ symbol, buckets_total: buckets.size, inserted, days });
    }

    // === Dark Pool (FINRA RegSHO short sale volume) ===
    // Unauth'd cache read — IP-rate-limited so an enumerator can't strip-mine the
    // watchlist signal by hammering this endpoint.
    if (path === '/darkpool') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const dpLimited = await checkRateLimit(env, `darkpool-ip:${ip}`, 60, 60);
      if (dpLimited) return json({ error: 'Rate limited' }, 429);
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const dpCached = await env.ALERTS.get('darkpool:latest');
      if (dpCached) {
        const data = JSON.parse(dpCached) as Record<string, { ratio: number; zscore: number }>;
        if (data[symbol]) return json(data[symbol]);
      }
      return json({ ratio: 0.5, zscore: 0 });
    }

    // === D1 Candle History (permanent archive — for backtest/optimizer) ===
    if (path === '/history' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const interval = url.searchParams.get('interval') || '1d';
      const start = url.searchParams.get('start'); // Unix ms
      const end = url.searchParams.get('end');     // Unix ms
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      let query = 'SELECT timestamp, open, high, low, close, volume FROM candles WHERE symbol = ? AND interval = ?';
      const params: any[] = [symbol, interval];
      if (start) { query += ' AND timestamp >= ?'; params.push(parseInt(start)); }
      if (end) { query += ' AND timestamp <= ?'; params.push(parseInt(end)); }
      query += ' ORDER BY timestamp ASC LIMIT 100000';

      const rows = await env.DB.prepare(query).bind(...params).all();
      return json({ count: rows.results.length, candles: rows.results });
    }

    // Upload candles to D1 archive (from app backtest/stitching). Auth-gated by the
    // global gate above; the per-device rate limit caps abuse from a compromised token.
    if (path === '/history' && request.method === 'POST') {
      // 5 uploads / 5 min / device — generous for backtest runs, tight enough to bound
      // D1 write amplification from a single bad actor.
      const uploadLimited = await checkRateLimit(env, `history-upload:${deviceId}`, 5, 300);
      if (uploadLimited) return json({ error: 'Upload rate limited' }, 429);
      try {
        const body = await request.json() as { symbol: string; interval: string; candles: any[] };
        if (!body.symbol || !body.interval || !body.candles?.length) return json({ error: 'Missing fields' }, 400);
        const symbol = body.symbol.replace(/[^a-zA-Z0-9.^-]/g, '').substring(0, 20);
        const interval = body.interval;
        const candles = body.candles.slice(0, 5000); // Cap at 5000 per upload

        // Batch insert (50 at a time, D1 limit)
        let inserted = 0;
        for (let i = 0; i < candles.length; i += 50) {
          const batch = candles.slice(i, i + 50);
          try {
            await env.DB.batch(
              batch.map((c: any) =>
                env.DB.prepare(
                  'INSERT OR IGNORE INTO candles (symbol, interval, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(symbol, interval, c.time || c.timestamp, c.open, c.high, c.low, c.close, c.volume)
              )
            );
            inserted += batch.length;
          } catch { /* skip batch on error */ }
        }
        return json({ ok: true, inserted, total: candles.length });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }

    // === Trade Outcomes (D1) ===
    if (path === '/outcomes' && request.method === 'POST') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      try {
        const body = await request.json() as any;
        if (!body.symbol || !body.direction || !body.entry) return json({ error: 'Missing required fields' }, 400);
        // Rollout dedupe (2026-07-09): the server now resolves outcomes itself (tracked_setups),
        // but app builds from before the cutover still POST locally-resolved outcomes. A near-
        // duplicate (same device/symbol/direction/outcome, entry within 0.05%, last 3 days) is
        // acknowledged without inserting so the same trade isn't counted twice.
        try {
          const dupe = await env.DB.prepare(
            `SELECT id FROM trade_outcomes
             WHERE device_id = ? AND symbol = ? AND direction = ? AND outcome = ?
               AND ABS(entry_price - ?) <= ? * 0.0005
               AND opened_at >= datetime('now', '-3 days') LIMIT 1`
          ).bind(deviceId, body.symbol, body.direction, body.outcome || null, body.entry, body.entry).first();
          if (dupe) return json({ ok: true, deduped: true });
        } catch { /* dedupe is best-effort */ }
        await env.DB.prepare(
          `INSERT INTO trade_outcomes
           (device_id, symbol, direction, entry_price, stop_loss, tp1, tp2,
            ml_probability, daily_score, four_h_score, conviction, outcome, pnl_percent,
            notes, model_version, prompt_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          deviceId, body.symbol, body.direction, body.entry, body.stopLoss || 0,
          body.tp1 || 0, body.tp2 || null, body.mlProb || null,
          body.dailyScore || null, body.fourHScore || null,
          body.conviction || null, body.outcome || null,
          body.pnlPercent || null, body.notes || null, body.modelVersion || null,
          body.promptVersion || null
        ).run();
        return json({ ok: true });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }
    if (path === '/outcomes' && request.method === 'PUT') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      try {
        const body = await request.json() as any;
        if (!body.id) return json({ error: 'Missing outcome ID' }, 400);
        await env.DB.prepare(
          'UPDATE trade_outcomes SET outcome = ?, pnl_percent = ?, closed_at = ?, notes = ? WHERE id = ? AND device_id = ?'
        ).bind(body.outcome, body.pnlPercent || null, new Date().toISOString(), body.notes || null, body.id, deviceId).run();
        return json({ ok: true });
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
    }
    if (path === '/outcomes' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const symbol = url.searchParams.get('symbol');
      let query = 'SELECT * FROM trade_outcomes WHERE device_id = ?';
      const params: any[] = [deviceId];
      if (symbol) { query += ' AND symbol = ?'; params.push(symbol); }
      if (url.searchParams.get('model_version')) {
        query += ' AND model_version = ?';
        params.push(parseInt(url.searchParams.get('model_version')!));
      }
      if (url.searchParams.get('prompt_version')) {
        query += ' AND prompt_version = ?';
        params.push(url.searchParams.get('prompt_version')!);
      }
      if (url.searchParams.get('resolved') === 'true') {
        query += " AND outcome IS NOT NULL AND outcome NOT IN ('open', 'not_triggered')";
      }
      query += ' ORDER BY opened_at DESC LIMIT 100';
      const rows = await env.DB.prepare(query).bind(...params).all();
      return json(rows.results);
    }

    // === Tracked Setups (D1, server-resolved — 2026-07-09 thin-client cutover) ===
    // Full per-device lifecycle rows (setups + flats) for the iOS dashboard/active-trades UI.
    // The cron registers (at /full-analysis) and resolves these; iOS is a read-only display.
    if (path === '/tracked-setups' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 500);
      const result = await readTrackedSetups(env, deviceId, symbol, limit);
      return json(result);
    }

    // === Liquidations (D1, box websocket collector — 2026-07-10) ===
    // Per-symbol observed forced-liquidation aggregates + recent events. Sampled feed
    // (Binance caps forceOrder at <=1 event/s/symbol) — lower bounds, not exact totals.
    if (path === '/liquidations' && request.method === 'GET') {
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      const hours = Math.min(Math.max(1, parseInt(url.searchParams.get('hours') || '24')), 168);
      try {
        const since = Date.now() - hours * 3_600_000;
        const agg = await env.DB.prepare(
          `SELECT side, SUM(notional) AS usd, COUNT(*) AS n, MAX(notional) AS largest
           FROM liquidations WHERE symbol = ? AND ts >= ? GROUP BY side`
        ).bind(symbol, since).all();
        const recent = await env.DB.prepare(
          'SELECT ts, side, price, qty, notional FROM liquidations WHERE symbol = ? AND ts >= ? ORDER BY ts DESC LIMIT 20'
        ).bind(symbol, since).all();
        return json({ symbol, hours, aggregates: agg.results ?? [], recent: recent.results ?? [] });
      } catch {
        return json({ symbol, hours, aggregates: [], recent: [] });   // table not created yet
      }
    }

    // === Score History (D1) ===
    if (path === '/scores' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
      let query = 'SELECT symbol, daily_score, four_h_score, ml_probability, bias, notification_sent, timestamp FROM score_history WHERE device_id = ?';
      const params: any[] = [deviceId];
      if (symbol) { query += ' AND symbol = ?'; params.push(symbol); }
      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);
      const rows = await env.DB.prepare(query).bind(...params).all();
      return json(rows.results);
    }

    // === Notification History (D1) ===
    if (path === '/notifications' && request.method === 'GET') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const rows = await env.DB.prepare(
        'SELECT * FROM notifications WHERE device_id = ? ORDER BY sent_at DESC LIMIT ?'
      ).bind(deviceId, limit).all();
      return json(rows.results);
    }

    // === Performance Dashboard (D1) ===
    if (path === '/performance') {
      if (!deviceId) return json({ error: 'Missing device ID' }, 400);
      const summary = await env.DB.prepare(`
        SELECT
          symbol,
          COUNT(*) as total_trades,
          SUM(CASE WHEN outcome IN ('TP1', 'TP2') THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN outcome = 'STOPPED' THEN 1 ELSE 0 END) as losses,
          AVG(CASE WHEN outcome IN ('TP1', 'TP2') THEN 1.0 ELSE 0.0 END) * 100 as win_rate,
          AVG(pnl_percent) as avg_pnl,
          AVG(ml_probability) as avg_ml_prob,
          SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as open_trades
        FROM trade_outcomes
        WHERE device_id = ?
        GROUP BY symbol
      `).bind(deviceId).all();

      const overall = await env.DB.prepare(`
        SELECT
          COUNT(*) as total_trades,
          AVG(CASE WHEN outcome IN ('TP1', 'TP2') THEN 1.0 ELSE 0.0 END) * 100 as win_rate,
          AVG(pnl_percent) as avg_pnl
        FROM trade_outcomes
        WHERE device_id = ? AND outcome IS NOT NULL
      `).bind(deviceId).first();

      return json({ bySymbol: summary.results, overall });
    }

    // Historical track record of the RETIRED dual-gate direction model. The "~94.7% backtest
    // accuracy" was a DATA-LEAK ARTIFACT (2026-06-02 finding) — the live forward test resolved
    // ~coin-flip, the pUp head was retired, and no new signals are logged (logDirectionSignals
    // skips on pUp=null). This endpoint now serves the resolved rows as the honest
    // "direction models fail live" exhibit; the retracted baseline is no longer presented as a
    // reference number.
    if (path === '/direction-accuracy' && request.method === 'GET') {
      try {
        const overall = await env.DB.prepare(`
          SELECT
            COUNT(*) as resolved,
            SUM(correct) as correct,
            AVG(correct) * 100 as accuracy,
            SUM(CASE WHEN predicted_dir = 1 THEN 1 ELSE 0 END) as longs,
            SUM(CASE WHEN predicted_dir = -1 THEN 1 ELSE 0 END) as shorts
          FROM direction_signals WHERE resolved = 1
        `).first();
        const byConfidence = await env.DB.prepare(`
          SELECT
            CASE
              WHEN p_up >= 0.90 OR p_up <= 0.10 THEN '90+'
              WHEN p_up >= 0.80 OR p_up <= 0.20 THEN '80-90'
              ELSE '70-80'
            END as band,
            COUNT(*) as n,
            AVG(correct) * 100 as accuracy
          FROM direction_signals WHERE resolved = 1
          GROUP BY band ORDER BY band DESC
        `).all();
        // Accuracy split by predicted side. Directional models are often asymmetric
        // (e.g. shorts harder than longs in an up-drifting regime), and the holdout was
        // short-skewed — so pooled accuracy can mask a weak side. -1 = short, +1 = long.
        const byDirection = await env.DB.prepare(`
          SELECT predicted_dir, COUNT(*) as n, AVG(correct) * 100 as accuracy
          FROM direction_signals WHERE resolved = 1
          GROUP BY predicted_dir
        `).all();
        // Per-instrument breakdown — which symbols the model reads well vs poorly.
        // longs/shorts split per symbol too, so a symbol that's great short / weak long
        // is visible. Ordered by sample size so the most-evidenced symbols lead.
        const bySymbol = await env.DB.prepare(`
          SELECT symbol,
            COUNT(*) as n,
            SUM(correct) as correct,
            AVG(correct) * 100 as accuracy,
            SUM(CASE WHEN predicted_dir = 1 THEN 1 ELSE 0 END) as longs,
            SUM(CASE WHEN predicted_dir = 1 THEN correct ELSE 0 END) as long_correct,
            SUM(CASE WHEN predicted_dir = -1 THEN 1 ELSE 0 END) as shorts,
            SUM(CASE WHEN predicted_dir = -1 THEN correct ELSE 0 END) as short_correct
          FROM direction_signals WHERE resolved = 1
          GROUP BY symbol ORDER BY n DESC
        `).all();
        const pending = await env.DB.prepare(
          'SELECT COUNT(*) as n FROM direction_signals WHERE resolved = 0'
        ).first();
        // The open signals themselves — which symbols are being tracked + their predicted
        // direction, so the UI can show "what's live right now", not just a count.
        const pendingSignals = await env.DB.prepare(`
          SELECT symbol, fired_at, entry_price, p_up, predicted_dir, ml_win, resolve_at
          FROM direction_signals WHERE resolved = 0
          ORDER BY fired_at DESC LIMIT 50
        `).all();
        const recent = await env.DB.prepare(`
          SELECT symbol, fired_at, p_up, predicted_dir, ml_win, fwd_return, correct
          FROM direction_signals WHERE resolved = 1
          ORDER BY resolve_at DESC LIMIT 20
        `).all();
        return json({
          overall: overall ?? { resolved: 0, correct: 0, accuracy: null, longs: 0, shorts: 0 },
          byConfidence: byConfidence.results ?? [],
          byDirection: byDirection.results ?? [],
          bySymbol: bySymbol.results ?? [],
          pending: (pending?.n as number) ?? 0,
          pendingSignals: pendingSignals.results ?? [],
          recent: recent.results ?? [],
          backtestBaseline: null,   // RETRACTED — the 94.7% was a data-leak artifact (2026-06-02)
          retracted: true,
          retractionNote: 'The direction model was retired 2026-06-02: its backtest accuracy was a data-leak artifact and the live forward test resolved ~coin-flip. Rows here are the honest historical exhibit.',
        });
      } catch (e) {
        // Table not created yet (no cron has fired a signal) — return an empty shell.
        return json({ overall: { resolved: 0, accuracy: null }, byConfidence: [], byDirection: [], bySymbol: [], pending: 0, pendingSignals: [], recent: [], backtestBaseline: null, retracted: true });
      }
    }

    // Live calibration of the ML quality model: realized goodR rate by predicted-probability
    // bucket. If predicted-70% bars hit ~70% in the wild, the model is still honest; large
    // gaps = drift. Universe-wide, forward, out-of-sample. See ml_calibration logging/grading.
    // Headline feed state: what the prompt is actually seeing, plus per-feed health from the last
    // poll. `?force=1` runs a poll inline — the way to check egress from the BOX (gluetun) rather
    // than from a dev machine, which is the one thing that could make the whole feed a non-starter.
    if (path === '/news' && request.method === 'GET') {
      try {
        const nowMs = Date.now();
        if (url.searchParams.get('force') === '1') {
          const { inserted, pruned, health } = await pollNewsFeeds(env as any, nowMs);
          await env.ALERTS.put('news:health', JSON.stringify({ at: nowMs, inserted, pruned, health }), { expirationTtl: 86400 }).catch(() => {});
          return json({ forced: true, inserted, pruned, health });
        }
        const cached = await env.ALERTS.get('news:health').catch(() => null);
        const isCrypto = (url.searchParams.get('market') ?? 'crypto') === 'crypto';
        const prompt = await fetchRecentNews(env as any, { isCrypto, nowMs });
        return json({ lastPoll: cached ? JSON.parse(cached) : null, promptView: prompt });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // Cash-and-carry basis on Coinbase dated nano futures — the one strategy in this project that
    // needs no directional forecast (docs/research/funding-carry.md). READ-ONLY: public market data,
    // no orders, no trade-enabled credentials. `?fee=` overrides the per-side assumption (default
    // 0.0007 = the user's measured Coinbase Advanced 2 derivatives taker, futures legs only — i.e.
    // the COVERED form against BTC already held. Buying the spot leg costs 0.250%/side at the same
    // tier, which is 0.50% round trip and consumes most of a typical basis.)
    if (path === '/basis' && request.method === 'GET') {
      try {
        const nowMs = Date.now();
        const fee = Number(url.searchParams.get('fee') ?? '0.0007');
        const rows = await fetchBasisRows(nowMs);
        const opportunities = findBasisOpportunities(rows, 0.10, 1000, Number.isFinite(fee) ? fee : 0.0007);
        return json({
          at: nowMs,
          spot: { BTC: rows.find(r => r.underlying === 'BTC')?.spotPrice ?? null,
                  ETH: rows.find(r => r.underlying === 'ETH')?.spotPrice ?? null },
          contracts: rows.map(r => ({
            ...r,
            netAnnualized: netAnnualized(r.spotPrice, r.futuresPrice, r.daysToExpiry, fee),
          })),
          opportunities: opportunities.map(o => ({ productId: o.row.productId, netAnnual: o.netAnnual, reason: o.reason })),
          // The one way a correctly-hedged carry still loses: the legs are not cross-margined, so a
          // rally drains futures margin while the offsetting spot gain sits unreachable.
          marginNote: 'Coinbase overnight short margin ~28.9% -> liquidation on roughly a 29% rally unless funded',
        });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // Ranked trade opportunities from the Phase 1-5 trading pipeline (docs/research/trading-refactor.md).
    //
    // ADDITIVE AND READ-ONLY: this touches no cron behaviour, no notifications and no model serving.
    // The existing /full-analysis path is unchanged.
    //
    // ⚠️ PROVISIONAL, but no longer for the reason this comment used to give. A trained excursion
    // model HAS shipped (2026-08-24) and the crash overlay with it, so the curves are measured — the
    // SHORT head clears its bar and serves; the LONG head does not and degrades to the observed base
    // rate. What stays provisional is PROFITABILITY: ranking is regime-independent, the payoff is
    // not (1 of 5 rising-market periods). `caveat` carries that to every surface.
    if (path === '/opportunities' && request.method === 'GET') {
      try {
        const nowMs = Date.now();
        const equity = Number(url.searchParams.get('equity') ?? '25000');
        const symbols = (url.searchParams.get('symbols') ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT')
          .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);

        const preds = JSON.parse((await env.ALERTS.get('ml_preds:all')) ?? '{}');
        const assets: AssetInput[] = [];
        const closesByAsset: Record<string, number[]> = {};
        const unavailable: Array<{ asset: string; reasons: string[] }> = [];

        for (const sym of symbols) {
          const p = preds[sym];
          if (!p) { unavailable.push({ asset: sym, reasons: ['no cached prediction'] }); continue; }
          try {
            const isC = sym.endsWith('USDT');
            if (!isC) { unavailable.push({ asset: sym, reasons: ['vol model is crypto-only'] }); continue; }

            // THE BOOK MUST RESPECT THE SAME GUARDS THE ANALYSIS USES.
            //
            // Without this the two halves of the Now tab contradict each other: the book offered an
            // ETH SHORT while the AI on the same screen said do not enter. The AI was applying the
            // Conviction Envelope — chase into an extended trend, kill conditions, macro IMMINENT,
            // mixed biases below the calibrated gate — and the book was applying none of them.
            //
            // The envelope encodes validated guards; an EV number does not override them. So a
            // symbol the envelope would auto-FLAT is dropped here, carrying the envelope's own
            // reason so the card can say WHY rather than silently omitting it.
            const tfAll = await fetchAllTimeframesCached(env, sym, true);
            const flatReasons = await envelopePrecheck(
              env, sym, true, typeof p.probability === 'number' ? p.probability : 0,
              tfAll.daily, tfAll.fourH as any, tfAll.oneH as any, []);
            if (flatReasons && flatReasons.length) {
              unavailable.push({ asset: sym, reasons: [`analysis says stand aside: ${flatReasons.join(', ')}`] });
              continue;
            }

            // 800 bars, NOT the shared 300-bar cache. `forecastVol` needs comp_bars['30d'] = 720
            // one-hour bars for its 30-day component and returns null if ANY component is short --
            // with 300 bars every asset silently reported "no volatility forecast".
            const oneH = await fetchBinanceKlines(sym, '1h', 800);
            const closes = (oneH ?? []).map(k => k.close).filter(x => x > 0);
            if (closes.length < VOL_MIN_1H_BARS) {
              unavailable.push({ asset: sym,
                reasons: [`need ${VOL_MIN_1H_BARS} 1h bars for the 30d vol component, got ${closes.length}`] });
              continue;
            }
            const price = closes[closes.length - 1];
            const atrPct = p.features?.atrPercent;
            if (!(atrPct > 0)) { unavailable.push({ asset: sym, reasons: ['no ATR in cached features'] }); continue; }
            closesByAsset[sym] = closes;
            assets.push({
              asset: sym, closes1h: closes, price, atr: (atrPct / 100) * price,
              mlWin: typeof p.probability === 'number' ? p.probability : null,
              // The 110 serving features the excursion model reads. Without them the pipeline
              // falls back to measured base rates, whose EV is negative -- i.e. no trade.
              features: p.features && typeof p.features === 'object' ? p.features : undefined,
              // null defers to the crash model, which the service runs from these same features.
              // It is NOT "no overlay" — that was true before 2026-08-24 and the comment outlived it.
              crashProbability: null,
              // REAL 24h traded notional from the last 24 hourly bars, not a flat 50M placeholder.
              // With a constant, the liquidity cap was the same generous number for BTC and for a
              // thin alt, so it could never bind where it actually matters.
              liquidityUsd24h: oneH.slice(-24).reduce((sum, k) => sum + k.close * k.volume, 0),
              isCrypto: isC,
              dataTimestamp: p.timestamp ?? nowMs,
            });
          } catch (e) {
            unavailable.push({ asset: sym, reasons: [String(e)] });
          }
        }

        // A SYSTEMIC failure must not look like "nothing qualifies". The first live call to this
        // endpoint returned 200 with an empty book while every asset had thrown ReferenceError --
        // indistinguishable, from the outside, from a genuinely quiet market. If nothing was
        // scoreable AND every failure looks like a thrown error, say so loudly instead.
        const threw = unavailable.filter(u => u.reasons.some(r => /Error|error:/i.test(r)));
        if (assets.length === 0 && threw.length > 0 && threw.length === unavailable.length) {
          console.error(`[opportunities] SYSTEMIC failure: all ${threw.length} assets threw`, threw[0].reasons);
          return json({ error: 'opportunity pipeline failed for every asset', detail: threw.slice(0, 3) }, 500);
        }

        // REAL pairwise correlations from the 1h returns already fetched. Passing `{}` here made
        // `effectiveBets` compute n/(1+(n-1)*0) = n, so a book of five correlated crypto positions
        // reported "5 independent bets" — the precise opposite of what that number exists to say
        // (T7 measured crypto rho-bar at 0.62, which makes five positions ~1.5 real bets). It also
        // made the correlated-exposure limit unable to bind, since every lookup returned 0.
        const correlations = pairwiseCorrelations(closesByAsset);

        const result = computeOpportunities(
          assets, { equity, openNotionalByAsset: {}, correlations }, nowMs);

        // THE CLOSEST MISS IS THE MOST INSTRUCTIVE ROW ON A QUIET DAY, and it was being thrown away
        // by the display filter below. "Nothing qualifies" and "the best candidate missed the floor
        // by a cent" are very different messages, and only the second teaches what the floor is.
        // Cost of the round trip expressed in R, which is what makes it comparable to the edge.
        // Recomputed rather than plumbed through the candidate: it is one division, and the inputs
        // (entry, stop, the frozen structure) are all right here.
        const feeBurden = (c: { entryPrice: number; stopPrice: number }) => {
          const stopPct = Math.abs(c.entryPrice - c.stopPrice) / c.entryPrice * 100;
          return stopPct > 0 ? DEFAULT_STRUCTURE.roundTripPercent / stopPct : 0;
        };

        const shown = result.allocation.accepted
          .filter(a => a.candidate.payoff.expectedValueR >= MIN_DISPLAY_EV_R);
        const nearMiss = result.allocation.accepted
          .filter(a => a.candidate.payoff.expectedValueR < MIN_DISPLAY_EV_R)
          .sort((a, b) => b.candidate.payoff.expectedValueR - a.candidate.payoff.expectedValueR)[0];

        // Market-wide, not per-asset: drawing Fear & Greed on a row would fabricate a per-symbol
        // specificity the input does not have. First asset that carries it wins — they all read the
        // same index.
        const fearGreedRaw = symbols.map(s2 => preds[s2]?.features?.fearGreedIndex)
          .find((v: unknown) => typeof v === 'number' && Number.isFinite(v));

        return json({
          at: nowMs,
          provisional: true,
          caveat: PROVISIONAL_CAVEAT,
          model: excursionModelInfo(),
          modelVersion: result.modelVersion,
          equity,
          /** How many assets were looked at — the denominator every count on the screen needs. */
          scanned: symbols.length,
          /** The display floor a row must clear. Served so no client has to hardcode it. */
          floorR: MIN_DISPLAY_EV_R,
          /** Best candidate that scored but missed the floor, or null. See above. */
          nearMiss: nearMiss ? {
            asset: nearMiss.candidate.asset,
            direction: nearMiss.candidate.direction,
            expectedValueR: nearMiss.candidate.payoff.expectedValueR,
          } : null,
          fearGreed: typeof fearGreedRaw === 'number' ? fearGreedRaw : null,
          /**
           * The frozen structure every row shares. Served because the screen states these as
           * properties of the STRUCTURE, once, above the rows — and a client that hardcoded
           * "0.171%" would keep printing it after `DEFAULT_STRUCTURE` changed.
           */
          structure: {
            roundTripPercent: DEFAULT_STRUCTURE.roundTripPercent,
            targetR: DEFAULT_STRUCTURE.targetR,
            stopAtrMultiple: DEFAULT_STRUCTURE.stopAtrMultiple,
            holdingHorizonHours: DEFAULT_STRUCTURE.holdingHorizonHours,
          },
          opportunities: shown
            .map(a => ({
            asset: a.candidate.asset,
            direction: a.candidate.direction,
            directionAgnostic: result.directionAgnosticAssets.includes(a.candidate.asset),
            entry: a.candidate.entryPrice,
            stop: a.candidate.stopPrice,
            target: a.candidate.targetPrice,
            expectedValueR: a.candidate.payoff.expectedValueR,
            payoffAsymmetry: a.candidate.payoff.payoffAsymmetry,
            winProbability: a.candidate.payoff.winProbability,
            score: a.candidate.riskAdjustedScore,
            riskFraction: a.sizing.riskFraction,
            notionalFraction: a.sizing.notionalFraction,
            positionUsd: a.sizing.positionUsd,
            crashMultiplier: a.sizing.crashMultiplier,
            bindingConstraints: a.sizing.bindingConstraints,
            // THE SPLIT THE ROW HIDES AND THE DETAIL VIEW SHOWS. `expectedValueR` is already net,
            // and the fee is the term that decides most of these trades: 0.171% against a 2% stop
            // is 0.086R, larger than the entire edge. Both halves were computed inside
            // `netExpectedValueR` and discarded, so nothing could say what the fee actually cost.
            feeBurdenR: feeBurden(a.candidate),
            grossExpectedValueR: a.candidate.payoff.expectedValueR + feeBurden(a.candidate),
            // Three ways this ends, and their measured shares. "1 in 13 reach target" is the
            // sentence that makes a +0.07R average readable; the average alone reads as a wage.
            branches: payoffBranches(a.candidate.payoff.winProbability, a.candidate.payoff.payoffAsymmetry),
          })),
          totals: result.allocation.totals,
          crashWarnings: result.crashWarnings,
          crashReadings: result.crashReadings,
          crashModel: crashModelInfo(),
          skipped: [...result.skipped, ...unavailable],
        });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // Forward validation of the Conviction Envelope. Realised excursion by TIER and by SIDE, so the
    // direction split Phase 2 found four times over can eventually be checked in a window that is
    // NOT the 2022-2026 crypto bear every retrospective arm shares. Returns almost nothing for the
    // first few months, by construction.
    if (path === '/envelope-accuracy' && request.method === 'GET') {
      try {
        await ensureEnvelopeSignalsTable(env);
        const side = url.searchParams.get('side');
        const rows = await env.DB.prepare(
          `SELECT max_allowed, aligned_direction, COUNT(*) AS n,
                  AVG(fav_r) AS avg_fav_r, AVG(adv_r) AS avg_adv_r,
                  AVG(CASE WHEN fav_r >= 1.5 THEN 1.0 ELSE 0.0 END) AS good_r_rate
           FROM envelope_signals
           WHERE resolved = 1${side ? ' AND aligned_direction = ?' : ''}
           GROUP BY max_allowed, aligned_direction
           ORDER BY aligned_direction, max_allowed`
        ).bind(...(side ? [side] : [])).all();
        const pending = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM envelope_signals WHERE resolved = 0').first();
        return json({
          horizonHours: ENV_SIG_HORIZON_MS / 3600000,
          byTier: rows.results ?? [],
          pending: (pending as { n?: number } | null)?.n ?? 0,
          note: 'Forward-only. Every retrospective envelope arm was measured in one crypto-bear '
              + 'window where SHORT is the better side ungated, so mechanism could not be separated '
              + 'from regime. This accumulates the window that can. It says nothing until it has '
              + 'months of rows.',
        });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === '/ml-calibration' && request.method === 'GET') {
      try {
        // ?market=crypto|stock filters to one model's forward record AND returns `curve` —
        // the fitted live mapping (2026-08-21 PAV refit) the gates actually apply, in percent
        // units. No market param = legacy mixed-market buckets (iOS dashboard), no curve
        // (a mixed-market fit is meaningless — the gates always fit per market).
        const market = url.searchParams.get('market');
        const marketFilter = market === 'crypto' ? 'AND is_crypto = 1' : market === 'stock' ? 'AND is_crypto = 0' : '';
        const buckets = await env.DB.prepare(`
          SELECT
            CASE
              WHEN predicted_prob < 0.30 THEN '00-30'
              WHEN predicted_prob < 0.50 THEN '30-50'
              WHEN predicted_prob < 0.60 THEN '50-60'
              WHEN predicted_prob < 0.70 THEN '60-70'
              ELSE '70-85' END as bucket,
            COUNT(*) as n,
            AVG(predicted_prob) * 100 as predicted,
            AVG(good_r) * 100 as realized
          FROM ml_calibration WHERE resolved = 1 ${marketFilter}
          GROUP BY bucket ORDER BY bucket`).all();
        const overall = await env.DB.prepare(
          `SELECT COUNT(*) as resolved, SUM(CASE WHEN resolved=0 THEN 1 ELSE 0 END) as pending FROM ml_calibration`
        ).first();
        const pend = await env.DB.prepare(`SELECT COUNT(*) as n FROM ml_calibration WHERE resolved = 0 ${marketFilter}`).first();
        let curve: Array<{ x: number; y: number; n: number }> | null = null;
        if (market === 'crypto' || market === 'stock') {
          const fit = fitCalibrationCurve(await fetchLiveCalBuckets(env, market === 'crypto'));
          if (fit) curve = fit.map(p => ({ x: Math.round(p.x * 1000) / 10, y: Math.round(p.y * 1000) / 10, n: p.n }));
        }
        return json({ buckets: buckets.results ?? [], resolved: (overall?.resolved as number) ?? 0, pending: (pend?.n as number) ?? 0, ...(curve ? { curve } : {}) });
      } catch (e) {
        return json({ buckets: [], resolved: 0, pending: 0 });
      }
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    setProxyConfig(env);
    ctx.waitUntil(checkAllDeviceScores(env));
    ctx.waitUntil(archiveShortInterest(env));
    ctx.waitUntil(cleanupStaleDevices(env));
    ctx.waitUntil(pollNewsIfDue(env));
  },
};

// === Short Interest Archive ===
// Daily snapshot of Yahoo's `shortPercentOfFloat` and `shortRatio` (days to cover) per stock.
// Yahoo updates these values bi-weekly from FINRA filings; one fetch per day per symbol is enough.
// Idempotent via KV gate (short_arch:last_date) — first cron firing of each UTC day does the work,
// remaining ~1439 firings of that day skip after a single KV read.
const ARCHIVE_STOCKS = [
  // Mirrors STOCK_SYMBOLS in ml-training/calibrate_v11_stocks.py (159 symbols).
  'AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'CRM', 'NFLX', 'AMD',
  'ORCL', 'ADBE', 'INTC', 'CSCO',
  'NOW', 'INTU', 'CRWD', 'PANW', 'FTNT', 'SNOW', 'DDOG', 'NET', 'ZS', 'WDAY', 'TEAM', 'MDB',
  'AVGO', 'QCOM', 'MU', 'AMAT', 'LRCX', 'MRVL', 'TXN', 'KLAC', 'ON', 'MCHP',
  'PLTR', 'ROKU', 'SHOP', 'SNAP', 'COIN', 'RBLX',
  'BYND', 'GME',
  'UBER', 'ABNB', 'BKNG', 'DASH', 'PYPL', 'SPOT', 'F', 'GM',
  'JPM', 'GS', 'MS', 'BAC', 'WFC', 'BLK', 'SCHW',
  'AXP', 'C', 'COF', 'USB', 'PNC', 'CME', 'ICE', 'AIG',
  'UNH', 'LLY', 'ABBV', 'JNJ', 'PFE', 'MRK', 'TMO',
  'AMGN', 'BMY', 'ABT', 'MDT', 'DHR', 'ISRG', 'BSX', 'SYK', 'CVS', 'ELV',
  'REGN', 'VRTX', 'GILD', 'BIIB',
  'HD', 'MA', 'V', 'DIS', 'NKE', 'SBUX', 'MCD', 'WMT', 'COST',
  'LOW', 'TGT', 'TJX', 'CMG', 'MAR', 'HLT', 'MGM',
  'CAT', 'DE', 'BA',
  'HON', 'MMM', 'GE', 'EMR', 'ETN', 'ITW', 'PH',
  'XOM', 'OXY', 'FANG', 'CVX', 'SLB',
  'COP', 'EOG', 'PSX', 'VLO',
  'LMT', 'RTX', 'GD', 'NOC',
  'UNP', 'FDX', 'DAL',
  'T', 'VZ', 'CMCSA', 'TMUS', 'CHTR',
  'SPG', 'O',
  'AMT', 'EQIX', 'PLD', 'CCI', 'PSA',
  // ETFs are skipped — short interest doesn't apply meaningfully
];

async function archiveShortInterest(env: Env) {
  const today = new Date().toISOString().split('T')[0];
  const lastDate = await env.ALERTS.get('short_arch:last_date');
  if (lastDate === today) return;  // already archived today

  const auth = await getYahooCrumb(env);
  if (!auth) return;
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  const headers = { 'User-Agent': ua, 'Cookie': auth.cookie };
  const crumbParam = `&crumb=${encodeURIComponent(auth.crumb)}`;

  // Process in parallel batches of 25 to keep total fetch time well under cron CPU limits.
  let inserted = 0;
  for (let i = 0; i < ARCHIVE_STOCKS.length; i += 25) {
    const batch = ARCHIVE_STOCKS.slice(i, i + 25);
    const stmts: any[] = [];
    await Promise.all(batch.map(async (symbol) => {
      try {
        const r = await fetch(
          `${YAHOO_BASE}/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics${crumbParam}`,
          { headers }
        );
        if (!r.ok) return;
        const data = await r.json() as any;
        const stats = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
        const shortPct = stats?.shortPercentOfFloat?.raw;
        const shortRatio = stats?.shortRatio?.raw;
        if (shortPct == null && shortRatio == null) return;
        stmts.push(env.DB.prepare(
          'INSERT OR REPLACE INTO short_interest_history (symbol, date, short_pct_of_float, days_to_cover) VALUES (?, ?, ?, ?)'
        ).bind(symbol, today, shortPct ?? null, shortRatio ?? null));
      } catch { /* skip on error */ }
    }));
    if (stmts.length) {
      try {
        await env.DB.batch(stmts);
        inserted += stmts.length;
      } catch { /* partial-failure is OK */ }
    }
  }
  await env.ALERTS.put('short_arch:last_date', today);
  console.log(`[short_arch] ${today}: ${inserted}/${ARCHIVE_STOCKS.length} symbols archived`);
}

// === Input Validation ===
function sanitizeSymbol(input: string | null): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^a-zA-Z0-9.%^-]/g, '').substring(0, 20);
  return cleaned || null;
}

/** Constant-time string comparison to prevent timing side-channel attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

/** Validate and sanitize an alert object. Returns null if invalid. */

// === Rate Limiting ===
async function checkRateLimit(env: Env, key: string, limit: number, windowSec: number = 3600): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const rlKey = `rl:${key}:${bucket}`;
  const current = parseInt(await env.ALERTS.get(rlKey) || '0');
  if (current >= limit) return true;
  await env.ALERTS.put(rlKey, String(current + 1), { expirationTtl: windowSec * 2 });
  return false;
}



// === APNs ===
type APNsResult = 'sent' | 'unregistered' | 'failed';

const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';
const APNS_PROD = 'https://api.push.apple.com';
const APNS_ENV_TTL_SEC = 90 * 24 * 60 * 60;

async function sendAPNs(env: Env, deviceToken: string, title: string, body: string): Promise<APNsResult> {
  // Endpoint order. Historically this was ALWAYS sandbox-then-production, so every push to a
  // production token paid a guaranteed wasted round-trip to Apple before the real one — on the
  // notification path that's pure added latency, and the cron sends these in series.
  //
  // A token belongs to exactly one environment and cannot migrate: the APNs device token is derived
  // per aps-environment, so a debug→release rebuild yields a DIFFERENT token (and therefore a
  // different cache key). That makes "remember which endpoint worked for this token" safe — a
  // stale-wrong entry isn't reachable. We still keep the full fallback loop, so a cache miss, a KV
  // eviction, or an unexpected rejection just costs the old behaviour.
  //
  // Uncached tokens keep the original sandbox-first order: the first send for a new token pays the
  // double hop once, then every later send goes straight to the right endpoint.
  const envKey = `apns_env:${deviceToken}`;
  let cachedEnv: string | null = null;
  try { cachedEnv = await env.ALERTS.get(envKey); } catch { /* best-effort */ }
  const endpoints = cachedEnv === 'prod' ? [APNS_PROD, APNS_SANDBOX] : [APNS_SANDBOX, APNS_PROD];

  try {
    const jwt = await buildAPNsJWT(env);
    if (!jwt) { console.error('APNs: JWT build returned null'); return 'failed'; }

    let lastStatus: number | null = null;
    let lastBody = '';
    for (const endpoint of endpoints) {
      const resp = await fetch(`${endpoint}/3/device/${deviceToken}`, {
        method: 'POST',
        headers: {
          'authorization': `bearer ${jwt}`,
          'apns-topic': env.APNS_BUNDLE_ID || 'com.ludikure.CryptoLens',
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          aps: { alert: { title, body }, sound: 'default', badge: 1 },
        }),
      });

      if (resp.ok) {
        const which = endpoint === APNS_SANDBOX ? 'sandbox' : 'prod';
        console.log(`APNs sent via ${which}${cachedEnv === which ? ' (cached route)' : ''}`);
        // Remember the winning endpoint so the next push skips the dead hop. Only write on change,
        // to avoid a KV put on every single push.
        if (cachedEnv !== which) {
          await env.ALERTS.put(envKey, which, { expirationTtl: APNS_ENV_TTL_SEC }).catch(() => {});
        }
        return 'sent';
      }
      lastStatus = resp.status;
      lastBody = await resp.text();
      const env_ = endpoint.includes('sandbox') ? 'sandbox' : 'prod';
      console.error(`APNs ${env_} ${resp.status}: ${lastBody}`);
      // Only break on responses that conclusively describe the token itself — anything
      // else (transient 5xx, rate-limit 429, generic network failure surfaced as 500)
      // should still attempt the OTHER endpoint, since a token rejected by the wrong
      // environment for non-token reasons would otherwise be permanently stranded.
      // Conclusive token-level errors: 400 BadDeviceToken doesn't apply (it's the signal
      // that we're on the wrong environment — fall through), but 410 Unregistered, 403
      // InvalidProviderToken (key misconfig), and 413 PayloadTooLarge all describe the
      // request/token, not the endpoint, so retrying the other one is pointless.
      if (resp.status === 400 && lastBody.includes('BadDeviceToken')) continue;
      if (resp.status === 410 || resp.status === 403 || resp.status === 413) break;
      // Transient: try the other endpoint as a fallback. Worst case it fails the same way
      // and we surface that error to the caller.
      continue;
    }
    // 410 = token unregistered (uninstall, device wipe) → the caller cascade-deletes the device.
    // Only the last-tried endpoint is treated as authoritative: a 410 from the WRONG environment
    // would be meaningless, and since the cross-environment fallthrough only happens on 400
    // BadDeviceToken, any 410 we surface came from the endpoint that actually routes this token.
    // With the cached route above we now usually try that endpoint FIRST, which makes this
    // marginally more trustworthy than before, not less.
    return lastStatus === 410 ? 'unregistered' : 'failed';
  } catch (e) {
    console.error(`APNs send failed: ${e}`);
    return 'failed';
  }
}

// Cascade-delete every row tied to a device. Called when APNs returns 410 (token dead)
// or by the daily stale-device sweep. D1 doesn't enforce the watchlist FK, so we delete
// children explicitly. notif_claims is keyed by push_token, not device_id, so we look
// up the token first and delete by that.
async function deleteDevice(env: Env, deviceId: string) {
  const row = await env.DB.prepare('SELECT push_token FROM devices WHERE device_id = ?').bind(deviceId).first();
  const pushToken = (row?.push_token as string | null) ?? null;
  const stmts = [
    env.DB.prepare('DELETE FROM watchlist WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM score_history WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM notifications WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM alerts WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM devices WHERE device_id = ?').bind(deviceId),
  ];
  if (pushToken) {
    stmts.push(env.DB.prepare('DELETE FROM notif_claims WHERE push_token = ?').bind(pushToken));
  }
  await env.DB.batch(stmts);
  await env.ALERTS.delete(`device:${deviceId}`);
  await env.ALERTS.delete(`watchlist:${deviceId}`);
  console.log(`[cleanup] deleted device ${deviceId}`);
}

// Daily sweep: prune devices that haven't checked in for 30 days. Idempotent — KV-gated to
// run once per UTC day. iOS rotates device_id on auth recovery (see PushService.handleAuthFailure),
// orphaning the old D1 row immediately. Without this sweep those orphans accumulate forever
// and the per-cron device pass walks them all (one row per minute per orphan), wasting
// compute and writing dead score_history rows.
const STALE_DEVICE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function cleanupStaleDevices(env: Env) {
  const today = new Date().toISOString().split('T')[0];
  const lastDate = await env.ALERTS.get('cleanup:last_date');
  if (lastDate === today) return;

  const cutoffIso = new Date(Date.now() - STALE_DEVICE_AGE_MS).toISOString();
  const stale = await env.DB.prepare(
    'SELECT device_id FROM devices WHERE last_seen < ? OR last_seen IS NULL'
  ).bind(cutoffIso).all();
  for (const row of stale.results) {
    try {
      await deleteDevice(env, row.device_id as string);
    } catch (e) {
      console.log(`[cleanup] failed for ${row.device_id}: ${e}`);
    }
  }
  // Also expire stale notif_claims whose tokens no longer map to any device.
  await env.DB.prepare(
    'DELETE FROM notif_claims WHERE push_token NOT IN (SELECT push_token FROM devices WHERE push_token IS NOT NULL)'
  ).run();
  await env.ALERTS.put('cleanup:last_date', today, { expirationTtl: 86400 * 2 });
  console.log(`[cleanup] sweep complete: ${stale.results.length} stale devices removed`);
}

// Apple validates the JWT against `iat` and accepts tokens up to ~1h old. We cache for
// 50 minutes (well inside Apple's window) so a single cron tick that sends N notifications
// reuses one JWT instead of rebuilding (crypto.subtle.importKey + sign per send was the
// dominant per-notification cost). Process-local memory; cron isolates restart cleanly.
let cachedAPNsJWT: { jwt: string; expiresAt: number } | null = null;
const APNS_JWT_TTL_MS = 50 * 60 * 1000;

async function buildAPNsJWT(env: Env): Promise<string | null> {
  if (cachedAPNsJWT && Date.now() < cachedAPNsJWT.expiresAt) {
    return cachedAPNsJWT.jwt;
  }
  try {
    const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_PRIVATE_KEY: privateKeyB64 } = env;
    if (!keyId || !teamId || !privateKeyB64) return null;

    const privateKeyPem = atob(privateKeyB64);
    const pemContents = privateKeyPem.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
    const keyData = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

    const header = btoa(JSON.stringify({ alg: 'ES256', kid: keyId })).replace(/=/g, '');
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(JSON.stringify({ iss: teamId, iat: now })).replace(/=/g, '');
    const signingInput = `${header}.${payload}`;

    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const jwt = `${header}.${payload}.${sigB64}`;
    cachedAPNsJWT = { jwt, expiresAt: Date.now() + APNS_JWT_TTL_MS };
    return jwt;
  } catch {
    console.error('JWT build failed');
    return null;
  }
}

// === Server-Side Score Notifications ===

// Crypto symbols processed every cron pass for D1 archive coverage of derivatives,
// regardless of any device's watchlist. Matches the model's training universe.
const ARCHIVE_CRYPTO = [
  // Pre-2021
  'BTCUSDT', 'ETHUSDT', 'BCHUSDT', 'XRPUSDT', 'LTCUSDT', 'TRXUSDT', 'ETCUSDT', 'LINKUSDT', 'XLMUSDT', 'ADAUSDT',
  'XMRUSDT', 'DASHUSDT', 'ZECUSDT', 'XTZUSDT', 'BNBUSDT', 'ATOMUSDT', 'ONTUSDT', 'IOTAUSDT', 'BATUSDT', 'VETUSDT',
  'NEOUSDT', 'QTUMUSDT', 'IOSTUSDT', 'THETAUSDT', 'ALGOUSDT', 'ZILUSDT', 'KNCUSDT', 'ZRXUSDT', 'COMPUSDT', 'DOGEUSDT',
  'KAVAUSDT', 'BANDUSDT', 'RLCUSDT', 'SNXUSDT', 'DOTUSDT', 'YFIUSDT', 'CRVUSDT', 'TRBUSDT', 'RUNEUSDT', 'SUSHIUSDT',
  'EGLDUSDT', 'SOLUSDT', 'ICXUSDT', 'STORJUSDT', 'UNIUSDT', 'AVAXUSDT', 'ENJUSDT', 'KSMUSDT', 'NEARUSDT', 'AAVEUSDT',
  'FILUSDT', 'RSRUSDT', 'BELUSDT', 'AXSUSDT', 'SKLUSDT', 'GRTUSDT',
  // Post-2021
  'SANDUSDT', 'MANAUSDT', 'HBARUSDT', 'MATICUSDT', 'ICPUSDT', 'DYDXUSDT', 'GALAUSDT',
  'IMXUSDT', 'GMTUSDT', 'APEUSDT', 'INJUSDT', 'LDOUSDT', 'APTUSDT',
  'ARBUSDT', 'SUIUSDT', 'PENDLEUSDT', 'SEIUSDT', 'TIAUSDT', 'JUPUSDT', 'PEPEUSDT',
];

const ML_THRESHOLD = 0.65;            // on the CALIBRATED scale (2026-08-21, was 0.70): the live curve's
                                      // 60-70 band realizes ~66% and the honest PAV map only exceeds 70 at
                                      // raw >= ~79, which made 0.70 pass only a few bars a month. 0.65 looks
                                      // at the band the forward data says is worth looking at.
// COST/NOISE, stated accurately (the earlier "the setup gate bounds pushes" note was stale on
// arrival — 2026-08-08c made a DECLINED analysis send its own push, so the setup gate stopped
// bounding volume). What bounds it now: the 3.5h `notif_claims` claim and the 3.5h `autorun:<sym>`
// guard cap work at ~one LLM run per symbol per 3.5h (~6.8/day/symbol worst case), and a decline
// BELOW the mandate band is deferred silently rather than pushed — so the widened 65-69 band adds
// analysis coverage without adding "nothing to do" notifications.
const MANDATE_ML_PCT = 70;            // calibrated %, matches the prompt's mandate window floor

const NOTIFY_COOLDOWN_SEC = 3.5 * 60 * 60;
// Calibrated-ML floor for the entry-zone-reached push: one notch below ML_THRESHOLD, so a setup
// already approved at the gate isn't re-litigated at its entry touch — only a genuine collapse
// in quality since registration suppresses the push.
const ENTRY_ZONE_ML_FLOOR = ML_THRESHOLD - 0.10;
// Envelope-precheck memo (2026-08-21). `crossCandidate` is a LEVEL, so an eligible symbol re-ran
// computeFullIndicators x3 + a full buildUserPrompt EVERY minute — ~1,440/day per symbol for at
// most ~24 distinct input states, since the inputs only move on a bar close. MODULE-scoped so it
// spans cron passes (the box is a long-lived Node process; a pass-scoped map would never hit,
// each symbol being visited once per pass). Keyed on everything that can change the verdict:
// symbol + last 4H bar time + ML to 0.1%. A new bar or a moved ML mints a new key, so a stale
// verdict is unreachable by construction; the size cap just bounds memory on a long uptime.
const PRECHECK_MEMO_MAX = 512;
const precheckMemo = new Map<string, string[] | null>();
function precheckMemoSet(key: string, val: string[] | null) {
  if (precheckMemo.size >= PRECHECK_MEMO_MAX) {
    // Map preserves insertion order — drop the oldest half in one sweep (cheap, amortized).
    let i = 0; for (const k of precheckMemo.keys()) { precheckMemo.delete(k); if (++i >= PRECHECK_MEMO_MAX / 2) break; }
  }
  precheckMemo.set(key, val);
}
// How long a suppressed (deferred) cross stays armed before it's considered stale. Shared by the
// `notif_suppressed:all` blob, its prune sweep, and the per-symbol `notif_resuppress:<sym>` key so
// the three can't drift apart.
const SUPPRESS_EXPIRY_SEC = 24 * 60 * 60;

interface SymbolPrediction {
  symbol: string;
  isCrypto: boolean;
  mlProb: number;
  // mlProb mapped through the live calibration curve — the scale EVERY gate keys on since
  // 2026-08-21 (notify threshold, envelope, entry-zone push). Carried on the prediction so
  // downstream consumers can't accidentally compare a raw number against a calibrated
  // threshold, which is the "one quantity, two decisions, two values" bug class that caused
  // the missed Aug rally. Equals mlProb when the live curve is too thin to fit.
  notifyProb: number;
  dailyScore: number;
  // True iff the previous cron's mlProb was below ML_THRESHOLD and current is at/above.
  // The notification gate fires only on this rising edge, not on continued elevation —
  // a symbol that sits at 0.75 for hours pages once when it crossed up, not every cron.
  crossed: boolean;
  // Envelope precheck verdict for this tick (2026-07-11): true = the Conviction Envelope would
  // auto-FLAT an analysis right now — gate EVERY proactive push on it (ML cross, risk-state,
  // entry-zone). null = not evaluated this tick / precheck failed (fail open).
  envelopeFlat?: boolean | null;
  // Daily Stochastic RSI crossover direction (+1 = bullish cross, -1 = bearish cross,
  // 0 = no recent cross). Combined with biasAlignment as the notification direction
  // primitive via the union rule (bias OR Stoch, skip conflicts).
  dStochCross: number;
  // Bias alignment from per-timeframe scoring: 'aligned_bullish', 'aligned_bearish',
  // 'conflict', or 'neutral'. Used together with dStochCross to determine the notification
  // direction. Backtest (direction_primitive_sweep.py, 2022-2026): the union (bias OR
  // Stoch with conflict-skip) captured 12× more total R than bias-alone on stocks
  // and 1.9× on crypto top-10, while keeping per-trade EV nearly identical.
  biasAlignment: string;
  // Last 4H bar high/low/close — used by pending-setup entry-zone touch detection so
  // we don't re-fetch the price for each device's setup checks. The 4H high/low covers
  // any intra-bar touch of the entry level; close is for staleness gating.
  last4HHigh: number;
  last4HLow: number;
  /// Live tick, fetched ONLY for symbols with a live pending setup (typically 0-3). Null otherwise.
  /// Everything else in this struct is deliberately closed-bar (training parity); this is the one
  /// value that must be current, because whether an entry is reachable is a live-price question.
  livePrice: number | null;
  last4HClose: number;
  // ATR in price units (atrPercent × close / 100), used to define the entry-zone width
  // (default 0.3 × ATR around the entry price).
  atrPrice: number;
  // Calibrated P(up 24h) from the crypto direction head (null for stocks — no model).
  // Carried here so the dual-gate live-validation logger (logDirectionSignals) can read
  // it alongside mlProb + crossed without re-reading the KV blob.
  pUp: number | null;
  // Phase 5: discrete risk states this tick, and the validated-HIGH states that newly
  // appeared since last tick (transition-into-HIGH → notification trigger).
  riskStateNames: string[];
  newHighStates: string[];
}

/// Combine daily + 4H bias labels into the alignment string. Mirrors
/// alignFromBiases in scripts/scoring-bias.ts (kept inline so the worker src
/// doesn't depend on the scripts dir).
function biasAlignmentFromLabels(dailyBias: string, fourHBias: string): string {
  const dB = dailyBias.includes('Bullish');
  const dBr = dailyBias.includes('Bearish');
  const hB = fourHBias.includes('Bullish');
  const hBr = fourHBias.includes('Bearish');
  if (dBr && hBr) return 'aligned_bearish';
  if (dB && hB) return 'aligned_bullish';
  if ((dBr && hB) || (dB && hBr)) return 'conflict';
  return 'neutral';
}

/// Direction-gate bias alignment from the FAITHFUL iOS-port scorer (2026-08-21). The simplified
/// scoring.ts computeScore previously used here penalizes RSI>70 by 3 points against crypto's +1
/// price-position weight, so the harder a rally ran the more bearish it leaned: it scored the
/// Aug-2026 62k→80k BTC breakout as daily-BEARISH on the +7% breakout day (RSI 74) and Neutral
/// at RSI 84 — holding the notification direction gate closed for the entire move while
/// /indicators showed the user Bullish / Strong Bullish. Bias here now comes from the same
/// computeFullIndicators the app displays, so the gate and the screen agree by construction.
/// (crossAsset/derivatives inputs default 0, exactly like the /indicators endpoint.)
/// Exported for the fixture regression test on the real Aug-2026 tape.
export function notificationBiasAlignment(daily: FullCandle[], fourH: FullCandle[], isCrypto: boolean, symbol = '?'): string {
  try {
    const d = computeFullIndicators(daily as any, { timeframe: '1d', label: 'Daily', isCrypto });
    const h = fourH.length ? computeFullIndicators(fourH as any, { timeframe: '4h', label: '4H', isCrypto }) : null;
    return biasAlignmentFromLabels(d.bias ?? 'Neutral', h?.bias ?? 'Neutral');
  } catch (e) {
    // Fail to 'neutral' so the dStochCross leg still works — but LOG it. This value is what
    // /notify-debug reports as biasAlignment, and a silent catch made a computation failure
    // indistinguishable from a genuine Neutral/Neutral read: the symbol would keep notifying off
    // one weaker primitive forever with the endpoint showing a perfectly ordinary-looking row.
    // That endpoint exists precisely because "silence looks identical whichever gate is closed".
    console.log(`[score] ${symbol} bias alignment failed, degrading to neutral: ${e}`);
    return 'neutral';
  }
}

/// Notification direction primitive: union of bias-aligned OR dStochCross.
/// Returns +1 for LONG, -1 for SHORT, 0 to skip the notification.
/// Skips on conflicts (bias and Stoch disagree). See direction_primitive_sweep.py
/// for the comparison that motivated this rule.
function notificationDirection(biasAlignment: string, dStochCross: number): number {
  const biasDir = biasAlignment === 'aligned_bullish' ? 1 :
                  biasAlignment === 'aligned_bearish' ? -1 : 0;
  const stochDir = dStochCross === 1 ? 1 : (dStochCross === -1 ? -1 : 0);
  if (biasDir !== 0 && stochDir !== 0 && biasDir !== stochDir) return 0; // conflict
  return biasDir !== 0 ? biasDir : stochDir;
}

// Orchestrates the per-cron score pass.
// Pre-refactor (commit 7148670 and earlier) this function called `checkDeviceScores` once
// per device, and each device's call independently fetched candles + derivatives + sector
// ETFs + ran ML for every symbol in (watchlist ∪ ARCHIVE_CRYPTO). Across 13 devices that
// meant ~13× redundant compute per symbol per cron, pushing single-cron runtime to 2-3
// minutes — well past the 60s cron interval. Subsequent cron events fired before previous
// runs finished and the resulting concurrency raced past the cooldown KV (eventually
// consistent), producing duplicate APNs.
//
// Post-refactor: ML compute happens once per symbol (the union across all devices), then
// each device just reads its watchlist's predictions from an in-memory map and applies
// per-device gating (notify window + cooldown + score_history write + APN). One full pass
// finishes in seconds instead of minutes; concurrency is gone, so notifications dedupe
// naturally without needing atomic D1 cooldowns.
async function checkAllDeviceScores(env: Env) {
  const watchlistRows = await env.DB.prepare('SELECT device_id, symbol FROM watchlist').all();
  // Empty watchlist is a HEALTHY state (e.g., right after a stale-device sweep) — stamp the
  // heartbeat before returning, or /cron-health false-alarms 503 while the cron is fine.
  if (!watchlistRows.results.length) { await stampHeartbeat(env); return; }

  const watchlistsByDevice = new Map<string, string[]>();
  for (const row of watchlistRows.results) {
    const deviceId = row.device_id as string;
    const symbol = row.symbol as string;
    let list = watchlistsByDevice.get(deviceId);
    if (!list) { list = []; watchlistsByDevice.set(deviceId, list); }
    list.push(symbol);
  }

  const watchlistSymbols = new Set<string>();
  for (const list of watchlistsByDevice.values()) for (const s of list) watchlistSymbols.add(s);
  const allSymbols = [...new Set([...watchlistSymbols, ...ARCHIVE_CRYPTO])];

  const predictions = await computeSymbolPredictions(env, allSymbols);

  // Direction-model live validation — RETIRED (the direction model's backtest accuracy was a
  // data-leak artifact, 2026-06-02; pUp is null so logDirectionSignals fires nothing new).
  // resolveDirectionSignals stays to grade any leftover pending rows so the historical
  // exhibit closes out honestly. Both calls are fault-isolated so a
  // schema hiccup never blocks notifications.
  try {
    await resolveDirectionSignals(env, predictions);
    await logDirectionSignals(env, predictions);
  } catch (e) {
    console.log(`[dirsignal] error: ${e}`);
  }

  // Server-side setup-outcome resolution (2026-07-09): advance every open tracked_setups row
  // against fresh candles (15m crypto / 1h stocks) and write counted terminals to
  // trade_outcomes. Fault-isolated — a resolver hiccup must never block notifications.
  // Fetchers injected to avoid a circular import (outcome-tracking.ts ← index.ts).
  // One-time retroactive void of any invalid-geometry setups registered before the parseSetups
  // guard shipped (they recorded phantom losses). KV-gated → self-disables after the first pass.
  try { await voidInvalidGeometrySetups(env); } catch (e) { console.log(`[tracked] geometry void error: ${e}`); }

  try {
    await resolveTrackedSetups(env, predictions as any, {
      cryptoKlines: (symbol, interval, limit) => fetchBinanceKlines(symbol, interval, limit),
      livePrice: (symbol, isCrypto) => fetchLivePrice(symbol, isCrypto),
      stock1hMap: async () => {
        try {
          const raw = await env.ALERTS.get('candles:all:1h');
          return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
      },
    });
  } catch (e) {
    console.log(`[tracked] resolve error: ${e}`);
  }

  for (const [deviceId, watchlist] of watchlistsByDevice) {
    try {
      await processDeviceNotifications(env, deviceId, watchlist, predictions);
    } catch (e) {
      console.log(`[score] device ${deviceId} error: ${e}`);
    }
  }

  // Dead-man's-switch heartbeat — stamped only after a full pass completes.
  await stampHeartbeat(env);
}

// ─── Dual-gate direction live-validation (RETIRED — historical exhibit) ────────
// The crypto direction head once claimed ~94% directional accuracy — that claim was a
// DATA-LEAK ARTIFACT (2026-06-02) and the model was retired: mlPredictDirection returns null,
// so logDirectionSignals never fires new signals. resolveDirectionSignals still grades any
// leftover pending rows so the historical record closes out honestly (it resolved ~coin-flip,
// which is the whole point of keeping the exhibit).

const DIR_SIGNAL_HORIZON_MS = 24 * 3600 * 1000;  // grade 24h after firing
const DIR_PUP_GATE = 0.70;                        // |conviction| threshold (>=.70 long / <=.30 short)
const DIR_MODEL_VERSION = 'crypto-dir-1';

let dirTableReady = false;
async function ensureDirectionSignalsTable(env: Env) {
  if (dirTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS direction_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    ml_win REAL NOT NULL,
    p_up REAL NOT NULL,
    predicted_dir INTEGER NOT NULL,
    model_version TEXT NOT NULL,
    is_crypto INTEGER NOT NULL,
    resolve_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    exit_price REAL,
    fwd_return REAL,
    actual_dir INTEGER,
    correct INTEGER
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_dirsig_unresolved ON direction_signals(resolved, resolve_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_dirsig_symbol ON direction_signals(symbol, fired_at DESC)`).run();
  dirTableReady = true;
}

// Log a new signal whenever the dual gate fires on a rising ML edge. Deduped: at most
// one *open* (unresolved) signal per symbol at a time, so a symbol whose ML chatters
// across 0.70 doesn't spam overlapping rows for the same move.
async function logDirectionSignals(env: Env, predictions: Map<string, SymbolPrediction>) {
  await ensureDirectionSignalsTable(env);
  const now = Date.now();

  const fired: SymbolPrediction[] = [];
  for (const pred of predictions.values()) {
    if (!pred.crossed) continue;                       // rising edge through ML 0.70
    if (pred.pUp == null) continue;                    // crypto-only (direction model)
    if (pred.last4HClose <= 0) continue;
    const confident = pred.pUp >= DIR_PUP_GATE || pred.pUp <= 1 - DIR_PUP_GATE;
    if (!confident) continue;                          // direction model must commit
    fired.push(pred);
  }
  if (!fired.length) return;

  // Skip symbols that already have an open signal (dedupe overlapping crosses).
  const openRows = await env.DB.prepare(
    'SELECT DISTINCT symbol FROM direction_signals WHERE resolved = 0'
  ).all();
  const open = new Set((openRows.results || []).map(r => r.symbol as string));

  const inserts = [];
  for (const p of fired) {
    if (open.has(p.symbol)) continue;
    const dir = p.pUp! >= DIR_PUP_GATE ? 1 : -1;
    inserts.push(env.DB.prepare(
      `INSERT INTO direction_signals
        (symbol, fired_at, entry_price, ml_win, p_up, predicted_dir, model_version, is_crypto, resolve_at, resolved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(p.symbol, now, p.last4HClose, p.mlProb, p.pUp, dir, DIR_MODEL_VERSION,
           p.isCrypto ? 1 : 0, now + DIR_SIGNAL_HORIZON_MS));
  }
  if (inserts.length) {
    await env.DB.batch(inserts);
    console.log(`[dirsignal] logged ${inserts.length} new dual-gate signal(s)`);
  }
}

// ─── ML quality-model live calibration ────────────────────────────────────────
// The direction scoreboard validates the direction head live. This does the same for the
// QUALITY model (ML Win): log a sample of predictions and grade them against realized goodR
// (max favorable excursion >= 1.5 ATR in 24h, direction-agnostic — the model's actual
// target). Tells us whether predicted-70% bars really hit ~70% in the wild, or whether the
// model has drifted. One sample per symbol per ~20h keeps D1 writes bounded.

const CAL_LOG_INTERVAL_MS = 20 * 3600 * 1000;
const CAL_HORIZON_MS = 24 * 3600 * 1000;
/** The envelope gates a SETUP, and the app's setups run to 72h — so grade it at the horizon it governs. */
const ENV_SIG_HORIZON_MS = 72 * 3600 * 1000;
/** One sample per symbol per ~20h, matching the calibration loop's cadence gate. */
const ENV_SIG_INTERVAL_MS = 20 * 3600 * 1000;
const CAL_GOODR_ATR = 1.5;

let calTableReady = false;
let envSigTableReady = false;
/**
 * FORWARD validation for the Conviction Envelope (2026-08-26).
 *
 * Every retrospective test of the envelope shares one window — a crypto bear in which the
 * equal-weight basket fell 83% and SHORT is the better side ungated. Phase 2 found the envelope is a
 * working gate on SHORT and an inverted one on LONG, four times over on different targets, and could
 * not tell mechanism from regime, because every arm was measured in that same window.
 *
 * The retrospective holdout is also gone: plan step 1.11 reserved the last six months and was never
 * implemented, so C1-C6 consumed the whole span. There is no unseen data left in that dataset.
 *
 * So the only honest holdout is FORWARD, and this is it: record each bar's tier and grade it at +72h
 * against the direction-agnostic excursion the envelope claims to gate. Same shape as
 * `direction_signals` and `ml_calibration`, which already work this way.
 *
 * It will not answer anything for months. That is the point — it needs a window that is not this one.
 */
async function ensureEnvelopeSignalsTable(env: Env) {
  if (envSigTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS envelope_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, is_crypto INTEGER NOT NULL,
    logged_at INTEGER NOT NULL, entry_price REAL NOT NULL, atr_price REAL NOT NULL,
    max_allowed TEXT NOT NULL, aligned_direction TEXT,
    ml_raw REAL, ml_calibrated REAL,
    auto_flat TEXT, high_blocks TEXT, moderate_blocks TEXT,
    resolve_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0, fav_r REAL, adv_r REAL
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_envsig_unresolved ON envelope_signals(resolved, resolve_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_envsig_symbol ON envelope_signals(symbol, logged_at DESC)`).run();
  envSigTableReady = true;
}

async function ensureCalibrationTable(env: Env) {
  if (calTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ml_calibration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, is_crypto INTEGER NOT NULL,
    logged_at INTEGER NOT NULL, entry_price REAL NOT NULL, atr_price REAL NOT NULL,
    predicted_prob REAL NOT NULL, resolve_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0, fav_r REAL, good_r INTEGER
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cal_unresolved ON ml_calibration(resolved, resolve_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cal_symbol ON ml_calibration(symbol)`).run();
  calTableReady = true;
}

// Dead-man's-switch: the cron stamps a heartbeat each successful pass; /cron-health returns
// 503 when it goes stale so an external uptime monitor (UptimeRobot etc.) can alert. A dead
// cron can't push, so detection is external-on-read by design.
async function stampHeartbeat(env: Env) {
  try { await env.ALERTS.put('cron:heartbeat', String(Date.now())); } catch {}
}

// Grade every signal whose 24h horizon has elapsed against the current price.
// fwd_return = exit/entry - 1; correct = predicted_dir matches the realized sign.
// Uses the live price from this cron's predictions (the symbol is in ARCHIVE_CRYPTO so
// it's always recomputed); rows whose symbol is absent this cron are simply graded on
// the next cron that has it.
async function resolveDirectionSignals(env: Env, predictions: Map<string, SymbolPrediction>) {
  await ensureDirectionSignalsTable(env);
  const now = Date.now();
  const due = await env.DB.prepare(
    'SELECT id, symbol, entry_price, predicted_dir FROM direction_signals WHERE resolved = 0 AND resolve_at <= ? LIMIT 200'
  ).bind(now).all();
  if (!due.results || !due.results.length) return;

  const updates = [];
  for (const row of due.results) {
    const symbol = row.symbol as string;
    const pred = predictions.get(symbol);
    if (!pred || pred.last4HClose <= 0) continue;       // no price this cron — grade later
    const entry = row.entry_price as number;
    const exit = pred.last4HClose;
    const fwd = exit / entry - 1;
    const actualDir = fwd > 0 ? 1 : (fwd < 0 ? -1 : 0);
    const correct = actualDir === (row.predicted_dir as number) ? 1 : 0;
    updates.push(env.DB.prepare(
      'UPDATE direction_signals SET resolved = 1, exit_price = ?, fwd_return = ?, actual_dir = ?, correct = ? WHERE id = ?'
    ).bind(exit, fwd, actualDir, correct, row.id as number));
  }
  if (updates.length) {
    await env.DB.batch(updates);
    console.log(`[dirsignal] resolved ${updates.length} signal(s)`);
  }
}

// Symbol pass: fetches global market data once, then for each symbol computes features +
// `mlPredict`, accumulates predictions, and returns a Map consumed by the device pass.
// Side-effects beyond the return value:
//  - `ml_preds:all` KV write (5-min TTL, one batched blob covering all symbols) — fed
//    to iOS via /ml-predict?symbol=X which extracts the requested symbol's record.
//    Previously a per-symbol `ml_pred:<symbol>` write; batching cut KV writes ~75×.
//  - `ml_snapshots` KV write (24h TTL) — feeds next cron's rate-of-change deltas
//  - `prev_oi:<symbol>` KV write (24h TTL) — for OI delta on next cron
//  - `derivatives_history` D1 archive every ~4H per symbol
//  - `candles:<symbol>:<interval>` KV cache + D1 candle archive
//  - `debug:<symbol>_features` KV write (1h TTL) for parity verification
async function computeSymbolPredictions(
  env: Env,
  allSymbols: string[],
): Promise<Map<string, SymbolPrediction>> {
  const predictions = new Map<string, SymbolPrediction>();
  // Phase 5: previous-tick risk states (for transition-into-HIGH detection) + current accumulator.
  let prevRiskStates: Record<string, { names: string[]; high: string[] }> = {};
  try { const r = await env.ALERTS.get('risk_states:all'); if (r) prevRiskStates = JSON.parse(r); } catch { /* ignore */ }
  // Envelope-precheck suppression state (defer-not-drop): symbol -> ms of the suppressed cross.
  let suppressedMap: Record<string, number> = {};
  try { const s = await env.ALERTS.get('notif_suppressed:all'); if (s) suppressedMap = JSON.parse(s); } catch { /* ignore */ }
  // Symbols with live pending setups — their entry-zone pushes are envelope-gated too, so the
  // precheck must run for them every tick (bounded: typically 0-3 symbols).
  // (Reads tracked_setups since 2026-07-24 — same rows the entry-zone pass now uses; the
  // `pending_setups` glue table was a duplicate and is retired. The `notified = 0` clause it used
  // to carry has no equivalent here because the notified marker moved to KV; the set is only used
  // to decide whether to RUN a precheck, so including an already-notified row costs one extra
  // precheck for a symbol that is almost certainly being prechecked anyway.)
  const notifyDebug: Record<string, any> = {};
  // Live calibration curves, fitted ONCE per cron (one fine-bucket D1 query per market — not
  // per symbol). See `calibratedNotifyProb` below for why the notify gate needs this: the
  // envelope has keyed on calibrated ML since 2026-07-02 while the NOTIFY threshold was left
  // on the raw number, so the same quantity gated two decisions differently. Since 2026-08-21
  // both apply the SAME honest PAV refit (calibration.ts) instead of the 35/65 blend — and the
  // curve is now per-market (the old code applied the crypto curve to stock symbols too).
  let cryptoCalCurve: CalPoint[] | null = null;
  let stockCalCurve: CalPoint[] | null = null;
  try { cryptoCalCurve = fitCalibrationCurve(await fetchLiveCalBuckets(env, true)); } catch { /* best-effort */ }
  try { stockCalCurve = fitCalibrationCurve(await fetchLiveCalBuckets(env, false)); } catch { /* best-effort */ }
  // Unreachable-gate guard. applyCalibration clamps at the curve's top, so if that top ever falls
  // below ML_THRESHOLD the notify gate can NEVER open for that market — total, silent notification
  // failure with every other component looking healthy. Log it loudly; this is the one failure mode
  // the whole calibrated-gate design can produce on its own.
  for (const [mkt, c] of [['crypto', cryptoCalCurve], ['stock', stockCalCurve]] as const) {
    const ceiling = c ? c[c.length - 1].y : null;
    if (ceiling != null && ceiling < ML_THRESHOLD) {
      console.log(`[calibration] WARNING ${mkt} curve tops out at ${(ceiling * 100).toFixed(1)}% — below the ${Math.round(ML_THRESHOLD * 100)}% notify threshold, so NO ${mkt} symbol can page until the curve recovers or the threshold moves`);
    }
  }
  /** Same live-curve mapping the envelope uses, so one number gates both decisions. Raw when the curve is too thin. */
  const calibratedNotifyProb = (raw: number, forCrypto: boolean): number => {
    const curve = forCrypto ? cryptoCalCurve : stockCalCurve;
    return curve ? applyCalibration(curve, raw) : raw;
  };
  /** Pass-level calibration handed to envelopePrecheck so it doesn't re-run the 90d D1 aggregate per symbol per minute. */
  const calForPrecheck = (raw: number, forCrypto: boolean) => {
    const curve = forCrypto ? cryptoCalCurve : stockCalCurve;
    return { calibratedMlWin: curve ? applyCalibration(curve, raw) : null,
           };
  };
  let pendingSetupSymbols = new Set<string>();
  try {
    const r = await env.DB.prepare(
      `SELECT DISTINCT symbol FROM tracked_setups
        WHERE kind = 'setup' AND state = 'pending' AND terminal = 0 AND is_crypto = 1 AND atr > 0`
    ).all();
    pendingSetupSymbols = new Set((r.results || []).map((x: any) => x.symbol as string));
  } catch { /* table may not exist yet */ }
  // Economic events for the precheck's macro_IMMINENT gate — fetched at most once per pass,
  // and only when some symbol actually needs a precheck.
  let econEventsCache: any[] | null = null;
  const econEvents = async (): Promise<any[]> => {
    if (econEventsCache === null) {
      try { econEventsCache = await fetchEconomicEvents(Date.now()); } catch { econEventsCache = []; }
    }
    return econEventsCache;
  };
  const curRiskStates: Record<string, { names: string[]; high: string[]; detail: Record<string, string> }> = {};
  // Accumulates per-symbol ML predictions for a single batched KV write after the loop —
  // replaces what used to be 76 individual `ml_pred:<symbol>` writes per cron run.
  const mlPredBatch: Record<string, { symbol: string; probability: number; features: FullFeatures; timestamp: number; isCrypto: boolean;
    // Phase 1/2 additive heads (crypto-only; null/absent otherwise). Served by /ml-predict.
    probabilityH72?: number | null; bigMoveProb?: number | null;
    probabilityMeta?: number | null; q75?: number | null; confident?: boolean | null; metaDirection?: number;
    pUp?: number | null }> = {};
  // Per-cron batched lookups: previous-bar open interest, last-derivatives-archive
  // timestamps (4H gate), and the candle cache for 1d/4h/1h. Each replaces 76 individual
  // KV reads + writes per cron with a single read + write of one blob. Candle cache is
  // the biggest line — was 228 reads/cron (76 × 3 intervals); now 3.
  const prevOIBatchRaw = await env.ALERTS.get('prev_oi:all');
  const prevOIMap: Record<string, number> = prevOIBatchRaw ? JSON.parse(prevOIBatchRaw) : {};
  const derivArchiveBatchRaw = await env.ALERTS.get('deriv_archive:all');
  const derivArchiveMap: Record<string, number> = derivArchiveBatchRaw ? JSON.parse(derivArchiveBatchRaw) : {};
  // The 3.5h archive gate used to live in that KV blob ALONE, which meant an eviction (or an
  // overlapping cron reading a blob the other pass hadn't flushed yet) reset every symbol's
  // last-archive time to "never" and re-archived the whole universe — the archive ran ~9×/day per
  // symbol instead of the intended 6.85× (~700 surplus rows/day across 76 symbols). Fix: seed the
  // gate from D1, which IS the thing being gated and therefore cannot disagree with itself. The KV
  // blob stays as a fast path; we take the LATER of the two, so a fresh/evicted blob degrades to
  // "ask D1" instead of "archive everything". One indexed GROUP BY per cron
  // (idx_deriv_lookup covers it). NB: D1 stores `timestamp` in SECONDS, the KV blob in ms.
  try {
    const seed = await env.DB.prepare(
      'SELECT symbol, MAX(timestamp) AS ts FROM derivatives_history GROUP BY symbol'
    ).all();
    mergeDerivArchiveGate(derivArchiveMap, (seed.results ?? []) as Array<{ symbol: string; ts: number }>);
  } catch (e) {
    // Best-effort: on failure we fall back to the KV-only behaviour (over-archives at worst).
    console.log(`[deriv-archive] D1 gate seed failed, using KV only: ${e}`);
  }
  // Live-derivatives cache: per-symbol raw fapi values + ts. Warm passes within the 5-min TTL
  // skip the VPN derivative batch (the cron's dominant cost). Per-symbol ts → staggered refresh.
  const derivLiveBatchRaw = await env.ALERTS.get('deriv_live:all');
  const derivLiveMap: Record<string, any> = derivLiveBatchRaw ? JSON.parse(derivLiveBatchRaw) : {};
  // Dense OI/price snapshots for a future HOMEMADE liquidation heatmap (every ~20 min per
  // symbol). Captures the heatmap inputs — live OI level + mark price + funding + positioning —
  // so that over months we accumulate the OI-vs-price history needed to model liquidation
  // clusters ourselves (the data Coinglass gates behind $699/mo), collected free going forward.
  const oiSnapBatchRaw = await env.ALERTS.get('oi_snap:all');
  const oiSnapMap: Record<string, number> = oiSnapBatchRaw ? JSON.parse(oiSnapBatchRaw) : {};
  // Depth snapshots share the oi_snapshots cadence (every ~20 min per crypto symbol).
  const depthSnapBatchRaw = await env.ALERTS.get('depth_snap:all');
  const depthSnapMap: Record<string, number> = depthSnapBatchRaw ? JSON.parse(depthSnapBatchRaw) : {};
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS oi_snapshots (symbol TEXT NOT NULL, timestamp INTEGER NOT NULL, open_interest REAL, mark_price REAL, funding_rate REAL, long_percent REAL, basis_pct REAL, PRIMARY KEY (symbol, timestamp))').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_oi_snap ON oi_snapshots(symbol, timestamp DESC)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS depth_snapshots (symbol TEXT NOT NULL, timestamp INTEGER NOT NULL, mid REAL, best_bid REAL, best_ask REAL, bid_05 REAL, ask_05 REAL, bid_1 REAL, ask_1 REAL, bid_2 REAL, ask_2 REAL, bid_span_pct REAL, ask_span_pct REAL, PRIMARY KEY (symbol, timestamp))').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_depth_snap ON depth_snapshots(symbol, timestamp DESC)').run();
  } catch {}
  const candles1dRaw = await env.ALERTS.get('candles:all:1d');
  const candles4hRaw = await env.ALERTS.get('candles:all:4h');
  const candles1hRaw = await env.ALERTS.get('candles:all:1h');
  const candles1dMap: Record<string, ScoreCandle[]> = candles1dRaw ? JSON.parse(candles1dRaw) : {};
  const candles4hMap: Record<string, FullCandle[]> = candles4hRaw ? JSON.parse(candles4hRaw) : {};
  const candles1hMap: Record<string, FullCandle[]> = candles1hRaw ? JSON.parse(candles1hRaw) : {};
  const candlesDirty = { '1d': false, '4h': false, '1h': false };
  const hasStocks = allSymbols.some(s => !s.endsWith('USDT'));

  // Fetch Fear & Greed index (global, once per cron run)
  let fearGreedIndex = 50, fearGreedZone = 0;
  try {
    const fgResp = await fetch('https://api.alternative.me/fng/?limit=1&format=json');
    if (fgResp.ok) {
      const fgData = await fgResp.json() as any;
      const val = parseInt(fgData?.data?.[0]?.value ?? '50');
      fearGreedIndex = val;
      fearGreedZone = val <= 20 ? -2 : val <= 40 ? -1 : val <= 60 ? 0 : val <= 80 ? 1 : 2;
    }
  } catch {}

  // Fetch ETH/BTC ratio (global, once per cron run)
  // iOS training used delta of last two 4H closes (1-bar delta despite the "6" suffix).
  // Matching that so the model sees the same feature distribution it was trained on.
  let ethBtcRatio = 0, ethBtcDelta6 = 0;
  try {
    const ebResp = await fetch(`${BINANCE_SPOT}/klines?symbol=ETHBTC&interval=4h&limit=2`);
    if (ebResp.ok) {
      const ebData = await ebResp.json() as any[];
      if (ebData.length >= 2) {
        ethBtcRatio = +ebData[ebData.length - 1][4];
        const prev = +ebData[ebData.length - 2][4];
        ethBtcDelta6 = prev > 0 ? (ethBtcRatio - prev) / prev * 100 : 0;
      } else if (ebData.length > 0) {
        ethBtcRatio = +ebData[ebData.length - 1][4];
      }
    }
  } catch {}

  // Fetch VIX + DXY (once per cron run, cached)
  let vixValue = 20, dxyAboveEma20 = 0;
  // Try cached VIX first (in case fetch fails)
  const cachedVix = await env.ALERTS.get('cache:vix_value');
  if (cachedVix) vixValue = parseFloat(cachedVix);
  try {
    const vixResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/%5EVIX?interval=1d&range=5d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (vixResp.ok) {
      const vixData = await vixResp.json() as any;
      const result = vixData?.chart?.result?.[0];
      const ts: number[] = result?.timestamp || [];
      const closes: (number|null)[] = result?.indicators?.quote?.[0]?.close || [];
      // Build paired (time, close) pairs, then drop in-progress so we use the latest CLOSED
      // daily VIX (yesterday's close during market hours, today's close after market close).
      // This matches BacktestEngine's training canonical: closing VIX as of the date.
      const pairs = ts.map((t, i) => ({ time: t * 1000, close: closes[i] }))
                      .filter(p => p.close != null) as { time: number; close: number }[];
      const closedPairs = dropInProgress(pairs, '1d');
      if (closedPairs.length) {
        vixValue = closedPairs[closedPairs.length - 1].close;
        await env.ALERTS.put('cache:vix_value', String(vixValue), { expirationTtl: 3600 });
      }
    }
  } catch {}
  try {
    const dxyResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/DX-Y.NYB?interval=1d&range=30d`);
    if (dxyResp.ok) {
      const dxyData = await dxyResp.json() as any;
      const closes = dxyData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((v: any) => v != null) || [];
      if (closes.length >= 20) {
        const ema20k = 2 / 21;
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) ema = closes[i] * ema20k + ema * (1 - ema20k);
        dxyAboveEma20 = closes[closes.length - 1] > ema ? 1 : 0;
      }
    }
  } catch {}

  // Fetch SPY candles once for stock relative strength + beta
  let spyCandles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  if (hasStocks) {
    try {
      const spyResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/SPY?interval=1d&range=6mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (spyResp.ok) {
        const spyData = await spyResp.json() as any;
        const result = spyData?.chart?.result?.[0];
        const ts = result?.timestamp || [];
        const q = result?.indicators?.quote?.[0] || {};
        for (let i = 0; i < ts.length; i++) {
          if (q.open?.[i] != null && q.close?.[i] != null) {
            spyCandles.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
          }
        }
        // Drop in-progress to match TSLA's daily candles (also dropped in fetchScoreCandles).
        // Without this, beta and relStrength computations correlate misaligned dates.
        spyCandles = dropInProgress(spyCandles, '1d');
      }
    } catch {}
  }

  // Fetch IWM candles for breadth ratio
  let iwmCandles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  if (hasStocks) {
    try {
      const iwmResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/IWM?interval=1d&range=1mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (iwmResp.ok) {
        const iwmData = await iwmResp.json() as any;
        const result = iwmData?.chart?.result?.[0];
        const ts = result?.timestamp || [];
        const q = result?.indicators?.quote?.[0] || {};
        for (let i = 0; i < ts.length; i++) {
          if (q.open?.[i] != null && q.close?.[i] != null) {
            iwmCandles.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
          }
        }
        iwmCandles = dropInProgress(iwmCandles, '1d');
      }
    } catch {}
  }

  // Fetch VIX3M for term structure ratio
  let vix3mPrice = 0;
  try {
    const vix3mResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/%5EVIX3M?interval=1d&range=5d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (vix3mResp.ok) {
      const vix3mData = await vix3mResp.json() as any;
      const closes = vix3mData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if (closes?.length) vix3mPrice = closes[closes.length - 1] ?? 0;
    }
  } catch {}

  // Fetch DXY candles for momentum (full 1mo for 5-day lookback)
  let dxyCandles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  try {
    const dxyResp2 = await fetch(`${YAHOO_BASE}/v8/finance/chart/DX-Y.NYB?interval=1d&range=1mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (dxyResp2.ok) {
      const dxyData2 = await dxyResp2.json() as any;
      const result = dxyData2?.chart?.result?.[0];
      const ts = result?.timestamp || [];
      const q = result?.indicators?.quote?.[0] || {};
      for (let i = 0; i < ts.length; i++) {
        if (q.open?.[i] != null && q.close?.[i] != null) {
          dxyCandles.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
        }
      }
      dxyCandles = dropInProgress(dxyCandles, '1d');
    }
  } catch {}

  // Fetch sector ETF candles for relative strength. Stocks subset of allSymbols.
  const sectorETFCandlesMap: Record<string, { time: number; open: number; high: number; low: number; close: number; volume: number }[]> = {};
  if (hasStocks) {
    const neededETFs = new Set<string>();
    for (const s of allSymbols) {
      if (!s.endsWith('USDT')) {
        const etf = sectorETFForSymbol(s);
        if (etf) neededETFs.add(etf);
      }
    }
    for (const etf of neededETFs) {
      try {
        const etfResp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${etf}?interval=1d&range=1mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (etfResp.ok) {
          const etfData = await etfResp.json() as any;
          const result = etfData?.chart?.result?.[0];
          const ts = result?.timestamp || [];
          const q = result?.indicators?.quote?.[0] || {};
          const candles: typeof iwmCandles = [];
          for (let i = 0; i < ts.length; i++) {
            if (q.open?.[i] != null && q.close?.[i] != null) {
              candles.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
            }
          }
          sectorETFCandlesMap[etf] = dropInProgress(candles, '1d');
        }
      } catch {}
    }
  }

  // Fetch FINRA dark pool data (once per day, cached in KV)
  let darkPoolData: Record<string, { ratio: number; zscore: number }> = {};
  if (hasStocks) {
    const dpCacheKey = 'darkpool:latest';
    const dpCached = await env.ALERTS.get(dpCacheKey);
    if (dpCached) {
      darkPoolData = JSON.parse(dpCached);
    } else {
      try {
        // FINRA publishes after market close; try today, fall back to yesterday
        const now = new Date();
        const tryDates = [0, 1, 2, 3].map(d => {
          const dt = new Date(now.getTime() - d * 86400000);
          return dt.toISOString().slice(0, 10).replace(/-/g, '');
        });
        let lines: string[] = [];
        for (const dateStr of tryDates) {
          try {
            const resp = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${dateStr}.txt`);
            if (resp.ok) {
              lines = (await resp.text()).split('\n');
              break;
            }
          } catch {}
        }
        if (lines.length > 0) {
          // Parse and compute ratios for our symbols
          for (const line of lines) {
            const parts = line.split('|');
            if (parts.length < 5) continue;
            const sym = parts[1];
            const shortVol = parseFloat(parts[2]);
            const totalVol = parseFloat(parts[4]);
            if (totalVol > 0 && !isNaN(shortVol)) {
              darkPoolData[sym] = { ratio: shortVol / totalVol, zscore: 0 };
            }
          }
          // Load historical ratios from KV for Z-score computation. APPEND AT MOST ONCE PER
          // DAY (2026-07-02): the 4h cache TTL meant ~6 re-fetches/day each pushed the SAME
          // day's ratio, so the "20-day" Z window really covered ~3.3 days of near-identical
          // values — variance collapsed and the Z feature saturated (live/train skew vs the
          // true-daily training pipeline). `__lastAppend` marks the last append date.
          const histKey = 'darkpool:history';
          const histRaw = await env.ALERTS.get(histKey);
          const histBlob: Record<string, number[] | string> = histRaw ? JSON.parse(histRaw) : {};
          const todayStr = new Date().toISOString().slice(0, 10);
          const appendToday = histBlob['__lastAppend'] !== todayStr;
          for (const [sym, dp] of Object.entries(darkPoolData)) {
            const cur = histBlob[sym];
            const arr: number[] = Array.isArray(cur) ? cur : [];
            if (appendToday) {
              arr.push(dp.ratio);
              histBlob[sym] = arr.length > 20 ? arr.slice(-20) : arr;
            }
            const window = Array.isArray(histBlob[sym]) ? histBlob[sym] as number[] : arr;
            if (window.length >= 5) {
              const mean = window.reduce((a, b) => a + b, 0) / window.length;
              const std = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length);
              dp.zscore = std > 0.001 ? (dp.ratio - mean) / std : 0;
            }
          }
          if (appendToday) histBlob['__lastAppend'] = todayStr;
          await env.ALERTS.put(histKey, JSON.stringify(histBlob), { expirationTtl: 86400 * 30 });
          await env.ALERTS.put(dpCacheKey, JSON.stringify(darkPoolData), { expirationTtl: 14400 });
        }
      } catch {}
    }
  }

  // Load previous ML snapshots for rate-of-change deltas + acceleration. `mlProb` was
  // added 2026-05-05 for rising-edge notification gating; older blobs lack it (treated as
  // undefined, so first cron after deploy fires normally for any symbol already above
  // threshold — a one-time noise event, not a regression).
  const prevSnapshotsRaw = await env.ALERTS.get('ml_snapshots');
  const prevSnapshots: Record<string, { dRsi: number; dAdx: number; hRsi: number; hAdx: number; hMacdHist: number;
    hRsiD1?: number; hMacdD1?: number; dRsiD1?: number; dAdxD1?: number; fundingHist?: number[];
    mlProb?: number }> =
    prevSnapshotsRaw ? JSON.parse(prevSnapshotsRaw) : {};
  const newSnapshots: typeof prevSnapshots = {};

  // Calibration: load the per-symbol last-log gate + any rows due for grading. Logging and
  // resolution happen inside the loop (resolution needs the 4H candle history for the max
  // excursion). Inserts/updates are batched after the loop.
  await ensureCalibrationTable(env);
  await ensureEnvelopeSignalsTable(env);
  const nowCal = Date.now();
  const calLogged: Record<string, number> = JSON.parse((await env.ALERTS.get('cal_logged:all')) || '{}');
  const calDueBySymbol = new Map<string, Array<{ id: number; logged_at: number; entry_price: number; atr_price: number }>>();
  try {
    const due = await env.DB.prepare(
      'SELECT id, symbol, logged_at, entry_price, atr_price FROM ml_calibration WHERE resolved = 0 AND resolve_at <= ? LIMIT 300'
    ).bind(nowCal).all();
    for (const r of due.results || []) {
      const s = r.symbol as string;
      if (!calDueBySymbol.has(s)) calDueBySymbol.set(s, []);
      calDueBySymbol.get(s)!.push({ id: r.id as number, logged_at: r.logged_at as number,
        entry_price: r.entry_price as number, atr_price: r.atr_price as number });
    }
  } catch (e) { console.log(`[cal] due-load err ${e}`); }
  const calInserts: D1PreparedStatement[] = [];
  const calUpdates: D1PreparedStatement[] = [];

  // Envelope forward validation — same cadence gate and same batching as the calibration loop above.
  // ENV_SIG_HORIZON_MS is 72h rather than the calibration loop's 24h because the envelope gates a
  // SETUP, and the app's setups run to a 72h horizon.
  const envSigLogged: Record<string, number> = JSON.parse((await env.ALERTS.get('envsig_logged:all')) || '{}');
  const envSigDueBySymbol = new Map<string, Array<{ id: number; logged_at: number; entry_price: number; atr_price: number }>>();
  try {
    const due = await env.DB.prepare(
      'SELECT id, symbol, logged_at, entry_price, atr_price FROM envelope_signals WHERE resolved = 0 AND resolve_at <= ? LIMIT 300'
    ).bind(nowCal).all();
    for (const r of due.results || []) {
      const sym = r.symbol as string;
      if (!envSigDueBySymbol.has(sym)) envSigDueBySymbol.set(sym, []);
      envSigDueBySymbol.get(sym)!.push({ id: r.id as number, logged_at: r.logged_at as number,
        entry_price: r.entry_price as number, atr_price: r.atr_price as number });
    }
  } catch (e) { console.log(`[envsig] due-load err ${e}`); }
  const envSigInserts: D1PreparedStatement[] = [];
  const envSigUpdates: D1PreparedStatement[] = [];

  // Pre-warm stale crypto derivative caches in bounded-parallel (5 symbols in flight) BEFORE the
  // serial loop, so the loop always hits a warm cache. Collapses the cold/refresh pass from ~87s
  // (76 serial VPN batches) to ~15s — without parallelizing the loop body, which would risk the
  // notification-dedup invariants. Capped to stay under Binance's per-IP rate limit on the single
  // VPN exit. On warm passes _stale is empty, so this is a no-op.
  const _stale = allSymbols.filter(s => s.endsWith('USDT')).filter(s => {
    const e = derivLiveMap[s]; return !e || (Date.now() - (e.ts || 0)) >= 300_000;
  });
  if (_stale.length) {
    await mapLimit(_stale, 5, async (sym) => {
      const d = await fetchLiveDerivatives(sym);
      // All-zero = every fapi endpoint failed (fetchLiveDerivatives returns 0 per failure) —
      // don't cache it, or zero funding/OI/taker feeds the ML for up to 5 ticks. Leaving the
      // stale entry (or nothing) makes the next tick retry instead.
      if (d.markPrice === 0 && d.openInterest === 0) return;
      derivLiveMap[sym] = { ...d, ts: Date.now() };
    });
  }

  for (const symbol of allSymbols) {
    try {
      const isCrypto = symbol.endsWith('USDT');

      // Candle cache: lookup in per-interval batched maps; fetch + insert on miss.
      let candles: ScoreCandle[] = candles1dMap[symbol] ?? [];
      if (!candles.length) {
        candles = await fetchScoreCandles(symbol, isCrypto);
        if (candles.length > 0) {
          candles1dMap[symbol] = candles;
          candlesDirty['1d'] = true;
          archiveCandlesToD1(env, symbol, '1d', candles).catch(() => {});
        }
      }
      if (candles.length < 210) continue;

      // Fetch 4H + 1H candles for full ML features
      let fourHCandles: FullCandle[] = candles4hMap[symbol] ?? [];
      let oneHCandles: FullCandle[] = candles1hMap[symbol] ?? [];
      if (isCrypto) {
        if (!fourHCandles.length) {
          const c = await fetchBinanceKlines(symbol, '4h', 260) as FullCandle[];   // proxy → Binance → Bybit
          if (c.length) {
            fourHCandles = c; candles4hMap[symbol] = fourHCandles; candlesDirty['4h'] = true;
            archiveCandlesToD1(env, symbol, '4h', fourHCandles).catch(() => {});
          }
        }
        if (!oneHCandles.length) {
          const c = await fetchBinanceKlines(symbol, '1h', 100) as FullCandle[];    // proxy → Binance → Bybit
          if (c.length) {
            oneHCandles = c; candles1hMap[symbol] = oneHCandles; candlesDirty['1h'] = true;
            archiveCandlesToD1(env, symbol, '1h', oneHCandles).catch(() => {});
          }
        }
      } else {
        // Stock: fetch 1H from Yahoo, aggregate to 4H
        if (!oneHCandles.length) {
          try {
            const resp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1h&range=6mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (resp.ok) {
              const data = await resp.json() as any;
              const r = data?.chart?.result?.[0];
              if (r?.timestamp) {
                const ts = r.timestamp;
                const q = r.indicators.quote[0];
                const parsed: FullCandle[] = [];
                for (let i = 0; i < ts.length; i++) {
                  if (q.open?.[i] != null && q.close?.[i] != null) {
                    parsed.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
                  }
                }
                oneHCandles = dropInProgress(parsed, '1h');
                candles1hMap[symbol] = oneHCandles;
                candlesDirty['1h'] = true;
              }
            }
          } catch {}
        }
        // Aggregate 1H → 4H via shared helper (mirrors iOS CandleAggregator.aggregate1HTo4H).
        // Cache the aggregated stock 4H so the next cron skips the recompute on hit.
        if (!fourHCandles.length && oneHCandles.length > 0) {
          fourHCandles = dropInProgress(aggregate1HTo4H_ET(oneHCandles), '4h');
          if (fourHCandles.length) {
            candles4hMap[symbol] = fourHCandles;
            candlesDirty['4h'] = true;
          }
        }
        if (fourHCandles.length > 0) {
          archiveCandlesToD1(env, symbol, '4h', fourHCandles).catch(() => {});
        }
        if (oneHCandles.length > 0) {
          archiveCandlesToD1(env, symbol, '1h', oneHCandles).catch(() => {});
        }
      }

      // Fetch live derivatives for crypto (funding + top trader + taker + OI + basis)
      let derivSignals: any = { fundingSignal: 0, oiSignal: 0, takerSignal: 0, crowdingSignal: 0, derivativesCombined: 0 };
      let basisPct = 0, largeBuyVol = 0, largeSellVol = 0;
      if (isCrypto) {
        const prevOI = prevOIMap[symbol] ?? 0;
        const FAPI = 'https://fapi.binance.com';
        let fundingRate = 0, topTraderLongPct = 0, takerBuyVol = 0, takerSellVol = 0;
        let openInterest = 0, markPrice = 0, indexPrice = 0, longPct = 0, takerRatio = 0;

        // Derivatives: cached per-symbol (deriv_live:all blob, per-symbol ts → staggered
        // refresh, matching prev_oi:all). Warm passes within the 5-min TTL skip the VPN batch
        // entirely — the dominant cron speedup. On a miss, fetch all 7 fapi/binance endpoints
        // CONCURRENTLY (mirrors the /derivatives endpoint ~line 1277). These are ~4h-period
        // stats + live mark/aggTrades; 5-min staleness is negligible for the ML, and the parsed
        // values + downstream signal/archive computation are identical either way.
        let largeBuyCount = 0, largeSellCount = 0;
        const _dl = derivLiveMap[symbol];
        if (_dl && (Date.now() - (_dl.ts || 0)) < 300_000) {
          fundingRate = _dl.fundingRate; openInterest = _dl.openInterest;
          topTraderLongPct = _dl.topTraderLongPct; takerBuyVol = _dl.takerBuyVol;
          takerSellVol = _dl.takerSellVol; takerRatio = _dl.takerRatio;
          longPct = _dl.longPct; markPrice = _dl.markPrice; indexPrice = _dl.indexPrice;
          basisPct = _dl.basisPct; largeBuyVol = _dl.largeBuyVol; largeSellVol = _dl.largeSellVol;
          largeBuyCount = _dl.largeBuyCount; largeSellCount = _dl.largeSellCount;
        } else {
          const _d = await fetchLiveDerivatives(symbol);
          fundingRate = _d.fundingRate; openInterest = _d.openInterest;
          topTraderLongPct = _d.topTraderLongPct; takerBuyVol = _d.takerBuyVol;
          takerSellVol = _d.takerSellVol; takerRatio = _d.takerRatio;
          longPct = _d.longPct; markPrice = _d.markPrice; indexPrice = _d.indexPrice;
          basisPct = _d.basisPct; largeBuyVol = _d.largeBuyVol; largeSellVol = _d.largeSellVol;
          largeBuyCount = _d.largeBuyCount; largeSellCount = _d.largeSellCount;
          // All-zero = fetch failure; don't cache (next tick retries instead of serving zeros 5 min).
          if (!(_d.markPrice === 0 && _d.openInterest === 0)) derivLiveMap[symbol] = { ..._d, ts: Date.now() };
        }

        let oiChangePct = 0;
        if (prevOI > 0 && openInterest > 0) {
          oiChangePct = (openInterest - prevOI) / prevOI * 100;
        }
        if (openInterest > 0) {
          prevOIMap[symbol] = openInterest;
        }

        derivSignals.fundingRateRaw = fundingRate;
        derivSignals.oiChangePct = oiChangePct;
        derivSignals.longPctRaw = longPct || 50;
        derivSignals.takerRatioRaw = takerRatio || 1.0;
        if (fundingRate > 0.03) derivSignals.fundingSignal = -1;
        else if (fundingRate < -0.03) derivSignals.fundingSignal = 1;
        if (takerRatio > 1.1) derivSignals.takerSignal = 1;
        else if (takerRatio < 0.9) derivSignals.takerSignal = -1;
        if (longPct > 60) derivSignals.crowdingSignal = -1;
        else if (longPct < 40) derivSignals.crowdingSignal = 1;
        const priceRising = candles.length >= 2 && candles[candles.length - 1].close > candles[candles.length - 2].close;
        const oiUp = oiChangePct > 1.0;
        const oiDown = oiChangePct < -1.0;
        if (oiUp && priceRising) derivSignals.oiSignal = 1;
        else if (oiUp && !priceRising) derivSignals.oiSignal = -1;
        else if (oiDown && priceRising) derivSignals.oiSignal = -1;
        else if (oiDown && !priceRising) derivSignals.oiSignal = 1;
        derivSignals.derivativesCombined = Math.max(-3, Math.min(3,
          derivSignals.fundingSignal + derivSignals.oiSignal + derivSignals.takerSignal + derivSignals.crowdingSignal));

        // Archive to D1 (every 4H). Per-symbol gate moved into the in-memory map; the
        // batched blob is flushed at the end of computeSymbolPredictions only if any
        // symbol actually archived this cron.
        const lastArchive = derivArchiveMap[symbol];
        // Never archive a failed (all-zero) fetch — it would write a permanent zero row into
        // derivatives_history and pollute future training data. Gate un-stamped so it retries.
        if ((!lastArchive || Date.now() - lastArchive > 3.5 * 3600 * 1000) && !(markPrice === 0 && openInterest === 0)) {
          const ts = Math.floor(Date.now() / 1000);
          try {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO derivatives_history (symbol, timestamp, funding_rate, open_interest, long_percent, taker_ratio, top_trader_long_pct, taker_buy_vol, taker_sell_vol, mark_price, index_price, basis_pct, large_buy_vol, large_sell_vol, large_buy_count, large_sell_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(symbol, ts, fundingRate, openInterest, longPct, takerRatio, topTraderLongPct, takerBuyVol, takerSellVol, markPrice, indexPrice, basisPct, largeBuyVol, largeSellVol, largeBuyCount, largeSellCount).run();
            derivArchiveMap[symbol] = Date.now();
          } catch {}
        }

        // Dense OI/price snapshot (~every 20 min) → oi_snapshots, for the homemade heatmap.
        // Fetch LIVE current OI (the 4H-stat `openInterest` above is too coarse) and pair it
        // with the live mark price, so ΔOI between snapshots can be attributed to the price it
        // was opened at — the raw material for estimating where liquidation levels cluster.
        const lastSnap = oiSnapMap[symbol];
        if (markPrice > 0 && (!lastSnap || Date.now() - lastSnap > 20 * 60 * 1000)) {
          try {
            const oiResp = await fetch(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`);
            const liveOI = oiResp.ok ? parseFloat(((await oiResp.json()) as any).openInterest) : 0;
            if (liveOI > 0) {
              await env.DB.prepare(
                'INSERT OR REPLACE INTO oi_snapshots (symbol, timestamp, open_interest, mark_price, funding_rate, long_percent, basis_pct) VALUES (?, ?, ?, ?, ?, ?, ?)'
              ).bind(symbol, Math.floor(Date.now() / 1000), liveOI, markPrice, fundingRate, longPct, basisPct).run();
              oiSnapMap[symbol] = Date.now();
            }
          } catch {}
        }

        // Order-book depth snapshot (~every 20 min) -> depth_snapshots. The third leg of the
        // homemade liquidation heatmap: oi_snapshots = where positions opened, liquidations =
        // where they died, depth = the resting walls in between. Non-backfillable (books are
        // ephemeral) - collected free going forward. limit=500 is fapi weight 10; 76 symbols
        // every 20 min is noise next to the derivative batch.
        const lastDepthSnap = depthSnapMap[symbol];
        if (!lastDepthSnap || Date.now() - lastDepthSnap > 20 * 60 * 1000) {
          try {
            const depthResp = await fetch(`${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=500`);
            if (depthResp.ok) {
              const book = await depthResp.json() as any;
              const d = summarizeDepth(book?.bids ?? [], book?.asks ?? []);
              if (d) {
                await env.DB.prepare(
                  'INSERT OR REPLACE INTO depth_snapshots (symbol, timestamp, mid, best_bid, best_ask, bid_05, ask_05, bid_1, ask_1, bid_2, ask_2, bid_span_pct, ask_span_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(symbol, Math.floor(Date.now() / 1000), d.mid, d.bestBid, d.bestAsk, d.bid05, d.ask05, d.bid1, d.ask1, d.bid2, d.ask2, d.bidSpanPct, d.askSpanPct).run();
                depthSnapMap[symbol] = Date.now();
              }
            }
          } catch {}
        }
      }
      const defaultMacro = { vix: vixValue, dxyAboveEma20 };

      const sentiment = isCrypto ? { fearGreedIndex, fearGreedZone, ethBtcRatio, ethBtcDelta6, basisPct } : undefined;
      const sectorETF = isCrypto ? null : sectorETFForSymbol(symbol);
      const sectorCandles = sectorETF ? (sectorETFCandlesMap[sectorETF] || []) as FullCandle[] : [];
      // TRAIN/SERVE SKEW FIX (2026-08-26, plan step 4.3). `evalTimeMs` defaults to `Date.now()`,
      // and nothing was passing it — but TRAINING passes the 4H bar's OPEN (`runBacktest.ts:487`).
      // The cron runs every minute against the last CLOSED bar, so `Date.now()` sits somewhere in
      // [T+4h, T+8h): the model was trained on one timestamp and served another, 4 to 8 hours later.
      //
      // That moves `hourBucket` (boundaries at ET 8/14/21) on most bars, and moves `dayOfWeek` and
      // `isWeekend` on every bar whose window straddles an ET midnight. `dayOfWeek` is crypto's TOP
      // permutation feature (+0.048), and `news_catalyst_test` measured BTC goodR swinging 34pp
      // across days of the week — so this is skew on the single temporal input the model leans on
      // hardest, not a rounding detail.
      //
      // Passing the last closed 4H bar's open time reproduces the training semantics exactly.
      const evalTimeMs = fourHCandles.length ? fourHCandles[fourHCandles.length - 1].time : Date.now();
      const features = computeAllFeatures(candles as FullCandle[], fourHCandles, oneHCandles, isCrypto, derivSignals, defaultMacro, sentiment, prevSnapshots[symbol], spyCandles, isCrypto ? undefined : darkPoolData[symbol], iwmCandles as FullCandle[], sectorCandles, dxyCandles as FullCandle[], vix3mPrice, symbol, evalTimeMs);

      // Save snapshot for next cron's rate-of-change deltas + acceleration
      const ps = prevSnapshots[symbol];
      const prevFundingHist = ps?.fundingHist || [];
      const newFundingHist = isCrypto ? [...prevFundingHist, derivSignals.fundingRateRaw || 0].slice(-4) : [];
      // v9 single-model: direction-agnostic goodR probability
      const mlProb = mlPredict(features as Record<string, number>, isCrypto);
      // 72h persistence: probability of >= 2.5 ATR favorable move within 72h.
      // Different question than mlProb — runner-hold confidence vs trade-quality gate.
      const mlProbH72 = mlPredictH72(features as Record<string, number>, isCrypto);
      // Big-move/tail head: P(>=4 ATR move in 24h). The dedicated huge-move gauge ML_WIN
      // can't be (ML_WIN targets >=1.5 ATR). Crypto-only → null for stocks. See ml-predict.ts.
      const mlBigMove = mlPredictTail(features as Record<string, number>, isCrypto);

      newSnapshots[symbol] = {
        dRsi: features.dRsi, dAdx: features.dAdx,
        hRsi: features.hRsi, hAdx: features.hAdx, hMacdHist: features.hMacdHist,
        hRsiD1: ps ? features.hRsi - ps.hRsi : 0,
        hMacdD1: ps ? features.hMacdHist - ps.hMacdHist : 0,
        dRsiD1: ps ? features.dRsi - ps.dRsi : 0,
        dAdxD1: ps ? features.dAdx - ps.dAdx : 0,
        fundingHist: newFundingHist,
        mlProb,
      };

      // Capture prediction for the batched ml_preds:all blob written at the end of the
      // symbol pass. Per-symbol KV writes were the dominant Cloudflare cost — 76 crypto
      // symbols × every minute × 5-min TTL = ~3.3M writes/month, 60% of the bill. The
      // batched blob is ~110KB (well under the 25MB KV value limit) and writes once per
      // cron instead of 76 times.
      // probabilityH72 is the runner-hold persistence score; kept alongside the existing
      // `probability` field so old iOS clients can ignore it cleanly (additive change).
      mlPredBatch[symbol] = { symbol, probability: mlProb, probabilityH72: mlProbH72, bigMoveProb: mlBigMove, features, timestamp: Date.now(), isCrypto };

      // Debug: dump features for comparison with iOS
      if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT' || symbol === 'TSLA' || symbol === 'NVDA') {
        await env.ALERTS.put(`debug:${symbol.toLowerCase()}_features`, JSON.stringify({ features, mlProbability: mlProb }), { expirationTtl: 3600 });
      }

      const prevMl = ps?.mlProb;
      // EDGE vs LEVEL (2026-08-06). This used to be a pure rising edge —
      //   prevMl !== undefined && prevMl < ML_THRESHOLD && mlProb >= ML_THRESHOLD
      // — which made the proactive analysis fire at most ONCE per excursion above the threshold.
      // ML only moves on a 4H close, so if it crossed 70 and then sat there for a day, there was
      // exactly one eligible tick; a setup that materialised six hours later (envelope clearing, a
      // level coming into play) got no analysis and no push, ever. That is the reported "app
      // generates setups but I'm not notified in time, or at all": the trigger answered "did
      // volatility just jump?" while the user needs "does a setup exist now?".
      //
      // Now it is a LEVEL: every tick with ML at or above the threshold is eligible. Nothing here
      // spams, because the two existing cost guards do the bounding and they are unchanged — the
      // 3.5h `notif_claims` claim per (push_token, symbol), and the 3.5h `autorun:<symbol>` KV guard
      // inside runAutoAnalysis. Worst case is still ~one LLM run per symbol per 3.5h. And since
      // 2026-07-14 the push itself only fires when the analysis actually yields a SETUP, so the
      // setup gate — not the ML threshold — is what keeps notifications quiet. Widening the trigger
      // buys coverage, not noise.
      // Log-only rising edge, on the SAME calibrated scale as the gate (2026-08-21). Comparing
      // raw prevMl/mlProb against a now-calibrated ML_THRESHOLD meant the "crossed up" line fired
      // on ticks unrelated to when the gate actually opened — so an operator grepping the box logs
      // for the deciding tick found nothing.
      const prevNotifyProb = prevMl !== undefined ? calibratedNotifyProb(prevMl, isCrypto) : undefined;
      // Gate on the CALIBRATED probability (2026-08-14), matching what the Conviction Envelope has
      // used since 2026-07-02. Leaving the notify threshold on raw meant the two disagreed: the
      // envelope would judge a bar tradeable on a corrected number while the notification never
      // fired because the raw one sat below 70. With the live curve compressed (the 30-50 bucket
      // realising ~65%), raw systematically under-reads — which is exactly "we routinely miss moves".
      const notifyProb = calibratedNotifyProb(mlProb, isCrypto);
      const crossed = notifyProb >= ML_THRESHOLD;
      const risingEdge = prevNotifyProb !== undefined && prevNotifyProb < ML_THRESHOLD && notifyProb >= ML_THRESHOLD;
      if (risingEdge) console.log(`[notify] ${symbol} calibrated ML crossed up through ${Math.round(ML_THRESHOLD * 100)}% (calibrated ${Math.round(notifyProb * 100)}%, raw ${Math.round(mlProb * 100)}%)`);

      // Last 4H bar for pending-setup entry-touch detection. Defensive fallback to 0
      // if candles disappeared — the device-pass code handles 0 by skipping the check.
      const last4H = fourHCandles[fourHCandles.length - 1];
      const last4HHigh = last4H?.high ?? 0;
      const last4HLow = last4H?.low ?? 0;
      // Live tick for entry-zone detection (2026-08-08). The rest of the pipeline is closed-bar on
      // purpose — ML features must match how the model was trained — but that made "has price
      // reached my entry?" answerable only at a 4H CLOSE. A setup does not become actionable on the
      // candle boundary: price can enter the zone at 10:15 and the old check would not see it until
      // 12:00, up to ~4h late (and would miss it entirely if price left the zone before the close).
      // Fetched ONLY for symbols that actually have a live pending setup — `pendingSetupSymbols` is
      // typically 0-3 — so this is a handful of ticks per cron, not one per archive symbol.
      let livePrice: number | null = null;
      if (pendingSetupSymbols.has(symbol)) {
        try { livePrice = await fetchLivePrice(symbol, isCrypto); } catch { /* best-effort */ }
      }
      const last4HClose = last4H?.close ?? 0;
      const atrPrice = (features.atrPercent / 100) * last4HClose;

      // Per-timeframe bias labels for the notification direction primitive — from the
      // faithful iOS-port scorer, so the gate reads the same labels the app displays.
      // (Until 2026-08-21 this used the simplified computeScore, whose RSI-overbought
      // penalty read the strongest rallies as Neutral/Bearish — see notificationBiasAlignment.)
      const biasAlignment = notificationBiasAlignment(candles as FullCandle[], fourHCandles as FullCandle[], isCrypto, symbol);

      // Phase 1/2 heads (crypto-only): direction-conditioned triple-barrier meta prob,
      // adaptive-TP2 q75, and the conformal `confident` gate. Additive — served by
      // /ml-predict alongside the existing probability; current prompt/notify behaviour
      // is unchanged until the app reads them. metaDirection = the union(bias, dStoch)
      // the meta head was conditioned on (so the app knows which side it scored).
      const metaDirection = notificationDirection(biasAlignment, features.dStochCross || 0);
      const probabilityMeta = mlPredictMeta(features as Record<string, number>, isCrypto, metaDirection);
      const q75 = mlPredictQuantile(features as Record<string, number>, isCrypto, '0.75');
      const confident = mlConfident(probabilityMeta, isCrypto);
      // Calibrated P(up 24h) — the dedicated direction model. Beats the indicator
      // heuristics (holdout: ~80% acc full-coverage, ~95% at pUp>=0.70, conditional on
      // high ML); crypto only. Direction-agnostic input (no tradeDir).
      const pUp = mlPredictDirection(features as Record<string, number>, isCrypto);
      mlPredBatch[symbol].probabilityMeta = probabilityMeta;
      mlPredBatch[symbol].q75 = q75;
      mlPredBatch[symbol].confident = confident;
      mlPredBatch[symbol].metaDirection = metaDirection;
      mlPredBatch[symbol].pUp = pUp;

      // Phase 5: compute risk states from the feature dict; detect transitions INTO a HIGH
      // validated state since last tick (the notification trigger).
      const states = computeRiskStates({
        isCrypto,
        atrPercentile: features.atrPercentile,
        bbSqueezeDaily: (features.dBBSqueeze ?? 0) > 0.5, bbSqueeze4h: (features.hBBSqueeze ?? 0) > 0.5,
        bbPercentBDaily: features.dBBPercentB ?? null,
        longPct: isCrypto ? features.longPctRaw : null,
        fundingZ: isCrypto ? (features.fundingRateRaw ?? 0) * 4000 : null,   // raw rate → heuristic z
        oiChangePct: isCrypto ? features.oiChangePct : null,
      });
      const highValidated = states.filter(s => s.severity === 'HIGH' && s.validated).map(s => s.state);
      const prevHigh = prevRiskStates[symbol]?.high ?? [];
      const newHighStates = highValidated.filter(s => !prevHigh.includes(s));
      curRiskStates[symbol] = { names: states.map(s => s.state), high: highValidated,
        detail: Object.fromEntries(states.map(s => [s.state, s.detail])) };

      // ── Envelope precheck: only page the user when the analysis could actually trade ──
      // Evaluated for any symbol that could page this tick: an ML rising-edge (or a prior cross
      // sitting suppressed), a new HIGH risk-state transition, or a live pending setup whose
      // entry zone could be touched. ONE verdict gates all three push types in the device pass.
      let wasSuppressed = suppressedMap[symbol] !== undefined;
      // A detached runAutoAnalysis may have re-armed this cross AFTER the symbol pass last wrote the
      // shared blob (it decided not to push — no setup / failure — and handed the signal back). It
      // writes a per-symbol key to avoid racing the blob, so fold that in here and adopt it into the
      // map, which persists it and makes the rest of the machinery (cancel-on-fade, 24h prune)
      // work unchanged. Guarded by the ML/direction preconditions so this costs one extra KV read
      // only for the handful of symbols that could actually page.
      if (!wasSuppressed && notifyProb >= ML_THRESHOLD && metaDirection !== 0) {
        try {
          if (await env.ALERTS.get(`notif_resuppress:${symbol}`)) {
            wasSuppressed = true;
            suppressedMap[symbol] = Date.now();
            console.log(`[notify] ${symbol} re-armed cross adopted from a deferred auto-analysis`);
          }
        } catch { /* best-effort — a missed re-arm degrades to the old drop, never to a false page */ }
      }
      const crossCandidate = notifyProb >= ML_THRESHOLD && (crossed || wasSuppressed) && metaDirection !== 0;
      let envelopeFlat: boolean | null = null;
      let envelopeReasons: string[] | null = null;
      if (crossCandidate || newHighStates.length > 0 || pendingSetupSymbols.has(symbol)) {
        const memoKey = `${symbol}:${last4H?.time ?? 0}:${Math.round(mlProb * 1000)}`;
        let reasons: string[] | null;
        if (precheckMemo.has(memoKey)) {
          reasons = precheckMemo.get(memoKey)!;
        } else {
          reasons = await envelopePrecheck(env, symbol, isCrypto, mlProb, candles as ScoreCandle[], fourHCandles as FullCandle[], oneHCandles as FullCandle[], await econEvents(), calForPrecheck(mlProb, isCrypto));
          // Cache VERDICTS only. `null` is the failure sentinel and is fail-OPEN downstream, so
          // memoizing it would freeze one transient KV/compute hiccup as "envelope clear" for the
          // rest of the bar — paging the user and burning a Sonnet-5 auto-analysis on a bar that
          // genuinely auto-FLATs. Before the memo this self-healed on the next 60s tick; retrying
          // on failure keeps that property while still collapsing the 1,440 -> ~24 successful runs.
          if (reasons !== null) precheckMemoSet(memoKey, reasons);
        }
        envelopeReasons = reasons;
        envelopeFlat = reasons === null ? null : reasons.length > 0;
        if (envelopeFlat) console.log(`[notify] ${symbol} envelope would auto-FLAT (${(reasons ?? []).join(', ')}) — proactive pushes gated`);
      }

      // ML-cross suppression transition (defer-not-drop): a suppressed cross re-checks every
      // tick and fires the moment the envelope clears with ML still >= threshold; it cancels
      // silently if ML fades below threshold first, and expires after 24h.
      let effectiveCross = crossed;
      // TWO deferral stores, cleared on DIFFERENT conditions — conflating them was a real bug
      // (2026-08-06). `suppressedMap` (blob) holds an ENVELOPE-precheck deferral: the envelope
      // clearing resolves it, because the push fires on that very tick. `notif_resuppress:<sym>`
      // (key) holds an AUTO-ANALYSIS deferral: the enriched analysis ran and produced no setup, and
      // only a LATER analysis producing one can resolve that — the envelope clearing says nothing
      // about it.
      //
      // Clearing both on envelope-clear meant the auto-analysis deferral lived exactly one tick,
      // and that tick was guaranteed to be swallowed by runAutoAnalysis's own 3.5h `autorun:<sym>`
      // guard (set when the first attempt ran) — so it returned silently, and by the next tick the
      // deferral was already gone. Net effect: the cross was still dropped, one tick later than
      // before the "fix". The key now persists until a push actually happens (runAutoAnalysis
      // deletes it), ML fades, or its 24h TTL expires — so when the claim and the autorun guard
      // both lapse at ~3.5h, the analysis genuinely re-runs and can page.
      const clearBlobDeferral = () => { delete suppressedMap[symbol]; };
      const clearAllDeferrals = async () => {
        delete suppressedMap[symbol];
        try { await env.ALERTS.delete(`notif_resuppress:${symbol}`); } catch { /* best-effort */ }
      };
      if (crossCandidate) {
        const next = nextSuppressionState({ crossed, wasSuppressed, flat: envelopeFlat });
        effectiveCross = next.effectiveCross;
        if (next.suppressed) {
          if (!wasSuppressed) suppressedMap[symbol] = Date.now();
        } else if (wasSuppressed) {
          clearBlobDeferral();   // NOT the key — see above
          if (effectiveCross) console.log(`[notify] ${symbol} envelope cleared — deferred notification firing`);
        }
      } else if (wasSuppressed && notifyProb < ML_THRESHOLD) {
        await clearAllDeferrals();   // the signal faded while suppressed — cancel, don't page
        console.log(`[notify] ${symbol} suppressed cross cancelled (ML faded to ${Math.round(mlProb * 100)}%)`);
      }

      // Gate telemetry (2026-08-08). The notify chain is a conjunction of five conditions and
      // silence looks identical whichever one is false — which is why "I get no notifications" took
      // several rounds of hypothesis to chase. Record what each gate ACTUALLY decided this tick
      // (not a re-derivation after the fact) and serve it from GET /notify-debug. One small blob per
      // cron, same batched-write discipline as the other per-cron KV writes.
      notifyDebug[symbol] = {
        at: Date.now(),
        ml: Math.round(mlProb * 1000) / 10,
        mlCalibrated: Math.round(notifyProb * 1000) / 10,
        mlThreshold: ML_THRESHOLD * 100,
        mlPasses: notifyProb >= ML_THRESHOLD,
        biasAlignment,
        dStochCross: features.dStochCross || 0,
        direction: metaDirection,                       // 0 = bias/Stoch conflict → blocked
        directionPasses: metaDirection !== 0,
        envelopeChecked: envelopeReasons !== null || envelopeFlat !== null,
        envelopeFlat,                                   // null = precheck errored (fails OPEN)
        envelopeReasons,                                // the AI's own auto-FLAT list
        deferred: wasSuppressed,
        eligible: crossCandidate && envelopeFlat !== true,
      };

      predictions.set(symbol, {
        symbol,
        isCrypto,
        mlProb,
        notifyProb,
        dailyScore: features.dailyScore,
        crossed: effectiveCross,
        envelopeFlat,
        dStochCross: features.dStochCross || 0,
        biasAlignment,
        last4HHigh,
        last4HLow,
        livePrice,
        last4HClose,
        atrPrice,
        pUp,
        riskStateNames: states.map(s => s.state),
        newHighStates,
      });

      // Calibration log: sample this symbol's ML Win at most once per ~20h.
      if (atrPrice > 0 && last4HClose > 0 && (nowCal - (calLogged[symbol] || 0) >= CAL_LOG_INTERVAL_MS)) {
        calInserts.push(env.DB.prepare(
          `INSERT INTO ml_calibration (symbol, is_crypto, logged_at, entry_price, atr_price, predicted_prob, resolve_at, resolved)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
        ).bind(symbol, isCrypto ? 1 : 0, nowCal, last4HClose, atrPrice, mlProb, nowCal + CAL_HORIZON_MS));
        calLogged[symbol] = nowCal;
      }
      // Envelope forward log: one sample per symbol per ~20h. Runs the REAL prompt builder via
      // `envelopePrecheck`, so the tier recorded is the tier production would emit — the whole point
      // of the exercise is that this is not a reconstruction.
      if (isCrypto && fourHCandles.length >= 210 && (nowCal - (envSigLogged[symbol] || 0)) >= ENV_SIG_INTERVAL_MS) {
        // Same arguments the notify path uses, including the real economic events — the recorded
        // tier has to be the tier production would emit, and passing `[]` would silently switch the
        // macro conditions off in every logged row.
        const flatReasons = await envelopePrecheck(env, symbol, isCrypto, mlProb,
          candles as ScoreCandle[], fourHCandles as FullCandle[], oneHCandles as FullCandle[],
          await econEvents(), calForPrecheck(mlProb, isCrypto));
        const v = lastEnvelopeVerdict;
        if (flatReasons !== null && v && v.symbol === symbol) {
          const px = fourHCandles[fourHCandles.length - 1].close;
          const atrPx = (features.atrPercent / 100) * px;
          if (px > 0 && atrPx > 0) {
            envSigInserts.push(env.DB.prepare(
              `INSERT INTO envelope_signals (symbol, is_crypto, logged_at, entry_price, atr_price,
                 max_allowed, aligned_direction, ml_raw, ml_calibrated, auto_flat, high_blocks,
                 moderate_blocks, resolve_at, resolved)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
            ).bind(symbol, nowCal, px, atrPx, v.maxAllowed, v.alignedDirection,
                   v.rawMlPct, v.mlPct, v.autoFlat, v.highBlocks, v.moderateBlocks,
                   nowCal + ENV_SIG_HORIZON_MS));
            envSigLogged[symbol] = nowCal;
          }
        }
      }
      // Envelope grade: direction-agnostic favourable AND adverse excursion in ATR units over the
      // horizon. Both are stored because the envelope's own claim is direction-agnostic — it gates
      // "is this bar tradeable", not "which way" — and keeping the adverse leg is what lets a later
      // analysis ask whether a tier that admitted a big move admitted it on the RIGHT side.
      const envDue = envSigDueBySymbol.get(symbol);
      if (envDue && fourHCandles.length) {
        for (const row of envDue) {
          let maxHigh = -Infinity, minLow = Infinity;
          for (const c of fourHCandles) {
            const t = (c as { time?: number }).time ?? 0;
            if (t > row.logged_at && t <= row.logged_at + ENV_SIG_HORIZON_MS) {
              if (c.high > maxHigh) maxHigh = c.high;
              if (c.low < minLow) minLow = c.low;
            }
          }
          if (maxHigh === -Infinity || row.atr_price <= 0) continue;
          const favR = (maxHigh - row.entry_price) / row.atr_price;
          const advR = (row.entry_price - minLow) / row.atr_price;
          envSigUpdates.push(env.DB.prepare(
            'UPDATE envelope_signals SET resolved = 1, fav_r = ?, adv_r = ? WHERE id = ?'
          ).bind(favR, advR, row.id));
        }
      }
      // Calibration grade: any due rows for this symbol → max excursion over [logged, resolve]
      // from the 4H candle history (direction-agnostic, matches the goodR target).
      const due = calDueBySymbol.get(symbol);
      if (due && fourHCandles.length) {
        for (const row of due) {
          let maxHigh = -Infinity, minLow = Infinity;
          for (const c of fourHCandles) {
            const t = (c as { time?: number }).time ?? 0;
            if (t > row.logged_at && t <= row.logged_at + CAL_HORIZON_MS) {
              if (c.high > maxHigh) maxHigh = c.high;
              if (c.low < minLow) minLow = c.low;
            }
          }
          if (maxHigh === -Infinity || row.atr_price <= 0) continue;  // no bars yet — grade next cron
          const favR = Math.max(maxHigh - row.entry_price, row.entry_price - minLow) / row.atr_price;
          calUpdates.push(env.DB.prepare(
            'UPDATE ml_calibration SET resolved = 1, fav_r = ?, good_r = ? WHERE id = ?'
          ).bind(favR, favR >= CAL_GOODR_ATR ? 1 : 0, row.id));
        }
      }
    } catch (e) {
      console.log(`[score] ${symbol} error: ${e}`);
    }
  }

  // Flush calibration inserts/updates + the per-symbol log gate (batched, once per cron).
  try {
    if (calInserts.length) await env.DB.batch(calInserts);
    if (calUpdates.length) await env.DB.batch(calUpdates);
    if (calInserts.length) await env.ALERTS.put('cal_logged:all', JSON.stringify(calLogged), { expirationTtl: 86400 * 3 });
    if (envSigInserts.length || envSigUpdates.length) {
      try {
        if (envSigInserts.length) await env.DB.batch(envSigInserts);
        if (envSigUpdates.length) await env.DB.batch(envSigUpdates);
        if (envSigInserts.length) await env.ALERTS.put('envsig_logged:all', JSON.stringify(envSigLogged), { expirationTtl: 86400 * 3 });
        console.log(`[envsig] +${envSigInserts.length} logged, ${envSigUpdates.length} graded`);
      } catch (e) { console.log(`[envsig] write err ${e}`); }
    }
    if (calInserts.length || calUpdates.length) console.log(`[cal] +${calInserts.length} logged, ${calUpdates.length} graded`);
  } catch (e) { console.log(`[cal] flush err ${e}`); }

  // Save ML snapshots for next cron's rate-of-change deltas
  // Suppression map: prune stale entries (a >24h-old suppressed cross is no longer meaningful).
  for (const [sym, since] of Object.entries(suppressedMap)) {
    if (Date.now() - (since as number) > SUPPRESS_EXPIRY_SEC * 1000) delete suppressedMap[sym];
  }
  await env.ALERTS.put('notif_suppressed:all', JSON.stringify(suppressedMap), { expirationTtl: SUPPRESS_EXPIRY_SEC });
  await env.ALERTS.put('notify_debug:all', JSON.stringify(notifyDebug), { expirationTtl: 900 }).catch(() => {});
  await env.ALERTS.put('ml_snapshots', JSON.stringify(newSnapshots), { expirationTtl: 86400 });

  // Batched KV blobs written once per cron in place of 4-5 × 76 per-symbol writes.
  // 5-min TTL on ml_preds:all and candles:all:<interval> preserves the "drop out of
  // cache when cron stops" behaviour the per-symbol blobs had; prev_oi:all and
  // deriv_archive:all use longer TTLs since they're internal state that should survive
  // cron-cycle gaps. Candle blobs only flush when at least one symbol was missing —
  // saves writes during the ~4 of 5 crons where everything hits cache.
  await env.ALERTS.put('ml_preds:all', JSON.stringify(mlPredBatch), { expirationTtl: 300 });
  // Phase 5: persist current risk states (powers /risk-states + next-tick transition detection).
  // No TTL on the comparison set — a stale blob would just suppress a duplicate notification.
  try { await env.ALERTS.put('risk_states:all', JSON.stringify(curRiskStates)); } catch { /* ignore */ }
  await env.ALERTS.put('prev_oi:all', JSON.stringify(prevOIMap), { expirationTtl: 86400 });
  await env.ALERTS.put('deriv_archive:all', JSON.stringify(derivArchiveMap), { expirationTtl: 14400 });
  await env.ALERTS.put('deriv_live:all', JSON.stringify(derivLiveMap), { expirationTtl: 86400 });
  await env.ALERTS.put('oi_snap:all', JSON.stringify(oiSnapMap), { expirationTtl: 14400 });
  await env.ALERTS.put('depth_snap:all', JSON.stringify(depthSnapMap), { expirationTtl: 14400 });
  if (candlesDirty['1d']) await env.ALERTS.put('candles:all:1d', JSON.stringify(candles1dMap), { expirationTtl: 300 });
  if (candlesDirty['4h']) await env.ALERTS.put('candles:all:4h', JSON.stringify(candles4hMap), { expirationTtl: 300 });
  if (candlesDirty['1h']) await env.ALERTS.put('candles:all:1h', JSON.stringify(candles1hMap), { expirationTtl: 300 });

  return predictions;
}

// Automated analysis (2026-07-14): when a watchlisted symbol's ML cross has cleared the direction
// gate, the envelope precheck, AND the 3.5h cooldown claim, run the FULL LLM analysis server-side
// and push its Bottom Line — replacing the bare "ML 73%" ping — instead of making the user open the
// app and spend a call to see it. It also registers the resulting setups into tracked_setups
// (autonomous outcome tracking) and caches the result for the app to pick up on open.
//
// Runs DETACHED (the caller does `void runAutoAnalysis(...)` — the box is a persistent Node process,
// so this outlives the cron pass; a 30-90s LLM call must NEVER be awaited inside the minute cron).
// Model is fixed to Sonnet 5 + extended thinking (the user's standing pick — auto-runs don't see the
/** Folds D1's real per-symbol last-archive times (SECONDS) into the KV gate map (MILLISECONDS),
 *  keeping whichever is LATER. Mutates and returns `kvMap`. Taking the max is what makes an evicted
 *  or half-flushed KV blob harmless: the worst case becomes "trust D1" rather than "re-archive
 *  everything". Exported for tests — the unit mismatch here is exactly the kind of thing that fails
 *  silently (a seconds value compared against ms reads as 1970 and never gates anything). */
export function mergeDerivArchiveGate(
  kvMap: Record<string, number>,
  rows: Array<{ symbol: string; ts: number }>,
): Record<string, number> {
  for (const r of rows) {
    if (!r?.symbol) continue;
    const d1Ms = Number(r.ts) * 1000;
    if (Number.isFinite(d1Ms) && d1Ms > (kvMap[r.symbol] ?? 0)) kvMap[r.symbol] = d1Ms;
  }
  return kvMap;
}

/** Pushes when an analysis CREATES a setup — the user-facing trigger, independent of the ML-cross
 *  machinery. Detached (`void`) by the caller so a slow APNs round-trip never delays the analysis
 *  response. Never throws. */
async function notifySetupCreated(
  env: Env, deviceId: string, symbol: string, setups: any[], analysisText: string,
): Promise<void> {
  try {
    const pushToken = await getPushToken(env, deviceId);
    if (!pushToken) { console.log(`[setup-notify] ${symbol} no push token for ${deviceId}`); return; }
    const s = setups[0] || {};
    const dir = String(s.direction ?? '').toUpperCase();
    // Identity, not time: the same setup re-analysed stays quiet, a different one always pages.
    const sig = `${symbol}:${dir}:${Number(s.entry ?? 0).toPrecision(6)}:${Number(s.stopLoss ?? 0).toPrecision(6)}`;
    const dedupeKey = `setupnotif:${pushToken}:${sig}`;
    if (await env.ALERTS.get(dedupeKey)) { console.log(`[setup-notify] ${symbol} duplicate setup — suppressed`); return; }

    const name = symbol.replace('USDT', '');
    const m = analysisText.match(/##\s*Bottom Line\s*\n([\s\S]*?)(?:\n##\s|\n---|\n```|$)/i);
    const bl = m ? m[1].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim() : '';
    const entryStr = Number(s.entry) < 10 ? Number(s.entry).toFixed(4) : Number(s.entry).toFixed(2);
    const title = `${name} ${dir} setup · entry ${entryStr}`;
    const body = bl.length ? bl.slice(0, 178)
                           : `A risk-defined ${dir} setup is on the table — open to act.`;
    const sent = await sendAPNs(env, pushToken, title, body);
    if (sent === 'unregistered') { await deleteDevice(env, deviceId); return; }
    await env.ALERTS.put(dedupeKey, '1', { expirationTtl: 6 * 60 * 60 }).catch(() => {});
    console.log(`[setup-notify] ${symbol} ${dir} setup push sent (${sent})`);
  } catch (e) {
    console.log(`[setup-notify] ${symbol} failed: ${e}`);
  }
}

/** Hands a consumed-but-unpushed ML cross BACK to the defer-not-drop machinery: releases the
 *  `notif_claims` claim the cross burned and re-arms suppression via a per-symbol key, so the symbol
 *  pass adopts it next tick and pages the moment a setup appears. Never throws — failed bookkeeping
 *  degrades to the old drop, never to a false page. Exported for tests. */
export async function deferAutoAnalysisCross(env: Env, pushToken: string, symbol: string, why: string): Promise<void> {
  try {
    // Deliberately does NOT release the notif_claims claim (2026-08-08). Releasing it caused a
    // DOUBLE TRIGGER: the analysis takes 30-90s, deferring dropped the claim, and the very next
    // cron tick re-claimed and logged a second trigger ~1 minute after the first — visible as
    // paired rows in `notifications` (ADA 18:00:42 + 18:02:08, SOL 18:00:16 + 18:01:09). It always
    // stopped at two because the second attempt hit the 3.5h `autorun:<sym>` guard and returned
    // without deferring. Harmless while a no-setup analysis sent nothing, but it would double-page
    // the moment favourable-conditions pushes exist.
    //
    // Leaving the claim in place gives exactly the retry cadence we want for free: it and the
    // autorun guard are both 3.5h, so they lapse together and the next tick does a REAL retry. The
    // resuppress key below is what keeps `wasSuppressed` true meanwhile, so the retry doesn't need
    // a fresh ML cross to become eligible again.
    await env.ALERTS.put(`notif_resuppress:${symbol}`, String(Date.now()), { expirationTtl: SUPPRESS_EXPIRY_SEC });
    console.log(`[autorun] ${symbol} no push (${why}) — cross re-armed, retry when the 3.5h claim + guard lapse`);
  } catch (e) {
    console.log(`[autorun] ${symbol} defer bookkeeping failed: ${e}`);
  }
}

// per-request model the app normally sends). Dedup-guarded per SYMBOL (`autorun:<sym>`, cooldown TTL)
// so multi-device / cron re-entrancy can't double-spend. When it decides NOT to push, the cross is
// DEFERRED back to the suppression machinery rather than dropped — see `deferAutoAnalysisCross`.
async function runAutoAnalysis(
  env: Env, symbol: string, isCrypto: boolean, deviceId: string, pushToken: string, mlProb: number,
  notifyProb?: number,
): Promise<void> {
  // User-facing copy and band decisions quote the CALIBRATED number — the one the gate actually
  // used. Quoting raw produced pushes like "ML 41% with agreeing signals" for a cross that passed
  // at calibrated 66%, which reads as a malfunction.
  const calProb = notifyProb ?? mlProb;
  const mlPct = Math.round(calProb * 100);
  // ── Defer-not-drop, part 2 (2026-07-24 fix) ──────────────────────────────────────────────────
  // The caller consumed the cross before knowing whether we'd push: `crossed` is a single-tick
  // rising edge (prevMl < 0.70 && mlProb >= 0.70) and the notif_claims claim is taken as a
  // PRECONDITION of queueing. So every silent return below used to DROP a real signal — the exact
  // failure the 2026-05-30 notify-window lesson and the 2026-07-11 precheck were built to prevent.
  // The precheck defers correctly; this later, enrichment-aware gate did not (and it's the one that
  // sees the auto-FLAT contributors the precheck structurally cannot — funding kills et al, which
  // is why the precheck "can only UNDER-suppress").
  //
  // So: release the claim this cross consumed and re-arm suppression, letting the symbol pass
  // re-check every tick and page the moment a setup appears with ML still >= threshold (cancelled
  // for free if ML fades, expired after SUPPRESS_EXPIRY_SEC). A PER-SYMBOL key, not the shared
  // `notif_suppressed:all` blob: this runs DETACHED, so read-modify-write on the shared blob would
  // race the symbol pass that owns it and lose updates. The `autorun:<sym>` guard bounds the LLM
  // cost to one real run per symbol per cooldown window; between runs the retry costs nothing.
  const deferCross = (why: string) => deferAutoAnalysisCross(env, pushToken, symbol, why);
  try {
    // Per-symbol dedup: at most one auto-run per cooldown window across devices / overlapping crons.
    // Deliberately does NOT defer — a concurrent (or recent) invocation owns this symbol's window
    // and its own deferral state; releasing its claim here would fight it.
    const guardKey = `autorun:${symbol}`;
    if (await env.ALERTS.get(guardKey)) return;   // already handled this window — no duplicate work or push
    await env.ALERTS.put(guardKey, String(Date.now()), { expirationTtl: NOTIFY_COOLDOWN_SEC });

    // The real analysis pipeline — same one /full-analysis runs. Registers setups + persists the
    // SINCE-LAST-ANALYSIS baseline internally. Fixed to Sonnet 5 + extended thinking.
    const r = await runFullAnalysisCore(env, symbol, isCrypto,
      { provider: 'claude', model: 'claude-sonnet-5', thinkingBudget: 8000 }, deviceId);
    if (!r.ok || !r.result?.analysis) { await deferCross('analysis failed'); return; }

    // Cache the full result so the app can show it instantly on open (iOS pickup is the fast-follow),
    // regardless of whether we notify.
    await env.ALERTS.put(`autoanalysis:${symbol}`,
      JSON.stringify({ result: r.result, at: Date.now(), deviceId }), { expirationTtl: 3600 }).catch(() => {});

    // ── THE GATE (2026-07-14): only page the user when the enriched analysis actually produced a
    // trade SETUP. An ML cross that opens into no setup — envelope auto-FLAT under enrichment, no
    // clean risk-defined level, or a setup the geometry guard dropped — is exactly the "notification
    // that leads nowhere" the user asked to stop. The enrichment-free precheck can only under-suppress;
    // THIS is the ground-truth gate (the real analysis said trade-or-not). No setup → suppress silently.
    const setups = Array.isArray(r.result.setups) ? r.result.setups : [];
    // ── FAVOURABLE CONDITIONS, no setup (2026-08-08) ──────────────────────────────────────────
    // Every precondition the AI uses passed — ML >= 70, bias and Stoch agree, and the envelope
    // precheck was clean — but the enriched analysis still declined. That is worth telling the
    // user, and it is what they asked for: notify on favourable conditions, not only on a completed
    // setup. Measured on this box, the cron produced ~11 FLATs to 0 setups over three days, so
    // gating purely on a setup meant the proactive path essentially never fired.
    //
    // This DOES reverse the 2026-07-14 "no setup → suppress silently" decision, deliberately and
    // with the thing that made those pushes useless fixed: the old ones said "ML 73%" and led
    // nowhere, so the user learned to distrust them. This one carries the model's own Bottom Line —
    // the REASON it declined — which is actionable ("chase into extended trend", "waiting for a
    // retest") rather than noise. Volume is bounded by the same 3.5h claim + autorun guard, so it
    // is at most one per symbol per 3.5h.
    if (setups.length === 0) {
      await deferCross('no setup');
      // MANDATE BAND (2026-08-21). At/above MANDATE_ML_PCT the envelope tells the model a setup is
      // MANDATORY, so arriving here means either the model ignored the directive or it emitted a
      // prose table the JSON contract dropped — both indistinguishable downstream and both the exact
      // failure this machinery exists to prevent. Log it loudly so recurrence is greppable instead of
      // requiring another manual replay session to diagnose. (The envelope can also legitimately
      // SUSPEND the mandate — stale data, earnings gap — which is why this is a log, not an alarm.)
      if (mlPct >= MANDATE_ML_PCT) {
        console.log(`[mandate-violation] ${symbol} calibrated ML ${mlPct}% >= ${MANDATE_ML_PCT} produced NO setup — window ignored, JSON contract dropped it, or the window was suspended (stale data / earnings)`);
      } else {
        // 65-69 band: BELOW the mandate, so a decline here is the expected, legitimate outcome
        // rather than news. Pushing it would generate up to one notification per watchlist symbol
        // per 3.5h of pure "nothing to do" — the volume that trained the user to ignore
        // notifications before the 2026-07-14 setup gate. Deferred silently; the cross stays armed
        // and pages the moment a setup appears or the calibrated value reaches the mandate band.
        console.log(`[autorun] ${symbol} no setup at calibrated ${mlPct}% (below the ${MANDATE_ML_PCT}% mandate band) — deferred, no push`);
        return;
      }
      try {
        const m = String(r.result.analysis).match(/##\s*Bottom Line\s*\n([\s\S]*?)(?:\n##\s|\n---|\n```|$)/i);
        const why = m ? m[1].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim() : '';
        const name = symbol.replace('USDT', '');
        await sendAPNs(env, pushToken,
          `${name} conditions favorable · no setup`,
          why.length ? why.slice(0, 178)
                     : `Move likelihood ${mlPct}% with agreeing signals, but the analysis found no risk-defined entry.`);
        console.log(`[autorun] ${symbol} favourable-conditions push sent (no setup)`);
      } catch (e) {
        console.log(`[autorun] ${symbol} favourable-conditions push failed: ${e}`);
      }
      return;
    }

    // The push itself is NOT sent here any more (2026-08-06). runFullAnalysisCore now notifies at
    // the moment a setup is REGISTERED — the one place every analysis path passes through — so
    // pushing again here would double-page for exactly the cron-triggered setups. What remains is
    // this path's own bookkeeping.
    // The cross is finally resolved — retire any auto-analysis deferral so the next tick doesn't
    // treat this symbol as still-pending. This is the ONLY place that key is cleared on success.
    try { await env.ALERTS.delete(`notif_resuppress:${symbol}`); } catch { /* best-effort */ }
    console.log(`[autorun] ${symbol} produced ${setups.length} setup(s) — push sent by the registration path (ML ${mlPct}%)`);
  } catch (e) {
    console.log(`[autorun] ${symbol} failed: ${e}`);   // never a false page — but never a lost cross either
    await deferCross('exception');
  }
}

// Device pass: reads device's watchlist from the precomputed predictions Map (no fresh
// candle/derivative fetches), writes per-(device, symbol) score_history, and applies
// per-device notification gating (notify-window + ML threshold + cooldown).
//
// Dedupe is an atomic D1 claim against `notif_claims` keyed by (push_token, symbol).
// Concurrent cron passes — which can overlap when a single pass exceeds the 60s cron
// interval — race through D1's primary region serializer; only one INSERT/UPDATE
// changes a row, the rest see `meta.changes === 0` and skip. Push_token (not device_id)
// is the key so rotated device_ids pointing at the same physical phone share a claim.
// (Pre-2026-05-05 the gate used `notif:<pushToken>:<symbol>` in KV which raced because
// KV is eventually consistent — two parallel readers both saw "no prior fire" and both
// fired, producing the duplicate APNs the user observed.)
async function processDeviceNotifications(
  env: Env,
  deviceId: string,
  watchlist: string[],
  predictions: Map<string, SymbolPrediction>,
) {
  const pushToken = await getPushToken(env, deviceId);
  const triggered: { symbol: string; score: number; mlProb: number; direction: string }[] = [];
  const now = Date.now();
  const expiresAt = now + NOTIFY_COOLDOWN_SEC * 1000;

  // Notify gate. Records score_history regardless (so the user's history endpoint sees
  // every cron), but only adds to triggered if all of: (a) the symbol just crossed up
  // through ML_THRESHOLD this cron, (b) the union direction primitive returns non-zero
  // (bias-aligned OR Stoch cross fired, conflicts skipped), and (c) the atomic D1 claim
  // succeeds. Continued elevation doesn't re-fire — paged once per crossing event.
  //
  // Direction primitive history:
  //   - Original: bias-aligned only. Backtest showed n=613 / +0.079R EV / +48R total
  //     on stocks across 4.4 years. Bias is a complex 6-layer score that's restrictive
  //     enough to miss most actionable setups on stocks (no derivatives/cross-asset
  //     layers like crypto has).
  //   - Brief detour (rolled back same day): bias AND Stoch — intersection dropped total
  //     R by 80% by requiring two redundant direction signals.
  //   - Current (2026-05-30): bias OR Stoch union, skip-on-conflict. Backtest captured
  //     12× more total R on stocks and 1.9× on crypto top-10, with per-trade EV nearly
  //     identical to bias-alone. See ml-training/direction_primitive_sweep.py for the
  //     full sweep vs 11 alternative primitives — union won both markets.
  for (const symbol of watchlist) {
    const pred = predictions.get(symbol);
    if (!pred) continue;
    // Phase 5: risk-state transition notification — fires once when a symbol newly enters a
    // HIGH *validated* state (COMPRESSION/EVENT_WINDOW: vol-grounded). Independent of the ML
    // cross below; 6h per-(token,symbol) cooldown. Honest "a big move may be brewing" heads-up.
    // Envelope-gated (2026-07-11): a COMPRESSION heads-up that opens into an auto-FLAT
    // analysis is a wasted page — and coiled/extended tape is exactly where the envelope
    // FLATs. Skipping drops this transition (prevHigh already recorded it) — acceptable for
    // an FYI push; the ML-cross path keeps its defer semantics for the actual signal.
    if (pushToken && pred.newHighStates && pred.newHighStates.length && pred.envelopeFlat !== true) {
      const cdKey = `riskstate-cd:${pushToken}:${symbol}`;
      if (!(await env.ALERTS.get(cdKey))) {
        const st = pred.newHighStates[0];
        const msg = st === 'COMPRESSION' ? 'vol compressed — a sharp move is more likely soon'
                  : st === 'EVENT_WINDOW' ? 'major event imminent — elevated event vol'
                  : 'elevated risk condition';
        const disp = symbol.endsWith('USDT') ? symbol.replace('USDT', '') : symbol;
        await sendAPNs(env, pushToken, `${disp}: ${st.replace(/_/g, ' ')}`, msg);
        await env.ALERTS.put(cdKey, '1', { expirationTtl: 21600 });
      }
    }
    // Real-time gate (2026-05-30): fire the instant a cross is detected, any hour,
    // protected only by the 3.5h per-(token,symbol) cooldown below. The previous fixed
    // notify-window gate (8/12/16/20/23:30 ET) silently DROPPED crosses that landed
    // off-window: mlProb only moves on a 4H close and `crossed` is true for a single
    // cron tick (prevMl = previous minute), so a close outside a window was missed
    // entirely, not deferred. With crypto closing 24/7 and most closes falling outside
    // the 4-5 hour-wide windows, the majority of signals were lost. The cooldown already
    // prevents spam; quiet-hours is delegated to the user's iOS Focus/DND.
    if (!pred.crossed || !pushToken) continue;
    const dir = notificationDirection(pred.biasAlignment, pred.dStochCross);
    if (dir === 0) continue;  // No direction signal (neither fires, or they conflict)
    // Atomic claim: insert if absent, otherwise overwrite only if the prior claim has
    // expired. `meta.changes === 1` means we won (either fresh insert or expired-claim
    // takeover); `0` means another concurrent caller already holds an unexpired claim.
    // NB: positional `?` only — the box's better-sqlite3 adapter rejects `?N` numbered params
    // (this exact statement silently killed every ML-crossing push from the TrueNAS cutover
    // until 2026-07-01: the throw aborted the device pass on precisely the ticks that crossed).
    const claim = await env.DB.prepare(
      `INSERT INTO notif_claims (push_token, symbol, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(push_token, symbol) DO UPDATE SET expires_at = ?
       WHERE notif_claims.expires_at < ?`
    ).bind(pushToken, symbol, expiresAt, expiresAt, now).run();
    if ((claim.meta.changes ?? 0) === 0) continue;
    triggered.push({ symbol, score: pred.dailyScore, mlProb: pred.mlProb, notifyProb: pred.notifyProb,
                     direction: dir === 1 ? 'LONG' : 'SHORT' });
  }

  // Score history per watchlisted symbol (one row per cron, even if not notified).
  // Batched: pre-batch this was N D1 round-trips per device × M devices per cron, easily
  // 1000+ writes/minute. four_h_score stays 0 — SymbolPrediction doesn't carry a 4H
  // score today; expose `features.fourH.score` through predictions if /scores starts
  // surfacing it.
  const historyStmts = watchlist
    .map(symbol => {
      const pred = predictions.get(symbol);
      if (!pred) return null;
      const wasNotified = triggered.some(t => t.symbol === symbol);
      // bias = the real bias-alignment label, NOT a direction fabricated from ML_WIN — ML_WIN is
      // direction-AGNOSTIC by the system's own doctrine (pre-2026-07-02 this wrote
      // mlProb > 0.5 ? 'Bullish' : 'Bearish', serving a fake directional label via /scores).
      return env.DB.prepare(
        'INSERT INTO score_history (device_id, symbol, daily_score, four_h_score, ml_probability, bias, notification_sent) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(deviceId, symbol, pred.dailyScore, 0, pred.mlProb, pred.biasAlignment ?? null, wasNotified ? 1 : 0);
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
  if (historyStmts.length > 0) {
    await env.DB.batch(historyStmts);
  }

  // === Entry-touched check for this device's live pending setups ===
  // For each pending setup, check if the latest 4H bar's high/low touched the entry zone
  // (entry ± 0.3 ATR) AND ML is still favorable AND we haven't already notified. Fire APNs once.
  //
  // Reads tracked_setups directly since 2026-07-24. This used to query a `pending_setups` glue
  // table that held a DUPLICATE of these same rows, written by registerTrackedSetups for no reason
  // other than keeping this one notification alive through the 2026-07-09 server-side cutover.
  // The filters below mirror exactly what that glue write did — crypto only, atr > 0 — so retiring
  // the table changes no behaviour. (Stock conditionals therefore stay excluded; widening the
  // notification surface would be a product decision, not a cleanup.)
  //
  // Expiry no longer needs handling here: stepSetup terminalizes a pending row when the 12h window
  // lapses (state='expired', terminal=1), so `state='pending' AND terminal=0` cannot return a stale
  // row, and the old DELETE-on-expiry pass retires with the table.
  //
  // "Already notified" lives in KV (`entryzone:<rowId>`, 24h TTL — comfortably longer than the 12h
  // pending window) instead of a new tracked_setups column, so no live schema change is required.
  if (pushToken) {
    try {
      const setupRows = await env.DB.prepare(
        `SELECT id, symbol, direction, entry, atr, pending_expires_at FROM tracked_setups
          WHERE device_id = ? AND kind = 'setup' AND state = 'pending' AND terminal = 0
            AND is_crypto = 1 AND atr > 0`
      ).bind(deviceId).all();
      const setups = setupRows.results as unknown as Array<{
        id: string; symbol: string; direction: string; entry: number; atr: number;
        pending_expires_at: number | null;
      }>;
      const now = Date.now();
      for (const setup of setups) {
        // Belt-and-braces: the resolver normally terminalizes these, but it runs on its own ~5 min
        // cadence, so a row can sit one pass past its window.
        if (setup.pending_expires_at != null && setup.pending_expires_at < now) continue;
        const notifiedKey = `entryzone:${setup.id}`;
        if (await env.ALERTS.get(notifiedKey)) continue;
        const pred = predictions.get(setup.symbol);
        if (!pred || pred.atrPrice <= 0) continue;
        // ML must still be favorable, on the CALIBRATED scale (2026-08-21). This compared RAW
        // ML against 0.55 while every gate that CREATES these setups moved to the calibrated
        // scale — and on the compressed live curve a setup born at calibrated 66% maps from raw
        // ~45%, so the raw test silently killed the entry-zone push for exactly the setups the
        // lowered threshold newly creates. ENTRY_ZONE_ML_FLOOR sits one notch under the notify
        // threshold: enough to drop a signal whose quality genuinely collapsed since
        // registration, not so high that it re-litigates the gate that already approved it.
        if (pred.notifyProb < ENTRY_ZONE_ML_FLOOR) continue;
        // Entry zone: ±0.3 × ATR around the setup's entry price.
        const zoneWidth = setup.atr * 0.3;
        const zoneLow = setup.entry - zoneWidth;
        const zoneHigh = setup.entry + zoneWidth;
        // For LONG: bar's low ended INSIDE the zone (price reached the pullback without
        // plunging through). For SHORT: bar's high ended INSIDE the zone (price spiked
        // up to the entry without overshooting). Pre-fix the lower/upper bound used an
        // extra `±zoneWidth` "grace" term that doubled the effective window to 0.9 ATR,
        // firing on bars that had already gapped well past the documented ±0.3 ATR zone.
        const isLong = setup.direction === 'LONG';
        // TWO ways to be in the zone, because a setup does not become actionable only on a candle
        // boundary (2026-08-08):
        //   (a) live price is in the zone RIGHT NOW — detected within one cron tick (~1 min)
        //       instead of waiting up to 4h for the bar to close;
        //   (b) the last CLOSED bar's extreme reached the zone — retained so a touch that happened
        //       and reversed inside that bar is still caught.
        const liveInZone = pred.livePrice != null && pred.livePrice >= zoneLow && pred.livePrice <= zoneHigh;
        const closedBarTouched = isLong
          ? pred.last4HLow <= zoneHigh && pred.last4HLow >= zoneLow
          : pred.last4HHigh >= zoneLow && pred.last4HHigh <= zoneHigh;
        if (!liveInZone && !closedBarTouched) continue;
        // Envelope-gated (2026-07-11): don't page "open the app to confirm + act" into an
        // auto-FLAT analysis. Deliberately does NOT record the notified marker — the touch
        // re-checks next tick and the push fires if the envelope clears while price is still
        // in the zone.
        if (pred.envelopeFlat === true) continue;
        // Send the notification
        const name = setup.symbol.replace('USDT', '');
        const title = `${name} entry zone reached`;
        const dirStr = setup.direction;
        const mlPct = Math.round(pred.mlProb * 100);
        const entryStr = setup.entry < 10 ? setup.entry.toFixed(4) : setup.entry.toFixed(2);
        // Quote the LIVE price when that's what triggered it — "is in range" is far more actionable
        // when you can see where price actually is versus your entry.
        const nowStr = pred.livePrice != null
          ? (pred.livePrice < 10 ? pred.livePrice.toFixed(4) : pred.livePrice.toFixed(2)) : null;
        const body = nowStr
          ? `${dirStr} entry $${entryStr} — price is $${nowStr} now. ML ${mlPct}% — open to confirm + act.`
          : `${dirStr} setup at $${entryStr} is in range. ML ${mlPct}% — open the app to confirm + act.`;
        const result = await sendAPNs(env, pushToken, title, body);
        if (result === 'unregistered') {
          await deleteDevice(env, deviceId);
          return;
        }
        await env.ALERTS.put(notifiedKey, '1', { expirationTtl: 24 * 3600 });
      }
    } catch (e) {
      console.log(`[entry-zone] check failed for ${deviceId}: ${e}`);
    }
  }

  if (triggered.length === 0 || !pushToken) return;

  // Automated analysis (2026-07-14): each survived cross now runs the FULL analysis and pushes its
  // Bottom Line — replacing the bare "ML 73%" ping — and auto-registers its setups into
  // tracked_setups. Fired per symbol WITHOUT await: the box is a persistent process, so these
  // outlive the cron pass; a 30-90s LLM call must never block the minute cron. Each call either
  // self-sends its richer push or DEFERS the cross back for retry (no setup / failure) — the bare
  // move-likelihood fallback push was removed 2026-07-14, so a silent return is not a lost signal.
  // Per-symbol instead of the old grouped push — every triggered symbol is a real analyzed signal.
  for (const t of triggered) {
    void runAutoAnalysis(env, t.symbol, t.symbol.endsWith('USDT'), deviceId, pushToken, t.mlProb, t.notifyProb);
  }
  // Log every triggered symbol regardless of how many APNs we sent — `notifications`
  // is the per-symbol audit trail, not the per-push log.
  for (const t of triggered) {
    await env.DB.prepare(
      'INSERT INTO notifications (device_id, symbol, type, ml_probability, score, direction) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(deviceId, t.symbol, 'ml_crossing', t.mlProb, t.score, t.direction).run();
  }
}

/// Resolves a device's APNs push token. D1 is authoritative; falls back to the KV blob
/// from older registration paths. Returns null if neither has a token (device hasn't
/// finished registration yet). Called twice per `checkDeviceScores` in the worst case
/// (once per triggering symbol at the gate, once before APN send) — both are short
/// indexed lookups so no caching needed.
async function getPushToken(env: Env, deviceId: string): Promise<string | null> {
  const deviceRow = await env.DB.prepare('SELECT push_token FROM devices WHERE device_id = ?').bind(deviceId).first();
  const fromDb = (deviceRow?.push_token as string | null) ?? null;
  if (fromDb) return fromDb;
  const deviceData = await env.ALERTS.get(`device:${deviceId}`);
  if (!deviceData) return null;
  try {
    const device = JSON.parse(deviceData);
    return device.pushToken || device.token || null;
  } catch {
    return null;
  }
}

// Policy/macro headline poll (2026-08-22). Every ~15 min, not every minute: these feeds update on
// the order of hours, publishers' fair-access norms deserve respect, and the analysis reads from
// D1 rather than from the fetch — so a faster poll would buy nothing. KV-gated the same way the
// other periodic jobs are; fully fault-isolated (a poll failure must never touch the cron pass).
// Per-feed health is cached for `GET /news`, which is how a gluetun-blocked publisher becomes
// visible instead of just quietly missing.
const NEWS_POLL_INTERVAL_MS = 15 * 60_000;
async function pollNewsIfDue(env: Env): Promise<void> {
  try {
    const last = Number(await env.ALERTS.get('news:last_poll').catch(() => null)) || 0;
    const now = Date.now();
    if (now - last < NEWS_POLL_INTERVAL_MS) return;
    await env.ALERTS.put('news:last_poll', String(now), { expirationTtl: 86400 });
    const { inserted, pruned, health } = await pollNewsFeeds(env as any, now);
    await env.ALERTS.put('news:health', JSON.stringify({ at: now, inserted, pruned, health }), { expirationTtl: 86400 }).catch(() => {});
    const bad = health.filter(h => !h.ok);
    console.log(`[news] polled ${health.length} feeds, ${inserted} new, ${pruned} pruned${bad.length ? ` — FAILED: ${bad.map(b => `${b.id}(${b.error})`).join(', ')}` : ''}`);
  } catch (e) {
    console.log(`[news] poll failed: ${e}`);
  }
}

async function fetchScoreCandles(symbol: string, isCrypto: boolean): Promise<ScoreCandle[]> {
  if (isCrypto) {
    return fetchBinanceKlines(symbol, '1d', 260);   // proxy → Binance → Bybit (resilient)
  } else {
    const resp = await fetch(
      `${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=1y`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!resp.ok) return [];
    const data = await resp.json() as any;
    const r = data?.chart?.result?.[0];
    if (!r?.timestamp) return [];
    const ts = r.timestamp;
    const q = r.indicators.quote[0];
    const candles = ts.map((t: number, i: number) => ({
      time: t * 1000,
      open: q.open[i] || 0, high: q.high[i] || 0,
      low: q.low[i] || 0, close: q.close[i] || 0,
      volume: q.volume[i] || 0
    })).filter((c: ScoreCandle) => c.close > 0);
    return dropInProgress(candles, '1d');
  }
}

// Fetch all three timeframes for the /indicators endpoint. Crypto: Binance klines direct.
// Stock: Yahoo daily + 1H, 4H aggregated from 1H (mirrors the cron + iOS). In-progress dropped.
// ── Self-hosted candle proxy (TrueNAS, residential IP) ─────────────────────────────────────
// Binance blocks Cloudflare datacenter IPs, not homes. When BINANCE_PROXY_BASE is configured
// the Worker fetches Binance-native data through the user's cloudflared tunnel; otherwise these
// return null and the caller falls back to Bybit. Config is constant per deploy → safe as
// module globals set once at each handler entry (see setProxyConfig).
let PROXY_BASE = '', PROXY_SECRET = '';
function setProxyConfig(env: any) {
  if (!PROXY_BASE && env?.BINANCE_PROXY_BASE) PROXY_BASE = String(env.BINANCE_PROXY_BASE).replace(/\/$/, '');
  if (!PROXY_SECRET && env?.BINANCE_PROXY_SECRET) PROXY_SECRET = String(env.BINANCE_PROXY_SECRET);
}
async function fetchProxyKlines(symbol: string, interval: string, limit: number): Promise<any[] | null> {
  if (!PROXY_BASE) return null;
  try {
    const r = await fetch(`${PROXY_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { headers: { 'X-Proxy-Secret': PROXY_SECRET }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const data = await r.json() as any;
    return Array.isArray(data) && data.length ? data : null;
  } catch { return null; }
}
async function fetchProxyPrice(symbol: string): Promise<number | null> {
  if (!PROXY_BASE) return null;
  try {
    const r = await fetch(`${PROXY_BASE}/price?symbol=${symbol}`,
      { headers: { 'X-Proxy-Secret': PROXY_SECRET }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json() as any; const p = parseFloat(j?.price);
    return isNaN(p) ? null : p;
  } catch { return null; }
}

// Bybit USDT-perp klines — the fallback when Binance is geo-blocked from Cloudflare colos.
// Same symbols (BTCUSDT), perp venue like the training data, up to 1000 bars/request. Bybit
// returns newest-first, so we reverse to oldest-first; in-progress last bar dropped after.
async function fetchBybitKlines(symbol: string, interval: string, limit: number): Promise<ScoreCandle[]> {
  const iv = interval === '1h' ? '60' : interval === '4h' ? '240' : interval === '1d' ? 'D'
           : interval === '1w' ? 'W' : interval === '15m' ? '15' : interval;
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}&limit=${Math.min(limit, 1000)}`;
  // Single attempt by default — the cron bulk-fetches ~228 crypto klines/min and long retry
  // backoffs make the scheduled handler time out before finishing. On-demand reliability comes
  // from the tfcache + last-good fallback, not retries. (The TrueNAS proxy removes this load.)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 120));
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json() as any;
      const list = data?.result?.list;
      if (!Array.isArray(list) || !list.length) continue;
      // each: [startMs, open, high, low, close, volume, turnover]; list is newest-first
      const candles = list.map((k: any[]) => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).reverse();
      return dropInProgress(candles as FullCandle[], interval);
    } catch { /* retry */ }
  }
  return [];
}

// 1H closes for the vol forecast. Binance fapi/spot klines are geo-blocked from Cloudflare
// colos (only the lighter derivatives endpoints work), so fall back to Bybit. Drops the
// in-progress last bar. Returns [] only if BOTH sources fail.
async function fetchFapiCloses(symbol: string, limit: number): Promise<number[]> {
  const proxied = await fetchProxyKlines(symbol, '1h', limit);       // TrueNAS (Binance-native) first
  if (proxied) return proxied.map((k: any) => +k[4]).slice(0, -1);
  try {
    const resp = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`);
    if (resp.ok) {
      const data = await resp.json() as any[];
      if (Array.isArray(data) && data.length) return data.map((k: any) => +k[4]).slice(0, -1);
    }
  } catch { /* fall through to Bybit */ }
  return (await fetchBybitKlines(symbol, '1h', limit)).map(c => c.close);
}

async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<ScoreCandle[]> {
  const proxied = await fetchProxyKlines(symbol, interval, limit);    // TrueNAS (Binance-native) first
  if (proxied) return dropInProgress(proxied.map((k: any) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })), interval);
  try {
    const resp = await fetch(`${BINANCE_SPOT}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (resp.ok) {
      const data = await resp.json() as any[];
      if (Array.isArray(data) && data.length)
        return dropInProgress(data.map((k: any) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })), interval);
    }
  } catch { /* fall through to Bybit */ }
  // Binance blocked/empty from this Cloudflare colo → Bybit fallback (same symbols).
  return fetchBybitKlines(symbol, interval, limit);
}
async function fetchYahooCandlesTF(symbol: string, interval: string, range: string): Promise<ScoreCandle[]> {
  const resp = await fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return [];
  const data = await resp.json() as any;
  const r = data?.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const ts = r.timestamp, q = r.indicators.quote[0];
  const out: ScoreCandle[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.open?.[i] != null && q.close?.[i] != null) out.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
  }
  return dropInProgress(out, interval);
}
// Live (current) price for display. Indicators are computed on CLOSED candles (in-progress
// dropped), so daily.price is the previous daily close — stale by up to a day for the header.
// This returns the real-time ticker so the web header matches iOS's live price.
// Live price from Bybit (lastPrice) — fallback when Binance ticker is geo-blocked.
async function fetchBybitPrice(symbol: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
    if (!r.ok) return null;
    const j = await r.json() as any;
    const p = parseFloat(j?.result?.list?.[0]?.lastPrice);
    return isNaN(p) ? null : p;
  } catch { return null; }
}

async function fetchLivePrice(symbol: string, isCrypto: boolean): Promise<number | null> {
  try {
    if (isCrypto) {
      const proxied = await fetchProxyPrice(symbol);    // TrueNAS (Binance-native) first
      if (proxied != null) return proxied;
      try {
        const r = await fetch(`${BINANCE_SPOT}/ticker/price?symbol=${symbol}`);
        if (r.ok) { const j = await r.json() as any; const p = parseFloat(j?.price); if (!isNaN(p)) return p; }
      } catch { /* Binance blocked → Bybit */ }
      return fetchBybitPrice(symbol);   // real live price, not a stale candle close
    }
    const r = await fetch(`${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    if (!r.ok) return null;
    const j = await r.json() as any;
    const meta = j?.chart?.result?.[0]?.meta;
    const p = meta?.regularMarketPrice ?? meta?.previousClose;
    return typeof p === 'number' && !isNaN(p) ? p : null;
  } catch { return null; }
}

// Cached candle fetch for on-demand endpoints. Serves a <60s cache without re-fetching, and
// on a fetch failure (Bybit rate-limited a colo) falls back to the last-good cache (≤1h) instead
// of 404ing. Candles are closed-bar anyway, so ≤1min staleness is harmless. Cuts Bybit load too.
async function fetchAllTimeframesCached(env: { ALERTS: KVNamespace }, symbol: string, isCrypto: boolean):
    Promise<{ daily: ScoreCandle[]; fourH: ScoreCandle[]; oneH: ScoreCandle[] }> {
  const key = `tfcache:${symbol}`;
  let cached: { tf: any; ts: number } | null = null;
  try { const raw = await env.ALERTS.get(key); if (raw) cached = JSON.parse(raw); } catch { /* ignore */ }
  if (cached && Date.now() - cached.ts < 60_000) return cached.tf;     // fresh enough — no fetch
  const tf = await fetchAllTimeframes(symbol, isCrypto);
  if (tf.daily.length) {
    try { await env.ALERTS.put(key, JSON.stringify({ tf, ts: Date.now() }), { expirationTtl: 3600 }); } catch { /* ignore */ }
    return tf;
  }
  // Live fetch blipped (Bybit rate-limited under cron load). Fall back to the cron's universe
  // candle cache (candles:all:<interval>, refreshed every tick for all symbols) — the reliable
  // path while Binance is geo-blocked and the TrueNAS proxy isn't configured. Then last-good tfcache.
  if (isCrypto) {
    try {
      const [d, h, o] = await Promise.all([
        env.ALERTS.get('candles:all:1d'), env.ALERTS.get('candles:all:4h'), env.ALERTS.get('candles:all:1h')]);
      const dm = d ? JSON.parse(d) : {}, hm = h ? JSON.parse(h) : {}, om = o ? JSON.parse(o) : {};
      const daily = dm[symbol];
      if (Array.isArray(daily) && daily.length) {
        const out = { daily, fourH: hm[symbol] ?? [], oneH: om[symbol] ?? [] };
        try { await env.ALERTS.put(key, JSON.stringify({ tf: out, ts: Date.now() }), { expirationTtl: 3600 }); } catch { /* ignore */ }
        return out;
      }
    } catch { /* ignore */ }
  }
  return cached?.tf ?? tf;                                             // fetch blipped — serve last-good
}

async function fetchAllTimeframes(symbol: string, isCrypto: boolean): Promise<{ daily: ScoreCandle[]; fourH: ScoreCandle[]; oneH: ScoreCandle[] }> {
  if (isCrypto) {
    const [daily, fourH, oneH] = await Promise.all([
      fetchBinanceKlines(symbol, '1d', 260), fetchBinanceKlines(symbol, '4h', 300), fetchBinanceKlines(symbol, '1h', 300),
    ]);
    return { daily, fourH, oneH };
  }
  const [daily, oneH] = await Promise.all([
    fetchYahooCandlesTF(symbol, '1d', '1y'), fetchYahooCandlesTF(symbol, '1h', '6mo'),
  ]);
  const fourH = oneH.length ? dropInProgress(aggregate1HTo4H_ET(oneH as FullCandle[]), '4h') : [];
  return { daily, fourH, oneH };
}

// === D1 Candle Archive ===
async function archiveCandlesToD1(env: Env, symbol: string, interval: string, candles: ScoreCandle[]) {
  if (candles.length === 0) return;
  // Batch insert, 50 at a time (D1 batch limit)
  const recent = candles.slice(-100); // Only archive the most recent 100 candles per fetch
  for (let i = 0; i < recent.length; i += 50) {
    const batch = recent.slice(i, i + 50);
    try {
      await env.DB.batch(
        batch.map(c =>
          env.DB.prepare(
            'INSERT OR IGNORE INTO candles (symbol, interval, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(symbol, interval, c.time, c.open, c.high, c.low, c.close, c.volume)
        )
      );
    } catch { /* D1 write failed — non-critical */ }
  }
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
