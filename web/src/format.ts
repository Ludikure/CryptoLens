// Display formatters mirroring the iOS/worker conventions used in the prompt.
export function formatPrice(p: number | null | undefined): string {
  if (p == null || isNaN(p)) return '—';
  if (p >= 1) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 0.01) return '$' + p.toFixed(4);
  return '$' + p.toFixed(6);
}
export function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + '%';
}
export function mlPct(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return '—';
  return Math.round(v * 100) + '%';
}
// lightweight-charts price format derived from a series' magnitude. The default minMove (0.01)
// collapses small-magnitude series (e.g. DOGE MACD ~±0.0005) to a flat line — the whole range
// is under one tick. Pick precision/minMove from the largest absolute value.
export function priceFormatFor(values: number[]): { type: 'price'; precision: number; minMove: number } {
  let maxAbs = 0;
  for (const v of values) { const a = Math.abs(v); if (isFinite(a) && a > maxAbs) maxAbs = a; }
  const precision = maxAbs >= 1 ? 2 : maxAbs >= 0.01 ? 4 : maxAbs >= 0.0001 ? 6 : maxAbs > 0 ? 8 : 2;
  return { type: 'price', precision, minMove: Math.pow(10, -precision) };
}

export function biasClass(bias: string | null | undefined): string {
  if (!bias) return 'neutral';
  if (bias.includes('Bullish')) return 'bull';
  if (bias.includes('Bearish')) return 'bear';
  return 'neutral';
}
