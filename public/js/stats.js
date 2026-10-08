// Latency statistics shared by the speed duel page and the command-line benchmark.

/** Percentile (0..1) of an ascending array, using linear interpolation. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function summarize(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, p50: null, p90: null, mean: null, min: null, max: null };
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/** "305 ms" below a second, "1.62 s" above. */
export function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
