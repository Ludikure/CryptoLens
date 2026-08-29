import urllib.request, zipfile, io, csv, datetime as dt, time
from pathlib import Path
UA={'User-Agent':'MarketScope/1.0 (research; bmihovilovic83@gmail.com)'}
out=Path('vision_backfill/klines'); out.mkdir(parents=True,exist_ok=True)
syms=sorted(p.stem for p in Path('candlefeed/liquidations').glob('*.csv') if p.stat().st_size>100)
for sym in syms:
    f=out/f'{sym}_1h.csv'
    if f.exists() and f.stat().st_size>50000: continue
    n=0; d=dt.date(2026,5,20)
    with f.open('w',newline='') as fh:
        w=csv.writer(fh); w.writerow(['ts','open','high','low','close','volume'])
        while d<=dt.date(2026,8,21):
            url=f'https://data.binance.vision/data/futures/um/daily/klines/{sym}/1h/{sym}-1h-{d.isoformat()}.zip'
            try:
                with urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=40) as r: blob=r.read()
                with zipfile.ZipFile(io.BytesIO(blob)) as z:
                    for row in csv.reader(io.StringIO(z.read(z.namelist()[0]).decode())):
                        if not row or not row[0].isdigit(): continue
                        ts=int(row[0]); ts=ts/1000 if ts>1e11 else ts
                        w.writerow([dt.datetime.fromtimestamp(ts,dt.timezone.utc).isoformat(),row[1],row[2],row[3],row[4],row[5]]); n+=1
            except Exception: pass
            time.sleep(0.05); d+=dt.timedelta(days=1)
    print(f'{sym}: {n:,} bars', flush=True)
print('KLINES DONE', flush=True)
