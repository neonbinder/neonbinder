/**
 * NEO-91: tests for `fetchSportLotsChecklist` (convex/adapters/sportlots.ts).
 * This is the first dedicated test file for that adapter.
 *
 * Lives at the convex/ ROOT (not co-located under convex/adapters/) for the
 * same import.meta.glob reason documented in
 * `convex/bscTeamEnrichmentQueue.test.ts`: convex-test's module registry
 * breaks when the glob is invoked from within convex/adapters/ itself.
 *
 * Two bugs fixed in this file's target function, both covered here:
 *
 * 1. `setRadioId` resolution used to read only `platformFilters.setName`
 *    (never populated for SL, which has no setName-level concept — it
 *    combines set+variant at variantType/insert/parallel), so the fetch
 *    always matched nothing. Fixed precedence, deepest-wins:
 *    parallel > insert > variantType > platformFilters.setName >
 *    parentFilters.setName direct > DB lookup fallback.
 *
 * 2. `platformRef` used to be the bare `cardNumber`, but SL reuses the same
 *    visible card number across "variation" rows on its own page, so the
 *    bare number can't disambiguate which SL row a card matched. Fixed to
 *    carry the raw, un-tokenized `fullDescription` instead. `sportlotsRef`
 *    is unchanged (still the bare card number — the correct BSC<->SL
 *    reconciliation key elsewhere).
 *
 * `getSportLotsCookie`'s underlying `internal.credentials.getSiteToken` is
 * mocked (following the `vi.mock` module-replacement convention already
 * established in `convex/fetchCardChecklistTeamLookup.test.ts` for adapter
 * actions) so these tests never need to seed real encrypted credentials or
 * hit the browser service. `fetch` itself is stubbed per
 * `convex/fetchBscCardTeamNames.test.ts`'s `vi.stubGlobal("fetch", ...)`
 * convention, capturing the POST body so we can assert on `selset`.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_sl_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_sl_001",
  name: "Admin User",
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
      returns: v.union(
        v.object({ token: v.string(), expiresAt: v.optional(v.float64()) }),
        v.null(),
      ),
      handler: async (): Promise<{ token: string }> => ({
        token: "sl-session-cookie",
      }),
    }),
  };
});

/** Records every POST body so tests can assert on the `selset` form field. */
function makeListcardsFetch(opts: {
  html: string;
  calls: Array<{ body: string }>;
}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    opts.calls.push({ body: String(init?.body ?? "") });
    return new Response(opts.html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }) as unknown as typeof fetch;
}

function extractSelset(body: string): string | undefined {
  return new URLSearchParams(body).get("selset") ?? undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSportLotsChecklist setRadioId resolution (NEO-91)", () => {
  test("platformFilters carrying only variantType is used as selset", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", makeListcardsFetch({ html: "<html></html>", calls }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2026", setName: "Topps" },
      platformFilters: { variantType: "12345" },
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(extractSelset(calls[0].body)).toBe("12345");
  });

  test("platformFilters carrying insert wins over variantType when both are present", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", makeListcardsFetch({ html: "<html></html>", calls }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2026", setName: "Topps" },
      platformFilters: { variantType: "12345", insert: "67890" },
    });

    expect(result.success).toBe(true);
    expect(extractSelset(calls[0].body)).toBe("67890");
  });

  test("platformFilters carrying insert alone (no variantType) is used as selset", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", makeListcardsFetch({ html: "<html></html>", calls }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2026", setName: "Topps" },
      platformFilters: { insert: "67890" },
    });

    expect(result.success).toBe(true);
    expect(extractSelset(calls[0].body)).toBe("67890");
  });

  test("platformFilters carrying parallel wins over both insert and variantType", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", makeListcardsFetch({ html: "<html></html>", calls }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2026", setName: "Topps" },
      platformFilters: {
        variantType: "11111",
        insert: "22222",
        parallel: "33333",
      },
    });

    expect(result.success).toBe(true);
    expect(extractSelset(calls[0].body)).toBe("33333");
  });

  test("platformFilters carrying none of variantType/insert/parallel but carrying setName preserves the old setName-direct behavior", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", makeListcardsFetch({ html: "<html></html>", calls }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2026", setName: "Topps" },
      platformFilters: { setName: "sl-topps-raw-display" },
    });

    expect(result.success).toBe(true);
    expect(extractSelset(calls[0].body)).toBe("sl-topps-raw-display");
  });

  test("platformFilters empty/undefined but parentFilters.setName present falls through to the DB-lookup path", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", makeListcardsFetch({ html: "<html></html>", calls }));

    // Seed a root-level (no parentId) setName selectorOptions row whose
    // platformData.sportlots is the resolved radio-button id —
    // resolveSportLotsPlatformValue's findByLevelAndValue lookup matches on
    // (level, parentId=undefined, value) case/whitespace-insensitively.
    await t.run(async (ctx) => {
      await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Topps",
        platformData: { sportlots: "db-resolved-99999" },
        children: [],
        lastUpdated: Date.now(),
      });
    });

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2026", setName: "Topps" },
    });

    expect(result.success).toBe(true);
    expect(extractSelset(calls[0].body)).toBe("db-resolved-99999");
  });

  test("no setRadioId resolvable at all (no platformFilters, no parentFilters.setName) returns a graceful failure, not a crash", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    vi.stubGlobal("fetch", makeListcardsFetch({ html: "<html></html>", calls: [] }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2026" },
    });

    expect(result.success).toBe(false);
    expect(result.cards).toEqual([]);
    expect(result.message).toMatch(/no set identifier/i);
  });
});

describe("fetchSportLotsChecklist platformRef carries the full per-row description (NEO-91)", () => {
  test("two SL rows sharing the same visible card number get DIFFERENT platformRef values, while sportlotsRef stays the bare number for both", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const calls: Array<{ body: string }> = [];
    const html = `
      <table>
        <tr><td class="smallleft">10</td><td class="smallleft">Aaron Judge</td></tr>
        <tr><td class="smallleft">10</td><td class="smallleft">Aaron Judge [ VAR All-Star Logo ]</td></tr>
      </table>
    `;
    vi.stubGlobal("fetch", makeListcardsFetch({ html, calls }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2026", setName: "Topps" },
      platformFilters: { variantType: "12345" },
    });

    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(2);

    const [row1, row2] = result.cards;
    // sportlotsRef unchanged — still the bare card number for both rows.
    expect(row1.sportlotsRef).toBe("10");
    expect(row2.sportlotsRef).toBe("10");

    // platformRef is the raw, un-tokenized description — different per row,
    // which is exactly what disambiguates them.
    expect(row1.platformRef).toBe("Aaron Judge");
    expect(row2.platformRef).toBe("Aaron Judge [ VAR All-Star Logo ]");
    expect(row1.platformRef).not.toBe(row2.platformRef);
  });
});
