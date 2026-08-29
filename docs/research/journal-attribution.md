# Journal + attribution — what it measures, and what it will say for months

**Phase 3 of the corrected spec (§42).** The spec's one-line brief: *"Highest-value item in the
spec: it is what catches abstention-vs-selection."* Definitions are fixed here BEFORE the first
entry exists, so the comparison cannot be tuned to the data later.

Related: [[redesign-spec-corrections]] (§21 effective n, §25 Tier 1 only, §35 forward log),
[[excursion-model]], [[strategy-targets-bands]].

## The question

When you act, does it beat not acting? And when you choose which of the system's proposals to
take, does your choosing beat taking them all?

Nothing in the app could answer either. The system grades **what it proposed** (28 setups and 243
FLAT decisions resolved by the cron as of 2026-08-28) and has **no record of what you did**: the
manual-close endpoint has never been called, `notes` is empty on all 61 outcomes, and every
`pnl_percent` is 0. Scanner rows were never logged at all — they vanished on the next scan.

## Three populations

| population | definition | where it comes from |
|---|---|---|
| **Proposed** | everything the system put in front of you that could have been traded | analysis setups (`tracked_setups`, kind=setup) + scanner rows that cleared the display floor (new `opportunity_log`, shown=1) |
| **Taken** | proposed items you marked *"I took this"* — plus any trade you journal by hand | new `journal_entries` |
| **Skipped** | proposed − taken | derived |

Near-miss and sub-floor scanner rows are logged too (shown=0) so a future test can ask whether the
floor is set right, but they are NOT "proposed" — you never saw them.

## Realised R — the same definition for every population

- **Scanner row**: graded at the structure it was priced at (1 ATR stop, 5R target, 72h) on the
  box's own 1h candles, first bar strictly after the scan. Target first → +5; stop first → −1;
  neither → horizon close in R. **Same-bar target-and-stop counts as the STOP** (conservative —
  1h bars cannot order intrabar). Net of the row's `feeBurdenR`.
- **Analysis setup**: the system's own mechanical management, which is what the cron simulates
  — half off at TP1, stop to break-even, runner to TP2 (the composite-band execution from
  [[strategy-targets-bands]]). `loss` −1 · `partial_be` +½·RR₁ · `tp1_win` +½·RR₁ (runner
  stopped at BE) · `tp2_win` +½·RR₁ + ½·RR₂. Gross — the analysis path does not model fees, and
  the number is labelled that way.
- **Taken, closed with a fill and an exit**: `(exit − fill) / (fill − stop)`, signed for the side.
  This is the only figure in the app that is YOUR result rather than the system's.
- **Taken, not closed**: inherits the linked proposal's R once graded, under the stated
  assumption *"graded as if managed the way the system manages it."* Shown as such.

## Tier 1 metrics only (§25)

Per population: n, **effective n**, expectancy (mean R), win rate (R > 0), mean MFE and MAE in R,
profit factor, fee burden (scanner rows), and period consistency by calendar month. No Sharpe, no
CAGR, no drawdown — those need the Phase 4 portfolio engine and are not reported before it exists.

**Effective n for discrete trades**: trades on the same symbol whose holding windows overlap are
one observation. Greedy clustering on start time. Stated on every count as *"12 trades (~7
independent)"*, never the raw count alone — §21's rule, applied to trades rather than bars.

## The two numbers

- **Selection** = E[R | taken] − E[R | proposed]. Positive: your choosing beats taking everything.
  Negative: your choosing costs you and the list was better than your picks.
- **Abstention** = E[R | skipped]. Negative: the trades you left alone lost, and not trading
  earned it. Positive: you skipped winners.

Both with a 95% bootstrap CI over trades (B = 2000, fixed seed). Plus **execution drag** =
mean(R at your fill − R at the proposed entry) over closed entries that carry a fill, which
separates "picked badly" from "entered badly".

## Verdict rule — pre-declared

No verdict word is rendered until **taken ≥ 10 AND skipped ≥ 10**. Below that the screen shows
the counts and the bar, and nothing else. At or above it:

- selection CI entirely above 0 → *"Your picks beat the list"*
- entirely below 0 → *"The list beat your picks"*
- spans 0 → *"No difference yet"* — reported as such, never rounded to a finding.

Same rule for abstention against 0.

**This will say "not enough data" for months.** That is the correct output. §35's forward log
carries the same caveat — *"It reports nothing for months"* — and the value is in the record
accumulating from the first entry rather than from whenever someone remembers to start.

## What it deliberately does not do

- No broker import. `/basis` is the only exchange integration and it is read-only by design;
  the journal is two taps at the moment you act, not a fills feed.
- No "why I skipped" prompt in v1. Skipped is implicit. A reason field is the obvious next
  addition once the population exists to attribute.
- No score. Two numbers with intervals, and counts.
