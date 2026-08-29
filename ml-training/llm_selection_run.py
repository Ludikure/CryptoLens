#!/usr/bin/env python3
"""Run one LLM judge over the blinded sample. Pre-declared in docs/research/llm-selection-test.md.

Resumable (decisions are appended per row; done ids are skipped on restart), concurrent, and
hard-capped in dollars at PEAK list prices so an off-peak run can only come in under.

    DEEPSEEK_API_KEY=... python3 llm_selection_run.py deepseek
    ANTHROPIC_API_KEY=... python3 llm_selection_run.py anthropic

The key is read from the environment and never printed. Output: llm_selection/decisions_<judge>.jsonl
"""
import json
import os
import sys
import time
import threading
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'llm_selection')
BUDGET_USD = float(os.environ.get('BUDGET_USD', '30'))
CONCURRENCY = int(os.environ.get('CONCURRENCY', '6'))
LIMIT = int(os.environ.get('LIMIT', '0'))          # 0 = all

JUDGES = {
    'deepseek': dict(url='https://api.deepseek.com/chat/completions', model='deepseek-v4-pro',
                     key_env='DEEPSEEK_API_KEY', in_usd=1.32, out_usd=3.96),      # peak list price
    'anthropic': dict(url='https://api.anthropic.com/v1/messages', model='claude-sonnet-5',
                      key_env='ANTHROPIC_API_KEY', in_usd=3.0, out_usd=15.0),
}

lock = threading.Lock()
spent = {'usd': 0.0, 'in': 0, 'out': 0, 'n': 0, 'err': 0}


def call(judge, system, user):
    j = JUDGES[judge]
    # The box names the Anthropic secret CLAUDE_API_KEY (Env interface); accept either spelling.
    key = os.environ.get(j['key_env']) or (os.environ.get('CLAUDE_API_KEY') if judge == 'anthropic' else None)
    if not key:
        sys.exit(f'{j["key_env"]} not set')
    if judge == 'deepseek':
        # v4-pro is a reasoning model: with thinking on it spent a 200-token cap deliberating and
        # returned empty content on 5 of 5 pilot rows. Thinking is disabled so both judges answer
        # without deliberation (Sonnet's is off by default here); the cap is raised as a margin.
        body = {'model': j['model'], 'temperature': 0, 'max_tokens': 300,
                'response_format': {'type': 'json_object'}, 'thinking': {'type': 'disabled'},
                'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
        headers = {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
    else:
        # 300, not 200: Sonnet wrote reasons past the 12-word ask and 1 of 3 pilot rows was cut
        # off mid-JSON. A truncated row is lost data, not a judgment.
        body = {'model': j['model'], 'max_tokens': 300, 'system': system,
                'messages': [{'role': 'user', 'content': user}]}
        headers = {'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'}
    req = urllib.request.Request(j['url'], data=json.dumps(body).encode(), headers=headers, method='POST')
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read())
            if judge == 'deepseek':
                msg = data['choices'][0]['message']
                text = msg.get('content') or msg.get('reasoning_content') or ''
                u = data.get('usage', {})
                tin, tout = u.get('prompt_tokens', 0), u.get('completion_tokens', 0)
            else:
                text = ''.join(b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text')
                u = data.get('usage', {})
                tin, tout = u.get('input_tokens', 0), u.get('output_tokens', 0)
            return text, tin, tout
        except urllib.error.HTTPError as e:
            if e.code == 400 and judge == 'deepseek' and 'thinking' in body:
                # an API that does not accept the switch: drop it and go on
                body.pop('thinking', None)
                req = urllib.request.Request(j['url'], data=json.dumps(body).encode(), headers=headers, method='POST')
                continue
            if e.code in (429, 500, 502, 503, 529):
                time.sleep(2 ** attempt)
                continue
            raise
        except Exception:
            time.sleep(2 ** attempt)
    raise RuntimeError('gave up after retries')


def parse(text):
    t = text.strip()
    a, b = t.find('{'), t.rfind('}')
    if a >= 0 and b > a:
        try:
            o = json.loads(t[a:b + 1])
            d = str(o.get('decision', '')).upper()
            if d in ('TAKE', 'SKIP'):
                return d, o.get('confidence'), str(o.get('reason', ''))[:120]
        except Exception:
            pass
    up = t.upper()
    if 'SKIP' in up and 'TAKE' not in up: return 'SKIP', None, t[:120]
    if 'TAKE' in up and 'SKIP' not in up: return 'TAKE', None, t[:120]
    return None, None, t[:120]


def main():
    judge = sys.argv[1] if len(sys.argv) > 1 else 'deepseek'
    j = JUDGES[judge]
    system = open(os.path.join(OUT, 'system_prompt.txt')).read()
    items = [json.loads(l) for l in open(os.path.join(OUT, 'sample.jsonl'))]
    out_path = os.path.join(OUT, f'decisions_{judge}.jsonl')
    done = set()
    if os.path.exists(out_path):
        for l in open(out_path):
            try: done.add(json.loads(l)['id'])
            except Exception: pass
    todo = [it for it in items if it['id'] not in done]
    if LIMIT: todo = todo[:LIMIT]
    print(f'{judge} ({j["model"]}): {len(done)} done, {len(todo)} to go, cap ${BUDGET_USD:.0f} at peak prices', flush=True)
    fout = open(out_path, 'a')
    stop = threading.Event()

    def one(it):
        if stop.is_set():
            return
        try:
            text, tin, tout = call(judge, system, it['prompt'])
            d, conf, reason = parse(text)
            cost = tin / 1e6 * j['in_usd'] + tout / 1e6 * j['out_usd']
            with lock:
                spent['usd'] += cost; spent['in'] += tin; spent['out'] += tout; spent['n'] += 1
                if d is None: spent['err'] += 1
                fout.write(json.dumps({'id': it['id'], 'decision': d, 'confidence': conf, 'reason': reason,
                                       'tokens_in': tin, 'tokens_out': tout, 'raw': text[:200]}) + '\n')
                fout.flush()
                if spent['n'] % 50 == 0:
                    print(f'  {spent["n"]} done  ${spent["usd"]:.2f}  in {spent["in"]:,} out {spent["out"]:,}  unparsed {spent["err"]}', flush=True)
                if spent['usd'] >= BUDGET_USD:
                    print(f'BUDGET CAP ${BUDGET_USD} reached — stopping', flush=True)
                    stop.set()
        except Exception as e:
            with lock:
                spent['err'] += 1
                fout.write(json.dumps({'id': it['id'], 'decision': None, 'error': str(e)[:200]}) + '\n')
                fout.flush()

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        list(ex.map(one, todo))
    fout.close()
    print(f'finished: {spent["n"]} calls, ${spent["usd"]:.2f} at peak list price, '
          f'tokens in {spent["in"]:,} / out {spent["out"]:,}, unparsed/errors {spent["err"]}')


if __name__ == '__main__':
    main()
