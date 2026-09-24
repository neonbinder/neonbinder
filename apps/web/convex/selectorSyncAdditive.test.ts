/**
 * NEO-211 — the two selector-sync stores, end to end.
 *
 * The bug this ticket exists for: both stores matched incoming marketplace
 * rows by DISPLAY VALUE and then deleted every non-custom row the marketplace
 * had not named. So renaming a set and re-syncing deleted it — with its `_id`,
 * which is what its cards, its child rows and its cross-listings all point at —
 * and re-inserted an empty replacement under the marketplace's name. A single
 * marketplace outage did the same thing to every row linked only to the side
 * that went down.
 *
 * These tests pin the replacement: match by marketplace ID first, never
 * delete, and remove a marketplace link only when the caller explicitly says
 * that side was fetched successfully AND the fetch did not return the id.
 *
 * `lastUpdated` is used as a sentinel throughout: a real patch replaces it
 * with `Date.now()` (~1.7e12), so its survival is the observable proof that a
 * row was not written.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { SL_ALL_BRANDS_BRAND_ID } from "./slBrandAxis";
import {
  MAX_SUBTREE_WALK_INSERTS,
  loadVariantTypeSubtreeElsewhere,
} from "./selectorSyncStore";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo211_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo211_001",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;

beforeEach(() => {
  // Both stores log withheld matches; the noise is intentional in prod and
  // unhelpful here.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function admin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity(ADMIN_IDENTITY);
}

/** A manufacturer row to hang setName rows off. */
async function insertParent(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps Inc",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function rowsUnder(
  t: ReturnType<typeof convexTest>,
  level:
    | "sport"
    | "year"
    | "manufacturer"
    | "setName"
    | "variantType"
    | "insert"
    | "parallel",
  parentId: Id<"selectorOptions"> | undefined,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", level).eq("parentId", parentId),
      )
      .collect(),
  );
}

// ===========================================================================
// storeSelectorOptions
// ===========================================================================

