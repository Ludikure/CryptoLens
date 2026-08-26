#!/usr/bin/env python3
"""How often did the 4-8h train/serve offset change a temporal feature? (plan step 4.3)

`computeAllFeatures`'s `evalTimeMs` defaults to `Date.now()` and the live cron was not passing it,
while training passes the 4H bar's OPEN. The cron runs every minute against the last CLOSED bar, so
the served timestamp sits in [T+4h, T+8h).

NOTE ON THIS SCRIPT'S OWN CORRECTNESS. The first version reported `isWeekend` differing on 0.00% of
bars, which is not plausible, and that implausibility is what exposed the bug: pandas returned a
`datetime64[us]` index here, so `astype("int64") // 10**6` produced SECONDS rather than milliseconds
and every date landed in 1970. The conversion now goes through an explicit `datetime64[ms]` cast and
is ASSERTED against a known date before anything is computed. Same class of defect as the ones this
whole programme is repairing — a unit assumption, unchecked.
"""
import numpy as np, pandas as pd

BUCKETS = (8, 14, 21)          # ET hour boundaries, matching scoring-full.ts


def to_ms(idx: pd.DatetimeIndex) -> np.ndarray:
    ms = idx.tz_convert('UTC').tz_localize(None).astype('datetime64[ms]').astype('int64')
    got = str(pd.to_datetime(ms[0], unit='ms', utc=True).date())
    want = str(idx[0].date())
    assert got == want, f'timestamp conversion is wrong: got {got}, expected {want}'
    return ms


def feats(ms: np.ndarray):
    t = pd.to_datetime(ms, unit='ms', utc=True).tz_convert('America/New_York')
    dow = ((t.dayofweek + 1) % 7).to_numpy()          # Sun=0..Sat=6, matching the TS map
    h = t.hour.to_numpy()
    bucket = np.where(h < BUCKETS[0], 0, np.where(h < BUCKETS[1], 1, np.where(h < BUCKETS[2], 2, 3)))
    return dow, bucket, ((dow == 0) | (dow == 6)).astype(int)


def main():
    opens = pd.date_range('2022-01-01', '2026-06-01', freq='4h', tz='UTC')
    ms = to_ms(opens)
    d0, b0, w0 = feats(ms)
    print(f'{len(ms):,} 4H bar opens, {opens[0].date()} .. {opens[-1].date()}\n')
    print(f'{"cron lag":>10}{"dayOfWeek differs":>20}{"hourBucket differs":>21}{"isWeekend differs":>20}')
    for lag in (4, 5, 6, 7, 8):
        d1, b1, w1 = feats(ms + lag * 3_600_000)
        print(f'{lag:>8}h{np.mean(d0 != d1):>20.2%}{np.mean(b0 != b1):>21.2%}{np.mean(w0 != w1):>20.2%}')
    print('\nThe cron fires every minute, so the realised lag is spread across [4h, 8h).')


if __name__ == '__main__':
    main()
