/**
 * Error-taxonomy + routing tests for the preprocess adapter (NEO-170; fast/heavy
 * split NEO-175).
 *
 * The single most important thing here is which HTTP statuses become a
 * `NonRetryableError` and which become a plain `Error`, because that split IS
 * the retry policy: the workpool reads the thrown error and either stops
 * immediately or spends an attempt. Getting it backwards fails in two silent
 * ways — a permanently-broken zip burning 5×40s of capacity per image, or a
 * cold start being treated as a dead job.
 *
 * The split adds a second: fast vs heavy ROUTING — each call has to reach the
 * right service's URL, and its OIDC audience has to be normalized (a tagged
 * preview host is reached at the tag but authorized against the base). The base-
 * host allowlist itself is unit-tested in convex/preprocessAudience.test.ts;
 * here we prove the adapter routes each call to the right URL.
 *
 * These call the adapter functions directly with a stub `ActionCtx` rather
 * than through convex-test. The functions use `ctx` only for `recordAdapterCall`
 * telemetry (which swallows its own failures), so a stub is both sufficient and
 * clearer about what is under test. Since NEO-315 that telemetry is SCHEDULED
 * (`ctx.scheduler.runAfter(0, internal.posthog.captureEvent, …)`), never run
 * inline, so the stub records what was scheduled and counts any `runAction`
 * call as a regression. The module is `"use node"` but runs here
 * under edge-runtime — the same arrangement the credentials tests use, and it
 * works because a loopback URL short-circuits the OIDC path before
 * google-auth-library is ever exercised.
 *
 * Filename note: dotted at the `convex/` root, matching
 * convex/adapters.placeholderUploads.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isNonRetryableError } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import type { ActionCtx } from "./_generated/server";
import {
  callExtract,
  callProcessEntryFast,
  callProcessEntryHeavy,
  callWarmupFast,
  callWarmupHeavy,
  parsePreprocessErrorCode,
  preprocessFastUrl,
  preprocessHeavyUrl,
  readEscalationHints,
} from "./adapters/preprocess";

type CapturedEvent = {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
};

/** Every capture the adapter SCHEDULED, in order. */
const captured: CapturedEvent[] = [];
/** What each schedule was aimed at and when — `[delayMs, functionName]`. */
const scheduled: Array<[number, string]> = [];
/** `ctx.runAction` calls. Telemetry must never make one again (NEO-315 C1). */
let runActionCalls = 0;

/**
 * Minimal ActionCtx. `recordAdapterCall` reads `ctx.auth` for the distinctId
 * (absent → "anonymous") and calls
 * `ctx.scheduler.runAfter(0, internal.posthog.captureEvent, …)`, which is what
 * we record. `runAction` is present only so a regression to the inline hop is
 * counted rather than crashing.
 */
function stubCtx(opts: { subject?: string } = {}): ActionCtx {
  return {
    auth: {
      getUserIdentity: async () => (opts.subject ? { subject: opts.subject } : null),
    },
    runAction: async () => {
      runActionCalls++;
      return null;
    },
    scheduler: {
      runAfter: async (delayMs: number, ref: unknown, args: CapturedEvent) => {
        scheduled.push([delayMs, getFunctionName(ref as never)]);
        captured.push(args);
        return "scheduled-id";
      },
    },
  } as unknown as ActionCtx;
}

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: FetchStub) {
  vi.stubGlobal("fetch", handler as unknown as typeof fetch);
}

function errorResponse(status: number, body: unknown = { error_code: "SOMETHING" }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EXTRACT_OK = {
  entries: [
    { index: 0, name: "front.jpg", accepted: true, content_type: "image/jpeg", size_bytes: 10 },
    { index: 1, name: "notes.txt", accepted: false, content_type: "text/plain", size_bytes: 3, reason: "not an image" },
  ],
  accepted_count: 1,
  rejected_count: 1,
};

const PROCESS_OK = {
  players: ["Ken Griffey Jr."],
  player: "Ken Griffey Jr.",
  team: "Seattle Mariners",
  card_number: "24",
  side: "back",
  rotation_degrees: 0,
  orient_confidence: 0.9,
  text_count: 40,
  cropped_source: "tiered",
  dhash: "0f1e2d3c4b5a6978",
  output_written: true,
  needs_escalation: false,
};

/** The fast role's decline: 200, no crop, `needs_escalation: true`. */
const PROCESS_DECLINED = {
  players: [],
  player: null,
  team: null,
  card_number: null,
  side: "",
  rotation_degrees: 0,
  orient_confidence: 0,
  text_count: 0,
  cropped_source: "",
  dhash: null,
  output_written: false,
  needs_escalation: true,
};

/** Run `fn` and return the error it threw, failing the test if it didn't. */
async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it resolved");
}

