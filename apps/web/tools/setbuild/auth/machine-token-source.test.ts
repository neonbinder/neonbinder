import { describe, expect, test } from "vitest";
import { machineTokenSource } from "./machine-token-source";
import { SetbuildAuthError } from "./token-source";
import { fakeJwt, json, routedFetch } from "./test-helpers";

const KEY = "ak_live-machine-api-key-value-0001";
const SITE = "https://happy-otter-123.convex.site";
const NOW = 1_800_000_000_000;

const jwt = (n: number) => fakeJwt({ sub: "user_abc", aud: "convex", exp: NOW / 1000 + 3600, n });

function source(fetchFn: typeof fetch) {
  return machineTokenSource({
    convexSite: `${SITE}/ignored/path`,
    apiKey: KEY,
    fetchFn,
    now: () => NOW,
    sleep: async () => {},
  });
}

describe("machineTokenSource", () => {
  test("posts the key, caches the session id and presents it on refresh", async () => {
    let n = 0;
    const { fetchFn, calls } = routedFetch({
      "POST /machine/token": () => json({ token: jwt(++n), sessionId: "sess_m1" }),
    });
    const ts = source(fetchFn);
    const a = await ts.getToken();
    expect(await ts.getToken()).toBe(a);
    const b = await ts.getToken({ forceRefresh: true });
    expect(b).not.toBe(a);

    expect(calls.map((c) => `${c.url.origin}${c.url.pathname}`)).toEqual([
      `${SITE}/machine/token`,
      `${SITE}/machine/token`,
    ]);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body)).toEqual({ key: KEY });
    expect(JSON.parse(calls[1].body)).toEqual({ key: KEY, sessionId: "sess_m1" });
  });

  test("a 401 is the key: no retry, and the key is not in the message", async () => {
    const { fetchFn, calls } = routedFetch({
      "POST /machine/token": () => json({ error: "unauthorized" }, 401),
    });
    const err = await source(fetchFn).getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetbuildAuthError);
    expect((err as SetbuildAuthError).stage).toBe("machine_key_refused");
    expect((err as Error).message).not.toContain(KEY);
    expect(calls).toHaveLength(1);
  });

  test("retries 502/503 with backoff, then succeeds", async () => {
    const { fetchFn, calls } = routedFetch({
      "POST /machine/token": [
        () => json({ error: "upstream_unavailable" }, 502),
        () => json({ error: "not_configured" }, 503),
        () => json({ token: jwt(1), sessionId: "sess_m1" }),
      ],
    });
    await expect(source(fetchFn).getToken()).resolves.toBeTypeOf("string");
    expect(calls).toHaveLength(3);
  });

  test("gives up after 3 transient failures", async () => {
    const { fetchFn, calls } = routedFetch({
      "POST /machine/token": () => json({ error: "upstream_unavailable" }, 502),
    });
    const err = await source(fetchFn).getToken().catch((e: unknown) => e);
    expect((err as SetbuildAuthError).status).toBe(502);
    expect(calls).toHaveLength(3);
  });

  test("ignores a malformed session id rather than echoing it into the next request", async () => {
    let n = 0;
    const { fetchFn, calls } = routedFetch({
      "POST /machine/token": () => json({ token: jwt(++n), sessionId: "../../users" }),
    });
    const ts = source(fetchFn);
    await ts.getToken();
    await ts.getToken({ forceRefresh: true });
    expect(JSON.parse(calls[1].body)).toEqual({ key: KEY });
  });

  test("describe() names the site, never the key", () => {
    const ts = source((async () => json({})) as typeof fetch);
    expect(ts.describe()).toContain("happy-otter-123.convex.site/machine/token");
    expect(ts.describe()).not.toContain(KEY);
  });

  test("refuses to build without a key", () => {
    expect(() => machineTokenSource({ convexSite: SITE, apiKey: "" })).toThrow(/NB_SETBUILD_API_KEY/);
  });
});
