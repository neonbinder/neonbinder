/**
 * NEO-239 security conditions — the fail-open cases the audit blocked on.
 *
 * Every one of these is the same shape: a hard abort became a soft skip, and
 * something downstream reads "no error" as positive evidence. A skip that
 * looks like a success is worse than the gate it replaced, so each of the
 * three has a lock at the boundary that actually acts on it — not only at the
 * caller that is supposed to have decided already.
 *
 *   R1  a side skipped for want of ids must never enter `coveredSides`, or the
 *       unlink pass detaches every child row's primary slot on a side nobody
 *       queried. Enforced in the STORE mutations, because an SPA bundle
 *       deployed before this ticket keeps sending error-derived coverage.
 *   R2  a BSC checklist request without a `variant` value returns the set's
 *       base cards plus every insert and parallel in it. Enforced inside
 *       `fetchBscChecklist`.
 *   R3  the SportLots adapter's `|| displayValue` fallback sent an NB name as
 *       a marketplace id. Enforced in the adapter.
 *   R7  `variant` is a scope facet, not a card source, and only means anything
 *       on the row that owns the variant axis.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo239",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo239",
  name: "Admin",
  role: "admin",
};

const SENTINEL = 1_000_000;

/** Credentials are not under test — hand the BSC adapter a token. */
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

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// R1 — a skipped side never unlinks
// ===========================================================================

describe("R1 — a side with no ids on the chain cannot be 'covered'", () => {
  /**
   * sport → year → setName, with BSC ids and NO SportLots ids anywhere, plus
   * one child variantType row already linked on BOTH sides.
   *
   * The SL linkage on the child is the thing at risk: an SL sync that was
   * never run, reported as covered with an empty `returnedIds`, reads as
   * "upstream dropped every set" and detaches it.
   */
  async function seedBscOnlyTree(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const sport = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: { bsc: { b0: "baseball" } }, // no SL id
        children: [],
        lastUpdated: SENTINEL,
      });
      const year = await ctx.db.insert("selectorOptions", {
        level: "year",
        value: "2024",
        platformData: { bsc: { b0: "2024" } }, // no SL id
        parentId: sport,
        children: [],
        lastUpdated: SENTINEL,
      });
      const setName = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Topps",
        platformData: { bsc: { b0: "2024-topps" } },
        parentId: year,
        children: [],
        lastUpdated: SENTINEL,
      });
      const child = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: { b0: "base" }, sportlots: { s0: "884412" } },
        platformFacets: { bsc: { b0: "variant" } },
        primaryPlatformId: { bsc: "b0", sportlots: "s0" },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
        parentId: setName,
        children: [],
        lastUpdated: SENTINEL,
      });
      return { setName, child };
    });
  }

  test("storeSelectorOptions drops an unresolvable side from coveredSides even when the caller insists", async () => {
    // THE FAIL-OPEN CASE, sent exactly as an old SPA bundle would send it:
    // `coveredSides: ["bsc", "sportlots"]` built from errors, and empty
    // `returnedIds.sportlots` because SportLots was never asked.
    const t = convexTest(schema, modules);
    const { setName, child } = await seedBscOnlyTree(t);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.storeSelectorOptions, {
        level: "variantType",
        parentId: setName,
        options: [{ value: "Base", platformData: { bsc: "base" } }],
        coveredSides: ["bsc", "sportlots"],
        returnedIds: { bsc: ["base"], sportlots: [] },
      });

    // The SL link survives, and nothing is reported as unlinked on that side.
    const after = await t.run(async (ctx) => ctx.db.get(child));
    expect(after?.platformData.sportlots).toEqual({ s0: "884412" });
    expect(res.unlinked.some((u) => u.side === "sportlots")).toBe(false);
  });

  test("…and the same narrowing applies in storeReconciledOptions", async () => {
    const t = convexTest(schema, modules);
    const { setName, child } = await seedBscOnlyTree(t);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.setReconciliation.storeReconciledOptions, {
        level: "variantType",
        parentId: setName,
        reconciledItems: [
          {
            value: "Base",
            platformData: { bsc: "base" },
            existingId: child,
            metadata: undefined,
          },
        ],
        coveredSides: ["bsc", "sportlots"],
        returnedIds: { bsc: ["base"], sportlots: [] },
      });

    const after = await t.run(async (ctx) => ctx.db.get(child));
    expect(after?.platformData.sportlots).toEqual({ s0: "884412" });
    expect(res.unlinked.some((u) => u.side === "sportlots")).toBe(false);
  });

  test("a RESOLVABLE side still unlinks — the narrowing is not a blanket mute", async () => {
    // The guard must not turn the unlink pass off. BSC is resolvable on this
    // chain, so a BSC id the fetch stopped returning is still detached and
    // reported, which is NEO-211 D's whole point.
    const t = convexTest(schema, modules);
    const { setName, child } = await seedBscOnlyTree(t);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.storeSelectorOptions, {
        level: "variantType",
        parentId: setName,
        options: [{ value: "Insert", platformData: { bsc: "insert" } }],
        coveredSides: ["bsc", "sportlots"],
        returnedIds: { bsc: ["insert"], sportlots: [] },
      });

    const after = await t.run(async (ctx) => ctx.db.get(child));
    expect(after?.platformData.bsc).toBeUndefined();
    expect(res.unlinked.some((u) => u.side === "bsc")).toBe(true);
    // …and STILL not on the side that was never queried.
    expect(after?.platformData.sportlots).toEqual({ s0: "884412" });
  });
});

