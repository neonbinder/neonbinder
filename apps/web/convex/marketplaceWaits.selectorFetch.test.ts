/**
 * PR 451 (NEO-487) — `fetchBscSelectorOptions` takes the client's `waitKey`
 * and hands its call recorder a wait writer, the way `fetchBscChecklist`
 * does: every column Sync, Base picker read, insert/parallel reconcile and
 * Attach Sets browse reaches BSC through it, so this is where their
 * "Waiting on BuySportsCards…" rows are written.
 *
 *   - A key: one `marketplaceWaits` row for the invocation, owned by the
 *     caller, closed once the action returns.
 *   - No key, or a malformed one: nothing written (the writer's contract).
 *   - The key is never sent to BSC.
 *
 * The real adapter runs with `fetch` stubbed and the credential reads
 * mocked, as `bscCallTelemetry.adapters.test.ts` does. The threading of the
 * key through the actions that call this one is pinned in
 * `marketplaceWaits.threading.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { resetBscInflightForTests } from "./lib/bscCallTelemetry";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo487_selector",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo487_selector",
  name: "Admin",
  role: "admin",
};

vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async () => ({ token: "test-bsc-token" }),
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

/** Every request BSC received: its URL and body. */
let sent: Array<{ url: string; body: string }>;

beforeEach(() => {
  resetBscInflightForTests();
  sent = [];
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? "") });
    return Response.json({
      aggregations: { sport: [{ label: "Baseball", slug: "baseball", count: 3 }] },
    });
  }) as typeof fetch);
  for (const m of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const waits = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("marketplaceWaits").collect());

const fetchSports = (t: ReturnType<typeof convexTest>, extra: { waitKey?: string } = {}) =>
  t.withIdentity(ADMIN).action(api.adapters.buysportscards.fetchBscSelectorOptions, {
    level: "sport",
    parentFilters: {},
    ...extra,
  });

describe("fetchBscSelectorOptions — waitKey", () => {
  test("a key: the invocation's wait row is written under it, owned by the caller, and closed", async () => {
    const t = convexTest(schema, modules);
    const r = await fetchSports(t, { waitKey: "sync_sport-1" });

    expect(r.success).toBe(true);
    const rows = await waits(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: ADMIN.subject,
      runKey: "sync_sport-1",
      platform: "bsc",
    });
    // The action has returned: the recorder's flush closed the wait.
    expect(rows[0].waitingSince).toBeUndefined();
  });

  test("the key is never sent to BSC", async () => {
    const t = convexTest(schema, modules);
    await fetchSports(t, { waitKey: "sync_sport-secret-marker" });

    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      expect(req.url).not.toContain("sync_sport-secret-marker");
      expect(req.body).not.toContain("sync_sport-secret-marker");
    }
  });

  test("no key: nothing is written", async () => {
    const t = convexTest(schema, modules);
    await fetchSports(t);

    expect(await waits(t)).toEqual([]);
  });

  test.each([["has space"], ["x".repeat(65)], [""]])(
    "a malformed key %j: the fetch runs and nothing is written",
    async (waitKey) => {
      const t = convexTest(schema, modules);
      const r = await fetchSports(t, { waitKey });

      expect(r.success).toBe(true);
      expect(await waits(t)).toEqual([]);
    },
  );

  test("a level BSC does not serve answers before any call: no row", async () => {
    const t = convexTest(schema, modules);
    const r = await t.withIdentity(ADMIN).action(api.adapters.buysportscards.fetchBscSelectorOptions, {
      level: "manufacturer",
      parentFilters: {},
      waitKey: "sync_brand-1",
    });

    expect(r.success).toBe(false);
    expect(sent).toEqual([]);
    expect(await waits(t)).toEqual([]);
  });
});
