// The Conviction Envelope — the app's sizing/permission function.
//
// WHY THIS IS ITS OWN MODULE (2026-08-26, plan step 1.8). Two reasons, both operational:
//
//  1. **Three of the four verdict lists are unobservable from the prompt.** `buildUserPrompt`
//     renders `HIGH_blocked_because` / `MODERATE_blocked_because` / `downgrade_one_tier_...` only
//     in the `else` branch of `if (autoFlat.length)`, so on a FLAT bar they are computed and
//     discarded. Nothing outside the builder could see them, which is why every envelope
//     measurement to date RECONSTRUCTED the rules in Python — and all five measurement defects
//     found in the 2026-08-25 reviews were reconstruction defects.
//  2. `scripts/exportEnvelope.ts` needs a per-bar verdict to join against `csv_exports_v14`. It
//     must call the SAME function production calls; a second implementation is the thing being
//     eliminated.
//
// This is a behaviour-preserving extraction of `prompt.ts` Phase C10. The rule bodies and their
// research comments moved verbatim; only the identifiers changed (locals in `buildUserPrompt`
// became fields of `EnvelopeInput`). The 776-test suite is the equivalence check.
//
// Deliberately PURE: no I/O, no clock, no `Date.now()`. `daysToEarnings` is resolved by the caller
// so the module has no notion of "now", which is what makes a historical replay honest.

export type ConvictionTier = 'FLAT' | 'LOW' | 'MODERATE' | 'HIGH';

export interface EnvelopeInput {
  /** Raw model ML_WIN in 0..1 (`indicators[0].mlWinProbability`), or null when unavailable. */
  rawMlWin: number | null;
  /** Live-calibrated ML_WIN in 0..1. The gates key on this when present (2026-07-02). */
  calibratedMlWin: number | null;
  /** `dataQuality.missingEnrichments.length` — 2+ sources missing downgrades a tier. */
  staleCount: number;
  /** `ANY_KILLED` — note this is only ever true on counter-trend-pullback bars (prompt.ts:848). */
  anyKilled: boolean;
  /** 'NONE' | 'ON_HORIZON' | 'UPCOMING' | 'NEARBY' | 'IMMINENT'. */
  macroRisk: string;
  /** Headline direction conflicts with the technical thesis. */
  newsConflicts: boolean;
  /** 'ALIGNED_BULLISH' | 'ALIGNED_BEARISH' | 'MIXED' | 'UNKNOWN' | … */
  alignment: string;
  /** 'LONG' | 'SHORT' | 'FLAT' — the daily-bias direction. */
  alignedDirection: string;
  /** 0..3 continuation signals (4H volume, EMA stack, funding support — the last is crypto-only). */
  continuationCount: number;
  isCrypto: boolean;
  isStock: boolean;
  /** Post-A/B-collapse this is always true; kept so the treatment-gated rules stay legible. */
  isTreatment: boolean;
  /** 'TRENDING' | 'RANGING' | 'TRANSITIONING'. */
  regime: string;
  /** 'PASS' | 'PARTIAL' | 'FAIL' | 'n/a' (LONG_CONFIRMATION; stocks only). */
  longConfirmStatus: string;
  /** Daily and 4H agree and 1H opposes them — the counter-trend pullback state. */
  oneHOpposes: boolean;
  cryptoBearRegime: boolean;
  /** Whole days to the next FUTURE earnings report, or null when none is scheduled ahead. */
  daysToEarnings: number | null;
  /**
   * RAW-scale cut that rejects the weakest `COVERAGE_FLOOR` of the live prediction distribution,
   * from `coverageCut()`. When present it REPLACES the fixed `calibrated < 50` floor.
   *
   * The floor was built to reject ~45% of bars and had come to reject 8.0%, because the PAV curve
   * kept moving under a cutoff expressed as a fixed level (calibrated 50 now means raw 30.3%). This
   * makes SELECTIVITY the invariant instead of the number, so recalibration cannot silently loosen
   * it again. Pre-declared in `docs/research/ml-floor-coverage.md`.
   *
   * null when there is too little live data to invert a distribution — the level-based floor is then
   * used unchanged, which is the safe direction.
   */
  mlCoverageCut: number | null;
}

