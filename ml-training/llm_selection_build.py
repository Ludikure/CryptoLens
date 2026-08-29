#!/usr/bin/env python3
"""Build the LLM take/skip test sample. Pre-declared in docs/research/llm-selection-test.md.

Scores every row of the excursion dataset the way src/trading/ does today (walk-forward OOF SHORT
head, base-rate LONG, three-way EV, fee in R, floor, direction gap, greed cancel), draws a
stratified sample of proposals, and writes the blinded dossiers + the hidden key.

Outputs (ml-training/llm_selection/):
  sample.jsonl   {id, prompt}            what a judge sees
  key.pkl.gz     id -> outcome + strata  what a judge never sees
  proposals.pkl.gz                        the full proposal population, for the take-all baseline

Run:  python3 llm_selection_build.py
"""
import json
import os
import numpy as np
import pandas as pd
import lightgbm as lgb

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'llm_selection')
DATA = os.path.join(HERE, 'excursion_dataset.pkl.gz')
PAYOFF = os.path.join(HERE, 'excursion_payoff_rows.pkl.gz')
CANDLES = os.path.join(HERE, 'crypto_candles_4h.csv.gz')

SEED = 20260828
N_SAMPLE = 2000
PRIMARY_R = 5.0
ROUND_TRIP_PCT = 0.171
MIN_DISPLAY_EV_R = 0.05
MIN_EDGE_R = 0.05
GREED = 60
PURGE_BARS = 24
# opportunity.ts MEASURED_TIMEOUT at 5R
TIMEOUT_SHARE, TIMEOUT_MEAN_R = 0.205, 1.431
# excursion_ev.py PARAMS, verbatim
PARAMS = dict(objective='binary', num_leaves=15, max_depth=4, learning_rate=0.05,
              n_estimators=150, min_child_samples=100, subsample=0.8, colsample_bytree=0.8,
              verbose=-1, n_jobs=-1, random_state=SEED)


def three_way_ev(pt, target_r=PRIMARY_R):
    pt = np.clip(pt, 0, 1)
    timeout = np.minimum(TIMEOUT_SHARE, 1 - pt)
    stop = np.maximum(0, 1 - pt - timeout)
    return pt * target_r + stop * -1 + timeout * TIMEOUT_MEAN_R


def half(ts_s):
    d = pd.to_datetime(pd.Series(np.asarray(ts_s)), unit='s')
    return (d.dt.year.astype(str) + np.where(d.dt.month <= 6, 'H1', 'H2')).values


def oof_short_scores(df, feats):
    """Expanding yearly walk-forward, purged. Rows before the first fold get NaN (never scored)."""
    df = df.sort_values('timestamp').reset_index(drop=True)
    years = sorted(set(pd.to_datetime(df.timestamp, unit='s').dt.year))
    score = np.full(len(df), np.nan)
    y = df['hit_SHORT_5R'].values
    ts = df.timestamp.values
    for yr in years[1:]:
        start = pd.Timestamp(f'{yr}-01-01').timestamp()
        end = pd.Timestamp(f'{yr + 1}-01-01').timestamp()
        purge_s = PURGE_BARS * 4 * 3600
        trn = (ts < start - purge_s)
        tst = (ts >= start) & (ts < end)
        if trn.sum() < 5000 or tst.sum() == 0:
            continue
        m = lgb.LGBMClassifier(**PARAMS).fit(df.loc[trn, feats], y[trn])
        score[tst] = m.predict_proba(df.loc[tst, feats])[:, 1]
        print(f'  fold {yr}: train {trn.sum():,} -> scored {tst.sum():,}', flush=True)
    df['p_short'] = score
    return df


KLINES_LONG = os.path.join(HERE, 'vision_backfill', 'klines_long')


