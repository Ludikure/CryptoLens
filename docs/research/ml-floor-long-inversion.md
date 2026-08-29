# Is the ML floor INVERTED for LONG-biased bars? — PRE-DECLARED 2026-08-26

**Nothing in the "Test" or "Bar" sections below was written after seeing its result.** The
observations in "What prompted this" have already been made and are stated as the *motivation*, not
as evidence for the hypothesis — they are the reason to run a test, not its outcome.

## What prompted this

The user asked why longs lose at high ML in a bull market. Conditioning on Fear & Greed and on the
symbol's own 90-day trend produced a monotone curve across eight ML bands, in the regime the app is
currently in (greed + rising symbol):

| ML band | n | net R | 95% CI |
|---|---:|---:|---|
| 0.25–0.30 | 457 | +0.1426 | [+0.0380, +0.2927] |
| 0.30–0.35 | 2,371 | +0.0853 | [+0.0087, +0.1615] |
| 0.35–0.40 | 3,979 | +0.0696 | [+0.0122, +0.1392] |
| 0.40–0.45 | 4,066 | +0.0174 | [−0.0398, +0.0822] |
| 0.50–0.55 | 2,421 | −0.0706 | [−0.1496, +0.0121] |
| 0.55–0.60 | 1,775 | −0.1394 | [−0.2322, −0.0378] |
| 0.60+ | 936 | −0.1951 | [−0.3399, −0.0571] |

Direct evidence that these are not simulation artifacts: high-ML LONG bars in greed had a **mean
forward 24h return of −0.368%**, with **P(2 ATR stop) = 26.9%** against **P(2.5 ATR target) = 14.4%**.
Price genuinely fell on them.

**Proposed mechanism.** ML_WIN predicts VOLATILITY, direction-agnostically — realised goodR runs
0.227 → 0.781 monotonically and favourable/adverse excursions grow together at a flat ~1.0 ratio. In
an uptrend the highest-volatility bars are blow-offs; the quiet bars are continuation. Longs want the
grind, shorts want the spike. The same gate therefore helps one side and harms the other.

## Why this needs a pre-declared test rather than a change

Three reasons, and each has burned this project already:

1. **It was found by conditioning on three variables after seeing the data** (mood, symbol trend, ML
   band). That is what fishing feels like from the inside, whatever the mechanism.
2. **C6 measured what happens when a threshold is chosen from a curve like this**: walk-forward
   fitting made the SHORT rule swing across a 0.34R range out of sample, and on LONG the optimizer
   selected the loosest available threshold every single time.
3. **The best cell holds ~150 effective observations** after horizon overlap, in one window.

## The test

**H1 — inversion.** On LONG-biased bars, net R per opportunity is DECREASING in ML.

**H0** — no monotone relationship, or the relationship is not stable across periods.

**Design.**
- Population: LONG-biased bars (`alignedDirection == 'LONG'`), crypto, app geometry (2 ATR stop,
  2.5 ATR target, 72h), market entry, net of fees at the measured Advanced 2 tier.
- Arms: the existing floor (`ML >= cut`), NO floor, and an INVERTED floor (`ML <= cut`), at the
  coverage the shipped gate uses.
- Split by regime — greed/not-greed × symbol rising/flat/falling — reported for ALL cells, not only
  the favourable ones.

**Bar, fixed now.** H1 is supported only if ALL FOUR hold:

1. **Monotonicity**: Spearman correlation between ML band and net R is negative at p < 0.01.
2. **Period consistency**: the inverted floor beats the current floor in **≥ 6 of 9** half-year
   periods. *This is the criterion the current evidence cannot supply and is the reason for the test
   — the OOF window yields 5-7 periods, so a genuine 6/9 requires the full span.*
3. **Both regimes**: the sign holds in greed AND not-greed. If it only appears in greed it is a
   regime finding, and must be reported as one rather than shipped as a gate.
4. **Effective n ≥ 500** in every cell carrying a claim.

**Stopping rule.** If any criterion fails, the LONG floor is left exactly as it is and this is filed
in `rejected-hypotheses.md`. **Partial support does not ship.** In particular a result that holds
only in greed is a note in the vault, not a code change.

**The threshold must not be fitted.** If H1 is supported, the action is to REMOVE the floor for
LONG-biased bars, not to invert it at an optimised cut. C6 established that fitting this number
destroys it. Removal is a structural change with no free parameter; an inverted-and-tuned threshold
is the failure mode wearing a new hat.

## Immediate consequence, before any of this runs

The coverage floor shipped earlier today (4e4d8b6) rejects the weakest 45% of live predictions on
**both sides**. If H1 is right, that removes precisely the LONG setups that historically worked —
the user's own BTC bar at raw 31 sits in the 0.30–0.35 band, the second-best cell in the table.

**The coverage floor was shipped for drift-resistance and that argument still stands.** But it was
never argued to improve LONG selection, and this evidence says it may degrade it. **Deploy is held
pending this test.** Rollback remains one constant.

## What would make me drop this

- Criterion 2 fails (the likeliest outcome — thin cells, one window).
- The effect disappears once the forward logger has independent data.
- The monotone curve turns out to be driven by a handful of symbols, which the cluster bootstrap
  would show and which has not yet been checked.
