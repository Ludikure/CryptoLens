import { useState } from 'react';
import { getSettings } from '../settings';

// Phase 6 — Survival analytics. Monte Carlo over a trading strategy's own stats (win rate,
// R-multiples, risk %, cadence) → drawdown distribution, loss-streak odds, risk of ruin,
// fractional Kelly. Answers "what would my account actually do" BEFORE capital moves. Runs
// 10k paths in-browser instantly. Direction-agnostic, symbol-agnostic — it's about survival.

interface Result {
  ddP50: number; ddP90: number; ddP99: number;
  finalP50: number; finalP10: number; finalP90: number;
  ruin: number;                          // P(drawdown >= ruinThreshold)
  streak: { k: number; p: number }[];    // P(>= k consecutive losses) over the horizon
  expectancyR: number; kelly: number;
}

function simulate(winRate: number, avgWin: number, avgLoss: number, riskFrac: number,
                  tradesPerMonth: number, months: number, ruinDD: number): Result {
  const N = 10000, T = Math.max(1, Math.round(tradesPerMonth * months));
  const p = winRate, q = 1 - p, b = avgWin / Math.max(1e-9, avgLoss);
  const expectancyR = p * avgWin - q * avgLoss;
  const kelly = b > 0 ? (b * p - q) / b : 0;
  const dds: number[] = [], finals: number[] = [];
  let ruinCount = 0;
  const streakKs = [5, 8, 10, 12];
  const streakHit = streakKs.map(() => 0);
  for (let i = 0; i < N; i++) {
    let eq = 1, peak = 1, maxDD = 0, run = 0, maxRun = 0;
    for (let t = 0; t < T; t++) {
      const win = Math.random() < p;
      eq *= 1 + (win ? avgWin : -avgLoss) * riskFrac;
      if (win) run = 0; else { run++; if (run > maxRun) maxRun = run; }
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak; if (dd > maxDD) maxDD = dd;
    }
    dds.push(maxDD); finals.push(eq);
    if (maxDD >= ruinDD) ruinCount++;
    streakKs.forEach((k, j) => { if (maxRun >= k) streakHit[j]++; });
  }
  dds.sort((a, b) => a - b); finals.sort((a, b) => a - b);
  const q_ = (arr: number[], x: number) => arr[Math.min(arr.length - 1, Math.floor(x * arr.length))];
  return {
    ddP50: q_(dds, .5), ddP90: q_(dds, .9), ddP99: q_(dds, .99),
    finalP50: q_(finals, .5), finalP10: q_(finals, .1), finalP90: q_(finals, .9),
    ruin: ruinCount / N,
    streak: streakKs.map((k, j) => ({ k, p: streakHit[j] / N })),
    expectancyR, kelly,
  };
}

export function StressTest() {
  const acct = getSettings().accountSize || 25000;
  const [winRate, setWinRate] = useState('45');
  const [avgWin, setAvgWin] = useState('1.8');
  const [avgLoss, setAvgLoss] = useState('1.0');
  const [risk, setRisk] = useState('2');
  const [tpm, setTpm] = useState('20');
  const [months, setMonths] = useState('12');
  const [res, setRes] = useState<Result | null>(null);

  const run = () => setRes(simulate(
    (+winRate || 0) / 100, +avgWin || 0, +avgLoss || 1, (+risk || 0) / 100,
    +tpm || 0, +months || 12, 0.5));

  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const usd = (mult: number) => `$${Math.round(acct * mult).toLocaleString()}`;
  return (
    <div className="risk-calc">
      <h3>Strategy Stress Test</h3>
      <div className="risk-inputs">
        <label>Win rate % <input inputMode="decimal" value={winRate} onChange={e => setWinRate(e.target.value)} /></label>
        <label>Avg win (R) <input inputMode="decimal" value={avgWin} onChange={e => setAvgWin(e.target.value)} /></label>
        <label>Avg loss (R) <input inputMode="decimal" value={avgLoss} onChange={e => setAvgLoss(e.target.value)} /></label>
        <label>Risk %/trade <input inputMode="decimal" value={risk} onChange={e => setRisk(e.target.value)} /></label>
        <label>Trades/mo <input inputMode="decimal" value={tpm} onChange={e => setTpm(e.target.value)} /></label>
        <label>Months <input inputMode="decimal" value={months} onChange={e => setMonths(e.target.value)} /></label>
        <button onClick={run}>Run 10k</button>
      </div>
      {res && (
        <div className="risk-out">
          <div className="risk-row"><span>Expectancy</span>
            <b className={res.expectancyR > 0 ? 'good' : 'bad'}>{res.expectancyR >= 0 ? '+' : ''}{res.expectancyR.toFixed(3)} R/trade</b>
            <span className="muted">{res.expectancyR > 0 ? 'positive edge' : 'negative — loses long-run'}</span></div>
          <div className="risk-row"><span>Max drawdown</span>
            <b className={res.ddP90 > 0.4 ? 'bad' : res.ddP90 > 0.25 ? 'warn' : 'good'}>{pct(res.ddP50)} typical</b>
            <span className="muted">p90 {pct(res.ddP90)} · p99 {pct(res.ddP99)} (12mo)</span></div>
          <div className="risk-row"><span>Risk of ruin</span>
            <b className={res.ruin > 0.05 ? 'bad' : res.ruin > 0.01 ? 'warn' : 'good'}>{pct(res.ruin)}</b>
            <span className="muted">P(≥50% drawdown)</span></div>
          <div className="risk-row"><span>Final equity</span>
            <b>{usd(res.finalP50)}</b>
            <span className="muted">p10 {usd(res.finalP10)} · p90 {usd(res.finalP90)} (from ${acct.toLocaleString()})</span></div>
          {res.streak.map(s => s.p > 0.01 && (
            <div className="risk-row" key={s.k}><span>{s.k}-loss streak</span>
              <b className={s.p > 0.5 ? 'warn' : ''}>{pct(s.p)}</b>
              <span className="muted">at least once in the year</span></div>
          ))}
          <div className="risk-row"><span>Kelly sizing</span>
            <b>{pct(Math.max(0, res.kelly))} full</b>
            <span className="muted">¼-Kelly {pct(Math.max(0, res.kelly) / 4)} · ½-Kelly {pct(Math.max(0, res.kelly) / 2)} (use fractional)</span></div>
        </div>
      )}
      <p className="risk-note muted">Pull win rate / R-multiples from your tracked outcomes once you have ≥30; manual estimates until then. 10k Monte Carlo paths, fixed-fractional sizing.</p>
    </div>
  );
}
