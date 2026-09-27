/**
 * NEO-305 — `convertSetToParallel` ("Make parallel of…") and
 * `promoteParallelToSet` ("Promote to set"), the two operator doors that move
 * a SportLots link between a set and a parallel.
 *
 * The fixture is 2026 Bowman as the ticket found it: BSC's Bowman with a Base,
 * an Insert type and a Parallel type (its roles read off `variant`-tagged BSC
 * slots, as the variant-type sync writes them), BSC's "Blue" and "Gold"
 * parallels under it, and SportLots-only sets minted by the real Sync Sets
 * write (`createSetsFromSlRoots` → `insertSetWithBaseFromSl`) — "Bowman Blue"
 * and friends, a set plus a Base holding the SportLots id.
 *
 * What is pinned: every refusal (and that a refusal writes nothing), the link
 * moving with its id and label to a new row and to an attached one, cards
 * following their own slot, the emptied rows going, the parallel staying
 * while a BSC link holds it, the name clash and its attach path, the
 * brand-wide SportLots holders the Parallels sync filters on, and the round
 * trip — demote, promote, demote — with the id covered by
 * `listBrandSubtreeSlIds` at every step.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  MAX_CARDS_PER_MOVE,
  conversionRefusal,
  noParallelTypeYet,
  parallelNameFromLabel,
  promotionRefusal,
  remapCardPlatformData,
} from "./setParallelConversion";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { MAX_VARIANT_TYPES_PER_SET } from "./setShapeMove";
import { teamRowFields } from "./lib/teamRow";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_neo305", role: "admin" };
const SIGNED_IN = { subject: "user_neo305" };
const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;
type RowId = Id<"selectorOptions">;
type Row = Doc<"selectorOptions">;

// ───────────────────────────────────────────────────────────────────────────
// Fixture
// ───────────────────────────────────────────────────────────────────────────

async function insertRow(
  t: T,
  fields: Partial<Row> & { level: Row["level"]; value: string },
): Promise<RowId> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
      ...fields,
    } as Omit<Row, "_id" | "_creationTime">);
    if (fields.parentId) {
      const parent = await ctx.db.get(fields.parentId);
      await ctx.db.patch(fields.parentId, {
        children: [...(parent?.children ?? []), id],
      });
    }
    return id;
  });
}

/**
 * A variant type as a BSC variant-type sync writes it: the `variant`-tagged
 * BSC slot, and the NB role conferred from it once (NEO-306: `isBase`, or
 * `metadata.variantRole`, is what `variantTypeRole` reads).
 */
function roleType(role: "base" | "insert" | "parallel") {
  return {
    platformData: { bsc: { b0: role } },
    platformFacets: { bsc: { b0: "variant" as const } },
    platformSlotSeq: { bsc: 1 },
    metadata: role === "base" ? { isBase: true } : { variantRole: role },
  };
}

async function seed(t: T) {
  const sportId = await insertRow(t, { level: "sport", value: "Baseball" });
  const yearId = await insertRow(t, { level: "year", value: "2026", parentId: sportId });
  const brandId = await insertRow(t, {
    level: "manufacturer",
    value: "Bowman",
    parentId: yearId,
    metadata: { setNamePrefix: "Bowman" },
  });
  const otherBrandId = await insertRow(t, {
    level: "manufacturer",
    value: "Topps",
    parentId: yearId,
    metadata: { setNamePrefix: "Topps" },
  });

  // BSC's flagship, its three variant types, and two BSC parallels.
  const bowmanId = await insertRow(t, {
    level: "setName",
    value: "Bowman",
    parentId: brandId,
    platformData: { bsc: { b0: "bowman" } },
    platformFacets: { bsc: { b0: "setName" } },
    platformSlotSeq: { bsc: 1 },
  });
  const bowmanBaseId = await insertRow(t, {
    level: "variantType",
    value: "Base",
    parentId: bowmanId,
    ...roleType("base"),
  });
  const parallelTypeId = await insertRow(t, {
    level: "variantType",
    value: "Parallel",
    parentId: bowmanId,
    features: { season: "2026" },
    ...roleType("parallel"),
  });
  const insertTypeId = await insertRow(t, {
    level: "variantType",
    value: "Insert",
    parentId: bowmanId,
    ...roleType("insert"),
  });
  const blueId = await insertRow(t, {
    level: "insert",
    value: "Blue",
    parentId: parallelTypeId,
    platformData: { bsc: { b0: "blue" } },
    platformSlotSeq: { bsc: 1 },
    metadata: { isParallel: true },
  });
  const goldId = await insertRow(t, {
    level: "insert",
    value: "Gold",
    parentId: parallelTypeId,
    platformData: { bsc: { b0: "gold" } },
    platformSlotSeq: { bsc: 1 },
    metadata: { isParallel: true },
  });

  // A second BSC set of the brand, with a Parallel type of its own.
  const chromeId = await insertRow(t, {
    level: "setName",
    value: "Bowman Chrome",
    parentId: brandId,
    platformData: { bsc: { b0: "bowman-chrome" } },
    platformFacets: { bsc: { b0: "setName" } },
    platformSlotSeq: { bsc: 1 },
  });
  const chromeParallelTypeId = await insertRow(t, {
    level: "variantType",
    value: "Parallel",
    parentId: chromeId,
    ...roleType("parallel"),
  });

  // Another brand's set with a Parallel type — never a legal target.
  const toppsId = await insertRow(t, {
    level: "setName",
    value: "Topps",
    parentId: otherBrandId,
    platformData: { bsc: { b0: "topps" } },
    platformSlotSeq: { bsc: 1 },
  });
  const toppsParallelTypeId = await insertRow(t, {
    level: "variantType",
    value: "Parallel",
    parentId: toppsId,
    ...roleType("parallel"),
  });

  return {
    yearId,
    brandId,
    otherBrandId,
    bowmanId,
    bowmanBaseId,
    parallelTypeId,
    insertTypeId,
    blueId,
    goldId,
    chromeId,
    chromeParallelTypeId,
    toppsId,
    toppsParallelTypeId,
  };
}

/** SportLots-only sets, minted by the real Sync Sets write. */
async function slSets(
  t: T,
  brandId: RowId,
  roots: Array<{ id: string; label: string }>,
) {
  await t.mutation(internal.selectorOptions.createSetsFromSlRoots, {
    manufacturerId: brandId,
    roots,
  });
  const out: Record<string, { setId: RowId; baseId: RowId }> = {};
  await t.run(async (ctx) => {
    const sets = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", brandId),
      )
      .collect();
    for (const set of sets) {
      const base = set.children?.[0];
      if (base && set.platformData.bsc === undefined) {
        out[set.value] = { setId: set._id, baseId: base };
      }
    }
  });
  return out;
}

type CardSpec = {
  n: string;
  name?: string;
  sl?: { ref: string; src?: string };
  bsc?: { ref: string; src?: string };
  sortOrder?: number;
};

