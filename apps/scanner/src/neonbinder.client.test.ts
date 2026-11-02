import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";

/**
 * The CLI's sign-in and upload, with fetch stubbed and the Convex client
 * faked: the key exchange's answers to each status, the one-shot primed
 * token, and an image's trip (sign, POST to storage, confirm).
 */
const convex = vi.hoisted(() => ({
  setAuth: vi.fn(),
  query: vi.fn(),
  action: vi.fn(),
  mutation: vi.fn(),
  close: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexClient: vi.fn(function () {
    return convex;
  }),
}));

import { NeonBinder } from "./neonbinder.js";

const URL_ = "https://happy-otter-123.convex.cloud";
const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  for (const f of Object.values(convex)) f.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function signedIn() {
  fetchMock.mockResolvedValueOnce(json(200, { token: "t1", sessionId: "s1" }));
  return await NeonBinder.signIn(URL_, "ak_secret");
}

describe("sign-in", () => {
  test("posts the key to the site origin, without following redirects", async () => {
    await signedIn();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://happy-otter-123.convex.site/machine/token");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ key: "ak_secret" });
  });

  test("a rejected key says where to make one, and is not retried", async () => {
    fetchMock.mockResolvedValueOnce(json(401));
    await expect(NeonBinder.signIn(URL_, "bad")).rejects.toThrow(/Profile → API Keys/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a blip is retried with backoff", async () => {
    fetchMock.mockResolvedValueOnce(json(503)).mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchMock.mockResolvedValueOnce(json(200, { token: "t1" }));
    const signing = NeonBinder.signIn(URL_, "k");
    await vi.runAllTimersAsync();
    await expect(signing).resolves.toBeInstanceOf(NeonBinder);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("gives up after five tries", async () => {
    fetchMock.mockResolvedValue(json(429));
    const signing = NeonBinder.signIn(URL_, "k");
    const outcome = expect(signing).rejects.toThrow(/unavailable \(HTTP 429\)/);
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test("any other status fails at once, and so does an answer with no session", async () => {
    fetchMock.mockResolvedValueOnce(json(500));
    await expect(NeonBinder.signIn(URL_, "k")).rejects.toThrow(/HTTP 500/);
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await expect(NeonBinder.signIn(URL_, "k")).rejects.toThrow(/no session/);
  });

  test("the first token is the one checked at start; later ones reuse the session; a failure is null", async () => {
    await signedIn();
    const fetchToken = convex.setAuth.mock.calls[0][0] as (a: { forceRefreshToken: boolean }) => Promise<string | null>;
    expect(await fetchToken({ forceRefreshToken: false })).toBe("t1");
    fetchMock.mockResolvedValueOnce(json(200, { token: "t2" }));
    expect(await fetchToken({ forceRefreshToken: false })).toBe("t2");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ key: "ak_secret", sessionId: "s1" });
    fetchMock.mockResolvedValueOnce(json(401));
    expect(await fetchToken({ forceRefreshToken: true })).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await fetchToken({ forceRefreshToken: true })).toBeNull();
  });
});

describe("sendImage", () => {
  const ticket = {
    uploadUrl: "https://storage.example/upload",
    fields: { key: "k1", policy: "p" },
    entryIndex: 7,
    maxUploadBytes: 10,
  };

  test("signs, posts the policy fields before the file, then confirms that entry", async () => {
    const nb = await signedIn();
    convex.action.mockResolvedValue(ticket);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await nb.sendImage("job-1", Buffer.from("jpeg"), "scan-1-front.jpg")).toBe(7);
    expect(getFunctionName(convex.action.mock.calls[0][0])).toBe("adapters/placeholderUploads:createPlaceholderImageUploadUrl");
    expect(convex.action.mock.calls[0][1]).toEqual({ jobId: "job-1", contentType: "image/jpeg", originalName: "scan-1-front.jpg" });
    const form = fetchMock.mock.calls[1][1]?.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "file"]);
    expect(getFunctionName(convex.mutation.mock.calls[0][0])).toBe("placeholderStream:confirmPlaceholderImageUpload");
    expect(convex.mutation.mock.calls[0][1]).toEqual({ jobId: "job-1", entryIndex: 7 });
  });

  test("refuses an image over the limit before sending it", async () => {
    const nb = await signedIn();
    convex.action.mockResolvedValue(ticket);
    await expect(nb.sendImage("job-1", Buffer.alloc(11), "big.jpg")).rejects.toThrow(/upload limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a failed upload reports the status only and confirms nothing", async () => {
    const nb = await signedIn();
    convex.action.mockResolvedValue(ticket);
    fetchMock.mockResolvedValueOnce(new Response("<Error>policy p quoted</Error>", { status: 403 }));
    const error = await nb.sendImage("job-1", Buffer.from("x"), "a.jpg").catch((e: Error) => e);
    expect(String(error)).toBe("Error: Upload failed (HTTP 403).");
    expect(convex.mutation).not.toHaveBeenCalled();
  });
});
