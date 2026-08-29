import { useState } from 'react';
import { getCorrelation, type CorrelationResponse } from '../api';
import { getWatchlist } from '../settings';

// Phase 7 — portfolio correlation / concentration risk. 90d daily-return correlations across
// your crypto watchlist → effective independent positions + β to BTC. "Your alts are all just BTC."
export function CorrelationView() {
  const crypto = getWatchlist().filter(s => s.endsWith('USDT'));
  const [res, setRes] = useState<CorrelationResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true); setErr(null);
    try { setRes(await getCorrelation(crypto)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed'); }
    finally { setLoading(false); }
  };

  const cell = (v: number) => {
    const a = Math.abs(v);
    const bg = a >= 0.8 ? 'rgba(229,72,77,0.25)' : a >= 0.5 ? 'rgba(245,166,35,0.18)' : 'transparent';
    return { background: bg };
  };
  return (
    <div className="risk-calc">
      <h3>Portfolio Correlation</h3>
      {crypto.length < 2
        ? <p className="muted">Add ≥2 crypto symbols (USDT) to your watchlist to see concentration risk.</p>
        : <button onClick={run} disabled={loading}>{loading ? '…' : `Analyze ${crypto.length} crypto`}</button>}
      {err && <div className="risk-err">{err}</div>}
      {res && (
        <>
          <div className="risk-out" style={{ margin: '12px 0' }}>
            <div className="risk-row"><span>Effective positions</span>
              <b className={res.effectivePositions < res.symbols.length * 0.5 ? 'bad' : 'warn'}>
                {res.effectivePositions} <span className="muted">of {res.symbols.length}</span></b>
              <span className="muted">independent bets — the rest is the same trade</span></div>
            <div className="risk-row"><span>Avg corr to {res.benchmark.replace('USDT', '')}</span>
              <b className={res.avgCorrToBenchmark > 0.8 ? 'bad' : res.avgCorrToBenchmark > 0.5 ? 'warn' : 'good'}>
                {res.avgCorrToBenchmark.toFixed(2)}</b>
              <span className="muted">90d daily returns</span></div>
          </div>
          <table className="corr-matrix">
            <thead><tr><th></th>{res.symbols.map(s => <th key={s}>{s.replace('USDT', '')}</th>)}<th>β</th></tr></thead>
            <tbody>
              {res.symbols.map((s, i) => (
                <tr key={s}>
                  <th>{s.replace('USDT', '')}</th>
                  {res.matrix[i].map((v, j) => <td key={j} style={cell(v)}>{v.toFixed(2)}</td>)}
                  <td className="muted">{res.betaToBenchmark[s]?.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="risk-note muted">Crypto-only (USDT). Aggregate risk ≈ your largest position × effective-positions, not the sum of per-position numbers.</p>
    </div>
  );
}
