import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Forward validation for the Conviction Envelope (2026-08-26).
//
// WHY IT EXISTS. Every retrospective arm in Phase 2 was measured in ONE window — a crypto bear where
// the equal-weight basket fell 83% and SHORT is the better side ungated. The envelope measured as a
// working gate on SHORT and an inverted one on LONG, four separate times on different targets, and
// none of those arms could separate mechanism from regime because they all share that window.
//
// The retrospective holdout is also gone: plan step 1.11 reserved the last six months and was never
// implemented, so C1-C6 consumed the span. There is no unseen data left in that dataset.
//
// These are structural tests. The thing itself cannot be tested until it has months of rows, which
// is the entire point.

const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf-8');

describe('the envelope forward logger', () => {
  it('grades at 72h — the horizon the envelope actually governs', () => {
    // Not the calibration loop's 24h: the envelope gates a SETUP, and setups run to 72h. Grading a
    // setup gate on a 24h window would score it on a horizon it never claimed.
    expect(src).toMatch(/const ENV_SIG_HORIZON_MS = 72 \* 3600 \* 1000;/);
  });

  it('records the tier from the REAL prompt builder, not a re-parse or a rebuild', () => {
    // The whole programme this came out of exists because reconstructions disagreed with production
    // on 88.7% of bars. A forward logger that rebuilt the rules would inherit that.
    expect(src).toMatch(/const flatReasons = await envelopePrecheck\(/);
    expect(src).toMatch(/lastEnvelopeVerdict = built\.envelope/);
  });

  it('stores BOTH excursion legs, because the envelope claim is direction-agnostic', () => {
    // fav_r alone cannot answer whether a tier admitted a big move on the RIGHT side, which is the
    // question the direction split raises.
    expect(src).toMatch(/fav_r REAL, adv_r REAL/);
    expect(src).toMatch(/const advR = \(row\.entry_price - minLow\) \/ row\.atr_price;/);
  });

  it('passes real economic events, so macro conditions are not silently off in every row', () => {
    // Passing `[]` here would record a tier production never emits — the exact class of defect
    // (measure one population, ship against another) this programme spent its length repairing.
    const call = /envelopePrecheck\(env, symbol, isCrypto, mlProb,\s*\n\s*candles as ScoreCandle\[\][\s\S]{0,240}?await econEvents\(\)/;
    expect(src).toMatch(call);
  });

  it('is rate-gated per symbol, like the calibration loop it mirrors', () => {
    expect(src).toMatch(/const ENV_SIG_INTERVAL_MS = 20 \* 3600 \* 1000;/);
    expect(src).toMatch(/nowCal - \(envSigLogged\[symbol\] \|\| 0\)\) >= ENV_SIG_INTERVAL_MS/);
  });

  it('exposes a read endpoint that states its own emptiness', () => {
    expect(src).toMatch(/path === '\/envelope-accuracy'/);
    expect(src).toMatch(/says nothing until it has/);
  });

  it('writes are batched and fault-isolated — a logging failure must not break the cron', () => {
    expect(src).toMatch(/\[envsig\] write err/);
    expect(src).toMatch(/\[envsig\] due-load err/);
  });
});
