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
        platformData: { sportlots: { s0: "db-resolved-99999" } },
      platformSlotSeq: { sportlots: 1 },
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
        <!-- NEO-189: a variation row's NUMBER cell is "smallcolorleft", not
             "smallleft" — SportLots tints it. This fixture said "smallleft",
             which is why the parser's matching bug survived: the test data did
             not look like the site. Verified against live set 328996. -->
        <tr><td class="smallcolorleft">10</td><td class="smallleft">Aaron Judge [ VAR All-Star Logo ]</td></tr>
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

/**
 * Pagination (NEO-137).
 *
 * `listcards.tpl` returns at most 100 rows per request and `start` is a
 * 1-BASED ROW OFFSET, not a page number. Verified live against selset=3628
 * (1996 Score Base, 6 pages):
 *
 *   start=1   -> cards #1..#100
 *   start=2   -> cards #2..#101   <- offset, NOT a page index
 *   start=101 -> cards #101..#200
 *
 * The adapter used to POST once with start=1, so every set larger than 100
 * cards silently truncated to its first 100 — the reconciliation modal then
 * showed "SportLots only (0)" against hundreds of BSC-only rows, which reads
 * like a matching bug rather than a fetch bug.
 */

/** Build a listcards page containing `count` rows starting at card `from`. */
function listcardsHtml(from: number, count: number): string {
  let rows = "";
  for (let i = 0; i < count; i++) {
    const n = from + i;
    rows += `<td class="smallleft">${n}</td><td class="smallleft">Player ${n}</td>`;
  }
  return `<html><table>${rows}</table></html>`;
}

/** Serves pages keyed by the `start` form field, recording every request. */
function makePaginatedFetch(opts: {
  pageFor: (start: number) => string;
  starts: number[];
}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const start = Number(new URLSearchParams(body).get("start") ?? "1");
    opts.starts.push(start);
    return new Response(opts.pageFor(start), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchSportLotsChecklist pagination (NEO-137)", () => {
  test("walks every page and returns the whole set, not just the first page", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const starts: number[] = [];
    // Mirrors the REAL measured shape of selset=309098 (2024 Topps Chrome
    // Base, 300 cards): rows per page vary and none of them is 100.
    vi.stubGlobal("fetch", makePaginatedFetch({
      starts,
      pageFor: (start) => {
        if (start === 1) return listcardsHtml(1, 88);
        if (start === 101) return listcardsHtml(89, 92);
        if (start === 201) return listcardsHtml(181, 89);
        if (start === 301) return listcardsHtml(270, 31);
        return listcardsHtml(0, 0);
      },
    }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2024", setName: "Topps Chrome" },
      platformFilters: { variantType: "309098" },
    });

    expect(result.success).toBe(true);
    // The regression: 88 before the fix (page one only).
    expect(result.cards).toHaveLength(300);
    // Fixed stride of 100, and the walk only stops on the EMPTY page.
    expect(starts).toEqual([1, 101, 201, 301, 401]);
    // No gaps and no duplicates across the page boundaries.
    expect(result.cards[0].cardNumber).toBe("1");
    expect(result.cards[87].cardNumber).toBe("88");
    expect(result.cards[88].cardNumber).toBe("89");
    expect(result.cards[299].cardNumber).toBe("300");
    expect(new Set(result.cards.map((c) => c.cardNumber)).size).toBe(300);
  });

  test("a SHORT first page does not end the walk (the bug this fix corrects)", async () => {
    // Guards the exact mistake made first time round: breaking on
    // "rows < 100" stops at page one, because a full SL page legitimately
    // yields fewer than 100 parsed card rows.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const starts: number[] = [];
    vi.stubGlobal("fetch", makePaginatedFetch({
      starts,
      pageFor: (start) => (start === 1 ? listcardsHtml(1, 88)
        : start === 101 ? listcardsHtml(89, 12)
        : listcardsHtml(0, 0)),
    }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2024", setName: "Topps Chrome" },
      platformFilters: { variantType: "309098" },
    });

    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(100);
    expect(starts).toEqual([1, 101, 201]);
  });

  test("advances by a fixed 100, never by rows parsed", async () => {
    // Advancing by rows (88) would request start=89 and re-read earlier cards.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const starts: number[] = [];
    vi.stubGlobal("fetch", makePaginatedFetch({
      starts,
      pageFor: (start) => (start === 1 ? listcardsHtml(1, 88) : listcardsHtml(0, 0)),
    }));

    await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2024", setName: "Topps Chrome" },
      platformFilters: { variantType: "309098" },
    });

    expect(starts).toEqual([1, 101]);
    expect(starts).not.toContain(89);
  });

  test("stops immediately when the set is empty", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const starts: number[] = [];
    vi.stubGlobal("fetch", makePaginatedFetch({ starts, pageFor: () => listcardsHtml(0, 0) }));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2024", setName: "Topps Chrome" },
      platformFilters: { variantType: "309098" },
    });

    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(0);
    expect(starts).toEqual([1]);
  });

  test("fails the whole fetch rather than committing a truncated checklist when a later page errors", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const starts: number[] = [];
    vi.stubGlobal("fetch", (async (_u: unknown, init?: RequestInit) => {
      const start = Number(new URLSearchParams(String(init?.body ?? "")).get("start") ?? "1");
      starts.push(start);
      if (start === 1) return new Response(listcardsHtml(1, 88), { status: 200 });
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch);

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsChecklist, {
      parentFilters: { sport: "Baseball", year: "2024", setName: "Topps Chrome" },
      platformFilters: { variantType: "309098" },
    });

    // Partial data is worse than no data: committing it would persist a
    // checklist silently missing cards.
    expect(result.success).toBe(false);
    expect(result.cards).toHaveLength(0);
  });
});
