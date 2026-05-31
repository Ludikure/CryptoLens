import { useEffect, useRef } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { IndicatorTF, TradeSetup } from '../types';

// Candlestick chart with EMA overlays + S/R and setup price lines. The hard pan/zoom/crosshair
// work comes from lightweight-charts (the reason we picked it over rebuilding the iOS Canvas).
export function ChartPanel({ tf, setup }: { tf: IndicatorTF; setup?: TradeSetup | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: '#0b0e14' }, textColor: '#9aa4b2' },
      grid: { vertLines: { color: '#1c2230' }, horzLines: { color: '#1c2230' } },
      rightPriceScale: { borderColor: '#1c2230' },
      timeScale: { borderColor: '#1c2230', timeVisible: true },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    chartRef.current = chart;
    candleRef.current = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    return () => { chart.remove(); chartRef.current = null; candleRef.current = null; };
  }, []);

  useEffect(() => {
    const chart = chartRef.current, candle = candleRef.current;
    if (!chart || !candle) return;

    const data = tf.candles
      .map(c => ({ time: Math.floor(c.time / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
      .sort((a, b) => a.time - b.time);
    candle.setData(data);

    // EMA overlays aligned to the right edge of the candle window.
    const overlays: ISeriesApi<'Line'>[] = [];
    const addEMA = (series: number[], color: string) => {
      if (!series?.length) return;
      const slice = series.slice(-data.length);
      const pts = slice.map((v, i) => ({ time: data[data.length - slice.length + i].time, value: v }))
        .filter(p => p.value != null && !isNaN(p.value));
      if (!pts.length) return;
      const ls = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      ls.setData(pts);
      overlays.push(ls);
    };
    addEMA(tf.ema20Series, '#5b8def');
    addEMA(tf.ema50Series, '#f0a020');
    addEMA(tf.ema200Series, '#b06be8');

    // S/R + setup price lines on the candle series.
    const lines = [
      ...tf.supportResistance.supports.slice(0, 3).map(p => ({ price: p, color: '#3f6f5f', title: 'S' })),
      ...tf.supportResistance.resistances.slice(0, 3).map(p => ({ price: p, color: '#6f3f4a', title: 'R' })),
    ];
    if (setup) {
      lines.push({ price: setup.entry, color: '#22d3ee', title: 'Entry' });
      lines.push({ price: setup.stopLoss, color: '#ef5350', title: 'SL' });
      lines.push({ price: setup.tp1, color: '#26a69a', title: 'TP1' });
      if (setup.tp2 != null) lines.push({ price: setup.tp2, color: '#26a69a', title: 'TP2' });
    }
    const priceLines = lines.map(l => candle.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.title }));
    chart.timeScale().fitContent();

    return () => { priceLines.forEach(pl => candle.removePriceLine(pl)); overlays.forEach(o => chart.removeSeries(o)); };
  }, [tf, setup]);

  return <div className="chart" ref={ref} />;
}
