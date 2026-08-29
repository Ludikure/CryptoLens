# Do policy catalysts predate tradeable moves? — PRE-DECLARED DESIGN

**Status:** design frozen 2026-08-22, BEFORE any result was computed.
**Origin:** the 2026-08-21 news feature ([[rejected-hypotheses]] discipline — a context feature that
cannot be validated forward was shipped labelled as such). User asked whether similar news
historically predated moves. This is that test.

> Everything below the line "RESULTS" was written after the numbers came back. Everything above it
> was written before. That ordering is the whole point — see `edge-methodology`.

## The question, split

"Did news predate moves" hides three hypotheses with very different value:

| | Hypothesis | Pre-declared stance |
|---|---|---|
| H1 | Catalysts predict DIRECTION (up vs down) | **Not tested.** Direction is a coin flip on clean data across every primitive tried ([[edge-direction-primitive]], [[rejected-hypotheses]]). A positive result here would be evidence of a bug, not an edge — see the 2026-06-02 leak. Reported as a descriptive sanity check ONLY, never as a signal. |
| H2 | Catalysts predict VOLATILITY (`goodR`) | **Primary test.** Same target the ML model is fit to, so a positive result is directly actionable as a v15 feature candidate. |
| H3 | Chase-guard FLATs age badly on catalyst days | **Suggestive only.** n is structurally tiny (see Power). Reported with that caveat attached regardless of outcome. |

## Data

- **Price/labels:** `ml-training/csv_exports_v14/` — 77 crypto symbols, 4H bars, 2020-01-01 →
  2026-06-29, leak-audited (the v14 regen closed the in-progress-daily-candle leak). Labels
  `fwdMaxFavR` (24h), `fwdMaxFavR48H`, `fwdMaxFavR72H`, `fwdMaxUp24H`, `fwdMaxDown24H` are
  precomputed — this test does NOT recompute them, so it inherits the audited definitions.
  BTC base rate: 48.1% goodR over 14,230 bars.
- **Events:** Federal Reserve + SEC press-release archives. Dates are encoded in the release URLs
  (`monetary20241203a.htm`), so no HTML parsing is needed to timestamp an event.

## Event definition — mechanical, declared before looking

Two sets, both defined by SOURCE and not by my judgement of importance:

- **`FED_ALL`** — every Federal Reserve press release in the yearly archives (monetary, orders,
  bcreg, other). Broad, noisy, high n.
- **`FED_MONETARY`** — releases whose URL slug begins `monetary` (FOMC statements, implementation
  notes, minutes). The subset with an actual macro-policy mechanism.
- **`SEC_ALL`** — every SEC press release.

**Explicitly forbidden:** selecting "the ones that mattered", filtering by keyword after seeing
results, or dropping an event because the market didn't move. Retrospective selection of important
news is the single most powerful way to manufacture a fake result here.

## Timestamping — conservative to the point of costing signal

Release URLs carry a DATE, not a time. Fed releases land anywhere from 08:30 to 16:30 ET; FOMC
statements at 14:00 ET. Rather than assume, **an event on date D is timestamped 23:59:59 UTC on D**,
and only bars OPENING STRICTLY AFTER that count as post-catalyst.

This deliberately discards the same-day reaction — the largest part of the move. That is the correct
trade: the user's question is whether news *predates* a move, so measuring only what follows a
provably-complete event is the honest form. It also makes lookahead structurally impossible, which
matters more than sensitivity given this project's leak history.

## Primary test (H2)

For each event set, label every 4H bar by `hoursSinceEvent` and compare `goodR` rate against the
symbol's own baseline:

- Windows: **0-24h**, **24-48h**, **48-72h** after an event.
- Baseline: all bars for that symbol NOT within 72h of any event in the set.
- Statistic: goodR rate difference in percentage points, plus a two-proportion z-test.
- Also reported: mean `fwdMaxFavR`, and mean `|fwdMaxUp24H| - |fwdMaxDown24H|` as the H1 sanity check.
- **Walk-forward:** the same computation per calendar year (2020…2026). A result that only exists in
  one year is a regime artifact, not an effect.

### Ship bar — declared now

To call H2 real and promote catalyst-proximity to a **v15 feature candidate**, ALL must hold:

