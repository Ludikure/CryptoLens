// Hardening of the must-offer-entry mandate (2026-08-21b), from the max-effort review of 30d7303.
// Each block pins one finding: the windows must survive a compressed calibration curve, must reach
// the pullback bars they name as the entry, must NOT compel a setup where forcing one is wrong
// (earnings gap, blind data, unguarded MIXED states), and the machine-readable contract must carry
// the mandate so a prose-only answer can't read downstream as "no setup".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeFullIndicators } from '../src/indicators-full';
import { buildUserPrompt, systemPrompt, type PromptIndicator } from '../src/prompt';
import { entryReached, stepSetup } from '../src/outcome-tracking';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'btc-rally-2026-08.json'), 'utf-8'));
const nowMs = fx.fourH[fx.fourH.length - 1].time + 14400e3;

// raw = the model's own probability (drives the mandate TIER); cal = the live-calibrated value
// (drives the auto-FLAT/quality gate, and vetoes the mandate if the forward data contradicts).
function build(over: { raw?: number; cal?: number; extra?: Record<string, any> } = {},
               tfs: { daily?: any[]; fourH?: any[]; oneH?: any[] } = {}) {
  const ind: PromptIndicator[] = [
    computeFullIndicators(tfs.daily ?? fx.daily, { timeframe: '1d', label: 'Daily', isCrypto: true }) as unknown as PromptIndicator,
    computeFullIndicators(tfs.fourH ?? fx.fourH, { timeframe: '4h', label: '4H', isCrypto: true }) as unknown as PromptIndicator,
    computeFullIndicators(tfs.oneH ?? fx.oneH, { timeframe: '1h', label: '1H', isCrypto: true }) as unknown as PromptIndicator,
  ];
  const raw = over.raw ?? 0.80;
  (ind[0] as any).mlWinProbability = raw;
  return buildUserPrompt({
    symbol: 'BTCUSDT', nowMs, indicators: ind, prevState: {}, economicEvents: [],
    calibratedMlWin: over.cal ?? raw, ...over.extra,
  } as any).prompt;
}

// Regression for the review's headline finding: the first cut floored the mandate's gate at the
// live calibration CEILING, but applyCalibration CLAMPS at that ceiling — so `calibrated <= ceiling`
// held by construction and the gate admitted only bars at the curve's very top point. Measured, it
// demanded raw >= 0.760 (coarse Aug curve) / raw >= 0.792 (the box's real curve) — both STRICTER
// than the raw >= 0.70 it was meant to widen. The tier now reads the raw scale, which no curve
// shape can move.
describe('mandate tier — read off the RAW scale, immune to curve compression', () => {
  it('mild drift does not veto: raw-70 bars calibrating to ~65 still mandate', () => {
    expect(build({ raw: 0.72, cal: 0.656 })).toContain('setup is MANDATORY');
  });

  it('fires at raw 70 even when the live curve is compressed far below it', () => {
    // Exactly the shape that killed the old gate: the whole curve tops out at ~66.
    const p = build({ raw: 0.80, cal: 0.66 });
    expect(p).toContain('HIGH_CONVICTION_WINDOW');
    expect(p).toContain('LONG setup is MANDATORY');
    expect(p).toContain('raw 80% (live-calibrated 66%)');   // both scales labelled, never bare "ML_WIN 66%"
  });

  it('does not fire below the raw top tier, however flattering the calibration', () => {
    expect(build({ raw: 0.69, cal: 0.80 })).not.toContain('HIGH_CONVICTION_WINDOW');
  });

  it('the live curve VETOES the mandate when forward data contradicts the model', () => {
    // Model still self-reports top tier, but graded outcomes say these bars no longer clear even
    // the FAVORABLE band — a decayed model must not compel trades. (Mild drift does not: on the
    // box's real curve raw-70 bars calibrate to ~65.6, which still mandates.)
    const p = build({ raw: 0.80, cal: 0.55 });
    expect(p).toContain('HIGH_CONVICTION_WINDOW_SUSPENDED');
    expect(p).toContain('live_calibration_55%_below_60');
    expect(p).not.toContain('setup is MANDATORY');
  });
});

describe('mandate window — suspension instead of a forced blind entry', () => {
  it('suspends (not mandates) when 2+ enrichment sources are stale', () => {
    // The missing feeds are exactly the ones whose signals would CLOSE the window, so a forced
    // entry there is the blindest possible read.
    const p = build({ raw: 0.80, extra: { dataQuality: { missingEnrichments: ['derivatives', 'positioning'] } } });
    expect(p).toContain('HIGH_CONVICTION_WINDOW_SUSPENDED');
    expect(p).not.toContain('setup is MANDATORY');
  });
});

