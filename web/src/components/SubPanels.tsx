import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import type { IndicatorTF } from '../types';
import { priceFormatFor } from '../format';

const baseOpts = {
  layout: { background: { type: ColorType.Solid, color: '#0b0e14' }, textColor: '#9aa4b2' },
  grid: { vertLines: { color: '#141a25' }, horzLines: { color: '#141a25' } },
  rightPriceScale: { borderColor: '#1c2230' },
  timeScale: { borderColor: '#1c2230', timeVisible: true },
  crosshair: { mode: 0 as const },
  autoSize: true,
};

const sortedTimes = (candles: { time: number }[]) =>
  candles.map(c => Math.floor(c.time / 1000) as UTCTimestamp).sort((a, b) => a - b);

// Map a series onto the last N candle timestamps (series are tail-aligned with candles).
function align(times: UTCTimestamp[], series: number[]) {
  const slice = series.slice(-times.length);
  return slice
    .map((v, i) => ({ time: times[times.length - slice.length + i], value: v }))
    .filter(p => p.value != null && !isNaN(p.value));
}

// Generic sub-panel: a creation effect (chart) + a data effect (series) that fully tears down
// its series on every tf change (same lesson as the main chart — stale series pin the scale).
function Panel({ tf, draw }: { tf: IndicatorTF; draw: (chart: IChartApi, tf: IndicatorTF, times: UTCTimestamp[]) => (() => void) }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Previous draw's series-teardown. Called at the TOP of the next data effect (tf change) —
  // NOT as an effect cleanup. On unmount we only run chart.remove(), which disposes the series
  // wholesale; calling removeSeries() on an already-disposed chart throws and would black-screen
  // the app when a panel is toggled off.
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, baseOpts);
    chartRef.current = chart;
    return () => { teardownRef.current = null; try { chart.remove(); } catch { /* already gone */ } chartRef.current = null; };
  }, []);
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    if (teardownRef.current) { try { teardownRef.current(); } catch { /* ignore */ } teardownRef.current = null; }
    teardownRef.current = draw(chart, tf, sortedTimes(tf.candles));
    chart.timeScale().fitContent();
  }, [tf, draw]);
  return <div className="subpanel" ref={ref} />;
}

const drawRSI = (chart: IChartApi, tf: IndicatorTF, times: UTCTimestamp[]) => {
  const line = chart.addLineSeries({ color: '#e6c84f', lineWidth: 2, priceLineVisible: false });
  line.setData(align(times, tf.rsiSeries));
  [70, 30].forEach(l => line.createPriceLine({ price: l, color: '#2c3b4a', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: String(l) }));
  return () => chart.removeSeries(line);
};
const drawMACD = (chart: IChartApi, tf: IndicatorTF, times: UTCTimestamp[]) => {
  // Magnitude-aware format so tiny-magnitude MACD (low-priced assets like DOGE) isn't flattened
  // to a single tick by the default minMove (0.01).
  const pf = priceFormatFor([...tf.macdHistSeries, ...tf.macdLineSeries, ...tf.macdSignalSeries]);
  const hist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: pf });
  hist.setData(align(times, tf.macdHistSeries).map(p => ({ ...p, color: p.value >= 0 ? '#26a69a' : '#ef5350' })));
  const macd = chart.addLineSeries({ color: '#5b8def', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf });
  macd.setData(align(times, tf.macdLineSeries));
  const sig = chart.addLineSeries({ color: '#f0a020', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf });
  sig.setData(align(times, tf.macdSignalSeries));
  return () => { chart.removeSeries(hist); chart.removeSeries(macd); chart.removeSeries(sig); };
};
const drawStoch = (chart: IChartApi, tf: IndicatorTF, times: UTCTimestamp[]) => {
  const k = chart.addLineSeries({ color: '#22d3ee', lineWidth: 2, priceLineVisible: false });
  k.setData(align(times, tf.stochKSeries));
  const d = chart.addLineSeries({ color: '#f0a020', lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false });
  d.setData(align(times, tf.stochDSeries));
  [80, 20].forEach(l => k.createPriceLine({ price: l, color: '#2c3b4a', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: String(l) }));
  return () => { chart.removeSeries(k); chart.removeSeries(d); };
};
const drawADX = (chart: IChartApi, tf: IndicatorTF, times: UTCTimestamp[]) => {
  const adx = chart.addLineSeries({ color: '#b06be8', lineWidth: 2, priceLineVisible: false });
  adx.setData(align(times, tf.adxSeries));
  const plus = chart.addLineSeries({ color: '#26a69a', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  plus.setData(align(times, tf.plusDISeries));
  const minus = chart.addLineSeries({ color: '#ef5350', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  minus.setData(align(times, tf.minusDISeries));
  adx.createPriceLine({ price: 25, color: '#2c3b4a', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '25' });
  return () => { chart.removeSeries(adx); chart.removeSeries(plus); chart.removeSeries(minus); };
};
const drawVolume = (chart: IChartApi, tf: IndicatorTF, _times: UTCTimestamp[]) => {
  // type:'volume' → compact axis labels (40M, 1.5B) instead of "40000000.00".
  const vol = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'volume' } });
  const candles = [...tf.candles].sort((a, b) => a.time - b.time);
  vol.setData(candles.map(c => ({ time: Math.floor(c.time / 1000) as UTCTimestamp, value: c.volume, color: c.close >= c.open ? 'rgba(38,166,154,0.6)' : 'rgba(239,83,80,0.6)' })));
  return () => chart.removeSeries(vol);
};

const PANELS = [
  { key: 'rsi', label: 'RSI', draw: drawRSI },
  { key: 'macd', label: 'MACD', draw: drawMACD },
  { key: 'stoch', label: 'Stoch', draw: drawStoch },
  { key: 'adx', label: 'ADX', draw: drawADX },
  { key: 'volume', label: 'Volume', draw: drawVolume },
] as const;

const loadEnabled = (): Record<string, boolean> => {
  try { const r = localStorage.getItem('subpanels'); if (r) return JSON.parse(r); } catch { /* default */ }
  return { rsi: true, macd: true, stoch: false, adx: false, volume: true };
};

export function SubPanels({ tf }: { tf: IndicatorTF }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(loadEnabled);
  const toggle = (key: string) => {
    const next = { ...enabled, [key]: !enabled[key] };
    setEnabled(next); localStorage.setItem('subpanels', JSON.stringify(next));
  };
  return (
    <div className="subpanels">
      <div className="subpanel-toggles">
        {PANELS.map(p => (
          <button key={p.key} className={enabled[p.key] ? 'on' : ''} onClick={() => toggle(p.key)}>{p.label}</button>
        ))}
      </div>
      {PANELS.filter(p => enabled[p.key]).map(p => (
        <div className="subpanel-row" key={p.key}>
          <span className="subpanel-label">{p.label}</span>
          <Panel tf={tf} draw={p.draw} />
        </div>
      ))}
    </div>
  );
}
