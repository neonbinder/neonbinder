import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ─── E2E work-queue (NEO-49) ────────────────────────────────────────────────
// CI runners pull the next pending flow from a shared queue instead of running a
// static shard slice, so dispatch is dynamic (work-stealing): any runner grabs
// whatever's available, slow flows can't drag a fixed shard, and the suite scales
// by just adding flows + runners. Convex mutations are serializable (OCC), so an
// atomic "pop next pending" is race-free with no locks — two concurrent claims
// can't take the same row (the loser re-runs and gets the next one).
//
// SECURITY POSTURE (hardened per NEO-49 security review):
//   - FAIL CLOSED IN PROD: every function throws unless `E2E_QUEUE_SECRET` is set
//     in the deployment env. It is a dedicated flag/secret set ONLY on dev/preview
//     (never prod), decoupled from TESTING_RESET_SECRET. So the queue cannot exist
//     or be touched in production.
//   - SHARED-SECRET on EVERY call: the `secret` arg must equal `E2E_QUEUE_SECRET`.
//     This is the load-bearing control: the Convex URL is in the preview client
//     bundle (window.__convexUrl), so without it ANYONE who can load the preview
//     could call markResult directly, bypass the Vercel x-testing-auth layer, and
//     force a FALSE-GREEN on the merge-blocking `e2e` gate (main auto-deploys to
//     prod). The Vercel api/e2e/* functions hold the secret and forward it; it is
//     a GitHub Actions secret in CI and is NEVER passed to Maestro via -e (NEO-29).
//   - Data is ephemeral, per-run test metadata (flow paths + status). No PII, no
//     credentials, no product data.

const MAX_SEED_FLOWS = 5000;
// flowPath is later interpolated into `maestro test "$flow"` on a runner that
// holds GH secrets — validate it can only ever be a repo flow path.
const FLOW_PATH_RE = /^\.maestro\/flows\/[A-Za-z0-9._/-]+\.yaml$/;

function assertAuthorized(secret: string) {
  const expected = process.env.E2E_QUEUE_SECRET;
  if (!expected) {
    // Fail closed: the queue is disabled wherever E2E_QUEUE_SECRET is unset (prod).
    throw new Error("E2E queue is not enabled on this deployment");
  }
  if (secret !== expected) {
    throw new Error("Unauthorized");
  }
}

/**
 * Seed the queue for a run with the full flow list. IDEMPOTENT: if the run is
 * already seeded (any row exists for runId) it's a no-op, so a retried seed step
 * can't double-insert. Validates every flowPath and bounds the batch.
 */
export const seedQueue = mutation({
  args: { secret: v.string(), runId: v.string(), flows: v.array(v.string()) },
  returns: v.object({ inserted: v.number(), alreadySeeded: v.boolean() }),
  handler: async (ctx, args) => {
    assertAuthorized(args.secret);
    if (args.flows.length > MAX_SEED_FLOWS) {
      throw new Error(`Too many flows (${args.flows.length} > ${MAX_SEED_FLOWS})`);
    }
    for (const flowPath of args.flows) {
      // Reject `..` explicitly: FLOW_PATH_RE's char class allows '.' and '/', so
      // it alone would match `.maestro/flows/../../etc/x.yaml`. flowPath is later
      // echoed by claimNext and reaches `maestro test "$flow"` on a secret-holding
      // runner, so it must not escape .maestro/flows/ (NEO-49 security re-audit).
      if (!FLOW_PATH_RE.test(flowPath) || flowPath.includes("..")) {
        throw new Error(`Invalid flow path: ${flowPath}`);
      }
    }
    const existing = await ctx.db
      .query("e2eFlowQueue")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId))
      .first();
    if (existing) return { inserted: 0, alreadySeeded: true };
    for (const flowPath of args.flows) {
      await ctx.db.insert("e2eFlowQueue", {
        runId: args.runId,
        flowPath,
        status: "pending",
        attempts: 0,
      });
    }
    return { inserted: args.flows.length, alreadySeeded: false };
  },
});

/**
 * Atomically claim the next pending flow for this run. Returns null when the
 * queue is drained, so the runner loop exits. `leaseMs` (optional): a flow stuck
 * "running" longer than this — its worker died — is reclaimable so the run can
 * still finish; `attempts` then increments.
 */
export const claimNext = mutation({
  args: {
    secret: v.string(),
    runId: v.string(),
    claimedBy: v.string(),
    leaseMs: v.optional(v.number()),
  },
  returns: v.union(v.object({ flowPath: v.string() }), v.null()),
  handler: async (ctx, args) => {
    assertAuthorized(args.secret);
    const now = Date.now();
    // Prefer a fresh pending flow.
    let target = await ctx.db
      .query("e2eFlowQueue")
      .withIndex("by_run_status", (q) =>
        q.eq("runId", args.runId).eq("status", "pending"),
      )
      .first();
    // None pending — reclaim a stale "running" row (dead worker) if leasing.
    if (!target && args.leaseMs !== undefined) {
      const running = await ctx.db
        .query("e2eFlowQueue")
        .withIndex("by_run_status", (q) =>
          q.eq("runId", args.runId).eq("status", "running"),
        )
        .collect();
      const lease = args.leaseMs;
      target = running.find((r) => (r.startedAt ?? 0) + lease < now) ?? null;
    }
    if (!target) return null;
    await ctx.db.patch(target._id, {
      status: "running",
      claimedBy: args.claimedBy,
      startedAt: now,
      attempts: target.attempts + 1,
    });
    return { flowPath: target.flowPath };
  },
});

