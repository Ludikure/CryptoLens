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

## RESULT — NOT SUPPORTED in 5 of 6 cells; 1 inconclusive and it fails the ship bar anyway

`ml-training/level_monthly_test.py`, full sample, both markets. Gap is against the **matched**
trailing-W control (same window length, anchored off a month boundary). CIs are symbol-level
block bootstrap, B=2000.

| market | arm | HOLD | matched ctrl | gap | 95% CI | periods+ | verdict |
|---|---|---:|---:|---:|---|---:|---|
| crypto | monthly HIGH | 85.10% | 83.42% | **+1.68pp** | [−0.03, +3.53] | 6/9 | INCONCLUSIVE |
| crypto | monthly LOW | 82.98% | 85.17% | **−2.19pp** | [−3.67, **−0.64**] | 3/9 | NOT SUPPORTED (inverted) |
| crypto | monthly CLOSE | 90.84% | 91.52% | −0.68pp | [−1.66, +0.26] | 6/9 | NOT SUPPORTED |
| stock | monthly HIGH | 83.92% | 84.53% | −0.62pp | [−1.41, +0.20] | **2/9** | NOT SUPPORTED |
| stock | monthly LOW | 85.04% | 85.43% | −0.39pp | [−1.42, +0.58] | 4/9 | NOT SUPPORTED |
| stock | monthly CLOSE | 86.22% | 85.27% | +0.95pp | [−0.01, +1.88] | 6/9 | NOT SUPPORTED |

**The one cell that survives — crypto monthly HIGH, +1.68pp — fails the pre-declared ship bar
on its own point estimate anyway**: below the +2.0pp magnitude bar (a), 6 of 9 rather than 7
of 9 periods (b), and the opposite sign on stocks at 2/9 (c). Three for three. It is recorded
as inconclusive rather than rejected because the CI genuinely does not exclude +2.0pp, not
because there is a case for it.

### Crypto monthly LOWS are significantly WORSE than a matched non-calendar low

−2.19pp with a CI excluding zero, at 3 of 9 periods. A monthly low holds *less* often than
the trailing-30-day low taken at an arbitrary mid-month cut. Both crypto extremes also sit
**below the random-line control** (high −1.25pp, low −3.38pp) — though that comparison is not
distance-matched, so the matched control is the one to trust.

This is consistent with the momentum thesis ([[edge-crypto-direction-model]]): on a 24/7 tape
a widely-watched extreme is where stops sit, and price runs them. It is the same shape as
Finding 4's weekly high at +0.3pp.

**Prediction 4 was WRONG, and usefully so.** I predicted that if anything showed on crypto it
would be the LOW side. The low is the cell that came out significantly *negative*, and the
high is the only one that could not be excluded. Recorded as a miss.

### The stock month-end close is the afternoon-bar effect, not a month effect

[[level-daily-close]] measured the session's afternoon bar at **+1.70pp** over the morning
bar. A month-end close is *always* an afternoon bar; the control anchors are uniform within
the month and so are ~50% afternoon. Expected gap from that alone:

```
0.50 x 1.70pp = +0.85pp        observed +0.95pp        residual +0.10pp
```

**~90% of the stock month-end close effect is an already-identified intraday effect.** The
month boundary contributes ~0.1pp. The crypto arm decomposes the same way: a month-end close
is always the hour-20 bar, which measured 91.36% against a ~91.58% all-hour mean, predicting
≈ −0.22pp against an observed −0.68pp — same direction, no month effect needed.

### A measurement defect caught before publishing, which CHANGED a verdict

The first run used a Kish design-effect estimate clustered on (symbol, period). On the sparse
monthly arms — ~1,200 events over ~675 cells — most cells fell below the minimum-count filter
and the between-block variance became unstable. It reported **eff_n of 21 and 18** and CIs of
**±15pp**, which would have made both crypto extremes "hopelessly underpowered".

The symbol-level block bootstrap gives eff_n ≈ 1,500-2,400 and CIs of ±1.8pp. **Crypto
monthly LOW moves from INCONCLUSIVE to a decisive NOT SUPPORTED with a CI excluding zero.**
An estimator that degrades silently on sparse arms would have buried the single significant
result in this test. Standing note: a design-effect estimate needs enough events per block to
be stable, and a bootstrap does not.

### Verdict against the pre-declared bar

Nothing ships. Monthly extremes are not a level source. This is the **eighth** level-selection
metric to measure flat or inverted, after test-count, flip-role, timeframe, Fibonacci ratio,
formation volume, volume-at-price and the day boundary.

The full picture across [[strategy-levels]], [[level-daily-close]] and this note:

> Prices the market has recently traded at hold ~5-7pp better than prices it has not. **No
> method of selecting *which* traded price — by calendar (day, week, month), by structure
> (swing, flip, test count), by ratio (Fibonacci) or by volume — has ever measured better
> than the others.** Where a calendar effect does appear it decomposes into an intraday
> session effect that has nothing to do with the calendar.

### Coverage note

52-week / all-time extremes are still untested here. This tape is 4.4 years, so a 52-week
extreme arm would carry ~4 events per symbol — an order of magnitude worse powered than the
monthly arm that already could not resolve one of six cells. It needs a longer history, not
another run against this one. `fiftyTwoWeekPct` and `distToFiftyTwoHigh` do exist as stock ML
features, so the model can already use that information if it is there.