describe("storeSelectorOptions is additive", () => {
  test("a renamed row survives a forced re-sync with its _id, its subtree and its name", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Topps", platformData: { bsc: "topps-2024" } }],
      coveredSides: ["bsc"],
    });
    const [created] = await rowsUnder(t, "setName", parentId);

    // A child row (a variantType) and a card, so "the subtree survived" is an
    // assertion about real referents rather than about `children` alone.
    const childId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId: created._id,
        children: [],
        lastUpdated: SENTINEL,
      });
      await ctx.db.patch(created._id, { children: [id] });
      return id;
    });

    await asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
      id: created._id,
      value: "TCG",
    });

    // Forced re-sync: BSC still calls it "Topps".
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Topps", platformData: { bsc: "topps-2024" } }],
      coveredSides: ["bsc"],
    });

    const after = await rowsUnder(t, "setName", parentId);
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(created._id);
    // NB owns the name. The sync has never written `value` and still does not.
    expect(after[0].value).toBe("TCG");
    expect(after[0].children).toEqual([childId]);
    // …but it records what the marketplace calls it, which is the entire input
    // to `getSelectorSyncSuggestions`.
    expect(after[0].platformLabels?.bsc?.b0).toBe("Topps");
    expect(
      await t.run(async (ctx) => ctx.db.get(childId)),
    ).toBeTruthy();
  });

  test("a set the marketplace stops listing keeps everything but its link, and is reported", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [
        { value: "Topps", platformData: { bsc: "t1", sportlots: "st1" } },
        { value: "Bowman", platformData: { bsc: "b1", sportlots: "sb1" } },
      ],
      coveredSides: ["bsc", "sportlots"],
    });
    const before = await rowsUnder(t, "setName", parentId);
    const bowman = before.find((r) => r.value === "Bowman")!;
    await t.run(async (ctx) => {
      await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId: bowman._id,
        children: [],
        lastUpdated: SENTINEL,
      });
    });

    // BSC drops Bowman. SportLots still lists it.
    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [
          { value: "Topps", platformData: { bsc: "t1", sportlots: "st1" } },
          { value: "Bowman", platformData: { sportlots: "sb1" } },
        ],
        coveredSides: ["bsc", "sportlots"],
      },
    );

    expect(res.unlinked).toEqual([
      { id: bowman._id, value: "Bowman", side: "bsc" },
    ]);
    expect(res.unlinkedTotal).toBe(1);

    const after = await rowsUnder(t, "setName", parentId);
    // Sets are fixed, never deleted — the row and its subtree are still here.
    expect(after).toHaveLength(2);
    const bowmanAfter = after.find((r) => r._id === bowman._id)!;
    expect(bowmanAfter.value).toBe("Bowman");
    expect(bowmanAfter.platformData.bsc).toBeUndefined();
    // The other side is untouched.
    expect(bowmanAfter.platformData.sportlots).toEqual({ s0: "sb1" });
    const kids = await rowsUnder(t, "variantType", bowman._id);
    expect(kids).toHaveLength(1);
  });

  test("a set that comes back under a NEW id re-links itself by name", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Bowman", platformData: { bsc: "b1" } }],
      coveredSides: ["bsc"],
    });
    const [bowman] = await rowsUnder(t, "setName", parentId);

    // BSC re-slugs. The old id never comes back; the new one is the same set.
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Bowman", platformData: { bsc: "b1-reslugged" } }],
      coveredSides: ["bsc"],
    });

    const after = await rowsUnder(t, "setName", parentId);
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(bowman._id);
    // The SLOT KEY is reused, so every card pointing at b0 keeps resolving —
    // that is the whole reason a re-slug must not become detach + re-attach.
    expect(after[0].platformData.bsc).toEqual({ b0: "b1-reslugged" });
  });

  test("an OLD bundle (no coveredSides) during a SportLots-only sync detaches nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Topps", platformData: { bsc: "t1", sportlots: "s1" } }],
      coveredSides: ["bsc", "sportlots"],
    });

    // The release-safety case: a bundle that predates `coveredSides` cannot
    // say "BSC was down", so it says nothing — and nothing is unlinked.
    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [{ value: "Topps", platformData: { sportlots: "s1" } }],
      },
    );

    expect(res.unlinked).toEqual([]);
    expect(res.unlinkedTotal).toBe(0);
    const [after] = await rowsUnder(t, "setName", parentId);
    expect(after.platformData.bsc).toEqual({ b0: "t1" });
  });

  test("declaring both sides but sending BSC-only items leaves SportLots alone", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Topps", platformData: { bsc: "t1", sportlots: "s1" } }],
      coveredSides: ["bsc", "sportlots"],
    });

    // Coverage is NARROWING: a declared side that carried no id anywhere in
    // the batch is not evidence that upstream dropped anything.
    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [{ value: "Topps", platformData: { bsc: "t1" } }],
        coveredSides: ["bsc", "sportlots"],
      },
    );

    expect(res.unlinked).toEqual([]);
    const [after] = await rowsUnder(t, "setName", parentId);
    expect(after.platformData.sportlots).toEqual({ s0: "s1" });
  });

  test("an EMPTY option list writes nothing, whatever it claims to cover", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Topps",
        platformData: { bsc: { b0: "t1" } },
        platformSlotSeq: { bsc: 1 },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [],
        coveredSides: ["bsc", "sportlots"],
      },
    );

    expect(res.unlinked).toEqual([]);
    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.lastUpdated).toBe(SENTINEL);
    expect(after?.platformData.bsc).toEqual({ b0: "t1" });
  });

  test("re-running the SAME sync reports nothing and patches nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const options = [
      { value: "Topps", platformData: { bsc: "t1", sportlots: "s1" } },
      { value: "Bowman", platformData: { bsc: "b1" } },
    ];

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options,
      coveredSides: ["bsc", "sportlots"],
    });
    const first = await rowsUnder(t, "setName", parentId);
    // Freeze `lastUpdated` so a second write is visible.
    await t.run(async (ctx) => {
      for (const r of first) await ctx.db.patch(r._id, { lastUpdated: SENTINEL });
    });

    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options,
        coveredSides: ["bsc", "sportlots"],
      },
    );

    // The unlink pass participates in the NEO-85 write-if-changed guard: an
    // identical sync produces no unlink, so no patch, so no reflow of every
    // SetSelector column under Maestro's coordinate taps.
    expect(res.unlinked).toEqual([]);
    const second = await rowsUnder(t, "setName", parentId);
    for (const r of second) expect(r.lastUpdated).toBe(SENTINEL);
  });

  test("a bucketed sync (syncSetsAcrossManufacturers) cannot unlink what another bucket returned", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [
        { value: "Topps Chrome", platformData: { bsc: "tc" } },
        { value: "Topps Heritage", platformData: { bsc: "th" } },
      ],
      coveredSides: ["bsc"],
    });

    // `syncSetsAcrossManufacturers` fetches ONE flat BSC set list for the year
    // and then buckets it by manufacturer-name prefix, so each per-bucket store
    // call sees only a slice of what the fetch returned. It therefore passes NO
    // coveredSides — declaring BSC covered on a slice would make every set
    // filed under a different manufacturer look delisted. This is that call.
    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [{ value: "Topps Chrome", platformData: { bsc: "tc" } }],
      },
    );

    expect(res.unlinked).toEqual([]);
    const after = await rowsUnder(t, "setName", parentId);
    const heritage = after.find((r) => r.value === "Topps Heritage")!;
    expect(heritage.platformData.bsc).toEqual({ b0: "th" });
  });

  test("NEO-287 — a paused side is dropped from coveredSides and its ids survive, with a warning naming the pause", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [
        { value: "Topps", platformData: { bsc: "t1", sportlots: "st1" } },
      ],
      coveredSides: ["bsc", "sportlots"],
    });
    const before = await rowsUnder(t, "setName", parentId);
    const topps = before.find((r) => r.value === "Topps")!;
    expect(topps.platformData.sportlots).toEqual({ s0: "st1" });

    // A re-sync that declares BOTH sides covered but no longer carries the SL
    // id — the shape that would ordinarily unlink SportLots. With SportLots
    // paused, the row must keep its id: nothing was actually asked this run.
    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Topps", platformData: { bsc: "t1" } }],
      coveredSides: ["bsc", "sportlots"],
    });

    expect(res.unlinked).toEqual([]);
    expect(res.unlinkedTotal).toBe(0);
    const after = await rowsUnder(t, "setName", parentId);
    const toppsAfter = after.find((r) => r._id === topps._id)!;
    expect(toppsAfter.platformData.sportlots).toEqual({ s0: "st1" });
    // BSC, unpaused, is untouched by the pause and still behaves normally.
    expect(toppsAfter.platformData.bsc).toEqual({ b0: "t1" });

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("sportlots is paused"),
    );

    delete process.env.NEONBINDER_PAUSED_PLATFORMS;
  });

  test("children is a union — a row the sync did not name keeps its place", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    const customId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "setName", value: "My Own Set", parentId },
    );
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [
        { value: "Topps", platformData: { bsc: "t1" } },
        { value: "Bowman", platformData: { bsc: "b1" } },
      ],
      coveredSides: ["bsc"],
    });
    const all = await rowsUnder(t, "setName", parentId);
    const bowman = all.find((r) => r.value === "Bowman")!;

    // BSC drops Bowman entirely.
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Topps", platformData: { bsc: "t1" } }],
      coveredSides: ["bsc"],
    });

    const parent = await t.run(async (ctx) => ctx.db.get(parentId));
    expect(parent?.children).toContain(customId);
    expect(parent?.children).toContain(bowman._id);
  });

  test("a cross-side conflict (bsc and sportlots ids pointing at DIFFERENT rows) is withheld — nothing destructive", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [
        { value: "Topps", platformData: { bsc: "t1" } },
        { value: "Bowman", platformData: { sportlots: "sb1" } },
      ],
      coveredSides: ["bsc", "sportlots"],
    });
    const before = await rowsUnder(t, "setName", parentId);
    const topps = before.find((r) => r.value === "Topps")!;
    const bowman = before.find((r) => r.value === "Bowman")!;

    // Upstream now believes these are ONE set — the wire item carries both
    // ids — but NB has them as two separate rows. A second, unrelated item in
    // the same batch proves the rest of the sync still lands normally.
    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [
        { value: "Merged Somehow", platformData: { bsc: "t1", sportlots: "sb1" } },
        { value: "Chrome", platformData: { bsc: "c1" } },
      ],
      coveredSides: ["bsc", "sportlots"],
    });

    const after = await rowsUnder(t, "setName", parentId);
    // No merge, no third row for the conflicting item, no deletion of either
    // side of the conflict — only the unrelated "Chrome" item lands.
    expect(after.map((r) => r.value).sort()).toEqual([
      "Bowman",
      "Chrome",
      "Topps",
    ]);
    const toppsAfter = after.find((r) => r._id === topps._id)!;
    const bowmanAfter = after.find((r) => r._id === bowman._id)!;
    expect(toppsAfter.lastUpdated).toBe(topps.lastUpdated);
    expect(toppsAfter.platformData.bsc).toEqual({ b0: "t1" });
    expect(bowmanAfter.lastUpdated).toBe(bowman.lastUpdated);
    expect(bowmanAfter.platformData.sportlots).toEqual({ s0: "sb1" });
    // The withheld item is not silently reported as unlinked either — nothing
    // about either row's linkage changed.
    expect(res.unlinked).toEqual([]);
  });
});

// ===========================================================================
// storeReconciledOptions
// ===========================================================================

