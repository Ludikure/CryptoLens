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
        {result.ml.directionUp != null && <div><span>P(up 24h)</span><b>{mlPct(result.ml.directionUp)}</b></div>}
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
