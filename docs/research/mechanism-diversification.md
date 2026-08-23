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

---

# RESULTS — run 2026-08-23

Corrections applied as declared: convex mean net R **+0.1629 → −0.0080**; carry annualised
**10.8% → 8.0%**. Shape and variance preserved.

## The pre-declared bar: PASSES 5/5

| arm | total | CAGR | maxDD | Sharpe | Calmar |
|---|---|---|---|---|---|
| EW optimistic (T6, contaminated) | 139.3% | 18.1% | −17.2% | 1.17 | 1.05 |
| **EW CONSERVATIVE (honest inputs)** | **66.0%** | 10.1% | **−24.6%** | 0.71 | **0.41** |
| EW harsh (volsell also removed) | 54.3% | 8.6% | −30.1% | 0.62 | 0.29 |
| buy & hold | 7.8% | 1.4% | −80.6% | 0.40 | 0.02 |

All five criteria pass, including the holdout (Calmar 0.48 vs −0.79). The corrections worked as
intended — convex becomes a **negative** contributor (−12.7%, Sharpe −0.15), and the result survives
without it. The harsh arm still beats buy-and-hold, so the conclusion does not rest on the
unreachable volatility-selling leg.

**And the reachable-only subset passes too** — hold + cash + trend + covered carry: **+88.1%,
−27.6% maxDD, Calmar 0.46**. Even dropping carry entirely (hold + cash + trend, all trivially
reachable): **+90.2%, −35.9%, Calmar 0.36**, against buy-and-hold's +7.8% / −80.6% / 0.02.

## ⚠️ But my ship bar had a gap, and closing it changes the reading

**Criteria 1–5 never controlled for the benchmark's window.** T7's period opens 2021-04 — near the
2021 peak — and closes 2026-06 near a trough, so buy-and-hold round-tripped to **+7.8% over five
years**. Any portfolio holding less crypto looks good against that. Tested across regimes:

| window | B&H total | B&H Calmar | EW total | EW Calmar | winner |
|---|---|---|---|---|---|
| **2020-01 → 2026-06 FULL** | **+2271.1%** | 0.78 | +589.7% | **1.24** | EW |
| 2020-01 → 2021-11 BULL | **+6699.1%** | **14.20** | +500.3% | 5.78 | **B&H** |
| 2021-11 → 2022-11 BEAR | −79.5% | −0.99 | −21.8% | −1.01 | B&H* |
| 2022-11 → 2025-10 RECOVERY | **+397.1%** | **1.38** | +53.5% | 0.78 | **B&H** |
| 2025-10 → 2026-06 BEAR | −66.8% | −1.13 | −5.1% | −0.54 | EW |
| 2021-04 → 2026-06 (T7's window) | +7.8% | 0.02 | +83.2% | 0.44 | EW |

\* both Calmars negative; the comparison is not meaningful there.

**EW wins 3 of 6 windows on Calmar — a coin flip.** And over the FULL period buy-and-hold returns
**+2271% against EW's +590%, roughly 4×.**

## What is actually true, stated without spin

**The pass stands on the letter of the pre-declared bar. The finding does not support "diversification
beats holding."** What the window sweep shows is a clean, ordinary risk/return trade, measured
honestly:

- **Drawdown reduction is real and consistent** — −80.6% → −28.0% on the full period, and EW's
  drawdown is smaller in *every* window tested.
- **The return cost is equally consistent** — roughly a quarter of buy-and-hold's full-period return.
- **On Calmar the full period favours EW** (1.24 vs 0.78), but the bull and recovery windows favour
  buy-and-hold decisively.

So: **diversifying across mechanisms reliably converts return into drawdown protection at roughly
fair terms.** Whether that is worth it depends entirely on whether the holder can actually sit
through −80%, which is a personal question and not a statistical one.

**My bar was incomplete.** It compared against a benchmark in a single window without asking whether
that window was representative. Recorded as a methodology lesson: *when a bar is relative to a
benchmark, test the benchmark's window before believing the result.*

## Remaining contamination, not corrected here

`carry` still shows Sharpe 4.78 at −2.3% drawdown because **a funding series cannot express venue
risk**. The 8% return is now honest; the risk is not. The real series has a left tail (FTX) that no
amount of rate correction introduces. Any allocation that leans on carry inherits that.