describe("storeReconciledOptions is additive", () => {
  async function seedVariant(
    t: ReturnType<typeof convexTest>,
    parentId: Id<"selectorOptions">,
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Chrome Update",
        platformData: { bsc: { b0: "primary-slug", b1: "operator-extra" } },
        platformLabels: { bsc: { b0: "Chrome Update", b1: "Hand attached" } },
        platformFacets: { bsc: { b0: "variantName", b1: "setName" } },
        primaryPlatformId: { bsc: "b0" },
        platformSlotSeq: { bsc: 2 },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
  }

  test("an operator-attached extra is never auto-detached, facet and all", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const id = await seedVariant(t, parentId);

    // Neither of this row's ids comes back; the fetch returns a different set.
    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "insert",
        parentId,
        coveredSides: ["bsc"],
        reconciledItems: [
          {
            value: "Something Else",
            platformData: { bsc: "other-slug" },
            metadata: undefined,
          },
        ],
      },
    );

    const after = await t.run(async (ctx) => ctx.db.get(id));
    // The PRIMARY goes — upstream stopped listing it.
    expect(after?.platformData.bsc).toEqual({ b1: "operator-extra" });
    expect(after?.primaryPlatformId?.bsc).toBeUndefined();
    // The extra stays, with its NEO-189 facet tag. A level-scoped fetch not
    // mentioning a setName-facet id is no evidence about that id at all.
    expect(after?.platformFacets?.bsc).toEqual({ b1: "setName" });
    expect(after?.platformLabels?.bsc?.b1).toBe("Hand attached");
    expect(res.unlinked).toEqual([
      { id, value: "Chrome Update", side: "bsc", hasCards: false },
    ]);
  });

  test("unlinked entries say whether the row owns a checklist", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const id = await seedVariant(t, parentId);
    await t.run(async (ctx) => {
      await ctx.db.insert("cardChecklist", {
        selectorOptionId: id,
        cardNumber: "1",
        cardName: "Someone",
        sortOrder: 0,
        platformData: {},
        lastUpdated: SENTINEL,
      });
    });

    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "insert",
        parentId,
        coveredSides: ["bsc"],
        reconciledItems: [
          {
            value: "Something Else",
            platformData: { bsc: "other-slug" },
            metadata: undefined,
          },
        ],
      },
    );

    // "A stub lost its link" and "the set you entered 400 cards into lost its
    // link" are different notices.
    expect(res.unlinked[0].hasCards).toBe(true);
  });

  test("an existingId outside the sibling set can never steer a write", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const otherParentId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Panini Inc",
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    // (a) a row under a different parent, (b) a row at a different level,
    // (c) an id whose row has been deleted.
    const foreignParent = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Foreign Sibling",
        platformData: {},
        parentId: otherParentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const foreignLevel = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "parallel",
        value: "Foreign Level",
        platformData: {},
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const deleted = await t.run(async (ctx) => {
      const id = await ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Gone",
        platformData: {},
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      });
      await ctx.db.delete(id);
      return id;
    });

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      reconciledItems: [
        {
          value: "Aims At Another Parent",
          platformData: { bsc: "x1" },
          existingId: foreignParent,
          metadata: undefined,
        },
        {
          value: "Aims At Another Level",
          platformData: { bsc: "x2" },
          existingId: foreignLevel,
          metadata: undefined,
        },
        {
          value: "Aims At A Deleted Row",
          platformData: { bsc: "x3" },
          existingId: deleted,
          metadata: undefined,
        },
      ],
    });

    // All three fell through to insert.
    const inserted = await rowsUnder(t, "insert", parentId);
    expect(inserted.map((r) => r.value).sort()).toEqual([
      "Aims At A Deleted Row",
      "Aims At Another Level",
      "Aims At Another Parent",
    ]);
    // And neither foreign row was touched.
    const untouchedParent = await t.run(async (ctx) => ctx.db.get(foreignParent));
    expect(untouchedParent?.value).toBe("Foreign Sibling");
    expect(untouchedParent?.lastUpdated).toBe(SENTINEL);
    const untouchedLevel = await t.run(async (ctx) => ctx.db.get(foreignLevel));
    expect(untouchedLevel?.value).toBe("Foreign Level");
    expect(untouchedLevel?.lastUpdated).toBe(SENTINEL);
  });

  test("one row can be claimed by only one item — the second is WITHHELD", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Chrome",
        platformData: {},
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      reconciledItems: [
        {
          value: "Chrome",
          platformData: { bsc: "chrome-1" },
          existingId: id,
          metadata: undefined,
        },
        {
          value: "Chrome Refractors",
          platformData: { bsc: "chrome-2" },
          existingId: id,
          metadata: undefined,
        },
      ],
    });

    // Nothing is inserted for the second claim. Inserting would put a second
    // row sharing this parent under a name the matcher then has to withhold on
    // forever — one malformed batch permanently disabling name matching here.
    const after = await rowsUnder(t, "insert", parentId);
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(id);
    expect(after[0].platformData.bsc).toEqual({ b0: "chrome-1" });
  });

  test("a title edited in the modal renames the row it names (tier 0 only)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Chrome Update",
        platformData: { bsc: { b0: "chrome-1" } },
        platformSlotSeq: { bsc: 1 },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      coveredSides: ["bsc"],
      reconciledItems: [
        {
          value: "Chrome Update Series 2",
          platformData: { bsc: "chrome-1" },
          existingId: id,
          metadata: undefined,
        },
      ],
    });

    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.value).toBe("Chrome Update Series 2");
    // Same row: a rename in the modal used to be delete + empty insert.
    expect(after?._id).toBe(id);
  });

  test("an ID-matched row is NEVER renamed — only the modal's tier 0 can", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "My Name For It",
        platformData: { bsc: { b0: "chrome-1" } },
        platformSlotSeq: { bsc: 1 },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      coveredSides: ["bsc"],
      reconciledItems: [
        {
          value: "BSC's Name For It",
          platformData: { bsc: "chrome-1" },
          platformLabels: { bsc: { "chrome-1": "BSC's Name For It" } },
          metadata: undefined,
        },
      ],
    });

    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.value).toBe("My Name For It");
    // The marketplace's name is RECORDED, not applied — that is what the
    // suggestions query turns into an offer the operator can decline.
    expect(after?.platformLabels?.bsc?.b0).toBe("BSC's Name For It");
  });

  test("a no-op reconciliation does not bump lastUpdated (NEO-85, new here)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const items = [
      {
        value: "Chrome Update",
        platformData: { bsc: "chrome-1", sportlots: "sl-1" },
        platformLabels: {
          bsc: { "chrome-1": "Chrome Update" },
          sportlots: { "sl-1": "Chrome Update" },
        },
        metadata: undefined,
      },
    ];

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      coveredSides: ["bsc", "sportlots"],
      reconciledItems: items,
    });
    const [created] = await rowsUnder(t, "insert", parentId);
    await t.run(async (ctx) =>
      ctx.db.patch(created._id, { lastUpdated: SENTINEL }),
    );

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      coveredSides: ["bsc", "sportlots"],
      reconciledItems: items,
    });

    const after = await t.run(async (ctx) => ctx.db.get(created._id));
    // This mutation used to patch every matched row unconditionally.
    expect(after?.lastUpdated).toBe(SENTINEL);
  });

  test("a row the reconciler no longer names is not deleted, only unlinked", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      coveredSides: ["bsc"],
      reconciledItems: [
        { value: "Keep Me", platformData: { bsc: "k1" }, metadata: undefined },
        { value: "Drop Me", platformData: { bsc: "d1" }, metadata: undefined },
      ],
    });

    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "insert",
        parentId,
        coveredSides: ["bsc"],
        reconciledItems: [
          { value: "Keep Me", platformData: { bsc: "k1" }, metadata: undefined },
        ],
      },
    );

    const after = await rowsUnder(t, "insert", parentId);
    expect(after.map((r) => r.value).sort()).toEqual(["Drop Me", "Keep Me"]);
    expect(res.unlinked.map((u) => u.value)).toEqual(["Drop Me"]);
  });

  test("an OLD-shaped call (no coveredSides, no existingId) during a one-side-missing batch is additive-only", async () => {
    // Exactly the args shape origin/main's VariantForm/ParallelForm built
    // before NEO-211: no `coveredSides`, and every reconciled item carries
    // only ONE side's id (the pre-fix single-platform branch never populated
    // the other side's `platformData` key at all — see `bscOnly`/`bothEmpty`
    // fixtures in VariantForm.test.tsx). This is the release-safety property:
    // an old SPA bundle mid-deploy must not be ABLE to unlink or delete
    // anything, no matter what it sends.
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      coveredSides: ["bsc", "sportlots"],
      reconciledItems: [
        {
          value: "Chrome Update",
          platformData: { bsc: "chrome-1", sportlots: "sl-chrome-1" },
          metadata: undefined,
        },
        {
          value: "Refractors",
          platformData: { bsc: "chrome-2", sportlots: "sl-chrome-2" },
          metadata: undefined,
        },
      ],
    });
    const before = await rowsUnder(t, "insert", parentId);
    const chrome = before.find((r) => r.value === "Chrome Update")!;
    const refractors = before.find((r) => r.value === "Refractors")!;

    // The OLD shape: only bsc ids on the wire, no coveredSides at all.
    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "insert",
        parentId,
        reconciledItems: [
          {
            value: "Chrome Update",
            platformData: { bsc: "chrome-1" },
            metadata: undefined,
          },
          { value: "Brand New", platformData: { bsc: "new-1" }, metadata: undefined },
        ],
      },
    );

    expect(res.unlinked).toEqual([]);
    const after = await rowsUnder(t, "insert", parentId);
    // Additive insert landed; nothing was deleted.
    expect(after.map((r) => r.value).sort()).toEqual([
      "Brand New",
      "Chrome Update",
      "Refractors",
    ]);
    const chromeAfter = after.find((r) => r._id === chrome._id)!;
    // Matched row's OTHER side (sportlots, absent from this call entirely) is
    // untouched — silence must not be read as "SportLots dropped it".
    expect(chromeAfter.platformData.sportlots).toEqual({ s0: "sl-chrome-1" });
    // The row this batch never mentioned at all is completely untouched too.
    const refractorsAfter = after.find((r) => r._id === refractors._id)!;
    expect(refractorsAfter.lastUpdated).toBe(refractors.lastUpdated);
    expect(refractorsAfter.platformData).toEqual(refractors.platformData);
  });
});

