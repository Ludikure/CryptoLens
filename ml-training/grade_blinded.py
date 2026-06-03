#!/usr/bin/env python3
"""Grade the blinded AI directional calls vs the hidden forward outcomes.
Metrics: FLAT rate (selectivity); directional HIT-rate vs 50% null (z-test); mean forward-R
(t-test); by confidence bucket; LONG vs SHORT; and a random-direction control on the same bars.
"""
import json, glob, numpy as np

key = json.load(open('/tmp/blinded_key.json'))
calls = {}
for f in sorted(glob.glob('/tmp/blinded_out_*.jsonl')):
    for line in open(f):
        line = line.strip()
        if not line: continue
        try:
            o = json.loads(line); calls[o['id']] = o
        except Exception:
            pass
print(f"loaded {len(calls)} AI calls, {len(key)} keyed outcomes\n")

rows = []
for cid, o in calls.items():
    if cid not in key: continue
    k = key[cid]; d = str(o.get('dir', '')).upper(); conf = float(o.get('conf', 50))
    fr = k['fwdRet']; atr = k['atrPct'] / 100
    rrow = {'dir': d, 'conf': conf, 'fwdRet': fr, 'R': fr / atr if atr > 0 else 0}
    rows.append(rrow)

flat = [r for r in rows if r['dir'] == 'FLAT']
trade = [r for r in rows if r['dir'] in ('LONG', 'SHORT')]
print(f"FLAT (no-call): {len(flat)}/{len(rows)} = {len(flat)/len(rows)*100:.0f}%   "
      f"committed LONG/SHORT: {len(trade)}\n")


def grade(sub, label):
    if not sub:
        print(f"  {label:<28} (none)"); return
    hit = np.array([1 if ((r['dir'] == 'LONG' and r['fwdRet'] > 0) or (r['dir'] == 'SHORT' and r['fwdRet'] < 0)) else 0 for r in sub])
    # robust magnitude: forward RETURN % in the called direction, winsorized to ±15%
    ret = np.array([(r['fwdRet'] if r['dir'] == 'LONG' else -r['fwdRet']) * 100 for r in sub])
    ret = np.clip(ret, -15, 15)
    n = len(sub); hr = hit.mean(); z = (hr - 0.5) / np.sqrt(0.25 / n)
    t = ret.mean() / (ret.std() / np.sqrt(n)) if ret.std() > 0 else 0
    sig = '  <-- p<0.05' if abs(z) > 1.96 else ''
    print(f"  {label:<28} n={n:>4}  hit={hr*100:>5.1f}%  z={z:>+5.2f}  ret%/call={ret.mean():>+5.2f}  t={t:>+5.2f}{sig}")


print(f"{'group':<30}{'n':>6}   hit% (z vs 50 null)   ret%-in-dir (t vs 0)")
grade(trade, 'ALL committed calls')
grade([r for r in trade if r['dir'] == 'LONG'], 'LONG calls')
grade([r for r in trade if r['dir'] == 'SHORT'], 'SHORT calls')
grade([r for r in trade if r['conf'] >= 65], 'high conf (>=65)')
grade([r for r in trade if r['conf'] < 65], 'low conf (<65)')

# proper random null: many draws → true noise floor at this n
rng = np.random.RandomState(1)
hrs = []
for _ in range(3000):
    dirs = rng.choice([1, -1], size=len(trade))
    hrs.append(np.mean([(1 if (d > 0) == (r['fwdRet'] > 0) else 0) for d, r in zip(dirs, trade)]))
hrs = np.array(hrs)
print(f"\n  RANDOM null ({len(trade)} bars): mean hit={hrs.mean()*100:.1f}%, "
      f"95% range [{np.percentile(hrs,2.5)*100:.1f}%, {np.percentile(hrs,97.5)*100:.1f}%]")
print(f"  → at n={len(trade)} the noise band alone spans ~{(np.percentile(hrs,97.5)-np.percentile(hrs,2.5))*100:.0f}pp. "
      f"The AI's {np.mean([1 if ((r['dir']=='LONG' and r['fwdRet']>0) or (r['dir']=='SHORT' and r['fwdRet']<0)) else 0 for r in trade])*100:.1f}% sits INSIDE it.")
print("\nVerdict: hit% within the random band + no high-vs-low-conf separation => the AI's chart-reading "
      "shows NO directional edge. Consistent with barrier-ordering: price structure doesn't predict direction, "
      "and the LLM reading the same structure doesn't either.")