beforeEach(() => {
  captured.length = 0;
  scheduled.length = 0;
  runActionCalls = 0;
  // recordAdapterCall schedules nothing when PostHog is unconfigured (the
  // capture would be a no-op), so the telemetry contract needs a key.
  process.env.POSTHOG_API_KEY = "test-posthog-key";
  // Loopback → getIdTokenClient short-circuits, so no OIDC and no GCP creds. Only
  // the heavy var is set by default; fast falls back to it, so a test that does
  // not care about routing sees a single service, as production did pre-split.
  process.env.NEONBINDER_PREPROCESS_URL = "http://localhost:9998";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEONBINDER_PREPROCESS_URL;
  delete process.env.NEONBINDER_PREPROCESS_FAST_URL;
  delete process.env.NEONBINDER_PREPROCESS_INTERNAL_KEY;
  delete process.env.POSTHOG_API_KEY;
});

describe("service URLs", () => {
  test("preprocessHeavyUrl defaults to port 8081, not the browser service's 8080", () => {
    // Both run locally during full-stack dev; 8080 would silently send
    // /extract to the browser service, which 404s and looks terminal.
    delete process.env.NEONBINDER_PREPROCESS_URL;
    expect(preprocessHeavyUrl()).toBe("http://localhost:8081");
  });

  test("preprocessHeavyUrl honours NEONBINDER_PREPROCESS_URL", () => {
    process.env.NEONBINDER_PREPROCESS_URL = "https://preprocess.example.run.app";
    expect(preprocessHeavyUrl()).toBe("https://preprocess.example.run.app");
  });

  test("preprocessFastUrl falls back to the heavy URL when its own var is unset", () => {
    // Graceful degradation before Phase 3 terraform: one service handles both
    // roles, so no escalation ever fires and the pipeline behaves as pre-split.
    delete process.env.NEONBINDER_PREPROCESS_FAST_URL;
    process.env.NEONBINDER_PREPROCESS_URL = "https://only-one.example.run.app";
    expect(preprocessFastUrl()).toBe("https://only-one.example.run.app");
  });

  test("preprocessFastUrl honours NEONBINDER_PREPROCESS_FAST_URL once it is set", () => {
    process.env.NEONBINDER_PREPROCESS_FAST_URL = "https://fast.example.run.app";
    process.env.NEONBINDER_PREPROCESS_URL = "https://heavy.example.run.app";
    expect(preprocessFastUrl()).toBe("https://fast.example.run.app");
    expect(preprocessHeavyUrl()).toBe("https://heavy.example.run.app");
  });
});

