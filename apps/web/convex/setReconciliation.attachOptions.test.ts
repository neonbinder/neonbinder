/**
 * NEO-252 — `fetchBscAttachOptions`, the BSC half of the attach dialog.
 *
 * Two things were wrong with the "variants" view's fallback, and they were the
 * same mistake in two costumes.
 *
 * It resolved the set to list variants of by reading the setName ANCESTOR's own
 * slots. A set NeonBinder built first has none — the operator attaches the BSC
 * set on the variant row, because that is where this dialog lives — so a path
 * that demonstrably names a BSC set was told it named none.
 *
 * And what it said was a hard failure carrying the operator's own set NAME:
 * "Missing platformData.bsc on: setName=<value>". An NB display value in a
 * client-facing string is the thing NEO-47 exists to prevent, and reporting an
 * ordinary unlinked state as a red alert sent the operator looking for an
 * outage instead of at the set list one click away.
 *
 * So: the set comes from `resolveBscFacetFilters` (the same plan the checklist
 * fetch builds its request from), and the no-set case is a SKIP with fixed
 * text. The dialog reads that by equality and hops to the set list.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { BSC_NO_LINKED_SET_MESSAGE } from "./marketplaceResolvability";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo252",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo252",
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

const HAND_TYPED_SET = "My Hand Typed Set";
const HAND_TYPED_SPORT = "My Hand Typed Sport";
const HAND_TYPED_YEAR = "Twenty Twenty Four";
const HAND_TYPED_MFR = "My Hand Typed Brand";
/**
 * Deliberately NOT "Base": that is a substring of the legitimate `baseball`
 * slug, so a negative assertion using it fails on a body that is perfectly
 * clean. A display value chosen to collide with real marketplace vocabulary
 * makes the test lie in the safe direction, which is the harder failure to
 * notice.
 */
const HAND_TYPED_VARIANT = "My Hand Typed Variant";
const BSC_SET_SLUG = "2024-topps";

/** Every NB display value on the seeded chain. None may reach the wire. */
const NB_DISPLAY_VALUES = [
  HAND_TYPED_SPORT,
  HAND_TYPED_YEAR,
  HAND_TYPED_MFR,
  HAND_TYPED_SET,
  HAND_TYPED_VARIANT,
];

/** Records every filters body sent to BSC's aggregation endpoint. */
function recordingBsc(recorded: Array<Record<string, string[]>>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/search/bulk-upload/filters")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      recorded.push((body.filters ?? {}) as Record<string, string[]>);
      return new Response(
        JSON.stringify({
          // BSC's own shape: { label, slug, count, active }.
          aggregations: {
            variantName: [{ label: "Gold Foil", slug: "gold-foil", count: 12 }],
            setName: [{ label: "Topps", slug: BSC_SET_SLUG, count: 300 }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/**
 * sport → year → manufacturer → setName(hand-typed) → variantType(Base).
 *
 * `baseSlots` / `baseFacets` are the variable under test: what, if anything,
 * the operator attached on the variant row.
 */
async function seedHandTypedSet(
  t: ReturnType<typeof convexTest>,
  baseSlots: Record<string, string>,
  baseFacets?: Record<string, "setName" | "variantName" | "variant">,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      // Display values deliberately unlike their slugs, so the negative
      // assertion below can actually see a leak. `fetchBscAttachOptions` passes
      // these to the adapter as `parentFilters`, which is telemetry — the
      // request body is built from `platformFilters` alone (NEO-239).
      value: HAND_TYPED_SPORT,
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: HAND_TYPED_YEAR,
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const mfrId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: HAND_TYPED_MFR,
      platformData: { sportlots: { s0: "TP" } },
      parentId: yearId,
      children: [],
      lastUpdated: SENTINEL,
    });
    // NB's own set. No marketplace ids — this is the row the old code read.
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: HAND_TYPED_SET,
      platformData: {},
      parentId: mfrId,
      children: [],
      lastUpdated: SENTINEL,
    });
    return ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: HAND_TYPED_VARIANT,
      platformData: { bsc: baseSlots },
      ...(baseFacets ? { platformFacets: { bsc: baseFacets } } : {}),
      ...(Object.keys(baseSlots).length > 0
        ? { primaryPlatformId: { bsc: Object.keys(baseSlots)[0] } }
        : {}),
      platformSlotSeq: { bsc: Object.keys(baseSlots).length },
      parentId: setNameId,
      children: [],
      lastUpdated: SENTINEL,
    });
  });
}

