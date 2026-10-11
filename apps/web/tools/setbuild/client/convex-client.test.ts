import { afterEach, describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { TokenSource } from "../auth/token-source";
import { WaitTimeout, makeClient } from "./convex-client";
import { parseTarget } from "./target";

const fake = vi.hoisted(() => ({
  ws: {
    fetchToken: undefined as undefined | ((a: { forceRefreshToken: boolean }) => Promise<string | null | undefined>),
    subscribers: [] as Array<{ cb: (v: unknown) => void; onError?: (e: Error) => void; unsubscribed: boolean }>,
    queryResult: undefined as unknown,
    closed: false,
    options: undefined as unknown,
  },
  http: {
    tokens: [] as string[],
    failures: [] as Error[],
    calls: 0,
  },
}));

vi.mock("convex/browser", () => {
  class ConvexClient {
    constructor(_url: string, options: unknown) {
      fake.ws.options = options;
    }
    setAuth(fetchToken: typeof fake.ws.fetchToken) {
      fake.ws.fetchToken = fetchToken;
    }
    async query() {
      return fake.ws.queryResult;
    }
    async mutation() {
      return "m";
    }
    async action() {
      return "a";
    }
    onUpdate(_fn: unknown, _args: unknown, cb: (v: unknown) => void, onError?: (e: Error) => void) {
      const sub = { cb, onError, unsubscribed: false };
      fake.ws.subscribers.push(sub);
      return () => {
        sub.unsubscribed = true;
      };
    }
    async close() {
      fake.ws.closed = true;
    }
  }
  class ConvexHttpClient {
    setAuth(token: string) {
      fake.http.tokens.push(token);
    }
    async query() {
      fake.http.calls++;
      const failure = fake.http.failures.shift();
      if (failure) throw failure;
      return { n: fake.http.calls };
    }
    async mutation() {
      return this.query();
    }
    async action() {
      return this.query();
    }
  }
  return { ConvexClient, ConvexHttpClient };
});

const target = parseTarget("https://happy-otter-123.convex.cloud");
const ref = makeFunctionReference<"query", Record<string, never>, { n: number }>("things:get");

function tokens(overrides: Partial<TokenSource> = {}): TokenSource & { forced: number } {
  let n = 0;
  const src = {
    forced: 0,
    describe: () => "fake",
    async getToken(opts?: { forceRefresh?: boolean }) {
      if (opts?.forceRefresh) src.forced++;
      return `token-${++n}`;
    },
    ...overrides,
  };
  return src;
}

afterEach(() => {
  fake.ws.subscribers = [];
  fake.ws.closed = false;
  fake.http.tokens = [];
  fake.http.failures = [];
  fake.http.calls = 0;
  vi.useRealTimers();
});

describe("makeClient (ws)", () => {
  test("wires setAuth to the token source, passing forceRefresh through", async () => {
    const src = tokens();
    makeClient(target, src);
    expect(fake.ws.fetchToken).toBeDefined();
    await fake.ws.fetchToken!({ forceRefreshToken: true });
    expect(src.forced).toBe(1);
  });

  test("skips the deployment-URL check only off convex.cloud", () => {
    makeClient(target, tokens());
    expect(fake.ws.options).toMatchObject({ skipConvexDeploymentUrlCheck: false, unsavedChangesWarning: false });
    makeClient(parseTarget("http://127.0.0.1:3210"), tokens());
    expect(fake.ws.options).toMatchObject({ skipConvexDeploymentUrlCheck: true });
  });

  test("a failing first mint fails the call with the auth error, not 'Not authenticated'", async () => {
    const client = makeClient(target, tokens({ getToken: async () => Promise.reject(new Error("ticket refused")) }));
    await expect(client.query(ref, {})).rejects.toThrow("ticket refused");
  });

  test("the auth fetcher swallows a mint failure into null (signed out)", async () => {
    makeClient(target, tokens({ getToken: async () => Promise.reject(new Error("x")) }));
    await expect(fake.ws.fetchToken!({ forceRefreshToken: false })).resolves.toBeNull();
  });

  test("waitFor resolves on the first value that satisfies the predicate and unsubscribes", async () => {
    const client = makeClient(target, tokens());
    const p = client.waitFor(ref, {}, (v) => v.n >= 3, { timeoutMs: 5000, label: "n to reach 3" });
    await vi.waitFor(() => expect(fake.ws.subscribers).toHaveLength(1));
    const sub = fake.ws.subscribers[0];
    sub.cb({ n: 1 });
    sub.cb({ n: 3 });
    await expect(p).resolves.toEqual({ n: 3 });
    expect(sub.unsubscribed).toBe(true);
  });

  test("waitFor times out with the label and the last value seen", async () => {
    const client = makeClient(target, tokens());
    vi.useFakeTimers();
    const p = client.waitFor(ref, {}, () => false, { timeoutMs: 2500, label: "the column to sync" });
    await vi.waitFor(() => expect(fake.ws.subscribers).toHaveLength(1));
    fake.ws.subscribers[0].cb({ n: 7 });
    const assertion = expect(p).rejects.toThrow(/2\.5s waiting for the column to sync \(last result \{"n":7\}\)/);
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;
    await p.catch((e: unknown) => expect(e).toBeInstanceOf(WaitTimeout));
    expect(fake.ws.subscribers[0].unsubscribed).toBe(true);
  });

  test("waitFor rejects with the query's error, and with a throwing predicate", async () => {
    const client = makeClient(target, tokens());
    const p1 = client.waitFor(ref, {}, () => false, { timeoutMs: 5000, label: "x" });
    await vi.waitFor(() => expect(fake.ws.subscribers).toHaveLength(1));
    fake.ws.subscribers[0].onError!(new Error("Admin access required"));
    await expect(p1).rejects.toThrow("Admin access required");

    const p2 = client.waitFor(
      ref,
      {},
      () => {
        throw new Error("bad predicate");
      },
      { timeoutMs: 5000, label: "y" },
    );
    await vi.waitFor(() => expect(fake.ws.subscribers).toHaveLength(2));
    fake.ws.subscribers[1].cb({ n: 1 });
    await expect(p2).rejects.toThrow("bad predicate");
  });

  test("close closes the socket", async () => {
    await makeClient(target, tokens()).close();
    expect(fake.ws.closed).toBe(true);
  });
});

describe("makeClient (http)", () => {
  test("sets a token before each call", async () => {
    const client = makeClient(target, tokens(), { transport: "http" });
    await client.query(ref, {});
    await client.query(ref, {});
    // token-1 is the eager first mint; the fake does not cache, so each call
    // then asks again (a real source answers those from its cache).
    expect(fake.http.tokens).toEqual(["token-2", "token-3"]);
  });

  test("retries once with a forced refresh when Convex rejects the token", async () => {
    const src = tokens();
    const client = makeClient(target, src, { transport: "http" });
    fake.http.failures.push(new Error("[Request ID: x] Server Error\nUnauthenticated: Could not verify OIDC token"));
    await expect(client.query(ref, {})).resolves.toEqual({ n: 2 });
    expect(src.forced).toBe(1);
  });

  test("does not retry other errors", async () => {
    const client = makeClient(target, tokens(), { transport: "http" });
    fake.http.failures.push(new Error("Admin access required"));
    await expect(client.query(ref, {})).rejects.toThrow("Admin access required");
    expect(fake.http.calls).toBe(1);
  });

  test("waitFor polls until the predicate holds", async () => {
    const client = makeClient(target, tokens(), { transport: "http" });
    const v = await client.waitFor(ref, {}, (r) => r.n >= 3, { timeoutMs: 5000, label: "n", pollMs: 1 });
    expect(v).toEqual({ n: 3 });
  });

  test("waitFor gives up at the deadline", async () => {
    const client = makeClient(target, tokens(), { transport: "http" });
    await expect(
      client.waitFor(ref, {}, () => false, { timeoutMs: 30, label: "never", pollMs: 10 }),
    ).rejects.toBeInstanceOf(WaitTimeout);
  });
});