describe("request shape + routing", () => {
  test("callExtract posts job_id/user_id to the FAST /extract and never a path", async () => {
    // Extract needs no model, so it goes to fast — routing it to heavy would
    // cold-start the 191s service just to unzip.
    process.env.NEONBINDER_PREPROCESS_FAST_URL = "http://localhost:7777";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(EXTRACT_OK), { status: 200 });
    });

    const result = await callExtract(stubCtx(), { jobId: "job-1", userId: "user_x" });

    expect(result.accepted_count).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:7777/extract");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ job_id: "job-1", user_id: "user_x" });
    // The hard rule from schema.ts: no object path crosses this boundary.
    expect(JSON.stringify(body)).not.toContain("placeholders/");
  });

  test("callProcessEntryFast hits the FAST url; callProcessEntryHeavy hits the HEAVY url", async () => {
    // The core of the split: the same request body, two services, chosen by which
    // function you call. Set both vars to distinct hosts and prove each routes.
    process.env.NEONBINDER_PREPROCESS_FAST_URL = "http://localhost:7777";
    process.env.NEONBINDER_PREPROCESS_URL = "http://localhost:9998";
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(PROCESS_OK), { status: 200 });
    });

    await callProcessEntryFast(stubCtx(), { jobId: "job-1", userId: "u", entryIndex: 3 });
    await callProcessEntryHeavy(stubCtx(), { jobId: "job-1", userId: "u", entryIndex: 3 });

    expect(calls).toEqual([
      "http://localhost:7777/process-entry",
      "http://localhost:9998/process-entry",
    ]);
  });

  test("callProcessEntryFast posts job_id/user_id/entry_index and surfaces needs_escalation", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    stubFetch(async (_url, init) => {
      calls.push({ init });
      return new Response(JSON.stringify(PROCESS_DECLINED), { status: 200 });
    });

    const result = await callProcessEntryFast(stubCtx(), {
      jobId: "job-1",
      userId: "user_x",
      entryIndex: 3,
    });

    // A decline is an ordinary 200 the adapter passes through untouched — the
    // routing decision belongs to the settle, not here.
    expect(result.needs_escalation).toBe(true);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      job_id: "job-1",
      user_id: "user_x",
      entry_index: 3,
    });
  });

  test("a completed fast crop carries needs_escalation: false", async () => {
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));
    const result = await callProcessEntryFast(stubCtx(), {
      jobId: "job-1",
      userId: "u",
      entryIndex: 0,
    });
    expect(result.needs_escalation).toBe(false);
    expect(result.dhash).toBe("0f1e2d3c4b5a6978");
  });

  test("sends x-internal-key when configured, and omits it when not", async () => {
    // Both auth halves ship during the transition; the key half dies with the
    // IAM flip in a follow-up.
    const seen: Array<Record<string, string>> = [];
    stubFetch(async (_url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify(EXTRACT_OK), { status: 200 });
    });

    await callExtract(stubCtx(), { jobId: "j", userId: "u" });
    expect(seen[0]["x-internal-key"]).toBeUndefined();
    expect(seen[0]["Content-Type"]).toBe("application/json");

    process.env.NEONBINDER_PREPROCESS_INTERNAL_KEY = "shhh";
    await callExtract(stubCtx(), { jobId: "j", userId: "u" });
    expect(seen[1]["x-internal-key"]).toBe("shhh");
  });
});

