import { useEffect, useState } from 'react';
import { getDirectionAccuracy, getMlCalibration } from '../api';
import type { DirectionAccuracy, MlCalibration } from '../types';

const acc = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1) + '%');
const dirLabel = (d: number) => (d === 1 ? 'LONG' : d === -1 ? 'SHORT' : '—');

// Live scoreboards — both endpoints are universe-wide + forward, accumulating from the cron
// whether or not anyone opens the app. The direction model's frozen-holdout baseline is 94.7%.
export function Dashboard() {
  const [dir, setDir] = useState<DirectionAccuracy | null>(null);
  const [cal, setCal] = useState<MlCalibration | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const [d, c] = await Promise.all([getDirectionAccuracy(), getMlCalibration()]);
        if (!alive) return; setDir(d); setCal(c);
      } catch (e) { if (alive) setErr((e as Error).message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) return <div className="status">Loading scoreboards…</div>;
  if (err) return <div className="status err">Failed to load scoreboards: {err}</div>;

  return (
    <div className="dashboard">
      {/* Direction model */}
      <section className="card">
        <h2>Direction Model — Live (crypto)</h2>
        {dir && dir.overall.resolved > 0 ? (
          <>
            <div className="big-stats">
              <div><span>Accuracy</span><b>{acc(dir.overall.accuracy)}</b></div>
              <div><span>Backtest baseline</span><b className="muted">{dir.backtestBaseline}%</b></div>
              <div><span>Resolved</span><b>{dir.overall.resolved}</b></div>
              <div><span>Pending</span><b className="muted">{dir.pending}</b></div>
              <div><span>L / S</span><b>{dir.overall.longs ?? 0} / {dir.overall.shorts ?? 0}</b></div>
            </div>

            {dir.byConfidence.length > 0 && (
              <table className="grid">
                <thead><tr><th>Confidence (pUp)</th><th>N</th><th>Accuracy</th></tr></thead>
                <tbody>{dir.byConfidence.map(b => (
                  <tr key={b.band}><td>{b.band}</td><td>{b.n}</td><td>{acc(b.accuracy)}</td></tr>
                ))}</tbody>
              </table>
            )}

            {dir.byDirection.length > 0 && (
              <table className="grid">
                <thead><tr><th>Side</th><th>N</th><th>Accuracy</th></tr></thead>
                <tbody>{dir.byDirection.map(b => (
                  <tr key={b.predicted_dir}><td>{dirLabel(b.predicted_dir)}</td><td>{b.n}</td><td>{acc(b.accuracy)}</td></tr>
                ))}</tbody>
              </table>
            )}

            {dir.bySymbol.length > 0 && (
              <table className="grid">
                <thead><tr><th>Symbol</th><th>N</th><th>Acc</th><th>L (✓)</th><th>S (✓)</th></tr></thead>
                <tbody>{dir.bySymbol.slice(0, 12).map(s => (
                  <tr key={s.symbol}>
                    <td>{s.symbol}</td><td>{s.n}</td><td>{acc(s.accuracy)}</td>
                    <td>{s.longs} ({s.long_correct})</td><td>{s.shorts} ({s.short_correct})</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </>
        ) : (
          <div className="muted">No resolved direction signals yet ({dir?.pending ?? 0} pending). Signals fire when ML ≥ 70% AND pUp ≥ 70% / ≤ 30%, and grade 24h later.</div>
        )}
      </section>

      {/* ML calibration */}
      <section className="card">
        <h2>ML Quality Calibration</h2>
        {cal && cal.buckets.length > 0 ? (
          <table className="grid">
            <thead><tr><th>Bucket</th><th>N</th><th>Predicted</th><th>Realized</th><th>Δ</th></tr></thead>
            <tbody>{cal.buckets.map(b => {
              const delta = b.realized - b.predicted;
              return (
                <tr key={b.bucket}>
                  <td>{b.bucket}</td><td>{b.n}</td><td>{b.predicted.toFixed(0)}%</td><td>{b.realized.toFixed(0)}%</td>
                  <td className={Math.abs(delta) <= 5 ? 'bull' : 'bear'}>{(delta >= 0 ? '+' : '') + delta.toFixed(0)}pp</td>
                </tr>
              );
            })}</tbody>
          </table>
        ) : (
          <div className="muted">No resolved calibration samples yet ({cal?.pending ?? 0} pending). Each symbol's ML Win is sampled ~once/20h and graded against realized goodR 24h later.</div>
        )}
        <p className="muted small">Realized within ±5pp of predicted = the quality model is still honest in the wild. Larger gaps = drift.</p>
      </section>
    </div>
  );
}
