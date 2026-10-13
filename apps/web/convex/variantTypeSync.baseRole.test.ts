/**
 * NEO-239 / NEO-334 — the variantType column sync, end to end, on the path the
 * setup flow actually walks.
 *
 * Since NEO-334 a variant type's TITLE is its kind: the sync writes the
 * `variant` tag on the BSC slot and nothing else about the kind, and the
 * Base mapping form is gated on `variantTypeKind(row) === "base"`.
 *
 * This file drives the whole chain the column uses:
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
 * `{ label, slug, count }`: `label` becomes the row's title at creation,
 * `slug` lands in the BSC slot and is never read for the kind.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { resolveBscFacetFilters } from "./bscFacets";
import { slotLabel } from "./platformSlots";
import { variantTypeKind } from "./variantRole";

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

describe("Sync Variant Types — the title is the kind, the slot gets the tag (NEO-334)", () => {
  test("a fresh sync creates Base / Insert / Parallel rows tagged `variant`, writing no role flag", async () => {
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
    expect(rows.map((r) => r.value).sort()).toEqual(["Base", "Insert", "Parallel"]);

    // The tag belongs on every one of them: it is what the id IS. Without it
    // the BSC side of every checklist under the row is unresolvable.
    for (const row of rows) {
      expect(row.platformFacets?.bsc).toEqual({ b0: "variant" });
    }
    // …and the kinds come from the titles, exactly one Base.
    expect(rows.map((r) => [r.value, variantTypeKind(r)]).sort()).toEqual([
      ["Base", "base"],
      ["Insert", "insert"],
      ["Parallel", "parallel"],
    ]);
    expect(rows.filter((r) => variantTypeKind(r) === "base")).toHaveLength(1);
  });

  test("the kind follows BSC's LABEL (the stored title), never its slug", async () => {
    // The row is created from the label; after that the title is NB's. A slug
    // that says base under a label that is not the word is no Base.
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    stubBscVariants([
      { label: "Base Set Cards", slug: "base" },
      { label: "Base", slug: "insert" },
    ]);

    await syncVariantTypes(t, setId);

    const rows = await variantTypeRows(t, setId);
    expect(variantTypeKind(rows.find((r) => r.value === "Base Set Cards"))).toBeUndefined();
    expect(variantTypeKind(rows.find((r) => r.value === "Base"))).toBe("base");
  });

  test.each([
    ["title case", "Base"],
    ["upper case", "BASE"],
    ["padded", " base "],
    ["hyphenated", "base-set"],
    ["prefixed with the set", "2024-topps-chrome-base"],
  ])(
    "BSC emitting the base variant's slug as %s changes neither the kind nor the flags",
    async (_shape, slug) => {
      const t = convexTest(schema, modules);
      const setId = await seedSetRow(t);
      stubBscVariants([
        { label: "Base", slug },
        { label: "Insert", slug: "insert" },
      ]);

      await syncVariantTypes(t, setId);

      const rows = await variantTypeRows(t, setId);
      const base = rows.find((r) => r.value === "Base")!;
      expect(variantTypeKind(base)).toBe("base");
      expect(base.metadata).toBeUndefined();
      expect(base.platformFacets?.bsc).toEqual({ b0: "variant" });
      expect(variantTypeKind(rows.find((r) => r.value === "Insert"))).toBe("insert");
    },
  );

  test("`Base` and `Base Parallel` in one batch: only the title that is the word is the Base", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    stubBscVariants([
      { label: "Base", slug: "base" },
      { label: "Base Parallel", slug: "base-parallel" },
    ]);

    await syncVariantTypes(t, setId);

    const rows = await variantTypeRows(t, setId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => variantTypeKind(r) === "base").map((r) => r.value)).toEqual([
      "Base",
    ]);
    expect(rows.every((r) => r.metadata === undefined)).toBe(true);
    expect(rows.every((r) => r.platformFacets?.bsc !== undefined)).toBe(true);
  });

  test("a later sync does not add a second Base beside the one the set has", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: { b0: "base" } },
        platformFacets: { bsc: { b0: "variant" } },
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
    expect(rows.map((r) => r.value).sort()).toEqual(["Base", "Insert"]);
    expect(rows.find((r) => r.value === "Base")!._id).toBe(existing);
    expect(rows.filter((r) => variantTypeKind(r) === "base")).toHaveLength(1);
  });

  test("a re-sync of an existing untagged Base row backfills the tag only, and is then a no-op", async () => {
    // Every dev and prod variantType row predates the tag. The column sync is
    // what most of them meet first, so it heals them — and then stops
    // writing, or NEO-85's no-churn guarantee is gone.
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
    expect(healed?.platformFacets?.bsc).toEqual({ b0: "variant" });
    expect(healed?.metadata).toBeUndefined();

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

// ===========================================================================
// NEO-239 — Base mapping must not clobber the variant axis
// ===========================================================================

/**
 * The seed's next step after "Sync Variant Types": tap Base, and
 * `BaseMappingForm` writes the picked SportLots set plus a BSC slug through
 * `setVariantTypePlatformData`.
 *
 * The BSC slug it sends is a **setName** value — the picked set, or (the
 * common case, because BSC's variantName facet is usually empty under
 * `variant=base`) the setName ancestor's own slug. It is not a variant value.
 *
 * That mutation used to push it through `setPrimarySlotId`, which reuses the
 * primary slot KEY and overwrites its id: the Base row's `b0` went from "base"
 * to "2024-topps-chrome". NEO-189 recorded exactly this corruption and it was
 * survivable only because an untagged variantType slot contributed nothing to
 * the query. NEO-239 tags that slot `variant`, which would have made the wrong
 * id ACTIVE — every checklist fetch beneath the row sending
 * `variant: ["2024-topps-chrome"]`, a value BSC's variant axis does not have.
 */