// ===========================================================================
// NEO-211 F1 — the unlink universe is the FETCH, not the operator's list
// ===========================================================================

describe("returnedIds separates what upstream listed from what the operator confirmed", () => {
  /**
   * `ReconciliationModal` seeds EVERY existing row into Ready, so
   * `reconciledItems` is the operator's confirmed set — not the marketplace's.
   * Deriving the unlink universe from the items therefore gets both directions
   * wrong, and each direction has a test below.
   */
  async function seedTwo(t: ReturnType<typeof convexTest>) {
    const parentId = await insertParent(t);
    const asAdmin = admin(t);
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      reconciledItems: [
        { value: "Still Listed", platformData: { bsc: "live" }, metadata: undefined },
        { value: "Delisted", platformData: { bsc: "gone" }, metadata: undefined },
      ],
    });
    const rows = await rowsUnder(t, "insert", parentId);
    return {
      parentId,
      live: rows.find((r) => r.value === "Still Listed")!,
      gone: rows.find((r) => r.value === "Delisted")!,
    };
  }

  test("a restored row whose id upstream no longer returns IS unlinked", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const { parentId, gone } = await seedTwo(t);

    // The modal restored both rows into Ready, so both are in the items —
    // including the one BSC has actually dropped. Only `returnedIds` knows.
    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "insert",
        parentId,
        coveredSides: ["bsc"],
        returnedIds: { bsc: ["live"] },
        reconciledItems: [
          { value: "Still Listed", platformData: { bsc: "live" }, metadata: undefined },
          { value: "Delisted", platformData: { bsc: "gone" }, metadata: undefined },
        ],
      },
    );

    expect(res.unlinked.map((u) => u.value)).toEqual(["Delisted"]);
    const after = await t.run(async (ctx) => ctx.db.get(gone._id));
    expect(after?.platformData.bsc).toBeUndefined();
    expect(after?.value).toBe("Delisted");
  });

  test("a row the OPERATOR disbanded is not reported as delisted", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const { parentId, gone } = await seedTwo(t);

    // The operator removed "Delisted" from the modal. BSC still lists its id.
    // Saying "no longer listed on BSC" here would be a false statement about
    // the marketplace, made to the very person who just did it.
    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "insert",
        parentId,
        coveredSides: ["bsc"],
        returnedIds: { bsc: ["live", "gone"] },
        reconciledItems: [
          { value: "Still Listed", platformData: { bsc: "live" }, metadata: undefined },
        ],
      },
    );

    expect(res.unlinked).toEqual([]);
    expect(res.unlinkedTotal).toBe(0);
    const after = await t.run(async (ctx) => ctx.db.get(gone._id));
    expect(after?.platformData.bsc).toEqual({ b0: "gone" });
  });

  test("an explicitly EMPTY returned list means that side is not covered", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const { parentId, gone, live } = await seedTwo(t);

    // BSC answered with nothing. That is not evidence it dropped everything —
    // it is far more likely a filter or an auth problem upstream.
    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "insert",
        parentId,
        coveredSides: ["bsc"],
        returnedIds: { bsc: [] },
        reconciledItems: [
          { value: "Still Listed", platformData: { bsc: "live" }, metadata: undefined },
        ],
      },
    );

    expect(res.unlinked).toEqual([]);
    expect(
      (await t.run(async (ctx) => ctx.db.get(gone._id)))?.platformData.bsc,
    ).toEqual({ b0: "gone" });
    expect(
      (await t.run(async (ctx) => ctx.db.get(live._id)))?.platformData.bsc,
    ).toEqual({ b0: "live" });
  });

  test("a real big year (2,563 SportLots sets, 76-item batch) stores normally", async () => {
    // The CI seed flow that caught this: 2024 Topps Chrome "Sync Inserts".
    // SportLots returns 2,563 sets for the year, the form passes them all as
    // `returnedIds.sportlots`, and the old 2,000 cap THREW — so "Save 76 sets"
    // never completed and the Reconcile Inserts dialog just sat there. A bound
    // that only guards the unlink pass must never cost the operator the save.
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    const batch = Array.from({ length: 76 }, (_, i) => ({
      value: `Insert ${i}`,
      platformData: { sportlots: `sl-${i}` },
      metadata: undefined,
    }));
    const universe = Array.from({ length: 2563 }, (_, i) => `sl-${i}`);

    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "insert",
        parentId,
        coveredSides: ["sportlots"],
        returnedIds: { sportlots: universe },
        reconciledItems: batch,
      },
    );

    expect(res.success).toBe(true);
    expect(res.optionsCount).toBe(76);
    expect(res.returnedIdsTruncatedSides).toEqual([]);
    expect(await rowsUnder(t, "insert", parentId)).toHaveLength(76);
  });

  test("a side over the cap degrades to 'not covered' instead of losing the save", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [
        { value: "Topps", platformData: { bsc: "t1" } },
        { value: "Bowman", platformData: { bsc: "b1" } },
      ],
      coveredSides: ["bsc"],
    });

    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [{ value: "Topps", platformData: { bsc: "t1" } }],
        coveredSides: ["bsc"],
        returnedIds: {
          bsc: Array.from({ length: 20001 }, (_, i) => `id-${i}`),
        },
      },
    );

    // The store still ran…
    expect(res.success).toBe(true);
    expect(res.optionsCount).toBe(1);
    // …and reported which side it could not judge…
    expect(res.returnedIdsTruncatedSides).toEqual(["bsc"]);
    // …and unlinked nothing on it, so Bowman keeps its slug even though the
    // options list did not name it.
    expect(res.unlinked).toEqual([]);
    const rows = await rowsUnder(t, "setName", parentId);
    expect(rows.find((r) => r.value === "Bowman")?.platformData.bsc).toEqual({
      b0: "b1",
    });
  });

  test("only a grossly abusive total still throws", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    await expect(
      asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
        level: "setName",
        parentId,
        options: [{ value: "Topps", platformData: { bsc: "t1" } }],
        coveredSides: ["bsc"],
        returnedIds: {
          bsc: Array.from({ length: 60000 }, (_, i) => `b-${i}`),
          sportlots: Array.from({ length: 60000 }, (_, i) => `s-${i}`),
        },
      }),
    ).rejects.toThrow(/over the 100000 hard limit/);
  });

  test("a dedupe collision cannot make a live id look delisted", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Topps", platformData: { bsc: "t1" } }],
      coveredSides: ["bsc"],
    });

    // `fetchAggregatedOptions` folds two same-named marketplace options into
    // one entry and keeps the LAST id per side, so "t1" disappears from the
    // options it hands the store even though BSC returned it. The raw fetch
    // list is what the store must judge staleness against.
    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [{ value: "Topps", platformData: { bsc: "t2" } }],
        coveredSides: ["bsc"],
        returnedIds: { bsc: ["t1", "t2"] },
      },
    );

    // "t1" came back, so nothing is unlinked and nothing is rebound — the row
    // simply is not free for a name match while its id is live.
    expect(res.unlinked).toEqual([]);
    expect(res.relinked).toEqual([]);
    const rows = await rowsUnder(t, "setName", parentId);
    expect(rows.find((r) => r.value === "Topps")?.platformData.bsc).toEqual({
      b0: "t1",
    });
  });

  test("storeSelectorOptions honours returnedIds the same way", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [
        { value: "Topps", platformData: { bsc: "t1" } },
        { value: "Bowman", platformData: { bsc: "b1" } },
      ],
      coveredSides: ["bsc"],
    });

    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [{ value: "Topps", platformData: { bsc: "t1" } }],
        coveredSides: ["bsc"],
        returnedIds: { bsc: ["t1", "b1"] },
      },
    );

    // Bowman is missing from the options but the fetch DID return its slug, so
    // its absence says nothing about BSC.
    expect(res.unlinked).toEqual([]);
    const rows = await rowsUnder(t, "setName", parentId);
    expect(
      rows.find((r) => r.value === "Bowman")?.platformData.bsc,
    ).toEqual({ b0: "b1" });
  });
});

