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