async function addCards(t: T, rowId: RowId, cards: CardSpec[]): Promise<Id<"cardChecklist">[]> {
  return t.run(async (ctx) => {
    const ids: Id<"cardChecklist">[] = [];
    for (const [i, c] of cards.entries()) {
      ids.push(
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: rowId,
          cardNumber: c.n,
          cardName: c.name ?? `Player ${c.n}`,
          platformData: {
            ...(c.sl ? { sportlots: c.sl } : {}),
            ...(c.bsc ? { bsc: c.bsc } : {}),
          },
          sortOrder: c.sortOrder ?? i,
          lastUpdated: SENTINEL,
        }),
      );
    }
    return ids;
  });
}

async function get(t: T, id: RowId) {
  return t.run(async (ctx) => ctx.db.get(id));
}

async function cardsOn(t: T, rowId: RowId) {
  return t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", rowId))
      .collect(),
  );
}

async function covered(t: T, brandId: RowId): Promise<string[]> {
  const { ids, truncated } = await t.query(
    internal.selectorOptions.listBrandSubtreeSlIds,
    { manufacturerId: brandId },
  );
  expect(truncated).toBe(false);
  return ids;
}

async function insertsUnder(t: T, typeId: RowId) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "insert").eq("parentId", typeId),
      )
      .collect(),
  );
}

/** Everything under the brand, for "a refusal wrote nothing" snapshots. */
async function snapshot(t: T) {
  return t.run(async (ctx) => ({
    rows: (await ctx.db.query("selectorOptions").collect()).map((r) => ({
      ...r,
      _creationTime: 0,
    })),
    cards: await ctx.db.query("cardChecklist").collect(),
  }));
}

async function expectRefusal(
  t: T,
  call: () => Promise<unknown>,
  message: string,
) {
  const before = await snapshot(t);
  await expect(call()).rejects.toThrow(message);
  expect(await snapshot(t)).toEqual(before);
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

describe("parallelNameFromLabel", () => {
  test.each([
    ["Bowman Blue", "Bowman", "Bowman", "Blue"],
    ["bowman blue", "Bowman", "Bowman", "blue"],
    ["Bowman Chrome Blue Refractor", "Bowman Chrome", "Bowman", "Blue Refractor"],
    // SportLots' brand-stripped list: the target's name without its brand.
    ["Chrome Blue Refractor", "Bowman Chrome", "Bowman", "Blue Refractor"],
    // No match keeps the whole label.
    ["Sapphire Orange", "Bowman Chrome", "Bowman", "Sapphire Orange"],
    // Whole word only: "Bowmanesque" does not start with "Bowman ".
    ["Bowmanesque Gold", "Bowman", "Bowman", "Bowmanesque Gold"],
    // A dash-joined label loses the dash with the prefix.
    ["Bowman - Neon Green", "Bowman", "Bowman", "Neon Green"],
  ])("%s under %s → %s", (label, target, prefix, expected) => {
    expect(parallelNameFromLabel(label, target, prefix)).toBe(expected);
  });

  test("the target's own name is not a parallel of it", () => {
    expect(parallelNameFromLabel("Bowman", "Bowman", "Bowman")).toBeNull();
    expect(parallelNameFromLabel("  bowman ", "Bowman", "Bowman")).toBeNull();
  });
});

describe("remapCardPlatformData", () => {
  test("a mapped src follows; an unmapped or dangling src is cleared; refs are kept", () => {
    expect(
      remapCardPlatformData(
        {
          sportlots: { ref: "#1 A", src: "s0" },
          bsc: { ref: "123", src: "b4" },
        },
        { sportlots: new Map([["s0", "s3"]]) },
      ),
    ).toEqual({ sportlots: { ref: "#1 A", src: "s3" }, bsc: { ref: "123" } });
    expect(remapCardPlatformData({ sportlots: { ref: "#2 B" } }, {})).toEqual({
      sportlots: { ref: "#2 B" },
    });
    expect(remapCardPlatformData({}, {})).toEqual({});
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Part B — convertSetToParallel
// ───────────────────────────────────────────────────────────────────────────

describe("convertSetToParallel — guards", () => {
  test("refuses a caller who is not an admin", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-FUCHSIA", label: "Bowman Fuchsia" }]);
    const args = {
      setId: sl["Bowman Fuchsia"].setId,
      targetParallelTypeId: ids.parallelTypeId,
    };
    await expect(
      t.withIdentity(SIGNED_IN).mutation(api.setParallelConversion.convertSetToParallel, args),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.setParallelConversion.convertSetToParallel, args),
    ).rejects.toThrow();
  });

  test("the set has BSC ids (on the set row, or on its Base)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const as = t.withIdentity(ADMIN);
    // BSC's own Bowman Chrome carries a BSC id on the set row.
    await expectRefusal(
      t,
      () =>
        as.mutation(api.setParallelConversion.convertSetToParallel, {
          setId: ids.chromeId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.onBsc("Bowman Chrome"),
    );
    // A SportLots set whose Base has picked up a BSC id.
    const sl = await slSets(t, ids.brandId, [{ id: "SL-GREEN", label: "Bowman Green" }]);
    await t.run(async (ctx) => {
      const base = (await ctx.db.get(sl["Bowman Green"].baseId))!;
      await ctx.db.patch(base._id, {
        platformData: { ...base.platformData, bsc: { b0: "green" } },
      });
    });
    await expectRefusal(
      t,
      () =>
        as.mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Green"].setId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.onBsc("Bowman Green"),
    );
  });

  test("its only child must be a Base", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const as = t.withIdentity(ADMIN);
    const sl = await slSets(t, ids.brandId, [
      { id: "SL-A", label: "Bowman Aqua" },
      { id: "SL-B", label: "Bowman Black" },
    ]);
    // A second variant type beside the Base.
    await insertRow(t, {
      level: "variantType",
      value: "Insert",
      parentId: sl["Bowman Aqua"].setId,
    });
    await expectRefusal(
      t,
      () =>
        as.mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Aqua"].setId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.moreThanBase("Bowman Aqua"),
    );
    // The one child is not flagged as the base (a name is not a role).
    await t.run(async (ctx) => {
      await ctx.db.patch(sl["Bowman Black"].baseId, { metadata: {} });
    });
    await expectRefusal(
      t,
      () =>
        as.mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Black"].setId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.moreThanBase("Bowman Black"),
    );
    // No children at all.
    const empty = await insertRow(t, {
      level: "setName",
      value: "Bowman Empty",
      parentId: ids.brandId,
    });
    await expectRefusal(
      t,
      () =>
        as.mutation(api.setParallelConversion.convertSetToParallel, {
          setId: empty,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.noBase("Bowman Empty"),
    );
  });

  test("the Base has no inserts", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-ORANGE", label: "Bowman Orange" }]);
    await insertRow(t, {
      level: "insert",
      value: "Something",
      parentId: sl["Bowman Orange"].baseId,
    });
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Orange"].setId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.baseHasRows("Bowman Orange"),
    );
  });

  test("the target is in the same brand (and so the same year)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-RED", label: "Bowman Red" }]);
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Red"].setId,
          targetParallelTypeId: ids.toppsParallelTypeId,
        }),
      conversionRefusal.otherBrand("Topps", "Bowman"),
    );
  });

  test("the target variant type is a Parallel type (its NB role, never its name)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-RED", label: "Bowman Red" }]);
    const as = t.withIdentity(ADMIN);
    await expectRefusal(
      t,
      () =>
        as.mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Red"].setId,
          targetParallelTypeId: ids.insertTypeId,
        }),
      conversionRefusal.notParallelType("Insert", "Bowman"),
    );
    // Called "Parallel" with no role behind it: still not a Parallel type.
    const named = await insertRow(t, {
      level: "variantType",
      value: "Parallel",
      parentId: ids.chromeId,
    });
    await expectRefusal(
      t,
      () =>
        as.mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Red"].setId,
          targetParallelTypeId: named,
        }),
      conversionRefusal.notParallelType("Parallel", "Bowman Chrome"),
    );
  });

  test("the target is not under the set itself", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-RED", label: "Bowman Red" }]);
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Red"].setId,
          targetParallelTypeId: sl["Bowman Red"].baseId,
        }),
      conversionRefusal.self("Bowman Red"),
    );
  });

  test("only a set converts", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: ids.blueId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.notASet(),
    );
  });

  test("an open checklist review holds the set", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-RED", label: "Bowman Red" }]);
    await t.run(async (ctx) => {
      await ctx.db.insert("checklistCandidates", {
        selectorOptionId: sl["Bowman Red"].baseId,
        batchId: "batch-neo305",
        createdByUserId: "another_admin",
        cardNumber: "1",
        cardName: "Card 1",
        platformData: {},
        bucket: "matched",
        stem: "1",
        status: "ready",
        lastUpdated: SENTINEL,
      });
    });
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Red"].setId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.reviewOpen("Bowman Red"),
    );
  });

  test("a new parallel may not take a name the target already has — attaching to it is the way", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Blue"].setId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.nameTaken("Bowman", "Blue"),
    );
  });

  test("the destination may not already hold the link — in either mode (coordinator, NEO-305)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    // The Parallels sync already put the SportLots id on BSC's Blue.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.blueId, {
        platformData: { bsc: { b0: "blue" }, sportlots: { s0: "SL-BLUE" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    const as = t.withIdentity(ADMIN);
    const refusal = conversionRefusal.linkTaken("Bowman", "Blue", "Bowman Blue");
    await expectRefusal(
      t,
      () =>
        as.mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Blue"].setId,
          targetParallelTypeId: ids.parallelTypeId,
          attachToId: ids.blueId,
        }),
      refusal,
    );
    // New mode, renamed so the name does not clash first: still the link.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.blueId, { value: "Blue Border" });
    });
    await expectRefusal(
      t,
      () =>
        as.mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Blue"].setId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.linkTaken("Bowman", "Blue Border", "Bowman Blue"),
    );
  });

  test("an attach row that is not under the target Parallel type is refused", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-RED", label: "Bowman Red" }]);
    const chromeGold = await insertRow(t, {
      level: "insert",
      value: "Gold",
      parentId: ids.chromeParallelTypeId,
    });
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Red"].setId,
          targetParallelTypeId: ids.parallelTypeId,
          attachToId: chromeGold,
        }),
      conversionRefusal.attachGone(),
    );
  });

  test("a label that IS the target's name cannot become a new parallel of it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // An NB set "Bowman Flagship Copy" whose Base holds SportLots' "Bowman".
    const setId = await insertRow(t, {
      level: "setName",
      value: "Bowman Flagship Copy",
      parentId: ids.brandId,
    });
    await insertRow(t, {
      level: "variantType",
      value: "Base",
      parentId: setId,
      metadata: { isBase: true },
      platformData: { sportlots: { s0: "SL-BOWMAN" } },
      platformLabels: { sportlots: { s0: "Bowman" } },
      platformSlotSeq: { sportlots: 1 },
    });
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.ownName("Bowman", "Bowman"),
    );
  });

  test("more cards than one move can carry is refused before anything is written", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-RED", label: "Bowman Red" }]);
    await addCards(
      t,
      sl["Bowman Red"].baseId,
      Array.from({ length: MAX_CARDS_PER_MOVE + 1 }, (_, i) => ({
        n: String(i + 1),
        sl: { ref: `#${i + 1}`, src: "s0" },
      })),
    );
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Red"].setId,
          targetParallelTypeId: ids.parallelTypeId,
        }),
      conversionRefusal.tooManyCards("Bowman Red", MAX_CARDS_PER_MOVE),
    );
  });
});

