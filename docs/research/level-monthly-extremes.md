# Pre-declared: do MONTHLY highs/lows hold better than an equivalent non-calendar extreme?

**Status: PRE-DECLARATION. Written and committed before any number in the RESULT section was
computed.** Design, ship bar, power analysis and predictions fixed here first.

Related: [[strategy-levels]], [[level-daily-close]], [[edge-methodology]],
[[rejected-hypotheses]].

## The question

Do reversals cluster at monthly maximums/minimums, or close to them? Weekly was tested
(Finding 4 of [[strategy-levels]]: weekly high **+0.3pp over random on crypto = noise**);
the daily boundary was tested and rejected ([[level-daily-close]]: **−0.26pp** against a
matched control). Monthly has never been measured.

## The matched control — the whole design

A monthly high is three things at once, and only the third is the hypothesis:

1. a **visited price** (the market traded there),
2. an **extreme of a ~30-day window** — the highest price in a month is an unusual price
   regardless of where the month boundary falls,
3. an extreme **aligned to a calendar month**.

[[level-daily-close]] showed what happens when these are not separated: the daily-close
"+5.8pp" was entirely (1), and an arbitrary 4H close scored **better** than the daily one.

So the control is: **the trailing-W-bar high, anchored at a bar that is NOT a month end**,
where W is the same window length as the calendar month it is drawn beside. Identical
object — the highest price of the trailing ~30 days, known at formation, no lookahead —
differing only in whether the window happens to end on a calendar boundary.

> If a 30-day high that ends on the 31st holds no better than a 30-day high that ends on the
> 17th, "monthly extreme" is decoration.

## Arms

All through the IDENTICAL `LV.forward_outcome`, same touch/break/react thresholds, same 48h
horizon, both markets:

| arm | purpose |
|---|---|
| `monthly high` / `monthly low` | the claim |
| **`trailing-W high` / `low` at a NON-month-end anchor** | **decisive matched control** |
| `monthly close` | parallel to the daily-close test |
| `random line 0.5-3.0 ATR` | original control, for comparability with Finding 4 |

Control anchors are drawn 3 per month, uniform within the month and at least 2 bars from any
month boundary, using the same W. Control windows overlap the same tape by construction —
that is the point; only the cut point moves.

## Power — stated before running, because n is the binding constraint

The tape holds **3,846 crypto symbol-months and 8,578 stock symbol-months**. After
`forward_outcome` drops unresolved retests and after (symbol, period) clustering, the monthly
arm will plausibly land at eff_n ~700-1,500 per market. Required to detect +2.0pp at 80%
power on a ~90% base: **eff_n ≈ 3,200 per arm** (≈4,700 at an 85% base).

**So this test is underpowered for a +2pp effect by roughly 2-4×, by construction, and no
amount of care changes that — there are only so many months.** Consequences, fixed now:

- Every figure is reported with a **95% CI on the gap**, not just a point estimate.
- **A point estimate near zero is NOT by itself evidence of absence.**

## Ship bar and reporting rule — pre-declared

Monthly extremes get implemented as a level source only if **all three**:

- **(a)** monthly extreme beats the matched trailing-W control by **≥ +2.0pp** on crypto,
- **(b)** the gap is positive in **≥ 7 of 9** half-year periods,
- **(c)** same sign on stocks.

Verdict rule for a null, decided in advance so the power problem cannot be argued either way
after the fact:

- If the **95% CI upper bound is below +2.0pp** → **NOT SUPPORTED.** The effect size that
  would have mattered is excluded, and low power is no longer a defence.
- If the CI **spans +2.0pp** → **INCONCLUSIVE — UNDERPOWERED.** Reported as such, filed as
  neither supported nor rejected, and *not* written up as "monthly extremes don't work".

## Predictions, recorded in advance

1. **Monthly extremes will not clear +2.0pp against the matched control.** Seven level-
   selection metrics have now measured flat (test-count, flip-role, timeframe, Fibonacci
   ratio, formation volume, volume-at-price, day boundary). The prior is strong.
2. **Both monthly arms WILL beat the random-line control substantially** — they are visited
   prices *and* window extremes, so they inherit the ~7pp the daily-close test attributed to
   "the market traded here", plus whatever the extreme itself is worth.
3. **Crypto will be genuinely underpowered** (CI half-width > 2pp), so the crypto verdict is
   more likely INCONCLUSIVE than NOT SUPPORTED. Stocks, with 2.2× the symbol-months, have the
   better chance of a decisive CI.
4. If anything shows, it shows on the **LOW** side on crypto, not the high — the momentum
   thesis ([[edge-crypto-direction-model]]) says crypto blows through highs, and Finding 4
   already measured weekly high +0.3pp against weekly low +1.5pp.

## RESULT

*(empty — to be filled after the run)*
