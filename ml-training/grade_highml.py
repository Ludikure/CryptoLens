#!/usr/bin/env python3
"""Grade high-ML blinded AI direction: run 1, run 2 (replication), and POOLED.
Pre-specified hypotheses from run 1: (H1) committed hit < 50%; (H2) LONG hit < base-up-rate
(anti-selection); (H3) high-conf hit < low-conf (anti-calibration). Replication tests these."""
import json, glob, numpy as np


def load(keyf, glb):
    key = json.load(open(keyf)); calls = {}
    for f in sorted(glob.glob(glb)):
        for line in open(f):
            line = line.strip()
            if not line: continue
            try:
                o = json.loads(line); calls[o['id']] = o
            except Exception: pass
    rows = []
    for cid, o in calls.items():
        if cid not in key: continue
        d = str(o.get('dir', '')).upper()
        rows.append({'dir': d, 'conf': float(o.get('conf', 50)), 'fwdRet': key[cid]['fwdRet']})
    return rows


def report(rows, label):
    base_up = np.mean([1 if r['fwdRet'] > 0 else 0 for r in rows]) * 100
    trade = [r for r in rows if r['dir'] in ('LONG', 'SHORT')]
    lo = [r for r in trade if r['dir'] == 'LONG']; sh = [r for r in trade if r['dir'] == 'SHORT']
    hi = [r for r in trade if r['conf'] >= 65]; lc = [r for r in trade if r['conf'] < 65]

    def hit(sub):
        return np.mean([1 if ((r['dir'] == 'LONG' and r['fwdRet'] > 0) or (r['dir'] == 'SHORT' and r['fwdRet'] < 0)) else 0 for r in sub]) if sub else float('nan')

    def z(sub):
        n = len(sub); return (hit(sub) - 0.5) / np.sqrt(0.25 / n) if n else 0
    print(f"\n=== {label} ===  (n_committed={len(trade)}, base P(up)={base_up:.0f}%)")
    print(f"  ALL committed   hit={hit(trade)*100:4.1f}%  z={z(trade):+.2f}")
    print(f"  LONG            hit={hit(lo)*100:4.1f}%  z={z(lo):+.2f}   vs base-up {base_up:.0f}%  "
          f"({'ANTI-selective' if hit(lo)*100 < base_up else 'ok'})  n={len(lo)}")
    print(f"  SHORT           hit={hit(sh)*100:4.1f}%  z={z(sh):+.2f}   vs base-down {100-base_up:.0f}%  "
          f"({'ANTI-selective' if hit(sh)*100 < 100-base_up else 'ok'})  n={len(sh)}")
    print(f"  high conf >=65  hit={hit(hi)*100:4.1f}%  z={z(hi):+.2f}   n={len(hi)}")
    print(f"  low conf  <65   hit={hit(lc)*100:4.1f}%  z={z(lc):+.2f}   n={len(lc)}")
    cal = hit(hi) * 100 - hit(lc) * 100
    print(f"  CALIBRATION (high-low) = {cal:+.1f}pp  ({'INVERTED (anti-skill)' if cal < 0 else 'positive'})")
    return trade, lo, hi, lc, base_up


r1 = load('/tmp/blinded_key_highml.json', '/tmp/blinded_highml_out_*.jsonl')
r2 = load('/tmp/blinded_key_highml2.json', '/tmp/blinded_highml2_out_*.jsonl')
print(f"run1 calls={len(r1)}, run2 calls={len(r2)} (replication, batch0 missing)")
report(r1, 'RUN 1 (seed A)')
report(r2, 'RUN 2 (seed B — independent replication)')
t, lo, hi, lc, bu = report(r1 + r2, 'POOLED run1+run2')
print("\nVERDICT: if RUN 2 reproduces LONG anti-selective + inverted calibration, and POOLED LONG/"
      "high-conf clear z<-1.96, the 'AI is anti-predictive on high-ML setups' finding is real, not a"
      " run-1 fluke.")