describe("convertSetToParallel — the move", () => {
  test("to a NEW parallel: the link moves with id and label, flags derived, the set and Base are gone", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-FUCHSIA", label: "Bowman Fuchsia" }]);
    const { setId, baseId } = sl["Bowman Fuchsia"];
    expect(await covered(t, ids.brandId)).toContain("SL-FUCHSIA");

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.convertSetToParallel, {
        setId,
        targetParallelTypeId: ids.parallelTypeId,
      });
    expect(result).toMatchObject({
      targetSetId: ids.bowmanId,
      parallelTypeId: ids.parallelTypeId,
      parallelValue: "Fuchsia",
      targetSetValue: "Bowman",
      created: true,
    });

    const row = (await get(t, result.parallelId))!;
    expect(row.level).toBe("insert");
    expect(row.parentId).toBe(ids.parallelTypeId);
    expect(row.platformData).toEqual({ sportlots: { s0: "SL-FUCHSIA" } });
    expect(row.platformLabels).toEqual({ sportlots: { s0: "Bowman Fuchsia" } });
    expect(row.platformSlotSeq).toEqual({ sportlots: 1 });
    expect(row.metadata).toEqual({ isParallel: true });
    expect(row.createdByUserId).toBe(ADMIN.subject);
    // Features copied down from the Parallel type at creation.
    expect(row.features?.season).toBe("2026");
    expect((await get(t, ids.parallelTypeId))!.children).toContain(row._id);

    expect(await get(t, setId)).toBeNull();
    expect(await get(t, baseId)).toBeNull();
    expect((await get(t, ids.brandId))!.children).not.toContain(setId);
    // Still covered: Sync Sets will not re-create the set.
    expect(await covered(t, ids.brandId)).toContain("SL-FUCHSIA");
  });

  test("to an ATTACHED parallel: the link joins BSC's row beside its BSC link", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.convertSetToParallel, {
        setId: sl["Bowman Blue"].setId,
        targetParallelTypeId: ids.parallelTypeId,
        attachToId: ids.blueId,
      });
    expect(result).toMatchObject({ parallelId: ids.blueId, parallelValue: "Blue", created: false });
    const blue = (await get(t, ids.blueId))!;
    expect(blue.platformData).toEqual({
      bsc: { b0: "blue" },
      sportlots: { s0: "SL-BLUE" },
    });
    expect(blue.platformLabels?.sportlots).toEqual({ s0: "Bowman Blue" });
    expect(blue.value).toBe("Blue");
    expect(await insertsUnder(t, ids.parallelTypeId)).toHaveLength(2);
    expect(await get(t, sl["Bowman Blue"].setId)).toBeNull();
    expect(await covered(t, ids.brandId)).toContain("SL-BLUE");
  });

  test("every SportLots link moves, the primary first, each card following its own slot", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-GREEN", label: "Bowman Green" }]);
    const { setId, baseId } = sl["Bowman Green"];
    // A second SportLots set on the Base, made primary.
    await t.run(async (ctx) => {
      await ctx.db.patch(baseId, {
        platformData: { sportlots: { s0: "SL-GREEN", s1: "SL-GREEN-2" } },
        platformLabels: { sportlots: { s0: "Bowman Green", s1: "Bowman Green II" } },
        platformSlotSeq: { sportlots: 2 },
        primaryPlatformId: { sportlots: "s1" },
      });
    });
    const [a, b, c, d, e] = await addCards(t, baseId, [
      { n: "10", sl: { ref: "#10 Ten", src: "s0" } },
      { n: "2", sl: { ref: "#2 Two", src: "s1" } },
      // Card numbers are not unique: both 2s move.
      { n: "2", sl: { ref: "#2 Two (var)", src: "s0" } },
      // A dangling BSC src is cleared; its ref is kept.
      { n: "1", bsc: { ref: "bsc-1", src: "b7" }, sl: { ref: "#1 One", src: "s0" } },
      // An unattributed SportLots ref stays unattributed.
      { n: "3", sl: { ref: "#3 Three" } },
    ]);

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.convertSetToParallel, {
        setId,
        targetParallelTypeId: ids.parallelTypeId,
      });
    const row = (await get(t, result.parallelId))!;
    // Named from the PRIMARY label; the primary is the new row's lowest slot.
    expect(row.value).toBe("Green II");
    expect(row.platformData).toEqual({ sportlots: { s0: "SL-GREEN-2", s1: "SL-GREEN" } });
    expect(row.platformLabels).toEqual({
      sportlots: { s0: "Bowman Green II", s1: "Bowman Green" },
    });

    const moved = await cardsOn(t, row._id);
    expect(moved.map((x) => x._id).sort()).toEqual([a, b, c, d, e].sort());
    const byId = new Map(moved.map((x) => [x._id, x]));
    expect(byId.get(a)!.platformData).toEqual({ sportlots: { ref: "#10 Ten", src: "s1" } });
    expect(byId.get(b)!.platformData).toEqual({ sportlots: { ref: "#2 Two", src: "s0" } });
    expect(byId.get(c)!.platformData).toEqual({ sportlots: { ref: "#2 Two (var)", src: "s1" } });
    expect(byId.get(d)!.platformData).toEqual({
      bsc: { ref: "bsc-1" },
      sportlots: { ref: "#1 One", src: "s1" },
    });
    expect(byId.get(e)!.platformData).toEqual({ sportlots: { ref: "#3 Three" } });
    // Card-number order, restamped in the moving patch: 1, 2, 2, 3, 10.
    const order = [...moved].sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.cardNumber);
    expect(order).toEqual(["1", "2", "2", "3", "10"]);
    expect(await cardsOn(t, baseId)).toHaveLength(0);
  });

  test("into a parallel that already has cards: appended, then re-numbered in the background", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    await addCards(t, ids.blueId, [
      { n: "1", bsc: { ref: "b-1", src: "b0" }, sortOrder: 0 },
      { n: "3", bsc: { ref: "b-3", src: "b0" }, sortOrder: 1 },
    ]);
    await addCards(t, sl["Bowman Blue"].baseId, [
      { n: "2", sl: { ref: "#2", src: "s0" } },
    ]);
    await t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
      setId: sl["Bowman Blue"].setId,
      targetParallelTypeId: ids.parallelTypeId,
      attachToId: ids.blueId,
    });
    await drainScheduled(t);
    const cards = await cardsOn(t, ids.blueId);
    expect(
      [...cards].sort((x, y) => x.sortOrder - y.sortOrder).map((c) => c.cardNumber),
    ).toEqual(["1", "2", "3"]);
    // BSC's own cards keep their BSC attribution untouched.
    expect(cards.find((c) => c.cardNumber === "1")!.platformData).toEqual({
      bsc: { ref: "b-1", src: "b0" },
    });
  });

  test("guest cross-listings follow the row; a redundant one is dropped", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    const [goldCard] = await addCards(t, ids.goldId, [{ n: "7", bsc: { ref: "g7", src: "b0" } }]);
    const [blueCard] = await addCards(t, ids.blueId, [{ n: "8", bsc: { ref: "b8", src: "b0" } }]);
    await t.run(async (ctx) => {
      for (const card of [goldCard, blueCard]) {
        await ctx.db.insert("cardCrossListings", {
          cardChecklistId: card,
          selectorOptionId: sl["Bowman Blue"].baseId,
          lastUpdated: SENTINEL,
        });
      }
    });
    await t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
      setId: sl["Bowman Blue"].setId,
      targetParallelTypeId: ids.parallelTypeId,
      attachToId: ids.blueId,
    });
    await drainScheduled(t);
    const links = await t.run(async (ctx) => ctx.db.query("cardCrossListings").collect());
    // Gold's card is now listed in Blue; Blue's own card needs no guest link.
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ cardChecklistId: goldCard, selectorOptionId: ids.blueId });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Part C — promoteParallelToSet
// ───────────────────────────────────────────────────────────────────────────