describe("Base mapping writes setName alongside variant, never over it", () => {
  async function seedMappedBase(t: ReturnType<typeof convexTest>) {
    const setId = await seedSetRow(t);
    stubBscVariants([{ label: "Base", slug: "base" }]);
    await syncVariantTypes(t, setId);
    const [base] = await variantTypeRows(t, setId);
    return { setId, baseId: base._id };
  }

  test("the variant slot survives, and the set slug lands in its own tagged slot", async () => {
    const t = convexTest(schema, modules);
    const { baseId } = await seedMappedBase(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: baseId,
        platformData: {
          bsc: "2024-topps-chrome", // the setName ancestor's slug — the fallback
          sportlots: "884412",
          sportlotsDisplay: "2024 Topps Chrome",
        },
      });

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    const bsc = row!.platformData.bsc!;
    const facets = row!.platformFacets!.bsc!;

    // The variant axis is untouched — this is the whole point.
    const variantSlots = Object.entries(facets).filter(([, f]) => f === "variant");
    expect(variantSlots).toHaveLength(1);
    expect(bsc[variantSlots[0][0]]).toBe("base");

    // …and the set slug is present, in a slot that says what it is.
    const setNameSlots = Object.entries(facets).filter(([, f]) => f === "setName");
    expect(setNameSlots).toHaveLength(1);
    expect(bsc[setNameSlots[0][0]]).toBe("2024-topps-chrome");

    // SportLots is unaffected by any of this.
    expect(row!.platformData.sportlots).toEqual({ s0: "884412" });
    expect(row!.platformLabels?.sportlots).toEqual({ s0: "2024 Topps Chrome" });
  });

  test("re-mapping REFRESHES the setName slot rather than allocating a new one", async () => {
    // Slot keys are how cards are attributed, so a confirm that allocated a
    // fresh slot every time would both grow without bound and orphan whatever
    // pointed at the previous one.
    const t = convexTest(schema, modules);
    const { baseId } = await seedMappedBase(t);
    const write = (bsc: string) =>
      t.withIdentity(ADMIN).mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: baseId,
        platformData: { bsc, sportlots: "884412" },
      });

    await write("2024-topps-chrome");
    const first = await t.run(async (ctx) => ctx.db.get(baseId));
    await write("2024-topps-chrome-update");
    const second = await t.run(async (ctx) => ctx.db.get(baseId));

    expect(Object.keys(second!.platformData.bsc!)).toEqual(
      Object.keys(first!.platformData.bsc!),
    );
    expect(Object.values(second!.platformData.bsc!)).toContain(
      "2024-topps-chrome-update",
    );
    // Still exactly one of each axis.
    const facets = Object.values(second!.platformFacets!.bsc!);
    expect(facets.filter((f) => f === "variant")).toHaveLength(1);
    expect(facets.filter((f) => f === "setName")).toHaveLength(1);
  });

  test("the resulting chain queries BOTH axes — variant=base AND the set", async () => {
    // The end-to-end statement: what the mapped Base row makes the checklist
    // fetch send. `variant` must still be "base", or BSC answers with the
    // set's whole catalogue (base plus every insert and parallel).
    const t = convexTest(schema, modules);
    const { baseId } = await seedMappedBase(t);
    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: baseId,
        platformData: { bsc: "2024-topps-chrome", sportlots: "884412" },
      });

    const chain = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.getAncestorChain, { id: baseId });
    const plan = resolveBscFacetFilters(chain);

    expect(plan.filters.variant).toEqual(["base"]);
    expect(plan.filters.setName).toEqual(["2024-topps-chrome"]);
    expect(plan.filters.sport).toEqual(["baseball"]);
    expect(plan.filters.year).toEqual(["2024"]);
    // A setName-tagged slot on the leaf makes it the source of cards.
    expect(plan.sourceFacet).toBe("setName");
  });

  // -------------------------------------------------------------------------
  // The setName slot's LABEL (NEO-239)
  // -------------------------------------------------------------------------
  //
  // Without a label the chip fell back to the slug and the Multi-source panel
  // read "topps topps" — the same string as the chip's name and as its id.
  // `bscLabel` is the BSC twin of `sportlotsDisplay`, and the picker sends the
  // display name of whichever BSC set the operator chose.

  test("bscLabel names the setName slot it allocates", async () => {
    const t = convexTest(schema, modules);
    const { baseId } = await seedMappedBase(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: baseId,
        platformData: { bsc: "2024-topps-chrome", sportlots: "884412" },
        bscLabel: "2024 Topps Chrome",
      });

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    const setNameSlot = Object.entries(row!.platformFacets!.bsc!).find(
      ([, f]) => f === "setName",
    )![0];
    expect(row!.platformLabels?.bsc?.[setNameSlot]).toBe("2024 Topps Chrome");
    // The variant slot keeps whatever the SYNC gave it. A Base mapping write
    // says nothing about the variant axis and must not retitle it.
    const variantSlot = Object.entries(row!.platformFacets!.bsc!).find(
      ([, f]) => f === "variant",
    )![0];
    expect(row!.platformLabels?.bsc?.[variantSlot]).toBe("Base");
  });

  test("re-mapping with a new bscLabel refreshes the label on the same slot", async () => {
    const t = convexTest(schema, modules);
    const { baseId } = await seedMappedBase(t);
    const write = (bsc: string, bscLabel?: string) =>
      t.withIdentity(ADMIN).mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: baseId,
        platformData: { bsc, sportlots: "884412" },
        ...(bscLabel ? { bscLabel } : {}),
      });

    await write("topps-series-1", "Topps Series 1");
    await write("topps-series-2", "Topps Series 2");

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    const setNameSlots = Object.entries(row!.platformFacets!.bsc!).filter(
      ([, f]) => f === "setName",
    );
    expect(setNameSlots).toHaveLength(1);
    expect(row!.platformData.bsc![setNameSlots[0][0]]).toBe("topps-series-2");
    expect(row!.platformLabels?.bsc?.[setNameSlots[0][0]]).toBe("Topps Series 2");
  });

  test("omitting bscLabel on a re-map CLEARS the old one, so the chip shows the new slug", async () => {
    // The stale-label trap. `BaseMappingForm`'s fallback — the setName
    // ancestor's own slug, used because BSC's variantName facet is usually
    // empty under `variant=base` — has no display name to send. Keeping the
    // previous label would leave the chip naming a set this row no longer
    // draws from, which is worse than the slug: the slug is at least true.
    const t = convexTest(schema, modules);
    const { baseId } = await seedMappedBase(t);
    const write = (bsc: string, bscLabel?: string) =>
      t.withIdentity(ADMIN).mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: baseId,
        platformData: { bsc, sportlots: "884412" },
        ...(bscLabel ? { bscLabel } : {}),
      });

    await write("topps-series-1", "Topps Series 1");
    await write("2024-topps-chrome");

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    const setNameSlot = Object.entries(row!.platformFacets!.bsc!).find(
      ([, f]) => f === "setName",
    )![0];
    expect(row!.platformLabels?.bsc?.[setNameSlot]).toBeUndefined();
    // `slotLabel`'s fallback is the id, never the slot key.
    expect(slotLabel(row!, "bsc", setNameSlot)).toBe("2024-topps-chrome");
  });

  test("a legacy untagged slot gets the label too — same write, same path", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    const legacy = await t.run(async (ctx) =>
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

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: legacy,
        platformData: { bsc: "2024-topps-chrome" },
        bscLabel: "2024 Topps Chrome",
      });

    const row = await t.run(async (ctx) => ctx.db.get(legacy));
    expect(row!.platformLabels?.bsc).toEqual({ b0: "2024 Topps Chrome" });
  });

  test("a blank bscLabel is refused rather than stored", async () => {
    // `assertValidSlotLabel` is the one rule every label-writing path shares.
    const t = convexTest(schema, modules);
    const { baseId } = await seedMappedBase(t);

    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: baseId,
        platformData: { bsc: "2024-topps-chrome" },
        bscLabel: "x".repeat(201),
      }),
    ).rejects.toThrow(/exceeds/);
  });

  test("a legacy row with an UNTAGGED bsc slot keeps the old in-place refresh", async () => {
    // Backward compatibility: a Base row written before facets existed has no
    // variant slot to protect, and its primary is what BaseMappingForm has
    // always overwritten. Allocating a second slot for it would change which
    // slot that row's existing cards resolve through.
    const t = convexTest(schema, modules);
    const setId = await seedSetRow(t);
    const legacy = await t.run(async (ctx) =>
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

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: legacy,
        platformData: { bsc: "2024-topps-chrome" },
      });

    const row = await t.run(async (ctx) => ctx.db.get(legacy));
    expect(row!.platformData.bsc).toEqual({ b0: "2024-topps-chrome" });
    expect(row!.platformFacets?.bsc).toEqual({ b0: "setName" });
  });
});
