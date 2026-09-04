/**
 * NEO-239 — the variantType column sync, end to end, on the path the setup
 * flow actually walks.
 *
 * CI caught what a unit test could not: `.maestro/flows/setup.yaml` synced
 * 2024 Topps Chrome's variant types on an empty preview, the Base / Insert /
 * Parallel rows appeared, and tapping "Base" never produced the Base mapping
 * form — because `metadata.isBase` had not landed on the freshly inserted row
 * and `modules/SetSelector.tsx` gates that form on the ROLE, not on the name.
 *
 * The tests that existed called `storeSelectorOptions` directly with
 * hand-written options. This file drives the whole chain the column uses:
 *
 *   ResilientEntityColumn(useEnsureSync, level="variantType")
 *     → ensureSelectorOptions
 *       → fetchAggregatedOptions
 *         → adapters.buysportscards.fetchBscSelectorOptions   (stubbed at fetch)
 *         → storeSelectorOptions
 *
 * and asserts on the ROWS, which is the only place the FE looks.
 *
 * The fixture is BSC's real response shape for the `variant` aggregation —
 * `{ label, slug, count }` — because the whole class of bug here is a
 * derivation that reads the wrong one of those two fields, or matches a
 * literal against a casing or a slug form that BSC does not actually emit.
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
  subject: "admin_variant_sync",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_variant_sync",
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

/**
 * sport → year → manufacturer → setName, BSC-linked, SportLots deliberately
 * absent.
 *
 * The variantType column is BSC-only by construction — SportLots has no
 * variant concept and `fetchSportLotsSelectorOptions` answers "unsupported
 * level" there (see `modules/SetSelector.tsx`: "Variant Type (BSC only: Base,
 * Insert, Parallel, Promo)"). Leaving SL unlinked makes the side SKIP rather
 * than round-trip through the credential path, which is what this file is not
 * about and what made it non-deterministic when it did.
 */
async function seedSetRow(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" } },
      platformSlotSeq: { bsc: 1 },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { bsc: { b0: "2024" } },
      platformSlotSeq: { bsc: 1 },
      parentId: sport,
      children: [],
      lastUpdated: SENTINEL,
    });
    const manufacturer = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      // Unlinked on both sides — and BSC still resolves, because BSC has no
      // manufacturer facet. That is the NEO-239 behaviour change this whole
      // fixture quietly depends on: under the old `isCustom` gate a hand-added
      // manufacturer skipped BOTH marketplaces for everything beneath it, and
      // these variant types would never have synced at all.
      platformData: {},
      parentId: year,
      children: [],
      lastUpdated: SENTINEL,
    });
    return ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps Chrome",
      platformData: { bsc: { b0: "2024-topps-chrome" } },
      platformSlotSeq: { bsc: 1 },
      parentId: manufacturer,
      children: [],
      lastUpdated: SENTINEL,
    });
  });
}

/**
 * BSC's `/search/bulk-upload/filters` response for the `variant` aggregation.
 *
 * `label` is what the operator sees and what NB stores as the row's display
 * value; `slug` is the marketplace id that lands in the row's BSC slot. They
 * are DIFFERENT FIELDS, and this fixture is parameterised over the slug
 * precisely because the codebase has never had a recorded sample of what BSC
 * really emits there — the shipped assumption was
 * `variantType.toLowerCase()`, and that assumption is exactly what NEO-239
 * removed.
 */