describe("promoteParallelToSet — guards", () => {
  test("refuses a caller who is not an admin", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const args = { parallelId: ids.blueId, slSlotKey: "s0" };
    await expect(
      t.withIdentity(SIGNED_IN).mutation(api.setParallelConversion.promoteParallelToSet, args),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.setParallelConversion.promoteParallelToSet, args),
    ).rejects.toThrow();
  });

  test("only a row under a set's variant types: not a set, not a variant type, not under the Base", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // NEO-306: an insert under the Insert type IS promotable now; a row under
    // the Base is not (the Base is terminal), nor is a set or a variant type.
    const underBase = await insertRow(t, {
      level: "insert",
      value: "Stray",
      parentId: ids.bowmanBaseId,
      platformData: { sportlots: { s0: "SL-STRAY" } },
    });
    const as = t.withIdentity(ADMIN);
    const promote = (parallelId: RowId) =>
      as.mutation(api.setParallelConversion.promoteParallelToSet, { parallelId, slSlotKey: "s0" });
    await expectRefusal(t, () => promote(underBase), promotionRefusal.notAParallel());
    await expectRefusal(t, () => promote(ids.bowmanId), promotionRefusal.notAParallel());
    await expectRefusal(t, () => promote(ids.parallelTypeId), promotionRefusal.notAParallel());
    expect(promotionRefusal.notAParallel()).toBe("Only an insert or a parallel can be promoted to a set.");
  });

  test("the row must carry that SportLots link", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.promoteParallelToSet, {
          parallelId: ids.blueId,
          slSlotKey: "s0",
        }),
      promotionRefusal.linkGone("Blue"),
    );
  });

  test("a name the brand already has is refused, naming the set", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // SportLots calls it "Chrome": the brand's prefix makes it "Bowman Chrome".
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.goldId, {
        platformData: { bsc: { b0: "gold" }, sportlots: { s0: "SL-CHROME" } },
        platformLabels: { sportlots: { s0: "Chrome" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.promoteParallelToSet, {
          parallelId: ids.goldId,
          slSlotKey: "s0",
        }),
      promotionRefusal.nameTaken("Bowman", "Bowman Chrome"),
    );
  });

  test("a card matched to BSC as well as to the promoted link cannot be split off", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.blueId, {
        platformData: { bsc: { b0: "blue" }, sportlots: { s0: "SL-BLUE" } },
        platformLabels: { sportlots: { s0: "Bowman Blue" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    await addCards(t, ids.blueId, [
      { n: "1", sl: { ref: "#1", src: "s0" }, bsc: { ref: "b1", src: "b0" } },
      { n: "2", sl: { ref: "#2", src: "s0" } },
    ]);
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.promoteParallelToSet, {
          parallelId: ids.blueId,
          slSlotKey: "s0",
        }),
      promotionRefusal.paired("Blue", 1),
    );
  });

  test("attach: only a set of the same brand, with a Base, not already holding the link", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.goldId, {
        platformData: { bsc: { b0: "gold" }, sportlots: { s0: "SL-GOLD" } },
        platformLabels: { sportlots: { s0: "Bowman Gold" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    const as = t.withIdentity(ADMIN);
    const promote = (attachToSetId: RowId) =>
      as.mutation(api.setParallelConversion.promoteParallelToSet, {
        parallelId: ids.goldId,
        slSlotKey: "s0",
        attachToSetId,
      });
    await expectRefusal(t, () => promote(ids.toppsId), promotionRefusal.attachOtherBrand("Topps", "Bowman"));
    await expectRefusal(t, () => promote(ids.chromeId), promotionRefusal.attachNoBase("Bowman Chrome"));
    await expectRefusal(t, () => promote(ids.blueId), promotionRefusal.attachGone());
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.bowmanBaseId, {
        platformData: { bsc: { b0: "base" }, sportlots: { s0: "SL-GOLD" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    await expectRefusal(t, () => promote(ids.bowmanId), promotionRefusal.linkTaken("Bowman", "Gold"));
  });
});

describe("promoteParallelToSet — the move", () => {
  test("a parallel holding only a SportLots link becomes a set again, and the empty row goes", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const pristine = await insertRow(t, {
      level: "insert",
      value: "Pristine",
      parentId: ids.parallelTypeId,
      platformData: { sportlots: { s0: "SL-PRISTINE" } },
      platformLabels: { sportlots: { s0: "Pristine" } },
      platformSlotSeq: { sportlots: 1 },
      metadata: { isParallel: true },
    });
    const [c1, c2] = await addCards(t, pristine, [
      { n: "5", sl: { ref: "#5", src: "s0" } },
      { n: "5", sl: { ref: "#5 var", src: "s0" }, bsc: { ref: "stale", src: "b3" } },
    ]);

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.promoteParallelToSet, {
        parallelId: pristine,
        slSlotKey: "s0",
      });
    // `candidateDefaultName`: the brand's prefix goes back on.
    expect(result).toMatchObject({ setValue: "Bowman Pristine", created: true, parallelKept: false });
    const set = (await get(t, result.setId))!;
    const base = (await get(t, result.baseId))!;
    expect(set).toMatchObject({ level: "setName", parentId: ids.brandId, platformData: {} });
    expect(set.children).toEqual([base._id]);
    expect(base).toMatchObject({
      level: "variantType",
      value: "Base",
      metadata: { isBase: true },
      platformData: { sportlots: { s0: "SL-PRISTINE" } },
      platformLabels: { sportlots: { s0: "Pristine" } },
      createdByUserId: ADMIN.subject,
    });
    const cards = await cardsOn(t, base._id);
    expect(cards.map((c) => c._id).sort()).toEqual([c1, c2].sort());
    expect(cards.find((c) => c._id === c2)!.platformData).toEqual({
      sportlots: { ref: "#5 var", src: "s0" },
      bsc: { ref: "stale" },
    });
    expect(await get(t, pristine)).toBeNull();
    expect((await get(t, ids.parallelTypeId))!.children).not.toContain(pristine);
    expect(await covered(t, ids.brandId)).toContain("SL-PRISTINE");
  });

  test("a parallel still holding a BSC link stays as BSC's parallel, with its BSC cards", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.goldId, {
        platformData: { bsc: { b0: "gold" }, sportlots: { s0: "SL-GOLD" } },
        platformLabels: { sportlots: { s0: "Bowman Gold" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
        primaryPlatformId: { bsc: "b0", sportlots: "s0" },
      });
    });
    const [bscCard, slCard] = await addCards(t, ids.goldId, [
      { n: "1", bsc: { ref: "g1", src: "b0" } },
      { n: "1", sl: { ref: "#1", src: "s0" } },
    ]);
    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.promoteParallelToSet, {
        parallelId: ids.goldId,
        slSlotKey: "s0",
      });
    expect(result).toMatchObject({ setValue: "Bowman Gold", created: true, parallelKept: true });
    const gold = (await get(t, ids.goldId))!;
    expect(gold.platformData).toEqual({ bsc: { b0: "gold" } });
    expect(gold.platformLabels?.sportlots).toBeUndefined();
    expect(gold.primaryPlatformId).toEqual({ bsc: "b0" });
    expect((await cardsOn(t, ids.goldId)).map((c) => c._id)).toEqual([bscCard]);
    expect((await cardsOn(t, result.baseId)).map((c) => c._id)).toEqual([slCard]);
  });

  test("a parallel keeping other cards stays, even with no link left", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await insertRow(t, {
      level: "insert",
      value: "Aqua",
      parentId: ids.parallelTypeId,
      platformData: { sportlots: { s0: "SL-AQUA" } },
      platformLabels: { sportlots: { s0: "Bowman Aqua" } },
      platformSlotSeq: { sportlots: 1 },
    });
    await addCards(t, row, [
      { n: "1", sl: { ref: "#1", src: "s0" } },
      // Hand-added: no marketplace ref, so not the link's to take.
      { n: "99" },
    ]);
    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.promoteParallelToSet, {
        parallelId: row,
        slSlotKey: "s0",
      });
    expect(result.parallelKept).toBe(true);
    expect((await cardsOn(t, row)).map((c) => c.cardNumber)).toEqual(["99"]);
    expect((await get(t, row))!.platformData).toEqual({});
  });

  test("NEO-306: an INSERT holding a SportLots link becomes a set, its cards following the link", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const stars = await insertRow(t, {
      level: "insert",
      value: "Stars",
      parentId: ids.insertTypeId,
      platformData: { sportlots: { s0: "SL-STARS" } },
      platformLabels: { sportlots: { s0: "Stars" } },
      platformSlotSeq: { sportlots: 1 },
      metadata: { isInsert: true },
    });
    const [c1] = await addCards(t, stars, [{ n: "S-1", sl: { ref: "#S-1", src: "s0" } }]);
    const eligibility = await t
      .withIdentity(ADMIN)
      .query(api.setParallelConversion.getParallelPromotionEligibility, { parallelId: stars });
    expect(eligibility).toEqual({ eligible: true, links: [{ slot: "s0", label: "Stars" }] });

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.promoteParallelToSet, { parallelId: stars, slSlotKey: "s0" });
    expect(result).toMatchObject({ setValue: "Bowman Stars", created: true, parallelKept: false });
    const base = (await get(t, result.baseId))!;
    expect(base.platformData).toEqual({ sportlots: { s0: "SL-STARS" } });
    expect(base.platformLabels).toEqual({ sportlots: { s0: "Stars" } });
    expect((await cardsOn(t, base._id)).map((c) => c._id)).toEqual([c1]);
    expect(await get(t, stars)).toBeNull();
    expect((await get(t, ids.insertTypeId))!.children).not.toContain(stars);
    expect(await covered(t, ids.brandId)).toContain("SL-STARS");
  });

  test("NEO-306: a PARALLEL of an insert becomes a set; the insert keeps its BSC link and its other parallels", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const autos = await insertRow(t, {
      level: "insert",
      value: "Autos",
      parentId: ids.insertTypeId,
      platformData: { bsc: { b0: "autos" } },
      platformSlotSeq: { bsc: 1 },
      metadata: { isInsert: true },
    });
    const redInk = await insertRow(t, {
      level: "parallel",
      value: "Red Ink",
      parentId: autos,
      platformData: { sportlots: { s0: "SL-RED-INK" } },
      platformLabels: { sportlots: { s0: "Autos Red Ink" } },
      platformSlotSeq: { sportlots: 1 },
      metadata: { isParallel: true },
    });
    const gold = await insertRow(t, {
      level: "parallel",
      value: "Gold",
      parentId: autos,
      platformData: { bsc: { b0: "autos-gold" } },
      platformSlotSeq: { bsc: 1 },
      metadata: { isParallel: true },
    });
    const [c1, c2] = await addCards(t, redInk, [
      { n: "A-1", sl: { ref: "#A-1", src: "s0" } },
      { n: "A-1", sl: { ref: "#A-1 var", src: "s0" } },
    ]);

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.promoteParallelToSet, { parallelId: redInk, slSlotKey: "s0" });
    expect(result).toMatchObject({ setValue: "Bowman Autos Red Ink", created: true, parallelKept: false });
    const base = (await get(t, result.baseId))!;
    expect(base.platformData).toEqual({ sportlots: { s0: "SL-RED-INK" } });
    expect((await cardsOn(t, base._id)).map((c) => c._id).sort()).toEqual([c1, c2].sort());
    expect(await get(t, redInk)).toBeNull();
    const insert = (await get(t, autos))!;
    expect(insert.children).toEqual([gold]);
    expect(insert.platformData).toEqual({ bsc: { b0: "autos" } });
    expect(await covered(t, ids.brandId)).toContain("SL-RED-INK");
  });

  test("NEO-306: a parallel of an insert still holding a BSC link stays, only its SportLots link leaves", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const autos = await insertRow(t, {
      level: "insert",
      value: "Autos",
      parentId: ids.insertTypeId,
      metadata: { isInsert: true },
    });
    const redInk = await insertRow(t, {
      level: "parallel",
      value: "Red Ink",
      parentId: autos,
      platformData: { bsc: { b0: "red-ink" }, sportlots: { s0: "SL-RED-INK" } },
      platformLabels: { sportlots: { s0: "Autos Red Ink" } },
      platformFacets: { bsc: { b0: "variantName" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      metadata: { isParallel: true },
    });
    await addCards(t, redInk, [{ n: "1", bsc: { ref: "b1", src: "b0" } }]);
    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.promoteParallelToSet, { parallelId: redInk, slSlotKey: "s0" });
    expect(result.parallelKept).toBe(true);
    const kept = (await get(t, redInk))!;
    expect(kept.platformData).toEqual({ bsc: { b0: "red-ink" } });
    // The BSC side is untouched, facet tag included.
    expect(kept.platformFacets).toEqual({ bsc: { b0: "variantName" } });
    expect(await cardsOn(t, redInk)).toHaveLength(1);
  });

  test("attach: the link and its cards join an existing set's Base", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-SAPPHIRE", label: "Bowman Sapphire" }]);
    const row = await insertRow(t, {
      level: "insert",
      value: "Sapphire",
      parentId: ids.parallelTypeId,
      platformData: { sportlots: { s0: "SL-SAPPHIRE-2" } },
      platformLabels: { sportlots: { s0: "Sapphire" } },
      platformSlotSeq: { sportlots: 1 },
    });
    const [card] = await addCards(t, row, [{ n: "4", sl: { ref: "#4", src: "s0" } }]);
    const as = t.withIdentity(ADMIN);
    // "Sapphire" → "Bowman Sapphire", which the brand already has.
    await expect(
      as.mutation(api.setParallelConversion.promoteParallelToSet, {
        parallelId: row,
        slSlotKey: "s0",
      }),
    ).rejects.toThrow(promotionRefusal.nameTaken("Bowman", "Bowman Sapphire"));

    const result = await as.mutation(api.setParallelConversion.promoteParallelToSet, {
      parallelId: row,
      slSlotKey: "s0",
      attachToSetId: sl["Bowman Sapphire"].setId,
    });
    expect(result).toMatchObject({
      setId: sl["Bowman Sapphire"].setId,
      baseId: sl["Bowman Sapphire"].baseId,
      created: false,
      parallelKept: false,
    });
    const base = (await get(t, sl["Bowman Sapphire"].baseId))!;
    expect(base.platformData).toEqual({
      sportlots: { s0: "SL-SAPPHIRE", s1: "SL-SAPPHIRE-2" },
    });
    expect(base.platformLabels?.sportlots).toEqual({ s0: "Bowman Sapphire", s1: "Sapphire" });
    const moved = (await t.run(async (ctx) => ctx.db.get(card)))!;
    expect(moved.selectorOptionId).toBe(base._id);
    expect(moved.platformData.sportlots).toEqual({ ref: "#4", src: "s1" });
    expect(await get(t, row)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The round trip
// ───────────────────────────────────────────────────────────────────────────

describe("demote → promote → demote", () => {
  test("ids and labels are preserved and the id stays covered at every step", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-NEON", label: "Bowman Neon Green" }]);
    const [c1, c2] = await addCards(t, sl["Bowman Neon Green"].baseId, [
      { n: "1", sl: { ref: "#1 One", src: "s0" } },
      { n: "2", sl: { ref: "#2 Two", src: "s0" } },
    ]);
    const as = t.withIdentity(ADMIN);
    expect(await covered(t, ids.brandId)).toContain("SL-NEON");

    // 1. Demote.
    const demoted = await as.mutation(api.setParallelConversion.convertSetToParallel, {
      setId: sl["Bowman Neon Green"].setId,
      targetParallelTypeId: ids.parallelTypeId,
    });
    expect(demoted.parallelValue).toBe("Neon Green");
    expect(await covered(t, ids.brandId)).toContain("SL-NEON");
    // A re-run of the Sync Sets write would not re-create it either: the
    // sync only files roots nothing covers, and the id is covered.

    // 2. Promote.
    const promoted = await as.mutation(api.setParallelConversion.promoteParallelToSet, {
      parallelId: demoted.parallelId,
      slSlotKey: "s0",
    });
    expect(promoted).toMatchObject({ setValue: "Bowman Neon Green", created: true, parallelKept: false });
    const base = (await get(t, promoted.baseId))!;
    expect(base.platformData).toEqual({ sportlots: { s0: "SL-NEON" } });
    expect(base.platformLabels).toEqual({ sportlots: { s0: "Bowman Neon Green" } });
    expect((await cardsOn(t, base._id)).map((c) => c._id).sort()).toEqual([c1, c2].sort());
    expect(await get(t, demoted.parallelId)).toBeNull();
    expect(await covered(t, ids.brandId)).toContain("SL-NEON");

    // 3. And back again: the same cards, the same link, the same name.
    const again = await as.mutation(api.setParallelConversion.convertSetToParallel, {
      setId: promoted.setId,
      targetParallelTypeId: ids.parallelTypeId,
    });
    expect(again.parallelValue).toBe("Neon Green");
    const row = (await get(t, again.parallelId))!;
    expect(row.platformData).toEqual({ sportlots: { s0: "SL-NEON" } });
    expect(row.platformLabels).toEqual({ sportlots: { s0: "Bowman Neon Green" } });
    const cards = await cardsOn(t, row._id);
    expect(cards.map((c) => c._id).sort()).toEqual([c1, c2].sort());
    for (const c of cards) expect(c.platformData.sportlots?.src).toBe("s0");
    expect(await covered(t, ids.brandId)).toContain("SL-NEON");
    await drainScheduled(t);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The dialog's reads
// ───────────────────────────────────────────────────────────────────────────

describe("the queries behind the dialogs", () => {
  test("eligibility: offered on a SportLots-only set, never on a BSC set", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-RED", label: "Bowman Red" }]);
    const as = t.withIdentity(ADMIN);
    expect(
      await as.query(api.setParallelConversion.getSetToParallelEligibility, {
        setId: sl["Bowman Red"].setId,
      }),
    ).toEqual({ eligible: true });
    expect(
      await as.query(api.setParallelConversion.getSetToParallelEligibility, {
        setId: ids.bowmanId,
      }),
    ).toEqual({ eligible: false });
    await expect(
      t.withIdentity(SIGNED_IN).query(api.setParallelConversion.getSetToParallelEligibility, {
        setId: sl["Bowman Red"].setId,
      }),
    ).rejects.toThrow();
  });

  test("targets: the brand's other sets, their Parallel type, the longest-prefix set preselected", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [
      { id: "SL-CHROME-GOLD", label: "Bowman Chrome Gold" },
      { id: "SL-RED", label: "Bowman Red" },
    ]);
    const result = await t
      .withIdentity(ADMIN)
      .query(api.setParallelConversion.getSetToParallelTargets, {
        setId: sl["Bowman Chrome Gold"].setId,
      });
    if (!result.ok) throw new Error(result.reason);
    expect(result.targets.map((x) => x.value)).toEqual(["Bowman", "Bowman Chrome", "Bowman Red"]);
    expect(result.targets.find((x) => x.value === "Bowman Red")!.parallelTypeId).toBeUndefined();
    expect(result.suggestedSetId).toBe(ids.chromeId);
    expect(result.cardCount).toBe(0);
    // NEO-306: the description says a link moves only when one does.
    expect(result.linkCount).toBe(1);
  });

  test("target detail: parallels listed, a clash preselects the one to add to, a held link is flagged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    const as = t.withIdentity(ADMIN);
    const detail = await as.query(api.setParallelConversion.getSetToParallelTargetDetail, {
      setId: sl["Bowman Blue"].setId,
      targetSetId: ids.bowmanId,
    });
    if (!detail.ok) throw new Error(detail.reason);
    expect(detail.parallels.map((p) => p.value)).toEqual(["Blue", "Gold"]);
    expect(detail.newName).toBeUndefined();
    expect(detail.newRefusal).toBe(conversionRefusal.nameTaken("Bowman", "Blue"));
    expect(detail.sameAsId).toBe(ids.blueId);

    const none = await as.query(api.setParallelConversion.getSetToParallelTargetDetail, {
      setId: sl["Bowman Blue"].setId,
      targetSetId: (await slSets(t, ids.brandId, [{ id: "SL-X", label: "Bowman X" }]))["Bowman X"].setId,
    });
    expect(none).toEqual({ ok: false, reason: noParallelTypeYet("Bowman X") });

    await t.run(async (ctx) => {
      await ctx.db.patch(ids.goldId, {
        platformData: { bsc: { b0: "gold" }, sportlots: { s0: "SL-BLUE" } },
      });
    });
    const held = await as.query(api.setParallelConversion.getSetToParallelTargetDetail, {
      setId: sl["Bowman Blue"].setId,
      targetSetId: ids.bowmanId,
    });
    if (!held.ok) throw new Error(held.reason);
    expect(held.parallels.find((p) => p.value === "Gold")!.holdsLink).toBe(true);
    expect(held.holdsLinkReason).toBe(conversionRefusal.linkTaken("Bowman", "Gold", "Bowman Blue"));
  });

  test("promotion: offered only on a parallel carrying a SportLots link; the preview names the set and the clash", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const as = t.withIdentity(ADMIN);
    expect(
      await as.query(api.setParallelConversion.getParallelPromotionEligibility, {
        parallelId: ids.goldId,
      }),
    ).toEqual({ eligible: false });
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.goldId, {
        platformData: { bsc: { b0: "gold" }, sportlots: { s0: "SL-CHROME" } },
        platformLabels: { sportlots: { s0: "Chrome" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    expect(
      await as.query(api.setParallelConversion.getParallelPromotionEligibility, {
        parallelId: ids.goldId,
      }),
    ).toEqual({ eligible: true, links: [{ slot: "s0", label: "Chrome" }] });
    const preview = await as.query(api.setParallelConversion.getParallelPromotionPreview, {
      parallelId: ids.goldId,
      slSlotKey: "s0",
    });
    expect(preview).toEqual({
      ok: true,
      rowValue: "Gold",
      brandValue: "Bowman",
      setName: "Bowman Chrome",
      cardCount: 0,
      rowStays: true,
      clash: { setId: ids.chromeId, value: "Bowman Chrome", hasBase: false, holdsLink: false },
    });
  });

  test("brand holders: every SportLots link under the brand's OTHER sets, by NB name", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await slSets(t, ids.brandId, [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    await insertRow(t, {
      level: "insert",
      value: "Refractor",
      parentId: ids.chromeParallelTypeId,
      platformData: { sportlots: { s0: "SL-CHROME-REF" } },
    });
    // Bowman's own Base link is this set's business, not "elsewhere".
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.bowmanBaseId, {
        platformData: { bsc: { b0: "base" }, sportlots: { s0: "SL-BOWMAN" } },
      });
    });
    const result = await t
      .withIdentity(ADMIN)
      .query(api.setParallelConversion.getBrandSlHolders, {
        variantTypeId: ids.parallelTypeId,
      });
    expect(result.truncated).toBe(false);
    expect(
      result.rows.map((r) => ({ name: r.name, sportlots: r.sportlots })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    ).toEqual([
      { name: "Bowman Blue", sportlots: ["SL-BLUE"] },
      { name: "Bowman Chrome Refractor", sportlots: ["SL-CHROME-REF"] },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Security-audit conditions (NEO-305)
// ───────────────────────────────────────────────────────────────────────────

/** A staged checklist review on `rowId` — another admin's work in flight. */
async function stageReview(t: T, rowId: RowId) {
  await t.run(async (ctx) => {
    await ctx.db.insert("checklistCandidates", {
      selectorOptionId: rowId,
      batchId: "batch-audit",
      createdByUserId: "another_admin",
      cardNumber: "1",
      cardName: "Card 1",
      platformData: {},
      bucket: "matched",
      stem: "1",
      status: "ready",
      lastUpdated: SENTINEL,
    });
  });
}

describe("security audit — convertSetToParallel", () => {
  test("attach refuses when ANY parallel of the type holds a moving link, not only the one picked", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    // Gold holds the link; the operator tries to add to Blue.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.goldId, {
        platformData: { bsc: { b0: "gold" }, sportlots: { s0: "SL-BLUE" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Blue"].setId,
          targetParallelTypeId: ids.parallelTypeId,
          attachToId: ids.blueId,
        }),
      conversionRefusal.linkTaken("Bowman", "Gold", "Bowman Blue"),
    );
  });

  test("attach refuses a destination with a checklist review open", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-BLUE", label: "Bowman Blue" }]);
    await stageReview(t, ids.blueId);
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.convertSetToParallel, {
          setId: sl["Bowman Blue"].setId,
          targetParallelTypeId: ids.parallelTypeId,
          attachToId: ids.blueId,
        }),
      conversionRefusal.reviewOpen("Blue"),
    );
  });

  test("a NEW parallel carries the card prefix, the attributes and the team; the Base's own role keys stay behind", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-FUCHSIA", label: "Bowman Fuchsia" }]);
    const { setId, baseId } = sl["Bowman Fuchsia"];
    const teamId = await t.run(async (ctx) => {
      const year = (await ctx.db.get(ids.yearId))!;
      return ctx.db.insert("teams", {
        ...teamRowFields({ name: "Bulls", location: "Durham" }),
        sportId: year.parentId!,
        lastUpdated: SENTINEL,
      } as never);
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(setId, {
        features: { releaseDate: "2026-05-01" },
        declinedUpstreamLabels: { sportlots: "bowman fuchsia refractor" },
      });
      await ctx.db.patch(baseId, {
        metadata: { isBase: true, cardNumberPrefix: "BF-" },
        features: { cardType: "Base", parallelName: "Base", isCaseHit: "true" },
        teamIds: [teamId as Id<"teams">],
      });
    });

    const detail = await t
      .withIdentity(ADMIN)
      .query(api.setParallelConversion.getSetToParallelTargetDetail, {
        setId,
        targetSetId: ids.bowmanId,
      });
    if (!detail.ok) throw new Error(detail.reason);
    // Only the turned-down names stay behind a NEW parallel…
    expect(detail.newLoses).toEqual({
      cardPrefix: false,
      featureKeys: [],
      team: false,
      dismissedNames: true,
    });
    // …while adding to BSC's Blue keeps Blue's own data and leaves these.
    expect(detail.parallels.find((p) => p.value === "Blue")!.loses).toEqual({
      cardPrefix: true,
      featureKeys: ["isCaseHit", "releaseDate"],
      team: true,
      dismissedNames: true,
    });

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.convertSetToParallel, {
        setId,
        targetParallelTypeId: ids.parallelTypeId,
      });
    const row = (await get(t, result.parallelId))!;
    expect(row.metadata).toEqual({ isParallel: true, cardNumberPrefix: "BF-" });
    expect(row.teamIds).toEqual([teamId]);
    expect(row.features).toMatchObject({
      season: "2026",
      releaseDate: "2026-05-01",
      isCaseHit: "true",
    });
    // The parallel's own role, not the Base's.
    expect(row.features?.cardType).not.toBe("Base");
    expect(row.features?.parallelName).toBeUndefined();
  });
});

describe("security audit — promoteParallelToSet", () => {
  test.each(["b0", "s", "S0", "s0x", "__proto__", ""])(
    "a slot key that is not a SportLots slot (%j) is refused, and the preview says so",
    async (slSlotKey) => {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      await t.run(async (ctx) => {
        await ctx.db.patch(ids.goldId, {
          platformData: { bsc: { b0: "gold" }, sportlots: { s0: "SL-GOLD" } },
          platformSlotSeq: { bsc: 1, sportlots: 1 },
        });
      });
      await expectRefusal(
        t,
        () =>
          t.withIdentity(ADMIN).mutation(api.setParallelConversion.promoteParallelToSet, {
            parallelId: ids.goldId,
            slSlotKey,
          }),
        promotionRefusal.linkGone("Gold"),
      );
      expect(
        await t
          .withIdentity(ADMIN)
          .query(api.setParallelConversion.getParallelPromotionPreview, {
            parallelId: ids.goldId,
            slSlotKey,
          }),
      ).toEqual({ ok: false, reason: promotionRefusal.linkGone("Gold") });
    },
  );

  test("attach refuses a destination Base with a checklist review open", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sl = await slSets(t, ids.brandId, [{ id: "SL-SAPPHIRE", label: "Bowman Sapphire" }]);
    const row = await insertRow(t, {
      level: "insert",
      value: "Sapphire",
      parentId: ids.parallelTypeId,
      platformData: { sportlots: { s0: "SL-SAPPHIRE-2" } },
      platformSlotSeq: { sportlots: 1 },
    });
    await stageReview(t, sl["Bowman Sapphire"].baseId);
    await expectRefusal(
      t,
      () =>
        t.withIdentity(ADMIN).mutation(api.setParallelConversion.promoteParallelToSet, {
          parallelId: row,
          slSlotKey: "s0",
          attachToSetId: sl["Bowman Sapphire"].setId,
        }),
      promotionRefusal.reviewOpen("Bowman Sapphire"),
    );
  });
});

