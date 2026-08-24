# T16 — Out-of-sample temporal + cross-asset replication

**Status:** pre-declared by the user. **Not a new strategy — a replication experiment.** T9 is frozen
exactly: same target, model, features, purge (72), exposure rule (p<0.30→100%, 0.30-0.50→50%,
>0.50→0%), same costs.

## The question

Every result from T9 onward was measured on the BTC sequence the phenomenon was discovered on. That
is the single largest unexamined risk in this branch:

> Did T9 discover a general phenomenon, or a remarkably convincing BTC-specific historical
> relationship?

## Design choice: LEAVE-ONE-SYMBOL-OUT — a harder bar than T9 itself faced

T9's model was trained on the pooled 77-symbol universe, so applying it to ETH would use a model that
had already seen ETH. That is not replication.

**T16 removes the test asset from training entirely**, in addition to the walk-forward time split.
For each of BTC / ETH / SOL / XRP, the model is trained only on the *other* symbols, expanding
monthly, purged 72 bars. **If the phenomenon is specific to the BTC sequence, this cannot survive.**

Note this means even the BTC result is now a genuine test — it asks whether crash risk learned from
other assets transfers *to* BTC.

## Measured, per the spec — no aggregate Calmar requirement

| | metric |
|---|---|
| A | lead time before ≥30% drawdowns |
| B | exposure at the drawdown peak |
| C | fraction of large drawdowns anticipated |
| D | false-alarm days |
| E | return sacrificed before successful protection |
| F | drawdown reduction per unit of turnover |
| G | placebo (shuffled probabilities, distribution preserved) |

## Success / failure, declared

- **SUCCESS:** the relationship between elevated predicted crash probability and subsequent extreme
  drawdown replicates out of sample — placebo beaten decisively on ≥3 of 4 assets **and** ≥50% of
  large drawdowns anticipated.
- **FAILURE:** the effect disappears once the exact BTC episodes are removed.

**Pre-registered expectation:** genuinely uncertain, and this is the test most likely to overturn the
whole branch. Crypto assets are 0.7-0.9 correlated, so a shared crash regime could produce apparent
replication without a general mechanism — noted in advance so it is not treated as confirmation if
all four assets crash together on the same dates.