/** Record a flow's terminal result (passed/failed). */
export const markResult = mutation({
  args: {
    secret: v.string(),
    runId: v.string(),
    flowPath: v.string(),
    status: v.union(v.literal("passed"), v.literal("failed")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertAuthorized(args.secret);
    const row = await ctx.db
      .query("e2eFlowQueue")
      .withIndex("by_run_flow", (q) =>
        q.eq("runId", args.runId).eq("flowPath", args.flowPath),
      )
      .first();
    // Intentional no-op when no row matches: markResult can only UPDATE the
    // status of an already-seeded flow, never INSERT — so a spurious/duplicate
    // call can't conjure a flow row or flip a non-existent one green. Do not
    // "fix" this into an upsert (it would open a gate-integrity hole).
    if (row) {
      await ctx.db.patch(row._id, { status: args.status, finishedAt: Date.now() });
    }
    return null;
  },
});

/**
 * LOCAL-HARNESS drip-enqueue (NEO-47). Unlike `seedQueue` (idempotent run-lock,
 * seeded once in CI), this appends flows to an EXISTING run so a persistent local
 * worker pool can be fed one flow at a time. Insert-if-absent; an already-queued
 * flow that is terminal (passed/failed) or still pending is RESET to pending so a
 * just-fixed flow can be re-validated; a flow currently "running" is left alone.
 * CI never calls this. Same secret gate + flow-path validation as seedQueue.
 */
export const enqueueFlows = mutation({
  args: { secret: v.string(), runId: v.string(), flows: v.array(v.string()) },
  returns: v.object({ queued: v.number(), skippedRunning: v.number() }),
  handler: async (ctx, args) => {
    assertAuthorized(args.secret);
    if (args.flows.length > MAX_SEED_FLOWS) {
      throw new Error(`Too many flows (${args.flows.length} > ${MAX_SEED_FLOWS})`);
    }
    let queued = 0;
    let skippedRunning = 0;
    for (const flowPath of args.flows) {
      if (!FLOW_PATH_RE.test(flowPath) || flowPath.includes("..")) {
        throw new Error(`Invalid flow path: ${flowPath}`);
      }
      const existing = await ctx.db
        .query("e2eFlowQueue")
        .withIndex("by_run_flow", (q) =>
          q.eq("runId", args.runId).eq("flowPath", flowPath),
        )
        .first();
      if (!existing) {
        await ctx.db.insert("e2eFlowQueue", {
          runId: args.runId,
          flowPath,
          status: "pending",
          attempts: 0,
        });
        queued += 1;
      } else if (existing.status === "running") {
        skippedRunning += 1;
      } else {
        await ctx.db.patch(existing._id, {
          status: "pending",
          claimedBy: undefined,
          startedAt: undefined,
          finishedAt: undefined,
        });
        queued += 1;
      }
    }
    return { queued, skippedRunning };
  },
});

/**
 * Per-flow status for a run (LOCAL-HARNESS watcher — `./e2e-watch.sh`). Returns
 * null when the flow isn't queued for this run. Secret-gated like the rest.
 */
export const getFlow = query({
  args: { secret: v.string(), runId: v.string(), flowPath: v.string() },
  returns: v.union(
    v.object({
      status: v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("passed"),
        v.literal("failed"),
      ),
      attempts: v.number(),
      claimedBy: v.optional(v.string()),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    assertAuthorized(args.secret);
    const row = await ctx.db
      .query("e2eFlowQueue")
      .withIndex("by_run_flow", (q) =>
        q.eq("runId", args.runId).eq("flowPath", args.flowPath),
      )
      .first();
    if (!row) return null;
    return {
      status: row.status,
      attempts: row.attempts,
      claimedBy: row.claimedBy,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  },
});

/**
 * Live status for a run — counts by status. Powers BOTH the CI gate (any failed,
 * or leftover running at the end, → red) AND live run monitoring (query any time
 * for "30 passed / 4 running / 9 pending / 2 failed" without parsing GH logs).
 * Secret-gated too: it is read only server-side via api/e2e/status (which holds
 * the secret) — never from the client bundle.
 */
export const getStatus = query({
  args: { secret: v.string(), runId: v.string() },
  returns: v.object({
    pending: v.number(),
    running: v.number(),
    passed: v.number(),
    failed: v.number(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    assertAuthorized(args.secret);
    const rows = await ctx.db
      .query("e2eFlowQueue")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId))
      .collect();
    const counts = { pending: 0, running: 0, passed: 0, failed: 0 };
    for (const r of rows) counts[r.status] += 1;
    return { ...counts, total: rows.length };
  },
});