describe('mandate window — pullback bars are IN the window', () => {
  it('fires on ALIGNED_*_HIGHER_TF_ONLY and names the 1H pullback as the entry', () => {
    // Daily+4H aligned bullish with the 1H counter — the retest bar the remedy points at, which
    // the strict-equality check previously excluded. The 1H bias is overridden directly so the
    // state is exercised deterministically rather than hoping synthetic candles produce it.
    const ind: PromptIndicator[] = [
      computeFullIndicators(fx.daily, { timeframe: '1d', label: 'Daily', isCrypto: true }) as unknown as PromptIndicator,
      computeFullIndicators(fx.fourH, { timeframe: '4h', label: '4H', isCrypto: true }) as unknown as PromptIndicator,
      { ...(computeFullIndicators(fx.oneH, { timeframe: '1h', label: '1H', isCrypto: true }) as any), bias: 'Bearish' } as unknown as PromptIndicator,
    ];
    (ind[0] as any).mlWinProbability = 0.80;
    const p = buildUserPrompt({ symbol: 'BTCUSDT', nowMs, indicators: ind, prevState: {}, economicEvents: [], calibratedMlWin: 0.80 } as any).prompt;
    expect(p).toContain('ALIGNED_BULLISH_HIGHER_TF_ONLY');   // the state under test really is active
    expect(p).toContain('HIGH_CONVICTION_WINDOW');
    expect(p).toContain('that IS the pullback');
    expect(p).toContain('LONG setup is MANDATORY');
  });
});

describe('system prompt — the machine-readable contract carries the mandate', () => {
  it('both markets: the JSON block must contain the mandated setup, not an empty array', () => {
    for (const s of [systemPrompt(true), systemPrompt(false)]) {
      expect(s).toContain('EXCEPTION —');
      expect(s).toContain('the array MUST contain the setup you described in the prose');
      expect(s).toContain('this section is REQUIRED');       // "If You Take a Position" un-gated inside a window
    }
  });

  it('no fused token from the splice (regression: "The`max_allowed`")', () => {
    for (const s of [systemPrompt(true), systemPrompt(false)]) {
      expect(s).not.toContain('The`max_allowed`');
      expect(s).toContain('The `max_allowed`');
    }
  });
});

describe('entryReached — breakout conditionals must not false-fire', () => {
  const bar = (high: number, low: number) => ({ high, low });
  it('LONG breakout (entry above setup price) needs price to RISE to it', () => {
    expect(entryReached(bar(102.9, 99.5), 103, 100, true)).toBe(false);   // the phantom-loss case
    expect(entryReached(bar(103.2, 99.5), 103, 100, true)).toBe(true);
  });
  it('SHORT breakdown (entry below setup price) needs price to FALL to it', () => {
    expect(entryReached(bar(100.5, 97.2), 97, 100, false)).toBe(false);
    expect(entryReached(bar(100.5, 96.8), 97, 100, false)).toBe(true);
  });
  it('pullback forms keep their original semantics', () => {
    expect(entryReached(bar(106, 99), 98, 100, true)).toBe(false);
    expect(entryReached(bar(101, 97.9), 98, 100, true)).toBe(true);
  });
  it('market entry (within 0.1%) counts immediately; legacy rows fall back to direction', () => {
    expect(entryReached(bar(101, 99.8), 100, 100, true, { allowMarketShortcut: true })).toBe(true);
    expect(entryReached(bar(102, 99.9), 100, 0, true)).toBe(true);
  });

  it('the market shortcut is OPT-IN, so a near-price breakout trigger cannot false-fire', () => {
    // The mandate tells the model to phrase entries as "on a 4H close above Y", and
    // classifySetupType routes that wording to pending regardless of distance — so a trigger
    // 0.03% above price must still wait for price to actually get there.
    const nearBreakout = () => entryReached(bar(64240, 64200), 64250, 64230, true);
    expect(nearBreakout()).toBe(false);
    expect(entryReached(bar(64260, 64200), 64250, 64230, true)).toBe(true);
    // The ACTIVE path keeps the shortcut (a market fill really is "already there").
    expect(entryReached(bar(64240, 64200), 64250, 64230, true, { allowMarketShortcut: true })).toBe(true);
  });
});

