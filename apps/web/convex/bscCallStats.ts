/**
 * NEO-475 — the `bscCallSummaries` table's writer and its one reader.
 *
 * The BSC adapters build a summary per action invocation (or seller session)
 * in `convex/lib/bscCallTelemetry.ts` and hand it here with
 *
 *   ctx.scheduler.runAfter(0, internal.bscCallStats.record, summary)
 *
 * so the write is never on the call's hot path. `record` re-caps everything
 * it is given: the emitter already scrubs and bounds its strings, but a row is
 * kept forever (Jason, decision D3), so a bug upstream must not be able to push
 * an unbounded document into a table nothing prunes.
 *
 * Internal only. Nothing subscribes to the table; `exportRange` is read with
 * `npx convex run` by the bsc-health scripts.
 */

import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { bscCallSummaryFields, bscCallSummaryValidator } from "./schema";
import type { Infer } from "convex/values";
// One source for the bucket edges and the sample cap: the emitter's. Bucket
// `i` counts calls with `durationMs <= EDGES[i]` (and above the previous
// edge); index `EDGES.length` is the overflow bucket (above 60 s). Fixed
// forever: changing an edge makes old and new rows unmergeable.
import {
  BSC_LATENCY_BUCKET_COUNT,
  BSC_LATENCY_BUCKET_EDGES_MS,
  MAX_SAMPLES,
} from "./lib/bscCallTelemetry";

export { bscCallSampleValidator, bscCallKindValidator, bscCallSummaryValidator } from "./schema";
export { BSC_LATENCY_BUCKET_COUNT, BSC_LATENCY_BUCKET_EDGES_MS, MAX_SAMPLES };
export type BscCallSummary = Infer<typeof bscCallSummaryValidator>;

export const MAX_STRING_CHARS = 600;
/** byKind / byStatus / a sample's headers: more keys than this is a bug upstream. */
export const MAX_RECORD_KEYS = 32;
export const MAX_EXPORT_PAGE = 500;

function capString(s: string): string {
  return s.length > MAX_STRING_CHARS ? s.slice(0, MAX_STRING_CHARS) : s;
}

function capOptString(s: string | undefined): string | undefined {
  return s === undefined ? undefined : capString(s);
}

/** Counts and durations: finite and non-negative, or 0. */
function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function capCounts(rec: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(rec).slice(0, MAX_RECORD_KEYS)) {
    out[k.slice(0, 64)] = count(n);
  }
  return out;
}

function capHeaders(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(rec).slice(0, MAX_RECORD_KEYS)) {
    out[k.slice(0, 64)] = capString(s);
  }
  return out;
}

/**
 * Exactly `BSC_LATENCY_BUCKET_COUNT` buckets. A short array is padded with
 * zeros; a long one folds its extra counts into the overflow bucket, so no
 * call is lost from the total.
 */
export function normaliseBuckets(buckets: number[]): number[] {
  const out = new Array<number>(BSC_LATENCY_BUCKET_COUNT).fill(0);
  buckets.forEach((n, i) => {
    out[Math.min(i, BSC_LATENCY_BUCKET_COUNT - 1)] += count(n);
  });
  return out;
}

function omitUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, val]) => val !== undefined)) as T;
}

/** The capped copy of a summary that `record` inserts. Pure, for the tests. */
export function capSummary(s: BscCallSummary): BscCallSummary {
  return omitUndefined({
    op: capString(s.op),
    deployment: capOptString(s.deployment),
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    calls: count(s.calls),
    ok: count(s.ok),
    byKind: capCounts(s.byKind),
    byStatus: capCounts(s.byStatus),
    maxInflight: count(s.maxInflight),
    suppressed: count(s.suppressed),
    lat: {
      min: count(s.lat.min),
      max: count(s.lat.max),
      sum: count(s.lat.sum),
      buckets: normaliseBuckets(s.lat.buckets),
    },
    samples: s.samples.slice(0, MAX_SAMPLES).map((x) =>
      omitUndefined({
        ...x,
        op: capOptString(x.op),
        pathTemplate: capOptString(x.pathTemplate),
        bscCardId: capOptString(x.bscCardId),
        errCode: capOptString(x.errCode),
        body: capOptString(x.body),
        deployment: capOptString(x.deployment),
        headers: x.headers === undefined ? undefined : capHeaders(x.headers),
      }),
    ),
  });
}

/** Insert one summary row. Scheduled by the adapters; never called inline. */
export const record = internalMutation({
  args: bscCallSummaryFields,
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("bscCallSummaries", capSummary(args));
    return null;
  },
});

const summaryDocValidator = v.object({
  _id: v.id("bscCallSummaries"),
  _creationTime: v.number(),
  ...bscCallSummaryFields,
});

/**
 * Summaries with `from <= startedAt < to`, oldest first, a page at a time
 * (at most `MAX_EXPORT_PAGE` rows per page).
 */
export const exportRange = internalQuery({
  args: {
    from: v.number(),
    to: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(summaryDocValidator),
  handler: async (ctx, { from, to, paginationOpts }) => {
    return await ctx.db
      .query("bscCallSummaries")
      .withIndex("by_startedAt", (q) => q.gte("startedAt", from).lt("startedAt", to))
      .order("asc")
      .paginate({
        ...paginationOpts,
        numItems: Math.max(1, Math.min(paginationOpts.numItems, MAX_EXPORT_PAGE)),
      });
  },
});
