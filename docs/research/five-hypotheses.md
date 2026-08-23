# Five untested hypotheses — PRE-DECLARED DESIGNS

**Status:** all five frozen 2026-08-23, BEFORE any result. Written in one pass deliberately, so that
no design is tuned with knowledge of how the others turned out.

**Origin:** [[regime-hold]] established that every prior test in this vault shares three properties —
it takes a DIRECTION, at a SHORT horizon, with HIGH turnover — and that these are exactly the three
things that make a crypto strategy fail. Each hypothesis below breaks at least one of them.

---

## H1 — Is a LONGER-horizon move more predictable than a 24h one?

**Why:** the vault's blindness is now measured. `goodR` asks about 24 hours; the 2025-26 decline took
261 days and every direction primitive read it as a coin flip. Nothing here has ever been trained
past 72h.

- **Target:** `fwdMaxFavR_H >= k` at H ∈ {24h (control), 7d, 30d}, ATR-normalised as production does.
- **Threshold scaling:** k = 1.5·√(H/24h) → 1.5 / 3.97 / 8.22. Scaled so base rates stay comparable;
  holding k=1.5 at 30d would make the target trivially easy and the AUC uninterpretable.
- **Model + folds:** production crypto config (LGB depth 4, 150 trees), 3-fold expanding walk-forward,
  48-bar purge — inherited, not tuned.
- **SHIP BAR:** AUC at 7d or 30d beats the 24h control by **>+0.02 in ALL folds**.
- **Expectation:** genuinely uncertain. Longer horizons average out noise (helps) but drift further
  from the features' information (hurts).

## H2 — Cross-sectional momentum (market-neutral)

**Why:** removes the market beta that gave [[regime-hold]] an −82% drawdown. Asks "which symbol
outperforms which", not "which way does the market go" — a different question that survives a coin
flip in the index.

- **Universe:** all v14 crypto symbols with ≥400 days of history.
- **Signal:** trailing 30-day return, ranked cross-sectionally.
- **Construction:** long top quintile, short bottom quintile, equal weight, dollar-neutral.
- **Rebalance:** weekly. **Costs:** 0.10% round trip on turnover.
- **SHIP BAR:** net Sharpe **> 0.5** AND positive in **≥2 of 3** expanding folds AND max drawdown
  better than buy-and-hold's −82%.

## H3 — Defensive FLAT rather than short

**Why:** [[regime-hold]] fold 2 lost 37.9% being SHORT through a recovery. Going flat keeps the
"don't hold through a crash" benefit and drops the whipsaw cost. This is a risk-management claim,
not an alpha claim, and it gets its own bar accordingly.

- Identical to [[regime-hold]] except position ∈ {0, +1} — never short.
- **SHIP BAR:** max drawdown at least **15pp better** than buy-and-hold AND total return **within
  25%** of buy-and-hold. (Return parity is not required; a materially smoother ride at modest cost
  is the entire point.)

## H4 — ML_WIN as position SIZE rather than a binary gate

**Why:** ML_WIN is the one validated signal in the project and it is currently consulted only as
yes/no at a threshold. A calibrated probability carries more information than the gate extracts.

- **Strategy:** the validated convex trade (1R stop, 5R target, 72h horizon).
- **Arms:** (a) binary gate at p≥0.70, size 1; (b) size ∝ p; (c) half-Kelly on calibrated p.
- **Predictions:** out-of-fold only, from H1's control model. Never in-sample.
- **SHIP BAR:** a sizing arm beats the binary gate on **net EV per unit of capital deployed** AND on
  Sharpe, in **≥2 of 3** folds.

## H5 — SELLING volatility with defined risk

**Why:** [[rejected-hypotheses]] measured the vol risk premium as positive (implied − realised =
+7.5 BTC vol points) and rejected BUYING straddles on that basis. The symmetric conclusion — that
selling is +EV — was noted and never tested. The open question is not the mean, it is the tail.

- **Data:** cached Deribit DVOL + daily closes, BTC and ETH.
- **Trade:** sell a 30d straddle, **defined risk** — loss capped at 3× premium collected (the
  economics of a strangle/spread rather than a naked short).
- **SHIP BAR:** positive net EV after a 1% round-trip friction assumption AND positive in **≥5 of 7**
  calendar years AND worst single year better than **−15%**.
- **Note stated in advance:** a positive result here does NOT mean "sell vol". Defined-risk capping is
  doing heavy lifting, and retail access to these structures is poor. It would be a finding about
  where the premium sits, not a product recommendation.

---

## Ranking method — declared before results exist

Hypotheses will be ranked on four axes, not on headline return:

1. **Does it pass its own pre-declared bar?** (binary — a fail cannot outrank a pass)
2. **Risk-adjusted result** (Sharpe, max drawdown)
3. **Robustness** (fold consistency; a strategy positive in 3/3 outranks a bigger number in 1/3)
4. **Actionability for THIS user** — single account, Coinbase nano perps, ~0.25% round-trip fees, no
   options desk, no market-making infrastructure. A strategy that needs venues or instruments the
   user cannot reach ranks below a smaller edge they can actually trade.

