# T10 — Bull-persistence override on the crash overlay

**Status:** design pre-declared by the user. Two parameters the spec left open were declared by me
before running: **Y = 10%** max drawdown from episode high (matched to the crash model's own 10%
target) and **episode trigger p > 0.30** (the threshold at which T9 begins reducing exposure).

## Verdict: ALL THREE RULES FAIL

| arm | total | CAGR | maxDD | Calmar | avg exp |
|---|---|---|---|---|---|
| BTC B&H | 555% | 36.8% | −76.6% | 0.48 | 100% |
| **T9 baseline (D)** | 2,339% | 70.4% | −40.4% | **1.74** | 73% |
| T10 P1 (7d +5%) | — | — | — | **1.43** | 76% |
| T10 P2 (14d +10%) | — | — | — | 1.76 | 75% |
| T10 P3 (30d +15%) | 2,501% | 72.2% | −38.0% | **1.90** | 74% |

All three fail criteria 1 and 2 — **2021 leg-2 capture improves only 30% → 32-37%, against a
required 80%.** The override does not fix the problem it was built for.

| bull period | BTC | T9 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| 2020 H2 | +582% | 70% | **60%** | 71% | 71% |
| 2021 leg-2 | +110% | 30% | 37% | 32% | 35% |
| 2022-25 recovery | +666% | 70% | 76% | 70% | 70% |

**P1 actively harms**: Calmar 1.43 (below T9's 1.74), 2020 H2 capture drops to 60%, and 2022 bear
protection degrades from **+28% to +11%** — the loose rule re-enters on bear rallies. The stricter
P3 preserves bear protection exactly (+28%) and edges Calmar up to 1.90, but that is a marginal gain
on the criteria that were not decisive.

## ⚠️ A LOOKAHEAD IN MY OWN IMPLEMENTATION — caught, and it was load-bearing

The first run had the persistence mask built from **today's close** while the crash signal was
correctly lagged, so today's price decided today's exposure. Corrected by shifting the mask.

| | with lookahead | corrected |
|---|---|---|
| P1 Calmar | **2.75** | **1.43** |
| P1 2021 capture | 47% | 37% |
| P1 2020 H2 capture | 81% | 60% |
| P1 2022 bear return | +27% | **+11%** |
| P1 verdict vs T9 | "improves real T9" | **"does NOT improve real T9"** |

**The bug inflated the loosest rule most and inverted the entire ranking** — P1 went from best to
worst, P3 from worst to best. Had this gone unnoticed, T10 would have been reported as a large
improvement built on a one-day peek. Recorded as the clearest example in this vault of why a
too-good result must be treated as a bug first.

## The more important finding: the premise may be wrong

T10 assumed 2021 underexposure was a **stale warning** — a false positive to be overridden. The data
suggests otherwise.

**The 2021 leg-2 "bull" ran 2021-07-20 → 2021-11-10 and terminated at the all-time high, immediately
followed by a 76% collapse.** The model reducing exposure into that advance was not a malfunction;
it was **early**. And the full-year arithmetic shows the caution cost almost nothing:

| year | B&H | T9 arm D | avg exposure |
|---|---|---|---|
| 2021 | +60% | +51% | **30%** |
| 2022 | **−64%** | **+49%** | 48% |

At 30% average exposure through 2021 the overlay still captured 85% of the year's return — because
2021 round-tripped — and then turned a −64% year into +49%. **The "missed bull" was the blow-off
top.** Declining to chase it is arguably the correct behaviour for a crash-protection overlay, not
the defect T9's criterion 3 scored it as.

That is an interpretation of a measured result, not a new validated claim. But it means the right
follow-up is **not** a better override. It is asking whether criterion 3 measured the right thing —
penalising an overlay for underweighting the final leg into a 76% crash may be scoring it against a
standard no risk manager would want met.

## What stands

T9's result is unchanged and remains the strongest in the vault: **Calmar 1.74 vs 0.48, drawdown
−76.6% → −40.4%, beating shuffled, lagged, realised-volatility and 200D controls.** T10 adds no
material improvement (P3's 1.74 → 1.90 is within the noise of choosing among three pre-declared
rules) and one rule makes things worse.

**No tuning was performed after seeing results. All three rules are reported; none was selected.**