// ===========================================================================
// NEO-211 F4 — nothing writes `value` unvalidated
// ===========================================================================

describe("marketplace strings are validated before they become row names", () => {
  const CONTROL = "Topps\nSeries 1";
  const TOO_LONG = "x".repeat(300);

  test("storeSelectorOptions skips an unnameable option and keeps the rest", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [
          { value: "Topps", platformData: { bsc: "t1" } },
          { value: CONTROL, platformData: { bsc: "c1" } },
          { value: TOO_LONG, platformData: { bsc: "l1" } },
        ],
        coveredSides: ["bsc"],
      },
    );

    const rows = await rowsUnder(t, "setName", parentId);
    expect(rows.map((r) => r.value)).toEqual(["Topps"]);
    expect(res.optionsCount).toBe(1);
  });

  test("storeReconciledOptions skips an unnameable item and a bad label", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId,
      reconciledItems: [
        { value: CONTROL, platformData: { bsc: "c1" }, metadata: undefined },
        {
          value: "Chrome Update",
          platformData: { bsc: "ok-1" },
          // A label written by an older build, or by a path predating the
          // label check. `assertValidSlotLabel` would THROW on this inside
          // initialSlots and lose every item after it in the batch.
          platformLabels: { bsc: { "ok-1": TOO_LONG } },
          metadata: undefined,
        },
      ],
    });

    const rows = await rowsUnder(t, "insert", parentId);
    expect(rows.map((r) => r.value)).toEqual(["Chrome Update"]);
    // The id still attaches; only the unusable label is dropped.
    expect(rows[0].platformData.bsc).toEqual({ b0: "ok-1" });
    expect(rows[0].platformLabels?.bsc?.b0).toBeUndefined();
  });

  test("an inserted value is trimmed on the way in", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "  Topps  ", platformData: { bsc: "t1" } }],
      coveredSides: ["bsc"],
    });
    const rows = await rowsUnder(t, "setName", parentId);
    expect(rows[0].value).toBe("Topps");
  });
});

// ===========================================================================
// NEO-237 / security review S3 — the reserved view name is refused at insert
// ===========================================================================

