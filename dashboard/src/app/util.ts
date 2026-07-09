export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Insert nulls into a time series wherever consecutive points are further apart
 * than `gapThresholdMs`, so Chart.js renders a break (a sleeping/offline
 * machine) instead of drawing a straight line across the gap.
 */
export function withGaps<T extends { timestamp: string }>(
  points: T[],
  gapThresholdMs: number,
  makeGap: (isoBetween: string) => T
): T[] {
  const out: T[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const prev = new Date(points[i - 1].timestamp).getTime();
      const cur = new Date(points[i].timestamp).getTime();
      if (cur - prev > gapThresholdMs) {
        out.push(makeGap(new Date(prev + (cur - prev) / 2).toISOString()));
      }
    }
    out.push(points[i]);
  }
  return out;
}