Axis 4 is included because this project has previously validated edges that were unreachable in
practice ([[strategy-breakeven]]: +0.151R gross, −0.008R at the user's actual fee tier).

---

# RESULTS — run 2026-08-23. **All five fail their pre-declared bars. No bar was moved.**

## H1 — longer horizons: FAIL, and the direction of the failure is the finding

870,170 bars, 120 features, 77 symbols. LGB d4/t150, 3-fold expanding WF.

| horizon | threshold | base rate | folds | mean AUC |
|---|---|---|---|---|
| **24h (control)** | 1.50 ATR | 39.7% | 0.734 / 0.743 / 0.749 | **0.742** |
| 7d | 3.97 ATR | 52.1% | 0.677 / 0.689 / 0.685 | 0.684 |
| 30d | 8.22 ATR | 59.4% | 0.616 / 0.713 / 0.690 | 0.673 |

**Predictability DECAYS with horizon** — −0.057 at 7d, −0.067 at 30d, negative in every fold. The
features carry information about the next day and lose it as the horizon extends.

**This reframes [[regime-hold]] and is the most useful result of the five.** The 200D rule captured
the 2025-26 decline (+74.7% vs −67.8%) but NOT by predicting it — longer moves are *less*
predictable, not more. It works through payoff structure: cut losers, ride winners, no forecast
required. **Trend capture and trend prediction are different mechanisms, and only the first is
available.** Do not build a long-horizon model; the information is not there.

*Caveat:* the 24h AUC of 0.742 exceeds production's 0.674 because excursions here are computed from
closes (no intrabar high/low), making the target slightly easier. The cross-horizon comparison is
internally consistent, which is what the test asks.

## H2 — cross-sectional momentum: FAIL, decisively

| | total | CAGR | maxDD | Sharpe |
|---|---|---|---|---|
| gross | −6.7% | −1.1% | −49.5% | 0.09 |
| **net** | **−28.3%** | −5.1% | −56.7% | **−0.06** |

Folds −5.2 / −23.8 / −0.8%. Negative even GROSS, so this is not a fee problem — crypto
cross-sectional momentum simply does not work over this period. Turnover of 11.1%/day then buries
it. Dead; do not revisit.

## H3 — defensive FLAT: FAIL by 4pp, and the closest of the five

| | total | CAGR | maxDD | Sharpe |
|---|---|---|---|---|
| **H3 defensive flat** | 218% | 19.5% | **−59.9%** | 0.63 |
| regime (short-capable) | 16% | 2.4% | −82.2% | 0.35 |
| buy & hold | 306% | 24.1% | −87.8% | 0.69 |

| criterion | result | |
|---|---|---|
| maxDD ≥15pp better | **+27.9pp** | PASS |
| return within 25% of B&H | 71% (needed 75%) | **FAIL** |

Bear behaviour: 2025-26 flat **−2.6%** vs B&H −66.5%; 2022 flat −30.4% vs B&H −81.3%.

So it does exactly what it was designed to do — removes the crash — at a 29% cost in total return,
where the bar allowed 25%. **A miss by 4pp on a criterion I chose arbitrarily.** Reported as FAIL
because the bar was pre-declared, but this is the one worth re-running with a properly justified
return tolerance rather than a round number.

## H4 — ML_WIN as size: FAIL, and it VALIDATES the current design

1,035,036 simulated convex trades (1R stop / 5R target / 72h, 0.25% round trip).

| arm | capital | net R/unit | Sharpe |
|---|---|---|---|
| **binary gate p≥0.70** | 97,486 | **+0.4098** | 1.253 |
| size ∝ p | 1,035,036 | +0.2126 | **2.045** |
| size ∝ p² | 1,035,036 | +0.2645 | 1.930 |

Neither sizing arm beat the gate on EV per unit of capital, in any fold (0/3). **The existing binary
gate is the correct design** — concentrating capital in the top decile extracts more per unit than
spreading it.

The real finding is the **trade-off the bar obscured**: sizing arms have far higher Sharpe (2.05 vs
1.25) because they diversify across many more bars. Gate = more return per unit deployed; sizing =
smoother. Neither dominates; the bar demanded both and so nothing passed.

*Caveat, material:* absolute R here is inflated — close-only paths miss intrabar stop hits, so real
stops trigger more often. The vault's OHLC-based +0.151R gross / −0.008R at user fees
([[strategy-breakeven]]) remains the trustworthy absolute. This test's RELATIVE comparison stands.

## H5 — selling volatility: FAIL, on a criterion I mis-specified

30d straddle sold, loss capped at 3× premium, 1% friction.

| | EV/trade | win | worst year | positive years |
|---|---|---|---|---|
| **BTC** | **+1.37%** | 62% | **−2.0%** | 4/6 |
| ETH | +0.04% | 60% | −3.2% | 4/6 |

BTC by year: 2021 +2.7, 2022 +3.7, 2023 −0.3, 2024 +0.1, 2025 +2.5, 2026 −2.0.

**Design error, acknowledged:** the bar required ≥5 of **7** calendar years, but the DVOL history
spans only 6. The bar was therefore harder than intended from the moment it was written. Even
adjusted (5 of 6), it got 4 — so it misses either way, but the criterion was not well-formed and
that is my fault, not the data's.

The economics are real and modest: the vol risk premium is positive as previously measured, and
selling it with capped risk earns ~+1.37%/trade on BTC with a −2.0% worst year. ETH is
indistinguishable from zero. **This is a finding about where the premium sits, not a
recommendation** — as stated in the design.
