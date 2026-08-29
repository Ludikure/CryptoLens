// Behavioural access to the Conviction Envelope, for tests.
//
// WHY THIS EXISTS. Until 2026-08-26 every envelope test was a regex over `prompt.ts` SOURCE TEXT:
//
//     expect(src).toMatch(/const continuationBlockApplies = isCryptoSym && .../)
//
// Those assertions never execute the envelope. They pin an implementation spelling, so they pass
// when the behaviour is wrong and fail when the behaviour is right but written differently — and
// during the 2026-08-25 corrections they fought every change, six at a time. They also cement
// removals in place, which makes them an obstacle to re-deciding gates on evidence.
//
// This helper builds a REAL prompt from the real BTC tape and parses the envelope's actual verdict.
// The parser is deliberately strict: a missing envelope block throws rather than returning empty,
// so a rename or a refactor fails loudly instead of silently turning every assertion vacuous.
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeFullIndicators } from '../../src/indicators-full';
import { buildUserPrompt, type PromptIndicator } from '../../src/prompt';

const fx = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'btc-rally-2026-08.json'), 'utf-8'));
const NOW_MS = fx.fourH[fx.fourH.length - 1].time + 14400e3;

export interface EnvelopeVerdict {
  maxAllowed: string;
  autoFlat: string[];
  highBlocks: string[];
  moderateBlocks: string[];
  downgrade: string[];
  prompt: string;
  /** True when any listed reason starts with the given prefix — the common assertion shape. */
  has(prefix: string): boolean;
}

export interface EnvelopeOverrides {
  ml?: number;                 // raw ML_WIN on indicators[0]
  calibratedMl?: number;       // what the envelope actually gates on; defaults to `ml`
  dailyBias?: string;          // e.g. 'Bearish', 'Strong Bullish', 'Neutral'
  fourHBias?: string;
  oneHBias?: string;
  symbol?: string;             // 'BTCUSDT' (crypto) or e.g. 'AAPL' (stock)
  stockInfo?: Record<string, unknown> | null;
  economicEvents?: unknown[];
  extra?: Record<string, unknown>;   // any other buildUserPrompt input
}

/**
 * The minimum `StockInfo` the prompt will render — `marketState`, `fiftyTwoWeekLow` and
 * `fiftyTwoWeekHigh` are the only non-optional fields (`prompt.ts:442-454`). Passing `{}` throws
 * deep inside a `.toFixed`, which is a confusing way to learn that; tests get this instead and
 * override only the field under test.
 */
export const MIN_STOCK_INFO = {
  marketState: 'REGULAR',
  fiftyTwoWeekLow: 40_000,
  fiftyTwoWeekHigh: 120_000,
  earningsDate: null,
} as const;

function listAfter(prompt: string, label: string): string[] {
  const m = new RegExp(`^\\s*${label}:\\s*(.+)$`, 'm').exec(prompt);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

/** Build a real prompt and read the envelope's verdict out of it. */
export function envelopeFor(o: EnvelopeOverrides = {}): EnvelopeVerdict {
  const isCrypto = (o.symbol ?? 'BTCUSDT').toUpperCase().endsWith('USDT');
  const indicators: PromptIndicator[] = [
    computeFullIndicators(fx.daily, { timeframe: '1d', label: 'Daily', isCrypto }) as unknown as PromptIndicator,
    computeFullIndicators(fx.fourH, { timeframe: '4h', label: '4H', isCrypto }) as unknown as PromptIndicator,
    computeFullIndicators(fx.oneH, { timeframe: '1h', label: '1H', isCrypto }) as unknown as PromptIndicator,
  ];
  if (o.ml != null) (indicators[0] as any).mlWinProbability = o.ml;
  if (o.dailyBias != null) (indicators[0] as any).bias = o.dailyBias;
  if (o.fourHBias != null) (indicators[1] as any).bias = o.fourHBias;
  if (o.oneHBias != null) (indicators[2] as any).bias = o.oneHBias;

  const { prompt } = buildUserPrompt({
    symbol: o.symbol ?? 'BTCUSDT',
    nowMs: NOW_MS,
    indicators,
    prevState: {},
    economicEvents: o.economicEvents ?? [],
    calibratedMlWin: o.calibratedMl ?? o.ml,
    stockInfo: o.stockInfo === null ? undefined
      : (o.stockInfo ?? (isCrypto ? undefined : MIN_STOCK_INFO)),
    ...(o.extra ?? {}),
  } as any);

  const maxM = /^\s*max_allowed:\s*(\w+)/m.exec(prompt);
  if (!maxM) {
    throw new Error(
      'envelopeFor: no `max_allowed:` line in the built prompt. The Conviction Envelope block was '
      + 'renamed, moved, or failed to render — fix the helper rather than letting every envelope '
      + 'assertion silently pass on an empty verdict.');
  }
  const autoFlat = listAfter(prompt, 'auto_FLAT_active');
  const highBlocks = listAfter(prompt, 'HIGH_blocked_because');
  const moderateBlocks = listAfter(prompt, 'MODERATE_blocked_because');
  const downgrade = listAfter(prompt, 'downgrade_one_tier_if_LLM_decides');
  const all = [...autoFlat, ...highBlocks, ...moderateBlocks, ...downgrade];
  return {
    maxAllowed: maxM[1],
    autoFlat, highBlocks, moderateBlocks, downgrade, prompt,
    has: (prefix: string) => all.some(r => r.startsWith(prefix)),
  };
}

/** Bias triples for the states the envelope distinguishes, so tests read as intent not as strings. */
export const BIAS = {
  alignedBullish: { dailyBias: 'Bullish', fourHBias: 'Bullish', oneHBias: 'Bullish' },
  alignedBearish: { dailyBias: 'Bearish', fourHBias: 'Bearish', oneHBias: 'Bearish' },
  higherTfOnly: { dailyBias: 'Bullish', fourHBias: 'Bullish', oneHBias: 'Neutral' },
  mixed: { dailyBias: 'Bullish', fourHBias: 'Bearish', oneHBias: 'Neutral' },
  // The ONLY state in which the Kill Conditions block renders at all: `prompt.ts` wraps the whole
  // kill evaluation in `if (oneHOpposes && oneH)`, and `oneHOpposes` requires daily and 4H to agree
  // while 1H opposes them. So `ANY_KILLED` — and therefore every kill condition — is scoped to
  // counter-trend-pullback bars. Worth knowing before reading any measurement of a kill rule: a
  // reconstruction that evaluates one on every bar is scoped to a population an order of magnitude
  // larger than the rule's own domain.
  counterTrendPullback: { dailyBias: 'Bullish', fourHBias: 'Bullish', oneHBias: 'Bearish' },
} as const;
