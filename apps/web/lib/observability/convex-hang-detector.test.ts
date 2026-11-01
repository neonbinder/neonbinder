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
  let result: unknown = undefined;
  const listeners = new Set<Listener>();
  const client = {
    mutation: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    ),
    action: vi.fn(() => Promise.resolve("ok")),
    watchQuery: vi.fn(() => ({
      onUpdate: (cb: Listener) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      localQueryResult: () => result,
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
    deliver(value: unknown) {
      result = value;
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

  it("holds a subscription open until its first result, and drops it on unsubscribe", () => {
    const { detector, fake, hangs, advance } = setup();
    const watch = fake.client.watchQuery(listBinders, {});
    const unsubscribe = watch.onUpdate(() => {});
    expect(detector.snapshot().openCalls).toEqual([
      expect.objectContaining({ kind: "query", name: "binders:list" }),
    ]);

    fake.deliver([]);
    expect(detector.snapshot().openCalls).toHaveLength(0);

    const second = fake.client.watchQuery(listBinders, { other: 1 });
    // Already has a result: never registered.
    second.onUpdate(() => {})();
    unsubscribe();
    advance(10_000);
    expect(hangs).toHaveLength(0);
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

  it("passes calls straight through even when the detector cannot register them", async () => {
    const { fake } = setup();
    await expect(fake.client.action(makeFunctionReference<"action">("x:y"), {})).resolves.toBe("ok");
  });
});

describe("redactLine", () => {
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
