# Derivatives Scoring Plan — Funding, OI, Liquidations, On-Chain

## Phase 1: Score Existing Data (30 min)
**No new APIs. Data already fetched. Just add scoring in ComputeAll.swift.**

### 1a. Funding Rate Scoring
Currently: kill condition only (funding flipped = block counter-trend entry).
Change: also score it as a directional signal.

**Logic:**
```
Extreme positive funding (> 0.05%) = crowded longs → bearish signal (-1)
Extreme negative funding (< -0.05%) = crowded shorts → bullish signal (+1)
Moderate funding (0.01% to 0.05%) = mild crowding → weaker signal (±1 only at extremes)
Normal funding (-0.01% to 0.01%) = no signal (0)
```

**Why it works:** Extreme funding means one side is paying the other to maintain their position. This is unsustainable — the paying side eventually capitulates, causing a reversal. Backtest this signal in isolation to verify.

**Where:** ComputeAll.swift, new Layer 6 after cross-asset. Only on Daily, crypto only.
Need to pass `DerivativesData` into `computeAll()` — currently not passed.

**Files:**
- `ComputeAll.swift` — add `derivatives: DerivativesData? = nil` parameter, add Layer 6
- `AnalysisService.swift` — pass derivatives to computeAll for Daily timeframe
- `ScoringSnapshot.swift` — add `fundingRatePercent: Double?` field
- `ScoringFunction.swift` — add funding scoring
- `ScoringParams.swift` — add `fundingWeight: Int = 1`

### 1b. OI + Price Direction Scoring
Currently: text in prompt ("OI up + price up = real buying"), not scored.
Change: score the OI/price combination.

**Logic (from derivatives analysis textbooks):**
```
OI rising + price rising = new money entering long → bullish (+1)
OI rising + price falling = new money entering short → bearish (-1)
OI falling + price rising = short covering (hollow rally) → neutral/bearish (0 or -1)
OI falling + price falling = capitulation → potential reversal → neutral (0)
OI change < 1% = no signal (0)
```

**Where:** Same Layer 6 in ComputeAll.swift. Uses `oiChange24h` + price direction (current > prior close).

**Fields to add:**
- `ScoringSnapshot` — `oiChange24h: Double?`, `priceRising: Bool`

### 1c. Taker Buy/Sell Ratio Scoring
Currently: text only.
Change: score extreme readings.

**Logic:**
```
Taker ratio > 1.1 = aggressive buying → bullish (+1)  
Taker ratio < 0.9 = aggressive selling → bearish (-1)
0.9-1.1 = balanced → no signal (0)
```

### 1d. Long/Short Ratio Scoring (Contrarian)
Currently: text only.
Change: score as contrarian signal.

**Logic:**
```
Longs > 65% = crowded longs → bearish contrarian (-1)
Shorts > 65% = crowded shorts → bullish contrarian (+1)
50-65% either way = no extreme → no signal (0)
```

### Phase 1 Score Budget
```
Funding:     ±1
OI+Price:    ±1
Taker ratio: ±1
L/S ratio:   ±1
Total:       ±4 max from derivatives
```

These are confirmation signals, not primary drivers. Capped at ±1 each.
Update `maxScore` from 18 to 22 (adds ±4 crypto-only).

---

## Phase 2: Coinglass Liquidation Data (1-2 hours)

### API
- **Endpoint:** `https://open-api.coinglass.com/public/v2/liquidation_map`
- **Auth:** Free API key (sign up at coinglass.com, key in header `coinglassSecret`)
- **Rate limit:** 30 req/min free tier
- **Data:** Liquidation clusters by price level — shows $ amount of longs/shorts that get liquidated at each price point

### What We Get
```json
{
  "data": [
    {"price": 67000, "longLiquidation": 45000000, "shortLiquidation": 12000000},
    {"price": 68000, "longLiquidation": 8000000, "shortLiquidation": 62000000},
    ...
  ]
}
```

### How to Use
1. Find the nearest large liquidation cluster above and below current price
2. If large short liquidation cluster is close above → price magnetically pulled up (bullish)
3. If large long liquidation cluster is close below → price magnetically pulled down (bearish)
4. The asymmetry tells you which way the liquidity sweep goes

### Scoring Logic
```
Nearest large cluster above = short squeeze target → bullish pull (+1)
Nearest large cluster below = long flush target → bearish pull (-1)
Both roughly equal distance → no directional pull (0)
Large cluster within 1 ATR → HIGH PROBABILITY liquidation run (+2 or -2)
```

### Implementation
**New files:**
- `Services/CoinglassProvider.swift` — fetch liquidation map via worker proxy
- `Models/LiquidationData.swift` — struct for parsed liquidation levels

