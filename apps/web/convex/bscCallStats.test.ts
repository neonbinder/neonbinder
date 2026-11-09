/**
 * NEO-475 — the bscCallSummaries writer caps what it stores, and exportRange
 * pages a half-open startedAt window in order.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  BSC_LATENCY_BUCKET_COUNT,
  MAX_EXPORT_PAGE,
  MAX_RECORD_KEYS,
  MAX_SAMPLES,
  MAX_STRING_CHARS,
  normaliseBuckets,
  type BscCallSummary,
} from "./bscCallStats";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

function summary(startedAt: number, over: Partial<BscCallSummary> = {}): BscCallSummary {
  return {
    op: "fetchBscCardTeamNames",
    deployment: "test-deployment",
    startedAt,
    endedAt: startedAt + 1000,
    calls: 3,
    ok: 2,
    byKind: { http: 1 },
    byStatus: { "503": 1 },
    maxInflight: 2,
    suppressed: 0,
    lat: { min: 80, max: 5000, sum: 5300, buckets: [1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0] },
    samples: [
      {
        kind: "http",
        pathTemplate: "marketplace/card/:id/card-listing",
        bscCardId: "abc",
        status: 503,
        durationMs: 5000,
        timeoutMs: 10000,
        attempt: 1,
        inflight: 2,
        headers: { server: "awselb/2.0", "x-amz-cf-pop": "ORD52-C1" },
        body: "<title>503 Service Temporarily Unavailable</title>",
      },
    ],
    ...over,
  };
}

async function all(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("bscCallSummaries").collect());
}

async function exportAll(t: ReturnType<typeof convexTest>, from: number, to: number, numItems: number) {
  const pages: number[][] = [];
  let cursor: string | null = null;
  for (;;) {
    const res = await t.query(internal.bscCallStats.exportRange, {
      from,
      to,
      paginationOpts: { numItems, cursor },
    });
    pages.push(res.page.map((r) => r.startedAt));
    if (res.isDone) break;
    cursor = res.continueCursor;
  }
  return pages;
}

describe("bscCallStats.record", () => {
  test("stores a summary as given when it is within the caps", async () => {
    const t = convexTest(schema, modules);
    const s = summary(1_000);
    await t.mutation(internal.bscCallStats.record, s);
    const rows = await all(t);
    expect(rows).toHaveLength(1);
    const { _id, _creationTime, ...stored } = rows[0];
    void _id;
    void _creationTime;
    expect(stored).toEqual(s);
  });

  test("accepts a summary with no deployment and no samples", async () => {
    const t = convexTest(schema, modules);
    const { deployment, ...rest } = summary(1_000, { samples: [] });
    void deployment;
    await t.mutation(internal.bscCallStats.record, rest);
    const [row] = await all(t);
    expect(row.deployment).toBeUndefined();
    expect(row.samples).toEqual([]);
  });

  test("caps samples, strings, maps and buckets", async () => {
    const t = convexTest(schema, modules);
    const long = "x".repeat(MAX_STRING_CHARS + 400);
    const manyKeys = Object.fromEntries(
      Array.from({ length: MAX_RECORD_KEYS + 10 }, (_, i) => [`k${i}`, 1]),
    );
    const manyHeaders = Object.fromEntries(
      Array.from({ length: MAX_RECORD_KEYS + 10 }, (_, i) => [`x-h${i}`, long]),
    );
    const sample = {
      kind: "network" as const,
      op: long,
      pathTemplate: long,
      bscCardId: long,
      errCode: long,
      body: long,
      deployment: long,
      headers: manyHeaders,
    };
    await t.mutation(
      internal.bscCallStats.record,
      summary(1_000, {
        op: long,
        deployment: long,
        byKind: manyKeys,
        byStatus: manyKeys,
        samples: Array.from({ length: MAX_SAMPLES + 4 }, () => sample),
      }),
    );
    const [row] = await all(t);
    expect(row.op).toHaveLength(MAX_STRING_CHARS);
    expect(row.deployment).toHaveLength(MAX_STRING_CHARS);
    expect(Object.keys(row.byKind)).toHaveLength(MAX_RECORD_KEYS);
    expect(Object.keys(row.byStatus)).toHaveLength(MAX_RECORD_KEYS);
    expect(row.samples).toHaveLength(MAX_SAMPLES);
    for (const s of row.samples) {
      for (const f of ["op", "pathTemplate", "bscCardId", "errCode", "body", "deployment"] as const) {
        expect(s[f]).toHaveLength(MAX_STRING_CHARS);
      }
      expect(Object.keys(s.headers ?? {})).toHaveLength(MAX_RECORD_KEYS);
      for (const h of Object.values(s.headers ?? {})) expect(h).toHaveLength(MAX_STRING_CHARS);
    }
    expect(row.lat.buckets).toHaveLength(BSC_LATENCY_BUCKET_COUNT);
  });

  test("bad numbers become 0 rather than poisoning a merge", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(
      internal.bscCallStats.record,
      summary(1_000, {
        calls: -3,
        suppressed: Number.NaN,
        lat: { min: Number.POSITIVE_INFINITY, max: 10, sum: 10, buckets: [1, -1] },
      }),
    );
    const [row] = await all(t);
    expect(row.calls).toBe(0);
    expect(row.suppressed).toBe(0);
    expect(row.lat.min).toBe(0);
    expect(row.lat.buckets).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("normaliseBuckets", () => {
  test("pads a short array with zeros", () => {
    expect(normaliseBuckets([2, 3])).toEqual([2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("folds a long array's extra counts into the overflow bucket", () => {
    const long = Array.from({ length: 14 }, () => 1);
    const out = normaliseBuckets(long);
    expect(out).toHaveLength(BSC_LATENCY_BUCKET_COUNT);
    expect(out[BSC_LATENCY_BUCKET_COUNT - 1]).toBe(4);
    expect(out.reduce((a, b) => a + b, 0)).toBe(14);
  });
});

describe("bscCallStats.exportRange", () => {
  test("returns from <= startedAt < to, oldest first", async () => {
    const t = convexTest(schema, modules);
    // Inserted out of order on purpose: the index, not insertion, orders them.
    for (const at of [300, 100, 200, 400, 99, 250]) {
      await t.mutation(internal.bscCallStats.record, summary(at));
    }
    const pages = await exportAll(t, 100, 400, 10);
    expect(pages.flat()).toEqual([100, 200, 250, 300]);
  });

  test("an empty or inverted window returns nothing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.bscCallStats.record, summary(100));
    expect((await exportAll(t, 100, 100, 10)).flat()).toEqual([]);
    expect((await exportAll(t, 200, 100, 10)).flat()).toEqual([]);
  });

  test("pages through a window without gaps or repeats", async () => {
    const t = convexTest(schema, modules);
    const starts = Array.from({ length: 7 }, (_, i) => 1_000 + i * 10);
    for (const at of starts) await t.mutation(internal.bscCallStats.record, summary(at));
    const pages = await exportAll(t, 0, 10_000, 3);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(3);
    expect(pages.flat()).toEqual(starts);
  });

  test("a page never exceeds MAX_EXPORT_PAGE rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_EXPORT_PAGE + 5; i++) {
        await ctx.db.insert("bscCallSummaries", summary(i));
      }
    });
    const first = await t.query(internal.bscCallStats.exportRange, {
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
      paginationOpts: { numItems: MAX_EXPORT_PAGE * 4, cursor: null },
    });
    expect(first.page).toHaveLength(MAX_EXPORT_PAGE);
    expect(first.isDone).toBe(false);
  });
});