1. goodR lift ≥ **+3.0pp** over baseline in the 0-24h window, on `FED_MONETARY`.
2. The lift is **positive in ≥ 5 of 7** calendar years (walk-forward stability).
3. n ≥ 200 post-event bars in the window.
4. The 24-48h window lift does not EXCEED the 0-24h lift — an effect that grows with distance from
   the event is a seasonality confound, not a catalyst response.

Anything less is written up as **not supported** and filed in [[rejected-hypotheses]]. A lift under
+3pp is not worth a feature slot: the 2026-07-05 audit found ~40-60 existing features contributing
nothing, and the model already has `earningsProximity` covering scheduled-event proximity for stocks.

**Pre-registered expectation (so the writeup can't drift):** I expect a modest positive lift on
`FED_MONETARY` at 0-24h, because elevated volatility around FOMC is well documented — and I expect
it to largely REPRODUCE what the app already encodes via the economic calendar and `macro_IMMINENT`.
The genuinely new information would be `SEC_ALL` (unscheduled), where I expect n to be adequate but
the effect to be diluted by enforcement minutiae unrelated to crypto. **A confirmatory result is
therefore of low marginal value; the useful outcomes are a clear null, or a surprise on SEC.**

## Power (H3) — stated before running, not after

FOMC produces ~8 statements/year → ~50 events since 2020. Bars that are BOTH within 24h of one AND
in a chase-guard FLAT state on a given symbol are a small fraction of that. **This cannot reach
significance.** It is run for direction-of-effect only and will be reported as anecdote.

## Known limitations

- **Survivorship:** `csv_exports_v14` contains surviving symbols only; no delisted tokens.
- **Same-day discarded:** by construction (see Timestamping) — the immediate repricing is invisible
  to this test, so any measured effect is a LOWER bound on the true event response.
- **Crypto-specific catalysts** (an ETF approval, a legalization vote) number ~a dozen in 6 years.
  Not testable. This test says nothing about them, and the writeup must not imply otherwise.
- **US-centric:** no ECB/BoJ/PBoC, which move crypto too.

---

## RESULTS

Run 2026-08-22. Events: **986 Fed press releases** (2020-2026, from the yearly archives —
`ml-training/news_backfill.py`), of which **177 `monetary`**. Bars: BTCUSDT 4H from
`csv_exports_v14`, 14,230 bars, baseline goodR 48.1%. Test: `ml-training/news_catalyst_test.py`.

### Verdict: NOT SUPPORTED — clean null. Filed in [[rejected-hypotheses]].

| Pre-declared criterion | Result | |
|---|---|---|
| 0-24h lift >= +3.0pp (FED_MONETARY) | **-0.8pp** | FAIL |
| positive in >= 5 of 7 years | 4/7 | FAIL |
| n >= 200 post-event bars | 984 | pass |
| 24-48h lift does not exceed 0-24h | -1.9 vs -0.8 | pass |

### The naive numbers were NEGATIVE — and that was an artifact of my own design

The raw comparison looked like Fed releases *suppress* volatility: FED_ALL 0-24h **-10.8pp**
(z=-10.4), FED_MONETARY 48-72h **-15.8pp** (z=-9.0). Reporting that as a finding would have been
wrong. Diagnosed instead:

**BTC goodR by weekday** — Mon 57.9 / Tue 52.4 / Wed 55.7 / Thu 52.4 / **Fri 34.8** / **Sat 24.6** /
Sun 59.1. A 34pp swing, consistent with `dayOfWeek` being crypto's top permutation feature
(2026-07-05 audit, +0.048).

Fed releases are dated on weekdays, and the pre-declared conservative timestamp (23:59:59 UTC of
the release date, chosen to make lookahead impossible) pushes the entire 0-24h window onto the
FOLLOWING day. For Thursday and Friday releases — the bulk of them — that window lands on Friday
and Saturday, the two lowest-goodR days of the week. Meanwhile the >72h baseline systematically
EXCLUDES weekends (a Friday release's 72h window swallows Sat/Sun/Mon), leaving it 83% weekday
against a calendar-neutral 71%. Event window and baseline therefore sat on opposite ends of a
strong seasonal gradient.

### Confound-controlled (day-of-week stratified, post-hoc diagnostic)

Comparing event bars only against baseline bars of the **same weekday**, weighted by event-bar count:

| Set | Window | Controlled lift |
|---|---|---|
| FED_MONETARY | 0-24h | **-0.57pp** |
| FED_ALL | 0-24h | **-1.68pp** |
| FED_MONETARY | 0-48h | **+1.20pp** |

The effect vanishes. Nothing here approaches the +3.0pp bar in either direction. **Policy-catalyst
proximity does not predict a 24h ATR-normalized move in BTC**, on this event set, at this
timestamp resolution.

### What this does and does not license

- **Does NOT license** promoting catalyst proximity to a v15 ML feature. Explicitly rejected.
- **Does NOT invalidate** the shipped news feature — which was labelled context/narrative, never an
  edge, precisely because it could not be validated. This test is the confirmation that the label
  was right, not a reason to remove it: telling the user *why* the tape is moving remains useful
  even when the fact of a catalyst carries no predictive information about the next 24h.
- **H1 (direction)** was not tested as a signal. Descriptively, forward up/down excursions were
  symmetric in every window (e.g. FED_MONETARY 0-24h: up +2.71% vs down +2.50%) — consistent with
  the coin-flip result everywhere else in this project.
- **H3 (chase-guard FLATs on catalyst days)** was NOT run. It was pre-declared underpowered
  (~50 FOMC events, of which only a fraction coincide with a chase-FLAT state), and with H2 a clean
  null its prior is now lower still. Running it would have produced a number the design already
  committed to calling anecdote. The catalyst framing line shipped 2026-08-22 therefore stands as a
  MESSAGE-quality change with no evidence behind it as a predictor — which is exactly how it is
  worded and gated (it does not open the FLAT).

### Reusable methodology lesson

**Any event study on crypto must control for day-of-week before believing an effect.** The
seasonality is large enough (34pp peak-to-trough on goodR) to manufacture a double-digit "result"
from any event set that clusters on weekdays — which is every economic, regulatory, or corporate
calendar. A >Nh-from-any-event baseline is NOT calendar-neutral and silently selects for weekends.

---

## ADDENDUM: is the news block INERT? (2026-08-23)

Separate question from the predictive null above: forget whether headlines predict anything — do
they change the model's OUTPUT at all? An input the output never reacts to is decoration, and that
failure has bitten twice (the mandate satisfiable in prose while the JSON block emitted `[]`; the
news block shipped with no output instruction).

**v1 was structurally incapable of answering it.** All four sampled symbols sat in envelope
auto-FLAT, where the setup gate is UPSTREAM of anything news could influence — the decision could
not change whatever the headlines said. It also checked news terms only in the with-news arm, where
"Fed" and "ETF" occur for unrelated reasons. Two design errors, both avoidable by asking "what
result would falsify this?" first.

**v2 fixes** (`ml-training/news_inertness_test.py`):
1. **Free pre-screen** via `promptOnly` — identify auto-FLAT bars for nothing, spend LLM calls only
   where a decision can move. Today: **1 of 10 symbols tradeable**, which is why v1 found nothing.
2. **A/A noise baseline** — run the same config twice. LLM text varies by sampling, so A-vs-B is
   uninterpretable without knowing A-vs-A'. This is the change that made the result readable.
3. **Attributable citation** — distinctive tokens from the ACTUAL headlines, required present in the
   with-news arm and ABSENT in the without-news arm.

| symbol | A vs A' (noise) | A vs B | decision with | decision without | attributable |
|---|---|---|---|---|---|
| SOLUSDT (tradeable) | 0.50 | **0.51** | LONG@94.01/sl91.15 | **identical** | none |
| BTCUSDT (auto-FLAT) | 0.42 | 0.36 | NO_SETUP | NO_SETUP | `minutes` |

**Result: on a no-catalyst day the block changes nothing measurable.** A-vs-B divergence equals the
sampling floor, and the setup is identical down to the stop. BTC citing `minutes` (from "Minutes of
the FOMC") shows the model does read the block — it is not ignored wholesale.

**This is consistent with CORRECT behaviour, not proof of inertness.** The guidance explicitly tells
the model to say nothing about headlines that do not explain the tape, and the freshest primary item
was days old. The decisive test needs a bar that is BOTH tradeable AND carries a live catalyst;
today supplied neither together. Harness is built and verified — three calls per symbol to re-run.

**Honest cost note:** on quiet-news days the block spends ~1,000 prompt characters to change nothing.
Small, but it is a real cost and the value case rests entirely on catalyst days, which remain
unsampled.
