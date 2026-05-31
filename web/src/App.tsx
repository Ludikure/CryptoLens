import { useEffect, useState, useCallback } from 'react';
import { getIndicators, runFullAnalysis } from './api';
import type { IndicatorsResponse, FullAnalysisResponse } from './types';
import { ChartPanel } from './components/ChartPanel';
import { SubPanels } from './components/SubPanels';
import { IndicatorTable } from './components/IndicatorTable';
import { AnalysisView } from './components/AnalysisView';
import { Dashboard } from './components/Dashboard';
import { SettingsView } from './components/SettingsView';
import { getSettings, getWatchlist, setWatchlist } from './settings';
import { formatPrice, pct, biasClass } from './format';

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
  const [view, setView] = useState<'markets' | 'scoreboard' | 'settings'>('markets');
  const [watchlist, setWatch] = useState<string[]>(() => getWatchlist());

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
    try {
      const s = getSettings();
      setAnalysis(await runFullAnalysis(symbol, { accountSize: s.accountSize, riskPercent: s.riskPercent }));
    }
    catch (e) { setAnaErr((e as Error).message); }
    finally { setAnaLoading(false); }
  };

  const inWatchlist = watchlist.includes(symbol);
  const toggleWatch = () => {
    const next = inWatchlist ? watchlist.filter(s => s !== symbol) : [...watchlist, symbol];
    setWatch(next); setWatchlist(next);
  };
  const removeFromWatch = (s: string) => { const next = watchlist.filter(x => x !== s); setWatch(next); setWatchlist(next); };

  const submit = (e: React.FormEvent) => { e.preventDefault(); const s = input.trim().toUpperCase(); if (s) setSymbol(s); };
  const daily = ind?.daily;
  const tfByKey: Record<TFKey, typeof daily | null | undefined> = { daily: ind?.daily, fourH: ind?.fourH, oneH: ind?.oneH };
  const chartTf = tfByKey[chartTF] ?? ind?.daily ?? null;

  return (
    <div className="app">
      <header>
        <h1>MarketScope</h1>
        <nav className="views">
          <button className={view === 'markets' ? 'on' : ''} onClick={() => setView('markets')}>Markets</button>
          <button className={view === 'scoreboard' ? 'on' : ''} onClick={() => setView('scoreboard')}>Scoreboard</button>
          <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}>Settings</button>
        </nav>
        {view === 'markets' && (
          <form onSubmit={submit} className="search">
            <input value={input} onChange={e => setInput(e.target.value)} placeholder="Symbol (BTCUSDT, AAPL…)" spellCheck={false} />
            <button type="submit">Load</button>
          </form>
        )}
      </header>

      {view === 'scoreboard' && <Dashboard />}
      {view === 'settings' && <SettingsView />}

      {view === 'markets' && (
      <>
      <div className="quick">
        {watchlist.map(s => (
          <span key={s} className={`pill ${s === symbol ? 'on' : ''}`}>
            <button className="pill-sym" onClick={() => { setInput(s); setSymbol(s); }}>{s}</button>
            <button className="pill-x" title="Remove" onClick={() => removeFromWatch(s)}>×</button>
          </span>
        ))}
        {!inWatchlist && <button className="pill-add" onClick={toggleWatch} title={`Add ${symbol}`}>+ {symbol}</button>}
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
      </>
      )}

      <footer>Thin client over the MarketScope Worker — indicators, ML &amp; prompt all server-side.</footer>
    </div>
  );
}
