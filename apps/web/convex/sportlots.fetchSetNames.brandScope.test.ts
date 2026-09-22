/**
 * NEO-237 (D3) — `fetchSetNames` (convex/adapters/sportlots.ts, reached via
 * the public `fetchSportLotsSelectorOptions` action at `level: "insert"`)
 * narrows and strips its `brd`-scoped response by `brandScope.setNamePrefix`
 * ONLY when the request's `brd` field is SportLots' all-brands sentinel. A
 * real brand's `brd` id is untouched by construction, however the caller's
 * `brandScope` argument is populated — the setReconciliation.ts callers
 * always send it (`setReconciliation.brandScope.test.ts` pins that side); this
 * file pins the adapter's own gate on it.
 *
 * At convex/ ROOT (not co-located under convex/adapters/) — the
 * `import.meta.glob` module-registry rule; see `convex/sportlots.test.ts`'s
 * header for the precedent this file follows (credentials mocked, `fetch`
 * stubbed, same POST-body-capturing style).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_sl_brandscope",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_sl_brandscope",
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
      handler: async (): Promise<{ token: string }> => ({ token: "sl-session-cookie" }),
    }),
    authenticateSportlots: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

/** dealsets.tpl's radio-button body for a list of (id, label) sets. */
function dealsetsHtml(sets: Array<[string, string]>): string {
  return sets
    .map(
      ([id, label], i) =>
        `<input type="radio" Name="selset" Value="${id}"> </td> <td>${i + 1}  ${label}</td>`,
    )
    .join("\n");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubDealsetsFetch(html: string) {
  vi.stubGlobal(
    "fetch",
    (async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(html, { status: 200, headers: { "Content-Type": "text/html" } })) as typeof fetch,
  );
}

describe("fetchSetNames narrows only when brd is the all-brands sentinel", () => {
  test("brd = the sentinel + a brandScope: the list is narrowed to prefix-matching sets, stripped", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    stubDealsetsFetch(
      dealsetsHtml([
        ["1", "Bandai Series 1"],
        ["2", "Bandai Series 2"],
        ["3", "Topps Chrome"], // a different brand's set, on the same all-brands list
      ]),
    );

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
      level: "insert",
      parentFilters: { sport: "Hockey", year: "1997", manufacturer: "Bandai" },
      platformFilters: { sport: "HK", year: "1997", manufacturer: "All Brands" },
      brandScope: { setNamePrefix: "Bandai" },
    });

    expect(result.success).toBe(true);
    expect(result.options).toEqual([
      { value: "Series 1", platformValue: "1" },
      { value: "Series 2", platformValue: "2" },
    ]);
  });

  test("a REAL brand's brd id is returned UNTOUCHED even when a brandScope is passed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    stubDealsetsFetch(
      dealsetsHtml([
        ["1", "Topps Series 1"],
        ["2", "Topps Chrome"],
      ]),
    );

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
      level: "insert",
      parentFilters: { sport: "Hockey", year: "1997", manufacturer: "Topps" },
      // `brd` is a real SportLots brand id, NOT the sentinel — a brandScope
      // may still be passed unconditionally by the caller (D3's contract).
      platformFilters: { sport: "HK", year: "1997", manufacturer: "1" },
      brandScope: { setNamePrefix: "Topps" },
      labelContext: { manufacturer: "Topps" },
    });

    expect(result.success).toBe(true);
    // Today's case-sensitive labelContext strip applies, untouched by the
    // brandScope prefix logic — both sets survive, brand prefix stripped once.
    expect(result.options).toEqual([
      { value: "Series 1", platformValue: "1" },
      { value: "Chrome", platformValue: "2" },
    ]);
  });

  test("an all-brands request with NO brandScope is untouched (Unknown's own year-wide fetch)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    stubDealsetsFetch(
      dealsetsHtml([
        ["1", "Bandai Series 1"],
        ["2", "Topps Chrome"],
      ]),
    );

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
      level: "insert",
      parentFilters: { sport: "Hockey", year: "1997", manufacturer: "Unknown" },
      platformFilters: { sport: "HK", year: "1997", manufacturer: "All Brands" },
      // no brandScope
    });

    expect(result.success).toBe(true);
    expect(result.options.map((o) => o.value)).toEqual(["Bandai Series 1", "Topps Chrome"]);
  });

  test("an all-brands request with an EMPTY prefix is refused with SL_UNSCOPED_MESSAGE", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    stubDealsetsFetch(dealsetsHtml([["1", "Bandai Series 1"]]));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
      level: "insert",
      parentFilters: { sport: "Hockey", year: "1997", manufacturer: "Bandai" },
      platformFilters: { sport: "HK", year: "1997", manufacturer: "All Brands" },
      brandScope: { setNamePrefix: "   " },
    });

    expect(result.success).toBe(false);
    expect(result.options).toEqual([]);
    expect(result.message).toMatch(/scope|brand|sport|year/i);
  });

  test("no matching sets under the prefix returns an empty (but successful) list", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    stubDealsetsFetch(dealsetsHtml([["1", "Topps Chrome"]]));

    const result = await asAdmin.action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
      level: "insert",
      parentFilters: { sport: "Hockey", year: "1997", manufacturer: "Bandai" },
      platformFilters: { sport: "HK", year: "1997", manufacturer: "All Brands" },
      brandScope: { setNamePrefix: "Bandai" },
    });

    expect(result.success).toBe(true);
    expect(result.options).toEqual([]);
  });
});
