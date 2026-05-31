import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineStyle, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import type { IndicatorTF } from '../types';

const baseOpts = {
  layout: { background: { type: ColorType.Solid, color: '#0b0e14' }, textColor: '#9aa4b2' },
  grid: { vertLines: { color: '#141a25' }, horzLines: { color: '#141a25' } },
  rightPriceScale: { borderColor: '#1c2230' },
  timeScale: { borderColor: '#1c2230', timeVisible: true },
  crosshair: { mode: 0 as const },
  autoSize: true,
};

// Map a series onto the last N candle timestamps (series are tail-aligned with candles).
function alignTimes(candles: { time: number }[], series: number[]) {
  const times = candles.map(c => Math.floor(c.time / 1000) as UTCTimestamp).sort((a, b) => a - b);
  const slice = series.slice(-times.length);
  return slice
    .map((v, i) => ({ time: times[times.length - slice.length + i], value: v }))
    .filter(p => p.value != null && !isNaN(p.value));
}

function RSIPanel({ tf }: { tf: IndicatorTF }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, baseOpts);
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const line = chart.addLineSeries({ color: '#e6c84f', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    line.setData(alignTimes(tf.candles, tf.rsiSeries));
    [70, 30].forEach(lvl => line.createPriceLine({ price: lvl, color: '#2c3b4a', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: String(lvl) }));
    chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: { top: 0.1, bottom: 0.1 } });
    chart.timeScale().fitContent();
    return () => { chart.removeSeries(line); };
  }, [tf]);
  return <div className="subpanel" ref={ref} />;
}

function MACDPanel({ tf }: { tf: IndicatorTF }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, baseOpts);
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const hist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    hist.setData(alignTimes(tf.candles, tf.macdHistSeries).map(p => ({ ...p, color: p.value >= 0 ? '#26a69a' : '#ef5350' })));
    const macdLine = chart.addLineSeries({ color: '#5b8def', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    macdLine.setData(alignTimes(tf.candles, tf.macdLineSeries));
    const sigLine = chart.addLineSeries({ color: '#f0a020', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    sigLine.setData(alignTimes(tf.candles, tf.macdSignalSeries));
    chart.timeScale().fitContent();
    return () => { chart.removeSeries(hist); chart.removeSeries(macdLine); chart.removeSeries(sigLine); };
  }, [tf]);
  return <div className="subpanel" ref={ref} />;
}

export function SubPanels({ tf }: { tf: IndicatorTF }) {
  return (
    <div className="subpanels">
      <div className="subpanel-row"><span className="subpanel-label">RSI</span><RSIPanel tf={tf} /></div>
      <div className="subpanel-row"><span className="subpanel-label">MACD</span><MACDPanel tf={tf} /></div>
    </div>
  );
}