describe("storeSelectorOptions never inserts a manufacturer row named after the All Brands view", () => {
  test("a manufacturer option folding to 'all brands' is skipped, counted, and never inserted", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);

    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "manufacturer",
      options: [
        { value: "Topps", platformData: { bsc: "topps-2024" } },
        { value: "  ALL brands ", platformData: { bsc: "ab-1" } },
      ],
      coveredSides: ["bsc"],
    });

    const rows = await t.run((ctx) => ctx.db.query("selectorOptions").collect());
    expect(rows.map((r) => r.value)).toEqual(["Topps"]);
    expect(res.reservedNamesSkipped).toBe(1);
    expect(res.optionsCount).toBe(1);
  });

  test("`reservedNamesSkipped` is zero on every normal sync", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);

    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "manufacturer",
      options: [{ value: "Topps", platformData: { bsc: "topps-2024" } }],
      coveredSides: ["bsc"],
    });
    expect(res.reservedNamesSkipped).toBe(0);
  });

  test("does not apply at other levels — a setName can be named anything (folding rule is manufacturer-only)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "All Brands", platformData: { bsc: "ab-1" } }],
      coveredSides: ["bsc"],
    });

    const rows = await rowsUnder(t, "setName", parentId);
    expect(rows.map((r) => r.value)).toEqual(["All Brands"]);
    expect(res.reservedNamesSkipped).toBe(0);
  });
});

// ===========================================================================
// NEO-211 — a re-slug rebinding is reported
// ===========================================================================

describe("relinked", () => {
  test("a name-tier rebind onto a new id is reported, and only then", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Bowman", platformData: { bsc: "b1" } }],
      coveredSides: ["bsc"],
    });
    const [bowman] = await rowsUnder(t, "setName", parentId);

    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [{ value: "Bowman", platformData: { bsc: "b1-reslugged" } }],
        coveredSides: ["bsc"],
      },
    );

    // The slot key is reused so nothing orphans — but every card under this
    // row now points at a different marketplace set, which is not something to
    // do silently.
    expect(res.relinked).toEqual([
      { id: bowman._id, value: "Bowman", side: "bsc" },
    ]);
    expect(res.relinkedTotal).toBe(1);

    // An identical re-sync rebinds nothing.
    const again = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [{ value: "Bowman", platformData: { bsc: "b1-reslugged" } }],
        coveredSides: ["bsc"],
      },
    );
    expect(again.relinked).toEqual([]);
  });

  test("an id-tier match is not a relink even when the row was renamed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Topps", platformData: { bsc: "t1" } }],
      coveredSides: ["bsc"],
    });
    const [created] = await rowsUnder(t, "setName", parentId);
    await asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
      id: created._id,
      value: "TCG",
    });

    const res = await asAdmin.mutation(
      api.selectorOptions.storeSelectorOptions,
      {
        level: "setName",
        parentId,
        options: [{ value: "Topps", platformData: { bsc: "t1" } }],
        coveredSides: ["bsc"],
      },
    );
    // Same id, same set, nothing rebound.
    expect(res.relinked).toEqual([]);
  });
});

// ===========================================================================
// NEO-237 — a hand-typed brand's SportLots PLACEHOLDER is upgraded, not
// re-slugged, when Sync Manufacturers lists the brand under its own id
// ===========================================================================

describe("linkedFromPlaceholder", () => {
  /** A sport + year that can scope SportLots, so the SL side is coverable. */
  async function insertYear(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Hockey",
        platformData: { sportlots: { s0: "HK" } },
        platformSlotSeq: { sportlots: 1 },
        children: [],
        lastUpdated: SENTINEL,
      });
      const yearId = await ctx.db.insert("selectorOptions", {
        level: "year",
        value: "1997",
        platformData: { sportlots: { s0: "1997" } },
        platformSlotSeq: { sportlots: 1 },
        parentId: sportId,
        children: [],
        lastUpdated: SENTINEL,
      });
      return yearId;
    });
  }

  /** Exactly the row `addCustomSelectorOption` writes for a typed brand. */
  async function insertViaAllBrands(
    t: ReturnType<typeof convexTest>,
    yearId: Id<"selectorOptions">,
    value: string,
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value,
        metadata: { setNamePrefix: value },
        platformData: { sportlots: { s0: SL_ALL_BRANDS_BRAND_ID } },
        platformLabels: { sportlots: { s0: value } },
        platformSlotSeq: { sportlots: 1 },
        parentId: yearId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
  }

  test("the real brand id lands in the placeholder's slot; counted as an upgrade, not a relink; the other holder keeps its placeholder", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const yearId = await insertYear(t);
    // Typed before Sync Manufacturers ran: Topps (which SportLots DOES list)
    // and Bandai (which it does not).
    const toppsId = await insertViaAllBrands(t, yearId, "Topps");
    const bandaiId = await insertViaAllBrands(t, yearId, "Bandai");

    // What `fetchAggregatedOptions` sends after routing the all-brands
    // option out (D6): the real brands as options, the sentinel still in
    // the returned universe.
    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "manufacturer",
      parentId: yearId,
      options: [{ value: "Topps", platformData: { sportlots: "1" } }],
      coveredSides: ["sportlots"],
      returnedIds: { sportlots: ["1", SL_ALL_BRANDS_BRAND_ID] },
    });

    const rows = await rowsUnder(t, "manufacturer", yearId);
    expect(rows).toHaveLength(2); // nothing inserted — Topps was MATCHED

    const topps = rows.find((r) => r._id === toppsId)!;
    // Same slot key, now the real id and the marketplace's label.
    expect(topps.platformData.sportlots).toEqual({ s0: "1" });
    expect(topps.platformLabels?.sportlots).toEqual({ s0: "Topps" });
    expect(topps.platformSlotSeq).toEqual({ sportlots: 1 });
    expect(topps.value).toBe("Topps");
    expect(topps.metadata?.setNamePrefix).toBe("Topps");

    // Reported as an upgrade from a placeholder — NOT as a re-slug, which
    // would claim every card under the row was reattributed.
    expect(res.relinked).toEqual([]);
    expect(res.relinkedTotal).toBe(0);
    expect(res.linkedFromPlaceholder).toBe(1);
    expect(res.unlinked).toEqual([]);

    // Bandai: no incoming id, sentinel still returned → untouched, link kept.
    const bandai = rows.find((r) => r._id === bandaiId)!;
    expect(bandai.platformData.sportlots).toEqual({ s0: SL_ALL_BRANDS_BRAND_ID });
    expect(bandai.platformLabels?.sportlots).toEqual({ s0: "Bandai" });
    expect(bandai.lastUpdated).toBe(SENTINEL); // not even patched
  });

  test("a brand holding a REAL SportLots id is not upgraded by a same-named different id", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const yearId = await insertYear(t);
    const toppsId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Topps",
        metadata: { setNamePrefix: "Topps" },
        platformData: { sportlots: { s0: "1" } },
        platformSlotSeq: { sportlots: 1 },
        parentId: yearId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "manufacturer",
      parentId: yearId,
      options: [
        { value: "Topps", platformData: { sportlots: "1" } },
        { value: "Topps", platformData: { sportlots: "2" } },
      ],
      coveredSides: ["sportlots"],
      returnedIds: { sportlots: ["1", "2", SL_ALL_BRANDS_BRAND_ID] },
    });

    const rows = await rowsUnder(t, "manufacturer", yearId);
    expect(rows).toHaveLength(1); // the second Topps was withheld, not inserted
    expect(rows[0]._id).toBe(toppsId);
    expect(rows[0].platformData.sportlots).toEqual({ s0: "1" });
    expect(res.linkedFromPlaceholder).toBe(0);
    expect(res.relinked).toEqual([]);
  });

  test("`linkedFromPlaceholder` is zero on every normal sync, and the re-slug heal is still `relinked`", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Bowman", platformData: { bsc: "b1" } }],
      coveredSides: ["bsc"],
    });
    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Bowman", platformData: { bsc: "b1-reslugged" } }],
      coveredSides: ["bsc"],
    });
    expect(res.linkedFromPlaceholder).toBe(0);
    expect(res.relinkedTotal).toBe(1);
  });
});

