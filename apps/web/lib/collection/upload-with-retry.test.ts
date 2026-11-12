import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  attemptTimeoutMs,
  PhotoUploadError,
  stallWindowMs,
  STALL_WINDOWS_MS,
  uploadWithRetry,
  type PhotoUploadRequest,
  type UploadAttempt,
} from "./upload-with-retry";
import type { UploadTransport, UploadTransportRequest } from "./xhr-transport";

const PRIMARY = "https://photos.example/copy/abc?X-Amz-Signature=secret";
const RETRY = "https://bucket.photos.example/copy/abc?X-Amz-Signature=other";
const MESSAGE = "That photo didn't upload. Check your connection and try again.";
const BYTES = 12;
/** The hard cap of the 12-byte body `request()` sends. */
const CAP_MS = attemptTimeoutMs(BYTES);

const request = (over: Partial<PhotoUploadRequest> = {}): PhotoUploadRequest => ({
  url: PRIMARY,
  retryUrl: RETRY,
  method: "PUT",
  headers: { "content-type": "image/jpeg" },
  body: new Blob([new Uint8Array(BYTES)], { type: "image/jpeg" }),
  file: "image",
  failureMessage: MESSAGE,
  ...over,
});

/** What a scripted try does: answer with a status, throw, or hang until aborted. */
type Step = number | { status: number; body: string } | Error | "hang";

const abortRejection = () => new DOMException("aborted", "AbortError");

/** A transport that plays `steps` in order and records every call. */
function scriptedTransport(...steps: Step[]) {
  const queue = [...steps];
  const calls: UploadTransportRequest[] = [];
  const transport: UploadTransport = (req) => {
    calls.push(req);
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error("transport called more often than the test expected"));
    if (next === "hang") {
      return new Promise((_resolve, reject) => {
        if (req.signal.aborted) reject(abortRejection());
        req.signal.addEventListener("abort", () => reject(abortRejection()), { once: true });
      });
    }
    if (next instanceof Error) return Promise.reject(next);
    if (typeof next === "number") return Promise.resolve({ status: next, body: "" });
    return Promise.resolve(next);
  };
  return { transport, calls };
}

