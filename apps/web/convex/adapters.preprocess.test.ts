/**
 * Error-taxonomy tests for the preprocess adapter (NEO-170).
 *
 * The single thing worth testing here is which HTTP statuses become a
 * `NonRetryableError` and which become a plain `Error`, because that split IS
 * the retry policy: the workpool reads the thrown error and either stops
 * immediately or spends an attempt. Getting it backwards fails in two silent
 * ways — a permanently-broken zip burning 5×40s of capacity per image, or a
 * cold start being treated as a dead job.
 *
 * These call the adapter functions directly with a stub `ActionCtx` rather
 * than through convex-test. The functions use `ctx` only for `recordAdapterCall`
 * telemetry (which swallows its own failures), so a stub is both sufficient and
 * clearer about what is under test. The module is `"use node"` but runs here
 * under edge-runtime — the same arrangement the credentials tests use, and it
 * works because a loopback NEONBINDER_PREPROCESS_URL short-circuits the OIDC
 * path before google-auth-library is ever exercised.
 *
 * Filename note: dotted at the `convex/` root, matching
 * convex/adapters.placeholderUploads.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isNonRetryableError } from "@convex-dev/workpool";
import type { ActionCtx } from "./_generated/server";
import {
  callExtract,
  callProcessEntry,
  parsePreprocessErrorCode,
  preprocessUrl,
} from "./adapters/preprocess";

type CapturedEvent = { event: string; properties: Record<string, unknown> };

const captured: CapturedEvent[] = [];

/**
 * Minimal ActionCtx. `recordAdapterCall` reads `ctx.auth` (absent → the
 * "anonymous" branch) and calls `ctx.runAction(internal.posthog.captureEvent)`,
 * which is what we record.
 */
function stubCtx(): ActionCtx {
  return {
    runAction: async (_ref: unknown, args: CapturedEvent) => {
      captured.push(args);
      return null;
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
  // Loopback → getIdTokenClient short-circuits, so no OIDC and no GCP creds.
  process.env.NEONBINDER_PREPROCESS_URL = "http://localhost:9998";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEONBINDER_PREPROCESS_URL;
  delete process.env.NEONBINDER_PREPROCESS_INTERNAL_KEY;
});

describe("preprocessUrl", () => {
  test("defaults to port 8081, not the browser service's 8080", () => {
    // Both run locally during full-stack dev; 8080 would silently send
    // /extract to the browser service, which 404s and looks terminal.
    delete process.env.NEONBINDER_PREPROCESS_URL;
    expect(preprocessUrl()).toBe("http://localhost:8081");
  });

  test("honours NEONBINDER_PREPROCESS_URL", () => {
    process.env.NEONBINDER_PREPROCESS_URL = "https://preprocess.example.run.app";
    expect(preprocessUrl()).toBe("https://preprocess.example.run.app");
  });
});

describe("request shape", () => {
  test("callExtract posts job_id/user_id to /extract and never a path", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(EXTRACT_OK), { status: 200 });
    });

    const result = await callExtract(stubCtx(), { jobId: "job-1", userId: "user_x" });

    expect(result.accepted_count).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:9998/extract");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ job_id: "job-1", user_id: "user_x" });
    // The hard rule from schema.ts: no object path crosses this boundary.
    expect(JSON.stringify(body)).not.toContain("placeholders/");
  });

  test("callProcessEntry posts job_id/user_id/entry_index to /process-entry", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(PROCESS_OK), { status: 200 });
    });

    const result = await callProcessEntry(stubCtx(), {
      jobId: "job-1",
      userId: "user_x",
      entryIndex: 3,
    });

    expect(result.dhash).toBe("0f1e2d3c4b5a6978");
    expect(calls[0].url).toBe("http://localhost:9998/process-entry");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      job_id: "job-1",
      user_id: "user_x",
      entry_index: 3,
    });
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

  test("the same taxonomy applies to /process-entry", async () => {
    stubFetch(async () => errorResponse(404, { error_code: "INPUT_NOT_FOUND" }));
    const err = await captureThrow(() =>
      callProcessEntry(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
    );
    expect(isNonRetryableError(err)).toBe(true);
  });
});

describe("error taxonomy — transient statuses are retryable", () => {
  test.each([429, 500, 502, 503, 504])("HTTP %i throws a plain Error", async (status) => {
    stubFetch(async () => errorResponse(status, { error_code: "EXTRACT_NOT_CONFIGURED" }));
    const err = await captureThrow(() =>
      callProcessEntry(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
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
      callProcessEntry(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
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
      callProcessEntry(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
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

  test("a 429 is bucketed as rate_limited — the signal that pool parallelism has drifted above capacity", async () => {
    stubFetch(async () => errorResponse(429, {}));
    await captureThrow(() =>
      callProcessEntry(stubCtx(), { jobId: "j", userId: "u", entryIndex: 0 }),
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