// ===========================================================================
// R2 — no BSC checklist request without a variant axis
// ===========================================================================

describe("R2 — `fetchBscChecklist` refuses an under-scoped request", () => {
  /** Records every outgoing bulk-upload body. */
  function recordingFetch(recorded: Array<Record<string, string[]>>) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(url).includes("/search/bulk-upload/results")) {
        recorded.push((body.filters ?? {}) as Record<string, string[]>);
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  const FULL_SCOPE = {
    sport: ["baseball"],
    year: ["2024"],
    setName: ["2024-topps"],
    variant: ["base"],
  };

  test.each([
    ["variant", { ...FULL_SCOPE, variant: [] }],
    ["setName", { ...FULL_SCOPE, setName: [] }],
    ["year", { ...FULL_SCOPE, year: [] }],
    ["sport", { ...FULL_SCOPE, sport: [] }],
  ])("a missing `%s` facet issues NO request at all", async (_facet, facetFilters) => {
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    const t = convexTest(schema, modules);

    const res = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: {
          sport: "Baseball",
          year: "2024",
          setName: "Topps",
          variantType: "Base",
        },
        facetFilters,
      });

    expect(recorded).toHaveLength(0);
    expect(res.success).toBe(false);
    expect(res.cards).toEqual([]);
  });

  test("`parentFilters` cannot supply the missing facet — it is telemetry now", async () => {
    // This is the removed pin, stated as a test. `parentFilters.variantType`
    // used to be lowercased into `filters.variant` outside the facet if/else,
    // which meant an NB DISPLAY VALUE built the marketplace query. Passing it
    // must now change nothing.
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    const t = convexTest(schema, modules);

    await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: { sport: "Baseball", year: "2024", variantType: "Base" },
        facetFilters: { ...FULL_SCOPE, variant: [] },
      });

    expect(recorded).toHaveLength(0);
  });

  test("a fully-scoped request goes out, and carries the variant from the SLOT", async () => {
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    const t = convexTest(schema, modules);

    await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: { sport: "Baseball", year: "2024", variantType: "Base" },
        facetFilters: FULL_SCOPE,
      });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].variant).toEqual(["base"]);
  });

  test("NO outgoing body ever carries an NB display value", async () => {
    // The audit's recommended negative test. Every value in the request body
    // must be a slot id; a value that appears as a `selectorOptions.value` and
    // not as a slot id is the reverse dependency the invariant forbids.
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    const t = convexTest(schema, modules);

    await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        // Display values chosen to be unmistakable if they ever leak.
        parentFilters: {
          sport: "E2E Test Sport 3",
          year: "Nineteen Ninety Six",
          setName: "My Hand Typed Set",
          variantType: "My Hand Typed Variant",
        },
        facetFilters: FULL_SCOPE,
      });

    expect(recorded).toHaveLength(1);
    const sent = Object.values(recorded[0]).flat().join(" ");
    for (const displayValue of [
      "E2E Test Sport 3",
      "Nineteen Ninety Six",
      "My Hand Typed Set",
      "My Hand Typed Variant",
    ]) {
      expect(sent).not.toContain(displayValue);
      expect(sent).not.toContain(displayValue.toLowerCase());
    }
  });
});

// ===========================================================================
// R3 — the SportLots adapter sends slot ids or nothing
// ===========================================================================

