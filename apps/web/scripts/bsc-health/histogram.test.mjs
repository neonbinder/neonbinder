/** NEO-475 — the scripts' histogram agrees with the recorder's, on the same vectors. */
import { expect, test } from "vitest";
import * as ts from "../../convex/lib/bscCallTelemetry";
import * as js from "./histogram.mjs";

const VALUES = [[], [420], [80, 80, 80, 9000], [5, 99, 100, 101, 250, 251, 60000, 60001, 125000], Array.from({ length: 200 }, (_, i) => i * 37)];

const build = (impl, values) => {
  const lat = impl.emptyLat ? impl.emptyLat() : impl.emptyLatency();
  values.forEach((v, i) => {
    lat.min = i === 0 ? v : Math.min(lat.min, v);
    lat.max = Math.max(lat.max, v);
    lat.sum += v;
    lat.buckets[impl.bucketIndex(v)] += 1;
  });
  return lat;
};

test("same buckets and same percentiles as the Convex module", () => {
  expect(js.EDGES_MS).toEqual([...ts.BSC_LATENCY_BUCKET_EDGES_MS]);
  for (const values of VALUES) {
    const a = build(ts, values);
    const b = build(js, values);
    expect(b).toEqual(a);
    for (const p of [0.5, 0.9, 0.95, 0.99]) expect(js.percentile(b, p)).toBe(ts.percentile(a, p));
  }
});

test("merge agrees with the Convex module", () => {
  const mk = (impl, values, extra) => ({
    op: "x",
    startedAt: extra.s,
    endedAt: extra.e,
    calls: values.length,
    ok: values.length,
    byKind: extra.k,
    byStatus: { 200: values.length },
    maxInflight: extra.m,
    suppressed: extra.u,
    lat: build(impl, values),
  });
  const x = { s: 5, e: 9, k: { http: 1 }, m: 2, u: 1 };
  const y = { s: 1, e: 12, k: { http: 2, timeout: 1 }, m: 4, u: 0 };
  expect(js.mergeSummaries(mk(js, [10, 700], x), mk(js, [9000], y))).toEqual(
    ts.mergeSummaries(mk(ts, [10, 700], x), mk(ts, [9000], y)),
  );
});

test("addObservation folds calls in", () => {
  const acc = js.emptySummary("op", 0);
  js.addObservation(acc, { durationMs: 150, ok: true, status: 200, at: 100 });
  js.addObservation(acc, { durationMs: 30000, ok: false, status: 503, kind: "http", at: 50 });
  js.addObservation(acc, { ok: false, kind: "timeout" });
  expect(acc).toMatchObject({ calls: 3, ok: 1, byKind: { http: 1, timeout: 1 }, byStatus: { 200: 1, 503: 1 }, startedAt: 50, endedAt: 100 });
  expect(acc.lat).toMatchObject({ min: 150, max: 30000, sum: 30150 });
});
