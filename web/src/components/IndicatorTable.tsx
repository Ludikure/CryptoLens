import type { IndicatorTF } from '../types';
import { formatPrice, biasClass } from '../format';

// Per-timeframe indicator snapshot (Daily / 4H / 1H) — mirrors the iOS IndicatorTableView.
const f1 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1));
const f2 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2));

function Col({ tf }: { tf: IndicatorTF | null }) {
  if (!tf) return <td className="muted">—</td>;
  return (
    <td>
      <div className={`bias ${biasClass(tf.bias)}`}>{tf.bias}</div>
      <div className="rows">
        <span>Price</span><b>{formatPrice(tf.price)}</b>
        <span>RSI</span><b>{f1(tf.rsi)}</b>
        <span>Stoch K/D</span><b>{tf.stochRSI ? `${f1(tf.stochRSI.k)}/${f1(tf.stochRSI.d)}` : '—'}</b>
        <span>ADX</span><b>{tf.adx ? `${f1(tf.adx.adx)} ${tf.adx.adx >= 20 ? tf.adx.direction : ''}` : '—'}</b>
        <span>MACD hist</span><b>{f2(tf.macd?.histogram)}</b>
        <span>BB %B</span><b>{tf.bollingerBands ? f2(tf.bollingerBands.percentB) + (tf.bollingerBands.squeeze ? ' ⊟' : '') : '—'}</b>
        <span>ATR%</span><b>{tf.atr ? f2(tf.atr.atrPercent) : '—'}</b>
        <span>EMA20</span><b>{formatPrice(tf.ema20)}</b>
        <span>VWAP</span><b>{formatPrice(tf.vwap)}</b>
        <span>Vol×</span><b>{f2(tf.volumeRatio)}</b>
      </div>
    </td>
  );
}

export function IndicatorTable({ daily, fourH, oneH }: { daily: IndicatorTF; fourH: IndicatorTF | null; oneH: IndicatorTF | null }) {
  return (
    <table className="indicators">
      <thead><tr><th>Daily</th><th>4H</th><th>1H</th></tr></thead>
      <tbody><tr><Col tf={daily} /><Col tf={fourH} /><Col tf={oneH} /></tr></tbody>
    </table>
  );
}