**Worker:**
- New route `/coinglass/liquidations?symbol=BTCUSDT`
- Worker secret: `COINGLASS_API_KEY`
- Cache 5 min (liquidation data changes slowly)

**Integration:**
- `AnalysisService.swift` — fetch alongside derivatives, pass to computeAll
- `ComputeAll.swift` — Layer 7: Liquidation proximity scoring
- `AnalysisPrompt.swift` — new `=== LIQUIDATION LEVELS ===` section in prompt
- `ScoringSnapshot.swift` — add liquidation fields for optimizer

### Prompt Addition
```
LIQUIDATION LEVELS (if provided):
- Nearest long liquidation cluster: $X ($Y million)
- Nearest short liquidation cluster: $X ($Y million)
Price is magnetically attracted to liquidation clusters — the larger
the cluster, the higher the probability of a sweep. A $50M short
liquidation cluster 1 ATR above price is a strong bullish magnet.
Factor this into target selection and risk assessment.
```

---

## Phase 3: CryptoQuant Exchange Flows (2-3 hours)

### API
- **Endpoint:** `https://api.cryptoquant.com/v1/btc/exchange-flows/inflow`
- **Auth:** Free tier requires API key (sign up at cryptoquant.com)
- **Rate limit:** 60 req/hour free
- **Data:** Exchange inflow/outflow in BTC, by exchange, hourly

### What We Get
```json
{
  "data": [
    {"datetime": "2026-04-07T10:00:00Z", "inflow_total": 1234.5, "outflow_total": 987.3},
    ...
  ]
}
```

### How to Use
1. **Net inflow (inflow > outflow):** Coins moving to exchanges = preparing to sell → bearish
2. **Net outflow (outflow > inflow):** Coins leaving exchanges = accumulation → bullish
3. **Spike detection:** Normal is ~500 BTC/hour. >2000 BTC/hour inflow = whale deposit = imminent sell

### Scoring Logic
```
Net outflow > 500 BTC/hour = accumulation → bullish (+1)
Net inflow > 500 BTC/hour = distribution → bearish (-1)
Net inflow > 2000 BTC/hour = whale sell warning → strong bearish (-2)
Normal range = no signal (0)
```

### Implementation
**New files:**
- `Services/CryptoQuantProvider.swift` — fetch exchange flows via worker proxy
- `Models/ExchangeFlowData.swift` — struct for flow data

**Worker:**
- New route `/cryptoquant/exchange-flows?symbol=BTC`
- Worker secret: `CRYPTOQUANT_API_KEY`
- Cache 15 min

**Integration:**
- `AnalysisService.swift` — fetch in crypto analysis flow
- `ComputeAll.swift` — Layer 8: On-chain flow scoring
- `AnalysisPrompt.swift` — new `=== ON-CHAIN FLOWS ===` section
- `ScoringSnapshot.swift` — add flow fields for optimizer

### Prompt Addition
```
ON-CHAIN EXCHANGE FLOWS (if provided):
- Net flow: [inflow/outflow] X BTC/hour ([above/below] average)
- Exchange reserves: [rising/falling] over 24h
Coins moving TO exchanges typically precede selling. Coins leaving
exchanges = accumulation. A sudden inflow spike (>2000 BTC/hour)
is a whale sell signal — reduce conviction or widen stops.
```

---

## Implementation Order

| Phase | What | Time | Dependencies |
|-------|------|------|-------------|
| 1a | Score funding rate | 15 min | None |
| 1b | Score OI + price | 15 min | None |
| 1c | Score taker ratio | 10 min | None |
| 1d | Score L/S ratio | 10 min | None |
| 2 | Coinglass liquidations | 1-2 hrs | API key signup |
| 3 | CryptoQuant flows | 2-3 hrs | API key signup |

Phase 1 is the highest-value-per-effort. No new APIs, no new keys, no new providers. Just scoring data we already fetch.

## API Keys Needed
- **Coinglass:** Sign up at https://www.coinglass.com/pricing — free tier available
- **CryptoQuant:** Sign up at https://cryptoquant.com/pricing — free tier available

Get both keys before tomorrow's session so we can implement all three phases.

## Score Budget After All Phases
```
Existing:          ±18 max
Phase 1 (derivs):  ±4 (funding ±1, OI ±1, taker ±1, L/S ±1)
Phase 2 (liq):     ±2 (proximity scoring)
Phase 3 (on-chain): ±2 (flow scoring)
New total:         ±26 max

maxScore update:   26.0
```

Thresholds may need recalibration after adding these — run the optimizer after Phase 1 to see the impact before adding Phases 2-3.
