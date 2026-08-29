# Pre-declared: does an LLM choosing take/skip beat taking everything the scanner proposes?

**Status: PRE-DECLARATION. Written and committed before any judge call was made.** Sample
construction, judge prompt (verbatim), arms, bar and predictions are fixed here.

Related: [[journal-attribution]] (the live version of this question, with the user in the seat),
[[excursion-model]] (the proposal source), [[edge-methodology]], [[rejected-hypotheses]].

## The question

The live journal puts the user in the seat and needs ~10 taken and ~10 skipped before it says
anything, and ~200 each side before it can see a plausible ±0.3R effect. The same question can be
asked of an AI judge over the historical tape with **n = 2,000 in one evening**, which is the only
reason to run it as a backtest: power, not novelty.

> When an LLM decides which of the scanner's proposals to take, does E[R | taken] beat
> E[R | all proposed] — and does it beat the number already on the card?

## The population — exactly what the scanner would have shown

Rows of `excursion_dataset.pkl.gz` (23 symbols, 2020-01 → 2026-06, `bar_close` anchor) scored
the way `src/trading/` scores them today:

- **SHORT** P(5R) from a walk-forward LightGBM (same params as `excursion_ev.py`, purged, expanding
  yearly folds — every scored row is out-of-fold). **LONG** at the measured base rate, because the
  LONG head is refused in production (`headIsShippable`). At base rate the LONG three-way EV is
  −0.04R before fees, so **no LONG ever clears the floor: the population is SHORT-only**, exactly
  as the live book is.
- Three-way EV per `opportunity.ts`: `pt·5 + stop·(−1) + timeout·1.431`, timeout share 0.205
  capped at `1 − pt`. Net of fee `0.171 / atrPercent` (a 1 ATR stop, so ATR% IS the stop%).
- Proposed = net EV ≥ 0.05 (`MIN_DISPLAY_EV_R`) and direction gap ≥ 0.05 (`chooseDirection`).
- Greed cancels SHORT (Fear & Greed > 60), as the app does.
- **Not applied: the envelope precheck.** It needs the full prompt builder and it measured
  +0.0012R against a coverage-matched random gate. Every judge sees the same population, so its
  absence cannot favour one arm over another. Stated, not hidden.

Sample: **2,000 proposals, stratified by half-year** (equal counts per half-year so period
consistency is measurable), **at most one per (symbol, UTC day)** to thin the overlap. Seed fixed.

## The judges

| judge | what it sees | why |
|---|---|---|
| **take-all** | nothing — takes every proposal | the list as-is; the baseline every arm is measured against |
| **card number** | net EV rank; takes the top half of the sample | the number already on the card. If the LLM cannot beat this, it adds nothing |
| **DeepSeek v4-pro** | the blinded dossier | cheap judge, full 2,000 |
| **Claude Sonnet 5** | the same dossier | the app's actual model, full 2,000 |

Both LLMs get the **same prompt, temperature 0**, and never see the EV number, the symbol, the
date, the absolute price, or anything forward. This is the June blinded harness
(`build_blinded_rich.py`) reframed from "call the direction" to "take or skip this SHORT".

## The prompt — verbatim, committed here, not to be edited after a result is seen

System:

> You are the final risk check on a systematic crypto SHORT. A model has already selected this
> setup; your only job is to decide whether to TAKE it or SKIP it. You see an anonymised technical
> dossier: symbol, date and absolute price are withheld so you cannot recall what happened.
> Answer in JSON only: {"decision":"TAKE"|"SKIP","confidence":0-100,"reason":"<=12 words"}.

User: the dossier (28 indexed 4H closes, daily/4H indicators, regime, derivatives, volume profile,
context — identical fields to `build_blinded_rich.py`) followed by:

> PROPOSED TRADE: SHORT at the current price. Stop 1 ATR above entry. Target 5 ATR below entry
> (5R). Time limit 72 hours. Historically about 1 in 10 of these reach the target, about 6 in 10
> stop out at −1R, and about 1 in 4 time out near +1.5R. Decide: TAKE or SKIP.