describe("error taxonomy — terminal statuses stop the pool immediately", () => {
  test.each([400, 401, 403, 404, 413, 415, 422])(
    "HTTP %i throws a NonRetryableError",
    async (status) => {
      stubFetch(async () => errorResponse(status, { error_code: "ZIP_REJECTED" }));
      const err = await captureThrow(() =>
        callExtract(stubCtx(), { jobId: "j", userId: "u" }),
      );
      expect(isNonRetryableError(err)).toBe(true);
      expect(String((err as Error).message)).toContain(String(status));
    },
  );

  test("the same taxonomy applies to the fast /process-entry", async () => {
    stubFetch(async () => errorResponse(404, { error_code: "INPUT_NOT_FOUND" }));
    const err = await captureThrow(() =>
      callProcessEntryFast(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
    );
    expect(isNonRetryableError(err)).toBe(true);
  });

  test("and to the heavy /process-entry", async () => {
    stubFetch(async () => errorResponse(422, { error_code: "ZIP_REJECTED" }));
    const err = await captureThrow(() =>
      callProcessEntryHeavy(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
    );
    expect(isNonRetryableError(err)).toBe(true);
  });
});

describe("error taxonomy — transient statuses are retryable", () => {
  test.each([429, 500, 502, 503, 504])("HTTP %i throws a plain Error", async (status) => {
    stubFetch(async () => errorResponse(status, { error_code: "EXTRACT_NOT_CONFIGURED" }));
    const err = await captureThrow(() =>
      callProcessEntryFast(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(isNonRetryableError(err)).toBe(false);
  });

  test("Cloud Run's own non-JSON 429 is still retryable", async () => {
    // Cloud Run sheds with an HTML body, so the code parse finds nothing —
    // retryability must come from the status alone.
    stubFetch(
      async () => new Response("<html>Too Many Requests</html>", { status: 429 }),
    );
    const err = await captureThrow(() =>
      callProcessEntryFast(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
    );
    expect(isNonRetryableError(err)).toBe(false);
  });

  test("a network failure is retryable", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await captureThrow(() =>
      callExtract(stubCtx(), { jobId: "j", userId: "u" }),
    );
    expect(isNonRetryableError(err)).toBe(false);
    expect((err as Error).message).toContain("network");
  });

  test("an aborted (timed-out) request is retryable and says so", async () => {
    stubFetch(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });
    const err = await captureThrow(() =>
      callProcessEntryHeavy(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
    );
    expect(isNonRetryableError(err)).toBe(false);
    expect((err as Error).message).toContain("timed out");
  });

  test("a 200 with a non-JSON body is retryable, not silently accepted", async () => {
    stubFetch(async () => new Response("not json", { status: 200 }));
    const err = await captureThrow(() =>
      callExtract(stubCtx(), { jobId: "j", userId: "u" }),
    );
    expect(isNonRetryableError(err)).toBe(false);
  });
});

describe("telemetry", () => {
  test("the capture is SCHEDULED at delay 0, never run inline as an action (NEO-315)", async () => {
    // The inline `runAction(captureEvent)` was a Node action hop plus an HTTPS
    // flush held inside every fast/heavy pool slot. Scheduling it is the fix;
    // a `runAction` here is the regression.
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));
    await callProcessEntryFast(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 });
    await callProcessEntryHeavy(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 });

    expect(runActionCalls).toBe(0);
    expect(scheduled).toEqual([
      [0, "posthog:captureEvent"],
      [0, "posthog:captureEvent"],
    ]);
  });

  test("a PostHog hop that would hang cannot hold the pool slot", async () => {
    // Under the old inline `runAction`, a capture whose flush never returned
    // held the whole call. Model that hop as a promise that never settles: the
    // call must still return, because the only thing it awaits is the enqueue.
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));
    const ctx = {
      auth: { getUserIdentity: async () => null },
      runAction: () => {
        runActionCalls++;
        return new Promise(() => {});
      },
      scheduler: { runAfter: async () => "scheduled-id" },
    } as unknown as ActionCtx;

    const result = await callProcessEntryFast(ctx, { jobId: "j", userId: "u", entryIndex: 0 });
    expect(result.needs_escalation).toBe(false);
    expect(runActionCalls).toBe(0);
  });

  test("distinctId is resolved from the caller's identity BEFORE scheduling", async () => {
    // A scheduled function runs with no auth context, so the id has to travel
    // in the args or every event would read "anonymous".
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));
    await callProcessEntryFast(stubCtx({ subject: "user_abc" }), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
    });
    await callProcessEntryFast(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 });

    expect(captured.map((c) => c.distinctId)).toEqual(["user_abc", "anonymous"]);
  });

  test("a scheduler failure is swallowed — telemetry cannot fail the call it observes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));
    const ctx = {
      auth: { getUserIdentity: async () => null },
      scheduler: {
        runAfter: async () => {
          throw new Error("scheduler down");
        },
      },
    } as unknown as ActionCtx;

    await expect(
      callProcessEntryFast(ctx, { jobId: "j", userId: "u", entryIndex: 0 }),
    ).resolves.toMatchObject({ needs_escalation: false });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  test("with PostHog unconfigured nothing is scheduled, but the console line still lands", async () => {
    delete process.env.POSTHOG_API_KEY;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));

    await callProcessEntryFast(stubCtx(), { jobId: "job-q", userId: "u", entryIndex: 2 });

    expect(scheduled).toEqual([]);
    const lines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"msg":"adapter_sync_call"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      operation: "preprocessProcessEntryFast",
      jobId: "job-q",
      entryIndex: 2,
      success: true,
    });
    log.mockRestore();
  });

  test("every request emits an adapter_sync_call, success or failure", async () => {
    stubFetch(async () => new Response(JSON.stringify(EXTRACT_OK), { status: 200 }));
    await callExtract(stubCtx(), { jobId: "j", userId: "u" });

    expect(captured).toHaveLength(1);
    expect(captured[0].event).toBe("adapter_sync_call");
    expect(captured[0].properties.platform).toBe("preprocess");
    expect(captured[0].properties.operation).toBe("preprocessExtract");
    expect(captured[0].properties.success).toBe(true);
    expect(captured[0].properties.status_code).toBe(200);
    expect(captured[0].properties.stage).toBe("preprocess_call");
  });

  test("fast and heavy process-entry are tagged with distinct operations", async () => {
    // The dashboard has to be able to separate fast load from heavy load — the
    // two services scale independently and "which one is saturated" is the whole
    // question.
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));
    await callProcessEntryFast(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 });
    await callProcessEntryHeavy(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 });

    expect(captured.map((e) => e.properties.operation)).toEqual([
      "preprocessProcessEntryFast",
      "preprocessProcessEntryHeavy",
    ]);
  });

  test("a 429 is bucketed as rate_limited — the signal that pool parallelism has drifted above capacity", async () => {
    stubFetch(async () => errorResponse(429, {}));
    await captureThrow(() =>
      callProcessEntryFast(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].properties.success).toBe(false);
    expect(captured[0].properties.status_code).toBe(429);
    expect(captured[0].properties.error_class).toBe("rate_limited");
  });

  test("a network failure records no status code but still reports", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await captureThrow(() => callExtract(stubCtx(), { jobId: "j", userId: "u" }));

    expect(captured).toHaveLength(1);
    expect(captured[0].properties.success).toBe(false);
    expect(captured[0].properties.status_code).toBeUndefined();
    expect(captured[0].properties.error_class).toBe("network");
  });

  test("process-entry telemetry carries jobId + entryIndex so a slow call joins to its image (NEO-170)", async () => {
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));
    await callProcessEntryFast(stubCtx(), {
      jobId: "job-abc",
      userId: "u",
      entryIndex: 7,
    });

    expect(captured).toHaveLength(1);
    // Correlation for the PostHog join — the exact placeholderImages row.
    expect(captured[0].properties.jobId).toBe("job-abc");
    expect(captured[0].properties.entryIndex).toBe(7);
    // Still no path or PII crossing into telemetry.
    expect(JSON.stringify(captured[0].properties)).not.toContain("placeholders/");
  });

  test("extract telemetry carries the jobId but no entryIndex — it is a per-batch call", async () => {
    stubFetch(async () => new Response(JSON.stringify(EXTRACT_OK), { status: 200 }));
    await callExtract(stubCtx(), { jobId: "job-xyz", userId: "u" });

    expect(captured[0].properties.jobId).toBe("job-xyz");
    expect(captured[0].properties.entryIndex).toBeUndefined();
  });

  test("warmup telemetry omits both correlation fields — it belongs to no batch", async () => {
    stubFetch(async () => new Response("{}", { status: 200 }));
    await callWarmupFast(stubCtx());

    const warmup = captured.find(
      (e) => (e.properties as { operation?: string }).operation === "preprocessWarmupFast",
    );
    expect(warmup?.properties.jobId).toBeUndefined();
    expect(warmup?.properties.entryIndex).toBeUndefined();
  });
});

