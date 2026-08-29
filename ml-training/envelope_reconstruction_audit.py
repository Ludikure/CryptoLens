#!/usr/bin/env python3
"""How wrong were the Python reconstructions of the Conviction Envelope?

CONTEXT. Parts 1-11 of `docs/research/envelope-rules.md` measured the envelope by REBUILDING its
rules in Python from the v14 feature columns. Two max-effort reviews then found five defects in that
measurement code, every one of which had already driven a live change. The repair (plan step 1.9)
was to stop having a second implementation: `marketscope-worker/scripts/exportEnvelope.ts` replays
the REAL `buildUserPrompt` and records `result.envelope` — the verdict object itself.

This script is the accounting. It puts the reconstructions and the truth side by side on the same
bars and reports how far apart they are, so that discarding the affected arms rests on a measured
disagreement rather than on an argument.

It computes NO payoffs and reaches NO trading conclusion. The payoff layer is separately retracted
(plan phase 1a); mixing the two is how the original numbers got their credibility.

Usage:  python3 envelope_reconstruction_audit.py [--symbols N]
"""
import sys, glob, os
import numpy as np, pandas as pd
import _guards as G

EXPORTS, V14 = 'envelope_exports', 'csv_exports_v14'

def load(sym):
    e = pd.read_csv(f'{EXPORTS}/{sym}.csv')
    v = pd.read_csv(f'{V14}/{sym}.csv')
    d = e.merge(v, on='timestamp', suffixes=('', '_v14'), how='inner')
    d['symbol'] = sym
    return d

def jaccard(a, b):
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else float('nan')

def row(name, truth, recon, extra=''):
    agree = float((truth == recon).mean())
    return dict(condition=name, true_fires=float(truth.mean()), recon_fires=float(recon.mean()),
                agreement=agree, jaccard=jaccard(truth, recon),
                true_only=float((truth & ~recon).mean()), recon_only=float((recon & ~truth).mean()),
                note=extra)

