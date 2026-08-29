# MarketScope redesign spec — corrections and implementation order

**Status: this document overrides the base spec wherever the two disagree.** Sections not listed
here stand as originally written. Recorded 2026-08-27 because it had no durable home — it governed
the entire redesign while existing only in a chat message, which is precisely the failure mode
[[regime-hold]] and the 2026-08-25 retractions were written to stop.

Ten defects were found in the base spec. Four are of one kind and it is worth naming: **a measured
number applied outside the population it was measured on.** That is the same defect as the
2026-08-25 entry-discipline retraction, the C5 envelope arms, and the Part 7 kill-rule reconstruction.

---

## Part A — what was wrong

| # | § | Class | The defect |
|---|---|---|---|
| A1 | 6 | FACTUAL | "SHORT is the strongest ML-supported path" conflates two models. **ML_WIN scores 0.5006 within-timestamp on SHORT payoff**, indistinguishable from LONG (0.5061). The *excursion* model is the one with SHORT utility (cross-sectional AUC 0.6220). The +0.0571R SHORT edge is a TIMING effect across periods, not bar selection, and it turns **negative in greed (−0.0467)**. |
| A2 | 9 | STALE | The target table was measured at a **2 ATR stop while LONG now ships 4 ATR**. Re-measured at each side's real stop the sign REVERSES: wider is better on both. All CIs span zero. |
| A3 | 15 | WORST | The 0–100 opportunity score has **invented weights over components that measure zero** — breakdown −0.0379 and vol-expansion −0.0355 are outright NEGATIVE. A composite over null components launders judgment as measurement, which is what §34 forbids. |
| A4 | 21 | STATISTICAL | "184 similar setups" — a 72h hold at 4h spacing means **~18 rows share an outcome**, so 184 rows is ~10 independent observations. Overstates confidence 18×. Non-independence has near-produced a finding four times in this project. |
| A5 | 12 | MISLABELLED | The Fear & Greed numbers are SHORT **at ML ≥ 0.55**, presented as unconditional short expectancy. |
| A6 | 2 | OMISSION | No regime constraint. Nearly every number comes from ONE window (2020–2026 crypto, equal-weight basket −83%, SHORT the better side ungated). |
| A7 | 35 | OMISSION | The forward logger `envelope_signals` already ships and is the ONLY mechanism that resolves A6 — absent from the spec. |
| A8 | 25 | SCOPE | CAGR / Sharpe / Calmar need concurrent-position limits, allocation and sizing. The backtester emits R-per-opportunity. That is a build, not a reporting flag. |
| A9 | 42 | SEQUENCING | Phase 1 was a rename: large surface, zero behaviour change. The SCANNER is what changes decisions. |
| A10 | 4, 15 | PROCESS | §29 requires a pre-declared test before production, and §4's seven setups plus §15's score are untested hypotheses specified as shipping features. **The spec violates its own rule.** |

---

## Part B — corrected spec (deltas only)

### §2 Research constraints — ADD SECTION E

> **E. REGIME IS A CONSTRAINT, NOT A FOOTNOTE.** Every number in this spec except the stop-width
> result comes from one window. Any rule derived from it may be reading the regime.
>
> **RULE:** a finding that has not cleared a period criterion spanning BOTH a bear and a bull is
> **provisional and must be labelled so in the UI**.
>
> Cleared to date: **LONG stop width** (10/10 periods, 2020-07 … 2025-07).

### §6 SHORT engine — replace the opening claim

- ~~"SHORT is currently the strongest ML-supported path."~~
- **"The SHORT EXCURSION model has measured cross-sectional utility (AUC 0.6220, all five criteria).
  ML_WIN does NOT — 0.5006 within-timestamp on SHORT payoff, indistinguishable from LONG."**
- The SHORT expectancy gate is **MOOD-CONDITIONED and must display it**, at ML ≥ 0.55:

  | mood | net R |
  |---|---:|
  | FEAR | +0.0616 |
  | NEUTRAL | +0.1437 |
  | **GREED** | **−0.0467** |

  **In GREED the short edge is absent. Do not present it as available.**
- KEEP `continuation < 2` (+0.0385R, 7/9, 34% coverage) — crypto only.
- KEEP `continuation < 3` excluded on coverage (1%).

### §9 Target engine — replace the table

Targets must be tested **at the side's own stop**. At shipped geometry:

| LONG (4 ATR stop) | net R | | SHORT (2 ATR stop) | net R |
|---|---:|---|---|---:|
| 4.0 ATR | −0.0041 | | 2.0 ATR | −0.0113 |
| 5.0 ATR | +0.0020 | | 2.5 ATR | −0.0145 |
| 6.0 ATR | +0.0069 | | 3.5 ATR | −0.0136 |
| 8.0 ATR | +0.0153 | | 5.0 ATR | +0.0003 |
| 10.0 ATR | +0.0168 | | 7.0 ATR | +0.0039 |

