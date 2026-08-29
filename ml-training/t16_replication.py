#!/usr/bin/env python3
"""T16 — out-of-sample temporal + cross-asset replication of the T9 phenomenon.
NOT a new strategy. T9 is frozen exactly: same target, model, features, purge, exposure rule, costs.

STRONGER THAN T9 ITSELF: predictions are LEAVE-ONE-SYMBOL-OUT — the test asset is removed from
training entirely, so the model has never seen that asset's history, in addition to the walk-forward
time split. If the phenomenon is BTC-sequence-specific this cannot survive.
"""
import numpy as np, pandas as pd, lightgbm as lgb, importlib.util, json
from pathlib import Path

ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']
T9_D = lambda p: 1.00 if p < .30 else (0.50 if p <= .50 else 0.00)
COST = 0.0010


def mets(r):
    r = r.dropna()
    if len(r) < 20: return {}
    eq = (1+r).cumprod(); yrs = len(r)/365.25; dd = eq/eq.cummax()-1
    cagr = (eq.iloc[-1]**(1/yrs)-1)*100 if eq.iloc[-1] > 0 else np.nan
    return dict(cagr=cagr, dd=dd.min()*100, calmar=cagr/abs(dd.min()*100) if dd.min() else np.nan,
                sharpe=r.mean()/r.std()*np.sqrt(365.25) if r.std() else np.nan)


def episodes(px, thresh=0.30):
    out = []; peak = 0; p = px.values; idx = px.index; i = 1
    while i < len(p):
        if p[i] > p[peak]: peak = i
        elif p[i]/p[peak]-1 <= -thresh:
            j = peak + int(np.argmin(p[peak:min(len(p), peak+400)]))
            out.append((idx[peak], idx[j], p[peak], p[j])); peak = j; i = j
        i += 1
    return out