// ===========================================================================
// NEO-300 — a grouped row is not re-created by the next sync
// ===========================================================================

describe("a row grouped between insert and parallel is not re-created by the next sync (NEO-300)", () => {
  /** An insert-role variant type, the parent of a Sync Inserts. */
  async function insertVariantType(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Inserts",
        platformData: { bsc: { b0: "insert" } },
        platformFacets: { bsc: { b0: "variant" } },
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
  }

  const insertPayload = [
    {
      value: "Chrome",
      platformData: { bsc: "chrome-v", sportlots: "sl-chrome" },
      metadata: undefined,
    },
    {
      value: "Refractor",
      platformData: { bsc: "refractor-v" },
      metadata: undefined,
    },
    {
      value: "Gold Refractor",
      platformData: { bsc: "gold-v", sportlots: "sl-gold" },
      metadata: undefined,
    },
  ];

  /**
   * Re-stamp rows with the sentinel after a grouping (which stamps `now`), so
   * "the sync did not write it" is not a same-millisecond coin-flip.
   */
  async function stamp(
    t: ReturnType<typeof convexTest>,
    ids: Id<"selectorOptions">[],
  ) {
    await t.run(async (ctx) => {
      for (const id of ids) await ctx.db.patch(id, { lastUpdated: SENTINEL });
    });
  }

  async function byValue(
    t: ReturnType<typeof convexTest>,
    level: "insert" | "parallel",
    parentId: Id<"selectorOptions">,
  ) {
    const rows = await rowsUnder(t, level, parentId);
    return new Map(rows.map((r) => [r.value, r]));
  }

  test("Sync Inserts → group two under a third → Sync Inserts again: zero new rows, grouped rows untouched", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const vt = await insertVariantType(t);

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: vt,
      reconciledItems: insertPayload,
    });
    const first = await byValue(t, "insert", vt);
    expect(first.size).toBe(3);
    const chrome = first.get("Chrome")!;
    const refractor = first.get("Refractor")!;
    const gold = first.get("Gold Refractor")!;

    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [
        { insertId: refractor._id, targetInsertId: chrome._id },
        { insertId: gold._id, targetInsertId: chrome._id },
      ],
      demotions: [],
    });
    await stamp(t, [refractor._id, gold._id]);
    const grouped = await byValue(t, "parallel", chrome._id);

    // The operator's re-run of Sync Inserts: the marketplace still files all
    // three as inserts, so the SAME payload comes back.
    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "insert", parentId: vt, reconciledItems: insertPayload },
    );

    const insertsAfter = await rowsUnder(t, "insert", vt);
    expect(insertsAfter.map((r) => r._id)).toEqual([chrome._id]);
    const parallelsAfter = await rowsUnder(t, "parallel", chrome._id);
    expect(parallelsAfter.map((r) => r._id).sort()).toEqual(
      [refractor._id, gold._id].sort(),
    );
    for (const row of parallelsAfter) {
      const before = grouped.get(row.value)!;
      // Nothing written to them: same level, same parent, same slots, and
      // the sentinel stamp survives (a patch would replace it with now).
      expect(row.level).toBe("parallel");
      expect(row.parentId).toBe(chrome._id);
      expect(row.platformData).toEqual(before.platformData);
      expect(row.platformLabels).toEqual(before.platformLabels);
      expect(row.metadata).toEqual(before.metadata);
      expect(row.lastUpdated).toBe(SENTINEL);
    }

    expect(res.heldElsewhereTotal).toBe(2);
    expect(
      res.heldElsewhere
        .map((e) => ({ ...e, id: String(e.id), parentId: String(e.parentId) }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    ).toEqual([
      {
        id: String(gold._id),
        value: "Gold Refractor",
        level: "parallel",
        parentId: String(chrome._id),
        parentValue: "Chrome",
      },
      {
        id: String(refractor._id),
        value: "Refractor",
        level: "parallel",
        parentId: String(chrome._id),
        parentValue: "Chrome",
      },
    ]);
    // Held rows are not "stored" rows: the count is Chrome alone.
    expect(res.optionsCount).toBe(1);
    // …and the variant type's children cache did not re-acquire them.
    const vtRow = await t.run(async (ctx) => ctx.db.get(vt));
    expect(vtRow?.children).toEqual([chrome._id]);
  });

  test("a genuinely new insert in the same re-sync is still stored", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const vt = await insertVariantType(t);
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: vt,
      reconciledItems: insertPayload,
    });
    const first = await byValue(t, "insert", vt);
    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [
        {
          insertId: first.get("Refractor")!._id,
          targetInsertId: first.get("Chrome")!._id,
        },
      ],
      demotions: [],
    });

    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "insert",
        parentId: vt,
        reconciledItems: [
          ...insertPayload,
          { value: "Atomic", platformData: { bsc: "atomic-v" }, metadata: undefined },
        ],
      },
    );
    const after = await byValue(t, "insert", vt);
    expect([...after.keys()].sort()).toEqual(["Atomic", "Chrome", "Gold Refractor"]);
    expect(res.heldElsewhereTotal).toBe(1);
  });

  test("symmetric: demote a parallel to an insert → sync the old parent's parallels → no new parallel", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const vt = await insertVariantType(t);
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: vt,
      reconciledItems: [insertPayload[0]],
    });
    const chrome = (await byValue(t, "insert", vt)).get("Chrome")!;

    const parallelPayload = [
      { value: "Refractor", platformData: { bsc: "refractor-v" }, metadata: undefined },
      { value: "Gold /50", platformData: { bsc: "gold50-v" }, metadata: undefined },
    ];
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "parallel",
      parentId: chrome._id,
      reconciledItems: parallelPayload,
    });
    const refractor = (await byValue(t, "parallel", chrome._id)).get("Refractor")!;

    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [],
      demotions: [{ parallelId: refractor._id }],
    });
    await stamp(t, [refractor._id]);

    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "parallel", parentId: chrome._id, reconciledItems: parallelPayload },
    );

    const parallelsAfter = await rowsUnder(t, "parallel", chrome._id);
    expect(parallelsAfter.map((r) => r.value)).toEqual(["Gold /50"]);
    const refractorAfter = await t.run(async (ctx) => ctx.db.get(refractor._id));
    expect(refractorAfter?.level).toBe("insert");
    expect(refractorAfter?.parentId).toBe(vt);
    expect(refractorAfter?.lastUpdated).toBe(SENTINEL);
    expect(res.heldElsewhereTotal).toBe(1);
    expect(res.heldElsewhere[0]).toMatchObject({
      value: "Refractor",
      level: "insert",
      parentValue: "Inserts",
    });
  });

  test("a parallel sync does not re-create a row grouped under a DIFFERENT insert", async () => {
    // Refractor was synced as Chrome's parallel, then reparented under Prizm.
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const vt = await insertVariantType(t);
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: vt,
      reconciledItems: [
        insertPayload[0],
        { value: "Prizm", platformData: { bsc: "prizm-v" }, metadata: undefined },
      ],
    });
    const inserts = await byValue(t, "insert", vt);
    const chrome = inserts.get("Chrome")!;
    const prizm = inserts.get("Prizm")!;
    const payload = [
      { value: "Refractor", platformData: { bsc: "refractor-v" }, metadata: undefined },
    ];
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "parallel",
      parentId: chrome._id,
      reconciledItems: payload,
    });
    const refractor = (await byValue(t, "parallel", chrome._id)).get("Refractor")!;
    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [],
      demotions: [],
      reparentings: [{ parallelId: refractor._id, newInsertId: prizm._id }],
    });

    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "parallel", parentId: chrome._id, reconciledItems: payload },
    );
    expect(await rowsUnder(t, "parallel", chrome._id)).toHaveLength(0);
    expect((await rowsUnder(t, "parallel", prizm._id)).map((r) => r._id)).toEqual([
      refractor._id,
    ]);
    expect(res.heldElsewhere[0]).toMatchObject({ value: "Refractor", parentValue: "Prizm" });
  });

  test("single-platform path: storeSelectorOptions does not re-create a grouped row either", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const vt = await insertVariantType(t);
    const options = insertPayload.map(({ value, platformData }) => ({
      value,
      platformData,
    }));

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "insert",
      parentId: vt,
      options,
    });
    const first = await byValue(t, "insert", vt);
    const chrome = first.get("Chrome")!;
    const refractor = first.get("Refractor")!;
    const gold = first.get("Gold Refractor")!;
    await asAdmin.mutation(api.selectorOptions.applyParallelGroupings, {
      variantTypeId: vt,
      promotions: [
        { insertId: refractor._id, targetInsertId: chrome._id },
        { insertId: gold._id, targetInsertId: chrome._id },
      ],
      demotions: [],
    });
    await stamp(t, [refractor._id, gold._id]);

    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "insert",
      parentId: vt,
      options,
    });

    expect((await rowsUnder(t, "insert", vt)).map((r) => r._id)).toEqual([chrome._id]);
    const parallelsAfter = await rowsUnder(t, "parallel", chrome._id);
    expect(parallelsAfter).toHaveLength(2);
    for (const row of parallelsAfter) {
      expect(row.level).toBe("parallel");
      expect(row.parentId).toBe(chrome._id);
      expect(row.lastUpdated).toBe(SENTINEL);
    }
    expect(res.heldElsewhereTotal).toBe(2);
    expect(res.heldElsewhere.map((e) => e.parentValue)).toEqual(["Chrome", "Chrome"]);
  });

  test("a re-sync that stays inside the siblings reports nothing held and reads no subtree", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const vt = await insertVariantType(t);
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: vt,
      reconciledItems: insertPayload,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "insert", parentId: vt, reconciledItems: insertPayload },
    );
    expect(res.heldElsewhere).toEqual([]);
    expect(res.heldElsewhereTotal).toBe(0);
    expect(res.writeOps).toBe(0);
    // The structured line is written only when the subtree was walked.
    expect(
      log.mock.calls.some((c) => String(c[0]).includes("selector_sync_held_elsewhere")),
    ).toBe(false);
    log.mockRestore();
  });

  test("the walk: one indexed read per insert, siblings excluded, and skipped past the bound", async () => {
    const t = convexTest(schema, modules);
    const vt = await insertVariantType(t);
    const walk = async (level: "insert" | "parallel", parentId: Id<"selectorOptions">) =>
      t.run(async (ctx) => {
        const parent = await ctx.db.get(parentId);
        const siblings = await ctx.db
          .query("selectorOptions")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", level).eq("parentId", parentId),
          )
          .collect();
        const r = await loadVariantTypeSubtreeElsewhere(ctx, { level, parent, siblings });
        return r ? { reads: r.reads, values: r.rows.map((x) => x.value).sort() } : null;
      });
    const a = await t.run(async (ctx) => {
      const mk = (value: string) =>
        ctx.db.insert("selectorOptions", {
          level: "insert",
          value,
          platformData: {},
          parentId: vt,
          children: [],
          lastUpdated: SENTINEL,
        });
      const a = await mk("A");
      const b = await mk("B");
      for (const [value, parentId] of [["A1", a], ["A2", a], ["B1", b]] as const) {
        await ctx.db.insert("selectorOptions", {
          level: "parallel",
          value,
          platformData: {},
          parentId,
          children: [],
          lastUpdated: SENTINEL,
        });
      }
      return a;
    });

    // At `insert`: the siblings are A and B; elsewhere is every parallel.
    expect(await walk("insert", vt)).toEqual({ reads: 2, values: ["A1", "A2", "B1"] });
    // At `parallel` under A: the variant type get + the inserts read + B's
    // parallels; A's own parallels are the siblings.
    expect(await walk("parallel", a)).toEqual({ reads: 3, values: ["A", "B", "B1"] });

    // Past the bound the walk does not run at all.
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_SUBTREE_WALK_INSERTS; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "insert",
          value: `Bulk ${i}`,
          platformData: {},
          parentId: vt,
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    expect(await walk("insert", vt)).toBeNull();
  });

  test("outside a variant type's subtree (a setName sync) nothing is held and nothing changes", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const res = await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: [{ value: "Topps", platformData: { bsc: "topps-2024" } }],
    });
    expect(res.heldElsewhereTotal).toBe(0);
    expect(await rowsUnder(t, "setName", parentId)).toHaveLength(1);
  });
});
