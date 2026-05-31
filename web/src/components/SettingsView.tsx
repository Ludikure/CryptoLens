import { useState } from 'react';
import { getSettings, setSettings } from '../settings';
import { deviceId } from '../api';

// Account size + risk% feed the Worker's CANDIDATE SETUPS position sizing (riskDollars =
// accountSize × risk% ÷ 100). Persisted to localStorage; sent on each Run AI Analysis.
export function SettingsView() {
  const init = getSettings();
  const [accountSize, setAccountSize] = useState(String(init.accountSize));
  const [riskPercent, setRiskPercent] = useState(String(init.riskPercent));
  const [saved, setSaved] = useState(false);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setSettings({ accountSize: Math.max(0, +accountSize || 0), riskPercent: Math.max(0, Math.min(100, +riskPercent || 0)) });
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  };

  const acct = Math.max(0, +accountSize || 0), risk = Math.max(0, +riskPercent || 0);
  const riskDollars = acct * risk / 100;

  return (
    <div className="settings-view">
      <section className="card">
        <h2>Position Sizing</h2>
        <form onSubmit={save} className="settings-form">
          <label>Account size ($)
            <input inputMode="decimal" value={accountSize} onChange={e => setAccountSize(e.target.value)} />
          </label>
          <label>Risk per trade (%)
            <input inputMode="decimal" value={riskPercent} onChange={e => setRiskPercent(e.target.value)} />
          </label>
          <div className="derived muted">
            Risk budget per trade: <b>${riskDollars.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b>
            {' '}— sent to the analysis so suggested position sizes match your plan.
          </div>
          <button type="submit">Save</button>
          {saved && <span className="bull">Saved ✓</span>}
        </form>
      </section>

      <section className="card">
        <h2>Device</h2>
        <div className="muted small">Device ID: <code>{deviceId()}</code></div>
        <div className="muted small">Settings + watchlist are stored locally in this browser.</div>
      </section>
    </div>
  );
}
