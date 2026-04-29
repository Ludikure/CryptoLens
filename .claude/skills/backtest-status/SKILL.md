---
name: backtest-status
description: Check backtest export progress — count completed CSVs, show which symbols are done vs pending
disable-model-invocation: true
allowed-tools: Bash(ls *) Bash(wc *) Bash(find *) Bash(stat *) Bash(sort *) Bash(head *) Bash(tail *) Read Glob
---

# Backtest Export Status

Check the current state of backtester CSV exports on the simulator.

## Steps

### 1. Find exports

Look in all simulator app containers:
```
/Users/bojanmihovilovic/Library/Developer/CoreSimulator/Devices/F32D1D3F-AAA8-4BAC-8359-DA0CC59082CC/data/Containers/Data/Application/*/Documents/ml_exports/
```

Use the container with the most recent files.

### 2. Categorize completed exports

List all CSVs and split into:
- **Crypto** (filename ends in `USDT.csv`): expected 76 symbols
- **Stocks** (everything else): expected 85 symbols

### 3. Check for missing symbols

Compare against the full symbol lists:

**Crypto (76):** BTCUSDT, ETHUSDT, BCHUSDT, XRPUSDT, LTCUSDT, TRXUSDT, ETCUSDT, LINKUSDT, XLMUSDT, ADAUSDT, XMRUSDT, DASHUSDT, ZECUSDT, XTZUSDT, BNBUSDT, ATOMUSDT, ONTUSDT, IOTAUSDT, BATUSDT, VETUSDT, NEOUSDT, QTMUSDT, IOSTUSDT, THETAUSDT, ALGOUSDT, ZILUSDT, KNCUSDT, ZRXUSDT, COMPUSDT, DOGEUSDT, KAVAUSDT, BANDUSDT, RLCUSDT, SNXUSDT, DOTUSDT, YFIUSDT, CRVUSDT, TRBUSDT, RUNEUSDT, SUSHIUSDT, EGLDUSDT, SOLUSDT, ICXUSDT, STORJUSDT, UNIUSDT, AVAXUSDT, ENJUSDT, KSMUSDT, NEARUSDT, AAVEUSDT, FILUSDT, RSRUSDT, BELUSDT, AXSUSDT, SKLUSDT, GRTUSDT, SANDUSDT, MANAUSDT, HBARUSDT, MATICUSDT, ICPUSDT, DYDXUSDT, GALAUSDT, IMXUSDT, GMTUSDT, APEUSDT, INJUSDT, LDOUSDT, APTUSDT, ARBUSDT, SUIUSDT, PENDLEUSDT, SEIUSDT, TIAUSDT, JUPUSDT, PEPEUSDT

**Stocks (85):** AAPL, TSLA, MSFT, NVDA, GOOGL, META, AMZN, CRM, NFLX, AMD, ORCL, ADBE, INTC, CSCO, AVGO, QCOM, MU, AMAT, LRCX, MRVL, PLTR, ROKU, SHOP, SQ, SNAP, COIN, RBLX, BYND, GME, JPM, GS, MS, BAC, WFC, BLK, SCHW, UNH, LLY, ABBV, JNJ, PFE, MRK, TMO, REGN, VRTX, GILD, BIIB, HD, MA, V, DIS, NKE, SBUX, MCD, WMT, COST, CAT, DE, X, BA, XOM, OXY, FANG, CVX, SLB, LMT, RTX, GD, UNP, FDX, DAL, T, VZ, CMCSA, SPG, O, SPY, QQQ, IWM, XLE, XLF, XLK, XLV, GLD, TLT

Report which are missing from each category.

### 4. Row counts

For the 5 most recently modified CSVs, show row counts (excluding header):
```bash
wc -l <file>
```

### 5. Freshness

Show the timestamp of the oldest and newest CSV to help gauge when the backtest started and how current it is.

### 6. Summary

```
Backtest Export Status
─────────────────────
Crypto:  XX/76 complete (missing: ...)
Stocks:  XX/85 complete (missing: ...)
Total:   XXX/161

Oldest:  SYMBOL — YYYY-MM-DD HH:MM
Newest:  SYMBOL — YYYY-MM-DD HH:MM
Est. remaining: ~X symbols
```
