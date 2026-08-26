#!/usr/bin/env python3
"""The shared payoff simulator. Every entry/stop/target measurement goes through this.

WHY THIS EXISTS. A load-bearing number — the entry-discipline gain — was hand-computed three times
in three throwaway scripts and produced three different answers (+0.0919, +0.0009, +0.0216), each
reported with confidence. The defect is not any one calculation; it is that the calculation lived in
a heredoc. Twelve scripts each carried their own copy of the same loop, so a fix to one fixed none of
the others, and five distinct measurement defects reached production that way.

**No further one-off simulation may justify a production change.**

THE ANCHOR, which is what went wrong. A feature row timestamped T carries `price` = the CLOSE of the
4H bar spanning T..T+4h — verified by nearest-match against the hourly klines, offset +3 fitting at
4.6e-04 against 2.4e-03 for the next best. So the row is only KNOWN at T+4h, and the first bar a
strategy may act in is the hourly bar OPENING at T+4h. Every script instead scanned from T+1h, which
counts a pullback that had already happened inside the signal bar as a fill. Correcting it inverted
the headline finding on SHORT.

Two anchors ship, deliberately:

    anchor='legacy_open'  scan from base+1  — the OLD, LEAKY behaviour, kept ONLY so a port can be
                                              proved bit-identical to the pickle it replaces before
                                              the semantics change. Isolates port bugs from the fix.
    anchor='bar_close'    scan from base+4  — correct. The entry bar is the one opening at T+4h and
                                              offsets run from ZERO, not one. Starting at one drops
                                              the first hour of every trade, which is the highest-
                                              hazard bar for a stop, and is the error that produced
                                              the SECOND wrong retraction.

Delete `legacy_open` once every caller has been ported.
"""
from __future__ import annotations
import subprocess
from dataclasses import dataclass, field, asdict
from typing import Literal

import numpy as np
import pandas as pd

MODULE_VERSION = '1.0.0'
Anchor = Literal['legacy_open', 'bar_close']
Entry = Literal['pullback', 'market', 'market_with_slippage']


def _git_sha() -> str | None:
    try:
        return subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'],
                                       stderr=subprocess.DEVNULL, text=True).strip()
    except Exception:
        return None


@dataclass
class Provenance:
    """Stamped onto every emitted frame. A pickle whose origin is unknown is not evidence."""
    module: str = 'ml-training/_payoff.py'
    module_version: str = MODULE_VERSION
    git_sha: str | None = field(default_factory=_git_sha)
    anchor: str = ''
    entry_mode: str = ''
    params: dict = field(default_factory=dict)
    symbols: int = 0
    rows_in: int = 0
    rows_out: int = 0
    dropped_no_path_match: int = 0
    dropped_short_horizon: int = 0
    dropped_gap_in_window: int = 0
    dropped_bad_atr: int = 0
    nan_counts: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PayoffParams:
    wait_h: int = 12            # hours allowed for the entry to be touched
    hold_h: int = 72            # hours held from the FILL bar
    stop_atr: float = 2.0
    tp_atr: float = 2.5
    fee_pct: float = 0.171      # round-trip, in percent of notional
    bar_hours: int = 4          # the feature bar's length, in path bars
    slippage_atr: float = 0.0   # only used by entry_mode='market_with_slippage'
    # Arm A of the entry controls: require price to trade THROUGH the level by this much rather than
    # merely touch it. A limit order at a price the market kisses once often does not fill.
    trigger_penetration_atr: float = 0.0
    # Arm B: enter at market this many path bars after the signal, to separate the LEVEL from the
    # DELAY. Applies to market modes only.
    delay_bars: int = 0


def _first_true(mask: np.ndarray, never: int) -> np.ndarray:
    """Column index of the first True per row, or `never` where the row is all False."""
    return np.where(mask.any(1), mask.argmax(1), never)


