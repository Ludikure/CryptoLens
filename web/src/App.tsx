import { useEffect, useState, useCallback } from 'react';
import { getIndicators, runFullAnalysis, getMlPredict } from './api';
import type { IndicatorsResponse, FullAnalysisResponse, MlPredict } from './types';
import { ChartPanel } from './components/ChartPanel';
import { SubPanels } from './components/SubPanels';
import { IndicatorTable } from './components/IndicatorTable';
import { AnalysisView } from './components/AnalysisView';
import { RiskCalculator } from './components/RiskCalculator';
import { Dashboard } from './components/Dashboard';
import { SettingsView } from './components/SettingsView';
import { MarketView } from './components/MarketView';
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
  const [ml, setMl] = useState<MlPredict | null>(null);
  const [analysis, setAnalysis] = useState<FullAnalysisResponse | null>(null);
  const [anaErr, setAnaErr] = useState<string | null>(null);
  const [anaLoading, setAnaLoading] = useState(false);
  const [chartTF, setChartTF] = useState<TFKey>('daily');
  const [view, setView] = useState<'chart' | 'market' | 'risk' | 'scoreboard' | 'settings'>('chart');
  const [watchlist, setWatch] = useState<string[]>(() => getWatchlist());

  const load = useCallback(async (sym: string) => {
    setIndLoading(true); setIndErr(null); setAnalysis(null); setAnaErr(null); setMl(null);
    try {
      const data = await getIndicators(sym);
      if (data.error) throw new Error(data.error);
      setInd(data);
      localStorage.setItem('last_symbol', sym);
      // ML is cron-cached separately (best-effort; null when no cron has scored this symbol).
      getMlPredict(sym).then(m => { if (m && m.symbol === sym) setMl(m); }).catch(() => {});
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
          <button className={view === 'chart' ? 'on' : ''} onClick={() => setView('chart')}>Chart</button>
          <button className={view === 'market' ? 'on' : ''} onClick={() => setView('market')}>Market</button>
          <button className={view === 'risk' ? 'on' : ''} onClick={() => setView('risk')}>Risk</button>
          <button className={view === 'scoreboard' ? 'on' : ''} onClick={() => setView('scoreboard')}>Scoreboard</button>
          <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}>Settings</button>
        </nav>
        {(view === 'chart' || view === 'market' || view === 'risk') && (
          <form onSubmit={submit} className="search">
            <input value={input} onChange={e => setInput(e.target.value)} placeholder="Symbol (BTCUSDT, AAPL…)" spellCheck={false} />
            <button type="submit">Load</button>
          </form>
        )}
      </header>

      {view === 'scoreboard' && <Dashboard />}
      {view === 'settings' && <SettingsView />}

      {(view === 'chart' || view === 'market' || view === 'risk') && (
      <div className="quick">
        {watchlist.map(s => (
          <span key={s} className={`pill ${s === symbol ? 'on' : ''}`}>
            <button className="pill-sym" onClick={() => { setInput(s); setSymbol(s); }}>{s}</button>
            <button className="pill-x" title="Remove" onClick={() => removeFromWatch(s)}>×</button>
          </span>
        ))}
        {!inWatchlist && <button className="pill-add" onClick={toggleWatch} title={`Add ${symbol}`}>+ {symbol}</button>}
      </div>
      )}

      {view === 'market' && <MarketView symbol={symbol} />}
      {view === 'risk' && <RiskCalculator symbol={symbol} />}

      {view === 'chart' && (
      <>
      {indLoading && <div className="status">Loading {symbol}…</div>}
      {indErr && <div className="status err">Failed to load {symbol}: {indErr}</div>}

      {daily && (
        <>
          <div className="price-header">
            <div className="sym">{ind!.symbol}</div>
            <div className="px">{formatPrice(ind!.livePrice ?? daily.price)}</div>
            <div className={`tag ${biasClass(daily.bias)}`}>{daily.bias}</div>
            {daily.atrPercentile != null && <div className="tag muted">ATR {Math.round(daily.atrPercentile)}%</div>}
            {ml && <div className={`tag ml ${ml.probability >= 0.6 ? 'bull' : ml.probability >= 0.5 ? '' : 'bear'}`}>ML {Math.round(ml.probability * 100)}%</div>}
            {ml?.probabilityH72 != null && <div className="tag muted">72h {Math.round(ml.probabilityH72 * 100)}%</div>}
            {/* Direction tag removed: the pUp head was a data-leak artifact (~chance on clean data).
                ML is a volatility signal, not a directional one. The Scoreboard keeps the live
                track record as the evidence. */}
            <div className="tag muted">{daily.bullPercent != null ? pct(daily.bullPercent - 50, 0) + ' tilt' : ''}</div>
            <button className="refresh" onClick={() => load(symbol)} disabled={indLoading} title="Refresh data">↻</button>
            {ind!.timestamp && <span className="updated muted">as of {new Date(ind!.timestamp).toLocaleTimeString()}</span>}
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