describe("parallelTypeOf is bounded (NEO-306 security audit)", () => {
  test("a Parallel type past MAX_VARIANT_TYPES_PER_SET is not looked for: the set reads as having none (fail closed)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // A BSC set whose Parallel type sits after MAX_VARIANT_TYPES_PER_SET
    // role-less types in index order.
    const sapphireId = await insertRow(t, {
      level: "setName",
      value: "Bowman Sapphire",
      parentId: ids.brandId,
      platformData: { bsc: { b0: "bowman-sapphire" } },
      platformSlotSeq: { bsc: 1 },
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_VARIANT_TYPES_PER_SET; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Promo ${i}`,
          parentId: sapphireId,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
    await insertRow(t, {
      level: "variantType",
      value: "Parallel",
      parentId: sapphireId,
      ...roleType("parallel"),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sl = await slSets(t, ids.brandId, [{ id: "SL-RED", label: "Bowman Red" }]);
      const as = t.withIdentity(ADMIN);

      const targets = await as.query(api.setParallelConversion.getSetToParallelTargets, {
        setId: sl["Bowman Red"].setId,
      });
      if (!targets.ok) throw new Error(targets.reason);
      expect(targets.targets.find((x) => x.setId === sapphireId)).toEqual({
        setId: sapphireId,
        value: "Bowman Sapphire",
      });
      // Chrome's Parallel type, within the cap, is found exactly as before.
      expect(targets.targets.find((x) => x.setId === ids.chromeId)?.parallelTypeId).toBe(
        ids.chromeParallelTypeId,
      );

      const detail = await as.query(api.setParallelConversion.getSetToParallelTargetDetail, {
        setId: sl["Bowman Red"].setId,
        targetSetId: sapphireId,
      });
      expect(detail).toEqual({ ok: false, reason: noParallelTypeYet("Bowman Sapphire") });
    } finally {
      warn.mockRestore();
    }
  });
});
