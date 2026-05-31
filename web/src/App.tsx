import { useEffect, useState, useCallback } from 'react';
import { getIndicators, runFullAnalysis } from './api';
import type { IndicatorsResponse, FullAnalysisResponse } from './types';
import { ChartPanel } from './components/ChartPanel';
import { SubPanels } from './components/SubPanels';
import { IndicatorTable } from './components/IndicatorTable';
import { AnalysisView } from './components/AnalysisView';
import { formatPrice, pct, biasClass } from './format';

const QUICK = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AAPL', 'NVDA', 'TSLA'];
type TFKey = 'daily' | 'fourH' | 'oneH';
const TF_LABELS: Record<TFKey, string> = { daily: 'Daily', fourH: '4H', oneH: '1H' };

export function App() {
  const [symbol, setSymbol] = useState(() => localStorage.getItem('last_symbol') || 'BTCUSDT');
  const [input, setInput] = useState(symbol);
  const [ind, setInd] = useState<IndicatorsResponse | null>(null);
  const [indErr, setIndErr] = useState<string | null>(null);
  const [indLoading, setIndLoading] = useState(false);
  const [analysis, setAnalysis] = useState<FullAnalysisResponse | null>(null);
  const [anaErr, setAnaErr] = useState<string | null>(null);
  const [anaLoading, setAnaLoading] = useState(false);
  const [chartTF, setChartTF] = useState<TFKey>('daily');

  const load = useCallback(async (sym: string) => {
    setIndLoading(true); setIndErr(null); setAnalysis(null); setAnaErr(null);
    try {
      const data = await getIndicators(sym);
      if (data.error) throw new Error(data.error);
      setInd(data);
      localStorage.setItem('last_symbol', sym);
    } catch (e) { setIndErr((e as Error).message); setInd(null); }
    finally { setIndLoading(false); }
  }, []);

  useEffect(() => { load(symbol); }, [symbol, load]);

  const analyze = async () => {
    setAnaLoading(true); setAnaErr(null);
    try { setAnalysis(await runFullAnalysis(symbol)); }
    catch (e) { setAnaErr((e as Error).message); }
    finally { setAnaLoading(false); }
  };

  const submit = (e: React.FormEvent) => { e.preventDefault(); const s = input.trim().toUpperCase(); if (s) setSymbol(s); };
  const daily = ind?.daily;
  const tfByKey: Record<TFKey, typeof daily | null | undefined> = { daily: ind?.daily, fourH: ind?.fourH, oneH: ind?.oneH };
  const chartTf = tfByKey[chartTF] ?? ind?.daily ?? null;

  return (
    <div className="app">
      <header>
        <h1>MarketScope</h1>
        <form onSubmit={submit} className="search">
          <input value={input} onChange={e => setInput(e.target.value)} placeholder="Symbol (BTCUSDT, AAPL…)" spellCheck={false} />
          <button type="submit">Load</button>
        </form>
      </header>

      <div className="quick">
        {QUICK.map(s => <button key={s} className={s === symbol ? 'on' : ''} onClick={() => { setInput(s); setSymbol(s); }}>{s}</button>)}
      </div>

      {indLoading && <div className="status">Loading {symbol}…</div>}
      {indErr && <div className="status err">Failed to load {symbol}: {indErr}</div>}

      {daily && (
        <>
          <div className="price-header">
            <div className="sym">{ind!.symbol}</div>
            <div className="px">{formatPrice(daily.price)}</div>
            <div className={`tag ${biasClass(daily.bias)}`}>{daily.bias}</div>
            {daily.atrPercentile != null && <div className="tag muted">ATR {Math.round(daily.atrPercentile)}%</div>}
            <div className="tag muted">{daily.bullPercent != null ? pct(daily.bullPercent - 50, 0) + ' tilt' : ''}</div>
          </div>

          <div className="tf-bar">
            {(Object.keys(TF_LABELS) as TFKey[]).map(k => (
              <button key={k} className={k === chartTF ? 'on' : ''} disabled={!tfByKey[k]} onClick={() => setChartTF(k)}>{TF_LABELS[k]}</button>
            ))}
          </div>

          {chartTf && <ChartPanel tf={chartTf} setup={analysis?.setups?.[0] ?? null} />}
          {chartTf && <SubPanels tf={chartTf} />}

          <IndicatorTable daily={daily} fourH={ind!.fourH} oneH={ind!.oneH} />

          <div className="analyze-bar">
            <button className="run" disabled={anaLoading} onClick={analyze}>
              {anaLoading ? 'Analyzing… (LLM, ~10s)' : 'Run AI Analysis'}
            </button>
            {anaErr && <span className="err">{anaErr}</span>}
          </div>

          {analysis && <AnalysisView result={analysis} />}
        </>
      )}

      <footer>Thin client over the MarketScope Worker — indicators, ML &amp; prompt all server-side.</footer>
    </div>
  );
}
