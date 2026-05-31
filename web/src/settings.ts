// Local persistence for user settings + watchlist (localStorage). Account size + risk feed the
// Worker's CANDIDATE SETUPS position sizing; the watchlist replaces the hardcoded quick-picks.

export interface Settings { accountSize: number; riskPercent: number; }

const DEFAULT_SETTINGS: Settings = { accountSize: 25000, riskPercent: 2 };
const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AAPL', 'NVDA', 'TSLA'];

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem('settings');
    if (raw) { const s = JSON.parse(raw); return { accountSize: +s.accountSize || 0, riskPercent: +s.riskPercent || 0 }; }
  } catch { /* fall through */ }
  return { ...DEFAULT_SETTINGS };
}
export function setSettings(s: Settings) { localStorage.setItem('settings', JSON.stringify(s)); }

export function getWatchlist(): string[] {
  try {
    const raw = localStorage.getItem('watchlist');
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a; }
  } catch { /* fall through */ }
  return [...DEFAULT_WATCHLIST];
}
export function setWatchlist(list: string[]) { localStorage.setItem('watchlist', JSON.stringify(list)); }