describe('pending setups — candle evidence outranks the wall clock', () => {
  const T0 = 1_700_000_000_000, M15 = 900_000, H = 3_600_000;
  const pendingRow = (over: any = {}) => ({
    id: 'p1', deviceId: 'd', symbol: 'BTCUSDT', isCrypto: true, kind: 'setup' as const,
    direction: 'LONG', entry: 103, stopLoss: 99, tp1: 111, tp2: null, reasoning: 'on a 4H close above 103',
    priceAtSetup: 100, atr: 2, mlAtRegistration: 0.7, conviction: null,
    modelVersion: 14, promptVersion: 'x', archetype: 'MOMENTUM_CONTINUATION', setupType: 'conditional',
    state: 'pending', terminal: false, entryHit: false, entryHitAt: null, stopHit: false,
    tp1Hit: false, tp2Hit: false, breakevenActivated: false, partialTaken: false,
    maxFavorable: 0, maxAdverse: 0, outcome: null, invalidReason: null, flatReason: null,
    falseFlat: null, priceAfter: null, pendingExpiresAt: T0 + 12 * H, registeredAt: T0,
    resolvedAt: null, lastCheckedAt: null, outcomeRowId: null, ...over,
  });
  const pt = (open: number, high: number, low: number, time: number) => ({ open, high, low, time });

  it('a backfilled touch inside the window wins over an elapsed expiry (downtime replay)', () => {
    // Box down for 13h; klines backfill a genuine trigger at T0+5h. Before the fix the wall-clock
    // expiry ran first and recorded a setup that triggered and ran as "never triggered".
    const res = stepSetup(pendingRow() as any, [pt(102, 103.5, 101, T0 + 5 * H)], { nowMs: T0 + 13 * H } as any);
    expect(res.row.entryHit).toBe(true);
    expect(res.row.outcome).not.toBe('expired');
  });

  it('still expires when the backfilled bars show no touch inside the window', () => {
    const res = stepSetup(pendingRow() as any, [pt(100, 102.5, 99.5, T0 + 5 * H)], { nowMs: T0 + 13 * H } as any);
    expect(res.row.entryHit).toBe(false);
    expect(res.row.outcome).toBe('expired');
  });

  it('a touch AFTER the pending window does not count as a trigger', () => {
    const res = stepSetup(pendingRow() as any, [pt(102, 103.5, 101, T0 + 13 * H)], { nowMs: T0 + 14 * H } as any);
    expect(res.row.entryHit).toBe(false);
    expect(res.row.outcome).toBe('expired');
  });
});

// Observed live on BTCUSDT 2026-08-25: one prompt saying three contradictory things about the same
// bar, because the Conviction Envelope gates on the LIVE-CALIBRATED ML_WIN while two other lines
// still banded on the RAW one.
//
//   Conviction Envelope: max_allowed: LOW ... NOT auto-FLAT on ML alone      (calibrated 60%)
//   ML Bucket: UNFAVORABLE (ML_WIN 44%) — NO TRADE regardless of ...          (raw)
//   POSITION SIZING: NO TRADE — ML_WIN < 60% ...                              (raw)
//
// This is the user-visible form of "it tells me not to trade and to trade at the same time".
describe('raw vs calibrated ML_WIN cannot contradict the gate', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');

  it('POSITION SIZING gates on the same calibrated value as the envelope', () => {
    expect(src).toMatch(/const mlWin = input\.calibratedMlWin \?\? rawWin;/);
    expect(src).not.toMatch(/const mlWin = daily\.mlWinProbability, qualityOK/);
  });

  it('the ML Bucket TIER stays on the RAW scale — the mandate reads rawMlPct >= 70', () => {
    // Banding the tier on the calibrated value would re-split it from the mandate, undoing the
    // 2026-08-22 alignment. The tier is raw on purpose; only the DIRECTIVE changed.
    expect(src).toMatch(/const mlPct = iTrunc\(daily\.mlWinProbability \* 100\), isStock = !!stockInfo;/);
    expect(src).toMatch(/const MANDATE_RAW_PCT = 70/);
  });

  it('the weakest bucket no longer issues a categorical NO TRADE over the envelope', () => {
    expect(src).not.toMatch(/UNFAVORABLE \(\$\{shown\}\) — NO TRADE regardless of directional clarity/);
    expect(src).toMatch(/Do NOT read this tier as a veto; read max_allowed/);
  });

  it('both scales are rendered wherever they differ, in both lines', () => {
    expect(src).toMatch(/ML_WIN raw \$\{mlPct\}% \(live-calibrated \$\{calPct\}%\)/);
    expect(src).toMatch(/\(raw \$\{iTrunc\(rawWin \* 100\)\}%, live-calibrated/);
  });

  it('the macro moderate-block label is not self-contradictory', () => {
    // Asserted on the emitted string, not on the file — the comment above it quotes the old label
    // by design, and a bare /_exceeds_NEARBY/ would match that prose forever.
    expect(src).not.toMatch(/moderateBlocks\.push\(`macro_\$\{envMacroRisk\}_exceeds_NEARBY`\)/);
    expect(src).toMatch(/moderateBlocks\.push\(`macro_\$\{envMacroRisk\}_at_or_inside_NEARBY`\)/);
  });
});