describe("uploadWithRetry (NEO-431, NEO-466)", () => {
  let warn: MockInstance<typeof console.warn>;
  const wait = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});

  /** The `copy_photo_put_failed` lines, parsed. */
  const logged = () =>
    warn.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes("copy_photo_put_failed"))
      .map((line) => JSON.parse(line));

  beforeEach(() => {
    wait.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  const run = (req: PhotoUploadRequest, transport: UploadTransport, onAttempt?: (a: UploadAttempt) => void) =>
    uploadWithRetry(req, { wait, transport, onAttempt });

  describe("answers", () => {
    it("hands the transport the request as given and returns the answer, without waiting or logging", async () => {
      const { transport, calls } = scriptedTransport({ status: 200, body: '{"storageId":"s1"}' });
      const req = request();
      const res = await run(req, transport);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ storageId: "s1" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: PRIMARY, method: "PUT", headers: req.headers, body: req.body });
      expect(calls[0].signal).toBeInstanceOf(AbortSignal);
      expect(calls[0].onProgress).toEqual(expect.any(Function));
      expect(wait).not.toHaveBeenCalled();
      expect(logged()).toEqual([]);
    });

    it("returns a 204 as a response with no body", async () => {
      const { transport } = scriptedTransport(204);
      const res = await run(request(), transport);
      expect(res.status).toBe(204);
      expect(res.body).toBeNull();
    });

    it("returns a 200 with an empty body as readable text", async () => {
      const { transport } = scriptedTransport(200);
      const res = await run(request(), transport);
      expect(await res.text()).toBe("");
    });

    it("never retries a 403, and the error carries it", async () => {
      const { transport, calls } = scriptedTransport(403);
      const error = await run(request(), transport).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PhotoUploadError);
      expect(error).toMatchObject({ status: 403, message: MESSAGE });
      expect(calls).toHaveLength(1);
      expect(wait).not.toHaveBeenCalled();
      expect(logged()).toEqual([
        { event: "copy_photo_put_failed", method: "PUT", status: 403, attempts: 1, file: "image", size: BYTES },
      ]);
    });

    it("does not retry an error that isn't the network's", async () => {
      const { transport, calls } = scriptedTransport(new RangeError("not a network failure"));
      await expect(run(request(), transport)).rejects.toThrow(new RangeError("not a network failure"));
      expect(calls).toHaveLength(1);
      expect(logged()).toEqual([]);
    });
  });

  describe("5xx and 429", () => {
    it("retries a 503 on the same host after a 500 ms backoff, then succeeds", async () => {
      const { transport, calls } = scriptedTransport(503, 200);
      const res = await run(request(), transport);
      expect(res.status).toBe(200);
      expect(calls.map((c) => c.url)).toEqual([PRIMARY, PRIMARY]);
      expect(wait.mock.calls.map((c) => c[0])).toEqual([500]);
      expect(logged()).toEqual([]);
    });

    it("retries a 429 like a 5xx", async () => {
      const { transport, calls } = scriptedTransport(429, 200);
      await run(request(), transport);
      expect(calls.map((c) => c.url)).toEqual([PRIMARY, PRIMARY]);
    });

    it("gives up after 3 tries of a 503, backing off 500 then 1500, with the status on the error", async () => {
      const { transport, calls } = scriptedTransport(503, 503, 503);
      const error = await run(request({ file: "thumb" }), transport).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 503, message: MESSAGE });
      expect(calls).toHaveLength(3);
      expect(wait.mock.calls.map((c) => c[0])).toEqual([500, 1500]);
      expect(logged()).toEqual([
        { event: "copy_photo_put_failed", method: "PUT", status: 503, attempts: 3, file: "thumb", size: BYTES },
      ]);
    });

    it("stays on the retry host once a stall has switched to it", async () => {
      vi.useFakeTimers();
      const { transport, calls } = scriptedTransport("hang", 503, 200);
      const uploading = run(request(), transport);
      await vi.advanceTimersByTimeAsync(STALL_WINDOWS_MS[0]);
      expect((await uploading).status).toBe(200);
      expect(calls.map((c) => c.url)).toEqual([PRIMARY, RETRY, RETRY]);
    });
  });

  describe("network errors", () => {
    it("retries after a 500 ms backoff on the retry URL, then succeeds", async () => {
      const { transport, calls } = scriptedTransport(new TypeError("Network request failed"), 200);
      const res = await run(request(), transport);
      expect(res.status).toBe(200);
      expect(calls.map((c) => c.url)).toEqual([PRIMARY, RETRY]);
      expect(wait.mock.calls.map((c) => c[0])).toEqual([500]);
    });

    it("treats a status 0 answer as a network error", async () => {
      const { transport, calls } = scriptedTransport(0, 200);
      await run(request(), transport);
      expect(calls.map((c) => c.url)).toEqual([PRIMARY, RETRY]);
    });

    it("stays on the primary URL when the request has no retry URL", async () => {
      const { transport, calls } = scriptedTransport(new TypeError("x"), 200);
      await run(request({ retryUrl: undefined }), transport);
      expect(calls.map((c) => c.url)).toEqual([PRIMARY, PRIMARY]);
    });

    it("gives the caller's message and a null status after 3 failures, logging no stall", async () => {
      const boom = () => new TypeError("Network request failed");
      const { transport, calls } = scriptedTransport(boom(), boom(), boom());
      const error = await run(request(), transport).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PhotoUploadError);
      expect(error).toMatchObject({ status: null, message: MESSAGE });
      expect(calls.map((c) => c.url)).toEqual([PRIMARY, RETRY, RETRY]);
      expect(wait.mock.calls.map((c) => c[0])).toEqual([500, 1500]);
      expect(logged()).toEqual([
        { event: "copy_photo_put_failed", method: "PUT", status: null, attempts: 3, file: "image", size: BYTES },
      ]);
    });
  });

  describe("stall detection", () => {
    beforeEach(() => vi.useFakeTimers());

    it("aborts a try with no progress at 2.5 s and starts the next at once on the retry URL, with no wait", async () => {
      const { transport, calls } = scriptedTransport("hang", 200);
      const uploading = run(request(), transport);

      await vi.advanceTimersByTimeAsync(STALL_WINDOWS_MS[0] - 1);
      expect(calls).toHaveLength(1);
      expect(calls[0].signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls[0].signal.aborted).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1].url).toBe(RETRY);
      expect(calls[1].signal.aborted).toBe(false);
      expect(wait).not.toHaveBeenCalled();

      expect((await uploading).status).toBe(200);
      expect(logged()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("never aborts a try that makes progress every second for ten seconds", async () => {
      const { transport, calls } = scriptedTransport("hang");
      const uploading = run(request(), transport);
      for (let i = 1; i <= 10; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        calls[0].onProgress?.({ loaded: i, total: 100 });
      }
      expect(calls[0].signal.aborted).toBe(false);
      expect(calls).toHaveLength(1);
      // Clean up: the try is still pending; let the hard cap end it.
      uploading.catch(() => {});
      await vi.advanceTimersByTimeAsync(CAP_MS);
    });

    it("aborts after the window of silence that follows progress", async () => {
      const { transport, calls } = scriptedTransport("hang", 200);
      const uploading = run(request(), transport);
      await vi.advanceTimersByTimeAsync(2_000);
      calls[0].onProgress?.({ loaded: 5, total: 100 });
      await vi.advanceTimersByTimeAsync(STALL_WINDOWS_MS[0] - 1);
      expect(calls[0].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls[0].signal.aborted).toBe(true);
      await uploading;
    });

    it("aborts on silence after the last byte too, and names it no_answer", async () => {
      const attempts: UploadAttempt[] = [];
      const { transport, calls } = scriptedTransport("hang", 200);
      const uploading = run(request(), transport, (a) => attempts.push(a));
      await vi.advanceTimersByTimeAsync(500);
      calls[0].onProgress?.({ loaded: BYTES, total: BYTES });
      await vi.advanceTimersByTimeAsync(STALL_WINDOWS_MS[0]);
      expect(calls[0].signal.aborted).toBe(true);
      await uploading;
      expect(attempts[0]).toMatchObject({ attempt: 1, outcome: "stall", stall: "no_answer", host: "primary" });
    });

    it("names a stall before the last byte no_progress", async () => {
      const attempts: UploadAttempt[] = [];
      const { transport, calls } = scriptedTransport("hang", 200);
      const uploading = run(request(), transport, (a) => attempts.push(a));
      calls[0].onProgress?.({ loaded: 3, total: BYTES });
      await vi.advanceTimersByTimeAsync(STALL_WINDOWS_MS[0]);
      await uploading;
      expect(attempts[0]).toMatchObject({ outcome: "stall", stall: "no_progress" });
    });

    it("grows the window: 2.5 s, then 5 s, then the full cap", async () => {
      const { transport, calls } = scriptedTransport("hang", "hang", "hang");
      const uploading = run(request(), transport).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(2_500);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(CAP_MS - 1);
      expect(calls[2].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls[2].signal.aborted).toBe(true);
      await uploading;
    });

    it("ends a trickle that keeps resetting the stall timer at the hard cap", async () => {
      const { transport, calls } = scriptedTransport("hang", 200);
      const uploading = run(request({ stallWindowsMs: [3_000] }), transport);
      let loaded = 0;
      for (let t = 0; t < CAP_MS - 1_000; t += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000);
        calls[0].onProgress?.({ loaded: ++loaded % BYTES, total: 1_000_000 });
      }
      expect(calls[0].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls[0].signal.aborted).toBe(true);
      expect(calls).toHaveLength(2);
      expect((await uploading).status).toBe(200);
    });

    it("runs every try to the hard cap when stallWindowsMs is empty", async () => {
      const { transport, calls } = scriptedTransport("hang", 200);
      const uploading = run(request({ stallWindowsMs: [] }), transport);
      await vi.advanceTimersByTimeAsync(STALL_WINDOWS_MS[0] + STALL_WINDOWS_MS[1] + 1_000);
      expect(calls[0].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(CAP_MS);
      expect(calls[0].signal.aborted).toBe(true);
      expect((await uploading).status).toBe(200);
    });

    it("sizes the cap from the body", async () => {
      const big = new Blob([new Uint8Array(3_000_000)], { type: "image/jpeg" });
      const { transport, calls } = scriptedTransport("hang", 200);
      const uploading = run(request({ body: big, stallWindowsMs: [] }), transport);
      await vi.advanceTimersByTimeAsync(113_749);
      expect(calls[0].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls[0].signal.aborted).toBe(true);
      await uploading;
    });

    it("gives up after three stalls: null status, the caller's message, one log line with timedOut and stall", async () => {
      const { transport, calls } = scriptedTransport("hang", "hang", "hang");
      const uploading = run(request(), transport).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_500 + 5_000 + CAP_MS);
      expect(calls).toHaveLength(3);
      const error = await uploading;
      expect(error).toBeInstanceOf(PhotoUploadError);
      expect(error).toMatchObject({ status: null, message: MESSAGE });
      expect(wait).not.toHaveBeenCalled();
      expect(logged()).toEqual([
        {
          event: "copy_photo_put_failed",
          method: "PUT",
          status: null,
          attempts: 3,
          file: "image",
          size: BYTES,
          timedOut: true,
          stall: "no_progress",
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("says timedOut only when the last try is the one that stalled", async () => {
      const { transport } = scriptedTransport("hang", 503, 503);
      const answeredLast = run(request(), transport).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(STALL_WINDOWS_MS[0]);
      expect(await answeredLast).toMatchObject({ status: 503 });
      expect(logged()).toEqual([
        { event: "copy_photo_put_failed", method: "PUT", status: 503, attempts: 3, file: "image", size: BYTES },
      ]);
    });

    it("leaves alone an answer that arrives just inside the window, with no timer left behind", async () => {
      let respond: (r: { status: number; body: string }) => void = () => {};
      const calls: UploadTransportRequest[] = [];
      const transport: UploadTransport = (req) => {
        calls.push(req);
        return new Promise((resolve) => (respond = resolve));
      };
      const uploading = run(request(), transport);
      await vi.advanceTimersByTimeAsync(STALL_WINDOWS_MS[0] - 1);
      respond({ status: 200, body: "" });
      expect((await uploading).status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(CAP_MS);
      expect(calls[0].signal.aborted).toBe(false);
    });

    it("passes on an AbortError that isn't its own timer's, with no retry", async () => {
      const foreign = new DOMException("something else", "AbortError");
      const { transport, calls } = scriptedTransport(foreign);
      await expect(run(request(), transport)).rejects.toBe(foreign);
      expect(calls).toHaveLength(1);
      expect(logged()).toEqual([]);
    });

    it("uses the default wait of 500 ms real backoff when none is injected", async () => {
      const { transport, calls } = scriptedTransport(503, 200);
      const uploading = uploadWithRetry(request(), { transport });
      await vi.advanceTimersByTimeAsync(499);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await uploading).status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each<[string, Step[]]>([
      ["a refusal", [403]],
      ["a retried 503", [503, 200]],
      ["network failures", [new TypeError("a"), new TypeError("b"), new TypeError("c")]],
      ["an error that isn't the network's", [new RangeError("x")]],
      ["success", [200]],
    ])("leaves no timer behind after %s", async (_name, steps) => {
      const { transport } = scriptedTransport(...steps);
      await run(request(), transport).catch(() => {});
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("the caller's own abort", () => {
    beforeEach(() => vi.useFakeTimers());

    it("stops a running try at once: AbortError out, no log, no retry, no timer", async () => {
      const controller = new AbortController();
      const { transport, calls } = scriptedTransport("hang");
      const uploading = run(request({ signal: controller.signal }), transport).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      const error = await uploading;
      expect((error as Error).name).toBe("AbortError");
      expect(calls).toHaveLength(1);
      expect(logged()).toEqual([]);
      expect(wait).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects without sending when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { transport, calls } = scriptedTransport(200);
      const error = await run(request({ signal: controller.signal }), transport).catch((e: unknown) => e);
      expect((error as Error).name).toBe("AbortError");
      expect(calls).toHaveLength(0);
      expect(logged()).toEqual([]);
    });

    it("rejects with the signal's own reason when that is an error", async () => {
      const reason = new Error("the other file gave up");
      const controller = new AbortController();
      controller.abort(reason);
      const { transport } = scriptedTransport(200);
      await expect(run(request({ signal: controller.signal }), transport)).rejects.toBe(reason);
    });

    it("sends no further try when the caller aborts during a backoff", async () => {
      const controller = new AbortController();
      const abortingWait = vi.fn(async () => controller.abort());
      const { transport, calls } = scriptedTransport(503, 200);
      const error = await uploadWithRetry(request({ signal: controller.signal }), {
        wait: abortingWait,
        transport,
      }).catch((e: unknown) => e);
      expect((error as Error).name).toBe("AbortError");
      expect(calls).toHaveLength(1);
      expect(logged()).toEqual([]);
    });

    it("reports the try as aborted", async () => {
      const controller = new AbortController();
      const attempts: UploadAttempt[] = [];
      const { transport } = scriptedTransport("hang");
      const uploading = run(request({ signal: controller.signal }), transport, (a) => attempts.push(a)).catch(() => {});
      controller.abort();
      await uploading;
      expect(attempts).toEqual([expect.objectContaining({ attempt: 1, outcome: "aborted", status: null })]);
    });
  });

  describe("onAttempt and logs", () => {
    it("reports each try once with its outcome, status and host, in order", async () => {
      const attempts: UploadAttempt[] = [];
      const { transport } = scriptedTransport(503, new TypeError("x"), 200);
      await run(request(), transport, (a) => attempts.push(a));
      expect(attempts.map(({ attempt, outcome, status, host }) => ({ attempt, outcome, status, host }))).toEqual([
        { attempt: 1, outcome: "status", status: 503, host: "primary" },
        { attempt: 2, outcome: "network", status: null, host: "primary" },
        { attempt: 3, outcome: "ok", status: 200, host: "retry" },
      ]);
    });

    it("swallows an error thrown by onAttempt", async () => {
      const { transport } = scriptedTransport(200);
      const res = await run(request(), transport, () => {
        throw new Error("timing broke");
      });
      expect(res.status).toBe(200);
    });

    it("carries no URL in any log line or reported try", async () => {
      const attempts: UploadAttempt[] = [];
      const { transport } = scriptedTransport(503, new TypeError("x"), 503);
      const error = (await run(request(), transport, (a) => attempts.push(a)).catch((e: unknown) => e)) as Error;
      const everything = JSON.stringify([warn.mock.calls, attempts, error.message]);
      expect(logged()).toHaveLength(1);
      expect(everything).not.toContain("photos.example");
      expect(everything).not.toContain("X-Amz-Signature");
    });
  });
});

describe("attemptTimeoutMs (NEO-431)", () => {
  it.each([
    ["an empty body gets the floor", 0, 20_000],
    ["a 30 KB thumb", 30_000, 20_938],
    ["a 3 MB photo", 3_000_000, 113_750],
    ["the size that reaches the cap", 3_200_000, 120_000],
    ["one byte past it", 3_200_001, 120_000],
    ["the largest photo the server takes", 10 * 1024 * 1024, 120_000],
  ])("%s", (_name, bytes, expected) => {
    expect(attemptTimeoutMs(bytes)).toBe(expected);
  });
});

describe("stallWindowMs (NEO-466)", () => {
  it("is 2.5 s, then 5 s, then the full cap", () => {
    expect([1, 2, 3, 4].map((n) => stallWindowMs(n, 12))).toEqual([2_500, 5_000, 20_001, 20_001]);
  });
  it("takes another list, and an empty one means the cap every time", () => {
    expect(stallWindowMs(1, 12, [100])).toBe(100);
    expect(stallWindowMs(1, 12, [])).toBe(20_001);
  });
});