describe("R3 — SportLots refuses an unscoped request", () => {
  test("`labelContext` cleans the RESPONSE and never reaches the wire", async () => {
    // NEO-239 — the brand-prefix strip, restored as DERIVATION. SportLots names
    // its sets "Topps Series 1" where NB files "Series 1" under a "Topps" row,
    // and a fresh NB row seeds its display value from what comes back. The
    // invariant allows deriving a row from marketplace data at creation; what
    // it forbids is the reverse, an NB name building the query — so the
    // distinction is enforced by shape: `labelContext` is a separate parameter
    // read only after the response is parsed, and the request body is built
    // from slot ids by `resolveSlScope`, which never sees it.
    const outgoing: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL | Request, init?: RequestInit) => {
        outgoing.push(`${String(url)} ${String(init?.body ?? "")}`);
        return new Response(
          `<input type="radio" Name="selset" Value="884412"></td> <td>1  Topps Series 1</td>` +
            `<input type="radio" Name="selset" Value="884413"></td> <td>2  Bowman Chrome</td>`,
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );
    const t = convexTest(schema, modules);

    const res = await t
      .withIdentity(ADMIN)
      .action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
        level: "insert",
        parentFilters: {
          sport: "Baseball",
          year: "2024",
          manufacturer: "Topps",
        },
        // Slot ids — the ONLY thing that scopes the request.
        platformFilters: { sport: "BB", year: "2024", manufacturer: "TP" },
        // A distinctive NB label, so a leak onto the wire is unmistakable.
        labelContext: { manufacturer: "Topps" },
      });

    expect(res.success).toBe(true);
    // The prefix is stripped from the label that matched it, and the unrelated
    // one is left exactly alone.
    expect(res.options).toEqual([
      { value: "Series 1", platformValue: "884412" },
      { value: "Bowman Chrome", platformValue: "884413" },
    ]);

    // Nothing derived from `labelContext` was sent. The form carries the slot
    // ids and nothing else that could be mistaken for a name.
    const sent = outgoing.join(" ");
    expect(sent).toContain("sprt=BB");
    expect(sent).toContain("brd=TP");
    expect(sent).not.toContain("Topps");
    expect(sent).not.toContain("Baseball");
  });

  test("`labelContext` cannot scope a request that has no slot ids", async () => {
    // The refusal is unchanged by the restore: a manufacturer NAME is not an
    // id, and passing one as `labelContext` must not make an unscoped request
    // look scoped.
    const outgoing: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (_url: string | URL | Request, init?: RequestInit) => {
        outgoing.push(String(init?.body ?? ""));
        return new Response("<html></html>", { status: 200 });
      }) as unknown as typeof fetch,
    );
    const t = convexTest(schema, modules);

    const res = await t
      .withIdentity(ADMIN)
      .action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
        level: "insert",
        parentFilters: { sport: "Baseball", manufacturer: "Topps" },
        labelContext: { manufacturer: "Topps" },
      });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/no SportLots ids/i);
    expect(outgoing).toEqual([]);
  });

  test("a sport named in parentFilters with no SL id is refused, not sent by name", async () => {
    // `resolveSportLotsPlatformValue` used to end `|| displayValue`, so this
    // exact call put "E2E Test Sport 3" in the `sprt` form field. SL matches
    // nothing, returns a page, and the empty parse reads as "SportLots does
    // not carry this" — indistinguishable from a real empty answer.
    const outgoing: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (_url: string | URL | Request, init?: RequestInit) => {
        outgoing.push(String(init?.body ?? ""));
        return new Response("<html></html>", { status: 200 });
      }) as unknown as typeof fetch,
    );
    const t = convexTest(schema, modules);

    const res = await t
      .withIdentity(ADMIN)
      .action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
        level: "year",
        parentFilters: { sport: "E2E Test Sport 3" },
      });

    expect(res.success).toBe(false);
    expect(res.options).toEqual([]);
    expect(res.message).toMatch(/no SportLots ids/i);
    // Nothing containing the display value was ever put on the wire.
    expect(outgoing.join(" ")).not.toContain("E2E");
  });
});

// ===========================================================================
// R7 — `variant` is a scope facet, not an attachable source
// ===========================================================================

describe("R7 — the `variant` facet is refused on rows below variantType", () => {
  async function seedRow(
    t: ReturnType<typeof convexTest>,
    level: "variantType" | "insert" | "parallel",
  ): Promise<Id<"selectorOptions">> {
    return t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level,
        value: "Row",
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
  }

  test.each(["insert", "parallel"] as const)(
    "attaching a `variant` facet to a %s row throws",
    async (level) => {
      // Allowed through, that tag would make `resolveBscFacetFilters` send the
      // id as the query's VARIANT AXIS — silently re-scoping the checklist —
      // while `sourceFacet` would never name it, so the cards it returned
      // could not be bound to the slot they came from.
      const t = convexTest(schema, modules);
      const id = await seedRow(t, level);

      await expect(
        t.withIdentity(ADMIN).mutation(api.selectorOptions.attachPlatformIds, {
          selectorOptionId: id,
          additions: {
            bsc: [{ id: "base", label: "Base", facet: "variant" }],
          },
        }),
      ).rejects.toThrow(/only meaningful on a variantType row/);

      const after = await t.run(async (ctx) => ctx.db.get(id));
      expect(after?.platformData.bsc).toBeUndefined();
    },
  );

  test("a variantType row DOES accept it — that is the row the axis belongs to", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t, "variantType");

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.attachPlatformIds, {
        selectorOptionId: id,
        additions: { bsc: [{ id: "base", label: "Base", facet: "variant" }] },
      });

    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.platformFacets?.bsc).toEqual({ b0: "variant" });
  });

  test("setName / variantName are still attachable on an insert row", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t, "insert");

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.attachPlatformIds, {
        selectorOptionId: id,
        additions: {
          bsc: [{ id: "series-1", label: "Series 1", facet: "setName" }],
        },
      });

    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.platformFacets?.bsc).toEqual({ b0: "setName" });
  });
});
