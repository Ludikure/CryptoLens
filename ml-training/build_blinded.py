#!/usr/bin/env python3
"""Build a BLINDED directional-skill test for the AI. Each item: recent normalized price
action + a technical snapshot, with SYMBOL and DATE stripped and price indexed to 100 so the
model cannot identify the asset or recall the future. Hidden key holds the forward outcome.
Output: /tmp/blinded_charts.jsonl (id + prompt text)  +  /tmp/blinded_key.json (id -> outcome).
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


def stack(bull, bear):
    return 'bullish (price above EMAs)' if bull > 0.5 else ('bearish (price below EMAs)' if bear > 0.5 else 'mixed')


def chart_text(closes):
    base = float(closes[-1])
    norm = [round(float(x) / base * 100, 2) for x in closes]
    return norm


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & (df['atrPercent'] > 0)].copy()
    cidx = candle_index()
    rng = np.random.RandomState(SEED)
    df = df.sample(frac=1, random_state=SEED).reset_index(drop=True)
    charts, key = [], {}
    i = 0
    for _, r in df.iterrows():
        if len(charts) >= N:
            break
        sym = r['symbol']
        if sym not in cidx:
            continue
        ct = cidx[sym]['t']; s = np.searchsorted(ct, int(r['timestamp']), 'right')
        if s < 30:
            continue
        closes = cidx[sym]['close'][s - 28:s]               # 28 most recent 4H closes, up to eval bar
        if len(closes) < 28 or np.any(closes <= 0):
            continue
        cid = f"c{i:03d}"; i += 1
        norm = chart_text(closes)
        txt = (
            f"ANONYMIZED ASSET — 4H technical snapshot. You are a momentum/technical analyst. "
            f"Decide the most likely PRICE DIRECTION over the next 24 hours (next 6 four-hour bars).\n\n"
            f"Recent 28 four-hour closes (price indexed so the latest = 100.0; oldest first):\n{norm}\n\n"
            f"Daily timeframe:  RSI {r['dRsi']:.0f} | MACD hist {r['dMacdHist']:+.2f} | ADX {r['dAdx']:.0f} | "
            f"Stoch %K {r['dStochK']:.0f} | BB position {r['dBBPercentB']:.2f} (0=lower band,1=upper) | "
            f"EMA stack {stack(r['dStackBull'], r['dStackBear'])} | volume {r['dVolumeRatio']:.1f}x avg\n"
            f"4H timeframe:   RSI {r['hRsi']:.0f} | MACD hist {r['hMacdHist']:+.2f} | ADX {r['hAdx']:.0f} | "
            f"Stoch %K {r['hStochK']:.0f} | BB position {r['hBBPercentB']:.2f} | "
            f"EMA stack {stack(r['hStackBull'], r['hStackBear'])} | volume {r['hVolumeRatio']:.1f}x avg\n\n"
            f"Answer with ONLY: DIRECTION=LONG|SHORT|FLAT, CONF=0-100 (your confidence the move goes that way), "
            f"REASON=<8 words>. FLAT means no clear directional edge."
        )
        charts.append({'id': cid, 'prompt': txt})
        key[cid] = {'fwdRet': float(r['fwdReturn24H']), 'atrPct': float(r['atrPercent']),
                    'fwdUp': float(r['fwdMaxUp24H']) if pd.notna(r.get('fwdMaxUp24H')) else None,
                    'fwdDn': float(r['fwdMaxDown24H']) if pd.notna(r.get('fwdMaxDown24H')) else None}
    with open('/tmp/blinded_charts.jsonl', 'w') as f:
        for c in charts:
            f.write(json.dumps(c) + '\n')
    with open('/tmp/blinded_key.json', 'w') as f:
        json.dump(key, f)
    base_up = np.mean([1 if key[c['id']]['fwdRet'] > 0 else 0 for c in charts]) * 100
    print(f"wrote {len(charts)} blinded charts → /tmp/blinded_charts.jsonl ; key → /tmp/blinded_key.json")
    print(f"base rate P(up) in this sample = {base_up:.0f}%  (the directional null)")
    print(f"\n--- sample chart (c000) ---\n{charts[0]['prompt']}")


if __name__ == '__main__':
    main()
