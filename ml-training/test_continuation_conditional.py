"""
Test 3: Is there a CONDITIONAL setup where 4H momentum continuation rate hits ~75%?

Tests multiple "clear-trend" conditions and reports the continuation rate
(P(next 4H sign == prev 4H sign)) within each subset.

If any condition shows ~75%, that's the validated form of the CLAUDE.md claim.
If all are <60%, the 75% claim is folklore regardless of conditioning.
"""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd

from calibrate_v11_stocks import STOCK_SYMBOLS, load_symbol, downsample_daily


def main():
    print("=" * 70)
    print("Conditional 4H Momentum Continuation Test")
    print("=" * 70)

    print("\nLoading stock CSVs...")
    parts = []
    for sym in STOCK_SYMBOLS:
        d = load_symbol(sym, is_crypto=False)
        if d is None:
            continue
        d = downsample_daily(d).sort_values('timestamp').reset_index(drop=True)
        d['prev_fwdRet4H'] = d['fwdReturn4H'].shift(1)
        parts.append(d)
    all_data = pd.concat(parts, ignore_index=True)
    valid = all_data[all_data['prev_fwdRet4H'].notna() & all_data['fwdReturn4H'].notna()].copy()
    valid['prev_up'] = (valid['prev_fwdRet4H'] > 0).astype(int)
    valid['this_up'] = (valid['fwdReturn4H'] > 0).astype(int)
    valid['continued'] = (valid['prev_up'] == valid['this_up']).astype(int)
    print(f"  total bars (with prev+this 4H): {len(valid)}")

    pop_rate = valid['continued'].mean() * 100
    print(f"  population continuation rate: {pop_rate:.1f}%")

    print("\n" + "=" * 70)
    print("CONDITIONAL CONTINUATION RATES")
    print("=" * 70)
    print(f"{'Condition':<55} {'N':>10} {'Cont %':>10} {'Δ pop':>10}")
    print("-" * 70)

    def report(name, mask):
        n = mask.sum()
        if n < 100:
            print(f"{name:<55} {n:>10} {'(too few)':>10}")
            return
        rate = valid.loc[mask, 'continued'].mean() * 100
        delta = rate - pop_rate
        marker = " ★" if rate >= 70 else ""
        print(f"{name:<55} {n:>10} {rate:>9.1f}% {delta:>+9.1f}pp{marker}")

    # 1. Bias alignment
    report("biasAlignment == aligned_bullish", valid['biasAlignment'] == 'aligned_bullish')
    report("biasAlignment == aligned_bearish", valid['biasAlignment'] == 'aligned_bearish')
    report("biasAlignment == aligned_*  (any)",
           valid['biasAlignment'].isin(['aligned_bullish', 'aligned_bearish']))
    report("biasAlignment != neutral & != conflict",
           ~valid['biasAlignment'].isin(['neutral', 'conflict']))

    # 2. Regime
    report("regime == TRENDING", valid['regime'] == 'TRENDING')
    report("regime == RANGING", valid['regime'] == 'RANGING')

    # 3. EMA stack alignment
    report("emaRegime == bullish", valid['emaRegime'] == 'bullish')
    report("emaRegime == bearish", valid['emaRegime'] == 'bearish')
    report("emaRegime != mixed", valid['emaRegime'].isin(['bullish', 'bearish']))

    # 4. Daily bias is strongly directional
    report("dailyBias in {Strong Bullish, Strong Bearish}",
           valid['dailyBias'].isin(['Strong Bullish', 'Strong Bearish']))

    # 5. Combos: trending + biases aligned
    report("TRENDING + biases aligned",
           (valid['regime'] == 'TRENDING') &
           valid['biasAlignment'].isin(['aligned_bullish', 'aligned_bearish']))
    report("TRENDING + emaRegime != mixed",
           (valid['regime'] == 'TRENDING') &
           valid['emaRegime'].isin(['bullish', 'bearish']))
    report("TRENDING + biasAlignment + emaRegime aligned",
           (valid['regime'] == 'TRENDING') &
           valid['biasAlignment'].isin(['aligned_bullish', 'aligned_bearish']) &
           valid['emaRegime'].isin(['bullish', 'bearish']))

    # 6. Even more selective: prev 4H matches the dominant trend
    bull_trend = (valid['biasAlignment'] == 'aligned_bullish') & (valid['emaRegime'] == 'bullish')
    bear_trend = (valid['biasAlignment'] == 'aligned_bearish') & (valid['emaRegime'] == 'bearish')
    # Prev 4H matched dominant trend
    bull_match = bull_trend & (valid['prev_up'] == 1)
    bear_match = bear_trend & (valid['prev_up'] == 0)
    report("aligned_bullish + emaBull + prev_up == 1", bull_match)
    report("aligned_bearish + emaBear + prev_up == 0", bear_match)

    # 7. Conditional on tfAlignment scalar (already in data)
    if 'tfAlignment' in valid.columns and 'momentumAlignment' in valid.columns:
        report("tfAlignment >= 2 (multi-TF agree)", valid['tfAlignment'] >= 2)
        report("tfAlignment <= -2 (multi-TF agree bearish)", valid['tfAlignment'] <= -2)
        report("|tfAlignment| >= 2", valid['tfAlignment'].abs() >= 2)
        report("|momentumAlignment| >= 5", valid['momentumAlignment'].abs() >= 5)
        report("|tfAlignment| >= 2 + |momentumAlignment| >= 5",
               (valid['tfAlignment'].abs() >= 2) & (valid['momentumAlignment'].abs() >= 5))

    # 8. Strong setup combo (most selective)
    strongest = (
        (valid['regime'] == 'TRENDING') &
        valid['biasAlignment'].isin(['aligned_bullish', 'aligned_bearish']) &
        valid['emaRegime'].isin(['bullish', 'bearish']) &
        (valid['tfAlignment'].abs() >= 2 if 'tfAlignment' in valid.columns else True) &
        (valid['momentumAlignment'].abs() >= 5 if 'momentumAlignment' in valid.columns else True)
    )
    report("STRONGEST: TRENDING+aligned+ema+tfAlign+momoAlign", strongest)


if __name__ == '__main__':
    main()