describe("fetchBscAttachOptions — the set comes from the facet plan", () => {
  test("a BSC set attached at the LEAF scopes the variants view", async () => {
    // The fix. Nothing on the setName row; the operator attached the BSC set
    // here, on the variant row, which is the only place the dialog offers.
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingBsc(recorded));
    const t = convexTest(schema, modules);
    const rowId = await seedHandTypedSet(
      t,
      { b0: "base", b1: BSC_SET_SLUG },
      { b0: "variant", b1: "setName" },
    );

    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchBscAttachOptions, {
        selectorOptionId: rowId,
        view: "variants",
      });

    expect(res.success).toBe(true);
    // Echoed back so the breadcrumb can name the set the pane is showing.
    expect(res.setSlug).toBe(BSC_SET_SLUG);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].setName).toEqual([BSC_SET_SLUG]);
    expect(res.options.map((o) => o.platformValue)).toContain("gold-foil");

    // …and NOTHING on the wire is an NB display value.
    //
    // The same negative assertion the checklist tests carry, and it belongs
    // here specifically because this action DOES hand the adapter NB names:
    // `fetchBscAttachOptions` passes `parentFilters: { sport, year }` off the
    // ancestor chain. NEO-239 deleted the branch that filled `filters` from
    // those when no `platformFilters` arrived — an NB name building a
    // marketplace query is the reverse dependency the invariant forbids, and
    // it was fail-open, since a name BSC does not know scopes nothing and BSC
    // answers 200 with a superset. `parentFilters` is telemetry now, and this
    // is what pins it there.
    const sent = Object.values(recorded[0]).flat().join(" ");
    for (const displayValue of NB_DISPLAY_VALUES) {
      expect(sent).not.toContain(displayValue);
      expect(sent).not.toContain(displayValue.toLowerCase());
    }
    // Every value that DID go out is a slot id off the chain.
    expect(recorded[0]).toEqual({
      sport: ["baseball"],
      year: ["2024"],
      setName: [BSC_SET_SLUG],
    });
  });

  test("no BSC set anywhere is a SKIP with fixed text, and no marketplace call", async () => {
    // The ordinary state of a set NeonBinder built and has not linked yet. It
    // is not an error, it names no NB row, and the pane it sends the operator
    // to is the one that fixes it.
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingBsc(recorded));
    const t = convexTest(schema, modules);
    const rowId = await seedHandTypedSet(t, {});

    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchBscAttachOptions, {
        selectorOptionId: rowId,
        view: "variants",
      });

    expect(res.success).toBe(true);
    expect(res.options).toEqual([]);
    expect(res.message).toBe(BSC_NO_LINKED_SET_MESSAGE);
    // Refused before the wire — there is nothing to scope a variants query by.
    expect(recorded).toHaveLength(0);
  });

  test("the LOG carries no NB row value either — the leak must not just move", async () => {
    // NEO-252, second pass. The client message was fixed by removing the set
    // name from it; the skip log beside it then printed `cxt.resolution.bsc
    // .missing`, whose entries are `label()` — `setName=<the operator's set
    // name>`. That is the same value with a different audience, and a Convex
    // log is retained and searchable, so it is not the safer place it looks.
    //
    // Note this resolution is LEVEL-scoped (the attach context passes
    // `slRequired`, not `bscScope`), so its entries really are the row-naming
    // kind — this path is exactly where the raw join was worst.
    const t = convexTest(schema, modules);
    const rowId = await seedHandTypedSet(t, {});

    await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchBscAttachOptions, {
        selectorOptionId: rowId,
        view: "variants",
      });

    const logged = (console.log as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls
      .map((call) => call.map((arg) => String(arg)).join(" "))
      .join("\n");

    // The line was written…
    expect(logged).toContain("[fetchBscAttachOptions] no BSC set on this path");
    // …with the count and the level NAMES, and none of the operator's text.
    expect(logged).toContain("missing=2 (setName,variantType)");
    for (const displayValue of NB_DISPLAY_VALUES) {
      expect(logged).not.toContain(displayValue);
    }
  });

  test("that message carries no NB row value — the old one carried the set NAME", async () => {
    // The regression this file exists for, stated directly. `message` is
    // client-facing text, so a row's display value must not be in it whatever
    // the row is called.
    vi.stubGlobal("fetch", recordingBsc([]));
    const t = convexTest(schema, modules);
    const rowId = await seedHandTypedSet(t, {});

    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchBscAttachOptions, {
        selectorOptionId: rowId,
        view: "variants",
      });

    expect(res.message).not.toContain(HAND_TYPED_SET);
    expect(res.message).not.toContain("platformData");
    expect(res.message).not.toContain("setName=");
  });

  test("an untagged leaf slug does NOT stand in for a set", async () => {
    // NEO-189's rule holds here too: an untagged variantType slug is not
    // self-describing (one class of them is a setName slug written into a
    // variantType row by a mis-saved Base mapping), so it contributes no facet
    // and this path still names no BSC set. Guessing would point the variants
    // pane at whatever that slug happens to be.
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingBsc(recorded));
    const t = convexTest(schema, modules);
    const rowId = await seedHandTypedSet(t, { b0: BSC_SET_SLUG });

    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchBscAttachOptions, {
        selectorOptionId: rowId,
        view: "variants",
      });

    expect(res.message).toBe(BSC_NO_LINKED_SET_MESSAGE);
    expect(recorded).toHaveLength(0);
  });

  test("the SETS view needs no set at all — it is the rung that finds one", async () => {
    // Deliberately not gated on `setName`: this pane browses the YEAR's sets,
    // which is exactly what an unlinked path needs. It was already true, and it
    // is what makes the skip above a one-click fix rather than a dead end.
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingBsc(recorded));
    const t = convexTest(schema, modules);
    const rowId = await seedHandTypedSet(t, {});

    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchBscAttachOptions, {
        selectorOptionId: rowId,
        view: "sets",
      });

    expect(res.success).toBe(true);
    expect(res.options.map((o) => o.platformValue)).toContain(BSC_SET_SLUG);
    expect(recorded).toHaveLength(1);
    // Scoped by sport + year only; no setName pin, or the year's list would be
    // one set long.
    expect(recorded[0].setName).toBeUndefined();
  });
});
