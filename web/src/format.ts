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
export function biasClass(bias: string | null | undefined): string {
  if (!bias) return 'neutral';
  if (bias.includes('Bullish')) return 'bull';
  if (bias.includes('Bearish')) return 'bear';
  return 'neutral';
}
