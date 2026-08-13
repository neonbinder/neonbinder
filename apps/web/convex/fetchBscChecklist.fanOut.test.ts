/**
 * NEO-137 — BSC does NOT OR multi-value facets, so the checklist fetch must
 * fan out: one request per source set.
 *
 * MEASURED LIVE on dev 2026-08-12, 1996 Score inserts (Dugout Collection
 * Artist's Proofs, which BSC splits into Series 1 and Series 2):
 *
 *   filters.variantName = ["…series-2"]                 -> 110 cards
 *   filters.variantName = ["…series-2", "…series-1"]    -> 200 OK, ZERO rows
 *
 * The adapter used to send both slugs in one request, on the strength of a
 * comment claiming "BSC's bulk-upload API accepts multi-value facets in one
 * call … no fan-out needed". That was never verified and is false.
 *
 * WHY NOTHING CAUGHT IT — and why this file mocks at a different layer.
 * Every existing checklist test (`fetchCardChecklist.stickyPairing`,
 * `fetchCardChecklistTeamLookup`) replaces `fetchBscChecklist` wholesale with
 * `vi.mock`, so the request BSC actually receives was never asserted and two
 * variantName values were never sent. These tests stub `fetch` instead and
 * assert on the outgoing request bodies, which is the only layer where this
 * class of bug is visible.
 *
 * The user-visible symptom was maximally misleading: a well-formed query, no
 * error anywhere, an empty checklist, and a UI reporting "0 BSC cards" as
 * though the marketplace had nothing — while SportLots returned 220.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_137",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_137",
  name: "Admin",
  role: "admin",
};

const S1 = "dugout-collection-artists-proofs-series-1";
const S2 = "dugout-collection-artists-proofs-series-2";

/** The credentials layer is not under test — hand the adapter a token. */
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

type Recorded = { variantName?: string[]; filters: Record<string, string[]> };

/**
 * Stub BSC's bulk-upload endpoint.
 *
 * `perSlug` maps a variantName slug -> how many cards to return. A slug absent
 * from the map returns []. `multiValueReturnsEmpty` reproduces the real API's
 * behaviour: any request carrying more than one variantName yields zero rows.
 */
function stubBsc(opts: {
  perSlug: Record<string, number>;
  recorded: Recorded[];
  multiValueReturnsEmpty?: boolean;
  status?: number;
  failSlug?: string;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const filters = (body.filters ?? {}) as Record<string, string[]>;
    const variantName = filters.variantName;
    opts.recorded.push({ variantName, filters });

    if (opts.failSlug && variantName?.includes(opts.failSlug)) {
      return new Response("boom", { status: opts.status ?? 500 });
    }

    const multi = (variantName?.length ?? 0) > 1;
    if (multi && (opts.multiValueReturnsEmpty ?? true)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const slug = variantName?.[0];
    const count = slug ? (opts.perSlug[slug] ?? 0) : 0;
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `${slug}-card-${i + 1}`,
      cardNo: String(i + 1),
      players: `Player ${i + 1}`,
      // BSC returns the PARENT set here for an insert query — never the
      // insert's own slug. This is why source attribution had to stop
      // trusting it.
      setName: "score",
    }));
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const PARENT = {
  sport: "Baseball",
  year: "1996",
  setName: "Score",
  variantType: "insert",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBscChecklist — per-source-set fan-out (NEO-137)", () => {
  test("two source sets produce TWO requests, one slug each, and the union", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBsc({ perSlug: { [S1]: 110, [S2]: 110 }, recorded }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    // THE REGRESSION: one request per slug, never both in one facet.
    expect(recorded).toHaveLength(2);
    expect(recorded.map((r) => r.variantName)).toEqual([[S2], [S1]]);
    expect(recorded.every((r) => (r.variantName?.length ?? 0) === 1)).toBe(true);

    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(220);
  });

  test("batching both slugs into one request would return NOTHING — the bug", async () => {
    // Proves the stub models the real API, so the assertion above is meaningful
    // rather than tautological. A single request carrying both slugs is exactly
    // what the old code sent, and it yields zero.
    const recorded: Recorded[] = [];
    const fetchStub = stubBsc({
      perSlug: { [S1]: 110, [S2]: 110 },
      recorded,
    });
    const res = await fetchStub("https://example.test/search/bulk-upload/results", {
      method: "POST",
      body: JSON.stringify({ filters: { variantName: [S2, S1] } }),
    } as RequestInit);

    await expect(res.json()).resolves.toEqual([]);
  });

  test("each card is tagged with the slug WE queried, not the response's setName", async () => {
    // The rows above all carry setName: "score" (the parent set). Trusting it
    // made every card claim the same source, so the BSC SOURCE chips could not
    // tell two attached sets apart.
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", stubBsc({ perSlug: { [S1]: 2, [S2]: 3 }, recorded }));
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    const bySlug = new Map<string, number>();
    for (const c of result.cards) {
      const s = c.sourceBscSetSlug ?? "(none)";
      bySlug.set(s, (bySlug.get(s) ?? 0) + 1);
    }
    expect(bySlug.get(S2)).toBe(3);
    expect(bySlug.get(S1)).toBe(2);
    expect(bySlug.get("score")).toBeUndefined();
  });

  test("a single source set still makes exactly ONE request", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", stubBsc({ perSlug: { [S2]: 110 }, recorded }));
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2] },
      });

    expect(recorded).toHaveLength(1);
    expect(result.cards).toHaveLength(110);
  });

  test("if ONE source set fails, the whole fetch fails — never a partial checklist", async () => {
    // Commit REPLACES the stored checklist. Returning only the slugs that
    // succeeded would delete the failing set's cards and look like a clean run.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBsc({
        perSlug: { [S1]: 110, [S2]: 110 },
        recorded,
        failSlug: S1,
        status: 500,
      }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    expect(result.success).toBe(false);
    expect(result.cards).toHaveLength(0);
    expect(result.message).toMatch(/partial|only 1 of 2/i);
  });

  test("duplicate cards across source sets are deduped by BSC card id", async () => {
    const recorded: Recorded[] = [];
    // Both slugs return identical ids — overlapping sets mapped to one NB set.
    vi.stubGlobal(
      "fetch",
      (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        recorded.push({ variantName: body.filters?.variantName, filters: body.filters });
        return new Response(
          JSON.stringify([
            { id: "shared-1", cardNo: "1", players: "A", setName: "score" },
            { id: "shared-2", cardNo: "2", players: "B", setName: "score" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    expect(recorded).toHaveLength(2);
    expect(result.cards).toHaveLength(2);
  });
});