describe("parsePreprocessErrorCode", () => {
  test("recovers the service code from the flattened error message", () => {
    // The code has to survive the workpool's error → string flattening; the
    // message is the only channel that does.
    expect(parsePreprocessErrorCode("preprocess ZIP_REJECTED (HTTP 422): bad zip")).toBe(
      "ZIP_REJECTED",
    );
    expect(parsePreprocessErrorCode("preprocess INPUT_TOO_LARGE (HTTP 413)")).toBe(
      "INPUT_TOO_LARGE",
    );
  });

  test("returns undefined when the response carried no code", () => {
    expect(parsePreprocessErrorCode("preprocess HTTP 429: <html>")).toBeUndefined();
    expect(parsePreprocessErrorCode("something else entirely")).toBeUndefined();
  });

  test("round-trips the wire shape the service actually emits", async () => {
    // services/preprocess/app/main.py returns errors as a TOP-LEVEL
    // `error_code` next to human `detail`/`reason` fields. Pin the full path:
    // wire body → thrown message → parsePreprocessErrorCode.
    stubFetch(async () =>
      errorResponse(422, { error_code: "ZIP_REJECTED", reason: "entry count", retryable: false }),
    );
    const err = await captureThrow(() => callExtract(stubCtx(), { jobId: "j", userId: "u" }));
    expect(parsePreprocessErrorCode((err as Error).message)).toBe("ZIP_REJECTED");
  });

  test("the thrown message carries the upstream body — which is why the job must not", async () => {
    // This is deliberate and it is the reason placeholderBatch.ts derives its
    // own `errorDetail` instead of storing the message: a log line wants the
    // body, and `errorDetail` is served to the browser by a public query. Both
    // halves are pinned, here and in convex/placeholderPipeline.test.ts, so
    // neither can drift into the other's job.
    stubFetch(
      async () =>
        new Response("<html><body>internal-host-9f2c.run.internal</body></html>", {
          status: 503,
        }),
    );
    const err = await captureThrow(() => callExtract(stubCtx(), { jobId: "j", userId: "u" }));
    expect((err as Error).message).toContain("run.internal");
  });

  test("a human-readable detail string is never mistaken for a code", async () => {
    // INVALID_IDENTIFIER bodies carry `detail: str(exc)` — prose, not a code.
    // Without the SCREAMING_SNAKE guard that prose would leak into the message
    // slot the parser reads.
    stubFetch(async () =>
      errorResponse(400, { detail: "job_id must be a UUID, got 'nope'" }),
    );
    const err = await captureThrow(() => callExtract(stubCtx(), { jobId: "j", userId: "u" }));
    expect(parsePreprocessErrorCode((err as Error).message)).toBeUndefined();
    expect((err as Error).message).toContain("HTTP 400");
  });
});

