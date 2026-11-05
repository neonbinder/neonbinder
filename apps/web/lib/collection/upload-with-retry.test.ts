import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PhotoUploadError, uploadWithRetry, type PhotoUploadRequest } from "./upload-with-retry";

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

/** `fetch` answering each call in turn: a status, or an error to throw. */
function stubFetch(...answers: (number | Error)[]) {
  const queue = [...answers];
  const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch called more often than the test expected");
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
    expect(fetchMock).toHaveBeenCalledWith(SIGNED_URL, { method: "PUT", headers: req.headers, body: req.body });
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
});