def candle_index():
    """28 four-hour closes per dossier. The 4H archive starts 2021-12-20 and silently dropped every
    2021H1 row on the first build (1,825 -> 1,472); the hourly Vision klines start 2020-10, so they
    are resampled to UTC-aligned 4H bars (close = last hourly close in the bucket) and the 4H file
    is the fallback for a symbol they do not cover."""
    idx = {}
    if os.path.isdir(KLINES_LONG):
        for fn in sorted(os.listdir(KLINES_LONG)):
            if not fn.endswith('.csv'):
                continue
            sym = fn.replace('.csv', '')
            d = pd.read_csv(os.path.join(KLINES_LONG, fn))
            ts = d['ts'].values.astype(np.int64)
            ts = ts // 1000 if ts.max() > 1e12 else ts
            b = (ts // 14400) * 14400
            g = pd.DataFrame({'b': b, 'close': d['close'].values.astype(float)}).groupby('b')['close'].last()
            # bucket b spans [b, b+4h); the 4H bar CLOSES at b+4h, which is the timestamp the
            # feature row carries for that bar's close
            idx[sym] = {'close': g.values, 't': (g.index.values + 14400).astype(np.int64)}
    c = pd.read_csv(CANDLES)
    t = c['timestamp'].values.astype(np.int64)
    t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t
    for sym, g in c.sort_values('t').groupby('symbol'):
        if sym not in idx:
            idx[sym] = {'close': g['close'].values.astype(float), 't': g['t'].values.astype(np.int64)}
    return idx


def yn(v): return 'yes' if v > 0.5 else 'no'
def stk(b, s): return 'bullish' if b > 0.5 else ('bearish' if s > 0.5 else 'mixed')
def g(r, k, d=0.0):
    v = r.get('f_' + k, d)
    return d if pd.isna(v) else float(v)


SYSTEM = ("You are the final risk check on a systematic crypto SHORT. A model has already selected this "
          "setup; your only job is to decide whether to TAKE it or SKIP it. You see an anonymised technical "
          "dossier: symbol, date and absolute price are withheld so you cannot recall what happened. "
          "Answer in JSON only: {\"decision\":\"TAKE\"|\"SKIP\",\"confidence\":0-100,\"reason\":\"<=12 words\"}.")

TAIL = ('\n\nPROPOSED TRADE: SHORT at the current price. Stop 1 ATR above entry. Target 5 ATR below entry (5R). Time limit 72 hours. Historically about 1 in 10 of these reach the target, about 6 in 10 stop out at -1R, and about 1 in 4 time out near +1.5R - which nets to roughly +0.2R per trade after fees, so the structure itself is profitable on average. The question is not whether this structure pays; it is whether THIS setup looks better or worse than the typical one. You are expected to TAKE a meaningful share of setups; skipping everything is abstention, not selection. Decide: TAKE or SKIP.')


def dossier(r, closes):
    base = float(closes[-1])
    norm = [round(float(x) / base * 100, 2) for x in closes]
    return (
        f"ANONYMIZED ASSET - multi-timeframe technical dossier at the moment of the proposal.\n\n"
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
        f"DERIVATIVES: funding {g(r,'fundingRateRaw'):+.3f}% | OI 6-bar chg {g(r,'oiChangePct'):+.1f}% | "
        f"taker buy/sell {g(r,'takerRatioRaw',1.0):.2f} | accounts long {g(r,'longPctRaw',50):.0f}% | basis {g(r,'basisPct'):+.2f}% | "
        f"funding-signal {g(r,'fundingSignal'):+.0f} | crowding {g(r,'crowdingSignal'):+.0f}\n"
        f"VOLUME PROFILE / LEVELS: dist-to-POC {g(r,'vpDistToPocATR'):+.1f} ATR | above-POC {yn(g(r,'vpAbovePoc'))} | "
        f"in-value-area {yn(g(r,'vpInValueArea'))} | dist-to-VAH {g(r,'vpDistToVAH_ATR'):.1f} ATR | dist-to-VAL {g(r,'vpDistToVAL_ATR'):.1f} ATR\n"
        f"CONTEXT: last-3 {('3-green' if g(r,'last3Green')>0.5 else '3-red' if g(r,'last3Red')>0.5 else 'mixed')} | "
        f"body/range {g(r,'bodyWickRatio'):.2f} | Fear&Greed {g(r,'fearGreedIndex',50):.0f} (0=fear,100=greed) | "
        f"ETH/BTC 6-bar chg {g(r,'ethBtcDelta6'):+.2f} | ATR {g(r,'atrPercent'):.1f}% of price"
        + TAIL
    )


def main():
    os.makedirs(OUT, exist_ok=True)
    df = pd.read_pickle(DATA)
    pay = pd.read_pickle(PAYOFF)
    df = df.merge(pay, on=['symbol', 'timestamp'], how='inner')
    df = df[df.f_atrPercent > 0].copy()
    feats = [c for c in df.columns if c.startswith('f_') and c != 'f_timestamp'
             and not c.startswith(('f_fwd', 'f_trade')) and pd.api.types.is_numeric_dtype(df[c])]
    print(f'{len(df):,} rows, {len(feats)} features', flush=True)

    cache = os.path.join(OUT, 'scored.pkl.gz')
    if os.path.exists(cache):
        df = pd.read_pickle(cache); print('scored frame loaded from cache', flush=True)
    else:
        print('walk-forward OOF SHORT scores:', flush=True)
        df = oof_short_scores(df, feats)
        df.to_pickle(cache)
    scored = df[df.p_short.notna()].copy()

    # Production scoring. LONG at base rate (head refused); SHORT from the model, ratio-scaled
    # against the base curve and capped at 3x as excursion.ts does.
    base_long = df['hit_LONG_5R'].mean()
    base_short = df['hit_SHORT_5R'].mean()
    ratio = np.minimum(3.0, scored.p_short / base_short)
    p_short = np.clip(base_short * ratio, 0.001, 0.95)
    scored['fee_r'] = ROUND_TRIP_PCT / scored.f_atrPercent.clip(lower=0.05)
    scored['ev_long'] = three_way_ev(base_long) - scored.fee_r
    scored['ev_short'] = three_way_ev(p_short) - scored.fee_r
    gap = scored.ev_long - scored.ev_short
    scored['direction'] = np.where(gap.abs() < MIN_EDGE_R, None, np.where(gap > 0, 'LONG', 'SHORT'))
    scored['net_ev'] = np.where(scored.direction == 'LONG', scored.ev_long, scored.ev_short)
    prop = scored[(scored.direction.notna()) & (scored.net_ev >= MIN_DISPLAY_EV_R)].copy()
    n_long = int((prop.direction == 'LONG').sum())
    greedy = (prop.direction == 'SHORT') & (prop.f_fearGreedIndex > GREED)
    print(f'proposals before mood: {len(prop):,} (LONG {n_long}) ; greed-cancelled SHORT: {int(greedy.sum()):,}')
    prop = prop[~greedy].copy()
    prop['r_gross'] = np.where(prop.direction == 'LONG', prop.r_LONG_5R, prop.r_SHORT_5R)
    prop['r_net'] = prop.r_gross - prop.fee_r
    prop['half'] = half(prop.timestamp)
    prop['day'] = (prop.timestamp // 86400).astype(int)
    print(f'proposal population: {len(prop):,} rows, {prop.symbol.nunique()} symbols, '
          f'mean net R {prop.r_net.mean():+.4f}, halves {prop.half.nunique()}', flush=True)
    prop.to_pickle(os.path.join(OUT, 'proposals.pkl.gz'))

    # Stratified sample: equal per half-year, <= 1 per (symbol, day).
    rng = np.random.RandomState(SEED)
    thin = prop.sample(frac=1, random_state=SEED).drop_duplicates(['symbol', 'day'])
    halves = sorted(thin.half.unique())
    per = int(np.ceil(N_SAMPLE / len(halves)))
    parts = []
    for h in halves:
        sub = thin[thin.half == h]
        parts.append(sub.sample(n=min(per, len(sub)), random_state=rng))
    sample = pd.concat(parts).sample(frac=1, random_state=SEED).head(N_SAMPLE).reset_index(drop=True)
    print(f'sample: {len(sample):,} rows; per half-year: {sample.half.value_counts().sort_index().to_dict()}')

    cidx = candle_index()
    items, key = [], {}
    for i, r in sample.iterrows():
        sym = r['symbol']
        if sym not in cidx:
            continue
        ct = cidx[sym]['t']
        s = np.searchsorted(ct, int(r['timestamp']), 'right')
        if s < 30:
            continue
        closes = cidx[sym]['close'][s - 28:s]
        if len(closes) < 28 or np.any(closes <= 0):
            continue
        cid = f's{i:04d}'
        items.append({'id': cid, 'prompt': dossier(r, closes)})
        key[cid] = dict(symbol=sym, timestamp=int(r.timestamp), half=r.half, day=int(r.day),
                        direction=r.direction, net_ev=float(r.net_ev), fee_r=float(r.fee_r),
                        r_gross=float(r.r_gross), r_net=float(r.r_net), atr_pct=float(r.f_atrPercent),
                        fear_greed=float(r.f_fearGreedIndex) if not pd.isna(r.f_fearGreedIndex) else None)
    with open(os.path.join(OUT, 'sample.jsonl'), 'w') as f:
        for it in items:
            f.write(json.dumps(it) + '\n')
    pd.DataFrame.from_dict(key, orient='index').to_pickle(os.path.join(OUT, 'key.pkl.gz'))
    with open(os.path.join(OUT, 'system_prompt.txt'), 'w') as f:
        f.write(SYSTEM)
    print(f'wrote {len(items):,} dossiers; base rate in sample: target {np.mean([key[i["id"]]["r_gross"] >= PRIMARY_R for i in items])*100:.1f}%, '
          f'mean net R {np.mean([key[i["id"]]["r_net"] for i in items]):+.4f}')
    print(f'\n--- sample dossier ({items[0]["id"]}) ---\n{items[0]["prompt"]}')


if __name__ == '__main__':
    main()
