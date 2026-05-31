#!/usr/bin/env python3
"""
Extract the iOS systemPrompt (static text) faithfully from AnalysisPrompt.swift → JSON, so
the worker serves a byte-identical system prompt without hand-transcription. Replicates Swift
multiline-string semantics (strip the closing-delimiter indentation; opening/closing newlines
excluded), resolves the few interpolations (tf labels + market ternaries), and assembles the
crypto / stock variants. Re-run if the Swift system prompt changes.

  python3 scripts/extract_system_prompt.py   →  writes src/prompt-system.json
"""
import json
import os
import re

HERE = os.path.dirname(__file__)
SWIFT = os.path.join(HERE, '..', '..', 'CryptoLens', 'Services', 'AnalysisPrompt.swift')
OUT = os.path.join(HERE, '..', 'src', 'prompt-system.json')


def block(lines, open_idx):
    """Swift multiline string starting at the line that ends with '\"\"\"'. Content = the lines
    until the closing '\"\"\"', with the closing line's indentation stripped from each."""
    content = []
    i = open_idx + 1
    while lines[i].strip() != '"""':
        content.append(lines[i]); i += 1
    indent = len(lines[i]) - len(lines[i].lstrip())
    out = []
    for l in content:
        out.append('' if l.strip() == '' else l[indent:])
    return '\n'.join(out)


def find(lines, needle, start=0):
    for i in range(start, len(lines)):
        if needle in lines[i]:
            return i
    raise ValueError(f'not found: {needle}')


def resolve_tf(s):
    return s.replace('\\(tf.trend)', 'Daily').replace('\\(tf.bias)', '4H').replace('\\(tf.entry)', '1H')


TERNARY = re.compile(r'\\\(market == \.crypto \? "([^"]*)" : "([^"]*)"\)')


def main():
    lines = open(SWIFT).read().split('\n')
    base = resolve_tf(block(lines, find(lines, 'let base = """')))
    crypto_ctx = block(lines, find(lines, 'cryptoContext = """'))
    deriv = block(lines, find(lines, 'derivativesGuidance = """'))
    # Two 'return base + """' lines: crypto branch first, stock branch second. Use the second.
    crypto_ret = find(lines, 'return base + """')
    stock_ret = find(lines, 'return base + """', crypto_ret + 1)
    stock_suffix = resolve_tf(block(lines, stock_ret))

    base_crypto = TERNARY.sub(lambda m: m.group(1), base)
    base_stock = TERNARY.sub(lambda m: m.group(2), base)

    # crypto: base + "\n" + cryptoContext + "\n" + derivativesGuidance (leading \n from the
    # empty first line of the appended block); stock: base + stock suffix (also leading \n).
    crypto = base_crypto + '\n' + crypto_ctx + '\n' + deriv
    stock = base_stock + stock_suffix

    # Safety: no unresolved Swift interpolations leaked through.
    for name, s in (('crypto', crypto), ('stock', stock)):
        assert '\\(' not in s, f'unresolved interpolation in {name}'

    json.dump({'crypto': crypto, 'stock': stock}, open(OUT, 'w'), indent=0)
    print(f'wrote {OUT}')
    print(f'  crypto: {len(crypto)} chars, {crypto.count(chr(10))+1} lines')
    print(f'  stock:  {len(stock)} chars, {stock.count(chr(10))+1} lines')
    print(f'  crypto starts: {crypto[:60]!r}')
    print(f'  crypto ends:   {crypto[-70:]!r}')
    print(f'  stock ends:    {stock[-70:]!r}')


if __name__ == '__main__':
    main()