export interface EnvelopeVerdict {
  /** Truncated percent of the raw model value, for display next to the calibrated one. */
  rawMlPct: number | null;
  /** Truncated percent of the value the gates actually used. */
  mlPct: number | null;
  /** Raw would have auto-FLATted but the live calibration lifted it over the floor. */
  calibLifted: boolean;
  autoFlat: string[];
  highBlocks: string[];
  moderateBlocks: string[];
  downgrade: string[];
  maxAllowed: ConvictionTier;
}

const iTrunc = (v: number) => Math.trunc(v);                            // Swift Int()

export function evaluateEnvelope(input: EnvelopeInput): EnvelopeVerdict {
  const { staleCount, alignedDirection, isTreatment, isStock, regime, oneHOpposes } = input;
  const rawMlPct = input.rawMlWin != null ? iTrunc(input.rawMlWin * 100) : null;
  // The ML auto-FLAT keys on the CALIBRATION-CORRECTED value (2026-07-02) — the raw number
  // has drifted low (30-50 bucket realizing ~65%), so keying the hard "no trade" on it was
  // over-suppressing tradeable-quality bars ("no trade auto-FLAT for 2 days while BTC ran").
  const gateMlWin = input.calibratedMlWin ?? input.rawMlWin;
  const mlPct = gateMlWin != null ? iTrunc(gateMlWin * 100) : null;
  const calibLifted = input.calibratedMlWin != null && rawMlPct != null && rawMlPct < 50 && mlPct != null && mlPct >= 50;
  const autoFlat: string[] = [];
  // THE HARD FLOOR. Expressed as COVERAGE when a live distribution exists, as a LEVEL otherwise.
  //
  // This REPLACES the fixed `calibrated < 50`; it does not add a gate. Same population, same
  // placement in `autoFlat`, same `ML_WIN_` reason prefix (which `isQualityGateReason` matches, so
  // the FRAMING hatch keeps working — losing that was one of the five defects that got the Part 11
  // version reverted within a day).
  //
  // The cut is on the RAW scale because that is the scale the distribution is measured on. Comparing
  // a raw value against a raw percentile is the whole point: it is immune to the calibration curve
  // moving, which is what broke the level version.
  //
  // SCOPED TO SHORT (2026-08-26). The coverage form was built for drift-resistance and that argument
  // is unchanged, but applying it to LONG would have been a large, unjustified behaviour change:
  //
  //   - 0.45 coverage cuts at raw 0.491, and the three LONG bands that measured POSITIVE
  //     (0.25-0.30, 0.30-0.35, 0.35-0.40) all sit BELOW it. Long setups would have been all but
  //     eliminated. The existing level floor rejects 6.1% of bars and permits raw 0.31+, which
  //     happens to preserve exactly those bands — the "5x loosening nobody decided" was, by
  //     accident, right for this side.
  //   - The justification for gating on ML at all is SHORT-side. Cross-sectional AUC — measured
  //     WITHIN a timestamp, so it cannot be a date proxy — is 0.53 on SHORT and 0.4993 on LONG.
  //     On longs the signal carries no information about whether the trade pays, so a floor built
  //     from it is filtering on noise.
  //
  // Note the argument is ABSENCE of information on LONG, not evidence of harm: the pre-declared
  // inversion test (docs/research/ml-floor-long-inversion.md) FAILED — its sign reverses in
  // non-greedy tape — so nothing here claims longs do better at low ML. LONG keeps the existing
  // level floor unchanged.
  const coverageApplies = input.mlCoverageCut != null && input.alignedDirection === 'SHORT';
  if (coverageApplies && input.rawMlWin != null) {
    if (input.rawMlWin < input.mlCoverageCut!) {
      autoFlat.push(`ML_WIN_${rawMlPct}%_below_live_floor_${iTrunc(input.mlCoverageCut * 100)}%`);
    }
  } else if (mlPct != null && mlPct < 50) {
    autoFlat.push(input.calibratedMlWin != null ? `ML_WIN_${mlPct}%<50_(calibrated_from_raw_${rawMlPct}%)` : `ML_WIN_${rawMlPct}%<50`);
  }
  if (input.anyKilled) autoFlat.push('ANY_KILLED=true');
  // REMOVED 2026-08-25 — directly tested and unsupported (envelope-rules.md Part 6 + follow-up).
  //
  // Twelve variant tests, zero passes. Best SHORT lift +0.0028R against a +0.02R bar, and EVERY
  // LONG lift negative — `against bias (daily)` blocked bars averaging +0.0504R while keeping
  // +0.0186R, the same block-the-best-bars signature as biases_MIXED and alignment_not_full.
  //
  // The underlying signal is real but worthless: 4H divergence moves P(up24) by +2.24pp at
  // p=3.9e-09 and does not convert into money, while DAILY divergence is INVERTED (bearish
  // divergence precedes UP more often, significantly). One indicator, two timeframes, opposite
  // signs — a weak effect sliced two ways, not a mechanism.
  //
  // WHY THIS GOES WHILE macro_IMMINENT AND EARNINGS STAY: those guard an EXOGENOUS EVENT and
  // never claimed predictive power, so a null EV test does not refute them. Divergence CLAIMS
  // prediction, and a claim of prediction has to be earned.
  // biases_MIXED auto-FLAT is ML-GATED (2026-07-06, ml-training/mixed_flat_test.py on the
  // clean v14 regen — 870K crypto + 503K stock bars). Non-aligned bars (daily/4H mixed or
  // neutral) carry ~2× the goodR rate of aligned bars (crypto 61/59% vs 33/30%; stocks
  // 70/71% vs 39/35%) — they are compression/transition states where a >=1.5-ATR move is
  // MORE likely, and the unconditional MIXED auto-FLAT fired on ~60% of all bars while
  // suppressing the system's best volatility cell (it also made the counter-trend reversal
  // playbook unreachable: the envelope FLATted before the LLM could build the setup the
  // playbook allows). Direction remains a coin flip in EVERY state (P(up24) 48–53%), so the
  // opened window trades as a structure-led setup capped at MODERATE (the alignment
  // highBlock keeps HIGH unreachable) — never as a trend-follow. Below ML 70 the hard block
  // stands. (The old "Stoch agreement overrides this" exemption stays removed — Stoch
  // direction is noise and can't rescue a mixed-bias setup; ML_WIN gates VOLATILITY, which
  // is the edge that actually exists here.)
  // REMOVED 2026-08-25 — measured INVERTED (docs/research/envelope-rules.md Part 1).
  //
  // This rule blocked bars averaging **+0.0503R** against a **+0.0197R** baseline: it was
  // discarding the best cell in the tape, at 2/9 six-month periods positive on shorts and
  // merely noise on longs. It never passed the bar in either direction.
  //
  // The mechanism, confirmed in Part 2: both goodR and the barrier target are ATR-normalised,
  // and MIXED bars are the un-compressed state where a large move relative to ATR is MORE
  // available. Blocking them was backwards. The ML_WIN < 50 floor below still applies, so a
  // genuinely dead tape is still flatted; what is gone is the extra alignment requirement.
  //
  // (Kept as history: the 2026-07-06 change already ML-gated this rule after mixed_flat_test
  // showed non-aligned bars carry ~2x the goodR rate. That was the right direction and did not
  // go far enough — the correct gate strength turned out to be zero.)
  // `chase_into_extended_aligned_trend` REMOVED from auto-FLAT 2026-08-25 (Part 10). It was
  // added 2026-07-02 as a symmetry fix and REHABILITATED in Part 4 on the grounds that it
  // defends the CHASING arm (entering 0.25 ATR the wrong way, −0.129R/−0.195R at 0/9 periods).
  // Both of those still stand. What changed underneath them is that `ENTRY DISCIPLINE` now
  // forbids the app from chasing at all — so the guard defends against a move that can no
  // longer be made, while blocking 27% of bars from producing the entry that is the single
  // best action in the system.
  //
  // Measured as a bar filter on 274,079 opportunities, faithfully reconstructed:
  //   MARKET   SHORT −0.0005 (4/9)   LONG +0.0022 (5/9)
  //   PULLBACK SHORT −0.0017 (3/9)   LONG −0.0005 (4/9)
  // Noise in all four cells, and the robust `stretch>=2` arm is INVERTED on LONG (−0.0067, 3/9).
  // By the Part 6 principle this rule claims PREDICTION — that entering after an extended move
  // is worse — and a prediction claim must be earned.
  //
  // It survives as CONTEXT, exactly like divergence in Part 6: the loud CHASE / EXHAUSTION RISK
  // line, the "prefer a pullback entry" directive and the Risk Map instruction are untouched.
  // The reading stays; the gate goes.
  //
  // The product consequence is the point. A chase-HIGH bar can now emit a CONDITIONAL setup at
  // the measured pullback band instead of an empty array — which registers in `tracked_setups`,
  // gets monitored by the cron, and fires the entry-zone push when price actually arrives. The
  // previous behaviour named a price 0.33% away and had no mechanism to say it got there.
  if (input.macroRisk === 'IMMINENT') autoFlat.push('macro_IMMINENT');
  if (isTreatment) {
    // `treatment_long_confirm_FAIL` REMOVED 2026-08-25 (Part 8). Tested on the stock intraday
    // paths the earlier parts lacked — 487k opportunities, 159 symbols, the app's own geometry:
    // 4/9 periods, +0.0007R global, and −0.0070R on the LONG bars it actually governs. A hard
    // auto-FLAT with no measured benefit and a mild inversion where it matters, which is the
    // same profile as `biases_MIXED` and SHORT-side `alignment_not_full`. The PARTIAL cap below
    // survives: it measured mildly positive (+0.0074R, 6/9) and is a soft conviction cap rather
    // than a block, so being wrong costs far less. Both numbers are noise-scale — the
    // asymmetric action tracks the asymmetric cost, not a claim that either was demonstrated.
    //
    // Aligned-bearish stock SHORTs stay blocked, but WITHOUT the three-way escape hatch, which
    // was inert: across 43,904 applicable bars, ML≥70 fired on 1.4%, 4H Stoch bearish on 11.5%,
    // TRENDING on 32.0% — and all three together on 0.02%, SEVEN bars in four years, which then
    // averaged −0.2082R, worse than the 43,897 the gate blocked. By the Part 6 principle a
    // condition claiming predictive power must earn it; this one never once demonstrated it.
    // The ban itself is well supported: blocked bars average −0.1123R against a −0.0457R
    // stock-SHORT average (8/9 periods) — aligned-bearish shorts are 2.5× worse than stock
    // shorts generally. See docs/research/envelope-rules.md Part 8.
    if (isStock && alignedDirection === 'SHORT' && input.alignment === 'ALIGNED_BEARISH') {
      // The label carried `_measured_-0.11R` until 2026-08-26. That figure came from
      // `stock_gates.py` scoring `d0.25_{side}_oppR`, a column produced by the retracted
      // 4-hour-lookahead simulation, so the NUMBER is withdrawn and must not be quoted.
      // The GATE stands on a separate, anchor-independent fact: the three-way escape hatch it
      // replaced fired on 7 bars in four years (0.02% of applicable bars), so simplifying it to
      // a ban changed almost nothing. Whether aligned-bearish stock SHORTs should be blocked at
      // all is re-tested in Phase 3 (docs/research/envelope-rules.md).
      autoFlat.push('aligned_bearish_stock_SHORT_evidence_under_review');
    }
  }
  const highBlocks: string[] = [];
  // SCOPED TO LONG 2026-08-25 — this rule is DIRECTION-DEPENDENT, and the envelope previously
  // had no way to say so (Part 1):
  //   SHORT  lift -0.0276R, 3/9 periods — it blocked bars averaging +0.0288R and KEPT bars
  //          averaging -0.0079R, converting a positive-expectancy set into a negative one.
  //   LONG   lift +0.0264R, 6/9 periods — the one condition that cleared the pre-declared bar.
  // Applying one rule to both sides was averaging an inverted gate with a working one.
  //
  // HONEST CAVEAT, recorded rather than buried: the LONG pass improves a LOSING proposition to
  // a less-losing one (kept bars still average -0.0729R), and its likely mechanism is regime —
  // "only go long in a confirmed uptrend" means simply *fewer longs* across a window in which
  // the equal-weight basket fell 83%. It is kept because it passed the bar that was declared in
  // advance, not because the mechanism is understood.
  const alignmentBlockApplies = alignedDirection !== 'SHORT';
  if (alignmentBlockApplies
      && input.alignment !== 'ALIGNED_BULLISH' && input.alignment !== 'ALIGNED_BEARISH') {
    highBlocks.push(`alignment_${input.alignment}_not_full`);
  }
  // `continuation < 3` REMOVED 2026-08-25 (Part 9). It required all THREE continuation signals
  // — 4H volume confirmation (fires 5%), 4H EMA stack (50%), and funding support — and the
  // third is crypto-only, because index.ts:492 hard-wires `derivatives` to null for stocks.
  // Measured: P(count = 3) is 0.87% on crypto and **0.0000% on stocks**, so the rule fired on
  // 100.0% of stock bars and HIGH conviction was structurally unreachable for the entire stock
  // universe since it shipped. On crypto it left 0.87% of bars tradeable against a declared 20%
  // floor, and it measured INVERTED on LONG (−0.0981R, 3/9). Its SHORT lift (+0.1345R) is the
  // largest number in the research vault and is deliberately NOT adopted — 2,523 kept bars is
  // exactly the thin-slice trap the coverage floor exists to catch.
  if (mlPct != null && mlPct < 70) highBlocks.push(`ML_WIN_${mlPct}<70`);
  if (input.macroRisk !== 'NONE' && input.macroRisk !== 'ON_HORIZON') highBlocks.push(`macro_${input.macroRisk}_not_ON_HORIZON`);
  if (input.newsConflicts) highBlocks.push('news_thesis_conflict');
  const moderateBlocks: string[] = [];
  // SCOPED TO CRYPTO SHORT 2026-08-25 (Part 9) — direction-dependent, like `alignment_not_full`
  // before it, and one rule averaged across two sides was averaging a working gate with an
  // inverted one:
  //   crypto SHORT  +0.0303R lift, 6/9 periods, 22.5% coverage — clears all three criteria.
  //   crypto LONG   −0.0284R, 3/9 — INVERTED, the fifth condition to behave this way and the
  //                 first where that behaviour was PREDICTED in advance from the
  //                 ATR-normalisation mechanism (Part 2) rather than explained afterwards.
  //   stocks        fires on 97.4% of bars (funding is unreachable, so the count maxes at 2),
  //                 leaving 2.56% coverage — both sides under the bar and far under the floor.
  // Caveat kept in view: the SHORT pass sits in a window where the equal-weight crypto basket
  // fell 83%, so "only short a confirmed downtrend" may be regime rather than mechanism.
  const continuationBlockApplies = input.isCrypto && alignedDirection === 'SHORT';
  if (continuationBlockApplies && input.continuationCount < 2) moderateBlocks.push(`continuation_${input.continuationCount}/2+_required`);
  if (mlPct != null && mlPct < 60) moderateBlocks.push(`ML_WIN_${mlPct}<60`);
  // Label was `macro_${risk}_exceeds_NEARBY`, which rendered as "macro_NEARBY_exceeds_NEARBY"
  // — literally false, and the commonest case. The rule fires at NEARBY or closer.
  if (input.macroRisk !== 'NONE' && input.macroRisk !== 'ON_HORIZON' && input.macroRisk !== 'UPCOMING') moderateBlocks.push(`macro_${input.macroRisk}_at_or_inside_NEARBY`);
  if (isTreatment) {
    if (alignedDirection === 'LONG' && input.longConfirmStatus === 'PARTIAL') moderateBlocks.push('treatment_long_confirm_PARTIAL_cap_LOW');
    const transitioningHighOk = regime === 'TRANSITIONING' && input.alignment === 'ALIGNED_BULLISH' && (mlPct ?? 0) >= 65 && (input.longConfirmStatus === 'PASS' || input.longConfirmStatus === 'n/a');
    // The `continuation_` clause is gone with the rule it referenced — `highBlocks` can no
    // longer contain one (Part 9), and a splice pattern matching a prefix nothing emits is the
    // kind of dead branch that reads as live governance. ML_WIN_ is still stripped.
    if (transitioningHighOk) { for (let i = highBlocks.length - 1; i >= 0; i--) if (highBlocks[i].startsWith('ML_WIN_')) highBlocks.splice(i, 1); }
  }
  const downgrade: string[] = [];
  if (staleCount >= 2) downgrade.push(`data_stale_${staleCount}_sources`);
  if (oneHOpposes) downgrade.push('counter_trend_pullback_cap_MODERATE');
  if (input.cryptoBearRegime) downgrade.push('crypto_bear_regime_LONG_cap_MODERATE_halve_size');
  if (input.daysToEarnings != null) {
    const days = input.daysToEarnings;
    if (days <= 2) moderateBlocks.push(`earnings_in_${days}d_cap_LOW`);
    else if (days <= 7) highBlocks.push(`earnings_in_${days}d_cap_MODERATE`);
    else if (days <= 14) downgrade.push(`earnings_in_${days}d_downgrade_one_tier`);
  }
  // FIXED 2026-08-26 — the ladder skipped a rung. `highBlocks` cap conviction at MODERATE and
  // `moderateBlocks` cap it at LOW (see their own labels: `earnings_in_5d_cap_MODERATE` vs
  // `earnings_in_1d_cap_LOW`). The old expression tested `highBlocks.length === 0 ? 'HIGH'`
  // FIRST, so **any moderateBlock was silently ignored whenever no highBlock fired** — and that
  // is exactly the high-ML case where the caps matter most.
  //
  // Found by the new behavioural test helper on its first run: a stock ONE DAY from earnings
  // reported `max_allowed: HIGH` while its own reason list said `earnings_in_1d_cap_LOW`. The
  // model is instructed "You may NOT output a tier above max_allowed", so the operative half was
  // the wrong one — and the earnings 0-2d gate is the single condition in this system validated
  // on its own stated mechanism (7.08x the baseline gap rate, 8/8 periods). It was being
  // overridden to the TOP tier. `continuation<2` and `treatment_long_confirm_PARTIAL` were
  // equally inert.
  //
  // A cap ladder must be monotone: if MODERATE is disallowed, HIGH cannot be allowed.
  const maxAllowed = autoFlat.length ? 'FLAT'
    : moderateBlocks.length ? 'LOW'
    : highBlocks.length ? 'MODERATE'
    : 'HIGH';
  return { rawMlPct, mlPct, calibLifted, autoFlat, highBlocks, moderateBlocks, downgrade, maxAllowed };
}
