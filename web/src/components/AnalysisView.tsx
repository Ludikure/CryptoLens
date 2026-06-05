import { marked } from 'marked';
import type { FullAnalysisResponse } from '../types';
import { formatPrice, mlPct, biasClass } from '../format';

// Renders the AI analysis markdown + a compact setups table + the ML/bias summary card.
export function AnalysisView({ result }: { result: FullAnalysisResponse }) {
  const html = marked.parse(result.analysis || '', { async: false }) as string;
  return (
    <div className="analysis">
      <div className="ml-card">
        <div><span>ML Win</span><b>{mlPct(result.ml.win)}</b></div>
        <div><span>Persistence</span><b>{mlPct(result.ml.persistence)}</b></div>
        {result.ml.bigMove && (() => {
          const bm = result.ml.bigMove;
          const color = bm.bucket === 'HIGH' ? '#e5484d' : bm.bucket === 'ELEVATED' ? '#f5a623' : undefined;
          const label = bm.bucket === 'NORMAL' ? 'NORMAL' : `${bm.bucket} · ${bm.multiple.toFixed(1)}× norm`;
          return <div title="Outsized-move (≥4 ATR) risk vs the ~6.4% base rate. Rare event → shown as a relative bucket (HIGH ≈ ~2× normal odds), not a probability. Direction-agnostic.">
            <span>Big-move risk</span><b style={color ? { color } : undefined}>{label}</b></div>;
        })()}
        <div><span>Bias</span><b className={biasClass(result.bias.daily)}>{result.bias.daily}</b></div>
        <div className="muted"><span>Model</span><b>{result.model}</b></div>
      </div>

      {result.setups.length > 0 ? (
        <table className="setups">
          <thead><tr><th>Dir</th><th>Entry</th><th>Stop</th><th>TP1</th><th>TP2</th></tr></thead>
          <tbody>
            {result.setups.map((s, i) => (
              <tr key={i} className={s.direction.toUpperCase() === 'LONG' ? 'bull' : 'bear'}>
                <td>{s.direction}</td><td>{formatPrice(s.entry)}</td><td>{formatPrice(s.stopLoss)}</td>
                <td>{formatPrice(s.tp1)}</td><td>{s.tp2 != null ? formatPrice(s.tp2) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="no-setup">No trade setup — the system declined (quality/conviction gate).</div>
      )}

      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
