/**
 * NEO-409 — the hang detector names the call that never returned.
 *
 * A fake client stands in for ConvexReactClient: its mutation can be left
 * open forever, which is exactly the E2E red this exists to explain.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  createHangDetector,
  hangAfterMsFrom,
  hashArgs,
  redactLine,
  DEFAULT_HANG_AFTER_MS,
  type HangRecord,
} from "./convex-hang-detector";

type Listener = () => void;

function fakeClient() {
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  // One result per watch, keyed by its args, as the real client keys them.
  const results = new Map<string, unknown>();
  const failing = new Set<string>();
  const listeners = new Set<Listener>();
  const key = (args: unknown) => JSON.stringify(args ?? {});
  const client = {
    mutation: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    ),
    action: vi.fn((_fn: unknown, args: { hang?: boolean } = {}) =>
      args.hang ? new Promise(() => {}) : Promise.resolve("ok"),
    ),
    watchQuery: vi.fn((_fn: unknown, args?: unknown) => ({
      onUpdate: (cb: Listener) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      localQueryResult: () => {
        if (failing.has(key(args))) throw new Error("query failed");
        return results.get(key(args));
      },
      localQueryLogs: () => undefined,
      journal: () => undefined,
    })),
    connectionState: () => ({
      isWebSocketConnected: true,
      connectionCount: 1,
      connectionRetries: 0,
      hasInflightRequests: true,
      timeOfOldestInflightRequest: new Date(0),
      hasEverConnected: true,
      inflightMutations: pending.length,
      inflightActions: 0,
    }),
  };
  return {
    client: client as unknown as ConvexReactClient,
    pending,
    deliver(args: unknown, value: unknown) {
      results.set(key(args), value);
      for (const l of listeners) l();
    },
    fail(args: unknown) {
      failing.add(key(args));
      for (const l of listeners) l();
    },
  };
}

const saveTheme = makeFunctionReference<"mutation">("userProfile:saveTheme");
const listBinders = makeFunctionReference<"query">("binders:list");

function setup(hangAfterMs = 5_000) {
  let clock = 0;
  const sink = { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const hangs: HangRecord[] = [];
  const detector = createHangDetector({
    hangAfterMs,
    now: () => clock,
    sink,
    onHang: (r) => hangs.push(r),
    autoCheck: false,
  });
  const fake = fakeClient();
  detector.attach(fake.client, 0);
  return {
    detector,
    fake,
    sink,
    hangs,
    advance(ms: number) {
      clock += ms;
      detector.check();
    },
  };
}

describe("convex hang detector", () => {
  it("reports a mutation that never resolves, once, with the socket and token state", () => {
    const { detector, fake, sink, hangs, advance } = setup();
    detector.logger.logVerbose("pausing WS for auth token fetch [v2]");
    void fake.client.mutation(saveTheme, { theme: "dark" });

    advance(4_999);
    expect(hangs).toHaveLength(0);

    advance(1);
    expect(hangs).toHaveLength(1);
    expect(hangs[0]).toMatchObject({
      kind: "mutation",
      name: "userProfile:saveTheme",
      argsHash: hashArgs({ theme: "dark" }),
      openForMs: 5_000,
      openCalls: 1,
      state: {
        authPaused: true,
        connection: { isWebSocketConnected: true, timeOfOldestInflightRequest: new Date(0).toISOString() },
      },
    });
    expect(sink.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[nb-hang\] .*userProfile:saveTheme/));

    advance(10_000);
    expect(hangs).toHaveLength(1);
    expect(detector.snapshot().openCalls).toEqual([
      expect.objectContaining({ name: "userProfile:saveTheme", openForMs: 15_000 }),
    ]);
  });

  it("reports the socket of the client that carried the call, not a spare one built after it", () => {
    const { detector, fake, hangs, advance } = setup();
    const spare = fakeClient();
    (spare.client as unknown as { connectionState: () => object }).connectionState = () => ({
      isWebSocketConnected: false,
      hasEverConnected: false,
    });
    detector.attach(spare.client, 0); // React StrictMode builds the memo twice in development
    void fake.client.mutation(saveTheme, {});
    advance(5_000);
    expect(hangs[0].state.connection).toMatchObject({ isWebSocketConnected: true });
    expect(detector.snapshot().state.connection).toMatchObject({ isWebSocketConnected: true });
  });

  it("still lets an ignored rejecting mutation surface as an unhandled rejection", async () => {
    const { fake } = setup();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      void fake.client.mutation(saveTheme, {});
      fake.pending[0].reject(new Error("ignored failure"));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([expect.objectContaining({ message: "ignored failure" })]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("counts an assembled chunked Transition as a server transition", () => {
    const { detector, advance } = setup();
    detector.logger.logVerbose("received ws message with type TransitionChunk");
    detector.logger.logVerbose("assembled full ws message of type Transition");
    advance(1_000);
    expect(detector.snapshot().state.msSinceLastTransition).toBe(1_000);
  });

  it("tracks a server-rejected token's reauthentication", () => {
    const { detector } = setup();
    detector.logger.logVerbose("attempting to reauthenticate: token expired [v3]");
    expect(detector.snapshot().state.reauthenticating).toBe(true);
    detector.logger.logVerbose("server confirmed new auth token is valid [v4]");
    expect(detector.snapshot().state.reauthenticating).toBe(false);
  });

  it("moves the snapshot to the new client after a swap, before any call lands on it", () => {
    const { detector } = setup();
    const swapped = fakeClient();
    (swapped.client as unknown as { connectionState: () => object }).connectionState = () => ({
      connectionCount: 7,
    });
    detector.attach(swapped.client, 1);
    expect(detector.snapshot().state.connection).toMatchObject({ connectionCount: 7 });
  });

  it("never records the args themselves", () => {
    const { detector, fake, advance } = setup();
    void fake.client.mutation(saveTheme, { secretish: "do-not-print" });
    advance(6_000);
    expect(JSON.stringify(detector.snapshot())).not.toContain("do-not-print");
  });

  it("clears a mutation when it resolves or rejects", async () => {
    const { detector, fake, hangs, advance } = setup();
    const ok = fake.client.mutation(saveTheme, {});
    const bad = fake.client.mutation(saveTheme, {});
    fake.pending[0].resolve(null);
    fake.pending[1].reject(new Error("boom"));
    await ok;
    await expect(bad).rejects.toThrow("boom");
    advance(10_000);
    expect(hangs).toHaveLength(0);
    expect(detector.snapshot().openCalls).toHaveLength(0);
  });

  it("holds a subscription open until its first result", () => {
    const { detector, fake, hangs, advance } = setup();
    const watch = fake.client.watchQuery(listBinders, {});
    watch.onUpdate(() => {});
    expect(detector.snapshot().openCalls).toEqual([
      expect.objectContaining({ kind: "query", name: "binders:list" }),
    ]);

    fake.deliver({}, []);
    expect(detector.snapshot().openCalls).toHaveLength(0);
    advance(10_000);
    expect(hangs).toHaveLength(0);
  });

  it("never registers a subscription that already has a result", () => {
    const { detector, fake } = setup();
    fake.deliver({ cached: 1 }, ["x"]);
    fake.client.watchQuery(listBinders, { cached: 1 }).onUpdate(() => {});
    expect(detector.snapshot().openCalls).toHaveLength(0);
  });

  it("drops a subscription unsubscribed before any result (the screen moved on)", () => {
    const { detector, fake, hangs, advance } = setup();
    const unsubscribe = fake.client.watchQuery(listBinders, { a: 1 }).onUpdate(() => {});
    expect(detector.snapshot().openCalls).toHaveLength(1);
    unsubscribe();
    expect(detector.snapshot().openCalls).toHaveLength(0);
    advance(10_000);
    expect(hangs).toHaveLength(0);
  });

  it("treats a subscription whose result is an error as settled", () => {
    const { detector, fake, hangs, advance } = setup();
    fake.client.watchQuery(listBinders, { b: 1 }).onUpdate(() => {});
    fake.fail({ b: 1 });
    expect(detector.snapshot().openCalls).toHaveLength(0);
    advance(10_000);
    expect(hangs).toHaveLength(0);
  });

  it("reports an action that never resolves, once, as an action", () => {
    const { fake, hangs, advance } = setup();
    void fake.client.action(makeFunctionReference<"action">("intake:run"), { hang: true });
    advance(5_000);
    advance(5_000);
    expect(hangs).toHaveLength(1);
    expect(hangs[0]).toMatchObject({ kind: "action", name: "intake:run" });
  });

  it("tracks the time since the last server transition from the client's own log lines", () => {
    const { detector, advance } = setup();
    detector.logger.logVerbose("received ws message with type Transition");
    advance(3_000);
    detector.logger.logVerbose("received ws message with type Ping");
    advance(2_000);
    const { state } = detector.snapshot();
    expect(state.msSinceLastTransition).toBe(5_000);
    expect(state.msSinceLastServerMessage).toBe(2_000);
  });

  it("resumes the token state and keeps a bounded, redacted line buffer", () => {
    const { detector, sink } = setup();
    detector.logger.logVerbose("pausing WS for auth token fetch");
    detector.logger.logVerbose("resuming WS after auth token fetch");
    expect(detector.snapshot().state.authPaused).toBe(false);

    detector.logger.warn("GET https://x.test/?__clerk_testing_token=abc123&y=1");
    for (let i = 0; i < 400; i++) detector.logger.logVerbose(`line ${i}`);
    const { recentLines } = detector.snapshot();
    expect(recentLines).toHaveLength(300);
    expect(recentLines.at(-1)).toContain("line 399");
    expect(sink.debug).toHaveBeenCalledWith("[convex] line 399");
  });

  it("passes calls straight through when the detector itself fails", async () => {
    const { detector, fake, hangs, advance } = setup();
    (fake.client as unknown as { connectionState: () => never }).connectionState = () => {
      throw new Error("client closed");
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      fake.client.action(makeFunctionReference<"action">("x:y"), cyclic),
    ).resolves.toBe("ok");
    void fake.client.mutation(saveTheme, cyclic);
    expect(() => advance(5_000)).not.toThrow();
    expect(hangs[0]).toMatchObject({ argsHash: "unhashable", state: { connection: null } });
    expect(() => detector.snapshot()).not.toThrow();
  });
});

describe("redactLine", () => {
  it("strips Clerk dev-browser and session tokens, plain and URL-encoded", () => {
    const out = redactLine(
      "GET https://clerk.x.dev/v1/client?__clerk_db_jwt=dvb_2abcSECRET&_v=5 " +
        "redirect=%2F%3F__clerk_db_jwt%3Ddvb_OTHERSECRET __session=sess_SECRET; __client_uat=123",
    );
    expect(out).not.toMatch(/SECRET|sess_|=123/);
    expect(out).toContain("__clerk_db_jwt=[redacted]&_v=5");
    expect(out).toContain("__clerk_db_jwt%3D[redacted]");
  });

  it("strips Clerk testing tokens, bearer tokens and JWTs", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2lnbmF0dXJl";
    const out = redactLine(
      `url=/x?__clerk_testing_token=tok_1&a=1 Authorization: Bearer abc.def ${jwt}`,
    );
    expect(out).not.toContain("tok_1");
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain(jwt);
    expect(out).toContain("__clerk_testing_token=[redacted]&a=1");
  });
});

describe("hangAfterMsFrom", () => {
  it("reads the fixture's override, clamped, and defaults otherwise", () => {
    expect(hangAfterMsFrom(undefined)).toBe(DEFAULT_HANG_AFTER_MS);
    expect(hangAfterMsFrom({ hang_after_ms: "3" })).toBe(DEFAULT_HANG_AFTER_MS);
    expect(hangAfterMsFrom({ hang_after_ms: 2_500 })).toBe(2_500);
    expect(hangAfterMsFrom({ hang_after_ms: 1 })).toBe(1_000);
    expect(hangAfterMsFrom({ hang_after_ms: 1e9 })).toBe(60_000);
  });
});
