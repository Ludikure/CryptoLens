# T7 — Does mechanism diversification survive HONEST inputs? — PRE-DECLARED DESIGN

**Status:** frozen 2026-08-23, BEFORE any result. Follow-up named at the end of [[regime-rotation]].

## The question

T6's real finding was its control: equal-weight across six mechanisms returned Sharpe 1.17 at −17.2%
drawdown against buy-and-hold's 0.40 at −80.6%. **But two of the six exposures carried numbers I had
already flagged as untrustworthy**, and both flatter the result:

| exposure | as measured in T6 | why it cannot stand |
|---|---|---|
| convex | +577.8%, Sharpe 3.01 | inherits [[vol-conditioned-tail]]'s unreconciled EV (+0.37R) — contradicts the trustworthy **−0.008R net** at the user's fees ([[strategy-breakeven]]) |
| carry | +75.6%, Sharpe 4.78 | Binance funding, which the user cannot access; −3.0% maxDD excludes venue risk entirely |

So T6's headline could be an artifact. This test asks the only question that matters:

> **Does mechanism diversification still beat buy-and-hold when the two contaminated exposures are
> replaced with their honest, reachable values?**

## Method — a sensitivity analysis, not a reconciliation

I have NOT reconciled why T5's convex EV differs from the vault's. Rather than pretend otherwise,
both assumptions are run side by side and the question becomes whether the conclusion is robust:

- **OPTIMISTIC arm** — exposures exactly as measured in T6 (the contaminated version).
- **CONSERVATIVE arm** — the same series with two corrections, **shape and variance preserved,
  location shifted**:
  - `convex` shifted so its mean net R equals **−0.008R** (the trustworthy figure at 0.25% round trip).
  - `carry` scaled so its annualised mean equals **8%** — the Coinbase COVERED basis on total capital
    ([[funding-carry]]), not Binance's 15.2%.
  - `trend`, `hold`, `volsell`, `cash` unchanged; they were never in question.

Shifting location while preserving shape is the honest conservative move: it keeps each mechanism's
realistic volatility and correlation structure (which is what diversification actually exploits)
while removing the disputed return.

**A third arm, HARSH**, additionally zeroes `volsell` (retail cannot reach defined-risk crypto
straddles) — testing whether the result rests on an exposure the user cannot trade either.

## Ship bar — all five required, evaluated on the CONSERVATIVE arm

1. Beats buy-and-hold on **Calmar**
2. Beats buy-and-hold on **max drawdown** by ≥20pp
3. **Positive** total return
4. Beats buy-and-hold on Calmar in **≥2 of 3** folds
5. Advantage **persists on the final untouched 20% holdout**

Criterion 2 carries real weight: the entire practical case for this is surviving an −80% drawdown,
which is the thing a single user actually cannot sit through.

**Pre-registered expectation:** genuinely uncertain. Diversification's benefit comes from imperfect
correlation, which the shift preserves — but with convex at break-even and carry at roughly half its
Binance rate, two of the four return engines are largely switched off. If it still wins on Calmar,
that is a real and *reachable* finding. If it does not, T6's headline was an artifact and should be
recorded as one.
