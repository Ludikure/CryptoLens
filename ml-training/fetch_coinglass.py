#!/usr/bin/env python3
"""Pull ~6mo of 4H aggregated OI (Coinglass) + aggregated liquidation (Coinglass) + price
(Binance) for the liquid majors, joined on 4H timestamps. Output: cg_data/<COIN>.csv with
columns time, oi, price, long_liq, short_liq — the raw material for the homemade heatmap test.
"""
import os, time, json, urllib.request, csv
CG = 'https://open-api-v4.coinglass.com'
KEY = open('/tmp/cg_key').read().strip()
OUT = os.path.join(os.path.dirname(__file__), 'cg_data')
os.makedirs(OUT, exist_ok=True)
COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC',
         'BCH', 'ATOM', 'NEAR', 'UNI', 'AAVE', 'FIL', 'INJ', 'TRX', 'SUI', 'ICP', 'HBAR',
         'ENA', 'PEPE', 'TIA']


def cg(path, **params):
    q = '&'.join(f'{k}={v}' for k, v in params.items())
    req = urllib.request.Request(f'{CG}{path}?{q}', headers={'CG-API-KEY': KEY})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)


def binance_price(coin):
    sym = coin + 'USDT'
    url = f'https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval=4h&limit=1500'
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return {int(k[0]): float(k[4]) for k in json.load(r)}   # openTime(ms) -> close
    except Exception as e:
        print(f'    binance {sym} fail: {e}'); return {}


ok = 0
for coin in COINS:
    try:
        oi = cg('/api/futures/open-interest/aggregated-history', symbol=coin, interval='4h', limit=4500)
        time.sleep(2.2)
        lq = cg('/api/futures/liquidation/aggregated-history', symbol=coin, interval='4h', limit=4500, exchange_list='Binance')
        time.sleep(2.2)
        if oi.get('code') != '0' or lq.get('code') != '0':
            print(f'  {coin}: cg error oi={oi.get("code")} lq={lq.get("code")}'); continue
        px = binance_price(coin)
        oimap = {int(d['time']): float(d['close']) for d in oi['data']}
        lqmap = {int(d['time']): (float(d['aggregated_long_liquidation_usd']), float(d['aggregated_short_liquidation_usd'])) for d in lq['data']}
        ts = sorted(set(oimap) & set(px))
        rows = []
        for t in ts:
            ll, sl = lqmap.get(t, (0.0, 0.0))
            rows.append((t, oimap[t], px[t], ll, sl))
        with open(f'{OUT}/{coin}.csv', 'w', newline='') as f:
            w = csv.writer(f); w.writerow(['time', 'oi', 'price', 'long_liq', 'short_liq']); w.writerows(rows)
        ok += 1
        print(f'  {coin}: {len(rows)} bars  (oi {len(oimap)}, px {len(px)}, liq {len(lqmap)})')
    except Exception as e:
        print(f'  {coin}: ERROR {e}')
print(f'\nwrote {ok}/{len(COINS)} coins -> {OUT}/')