def simulate(
    feat: pd.DataFrame,
    path: pd.DataFrame,
    *,
    symbol: str,
    depth_atr: float,
    side: Literal['LONG', 'SHORT'],
    anchor: Anchor,
    entry_mode: Entry = 'pullback',
    params: PayoffParams | None = None,
    require_contiguous: bool = True,
) -> tuple[pd.DataFrame, Provenance]:
    """One symbol, one depth, one side. Returns per-opportunity rows plus provenance.

    `feat` needs `timestamp` (s or ms), `price`, `atrPercent`. `path` needs `ts` (s), `high`, `low`,
    `close` at a fixed 1-hour spacing.

    THE PRIMARY OUTPUT IS `oppR` — R per OPPORTUNITY, with an unfilled setup scoring EXACTLY 0. A
    pullback rule only trades when price comes back, so it systematically misses the bars where price
    ran away, which are the strongest moves. Judging it on filled trades alone measures the survivors
    of its own selection. `fillR` is NaN when unfilled, so a mean over it is per-filled-trade.
    """
    p = params or PayoffParams()
    prov = Provenance(anchor=anchor, entry_mode=entry_mode,
                      params={**p.__dict__, 'depth_atr': depth_atr, 'side': side}, symbols=1)

    if anchor not in ('legacy_open', 'bar_close'):
        raise ValueError(f'unknown anchor {anchor!r}')
    if entry_mode == 'pullback' and depth_atr <= 0:
        raise ValueError('pullback entry needs a positive depth; use entry_mode="market" for depth 0')
    if entry_mode != 'pullback' and depth_atr != 0:
        raise ValueError(f'entry_mode={entry_mode!r} takes no depth (got {depth_atr})')

    ts_raw = feat['timestamp'].to_numpy(np.int64)
    fts = (ts_raw // 1000) if ts_raw[0] > 1e12 else ts_raw
    pts = path['ts'].to_numpy(np.int64)
    hi, lo, cl, op = (path[c].to_numpy(np.float64) for c in ('high', 'low', 'close', 'open'))
    prov.rows_in = len(fts)

    # `shift` is the whole correction. Under bar_close the signal is only known at the CLOSE of the
    # feature bar, so the actionable window starts `bar_hours` later and its offsets start at 0.
    shift = 0 if anchor == 'legacy_open' else p.bar_hours
    first_off = 1 if anchor == 'legacy_open' else 0
    span = p.wait_h + p.hold_h + shift + first_off + p.delay_bars

    idx = np.searchsorted(pts, fts, side='left')
    in_range = (idx >= 0) & (idx < len(pts))
    matched = np.zeros(len(fts), bool)
    matched[in_range] = pts[idx[in_range]] == fts[in_range]
    prov.dropped_no_path_match = int((~matched).sum())

    horizon_ok = matched & (idx < len(pts) - span)
    prov.dropped_short_horizon = int((matched & ~horizon_ok).sum())

    # CONTIGUITY. Every offset below is index arithmetic, which silently means something else across
    # a gap. Measured on the real path files: 10 of 24 symbols have gaps, and NEARUSDT's is 57.8
    # MILLION seconds — 669 days. `base + 4` there is not "four hours later", it is two years later.
    run_id = np.concatenate([[0], np.cumsum(np.diff(pts) != 3600)])
    end_i = np.clip(idx + span, 0, len(pts) - 1)
    contiguous = horizon_ok & ((run_id[np.clip(idx, 0, len(pts) - 1)] == run_id[end_i])
                               if require_contiguous else True)
    prov.dropped_gap_in_window = int((horizon_ok & ~contiguous).sum())

    e0 = feat['price'].to_numpy(np.float64)
    atr_pct = feat['atrPercent'].to_numpy(np.float64)
    atr = (atr_pct / 100.0) * e0
    good = contiguous & np.isfinite(atr) & (atr > 0) & np.isfinite(e0) & (e0 > 0)
    prov.dropped_bad_atr = int((contiguous & ~good).sum())

    r_ = np.where(good)[0]
    prov.rows_out = len(r_)
    if len(r_) == 0:
        return pd.DataFrame(columns=['symbol', 'timestamp', 'atrPct', 'filled', 'oppR', 'fillR']), prov

    base = idx[r_] + shift          # index of the first bar the strategy may act in
    e_, a_, apct = e0[r_], atr[r_], atr_pct[r_]
    sg = 1.0 if side == 'LONG' else -1.0
    never = span + 10

    if entry_mode == 'pullback':
        entry = e_ - sg * depth_atr * a_          # AGAINST the direction: a better price
    elif entry_mode == 'market':
        entry = e_.copy()
    else:                                          # market_with_slippage
        entry = e_ + sg * p.slippage_atr * a_      # WITH the direction: a worse price

    # SIGN INVARIANT. `level_entry_controls.py` built its adverse arm by moving the entry the WRONG
    # way while keeping the pullback fill test (`low <= entry` with entry ABOVE price), so it filled
    # instantly on every bar — a market entry with forced slippage, reported as "chasing". That is
    # where the -0.129R / -0.195R numbers shipped into both prompts came from. A pullback entry must
    # be on the against-direction side of price; anything else must not use the touch test.
    if entry_mode == 'pullback':
        assert np.all(sg * (e_ - entry) >= -1e-12), \
            f'{symbol}: pullback entry is not against the direction — the fill test would be inverted'

    if entry_mode == 'pullback':
        # The TRIGGER may sit beyond the entry (arm A: trade through, don't just touch), but the
        # FILL price stays at the level — that is what a resting limit order does.
        trig = entry - sg * p.trigger_penetration_atr * a_
        w = np.arange(first_off, first_off + p.wait_h)
        wl, wh = lo[base[:, None] + w], hi[base[:, None] + w]
        touch = (wl <= trig[:, None]) if side == 'LONG' else (wh >= trig[:, None])
        ti = _first_true(touch, never)
        filled = ti < never
        fill_off = np.where(filled, first_off + ti, 0)
    else:
        # A market order fills AT THE FEATURE CLOSE. The signal IS that close, so acting on it at
        # that price is the honest model of "enter at market"; the next bar's open would be a
        # different and slightly optimistic assumption. Fill offset 0 = the bar boundary itself.
        filled = np.ones(len(e_), bool)
        fill_off = np.full(len(e_), p.delay_bars)
        if p.delay_bars:
            # Delayed market entry fills at that later bar's CLOSE.
            entry = cl[base + first_off + p.delay_bars - 1] + sg * p.slippage_atr * a_

    risk = p.stop_atr * a_
    stop = entry - sg * risk
    target = entry + sg * p.tp_atr * a_

    # THE HOLD WINDOW'S START, which is a real modelling choice and is recorded as one.
    #
    # `legacy_open` uses 1 because the original did: it excluded the fill bar itself.
    #
    # `bar_close` uses 0, and both options were measured rather than assumed:
    #
    #     hold from fill+0   SHORT -0.0125 (2/9)   LONG +0.0211 (8/9)
    #     hold from fill+1   SHORT -0.0120 (2/9)   LONG +0.0221 (8/9)
    #
    # For a MARKET entry the choice is not a choice: the fill is at the feature close, so the bar at
    # offset 0 is entirely after the fill and excluding it discards a real hour of risk. For a
    # PULLBACK the fill happens somewhere inside its bar, so that bar is genuinely ambiguous — its
    # low may precede the fill. Using DIFFERENT conventions per entry mode would bias exactly the
    # market-vs-pullback comparison being measured, so both use the unambiguous one: 0.
    #
    # This errs AGAINST the pullback arm, which is the direction a bias should run when the result
    # being tested is one we would like to be true.
    hold_from = 1 if anchor == 'legacy_open' else 0
    h = np.arange(hold_from, hold_from + p.hold_h)
    gi = base[:, None] + fill_off[:, None] + h
    # ASSERT, never clip. `np.clip` here reads the last bar repeatedly for every row near the end of
    # the series, which turns a missing horizon into a flat one instead of an error.
    assert gi.max() < len(hi), f'{symbol}: hold window runs past the path series — horizon guard failed'
    gh, gl = hi[gi], lo[gi]
    si = _first_true((gl <= stop[:, None]) if side == 'LONG' else (gh >= stop[:, None]), never)
    qi = _first_true((gh >= target[:, None]) if side == 'LONG' else (gl <= target[:, None]), never)

    exit_i = base + fill_off + hold_from + p.hold_h - 1
    assert exit_i.max() < len(cl), f'{symbol}: timeout exit runs past the path series'
    to_r = sg * (cl[exit_i] - entry) / risk

    R = p.tp_atr / p.stop_atr
    won = qi < si
    lost = (si < never) & ~won
    r = np.where(won, R, np.where(lost, -1.0, np.clip(to_r, -1.0, R)))

    # Fees are charged in R, so they scale with how wide the stop is in percent terms. The floor
    # stops a near-zero ATR from producing an unbounded fee.
    fee_r = p.fee_pct / np.clip(apct * p.stop_atr, 0.05, None)

    out = pd.DataFrame({
        'symbol': symbol, 'timestamp': fts[r_], 'atrPct': apct,
        'filled': filled.astype(np.int8),
        'oppR': np.where(filled, r - fee_r, 0.0),
        'fillR': np.where(filled, r - fee_r, np.nan),
    })
    prov.nan_counts = {c: int(out[c].isna().sum()) for c in ('oppR', 'fillR')}
    return out, prov


def eff_n(df: pd.DataFrame, mask: pd.Series | np.ndarray | None = None) -> int:
    """Independent EPISODES of a CONDITION: contiguous runs per symbol.

    Use this for a gate's fire mask. With no mask every row is True and the answer is just the symbol
    count, which is why callers should pass one — `overlap_eff_n` is the right measure for a whole
    dataset.

    Dependent observations have nearly produced a finding in this project four separate times, so
    this is a first-class output rather than something a caller may forget to compute.
    """
    d = df.reset_index(drop=True)
    m = np.ones(len(d), bool) if mask is None else np.asarray(mask, bool).copy()
    if len(m) != len(d):
        raise ValueError(f'mask length {len(m)} != frame length {len(d)}')
    total = 0
    for _, g in d.groupby('symbol', sort=False):
        v = m[g.index.to_numpy()]
        if not len(v):
            continue
        total += int((v[1:] & ~v[:-1]).sum()) + (1 if v[0] else 0)
    return total


def overlap_eff_n(n_rows: int, hold_h: int, bar_hours: int) -> int:
    """Effective sample size when consecutive rows share most of their outcome window.

    A 72-hour hold sampled every 4 hours means ~18 consecutive rows resolve against overlapping
    price paths. Treating those as 18 independent observations is what makes a "9/9 periods" claim
    read as far stronger than it is. This is the crude but honest correction: rows divided by the
    overlap factor.
    """
    overlap = max(1, hold_h // max(1, bar_hours))
    return int(n_rows // overlap)


def align_arms(arms: dict[str, pd.DataFrame], *, key=('symbol', 'timestamp'),
               max_loss: float = 0.05) -> tuple[pd.DataFrame, dict]:
    """Inner-join per-arm outputs onto ONE row set, so arms are compared on the same population.

    Arms legitimately drop different rows: a delayed-entry arm needs more future bars than a market
    arm, so its horizon guard bites harder. Concatenating them side by side without aligning would
    compare arms on different populations — the same class of error that made Part 7 score kill
    rules on 15x their true domain.

    Raises if the intersection costs more than `max_loss` of the largest arm, because at that point
    the arms are not really measuring the same thing and silently proceeding would hide it.
    """
    if not arms:
        raise ValueError('no arms')
    keys = None
    for name, df in arms.items():
        k = df[list(key)].drop_duplicates()
        keys = k if keys is None else keys.merge(k, on=list(key), how='inner')
    biggest = max(len(df) for df in arms.values())
    loss = 1.0 - (len(keys) / biggest) if biggest else 0.0
    if loss > max_loss:
        raise ValueError(f'aligning arms costs {loss:.1%} of the largest arm '
                         f'({biggest:,} -> {len(keys):,}); arms are not on comparable populations')
    out = keys
    for name, df in arms.items():
        cols = [c for c in df.columns if c not in key]
        out = out.merge(df[list(key) + cols].rename(columns={c: f'{name}|{c}' for c in cols}),
                        on=list(key), how='left')
    return out.reset_index(drop=True), {'rows': len(out), 'largest_arm': biggest, 'loss': loss}