describe("callWarmupFast / callWarmupHeavy — best-effort, never throw", () => {
  test("fast warmup posts to the FAST /warmup and returns warmed on 2xx", async () => {
    process.env.NEONBINDER_PREPROCESS_FAST_URL = "http://localhost:7777";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ status: "warm" }), { status: 200 });
    });

    const result = await callWarmupFast(stubCtx());

    expect(result).toEqual({ warmed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:7777/warmup");
    expect(calls[0].init?.method).toBe("POST");

    const warmupEvents = captured.filter(
      (e) => (e.properties as { operation?: string }).operation === "preprocessWarmupFast",
    );
    expect(warmupEvents).toHaveLength(1);
    expect((warmupEvents[0].properties as { success?: boolean }).success).toBe(true);
  });

  test("heavy warmup posts to the HEAVY /warmup and is tagged distinctly", async () => {
    process.env.NEONBINDER_PREPROCESS_FAST_URL = "http://localhost:7777";
    process.env.NEONBINDER_PREPROCESS_URL = "http://localhost:9998";
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ status: "warm" }), { status: 200 });
    });

    const result = await callWarmupHeavy(stubCtx());

    expect(result).toEqual({ warmed: true });
    // Heavy warm-up goes to the heavy service, NOT the fast one.
    expect(calls).toEqual(["http://localhost:9998/warmup"]);
    const warmupEvents = captured.filter(
      (e) => (e.properties as { operation?: string }).operation === "preprocessWarmupHeavy",
    );
    expect(warmupEvents).toHaveLength(1);
  });

  test("sends the internal-key header when configured", async () => {
    process.env.NEONBINDER_PREPROCESS_INTERNAL_KEY = "secret-key";
    const calls: Array<{ init?: RequestInit }> = [];
    stubFetch(async (_url, init) => {
      calls.push({ init });
      return new Response("{}", { status: 200 });
    });

    await callWarmupFast(stubCtx());

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["x-internal-key"]).toBe("secret-key");
  });

  test("swallows a throwing fetch — logs, does not propagate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(async () => {
      throw new TypeError("network is down");
    });

    // The whole contract: no throw reaches the caller.
    await expect(callWarmupHeavy(stubCtx())).resolves.toEqual({ warmed: false });
    expect(warn).toHaveBeenCalled();

    const warmupEvents = captured.filter(
      (e) => (e.properties as { operation?: string }).operation === "preprocessWarmupHeavy",
    );
    expect(warmupEvents).toHaveLength(1);
    expect((warmupEvents[0].properties as { success?: boolean }).success).toBe(false);
    warn.mockRestore();
  });

  test("swallows a non-2xx response — returns not-warmed without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(async () => new Response("service starting", { status: 503 }));

    await expect(callWarmupFast(stubCtx())).resolves.toEqual({ warmed: false });
    warn.mockRestore();

    const warmupEvents = captured.filter(
      (e) => (e.properties as { operation?: string }).operation === "preprocessWarmupFast",
    );
    expect((warmupEvents[0].properties as { success?: boolean }).success).toBe(false);
  });

  test("swallows a telemetry failure too — recordAdapterCall throwing cannot fail warmup", async () => {
    // The belt-and-suspenders `.catch(() => {})` on the record call: even if the
    // observability path throws, a warmup must not.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(async () => new Response("{}", { status: 200 }));
    const ctx = {
      auth: {
        getUserIdentity: async () => {
          throw new Error("auth down");
        },
      },
      scheduler: {
        runAfter: async () => {
          throw new Error("posthog down");
        },
      },
    } as unknown as ActionCtx;

    await expect(callWarmupFast(ctx)).resolves.toEqual({ warmed: true });
    error.mockRestore();
  });
});