function stubBscVariants(variants: Array<{ label: string; slug: string }>) {
  vi.stubGlobal(
    "fetch",
    (async () =>
      new Response(
        JSON.stringify({
          aggregations: {
            variant: variants.map((v) => ({ ...v, count: 42 })),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch,
  );
}

async function syncVariantTypes(
  t: ReturnType<typeof convexTest>,
  setId: Id<"selectorOptions">,
  opts: { force?: boolean } = {},
) {
  return t
    .withIdentity(ADMIN)
    .action(api.selectorOptions.ensureSelectorOptions, {
      level: "variantType",
      parentId: setId,
      // `ensureSelectorOptions` short-circuits on "already populated", keyed on
      // the ROWS. A test that seeds a row and expects a sync has to say so.
      ...(opts.force ? { force: true } : {}),
    });
}

async function variantTypeRows(
  t: ReturnType<typeof convexTest>,
  setId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "variantType").eq("parentId", setId),
      )
      .collect(),
  );
}

describe("Sync Variant Types — the Base row gets the role and the tag", () => {
  test("THE CI FAILURE: a fresh sync leaves Base able to open the Base mapping form", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    stubBscVariants([
      { label: "Base", slug: "base" },
      { label: "Insert", slug: "insert" },
      { label: "Parallel", slug: "parallel" },
    ]);

    const res = await syncVariantTypes(t, setId);
    expect(res.ran).toBe(true);

    const rows = await variantTypeRows(t, setId);
    expect(rows.map((r) => r.value).sort()).toEqual([
      "Base",
      "Insert",
      "Parallel",
    ]);

    const base = rows.find((r) => r.value === "Base")!;
    // The role. `modules/SetSelector.tsx` gates the Base mapping form on this
    // and nothing else, so without it the setup flow's tap on "Base" produces
    // no "Select Base Set" / "Re-map Base" control at all.
    expect(base.metadata?.isBase).toBe(true);
    // The tag. Without it the BSC side of every checklist under this row is
    // unresolvable and the Fetch step that follows returns SportLots only.
    expect(base.platformFacets?.bsc).toEqual({ b0: "variant" });

    // …and the role is EXCLUSIVE. Two base rows would make
    // `getBaseVariantBySet` answer by document order.
    for (const other of rows.filter((r) => r.value !== "Base")) {
      expect(other.metadata?.isBase).toBeUndefined();
      // The tag, though, belongs on every one of them: it is what the id IS.
      expect(other.platformFacets?.bsc).toEqual({ b0: "variant" });
    }
  });

  test("the role is read off BSC's SLUG, whatever BSC calls the label", async () => {
    // Marketplace id compared to marketplace id, once at creation — which the
    // invariant allows. What it forbids is deriving the role from the NB
    // DISPLAY VALUE, so an operator (or BSC) renaming the label must not move
    // the role.
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    stubBscVariants([
      { label: "Base Set Cards", slug: "base" },
      { label: "Insert", slug: "insert" },
    ]);

    await syncVariantTypes(t, setId);

    const rows = await variantTypeRows(t, setId);
    const base = rows.find((r) => r.value === "Base Set Cards")!;
    expect(base.metadata?.isBase).toBe(true);
    expect(rows.find((r) => r.value === "Insert")!.metadata?.isBase).toBeUndefined();
  });

  test("a label reading 'Base' with a slug that is NOT base gets no role", async () => {
    // The other half of the same statement. If this ever needs to change, the
    // fix is an operator pressing `setBaseVariantType`, not a name check
    // creeping back in.
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    stubBscVariants([{ label: "Base", slug: "insert" }]);

    await syncVariantTypes(t, setId);

    const rows = await variantTypeRows(t, setId);
    expect(rows[0].value).toBe("Base");
    expect(rows[0].metadata?.isBase).toBeUndefined();
  });

  test.each([
    ["title case", "Base"],
    ["upper case", "BASE"],
    ["padded", " base "],
    ["hyphenated", "base-set"],
    ["prefixed with the set", "2024-topps-chrome-base"],
  ])(
    "BSC emitting the base variant as %s still yields the role",
    async (_shape, slug) => {
      // We have no recorded sample of BSC's variant slug, and the codebase's
      // only prior evidence was an assumption (`variantType.toLowerCase()`)
      // that NEO-239 deleted for being one. The derivation therefore has to
      // recognise the base variant across the forms BSC plausibly emits rather
      // than pin one literal — a wrong guess here is silent, and the symptom
      // (a Base row that cannot open its own mapping form) shows up two screens
      // later.
      const t = convexTest(schema, modules);
      const setId = await seedSetRow(t);
      stubBscVariants([
        { label: "Base", slug },
        { label: "Insert", slug: "insert" },
      ]);

      await syncVariantTypes(t, setId);

      const rows = await variantTypeRows(t, setId);
      expect(rows.find((r) => r.value === "Base")!.metadata?.isBase).toBe(true);
      expect(
        rows.find((r) => r.value === "Insert")!.metadata?.isBase,
      ).toBeUndefined();
    },
  );

  test("TWO base-ish ids in one batch confer the role on NEITHER", async () => {
    // A token match cannot rank `base` against `base-parallel`, so it does not
    // try. Fail-closed is the right side to err on: a missing role is one
    // click of `setBaseVariantType` away, while two rival base rows make
    // `getBaseVariantBySet` answer by document order — a bug that reads as
    // "the Base mapping form sometimes edits the wrong row".
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    stubBscVariants([
      { label: "Base", slug: "base" },
      { label: "Base Parallel", slug: "base-parallel" },
    ]);

    await syncVariantTypes(t, setId);

    const rows = await variantTypeRows(t, setId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.metadata?.isBase === undefined)).toBe(true);
    // The facet tag is unaffected — that is a fact about each id, not a choice
    // between them.
    expect(rows.every((r) => r.platformFacets?.bsc !== undefined)).toBe(true);
  });

  test("a set whose base an OPERATOR chose is not re-derived by a later sync", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    const operatorChoice = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Insert",
        platformData: { bsc: { b0: "insert" } },
        platformFacets: { bsc: { b0: "variant" } },
        metadata: { isBase: true }, // set through setBaseVariantType
        primaryPlatformId: { bsc: "b0" },
        platformSlotSeq: { bsc: 1 },
        parentId: setId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    stubBscVariants([
      { label: "Base", slug: "base" },
      { label: "Insert", slug: "insert" },
    ]);

    await syncVariantTypes(t, setId, { force: true });

    const rows = await variantTypeRows(t, setId);
    // The operator's row keeps the role…
    expect(
      (await t.run(async (ctx) => ctx.db.get(operatorChoice)))?.metadata?.isBase,
    ).toBe(true);
    // …and the newly-inserted "Base" row does NOT take it, which would have
    // left the set with two.
    expect(rows.find((r) => r.value === "Base")?.metadata?.isBase).toBeUndefined();
  });

  test("a re-sync of an existing untagged Base row backfills both, and is then a no-op", async () => {
    // Every dev and prod variantType row predates this ticket. The column sync
    // is what most of them will meet first, so it has to heal them — and then
    // stop writing, or NEO-85's no-churn guarantee is gone and every column
    // reflows on every sync.
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: { b0: "base" } },
        primaryPlatformId: { bsc: "b0" },
        platformSlotSeq: { bsc: 1 },
        parentId: setId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    stubBscVariants([{ label: "Base", slug: "base" }]);

    await syncVariantTypes(t, setId, { force: true });
    const healed = await t.run(async (ctx) => ctx.db.get(existing));
    expect(healed?.metadata?.isBase).toBe(true);
    expect(healed?.platformFacets?.bsc).toEqual({ b0: "variant" });

    // Second run: nothing left to write.
    const stamp = healed?.lastUpdated;
    await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.ensureSelectorOptions, {
        level: "variantType",
        parentId: setId,
        force: true,
      });
    expect((await t.run(async (ctx) => ctx.db.get(existing)))?.lastUpdated).toBe(
      stamp,
    );
  });
});
