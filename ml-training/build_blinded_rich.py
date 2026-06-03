#!/usr/bin/env python3
"""RICH blinded directional test — same 150 bars/key as build_blinded.py, but the AI now gets
the full directional feature set production uses (structure, divergence, VWAP, volume-profile
levels, momentum acceleration, TF alignment, DERIVATIVES positioning, sentiment, cross-asset),
minus only symbol/date/absolute-price/forward-data/news-context. Removes the "too little info"
objection. Output: /tmp/blinded_charts_rich.jsonl + /tmp/blinded_key_rich.json
"""
import os, json, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
ev = __import__('edge_validation'); P1 = __import__('phase1_meta')
N = 150
SEED = 20260602
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {'close': g['close'].values.astype(float), 't': g['t'].values.astype(np.int64)}
    return idx


def yn(v): return 'yes' if v > 0.5 else 'no'
def stk(b, s): return 'bullish' if b > 0.5 else ('bearish' if s > 0.5 else 'mixed')
def g(r, k, d=0.0):
    v = r.get(k, d)
    return d if pd.isna(v) else v


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & (df['atrPercent'] > 0)].copy()
    cidx = candle_index()
    df = df.sample(frac=1, random_state=SEED).reset_index(drop=True)
    charts, key = [], {}; i = 0
    for _, r in df.iterrows():
        if len(charts) >= N: break
        sym = r['symbol']
        if sym not in cidx: continue
        ct = cidx[sym]['t']; s = np.searchsorted(ct, int(r['timestamp']), 'right')
        if s < 30: continue
        closes = cidx[sym]['close'][s - 28:s]
        if len(closes) < 28 or np.any(closes <= 0): continue
        cid = f"c{i:03d}"; i += 1
        base = float(closes[-1]); norm = [round(float(x) / base * 100, 2) for x in closes]
        txt = (
            f"ANONYMIZED ASSET — full multi-timeframe technical dossier. You are an expert momentum/"
            f"technical analyst. Call the most likely PRICE DIRECTION over the next 24h (6 four-hour bars).\n\n"
            f"Recent 28 four-hour closes (indexed, latest=100.0; oldest first):\n{norm}\n\n"
            f"DAILY:  RSI {g(r,'dRsi'):.0f} (6-bar chg {g(r,'dRsiDelta'):+.1f}) | MACD hist {g(r,'dMacdHist'):+.2f} | "
            f"ADX {g(r,'dAdx'):.0f} (6-bar chg {g(r,'dAdxDelta'):+.1f}) | Stoch %K {g(r,'dStochK'):.0f} | "
            f"BB pos {g(r,'dBBPercentB'):.2f} | EMA stack {stk(g(r,'dStackBull'),g(r,'dStackBear'))} | "
            f"vs VWAP {'above' if g(r,'dAboveVwap')>0.5 else 'below'} | structure {stk(g(r,'dStructBull'),g(r,'dStructBear'))} | "
            f"RSI divergence {g(r,'dDivergence'):+.0f} | EMA20 rising {yn(g(r,'dEma20Rising'))} | vol {g(r,'dVolumeRatio'):.1f}x\n"
            f"4H:     RSI {g(r,'hRsi'):.0f} (6-bar chg {g(r,'hRsiDelta'):+.1f}) | MACD hist {g(r,'hMacdHist'):+.2f} | "
            f"ADX {g(r,'hAdx'):.0f} | Stoch %K {g(r,'hStochK'):.0f} | BB pos {g(r,'hBBPercentB'):.2f} | "
            f"EMA stack {stk(g(r,'hStackBull'),g(r,'hStackBear'))} | vs VWAP {'above' if g(r,'hAboveVwap')>0.5 else 'below'} | "
            f"structure {stk(g(r,'hStructBull'),g(r,'hStructBear'))} | RSI divergence {g(r,'hDivergence'):+.0f} | vol {g(r,'hVolumeRatio'):.1f}x\n"
            f"REGIME: code {g(r,'regimeCode'):.0f} | bars-since-change {g(r,'barsSinceRegimeChange'):.0f} | "
            f"TF-align {g(r,'tfAlignment'):+.0f} | momentum-align {g(r,'momentumAlignment'):+.0f} | structure-align {g(r,'structureAlignment'):+.0f}\n"
            f"DERIVATIVES: funding {g(r,'fundingRateRaw')*100:+.3f}% | OI 6-bar chg {g(r,'oiChangePct'):+.1f}% | "
            f"taker buy/sell {g(r,'takerRatioRaw',1.0):.2f} | accounts long {g(r,'longPctRaw',50):.0f}% | basis {g(r,'basisPct'):+.2f}% | "
            f"funding-signal {g(r,'fundingSignal'):+.0f} | crowding {g(r,'crowdingSignal'):+.0f}\n"
            f"VOLUME PROFILE / LEVELS: dist-to-POC {g(r,'vpDistToPocATR'):+.1f} ATR | above-POC {yn(g(r,'vpAbovePoc'))} | "
            f"in-value-area {yn(g(r,'vpInValueArea'))} | dist-to-VAH {g(r,'vpDistToVAH_ATR'):.1f} ATR | dist-to-VAL {g(r,'vpDistToVAL_ATR'):.1f} ATR\n"
            f"CONTEXT: last-3 {('3-green' if g(r,'last3Green')>0.5 else '3-red' if g(r,'last3Red')>0.5 else 'mixed')} | "
            f"body/range {g(r,'bodyWickRatio'):.2f} | Fear&Greed {g(r,'fearGreedIndex',50):.0f} (0=fear,100=greed) | "
            f"ETH/BTC 6-bar chg {g(r,'ethBtcDelta6'):+.2f} | ATR {g(r,'atrPercent'):.1f}% of price\n\n"
            f"(ML_WIN is intentionally omitted: it's a direction-AGNOSTIC volatility gauge, not a directional signal.)\n"
            f"Answer ONLY: DIRECTION=LONG|SHORT|FLAT, CONF=0-100, REASON=<10 words>."
        )
        charts.append({'id': cid, 'prompt': txt})
        key[cid] = {'fwdRet': float(r['fwdReturn24H']), 'atrPct': float(r['atrPercent'])}
    with open('/tmp/blinded_charts_rich.jsonl', 'w') as f:
        for c in charts: f.write(json.dumps(c) + '\n')
    with open('/tmp/blinded_key_rich.json', 'w') as f: json.dump(key, f)
    print(f"wrote {len(charts)} RICH blinded charts. base P(up)={np.mean([1 if key[c['id']]['fwdRet']>0 else 0 for c in charts])*100:.0f}%")
    print(f"\n--- sample rich chart (c000) ---\n{charts[0]['prompt']}")


if __name__ == '__main__':
    main()