def main():
    n = int(sys.argv[sys.argv.index('--symbols') + 1]) if '--symbols' in sys.argv else 10**9
    syms = sorted(os.path.basename(p)[:-4] for p in glob.glob(f'{EXPORTS}/*.csv')
                  if os.path.exists(f'{V14}/{os.path.basename(p)}'))[:n]
    if not syms:
        sys.exit(f'no exports in {EXPORTS}/ — run marketscope-worker/scripts/exportEnvelope.ts first')
    d = pd.concat([load(s) for s in syms], ignore_index=True)
    print(f'{len(d):,} bars, {len(syms)} symbols\n')

    out = []

    # ── 0. the guards, on the real columns ────────────────────────────────────────────────────
    # Run first, and reported rather than raised, because this script's PURPOSE is to characterise
    # broken conditions — a guard that aborted here would prevent the very measurement being made.
    # Everywhere else they should raise.
    print('=== guards (each of these caught a defect that shipped) ===')
    try:
        G.check_value_domain('|momentumAlignment| (used as a continuation COUNT)',
                             d.momentumAlignment.abs().to_numpy(), 2)
        print('  value domain: PASSED (unexpected)')
    except G.GuardError as e:
        print(f'  value domain: {e}')
    bias = np.sign(d.tfAlignment)
    fund = np.sign(d.fundingRateRaw.fillna(0))
    try:
        G.check_no_duplicates({'live funding rule': ((fund == bias) & (bias != 0)).to_numpy(),
                               'reconstruction':    ((fund == -bias) & (bias != 0)).to_numpy()})
        print('  duplicate/complement: PASSED')
    except G.GuardError as e:
        print(f'  duplicate/complement: {str(e).splitlines()[-1].strip()}')
    print(f'  independence: {G.check_independence(len(d), 72, 4)}')
    print()

    # ── 1. continuation ────────────────────────────────────────────────────────────────────────
    # `envelope_whole.py:43`: cont = |f_momentumAlignment|, then `cont < 2` and `cont < 3`.
    # momentumAlignment is a THREE-VALUED alignment score in {-1,0,1}; continuationCount is a COUNT
    # of three 4H signals in {0,1,2,3}. They are different quantities that happen to be small ints.
    cont_true = d.continuationCount
    cont_recon = d.momentumAlignment.abs()
    print('=== continuation: |momentumAlignment| vs the real signal count ===')
    print(pd.crosstab(cont_recon.rename('|momentumAlignment|'), cont_true.rename('continuationCount')))
    print(f'\nvalue domains — reconstruction {sorted(cont_recon.dropna().unique())}, '
          f'truth {sorted(cont_true.dropna().unique())}\n')
    for k in (2, 3):
        out.append(row(f'continuation < {k}', cont_true < k, cont_recon < k,
                       'the threshold exceeds the proxy\'s range' if k > cont_recon.max() else ''))

    # ── 2. alignment ───────────────────────────────────────────────────────────────────────────
    al = d.tfAlignment
    out.append(row('biases_MIXED', d.alignment == 'MIXED', al == 0))
    out.append(row('alignment_not_full',
                   ~d.alignment.isin(['ALIGNED_BULLISH', 'ALIGNED_BEARISH']), al.abs() < 2))

    # ── 3. funding_supports_counter ────────────────────────────────────────────────────────────
    # `envelope_sweep.py:24` reconstructs it as sign(funding) == -bias. The live rule
    # (`prompt.ts:884`) is sign(funding) == sign(bias). Disjoint sets by construction — but the rule
    # ALSO only exists inside `if (oneHOpposes && oneH)`, so its true domain is a small subset of
    # the bars the sweep scored. Both errors are shown.
    bias = np.sign(al)
    fund = np.sign(d.fundingRateRaw.fillna(0))
    recon_fsc = (fund == -bias) & (bias != 0)
    live_rule = (fund == bias) & (bias != 0)
    out.append(row('funding_supports_counter (sign only)', live_rule, recon_fsc, 'sign inverted'))
    out.append(row('funding_supports_counter (as gated)', live_rule & d.oneHOpposes.astype(bool),
                   recon_fsc, 'sign inverted AND domain unscoped'))

    # ── 4. the kill scoping, which applies to EVERY kill row in Part 7 ─────────────────────────
    out.append(row('ANY_KILLED domain', d.oneHOpposes.astype(bool),
                   pd.Series(True, index=d.index),
                   'Part 7 scored kill rules on all bars; they only exist on pullback bars'))

    # ── 5. 1H opposes ──────────────────────────────────────────────────────────────────────────
    oneH = np.sign(d.oneHScore.fillna(0))
    out.append(row('1H opposes daily', d.oneHOpposes.astype(bool),
                   (oneH != 0) & (bias != 0) & (oneH != bias)))

    r = pd.DataFrame(out)
    for c in ('true_fires', 'recon_fires', 'agreement', 'jaccard', 'true_only', 'recon_only'):
        r[c] = r[c].map(lambda x: f'{x:.4f}' if pd.notna(x) else '—')
    print('=== condition-level disagreement ===')
    print(r.to_string(index=False))

    # ── 6. the whole tier ──────────────────────────────────────────────────────────────────────
    # `envelope_whole.py:tiers()` with ML held out of it, so this isolates the STRUCTURAL gates —
    # the export carries no ML, and the point here is the reconstruction, not the model.
    stack = d.dStackBull.astype(bool) | d.dStackBear.astype(bool)
    flat = (al == 0) | ((al.abs() == 2) & stack)
    modb = cont_recon < 2
    highb = (cont_recon < 3) | (al.abs() < 2)
    t = pd.Series('HIGH', index=d.index)
    t[highb] = 'MODERATE'; t[modb] = 'LOW'; t[flat] = 'FLAT'
    print('\n=== max_allowed: reconstruction (rows) vs the real envelope (columns), ML excluded ===')
    ct = pd.crosstab(t.rename('reconstructed'), d.maxAllowed.rename('actual'))
    print(ct)
    print(f'\nagreement {float((t == d.maxAllowed).mean()):.4f}')

if __name__ == '__main__':
    main()
