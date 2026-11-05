import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { attemptTimeoutMs, PhotoUploadError, uploadWithRetry, type PhotoUploadRequest } from "./upload-with-retry";

const SIGNED_URL = "https://photos.example/copy/abc?X-Amz-Signature=secret";
const MESSAGE = "That photo didn't upload. Check your connection and try again.";

const request = (over: Partial<PhotoUploadRequest> = {}): PhotoUploadRequest => ({
  url: SIGNED_URL,
  method: "PUT",
  headers: { "content-type": "image/jpeg" },
  body: new Blob([new Uint8Array(12)], { type: "image/jpeg" }),
  file: "image",
  failureMessage: MESSAGE,
  ...over,
});

const answer = (status: number) => new Response(null, { status });

/** A call that never answers: it settles only when its signal aborts, the way a browser's does. */
const STALL = Symbol("stall");

const stalled = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** `fetch` answering each call in turn: a status, an error to throw, or a stall. */
function stubFetch(...answers: (number | Error | typeof STALL)[]) {
  const queue = [...answers];
  const fetchMock = vi.fn(async (...[, init]: Parameters<typeof fetch>) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch called more often than the test expected");
    if (next === STALL) return stalled(init?.signal);
    if (next instanceof Error) throw next;
    return answer(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("uploadWithRetry (NEO-431)", () => {
  let warn: MockInstance<typeof console.warn>;
  const wait = vi.fn(async (_ms: number) => {});

  /** The `copy_photo_put_failed` lines, as logged. */
  const logged = () =>
    warn.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes("copy_photo_put_failed"));

  beforeEach(() => {
    wait.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  it("sends the request as given and returns the answer, without waiting or logging", async () => {
    const fetchMock = stubFetch(200);
    const req = request();
    const res = await uploadWithRetry(req, wait);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(SIGNED_URL, {
      method: "PUT",
      headers: req.headers,
      body: req.body,
      signal: expect.any(AbortSignal),
    });
    expect(wait).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
  });

  it("tries once more after a 503, then succeeds", async () => {
    const fetchMock = stubFetch(503, 200);
    const res = await uploadWithRetry(request(), wait);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls).toEqual([[500]]);
    expect(logged()).toEqual([]);
  });

  it("tries again after a 429", async () => {
    const fetchMock = stubFetch(429, 200);
    await uploadWithRetry(request(), wait);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tries again after a network TypeError", async () => {
    const fetchMock = stubFetch(new TypeError("Failed to fetch"), 200);
    const res = await uploadWithRetry(request(), wait);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a 403, and the error carries it", async () => {
    const fetchMock = stubFetch(403);
    const error = await uploadWithRetry(request(), wait).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhotoUploadError);
    expect(error).toMatchObject({ status: 403, message: MESSAGE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(logged().map((line) => JSON.parse(line))).toEqual([
      { event: "copy_photo_put_failed", method: "PUT", status: 403, attempts: 1, file: "image", size: 12 },
    ]);
  });

  it("gives up after 3 attempts of a 503, with the status on the error", async () => {
    const fetchMock = stubFetch(503, 503, 503);
    const error = await uploadWithRetry(request({ file: "thumb" }), wait).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, message: MESSAGE });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[500], [1500]]);
    expect(logged().map((line) => JSON.parse(line))).toEqual([
      { event: "copy_photo_put_failed", method: "PUT", status: 503, attempts: 3, file: "thumb", size: 12 },
    ]);
  });

  it("gives the caller's message, not the browser's, after 3 network failures, with a null status", async () => {
    const fetchMock = stubFetch(new TypeError("Failed to fetch"), new TypeError("Failed to fetch"), new TypeError("Failed to fetch"));
    const error = await uploadWithRetry(request(), wait).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhotoUploadError);
    expect(error).toMatchObject({ status: null, message: MESSAGE });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[500], [1500]]);
    expect(logged().map((line) => JSON.parse(line))).toEqual([
      { event: "copy_photo_put_failed", method: "PUT", status: null, attempts: 3, file: "image", size: 12 },
    ]);
  });

  it("does not retry an error that isn't the network's", async () => {
    const fetchMock = stubFetch(new RangeError("not a network failure"));
    await expect(uploadWithRetry(request(), wait)).rejects.toThrow(new RangeError("not a network failure"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logged()).toEqual([]);
  });

  it("logs one line that never carries the signed URL", async () => {
    stubFetch(503, 503, 503);
    const error = (await uploadWithRetry(request(), wait).catch((e: unknown) => e)) as Error;
    expect(logged()).toHaveLength(1);
    const everything = JSON.stringify(warn.mock.calls);
    expect(everything).not.toContain("photos.example");
    expect(everything).not.toContain("X-Amz-Signature");
    expect(error.message).not.toContain("photos.example");
  });

  describe("when storage never answers", () => {
    /** The window of the 12-byte body `request()` sends. */
    const WINDOW_MS = attemptTimeoutMs(12);

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const signalOf = (fetchMock: ReturnType<typeof stubFetch>, call: number) => fetchMock.mock.calls[call]?.[1]?.signal;

    it("aborts a try that stalls, tries again with a fresh window, then succeeds", async () => {
      const fetchMock = stubFetch(STALL, 200);
      const uploading = uploadWithRetry(request(), wait);

      await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(signalOf(fetchMock, 0)?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(signalOf(fetchMock, 0)?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(signalOf(fetchMock, 1)).not.toBe(signalOf(fetchMock, 0));
      expect(signalOf(fetchMock, 1)?.aborted).toBe(false);
      expect(wait.mock.calls).toEqual([[500]]);

      expect((await uploading).status).toBe(200);
      expect(logged()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("gives each try a window of its own, however long the last one took", async () => {
      const fetchMock = stubFetch(STALL, STALL, 200);
      const uploading = uploadWithRetry(request(), wait);

      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      expect((await uploading).status).toBe(200);
    });

    it("gives up after 3 stalls with the caller's message and a null status, logging timedOut and no URL", async () => {
      const fetchMock = stubFetch(STALL, STALL, STALL);
      const uploading = uploadWithRetry(request(), wait).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const error = await uploading;
      expect(error).toBeInstanceOf(PhotoUploadError);
      expect(error).toMatchObject({ status: null, message: MESSAGE });
      expect(wait.mock.calls).toEqual([[500], [1500]]);
      expect(logged().map((line) => JSON.parse(line))).toEqual([
        { event: "copy_photo_put_failed", method: "PUT", status: null, attempts: 3, file: "image", size: 12, timedOut: true },
      ]);
      const everything = JSON.stringify(warn.mock.calls);
      expect(everything).not.toContain("photos.example");
      expect(everything).not.toContain("X-Amz-Signature");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("says timedOut only when the last try is the one that stalled", async () => {
      const lastTryStalls = stubFetch(503, 503, STALL);
      const stalledLast = uploadWithRetry(request(), wait).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(lastTryStalls).toHaveBeenCalledTimes(3);
      expect(await stalledLast).toMatchObject({ status: null, message: MESSAGE });

      const lastTryAnswers = stubFetch(STALL, 503, 503);
      const answeredLast = uploadWithRetry(request(), wait).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(lastTryAnswers).toHaveBeenCalledTimes(3);
      expect(await answeredLast).toMatchObject({ status: 503, message: MESSAGE });

      expect(logged().map((line) => JSON.parse(line))).toEqual([
        { event: "copy_photo_put_failed", method: "PUT", status: null, attempts: 3, file: "image", size: 12, timedOut: true },
        { event: "copy_photo_put_failed", method: "PUT", status: 503, attempts: 3, file: "image", size: 12 },
      ]);
    });

    it("leaves alone an answer that arrives just inside the window, with no timer left behind", async () => {
      let respond: (res: Response) => void = () => {};
      const fetchMock = vi.fn(
        (..._args: Parameters<typeof fetch>) =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const uploading = uploadWithRetry(request(), wait);

      await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
      respond(answer(200));
      expect((await uploading).status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each<[string, (number | Error)[]]>([
      ["a refusal", [403]],
      ["a retried 503", [503, 200]],
      ["network failures", [new TypeError("Failed to fetch"), new TypeError("Failed to fetch"), new TypeError("Failed to fetch")]],
      ["an error that isn't the network's", [new RangeError("not a network failure")]],
    ])("leaves no timer behind after %s", async (_name, answers) => {
      stubFetch(...answers);
      await uploadWithRetry(request(), wait).catch(() => {});
      expect(vi.getTimerCount()).toBe(0);
    });

    it("sizes the window from the body it is sending", async () => {
      const threeMegabytes = new Blob([new Uint8Array(3_000_000)], { type: "image/jpeg" });
      const fetchMock = stubFetch(STALL, 200);
      const uploading = uploadWithRetry(request({ body: threeMegabytes }), wait);

      await vi.advanceTimersByTimeAsync(113_749);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      expect((await uploading).status).toBe(200);
    });

    it("passes on an AbortError that isn't its own timer's, with no retry", async () => {
      const foreign = new DOMException("Something else aborted this", "AbortError");
      const fetchMock = stubFetch(foreign);
      await expect(uploadWithRetry(request(), wait)).rejects.toBe(foreign);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(logged()).toEqual([]);
    });

    it("passes on any other error that lands after the timer fired, with no retry", async () => {
      const other = new RangeError("not a network failure");
      const fetchMock = vi.fn(
        (...[, init]: Parameters<typeof fetch>) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(other), { once: true });
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const uploading = uploadWithRetry(request(), wait).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(await uploading).toBe(other);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(logged()).toEqual([]);
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
