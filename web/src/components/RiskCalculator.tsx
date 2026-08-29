import { useState } from 'react';
import { getRisk, type RiskResponse } from '../api';
import { getSettings } from '../settings';
import { formatPrice } from '../format';

// Phase 2+3 position-risk calculator. Direction-agnostic: you supply a position, it tells you
// stop quality (noise-hit), VaR/ES (fat-tail), liquidation distance, and fee breakeven — all
// off the live HAR-RV σ. Account size comes from Settings.
export function RiskCalculator({ symbol }: { symbol: string }) {
  const acct = getSettings().accountSize || 0;
  const [stop, setStop] = useState('');
  const [entry, setEntry] = useState('');
  const [leverage, setLeverage] = useState('4');
  const [dir, setDir] = useState<'long' | 'short'>('long');
  const [venue, setVenue] = useState('coinbase_intx');
  const [size, setSize] = useState(String(acct));
  const [res, setRes] = useState<RiskResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true); setErr(null);
    try {
      setRes(await getRisk(symbol, {
        entry: +entry || undefined, stop: +stop || undefined, size: +size || undefined,
        leverage: +leverage || undefined, dir, venue,
      }));
    } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); }
    finally { setLoading(false); }
  };

  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const rk = res?.risk;
  return (
    <div className="risk-calc">
      <h3>Position Risk — {symbol}</h3>
      <div className="risk-inputs">
        <label>Entry <input inputMode="decimal" placeholder="live" value={entry} onChange={e => setEntry(e.target.value)} /></label>
        <label>Stop <input inputMode="decimal" placeholder="price" value={stop} onChange={e => setStop(e.target.value)} /></label>
        <label>Size $ <input inputMode="decimal" value={size} onChange={e => setSize(e.target.value)} /></label>
        <label>Leverage <input inputMode="decimal" value={leverage} onChange={e => setLeverage(e.target.value)} /></label>
        <label>Dir
          <select value={dir} onChange={e => setDir(e.target.value as 'long' | 'short')}>
            <option value="long">Long</option><option value="short">Short</option>
          </select>
        </label>
        <label>Venue
          <select value={venue} onChange={e => setVenue(e.target.value)}>
            <option value="coinbase_intx">Coinbase Intro-1</option>
            <option value="binance">Binance</option>
            <option value="coinbase_adv">Coinbase Adv</option>
            <option value="robinhood">Robinhood</option>
          </select>
        </label>
        <button onClick={run} disabled={loading}>{loading ? '…' : 'Calculate'}</button>
      </div>
      {err && <div className="risk-err">{err}</div>}
      {res && rk && (
        <div className="risk-out">
          <div className="risk-row"><span>Expected 24h range</span>
            <b>{formatPrice(res.range.s1[0])}–{formatPrice(res.range.s1[1])}</b>
            <span className="muted">1σ · σ {(res.range.sigma * 100).toFixed(1)}%</span></div>
          {rk.stop && <div className="risk-row"><span>Stop quality</span>
            <b className={rk.stop.rating === 'TIGHT' ? 'bad' : rk.stop.rating === 'OK' ? 'warn' : 'good'}>
              {pct(rk.stop.noiseHit)} noise-hit · {rk.stop.rating}</b>
            <span className="muted">{rk.stop.distSigma.toFixed(2)}σ away</span></div>}
          <div className="risk-row"><span>VaR (95%, 24h)</span>
            <b>{formatPrice(rk.var.var95emp)}</b>
            <span className="muted">fat-tail · gaussian {formatPrice(rk.var.var95)} · ES {formatPrice(rk.var.es95)}</span></div>
          <div className="risk-row"><span>VaR (99%)</span><b>{formatPrice(rk.var.var99emp)}</b>
            <span className="muted">empirical tail</span></div>
          {rk.liq && <div className="risk-row"><span>Liquidation</span>
            <b className={rk.liq.sigmaMult < 3 ? 'bad' : rk.liq.sigmaMult < 6 ? 'warn' : 'good'}>{formatPrice(rk.liq.liqPrice)}</b>
            <span className="muted">{rk.liq.sigmaMult.toFixed(1)}σ away</span></div>}
          {rk.fees && <div className="risk-row"><span>Breakeven move</span>
            <b>{(rk.fees.roundTrip * 100).toFixed(2)}%</b>
            <span className="muted">{rk.fees.label} round-trip</span></div>}
        </div>
      )}
      <p className="risk-note muted">Direction-agnostic — you choose the side; this is the risk on it. All figures from the live volatility forecast.</p>
    </div>
  );
}