describe("per-call fetch timeouts (NEO-299)", () => {
  // Each call's abort budget is threaded straight into `AbortSignal.timeout`,
  // which is what actually bounds the fetch. Spying on the static factory
  // proves the number reaching the network is the one the comment claims —
  // reading the request itself can't observe a signal's timeout value.
  function spyOnAbortTimeout() {
    return vi.spyOn(AbortSignal, "timeout");
  }

  test("callWarmupHeavy uses the 330s heavy warm-up budget, not the fast one", async () => {
    const timeoutSpy = spyOnAbortTimeout();
    stubFetch(async () => new Response("{}", { status: 200 }));

    await callWarmupHeavy(stubCtx());

    expect(timeoutSpy).toHaveBeenCalledWith(330_000);
    timeoutSpy.mockRestore();
  });

  test("callWarmupFast uses the 60s fast warm-up budget", async () => {
    const timeoutSpy = spyOnAbortTimeout();
    stubFetch(async () => new Response("{}", { status: 200 }));

    await callWarmupFast(stubCtx());

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(timeoutSpy).not.toHaveBeenCalledWith(330_000);
    timeoutSpy.mockRestore();
  });

  test("callProcessEntryHeavy uses the 400s heavy process-entry budget", async () => {
    const timeoutSpy = spyOnAbortTimeout();
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));

    await callProcessEntryHeavy(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 });

    expect(timeoutSpy).toHaveBeenCalledWith(400_000);
    timeoutSpy.mockRestore();
  });

  test("callProcessEntryFast uses the 60s fast process-entry budget, not heavy's", async () => {
    const timeoutSpy = spyOnAbortTimeout();
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));

    await callProcessEntryFast(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 });

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(timeoutSpy).not.toHaveBeenCalledWith(400_000);
    timeoutSpy.mockRestore();
  });
});

