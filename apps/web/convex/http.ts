import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

const http = httpRouter();

// ─── E2E work-queue HTTP endpoints (NEO-49) ──────────────────────────────────
// CI runners (bash) POST here to pull the next flow + report results, so a
// homogeneous pool of runners drains one shared queue (dynamic work-stealing)
// instead of each running a static shard slice.
//
// WHY Convex HTTP actions (not a Vercel /api function): a Vercel function's
// VITE_CONVEX_URL is the DEV deployment, not the per-PR preview the test data
// lives on (see api/auth/testing.ts). These run ON the preview Convex, so the
// queue is co-located + per-PR isolated. Runners hit the preview's PUBLIC
// `<deployment>.convex.site` URL directly (no Vercel bypass proxy needed); the
// `setup` CI job resolves that URL once and passes it to the runner jobs.
//
// AUTH: `x-e2e-queue-secret` header must equal E2E_QUEUE_SECRET. The underlying
// e2eQueue mutations re-check it AND fail closed when the env is unset (prod),
// so this header is the load-bearing control (the Convex URL is public). The
// secret is a GitHub Actions secret in CI and is NEVER passed to Maestro via -e
// (NEO-29: Maestro serializes -e into public debug artifacts).

function secretOf(req: Request): string {
  return req.headers.get("x-e2e-queue-secret") ?? "";
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Map a thrown auth/validation error to an HTTP status. "Unauthorized" / "not
// enabled" → 401; validation (bad flow path, too many flows) → 400; else 500.
function errorResponse(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e);
  let status = 500;
  if (/unauthorized|not enabled/i.test(msg)) status = 401;
  else if (/invalid|too many/i.test(msg)) status = 400;
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

http.route({
  path: "/e2e/seed",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await bodyOf(req);
    try {
      const res = await ctx.runMutation(api.e2eQueue.seedQueue, {
        secret: secretOf(req),
        runId: String(body.runId ?? ""),
        flows: Array.isArray(body.flows) ? body.flows.map(String) : [],
      });
      return Response.json(res);
    } catch (e) {
      return errorResponse(e);
    }
  }),
});

http.route({
  path: "/e2e/claim",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await bodyOf(req);
    try {
      const res = await ctx.runMutation(api.e2eQueue.claimNext, {
        secret: secretOf(req),
        runId: String(body.runId ?? ""),
        claimedBy: String(body.claimedBy ?? "unknown"),
        ...(body.leaseMs !== undefined ? { leaseMs: Number(body.leaseMs) } : {}),
      });
      // Normalize to a stable shape so the runner can just read .flowPath.
      return Response.json({ flowPath: res?.flowPath ?? null });
    } catch (e) {
      return errorResponse(e);
    }
  }),
});

http.route({
  path: "/e2e/result",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await bodyOf(req);
    const status = body.status === "passed" ? "passed" : "failed";
    try {
      await ctx.runMutation(api.e2eQueue.markResult, {
        secret: secretOf(req),
        runId: String(body.runId ?? ""),
        flowPath: String(body.flowPath ?? ""),
        status,
      });
      return Response.json({ ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  }),
});

http.route({
  path: "/e2e/status",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await bodyOf(req);
    try {
      const res = await ctx.runQuery(api.e2eQueue.getStatus, {
        secret: secretOf(req),
        runId: String(body.runId ?? ""),
      });
      return Response.json(res);
    } catch (e) {
      return errorResponse(e);
    }
  }),
});

// ── LOCAL-HARNESS routes (NEO-47) ────────────────────────────────────────────
// /e2e/add  = drip flows into an existing run (persistent local worker pool).
// /e2e/flow = per-flow status for the local watcher. CI uses neither. Same
// x-e2e-queue-secret gate (prod fail-closed via the underlying mutations/query).
http.route({
  path: "/e2e/add",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await bodyOf(req);
    try {
      const res = await ctx.runMutation(api.e2eQueue.enqueueFlows, {
        secret: secretOf(req),
        runId: String(body.runId ?? ""),
        flows: Array.isArray(body.flows) ? body.flows.map(String) : [],
      });
      return Response.json(res);
    } catch (e) {
      return errorResponse(e);
    }
  }),
});

http.route({
  path: "/e2e/flow",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await bodyOf(req);
    try {
      const res = await ctx.runQuery(api.e2eQueue.getFlow, {
        secret: secretOf(req),
        runId: String(body.runId ?? ""),
        flowPath: String(body.flowPath ?? ""),
      });
      return Response.json(res);
    } catch (e) {
      return errorResponse(e);
    }
  }),
});

export default http;
