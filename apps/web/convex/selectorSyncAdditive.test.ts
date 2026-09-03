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

  test("one row can be claimed by only one item — the second inserts", async () => {
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

    const after = await rowsUnder(t, "insert", parentId);
    expect(after).toHaveLength(2);
    const original = after.find((r) => r._id === id)!;
    expect(original.platformData.bsc).toEqual({ b0: "chrome-1" });
    const other = after.find((r) => r._id !== id)!;
    expect(other.value).toBe("Chrome Refractors");
    expect(other.platformData.bsc).toEqual({ b0: "chrome-2" });
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
});
