# Plain-English copy rules

Two things on the first attempt needed a legend to parse. Neither survives.

## 1. Machine reason strings → plain English

The payload's `bindingConstraints` and `skipped[].reasons` are developer tokens. They are
never shown raw. Table below is the full live set (from `src/envelope.ts`).

| token | shown as |
|---|---|
| `ML_WIN_31%_below_live_floor_49%` | Move likelihood too low — 31%, needs 49% |
| `ML_WIN_47%<50` | Move likelihood under 50% |
| `ANY_KILLED=true` | A kill condition fired |
| `macro_IMMINENT` | Big economic event within hours |
| `macro_NEARBY_not_ON_HORIZON` | Economic event within 4 hours |
| `alignment_MIXED_not_full` | Timeframes disagree |
| `continuation_1/2+_required` | Trend confirmation weak — 1 of 2 signals |
| `continuation_lt_2` | Trend confirmation: 1 of 2 |
| `news_thesis_conflict` | Headlines contradict the setup |
| `data_stale_3_sources` | 3 data feeds are stale |
| `crypto_bear_regime_LONG_cap_MODERATE_halve_size` | Bear regime — long size halved |
| `crash_size_x0.72` | Size cut 28% for drawdown risk |
| `momentum_continuation` | Momentum continuation |
| `pullback_continuation` | Pullback into trend |
| `counter_trend_pullback_cap_MODERATE` | Counter-trend pullback |

## 2. R units → money

`+0.073 net R` is precise and opaque. Account is $28,000 at 2% risk
(`CryptoLensApp.swift:60`), so **1R = $560**.

| R | money | what it is |
|---|---|---|
| 1R | $560 | what a stopped-out trade costs |
| +0.073R | **+$41** | SOL — average per trade, over many trades |
| +0.034R | +$19 | LINK |
| +0.05R | $28 | the display floor |
| &minus;0.082R | &minus;$46 | ETH — a long at the base rate |

**The average alone would mislead.** At a ~10% hit rate the shape is: lose $560 most
times, occasionally win ~$2,800. +$41 is the average of that, not the typical outcome.
So the three branches are not pedantry — they are what makes the average readable.
Show both: the money, and the shape that produces it.