*(Base-rate sentence corrected to the measured proposal population before any call — amendment 1
below. The original read "1 in 13 … most stop out … 1 in 5 near +1.4R".)*

The base-rate sentence is deliberate: a judge that does not know the payoff shape will skip
everything, and "skips everything" is not a selection strategy, it is abstention.

## Metrics — Tier 1 only

Per arm: n, **effective n** (trades on one symbol with overlapping 72h windows are one
observation, greedy), mean **net** R, win rate, profit factor, coverage (share of proposals
taken), and mean net R by half-year.

**Selection gap** = mean R(taken) − mean R(all proposed), with a 95% bootstrap CI that resamples
**UTC days** (all rows on a day move together, because they share the market), B = 2000, seeded.
**Abstention** = mean R(skipped).

## Ship bar — pre-declared

An LLM judge becomes an automatic take/skip gate on the scanner only if **all five**:

1. **Magnitude**: selection gap ≥ **+0.05R** — one display floor's worth. A judge that cannot add
   what the floor demands is not adding a mechanism.
2. **Significance**: the day-clustered CI excludes 0.
3. **Period consistency**: the gap is positive in ≥ **8 of 11** half-years (counting half-years
   with ≥ 20 rows in both arms). *(Amended from 9 of 13 before any call — see below.)*
4. **Beats the card**: the gap exceeds the card-number judge's gap. The LLM must add information
   over the number already displayed.
5. **Coverage** ≥ 20% of proposals taken. Below that the arm is too thin to evaluate — the same
   floor that disqualified `continuation < 3` (Part 9).

Partial support does not ship. Two LLM judges agreeing is not a criterion; it is a consistency
check reported alongside.

## Predictions, recorded in advance

1. **Neither LLM clears the bar.** The models already consume the same 110 features the dossier
   is printed from; every rule that claimed judgment has measured flat or inverted; the blinded
   direction test in June was never even written up, which is its own tell.
2. If anything shows, it shows on **abstention** — the SKIP pile averaging below the population —
   not on selection. Avoiding the worst tape is an easier task than finding the best.
3. **The card-number judge will post a positive gap** (the model ranks; cross-sectional AUC 0.62
   is measured), and it will be small — on the order of +0.02 to +0.05R.
4. The two LLMs will agree on most rows and their gaps will be within noise of each other.
5. Coverage: both LLMs will take between 30% and 70%. A judge outside that range has a prior it
   is applying regardless of the dossier.

## Cost, stated before spending

Dossier ≈ 1.3k tokens, answer ≈ 60 tokens (JSON, no reasoning requested). 2,000 calls:
DeepSeek v4-pro ≈ **$3–7**, Sonnet 5 ≈ **$10–13**. Account balance $36. Hard cap $30 in the runner,
priced at peak rates so it can only come in under.

## Pre-run amendments — made after building the sample, BEFORE any judge call

Three corrections, each forced by looking at the sample rather than by any result:

1. **Base-rate sentence.** The prompt said "1 in 13 reach the target … 1 in 5 time out near
   +1.4R" — the pooled excursion numbers. The PROPOSAL population (post floor, post greed cancel)
   measures **target 10.5%, stop 63.9%, timeout 25.6% at +1.50R**. The sentence now says "1 in 10 …
   6 in 10 … 1 in 4 near +1.5R". A judge told the wrong base rate is being nudged toward SKIP.
2. **Period bar.** The OOF population spans **11 half-years** (2021H1–2026H1; 2020 is the first
   training block), not 13. "≥ 9 of 13" becomes **≥ 8 of 11** — the same 73%. 2024H1 holds only 43
   proposals in the whole population (80% of its bars were greed-cancelled) and will not reach the
   20-row minimum on either arm; it simply does not count.
3. **Candle source.** The 4H archive starts 2021-12-20, which silently dropped all of 2021H1 and
   most of 2021H2 on the first build (1,825 → 1,472 dossiers). The hourly Vision klines (2020-10
   onward) are resampled to 4H instead. And `fundingRateRaw` is already in percent in the dataset
   (median 0.01); the dossier had multiplied it by 100 again, printing "+50.000%".

## RESULT

*(empty — to be filled after the run)*
