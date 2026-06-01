import { useEffect, useState } from 'react';
import { getMarket } from '../api';
import type { MarketData } from '../types';
import { formatPrice, pct } from '../format';

const fmtVol = (v: number) => v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + v.toFixed(0);
const Row = ({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) => (
  <div className="mrow"><span>{k}</span><b className={cls}>{v}</b></div>
);
const fgClass = (v: number) => (v <= 25 ? 'bear' : v >= 75 ? 'bull' : '');
const lsClass = (long: number) => (long > 55 ? 'bull' : long < 45 ? 'bear' : '');

// The Market tab — raw market context for the current symbol, mirroring the iOS Market tab.
// Reads /market (the same parsed enrichment that feeds the AI analysis).
export function MarketView({ symbol }: { symbol: string }) {
  const [m, setM] = useState<MarketData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    getMarket(symbol).then(d => { if (alive) setM(d); }).catch(e => { if (alive) setErr((e as Error).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol]);

  if (loading) return <div className="status">Loading market data for {symbol}…</div>;
  if (err) return <div className="status err">Failed to load market data: {err}</div>;
  if (!m) return null;

  const d = m.derivatives, p = m.positioning, sp = m.spotPressure, s = m.sentiment, ca = m.crossAsset, mac = m.macro, fg = m.fearGreed;

  return (
    <div className="market-view">
      {fg && (
        <section className="card">
          <h2>Fear &amp; Greed</h2>
          <div className="fg"><span className={`fg-val ${fgClass(fg.value)}`}>{fg.value}</span><span className="muted">{fg.label}</span></div>
        </section>
      )}

      {d && p && (
        <section className="card">
          <h2>Derivatives Positioning</h2>
          <Row k="Funding rate" v={`${d.fundingRatePercent.toFixed(4)}%`} cls={d.fundingRatePercent > 0 ? 'bull' : d.fundingRatePercent < 0 ? 'bear' : ''} />
          <Row k="" v={<span className="muted small">{p.fundingSentiment}</span>} />
          <Row k="Open interest" v={`${fmtVol(d.openInterestUSD)}${d.oiChange24h != null ? ` (${pct(d.oiChange24h)})` : ''}`} cls="" />
          <Row k="" v={<span className="muted small">{p.oiTrend} OI</span>} />
          <Row k="Global L/S" v={`${Math.round(d.globalLongPercent)}% / ${Math.round(d.globalShortPercent)}%`} cls={lsClass(d.globalLongPercent)} />
          <Row k="" v={<span className="muted small">{p.crowding}</span>} />
          <Row k="Top traders L/S" v={`${Math.round(d.topTraderLongPercent)}% / ${Math.round(d.topTraderShortPercent)}%`} cls={lsClass(d.topTraderLongPercent)} />
          <Row k="" v={<span className="muted small">{p.smartMoneyBias}</span>} />
          <Row k="Taker buy/sell" v={d.takerBuySellRatio.toFixed(2)} cls={d.takerBuySellRatio > 1 ? 'bull' : 'bear'} />
          {p.squeezeRisk.level !== 'NONE' && <Row k="Squeeze risk" v={`${p.squeezeRisk.level} ${p.squeezeRisk.direction}`} cls="bear" />}
          {p.signals.length > 0 && (
            <div className="signals">{p.signals.map((sig, i) => <div key={i} className="sig"><span className="sig-strength">{sig.strength}</span> {sig.message}</div>)}</div>
          )}
        </section>
      )}

      {sp && (
        <section className="card">
          <h2>Spot Pressure (24h)</h2>
          <Row k="Taker buy ratio" v={`${sp.takerBuyRatio.toFixed(2)} (${sp.takerBuyLabel})`} cls={sp.takerBuyRatio > 0.55 ? 'bull' : sp.takerBuyRatio < 0.45 ? 'bear' : ''} />
          <Row k="CVD trend" v={sp.cvdTrend} cls={sp.cvdTrend === 'Rising' ? 'bull' : sp.cvdTrend === 'Falling' ? 'bear' : ''} />
          {sp.bookRatio != null && <Row k="Order book" v={`${sp.bookRatio.toFixed(2)} (${sp.bookLabel})`} cls={sp.bookRatio > 0.6 ? 'bull' : sp.bookRatio < 0.4 ? 'bear' : ''} />}
        </section>
      )}

      {s && (
        <section className="card">
          <h2>Price Performance</h2>
          {s.priceChangePercentage24h != null && <Row k="24h" v={pct(s.priceChangePercentage24h)} cls={s.priceChangePercentage24h >= 0 ? 'bull' : 'bear'} />}
          {s.priceChangePercentage7d != null && <Row k="7d" v={pct(s.priceChangePercentage7d)} cls={s.priceChangePercentage7d >= 0 ? 'bull' : 'bear'} />}
          {s.priceChangePercentage30d != null && <Row k="30d" v={pct(s.priceChangePercentage30d)} cls={s.priceChangePercentage30d >= 0 ? 'bull' : 'bear'} />}
          <Row k="From ATH" v={pct(s.athChangePercentage)} cls="bear" />
        </section>
      )}

      {ca && (
        <section className="card">
          <h2>Cross-Asset</h2>
          <div className="muted" style={{ marginBottom: 8 }}>{ca.summary}</div>
          <Row k="DXY" v={`${formatPrice(ca.dxyPrice)} (${ca.dxyTrend})`} />
          <Row k="SPY" v={`${formatPrice(ca.spyPrice)} (${ca.spyTrend})`} />
        </section>
      )}

      {mac && (
        <section className="card">
          <h2>Macro</h2>
          {mac.vix != null && <Row k="VIX" v={mac.vix.toFixed(1)} cls={mac.vix > 25 ? 'bear' : mac.vix < 15 ? 'bull' : ''} />}
          {mac.usdIndex != null && <Row k="DXY (USD index)" v={mac.usdIndex.toFixed(2)} />}
          {mac.treasury10Y != null && <Row k="10Y Treasury" v={`${mac.treasury10Y.toFixed(2)}%`} />}
          {mac.treasury2Y != null && <Row k="2Y Treasury" v={`${mac.treasury2Y.toFixed(2)}%`} />}
          {mac.yieldSpread != null && <Row k="2Y/10Y spread" v={`${mac.yieldSpread.toFixed(2)}%`} cls={mac.yieldSpread < 0 ? 'bear' : ''} />}
          {mac.fedFundsRate != null && <Row k="Fed funds" v={`${mac.fedFundsRate.toFixed(2)}%`} />}
        </section>
      )}

      {!d && !sp && !s && !ca && !fg && (mac == null) && (
        <div className="status muted">No market data available for {symbol}.</div>
      )}
      {!m.isCrypto && <div className="muted small" style={{ marginTop: 8 }}>Derivatives, spot pressure, sentiment &amp; Fear/Greed are crypto-only. Stock fundamentals are coming to the web app.</div>}
    </div>
  );
}