def main():
    spec = importlib.util.spec_from_file_location('t2','t2_t3_test.py')
    t2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(t2)
    a, feats = t2.build()
    a = a.dropna(subset=['y_crash']).reset_index(drop=True)
    a['dt'] = pd.to_datetime(a.timestamp, unit='s', utc=True)
    starts = pd.date_range(a.dt.min()+pd.DateOffset(months=6), a.dt.max(), freq='MS', tz='UTC')
    tb = pd.read_csv('tbill_3m.csv', parse_dates=['date']); tb['date'] = tb.date.dt.date
    results = {}

    for sym in ASSETS:
        preds = []
        for i, s in enumerate(starts):
            e = starts[i+1] if i+1 < len(starts) else a.dt.max()+pd.Timedelta(days=1)
            # LEAVE-ONE-SYMBOL-OUT: the test asset is absent from training entirely
            tr = a[(a.dt < s - pd.Timedelta(hours=4*72)) & (a.sym != sym)]
            te = a[(a.dt >= s) & (a.dt < e) & (a.sym == sym)]
            if len(tr) < 3000 or len(te) == 0: continue
            m = lgb.LGBMClassifier(max_depth=4, n_estimators=150, learning_rate=0.05,
                                   num_leaves=15, verbose=-1, n_jobs=-1)
            m.fit(tr[feats], tr['y_crash'])
            t = te.copy(); t['p'] = m.predict_proba(t[feats])[:, 1]
            preds.append(t[['timestamp','p']])
        if not preds: continue
        P = pd.concat(preds).sort_values('timestamp')
        P['date'] = pd.to_datetime(P.timestamp, unit='s', utc=True).dt.date
        sig = P.groupby('date')['p'].last()

        px = pd.read_csv(f'csv_exports_v14/{sym}.csv', usecols=['timestamp','price'], low_memory=False)
        px['date'] = pd.to_datetime(px.timestamp, unit='s', utc=True).dt.date
        pxd = px.groupby('date')['price'].last()
        d = pd.DataFrame({'px': pxd}).join(sig.rename('p'), how='left')
        d['p'] = d['p'].ffill()
        d['cashr'] = tb.set_index('date')['rate'].reindex(d.index).ffill().fillna(0)/100/365.25
        d = d.dropna(subset=['p']); d['ret'] = d.px.pct_change(); d['sig'] = d.p.shift(1)
        d = d.dropna(subset=['ret','sig'])
        d['w'] = d.sig.map(T9_D)
        d['r9'] = d.w*d.ret + (1-d.w)*d.cashr - d.w.diff().abs().fillna(0)*COST
        results[sym] = d
        print(f"[{sym}] {len(d):,} days, LOSO predictions generated", flush=True)

    print("\n" + "="*82)
    print("AGGREGATE (T9 rule frozen, leave-one-symbol-out predictions)")
    print(f"{'asset':<10}{'assetCAGR':>11}{'T9 CAGR':>10}{'assetDD':>10}{'T9 DD':>9}{'assetCal':>10}{'T9 Cal':>9}{'avgExp':>8}")
    for sym, d in results.items():
        mb, m9 = mets(d.ret), mets(d.r9)
        print(f"{sym:<10}{mb['cagr']:>10.1f}%{m9['cagr']:>9.1f}%{mb['dd']:>9.1f}%{m9['dd']:>8.1f}%"
              f"{mb['calmar']:>10.2f}{m9['calmar']:>9.2f}{d.w.mean()*100:>7.0f}%")

    print("\n" + "="*82)
    print("A-F: PER-EPISODE ANTICIPATION (>=30% drawdowns)")
    print(f"{'asset':<10}{'peak':<12}{'loss':>7}{'expAtPeak':>11}{'leadDays':>10}{'minExp':>8}{'avoided':>9}")
    antic = {}
    for sym, d in results.items():
        eps = episodes(d.px)
        hits = 0
        for pk, tr, pp, tp in eps:
            m = (pd.Index(d.index) >= pk) & (pd.Index(d.index) <= tr)
            seg = d[m]
            if len(seg) < 5: continue
            pre = d[pd.Index(d.index) < pk].tail(30)
            lead = int((pre.w < 1.0).sum())
            expk = seg.w.iloc[0]*100
            av = ((1+seg.r9).prod()-1)*100 - (tp/pp-1)*100
            if expk < 100: hits += 1
            print(f"{sym:<10}{str(pk):<12}{(tp/pp-1)*100:>6.0f}%{expk:>10.0f}%{lead:>10}{seg.w.min()*100:>7.0f}%{av:>8.0f}pp")
        antic[sym] = (hits, len(eps))
    print(f"\n  C. fraction of >=30% drawdowns ANTICIPATED (exposure already reduced at the peak):")
    th, tt = 0, 0
    for sym, (h, n) in antic.items():
        th += h; tt += n
        print(f"     {sym:<10}{h}/{n}")
    print(f"     POOLED    {th}/{tt} = {th/max(1,tt)*100:.0f}%")

    print("\n" + "="*82)
    print("D-F: FALSE ALARMS, COST, AND PROTECTION PER UNIT TURNOVER")
    print(f"{'asset':<10}{'falseAlarmDays':>16}{'turnover/y':>12}{'ddReduction':>13}{'ddPerTurn':>11}")
    for sym, d in results.items():
        mb, m9 = mets(d.ret), mets(d.r9)
        fa = ((d.w < 1.0) & (d.px.shift(-30) > d.px)).sum()
        turn = d.w.diff().abs().fillna(0).sum()/(len(d)/365.25)
        ddr = abs(mb['dd'])-abs(m9['dd'])
        print(f"{sym:<10}{fa:>16,}{turn:>12.1f}{ddr:>12.1f}pp{ddr/turn:>11.2f}")

    print("\n" + "="*82)
    print("G: PLACEBO (shuffled probabilities, same distribution)")
    print(f"{'asset':<10}{'real Calmar':>13}{'placebo':>10}{'real maxDD':>12}{'placebo DD':>12}{'verdict':>12}")
    reps = 0
    for sym, d in results.items():
        m9 = mets(d.r9)
        ph = []
        for sd in range(15):
            w = pd.Series(np.random.default_rng(sd).permutation(d.sig.values), index=d.index).map(T9_D)
            ph.append(mets(w*d.ret + (1-w)*d.cashr - w.diff().abs().fillna(0)*COST))
        pc = np.mean([x['calmar'] for x in ph]); pd_ = np.mean([x['dd'] for x in ph])
        ok = m9['calmar'] > pc*1.25 and abs(m9['dd']) < abs(pd_)
        reps += ok
        print(f"{sym:<10}{m9['calmar']:>13.2f}{pc:>10.2f}{m9['dd']:>11.1f}%{pd_:>11.1f}%{'REPLICATES' if ok else 'no':>12}")

    print("\n" + "="*82)
    print(f"PRIMARY QUESTION: does the signal identify tail risk OUTSIDE the BTC sequence it was found on?")
    print(f"  assets where the placebo is beaten decisively AND drawdown improves: {reps}/{len(results)}")
    print(f"  large drawdowns anticipated across all assets: {th}/{tt} = {th/max(1,tt)*100:.0f}%")
    print(f"\n  VERDICT: {'REPLICATES' if reps >= 3 and th/max(1,tt) >= 0.5 else 'DOES NOT REPLICATE CLEANLY'}")


if __name__ == '__main__':
    main()