describe("escalation hints — FAST decline baseline + dhash (NEO-315 D4)", () => {
  const WIRE_BASELINE = { rotation_degrees: 90, confidence: 0.75, text_count: 42 };
  const DECLINE_WITH_HINTS = {
    ...PROCESS_DECLINED,
    baseline: WIRE_BASELINE,
    dhash: "a1b2c3d4e5f60718",
  };

  test("a decline's baseline is parsed and camelCased; its dhash comes through", async () => {
    stubFetch(async () => new Response(JSON.stringify(DECLINE_WITH_HINTS), { status: 200 }));
    const result = await callProcessEntryFast(stubCtx(), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
    });

    expect(result.needs_escalation).toBe(true);
    expect(result.baseline).toEqual({
      rotationDegrees: 90,
      orientConfidence: 0.75,
      textCount: 42,
    });
    expect(result.dhash).toBe("a1b2c3d4e5f60718");
  });

  test("an older revision that sends neither field reads as no hints, not an error", async () => {
    // PROCESS_DECLINED is the pre-NEO-315 decline body: no `baseline` key at all.
    stubFetch(async () => new Response(JSON.stringify(PROCESS_DECLINED), { status: 200 }));
    const result = await callProcessEntryFast(stubCtx(), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
    });

    expect(result.needs_escalation).toBe(true);
    expect(result.baseline).toBeNull();
    expect(result.dhash).toBeNull();
    expect(readEscalationHints(result)).toEqual({});
  });

  test("an explicit null baseline is no hint", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ ...PROCESS_DECLINED, baseline: null, dhash: null }), {
          status: 200,
        }),
    );
    const result = await callProcessEntryFast(stubCtx(), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
    });
    expect(result.baseline).toBeNull();
    expect(readEscalationHints(result)).toEqual({});
  });

  test.each([
    ["a non-quadrant rotation", { ...WIRE_BASELINE, rotation_degrees: 45 }],
    ["a string rotation", { ...WIRE_BASELINE, rotation_degrees: "90" }],
    ["a confidence above 1", { ...WIRE_BASELINE, confidence: 1.5 }],
    ["a NaN-ish confidence", { ...WIRE_BASELINE, confidence: "high" }],
    ["a fractional text count", { ...WIRE_BASELINE, text_count: 4.5 }],
    ["a negative text count", { ...WIRE_BASELINE, text_count: -1 }],
    ["a missing field", { rotation_degrees: 0, confidence: 0.5 }],
    ["the camelCase shape on the wire", { rotationDegrees: 0, orientConfidence: 0.5, textCount: 3 }],
    ["an array", [0, 0.5, 3]],
  ])("a malformed baseline (%s) is dropped, not trusted", async (_label, baseline) => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ ...PROCESS_DECLINED, baseline }), { status: 200 }),
    );
    const result = await callProcessEntryFast(stubCtx(), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
    });
    // Still a decline — a bad hint costs only the hint.
    expect(result.needs_escalation).toBe(true);
    expect(result.baseline).toBeNull();
  });

  test.each(["A1B2C3D4E5F60718", "a1b2c3", "zzzzzzzzzzzzzzzz", 12345])(
    "a malformed dhash (%s) becomes null",
    async (dhash) => {
      stubFetch(
        async () =>
          new Response(JSON.stringify({ ...PROCESS_DECLINED, dhash }), { status: 200 }),
      );
      const result = await callProcessEntryFast(stubCtx(), {
        jobId: "j",
        userId: "u",
        entryIndex: 0,
      });
      expect(result.dhash).toBeNull();
    },
  );

  test("a completed crop passes its fields through untouched apart from the hints", async () => {
    stubFetch(async () => new Response(JSON.stringify(PROCESS_OK), { status: 200 }));
    const result = await callProcessEntryFast(stubCtx(), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
    });
    expect(result).toEqual({ ...PROCESS_OK, baseline: null });
  });

  test("readEscalationHints reads both off a settled fast result (the workpool's returnValue)", async () => {
    stubFetch(async () => new Response(JSON.stringify(DECLINE_WITH_HINTS), { status: 200 }));
    const result = await callProcessEntryFast(stubCtx(), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
    });
    // The value crosses the workpool as JSON; read it the way the settle does.
    const settled: unknown = JSON.parse(JSON.stringify(result));

    expect(readEscalationHints(settled)).toEqual({
      baseline: { rotationDegrees: 90, orientConfidence: 0.75, textCount: 42 },
      dhash: "a1b2c3d4e5f60718",
    });
  });

  test("readEscalationHints never throws and never invents a hint", () => {
    expect(readEscalationHints(undefined)).toEqual({});
    expect(readEscalationHints(null)).toEqual({});
    expect(readEscalationHints("nope")).toEqual({});
    expect(readEscalationHints({ baseline: WIRE_BASELINE })).toEqual({});
    expect(
      readEscalationHints({
        baseline: { rotationDegrees: 180, orientConfidence: 0.5, textCount: 3, extra: "x" },
      }),
    ).toEqual({ baseline: { rotationDegrees: 180, orientConfidence: 0.5, textCount: 3 } });
  });

  test("the heavy request carries both hints, snake_case, when present", async () => {
    const bodies: unknown[] = [];
    stubFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(PROCESS_OK), { status: 200 });
    });

    await callProcessEntryHeavy(stubCtx(), {
      jobId: "job-1",
      userId: "user_x",
      entryIndex: 4,
      baseline: { rotationDegrees: 270, orientConfidence: 0.6, textCount: 12 },
      dhash: "0f1e2d3c4b5a6978",
    });

    expect(bodies[0]).toEqual({
      job_id: "job-1",
      user_id: "user_x",
      entry_index: 4,
      baseline: { rotation_degrees: 270, confidence: 0.6, text_count: 12 },
      dhash: "0f1e2d3c4b5a6978",
    });
  });

  test("without hints the heavy request is byte-for-byte the pre-NEO-315 request", async () => {
    // An older heavy revision must see exactly what it always saw — no
    // `baseline: null`, no `dhash: null`.
    const bodies: unknown[] = [];
    stubFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(PROCESS_OK), { status: 200 });
    });

    await callProcessEntryHeavy(stubCtx(), { jobId: "job-1", userId: "user_x", entryIndex: 4 });
    await callProcessEntryHeavy(stubCtx(), {
      jobId: "job-1",
      userId: "user_x",
      entryIndex: 4,
      ...readEscalationHints(PROCESS_DECLINED),
    });

    for (const body of bodies) {
      expect(body).toEqual({ job_id: "job-1", user_id: "user_x", entry_index: 4 });
    }
  });

  test("each hint is sent independently, and a malformed one is left out", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(PROCESS_OK), { status: 200 });
    });

    await callProcessEntryHeavy(stubCtx(), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
      dhash: "0f1e2d3c4b5a6978",
    });
    await callProcessEntryHeavy(stubCtx(), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
      baseline: { rotationDegrees: 0, orientConfidence: 0.9, textCount: 30 },
    });
    // Forwarding garbage could fail the heavy request's validation and the
    // image with it, for the sake of a shortcut. Drop it instead.
    await callProcessEntryHeavy(stubCtx(), {
      jobId: "j",
      userId: "u",
      entryIndex: 0,
      baseline: { rotationDegrees: 33, orientConfidence: 0.9, textCount: 30 },
      dhash: "not-a-hash",
    });

    expect(bodies[0]).toHaveProperty("dhash", "0f1e2d3c4b5a6978");
    expect(bodies[0]).not.toHaveProperty("baseline");
    expect(bodies[1]).toHaveProperty("baseline", {
      rotation_degrees: 0,
      confidence: 0.9,
      text_count: 30,
    });
    expect(bodies[1]).not.toHaveProperty("dhash");
    expect(bodies[2]).toEqual({ job_id: "j", user_id: "u", entry_index: 0 });
  });
});
