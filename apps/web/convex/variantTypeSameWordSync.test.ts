/**
 * NEO-334 — one Base per set, and one variant type per WORD, from every door.
 *
 * A variant type's title is its kind (convex/variantRole.ts), and singular and
 * plural are the same word (Jason, 2026-10-10). The custom-add and rename doors
 * refuse a same-word sibling; the two sync stores must not mint one either. At
 * `variantType` level their name tier matches by word (`sameTitleWord`), so an
 * incoming "Inserts" LINKS to the existing "Insert" — the marketplace id lands
 * in that row's slot, additively, and the row keeps its NB title — and a
 * second "Base" can never be inserted beside the first.
 *
 * Where linking is unsafe (the namesake already holds a different id upstream
 * still lists, or two incoming items fold to one word) the item is WITHHELD:
 * nothing is inserted and nothing is renamed.
 *
 * The pure half pins `planSelectorSync`'s `sameName` rule; the convex-test
 * half drives both stores end to end.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  planSelectorSync,
  type IncomingItem,
  type MatchableRow,
} from "./selectorSyncMatch";
import { sameTitleWord } from "./variantRole";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo334_sameword",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo334_sameword",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;

beforeEach(() => {
  // Both stores log withheld matches; intentional in prod, noise here.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ===========================================================================
// planSelectorSync — the `sameName` rule
// ===========================================================================

type Row = MatchableRow<string>;

function row(id: string, value: string, over: Partial<Row> = {}): Row {
  return { _id: id, value, platformData: {}, ...over };
}

function item(value: string, ids: IncomingItem["ids"] = {}): IncomingItem {
  return { value, ids };
}

describe("planSelectorSync with sameName = sameTitleWord", () => {
  test("control: without the rule, 'Inserts' beside 'Insert' is an insert", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Insert")],
      items: [item("Inserts", { bsc: "insert" })],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "insert" });
  });

  test("'Inserts' matches the existing 'Insert' at tier 2 and attaches", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Insert")],
      items: [item("Inserts", { bsc: "insert" })],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "matched",
      existingId: "a",
      tier: 2,
    });
  });

  test("'Promo' matches 'Promos' the other way round too", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Promos")],
      items: [item("promo", { sportlots: "123" })],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes[0]).toMatchObject({ kind: "matched", existingId: "a" });
  });

  test("an exact name still matches exactly as before", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Base"), row("b", "Insert")],
      items: [item("Base", { bsc: "base" })],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes[0]).toMatchObject({ kind: "matched", existingId: "a" });
  });

  test("a different word is still an insert ('Insert Set' is not 'Insert')", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Insert")],
      items: [item("Insert Set", { bsc: "insert-set" })],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes[0]).toEqual({ kind: "insert" });
  });

  test("UNSAFE: the namesake holds a different id upstream still lists → withheld, not inserted", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Insert", { platformData: { bsc: { b0: "insert-a" } } })],
      items: [item("Inserts", { bsc: "insert-b" })],
      returnedIds: { bsc: ["insert-a", "insert-b"] },
      sameName: sameTitleWord,
    });
    expect(plan.outcomes[0].kind).toBe("withheld");
    expect(plan.siblingWithholds[0]).toEqual({
      reason: "nameLinkedToOtherSet",
      rowIds: ["a"],
    });
  });

  test("two incoming items of one word and no namesake → both withheld", () => {
    const plan = planSelectorSync({
      existing: [],
      items: [item("Promo", { bsc: "promo-1" }), item("Promos", { bsc: "promo-2" })],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes.map((o) => o.kind)).toEqual(["withheld", "withheld"]);
    expect(plan.siblingWithholds[0]?.reason).toBe("nameSharedInBatch");
  });

  test("id-less 'Base' + id-less 'Bases', no namesake → both withheld, never two rows", () => {
    const plan = planSelectorSync({
      existing: [],
      items: [item("Base"), item("Bases")],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes.map((o) => o.kind)).toEqual(["withheld", "withheld"]);
    expect(plan.siblingWithholds.map((w) => w?.reason)).toEqual([
      "nameSharedInBatch",
      "nameSharedInBatch",
    ]);
  });

  test("id-less 'Base' + id-carrying 'Bases', no namesake → both withheld", () => {
    const plan = planSelectorSync({
      existing: [],
      items: [item("Base"), item("Bases", { bsc: "x" })],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes.map((o) => o.kind)).toEqual(["withheld", "withheld"]);
    expect(plan.siblingWithholds[1]?.reason).toBe("nameSharedInBatch");
  });

  test("control: the exact rule is unchanged — id-less same-name items still insert", () => {
    const plan = planSelectorSync({
      existing: [],
      items: [item("Gold"), item("Gold", { bsc: "x" })],
    });
    expect(plan.outcomes.map((o) => o.kind)).toEqual(["insert", "insert"]);
  });

  test("control: one id-less item of a word is still inserted alone", () => {
    const plan = planSelectorSync({
      existing: [],
      items: [item("Base"), item("Insert")],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes.map((o) => o.kind)).toEqual(["insert", "insert"]);
  });

  test("two incoming items folding to one existing word → both withheld", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Insert")],
      items: [item("Insert", { bsc: "i-1" }), item("Inserts", { bsc: "i-2" })],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes.map((o) => o.kind)).toEqual(["withheld", "withheld"]);
    expect(plan.siblingWithholds[0]?.reason).toBe("nameClaimedTwice");
  });

  test("a word already claimed by id in this batch is withheld, not inserted", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Insert", { platformData: { bsc: { b0: "insert" } } })],
      items: [item("Insert", { bsc: "insert" }), item("Inserts", { sportlots: "77" })],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes[0]).toMatchObject({ kind: "matched", tier: 1 });
    expect(plan.outcomes[1].kind).toBe("withheld");
    expect(plan.siblingWithholds[1]?.reason).toBe("rowClaimedInBatch");
  });

  test("legacy siblings already holding both forms → withheld, never a coin flip", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Promo"), row("b", "Promos")],
      items: [item("Promo", { bsc: "promo" })],
      sameName: sameTitleWord,
    });
    expect(plan.outcomes[0].kind).toBe("withheld");
    expect(plan.siblingWithholds[0]?.reason).toBe("nameSharedBySiblings");
  });
});

// ===========================================================================
// The stores, end to end
// ===========================================================================

async function seedSet(
  t: ReturnType<typeof convexTest>,
  variantTypes: Array<{ value: string; bsc?: string }>,
): Promise<{ setId: Id<"selectorOptions">; ids: Id<"selectorOptions">[] }> {
  return t.run(async (ctx) => {
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Chrome",
      platformData: { bsc: { b0: "topps-chrome" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const ids: Id<"selectorOptions">[] = [];
    for (const vt of variantTypes) {
      ids.push(
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: vt.value,
          platformData: vt.bsc ? { bsc: { b0: vt.bsc } } : {},
          ...(vt.bsc ? { platformFacets: { bsc: { b0: "variant" as const } } } : {}),
          parentId: setId,
          children: [],
          lastUpdated: SENTINEL,
        }),
      );
    }
    await ctx.db.patch(setId, { children: ids });
    return { setId, ids };
  });
}

async function variantTypesOf(
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

function bscIds(r: { platformData: { bsc?: Record<string, string> } }): string[] {
  return Object.values(r.platformData.bsc ?? {});
}

describe("storeSelectorOptions at variantType — one row per word", () => {
  test("'Inserts' links to the existing 'Insert', which keeps its title", async () => {
    const t = convexTest(schema, modules);
    const { setId, ids } = await seedSet(t, [{ value: "Base" }, { value: "Insert" }]);

    await t.withIdentity(ADMIN).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "variantType",
      parentId: setId,
      options: [
        { value: "Base", platformData: { bsc: "base" } },
        { value: "Inserts", platformData: { bsc: "insert" } },
      ],
      coveredSides: ["bsc"],
    });

    const rows = await variantTypesOf(t, setId);
    expect(rows.map((r) => r.value).sort()).toEqual(["Base", "Insert"]);
    const insert = rows.find((r) => r._id === ids[1])!;
    expect(insert.value).toBe("Insert");
    expect(bscIds(insert)).toEqual(["insert"]);
    const base = rows.find((r) => r._id === ids[0])!;
    expect(bscIds(base)).toEqual(["base"]);
  });

  test("a second 'Base' is never inserted: it links to the one there is", async () => {
    const t = convexTest(schema, modules);
    const { setId, ids } = await seedSet(t, [{ value: "base" }]);

    await t.withIdentity(ADMIN).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "variantType",
      parentId: setId,
      options: [{ value: "Base", platformData: { bsc: "base" } }],
      coveredSides: ["bsc"],
    });

    const rows = await variantTypesOf(t, setId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(ids[0]);
    expect(rows[0].value).toBe("base");
    expect(bscIds(rows[0])).toEqual(["base"]);
  });

  test("UNSAFE: the namesake holds a live different id → withheld; no row, no rewrite", async () => {
    const t = convexTest(schema, modules);
    const { setId, ids } = await seedSet(t, [{ value: "Insert", bsc: "insert-a" }]);

    await t.withIdentity(ADMIN).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "variantType",
      parentId: setId,
      options: [{ value: "Inserts", platformData: { bsc: "insert-b" } }],
      returnedIds: { bsc: ["insert-a", "insert-b"] },
      coveredSides: ["bsc"],
    });

    const rows = await variantTypesOf(t, setId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(ids[0]);
    expect(bscIds(rows[0])).toEqual(["insert-a"]);
    expect(rows[0].lastUpdated).toBe(SENTINEL);
  });

  test("one call cannot mint two Bases: 'Base' + 'Bases' (one id-less) on an empty set inserts nothing", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t, []);

    await t.withIdentity(ADMIN).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "variantType",
      parentId: setId,
      options: [
        { value: "Base", platformData: {} },
        { value: "Bases", platformData: { bsc: "x" } },
        { value: "Insert", platformData: { bsc: "insert" } },
      ],
      coveredSides: ["bsc"],
    });

    const rows = await variantTypesOf(t, setId);
    expect(rows.map((r) => r.value)).toEqual(["Insert"]);
  });

  test("other levels keep the exact-name rule: 'Gold Refractors' beside 'Gold Refractor' inserts", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await seedSet(t, [{ value: "Insert" }]);
    const insertType = ids[0];
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Gold Refractor",
        platformData: {},
        parentId: insertType,
        children: [],
        lastUpdated: SENTINEL,
      });
      await ctx.db.patch(insertType, { children: [id] });
    });

    await t.withIdentity(ADMIN).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "insert",
      parentId: insertType,
      options: [{ value: "Gold Refractors", platformData: { bsc: "gold-refractors" } }],
      coveredSides: ["bsc"],
    });

    const inserts = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "insert").eq("parentId", insertType),
        )
        .collect(),
    );
    expect(inserts.map((r) => r.value).sort()).toEqual([
      "Gold Refractor",
      "Gold Refractors",
    ]);
  });
});

describe("storeReconciledOptions at variantType — one row per word", () => {
  test("'Parallels' links to the existing 'Parallel', which keeps its title", async () => {
    const t = convexTest(schema, modules);
    const { setId, ids } = await seedSet(t, [{ value: "Base" }, { value: "Parallel" }]);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.setReconciliation.storeReconciledOptions, {
        level: "variantType",
        parentId: setId,
        coveredSides: ["bsc"],
        reconciledItems: [
          { value: "Parallels", platformData: { bsc: "parallel" }, metadata: undefined },
        ],
      });

    const rows = await variantTypesOf(t, setId);
    expect(rows.map((r) => r.value).sort()).toEqual(["Base", "Parallel"]);
    expect(bscIds(rows.find((r) => r._id === ids[1])!)).toEqual(["parallel"]);
    expect(res.withheldSiblingsTotal).toBe(0);
  });

  test("identityOnly cannot mint a second 'Base' at variantType level", async () => {
    const t = convexTest(schema, modules);
    const { setId, ids } = await seedSet(t, [{ value: "Base" }]);

    await t.withIdentity(ADMIN).mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId: setId,
      coveredSides: ["bsc"],
      reconciledItems: [
        {
          value: "Base",
          platformData: { bsc: "base" },
          metadata: undefined,
          identityOnly: true,
        },
      ],
    });

    const rows = await variantTypesOf(t, setId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(ids[0]);
    expect(bscIds(rows[0])).toEqual(["base"]);
  });

  test("UNSAFE: reported to the operator as a withheld sibling, nothing inserted", async () => {
    const t = convexTest(schema, modules);
    const { setId, ids } = await seedSet(t, [{ value: "Promo", bsc: "promo-a" }]);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.setReconciliation.storeReconciledOptions, {
        level: "variantType",
        parentId: setId,
        coveredSides: ["bsc"],
        returnedIds: { bsc: ["promo-a", "promo-b"] },
        reconciledItems: [
          { value: "Promos", platformData: { bsc: "promo-b" }, metadata: undefined },
        ],
      });

    const rows = await variantTypesOf(t, setId);
    expect(rows).toHaveLength(1);
    expect(bscIds(rows[0])).toEqual(["promo-a"]);
    expect(res.withheldSiblingsTotal).toBe(1);
    expect(res.withheldSiblings[0]).toMatchObject({
      reason: "nameLinkedToOtherSet",
      rows: [{ id: ids[0], value: "Promo" }],
    });
  });
});
