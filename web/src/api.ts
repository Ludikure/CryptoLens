// Thin client over the MarketScope Worker (the shared analysis brain). Mirrors the iOS auth
// flow: a localStorage device_id + Keychain-equivalent token, three headers on every call,
// 401 → rotate device_id + re-register (PushService.handleAuthFailure equivalent).

const BASE = import.meta.env.VITE_WORKER_BASE || 'https://marketscope-proxy.ludikure.workers.dev';
const APP_ID = 'marketscope-ios'; // worker auth gate requires this on every request

function deviceId(): string {
  let id = localStorage.getItem('device_id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('device_id', id);
  }
  return id;
}

async function register(): Promise<string> {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'X-App-ID': APP_ID, 'X-Device-ID': deviceId(), 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`register failed (${res.status})`);
  const data = (await res.json()) as { authToken?: string };
  if (!data.authToken) throw new Error('register: no token');
  localStorage.setItem('worker_auth_token', data.authToken);
  return data.authToken;
}

async function authToken(): Promise<string> {
  return localStorage.getItem('worker_auth_token') || (await register());
}

function rotateDevice() {
  localStorage.removeItem('worker_auth_token');
  localStorage.removeItem('device_id'); // new device_id on next deviceId() call (matches iOS recovery)
}

async function authedFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await authToken();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
    'X-App-ID': APP_ID, 'X-Device-ID': deviceId(), 'X-Auth-Token': token,
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401 && retry) {
    rotateDevice();
    await register();
    return authedFetch(path, init, false);
  }
  return res;
}

import type { IndicatorsResponse, FullAnalysisResponse, DirectionAccuracy, MlCalibration, MlPredict, MarketData } from './types';

export async function getIndicators(symbol: string): Promise<IndicatorsResponse> {
  const res = await authedFetch(`/indicators?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`indicators failed (${res.status})`);
  return res.json();
}

export async function runFullAnalysis(symbol: string, opts?: { accountSize?: number; riskPercent?: number }): Promise<FullAnalysisResponse> {
  const res = await authedFetch('/full-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, ...opts }),
  });
  if (!res.ok) {
    let msg = `analysis failed (${res.status})`;
    try { const e = await res.json(); if (e?.error) msg = e.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// Cron-cached ML for a symbol. Returns null on 404 (no cron has scored it — e.g. a stock not
// on any watchlist) so the UI can simply omit ML rather than error.
export async function getMlPredict(symbol: string): Promise<MlPredict | null> {
  const res = await authedFetch(`/ml-predict?symbol=${encodeURIComponent(symbol)}`);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

export async function getMarket(symbol: string): Promise<MarketData> {
  const res = await authedFetch(`/market?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`market failed (${res.status})`);
  return res.json();
}

export async function getDirectionAccuracy(): Promise<DirectionAccuracy> {
  const res = await authedFetch('/direction-accuracy');
  if (!res.ok) throw new Error(`direction-accuracy failed (${res.status})`);
  return res.json();
}

export async function getMlCalibration(): Promise<MlCalibration> {
  const res = await authedFetch('/ml-calibration');
  if (!res.ok) throw new Error(`ml-calibration failed (${res.status})`);
  return res.json();
}

export { deviceId };
