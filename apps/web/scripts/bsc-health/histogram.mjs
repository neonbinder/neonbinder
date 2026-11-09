/**
 * NEO-475 — fixed-bucket latency histograms for the bsc-health scripts.
 *
 * This mirrors the histogram half of `convex/lib/bscCallTelemetry.ts` (the
 * scripts are plain Node and cannot import Convex TypeScript). The two are kept
 * honest by `histogram.test.mjs`, which runs the same vectors through both.
 * The bucket edges are fixed forever: changing one makes old and new summaries
 * unmergeable.
 */

export const EDGES_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000];
export const BUCKET_COUNT = EDGES_MS.length + 1;

export function emptyLat() {
  return { min: 0, max: 0, sum: 0, buckets: new Array(BUCKET_COUNT).fill(0) };
}

export function bucketIndex(ms) {
  for (let i = 0; i < EDGES_MS.length; i++) if (ms <= EDGES_MS[i]) return i;
  return EDGES_MS.length;
}

const total = (buckets) => buckets.reduce((a, b) => a + b, 0);

/** Estimated percentile (p in 0..1) from the buckets; null when empty. */
export function percentile(lat, p) {
  const n = total(lat.buckets);
  if (n <= 0) return null;
  const rank = Math.min(Math.max(p, 0), 1) * n;
  let before = 0;
  for (let i = 0; i < lat.buckets.length; i++) {
    const c = lat.buckets[i];
    if (c > 0 && before + c >= rank) {
      const lower = i === 0 ? 0 : EDGES_MS[i - 1];
      const upper = i < EDGES_MS.length ? EDGES_MS[i] : lat.max;
      const estimate = lower + ((rank - before) / c) * (Math.max(upper, lower) - lower);
      return Math.round(Math.min(Math.max(estimate, lat.min), lat.max));
    }
    before += c;
  }
  return lat.max;
}

const addCounts = (a, b) => {
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
};

/** Counts add, maxima take the max, min the min of the non-empty sides, buckets add. */
export function mergeSummaries(a, b) {
  const aEmpty = total(a.lat.buckets) === 0;
  const bEmpty = total(b.lat.buckets) === 0;
  const buckets = new Array(BUCKET_COUNT).fill(0);
  for (let i = 0; i < BUCKET_COUNT; i++) buckets[i] = (a.lat.buckets[i] ?? 0) + (b.lat.buckets[i] ?? 0);
  return {
    op: a.op,
    ...(a.deployment !== undefined ? { deployment: a.deployment } : {}),
    startedAt: Math.min(a.startedAt, b.startedAt),
    endedAt: Math.max(a.endedAt, b.endedAt),
    calls: a.calls + b.calls,
    ok: a.ok + b.ok,
    byKind: addCounts(a.byKind, b.byKind),
    byStatus: addCounts(a.byStatus, b.byStatus),
    maxInflight: Math.max(a.maxInflight, b.maxInflight),
    suppressed: a.suppressed + b.suppressed,
    lat: {
      min: aEmpty ? b.lat.min : bEmpty ? a.lat.min : Math.min(a.lat.min, b.lat.min),
      max: Math.max(a.lat.max, b.lat.max),
      sum: a.lat.sum + b.lat.sum,
      buckets,
    },
  };
}

export function emptySummary(op, at = 0) {
  return {
    op,
    startedAt: at,
    endedAt: at,
    calls: 0,
    ok: 0,
    byKind: {},
    byStatus: {},
    maxInflight: 0,
    suppressed: 0,
    lat: emptyLat(),
  };
}

/**
 * Fold one observed call into a summary-shaped accumulator (in place).
 * `{durationMs, ok, status?, kind?, at?}`; `kind` counts only when not ok.
 */
export function addObservation(acc, obs) {
  const had = acc.calls;
  acc.calls += 1;
  if (obs.ok) acc.ok += 1;
  else if (obs.kind) acc.byKind[obs.kind] = (acc.byKind[obs.kind] ?? 0) + 1;
  if (obs.status !== undefined && obs.status !== null) {
    const key = String(obs.status);
    acc.byStatus[key] = (acc.byStatus[key] ?? 0) + 1;
  }
  if (typeof obs.durationMs === "number" && Number.isFinite(obs.durationMs) && obs.durationMs >= 0) {
    const d = obs.durationMs;
    const first = total(acc.lat.buckets) === 0;
    acc.lat.buckets[bucketIndex(d)] += 1;
    acc.lat.sum += d;
    acc.lat.min = first ? d : Math.min(acc.lat.min, d);
    acc.lat.max = Math.max(acc.lat.max, d);
  }
  if (typeof obs.at === "number") {
    acc.startedAt = had === 0 ? obs.at : Math.min(acc.startedAt, obs.at);
    acc.endedAt = Math.max(acc.endedAt, obs.at);
  }
  return acc;
}