All CIs span zero. **RULE: stop and target INTERACT. Any change to one voids measurements of the
other.** Defaults stay at shipped values until a joint test runs.

### §4 Setup engine — DEMOTE TO RESEARCH

Build the engine (definitions as config, per-setup statistics, journal integration). **Do NOT ship
setups as trade triggers until each passes §29.** First pass, LONG @4 ATR / SHORT @2 ATR:

| setup | SHORT | LONG |
|---|---:|---:|
| trend continuation | +0.0073 | +0.0078 |
| pullback continuation | +0.0122 | −0.0188 |
| breakout | — | −0.0011 |
| **breakdown** | **−0.0379** [−0.0704, −0.0053] | — |
| **vol expansion** | **−0.0355** [−0.0623, −0.0104] | +0.0167 |
| vol compression | −0.0239 | +0.0296 |
| mean reversion | fires 0.4% — unevaluable, drop | |

Everything unbolded spans zero. **ACTION: breakdown-SHORT and vol-expansion-SHORT are BLOCKED, not
offered.** Definitions were proxies; a better-specified setup may do better, but the burden is on
the setup.

### §15 Opportunity score — REPLACE ENTIRELY

**DELETE the weighted 0–100 score.** Replace with a CHECKLIST that shows components without summing
them:

```
Trend           FALLING
Continuation    PASS (< 2)
Structure       BEARISH
Entry           TRIGGERED
Movement risk   HIGH (67% extreme-move)
Net expected R  +0.031
Fee burden      LOW
News            CLEAR
Mood context    NEUTRAL — short expectancy favourable
Regime status   PROVISIONAL (single-window evidence)
```

A single number may be introduced ONLY when its weights are derived from measured per-component
expectancy.

> **NOT a blanket ban on ranking numbers.** The `opportunityScore` that already ships is anchored on
> `expectedValueR` in R units with deliberately tiny tie-breakers (0.05 / 0.15 / 0.10) and a comment
> stating none has independent evidence. That one is honest. §15's proposed composite over
> trend/structure/continuation/entry is the one being deleted.

### §20 Ranking — replace the primary key

**Rank by NET EXPECTED R (fee-adjusted)**, not by setup score. Cross-sectional top-k ranking beats
random (+0.0146, CI clear of zero at k=5) but **LOSES to the plain ML ≥ 0.55 threshold gate**
(+0.0472 vs +0.0156). Do not build top-k selection as the primary ranker.

### §21 Historical analogs — add the de-overlap rule

```
effective_n = rows / (hold_hours / bar_hours)
```

Display **"184 similar bars (~10 independent)"**. Never the raw count alone.

### §25 Walk-forward — split the metrics

- **TIER 1 (now, per-opportunity):** expectancy, win rate, MFE, MAE, profit factor, fee burden,
  coverage, effective n, period consistency.
- **TIER 2 (needs the portfolio engine, Phase 4):** CAGR, Sharpe, Calmar, max DD, turnover, exposure.

Do not report Tier 2 before that engine exists.

### §35 Research lab — add section 11

> **11. FORWARD VALIDATION (primary, not another backtest).** `envelope_signals` records tier, side,
> both ML scales, all block lists, entry price and ATR, graded at +72h into `fav_r` / `adv_r`.
> **ADD at log time: Fear & Greed, the symbol's own 90d trend, setup type.** This is the ONLY
> resolution path for §2E. It reports nothing for months.

### §42 Implementation order — REORDERED

| Phase | Work | Why here |
|---|---|---|
| **1** | **SCANNER + TRADE CARD** | Changes decisions. Was Phase 4. |
| 2 | RISK ENGINE | Stop / target / expected R / fees — the only measured levers |
| 3 | JOURNAL + ATTRIBUTION | Highest-value item in the spec: it is what catches abstention-vs-selection |
| 4 | PORTFOLIO | Sizing, correlation, risk-at-stop; unblocks Tier 2 metrics |
| 5 | SHORT EXCURSION MODEL | Production candidate, LONG disabled |
| 6 | SETUP ENGINE AS RESEARCH | Per-setup stats, no trade triggers |
| 7 | RESEARCH LAB + FORWARD LOG | |
| 8 | RENAME / TERMINOLOGY SWEEP | Cosmetic. Last. |

### §43 Final principle — add one line

> "…and to state plainly which of its rules are measured, which are provisional on one regime, and
> which are merely plausible."

---

## Where Phase 1 stands

Design: `design/trade-opportunities/` (three artboards + `COPY.md`), published at
https://claude.ai/code/artifact/960dc494-aa9a-4001-ada1-116a52b1f88a

The screen is built against this document, not the base spec. In particular it ranks by net expected
R (§20), shows a checklist rather than a composite (§15), carries the regime label on every claim
(§2E), and states the mood conditioning on the short edge (§6).
