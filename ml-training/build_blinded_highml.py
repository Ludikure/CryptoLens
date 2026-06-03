#!/usr/bin/env python3
"""Blinded directional test on HIGH-ML_WIN bars only (the production scenario: the AI is only
called when a big move is statistically likely). Compute ML_WIN (OOF quality-model proba),
keep bars >= 0.70, sample 150, build the rich blinded dossier with the framing 'a big move is
likely — call its DIRECTION'. Same blinding (no symbol/date/price/forward/context).
"""
import os, json, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); ev = __import__('edge_validation'); P1 = __import__('phase1_meta')
N = 150; SEED = int(os.environ.get('SEED', 20260602)); GATE = 0.70
SUF = os.environ.get('SUF', '')
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, gg in c.sort_values('t').groupby('symbol'):
        idx[sym] = {'close': gg['close'].values.astype(float), 't': gg['t'].values.astype(np.int64)}
    return idx


def yn(v): return 'yes' if v > 0.5 else 'no'
def stk(b, s): return 'bullish' if b > 0.5 else ('bearish' if s > 0.5 else 'mixed')
def g(r, k, d=0.0):
    v = r.get(k, d); return d if pd.isna(v) else v


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & (df['atrPercent'] > 0)].copy().sort_values('timestamp').reset_index(drop=True)
    # OOF ML_WIN: train on first 55%, predict on the rest
    cut = int(len(df) * 0.55)
    m = H.make_model(); m.fit(df.iloc[:cut][H.FEATURES].fillna(0), df.iloc[:cut]['goodR'])
    pred = df.iloc[cut:].copy()
    pred['mlWin'] = m.predict_proba(pred[H.FEATURES].fillna(0))[:, 1]
    hi = pred[pred['mlWin'] >= GATE]
    print(f"high-ML pool (mlWin>={GATE}): {len(hi):,} bars; realized goodR among them = {hi['goodR'].mean()*100:.0f}%")
    cidx = candle_index()
    hi = hi.sample(frac=1, random_state=SEED).reset_index(drop=True)
    charts, key = [], {}; i = 0
    for _, r in hi.iterrows():
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
            f"ANONYMIZED ASSET — full technical dossier. A volatility model estimates a SIGNIFICANT "
            f"move (>=1.5 ATR) is LIKELY here over the next 24h (this is a high-conviction setup) — but "
            f"that estimate is DIRECTION-AGNOSTIC. Your job: call the DIRECTION of that likely move.\n\n"
            f"Recent 28 four-hour closes (indexed, latest=100.0):\n{norm}\n\n"
            f"DAILY:  RSI {g(r,'dRsi'):.0f} (6-bar chg {g(r,'dRsiDelta'):+.1f}) | MACD hist {g(r,'dMacdHist'):+.2f} | "
            f"ADX {g(r,'dAdx'):.0f} | Stoch %K {g(r,'dStochK'):.0f} | BB pos {g(r,'dBBPercentB'):.2f} | "
            f"EMA stack {stk(g(r,'dStackBull'),g(r,'dStackBear'))} | vs VWAP {'above' if g(r,'dAboveVwap')>0.5 else 'below'} | "
            f"structure {stk(g(r,'dStructBull'),g(r,'dStructBear'))} | RSI div {g(r,'dDivergence'):+.0f} | vol {g(r,'dVolumeRatio'):.1f}x\n"
            f"4H:     RSI {g(r,'hRsi'):.0f} (6-bar chg {g(r,'hRsiDelta'):+.1f}) | MACD hist {g(r,'hMacdHist'):+.2f} | "
            f"ADX {g(r,'hAdx'):.0f} | Stoch %K {g(r,'hStochK'):.0f} | BB pos {g(r,'hBBPercentB'):.2f} | "
            f"EMA stack {stk(g(r,'hStackBull'),g(r,'hStackBear'))} | vs VWAP {'above' if g(r,'hAboveVwap')>0.5 else 'below'} | "
            f"structure {stk(g(r,'hStructBull'),g(r,'hStructBear'))} | RSI div {g(r,'hDivergence'):+.0f} | vol {g(r,'hVolumeRatio'):.1f}x\n"
            f"REGIME code {g(r,'regimeCode'):.0f} | TF-align {g(r,'tfAlignment'):+.0f} | mom-align {g(r,'momentumAlignment'):+.0f} | struct-align {g(r,'structureAlignment'):+.0f}\n"
            f"DERIVATIVES: funding {g(r,'fundingRateRaw')*100:+.3f}% | OI 6-bar chg {g(r,'oiChangePct'):+.1f}% | "
            f"taker b/s {g(r,'takerRatioRaw',1.0):.2f} | accounts long {g(r,'longPctRaw',50):.0f}% | basis {g(r,'basisPct'):+.2f}%\n"
            f"LEVELS: dist-to-POC {g(r,'vpDistToPocATR'):+.1f} ATR | above-POC {yn(g(r,'vpAbovePoc'))} | in-VA {yn(g(r,'vpInValueArea'))}\n"
            f"CONTEXT: last-3 {('3-green' if g(r,'last3Green')>0.5 else '3-red' if g(r,'last3Red')>0.5 else 'mixed')} | "
            f"Fear&Greed {g(r,'fearGreedIndex',50):.0f} | ETH/BTC 6-bar chg {g(r,'ethBtcDelta6'):+.2f} | ATR {g(r,'atrPercent'):.1f}%\n\n"
            f"Answer ONLY: DIRECTION=LONG|SHORT|FLAT, CONF=0-100, REASON=<10 words>."
        )
        charts.append({'id': cid, 'prompt': txt})
        key[cid] = {'fwdRet': float(r['fwdReturn24H']), 'atrPct': float(r['atrPercent']), 'mlWin': float(r['mlWin'])}
    with open(f'/tmp/blinded_charts_highml{SUF}.jsonl', 'w') as f:
        for c in charts: f.write(json.dumps(c) + '\n')
    with open(f'/tmp/blinded_key_highml{SUF}.json', 'w') as f: json.dump(key, f)
    print(f"wrote {len(charts)} HIGH-ML blinded charts. base P(up)={np.mean([1 if key[c['id']]['fwdRet']>0 else 0 for c in charts])*100:.0f}% | "
          f"mean mlWin={np.mean([key[c['id']]['mlWin'] for c in charts]):.2f}")


if __name__ == '__main__':
    main()
