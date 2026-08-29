#!/usr/bin/env python3
"""Does the news block change the model's OUTPUT? — v2

v1 was structurally incapable of answering: all four sampled symbols sat in envelope auto-FLAT,
where the setup gate is UPSTREAM of anything news could influence, so the decision could not change
whatever the headlines said. It also checked for news terms only in the with-news arm, where words
like "Fed" and "ETF" appear for unrelated reasons.

Three fixes:

  1. FREE PRE-SCREEN. `promptOnly` returns the built prompt without an LLM call, so auto-FLAT
     symbols are identified for nothing and LLM spend goes only to bars that CAN change decision.
  2. A/A NOISE BASELINE. The same configuration is run twice. LLM output varies from sampling
     alone, so an A-vs-B difference means nothing until you know how big A-vs-A' is. Without this
     control, "the text differs" is unfalsifiable.
  3. ATTRIBUTABLE CITATION. Instead of generic keywords, distinctive tokens are extracted from the
     ACTUAL headlines in the block (e.g. "buyback", "MiCA", "Sandbox") and checked for presence in
     the with-news arm AND absence in the without-news arm. Only that difference is attributable.

Decision-change is only measured on tradeable bars; citation attribution works on any bar, so the
two questions are sampled separately.
"""
import json, re, sys, time, urllib.request
from pathlib import Path

BASE = 'https://marketscope.ludikure.org'
UA = 'MarketScope/1.0 (research)'
STOP = set('the a an and or of to in on for with is are was were be been this that it its as at by '
           'from has have had will would could should may might can bitcoin crypto price market '
           'new news says say said after before more most'.split())


def creds():
    return Path(sys.argv[1]).read_text().strip().split()[-2:]


def post(sym, did, tok, body, timeout=240):
    req = urllib.request.Request(f'{BASE}/full-analysis?symbol={sym}', data=json.dumps(body).encode(),
        headers={'X-App-ID': 'marketscope-ios', 'X-Device-ID': did, 'X-Auth-Token': tok,
                 'Content-Type': 'application/json', 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def screen(sym, did, tok):
    """Free: is this bar tradeable, and what headlines is it carrying?"""
    d = post(sym, did, tok, {'promptOnly': True}, timeout=90)
    p = (d.get('result') or d).get('prompt', '')
    flat = re.search(r'auto_FLAT_active: (.+)', p)
    heads = re.findall(r'^  \[[^\]]+\] (.+)$', p, re.M)
    # distinctive tokens: rare-ish words from real headlines, usable as attribution fingerprints
    toks = set()
    for h in heads:
        for w in re.findall(r"[A-Za-z][A-Za-z'-]{4,}", h.lower()):
            if w not in STOP:
                toks.add(w)
    return (flat.group(1) if flat else None), heads, toks


def sig(setups):
    if not setups: return 'NO_SETUP'
    return ' | '.join(f"{s.get('direction')}@{s.get('entry')}/sl{s.get('stopLoss')}" for s in setups)


def jac(a, b):
    wa, wb = set(a.lower().split()), set(b.lower().split())
    return len(wa & wb) / max(1, len(wa | wb))


def main():
    did, tok = creds()
    cands = sys.argv[2].split(',') if len(sys.argv) > 2 else ['SOLUSDT', 'BTCUSDT', 'ETHUSDT']
    print('pre-screen (free):')
    info = {}
    for s in cands:
        try:
            flat, heads, toks = screen(s, did, tok)
        except Exception as e:
            print(f'  {s}: screen failed ({e})'); continue
        info[s] = (flat, heads, toks)
        print(f"  {s:<10}{'AUTO-FLAT' if flat else 'TRADEABLE':<11}{len(heads)} headlines, {len(toks)} distinctive tokens")

    tradeable = [s for s, v in info.items() if not v[0]]
    print(f'\ntradeable bars available: {len(tradeable)} -> {tradeable or "none (decision test cannot run)"}\n')

    print(f"{'symbol':<10}{'A vs A2':<12}{'A vs B':<12}{'decision A':<22}{'decision B':<22}{'cited'}")
    for s in info:
        try:
            a  = post(s, did, tok, {'provider':'claude','model':'claude-sonnet-5','thinkingBudget':4000}); time.sleep(2)
            a2 = post(s, did, tok, {'provider':'claude','model':'claude-sonnet-5','thinkingBudget':4000}); time.sleep(2)
            b  = post(s, did, tok, {'provider':'claude','model':'claude-sonnet-5','thinkingBudget':4000,'noNews':True}); time.sleep(2)
        except Exception as e:
            print(f'  {s}: {e}'); continue
        ta, ta2, tb = (x.get('analysis') or '' for x in (a, a2, b))
        toks = info[s][2]
        in_a  = {t for t in toks if t in ta.lower()}
        in_b  = {t for t in toks if t in tb.lower()}
        attributable = in_a - in_b          # present WITH news, absent WITHOUT -> attributable
        da, db = sig(a.get('setups') or []), sig(b.get('setups') or [])
        print(f"{s:<10}{jac(ta,ta2):<12.2f}{jac(ta,tb):<12.2f}{da[:20]:<22}{db[:20]:<22}"
              f"{','.join(sorted(attributable)[:3]) or '-'}")
    print('\nREAD: A-vs-A2 is the sampling noise floor. A-vs-B must diverge MORE than that to mean')
    print('anything. "cited" lists headline tokens present with news and absent without — the only')
    print('attributable evidence the model actually read the block.')


if __name__ == '__main__':
    main()
