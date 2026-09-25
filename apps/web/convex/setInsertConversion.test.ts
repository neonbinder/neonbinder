/**
 * NEO-306 — "Make insert of…" (`setInsertConversion.ts`).
 *
 * The fixture is 2026 Bowman after NEO-305: BSC's Bowman with a Base, a
 * Parallel type and an Insert type (their NB roles as the variant-type sync
 * confers them: `isBase` / `metadata.variantRole`, beside the `variant`-tagged
 * BSC slot it was read from), BSC's "All-America Game Autos" insert with a
 * BSC parallel "Gold" under it (a `variantName`-tagged BSC slot, as NEO-293
 * writes it), a second set with no Insert type, and another brand.
 *
 * Sources: S1, a SportLots-only set that is nothing but a Base (the shape
 * Sync Sets mints), and S2, an insert-level row the Parallels reconcile filed
 * under Bowman's Parallel type.
 *
 * What is pinned: eligibility for both source shapes; the dialog's reads;
 * each of the five landings moving every link (id + label, primary first)
 * and every card by its own slot, flags derived, operator data carried,
 * source rows gone, the id still covered; every refusal writing nothing; the
 * BSC side of a joined destination deep-equal to its pre-write snapshot; the
 * link-taken rule reaching parallel rows under the inserts; and the round
 * trip back through "Promote to set".
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { MAX_CARDS_PER_MOVE, sourceDataOfRow } from "./setShapeMove";
import { MAX_INSERT_TREE_ROWS, insertConversionRefusal } from "./setInsertConversion";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_neo306", role: "admin" };
const SIGNED_IN = { subject: "user_neo306" };
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

/** A variant type as the BSC variant-type sync writes it, role conferred. */
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
    ...roleType("parallel"),
  });
  const insertTypeId = await insertRow(t, {
    level: "variantType",
    value: "Insert",
    parentId: bowmanId,
    features: { season: "2026" },
    ...roleType("insert"),
  });
  // BSC's insert, and BSC's parallel of it (NEO-293's promoted-parallel facet).
  const autosId = await insertRow(t, {
    level: "insert",
    value: "All-America Game Autos",
    parentId: insertTypeId,
    platformData: { bsc: { b0: "aa-autos" } },
    platformFacets: { bsc: { b0: "variantName" } },
    platformLabels: { bsc: { b0: "All-America Game Autos" } },
    platformSlotSeq: { bsc: 1 },
    metadata: { isInsert: true },
    features: { season: "2026", cardType: "Insert" },
  });
  const goldId = await insertRow(t, {
    level: "parallel",
    value: "Gold",
    parentId: autosId,
    platformData: { bsc: { b0: "aa-autos-gold" } },
    platformFacets: { bsc: { b0: "variantName" } },
    platformSlotSeq: { bsc: 1 },
    metadata: { isParallel: true },
  });

  // A second set of the brand with a Parallel type and NO Insert type.
  const chromeId = await insertRow(t, {
    level: "setName",
    value: "Bowman Chrome",
    parentId: brandId,
    platformData: { bsc: { b0: "bowman-chrome" } },
    platformSlotSeq: { bsc: 1 },
  });
  const chromeParallelTypeId = await insertRow(t, {
    level: "variantType",
    value: "Parallel",
    parentId: chromeId,
    ...roleType("parallel"),
  });

  // Another brand's set with an Insert type — never a legal target.
  const toppsId = await insertRow(t, {
    level: "setName",
    value: "Topps",
    parentId: otherBrandId,
    platformData: { bsc: { b0: "topps" } },
    platformSlotSeq: { bsc: 1 },
  });
  const toppsInsertTypeId = await insertRow(t, {
    level: "variantType",
    value: "Insert",
    parentId: toppsId,
    ...roleType("insert"),
  });

  return {
    yearId,
    brandId,
    bowmanId,
    bowmanBaseId,
    parallelTypeId,
    insertTypeId,
    autosId,
    goldId,
    chromeId,
    chromeParallelTypeId,
    toppsId,
    toppsInsertTypeId,
  };
}

/** S1: a SportLots-only set and its Base, the shape Sync Sets mints. */
async function slSet(
  t: T,
  brandId: RowId,
  name: string,
  links: Array<{ id: string; label: string }>,
  extra: { base?: Partial<Row>; set?: Partial<Row> } = {},
): Promise<{ setId: RowId; baseId: RowId }> {
  const setId = await insertRow(t, {
    level: "setName",
    value: name,
    parentId: brandId,
    ...extra.set,
  });
  const baseId = await insertRow(t, {
    level: "variantType",
    value: "Base",
    parentId: setId,
    metadata: { isBase: true },
    features: { cardType: "Base", parallelName: "Base" },
    platformData: {
      sportlots: Object.fromEntries(links.map((l, i) => [`s${i}`, l.id])),
    },
    platformLabels: {
      sportlots: Object.fromEntries(links.map((l, i) => [`s${i}`, l.label])),
    },
    platformSlotSeq: { sportlots: links.length },
    ...extra.base,
  });
  return { setId, baseId };
}

/** S2: an insert-level row the Parallels reconcile filed under Bowman › Parallel. */
async function slRow(
  t: T,
  parentId: RowId,
  value: string,
  links: Array<{ id: string; label: string }>,
  extra: Partial<Row> = {},
): Promise<RowId> {
  return insertRow(t, {
    level: "insert",
    value,
    parentId,
    platformData: {
      sportlots: Object.fromEntries(links.map((l, i) => [`s${i}`, l.id])),
    },
    platformLabels: {
      sportlots: Object.fromEntries(links.map((l, i) => [`s${i}`, l.label])),
    },
    platformSlotSeq: { sportlots: links.length },
    metadata: { isParallel: true },
    features: { cardType: "Parallel", season: "2026" },
    ...extra,
  });
}

type CardSpec = {
  n: string;
  sl?: { ref: string; src?: string };
  bsc?: { ref: string; src?: string };
};

async function addCards(t: T, rowId: RowId, cards: CardSpec[]): Promise<Id<"cardChecklist">[]> {
  return t.run(async (ctx) => {
    const ids: Id<"cardChecklist">[] = [];
    for (const [i, c] of cards.entries()) {
      ids.push(
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: rowId,
          cardNumber: c.n,
          cardName: `Player ${c.n}`,
          platformData: {
            ...(c.sl ? { sportlots: c.sl } : {}),
            ...(c.bsc ? { bsc: c.bsc } : {}),
          },
          sortOrder: i,
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

async function card(t: T, id: Id<"cardChecklist">) {
  return t.run(async (ctx) => ctx.db.get(id));
}

async function covered(t: T, brandId: RowId): Promise<string[]> {
  const { ids, truncated } = await t.query(
    internal.selectorOptions.listBrandSubtreeSlIds,
    { manufacturerId: brandId },
  );
  expect(truncated).toBe(false);
  return ids;
}

async function childrenAt(t: T, level: Row["level"], parentId: RowId) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) => q.eq("level", level).eq("parentId", parentId))
      .collect(),
  );
}

/** Everything, for "a refusal wrote nothing" snapshots. */
async function snapshot(t: T) {
  return t.run(async (ctx) => ({
    rows: (await ctx.db.query("selectorOptions").collect()).map((r) => ({
      ...r,
      _creationTime: 0,
    })),
    cards: await ctx.db.query("cardChecklist").collect(),
    guests: await ctx.db.query("cardCrossListings").collect(),
  }));
}

async function expectRefusal(t: T, call: () => Promise<unknown>, message: string) {
  const before = await snapshot(t);
  await expect(call()).rejects.toThrow(message);
  expect(await snapshot(t)).toEqual(before);
}

/** The BSC side of a row: what no NEO-306 write may touch (v3 D1). */
function bscSide(row: Row | null) {
  return {
    data: row?.platformData.bsc,
    facets: row?.platformFacets?.bsc,
    labels: row?.platformLabels?.bsc,
  };
}

const RED_INK = { id: "SL-RED-INK", label: "All-America Game Autos Red Ink" };

function convert(
  t: T,
  rowId: RowId,
  targetInsertTypeId: RowId,
  landing:
    | { kind: "newInsert" }
    | { kind: "joinInsert"; insertId: RowId }
    | { kind: "newParallel"; insertId: RowId }
    | { kind: "joinParallel"; parallelId: RowId }
    | { kind: "newInsertNamed"; name: string },
) {
  return t
    .withIdentity(ADMIN)
    .mutation(api.setInsertConversion.convertToInsert, { rowId, targetInsertTypeId, landing });
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

describe("sourceDataOfRow (S2's operator data)", () => {
  test("its own level-derived keys stay behind; everything the operator typed comes along", () => {
    const row = {
      features: { cardType: "Parallel", parallelName: "Red Ink", season: "2026", printRun: "/25" },
      metadata: { cardNumberPrefix: "AA-", isParallel: true },
      teamIds: ["t1" as Id<"teams">],
      declinedUpstreamLabels: { sportlots: "Red Ink Autos" },
    } as unknown as Row;
    expect(sourceDataOfRow(row)).toEqual({
      cardNumberPrefix: "AA-",
      features: { season: "2026", printRun: "/25" },
      teamIds: ["t1"],
      declined: true,
    });
  });

  test("a bare row carries nothing", () => {
    expect(sourceDataOfRow({ platformData: {} } as unknown as Row)).toEqual({
      features: {},
      declined: false,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Eligibility and the dialog's reads
// ───────────────────────────────────────────────────────────────────────────

describe("eligibility", () => {
  test("S1 and S2 are offered; a BSC-linked row, a row with parallels, a type and a parallel row are not", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { setId } = await slSet(t, ids.brandId, "Bowman Stars", [
      { id: "SL-STARS", label: "Bowman Stars" },
    ]);
    const redInk = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK]);
    // Invariant 6: a row with no marketplace ids at all behaves the same.
    const bare = await slRow(t, ids.insertTypeId, "Hand Made", [], { platformData: {} });
    const withParallel = await slRow(t, ids.insertTypeId, "Futures", [
      { id: "SL-FUT", label: "Futures" },
    ]);
    await insertRow(t, { level: "parallel", value: "Blue", parentId: withParallel });

    const eligible = async (rowId: RowId) =>
      (
        await t
          .withIdentity(ADMIN)
          .query(api.setInsertConversion.getMakeInsertEligibility, { rowId })
      ).eligible;
    expect(await eligible(setId)).toBe(true);
    expect(await eligible(redInk)).toBe(true);
    expect(await eligible(bare)).toBe(true);
    expect(await eligible(ids.bowmanId)).toBe(false); // BSC lists it
    expect(await eligible(ids.autosId)).toBe(false); // BSC lists it
    expect(await eligible(withParallel)).toBe(false);
    expect(await eligible(ids.insertTypeId)).toBe(false);
    expect(await eligible(ids.goldId)).toBe(false);

    await expect(
      t.withIdentity(SIGNED_IN).query(api.setInsertConversion.getMakeInsertEligibility, {
        rowId: setId,
      }),
    ).rejects.toThrow();
  });

  test("targets: a set never lists itself; a row's own set is listed and preselected", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { setId } = await slSet(t, ids.brandId, "Bowman All-America", [
      { id: "SL-AA", label: "Bowman All-America" },
    ]);
    await addCards(t, (await get(t, setId))!.children[0], [{ n: "1" }, { n: "2" }]);
    const s1 = await t
      .withIdentity(ADMIN)
      .query(api.setInsertConversion.getMakeInsertTargets, { rowId: setId });
    expect(s1).toMatchObject({
      ok: true,
      kind: "set",
      rowValue: "Bowman All-America",
      brandValue: "Bowman",
      cardCount: 2,
      truncated: false,
      suggestedSetId: ids.bowmanId,
    });
    if (!s1.ok) throw new Error("unreachable");
    expect(s1.targets).toEqual([
      { setId: ids.bowmanId, value: "Bowman", insertTypeId: ids.insertTypeId, insertTypeValue: "Insert" },
      { setId: ids.chromeId, value: "Bowman Chrome" },
    ]);

    const redInk = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK]);
    const s2 = await t
      .withIdentity(ADMIN)
      .query(api.setInsertConversion.getMakeInsertTargets, { rowId: redInk });
    expect(s2).toMatchObject({
      ok: true,
      kind: "row",
      ownSetId: ids.bowmanId,
      ownSetValue: "Bowman",
      suggestedSetId: ids.bowmanId,
    });
    if (!s2.ok) throw new Error("unreachable");
    expect(s2.targets.map((x) => x.value)).toEqual([
      "Bowman",
      "Bowman All-America",
      "Bowman Chrome",
    ]);
  });

  test("target detail: inserts listed without the source, the derived name, a clash, a set with no Insert type", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const redInk = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK]);
    const detail = await t
      .withIdentity(ADMIN)
      .query(api.setInsertConversion.getMakeInsertTargetDetail, {
        rowId: redInk,
        targetSetId: ids.bowmanId,
      });
    expect(detail).toMatchObject({
      ok: true,
      targetSetValue: "Bowman",
      insertTypeId: ids.insertTypeId,
      insertTypeValue: "Insert",
      newInsertName: "All-America Game Autos Red Ink",
      truncated: false,
      newLoses: { cardPrefix: false, featureKeys: [], team: false, dismissedNames: false },
    });
    if (!detail.ok) throw new Error("unreachable");
    expect(detail.inserts).toEqual([
      {
        _id: ids.autosId,
        value: "All-America Game Autos",
        holdsLink: false,
        loses: { cardPrefix: false, featureKeys: [], team: false, dismissedNames: false },
      },
    ]);
    expect(detail.holdsLinkReason).toBeUndefined();

    // A row named after an existing insert: new is refused, that insert preselected.
    const clash = await slRow(t, ids.parallelTypeId, "All-America Game Autos", [
      { id: "SL-AA-AUTOS", label: "Bowman All-America Game Autos" },
    ]);
    const clashDetail = await t
      .withIdentity(ADMIN)
      .query(api.setInsertConversion.getMakeInsertTargetDetail, {
        rowId: clash,
        targetSetId: ids.bowmanId,
      });
    expect(clashDetail).toMatchObject({
      ok: true,
      newInsertRefusal: insertConversionRefusal.insertNameTaken("Bowman", "All-America Game Autos"),
      sameAsInsertId: ids.autosId,
    });

    for (const [targetSetId, reason] of [
      [ids.chromeId, insertConversionRefusal.noInsertTypeYet("Bowman Chrome")],
      [ids.toppsId, insertConversionRefusal.otherBrand("Topps", "Bowman")],
    ] as const) {
      expect(
        await t
          .withIdentity(ADMIN)
          .query(api.setInsertConversion.getMakeInsertTargetDetail, { rowId: redInk, targetSetId }),
      ).toEqual({ ok: false, reason });
    }
  });

  test("target detail: a moving link held by a PARALLEL under an insert blocks every landing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const redInk = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK]);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.goldId, {
        platformData: { bsc: { b0: "aa-autos-gold" }, sportlots: { s0: RED_INK.id } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    const detail = await t
      .withIdentity(ADMIN)
      .query(api.setInsertConversion.getMakeInsertTargetDetail, {
        rowId: redInk,
        targetSetId: ids.bowmanId,
      });
    expect(detail).toMatchObject({
      ok: true,
      holdsLinkReason: insertConversionRefusal.linkTaken(
        "All-America Game Autos Gold",
        "Bowman",
        "All-America Game Autos Red Ink",
      ),
    });
    if (!detail.ok) throw new Error("unreachable");
    expect(detail.inserts[0].holdsLink).toBe(true);
  });

  test("insert detail: the parallel name, the insert-itself case, a parallel clash", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const redInk = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK]);
    const detail = await t
      .withIdentity(ADMIN)
      .query(api.setInsertConversion.getMakeInsertInsertDetail, {
        rowId: redInk,
        insertId: ids.autosId,
      });
    expect(detail).toMatchObject({
      ok: true,
      insertValue: "All-America Game Autos",
      targetSetValue: "Bowman",
      newParallelName: "Red Ink",
      sameAsInsertSelf: false,
      // Joining the insert keeps the insert's own values: "season" matches.
      joinLoses: { cardPrefix: false, featureKeys: [], team: false, dismissedNames: false },
    });
    if (!detail.ok) throw new Error("unreachable");
    expect(detail.parallels.map((p) => p.value)).toEqual(["Gold"]);

    // The whole label is the insert's name (the set's name coming off first).
    const same = await slRow(t, ids.parallelTypeId, "AA Autos", [
      { id: "SL-AA-AUTOS", label: "Bowman All-America Game Autos" },
    ]);
    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.setInsertConversion.getMakeInsertInsertDetail, { rowId: same, insertId: ids.autosId }),
    ).toMatchObject({
      ok: true,
      sameAsInsertSelf: true,
      newParallelRefusal: insertConversionRefusal.insertOwnName(
        "Bowman All-America Game Autos",
        "All-America Game Autos",
      ),
    });

    const gold = await slRow(t, ids.parallelTypeId, "AA Gold", [
      { id: "SL-AA-GOLD", label: "All-America Game Autos Gold" },
    ]);
    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.setInsertConversion.getMakeInsertInsertDetail, { rowId: gold, insertId: ids.autosId }),
    ).toMatchObject({
      ok: true,
      sameAsInsertSelf: false,
      sameAsParallelId: ids.goldId,
      newParallelRefusal: insertConversionRefusal.parallelNameTaken("All-America Game Autos", "Gold"),
    });
  });

  test("named preview: the typed insert and the parallel left of the label", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "Rookie Autos Blue Ink", [
      { id: "SL-RA-BLUE", label: "Bowman Rookie Autos Blue Ink" },
    ]);
    const preview = (name: string) =>
      t.withIdentity(ADMIN).query(api.setInsertConversion.getMakeInsertNamedPreview, {
        rowId: row,
        targetSetId: ids.bowmanId,
        name,
      });
    expect(await preview("Rookie Autos")).toEqual({
      ok: true,
      insertName: "Rookie Autos",
      parallelName: "Blue Ink",
    });
    expect(await preview("Rookie Autos Blue Ink")).toEqual({
      ok: false,
      reason: insertConversionRefusal.wholeName("Bowman Rookie Autos Blue Ink"),
    });
    expect(await preview("all-america game autos")).toEqual({
      ok: false,
      reason: insertConversionRefusal.insertNameTaken("Bowman", "All-America Game Autos"),
      sameAsInsertId: ids.autosId,
    });
    expect(await preview("   ")).toMatchObject({ ok: false });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The five landings
// ───────────────────────────────────────────────────────────────────────────

describe("convertToInsert — the landings", () => {
  test("S1 → newInsert: every link (primary first) and every card by its own slot; the set and Base go", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { setId, baseId } = await slSet(
      t,
      ids.brandId,
      "Bowman Stars",
      [
        { id: "SL-STARS", label: "Bowman Stars" },
        { id: "SL-STARS-UPDATE", label: "Bowman Stars Update" },
      ],
      {
        base: {
          primaryPlatformId: { sportlots: "s1" },
          metadata: { isBase: true, cardNumberPrefix: "BS-" },
          features: { cardType: "Base", parallelName: "Base", printRun: "/99" },
        },
      },
    );
    const [onS0, onS1, dangling] = await addCards(t, baseId, [
      { n: "BS-1", sl: { ref: "#1", src: "s0" } },
      { n: "BS-1", sl: { ref: "#1u", src: "s1" } }, // card numbers are never unique
      { n: "BS-2", sl: { ref: "#2", src: "s9" }, bsc: { ref: "stale", src: "b0" } },
    ]);

    const result = await convert(t, setId, ids.insertTypeId, { kind: "newInsert" });
    // Named once, from the PRIMARY link's label, with the set's name taken off.
    expect(result).toMatchObject({
      created: true,
      landedValue: "Stars Update",
      targetSetValue: "Bowman",
    });
    expect(result.path.map((p) => [p.level, p.value])).toEqual([
      ["setName", "Bowman"],
      ["variantType", "Insert"],
      ["insert", "Stars Update"],
    ]);
    const dest = (await get(t, result.path[2]._id))!;
    // The primary (s1 on the Base) leads, so it takes the destination's first slot.
    expect(dest.platformData).toEqual({ sportlots: { s0: "SL-STARS-UPDATE", s1: "SL-STARS" } });
    expect(dest.platformLabels).toEqual({
      sportlots: { s0: "Bowman Stars Update", s1: "Bowman Stars" },
    });
    expect(dest.parentId).toBe(ids.insertTypeId);
    expect(dest.metadata).toEqual({ isInsert: true, cardNumberPrefix: "BS-" });
    // Type copy-down, then the operator's data, then the row's own level; the
    // Base's own "Base" keys stay behind.
    expect(dest.features).toEqual({ season: "2026", printRun: "/99", cardType: "Insert" });
    expect(dest.createdByUserId).toBe(ADMIN.subject);
    expect((await get(t, ids.insertTypeId))!.children).toContain(dest._id);

    expect((await card(t, onS0))!.platformData).toEqual({ sportlots: { ref: "#1", src: "s1" } });
    expect((await card(t, onS1))!.platformData).toEqual({ sportlots: { ref: "#1u", src: "s0" } });
    // A src that pointed at nothing is cleared, never carried; refs are kept.
    expect((await card(t, dangling))!.platformData).toEqual({
      sportlots: { ref: "#2" },
      bsc: { ref: "stale" },
    });
    expect((await cardsOn(t, dest._id)).map((c) => c._id).sort()).toEqual(
      [onS0, onS1, dangling].sort(),
    );

    expect(await get(t, setId)).toBeNull();
    expect(await get(t, baseId)).toBeNull();
    expect((await get(t, ids.brandId))!.children).not.toContain(setId);
    const ids2 = await covered(t, ids.brandId);
    expect(ids2).toEqual(expect.arrayContaining(["SL-STARS", "SL-STARS-UPDATE"]));
  });

  test("S2 → joinInsert: the link joins BSC's insert; its BSC side is byte-for-byte what it was", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const redInk = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK], {
      metadata: { isParallel: true, cardNumberPrefix: "RI-" },
    });
    const [c1] = await addCards(t, redInk, [{ n: "AA-1", sl: { ref: "#AA-1", src: "s0" } }]);
    const [existing] = await addCards(t, ids.autosId, [
      { n: "AA-2", bsc: { ref: "b-AA-2", src: "b0" } },
    ]);
    // A guest listed in the row follows it.
    const guestCardId = (await addCards(t, ids.bowmanBaseId, [{ n: "9" }]))[0];
    await t.run(async (ctx) => {
      await ctx.db.insert("cardCrossListings", {
        cardChecklistId: guestCardId,
        selectorOptionId: redInk,
        lastUpdated: SENTINEL,
      });
    });
    const before = bscSide(await get(t, ids.autosId));

    const result = await convert(t, redInk, ids.insertTypeId, {
      kind: "joinInsert",
      insertId: ids.autosId,
    });
    expect(result).toMatchObject({ created: false, landedValue: "All-America Game Autos" });
    expect(result.path.map((p) => p._id)).toEqual([ids.bowmanId, ids.insertTypeId, ids.autosId]);
    const dest = (await get(t, ids.autosId))!;
    expect(bscSide(dest)).toEqual(before);
    expect(dest.platformData.sportlots).toEqual({ s0: RED_INK.id });
    expect(dest.platformLabels?.sportlots).toEqual({ s0: RED_INK.label });
    // Joining never writes over the operator's data on the destination.
    expect(dest.metadata).toEqual({ isInsert: true });
    expect((await card(t, c1))!).toMatchObject({
      selectorOptionId: ids.autosId,
      platformData: { sportlots: { ref: "#AA-1", src: "s0" } },
    });
    expect((await card(t, existing))!.platformData).toEqual({ bsc: { ref: "b-AA-2", src: "b0" } });
    const guests = await t.run(async (ctx) => ctx.db.query("cardCrossListings").collect());
    expect(guests.map((g) => g.selectorOptionId)).toEqual([ids.autosId]);
    expect(await get(t, redInk)).toBeNull();
    expect((await get(t, ids.parallelTypeId))!.children).not.toContain(redInk);
    expect(await covered(t, ids.brandId)).toContain(RED_INK.id);
  });

  test("S2 → newParallel: a parallel of the insert, named by taking the set's then the insert's name off", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const redInk = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [
      { id: "SL-RED-INK", label: "Bowman All-America Game Autos Red Ink" },
    ]);
    const [c1] = await addCards(t, redInk, [{ n: "AA-1", sl: { ref: "#AA-1", src: "s0" } }]);
    const before = bscSide(await get(t, ids.autosId));

    const result = await convert(t, redInk, ids.insertTypeId, {
      kind: "newParallel",
      insertId: ids.autosId,
    });
    expect(result.path.map((p) => [p.level, p.value])).toEqual([
      ["setName", "Bowman"],
      ["variantType", "Insert"],
      ["insert", "All-America Game Autos"],
      ["parallel", "Red Ink"],
    ]);
    const dest = (await get(t, result.path[3]._id))!;
    expect(dest).toMatchObject({
      level: "parallel",
      parentId: ids.autosId,
      platformData: { sportlots: { s0: "SL-RED-INK" } },
      platformLabels: { sportlots: { s0: "Bowman All-America Game Autos Red Ink" } },
      metadata: { isParallel: true },
    });
    // The insert's copy-down, the row's own "season"; its old "Parallel"
    // cardType is re-derived for the new level, not carried.
    expect(dest.features).toEqual({ season: "2026", cardType: "Parallel" });
    expect((await get(t, ids.autosId))!.children).toEqual([ids.goldId, dest._id]);
    expect(bscSide(await get(t, ids.autosId))).toEqual(before);
    expect((await card(t, c1))!).toMatchObject({
      selectorOptionId: dest._id,
      platformData: { sportlots: { ref: "#AA-1", src: "s0" } },
    });
    expect(await get(t, redInk)).toBeNull();
    expect(await covered(t, ids.brandId)).toContain("SL-RED-INK");
  });

  test("S1 → joinParallel: onto BSC's parallel of the insert, its BSC side untouched, cards appended", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { setId, baseId } = await slSet(t, ids.brandId, "Bowman All-America Game Autos Gold", [
      { id: "SL-AA-GOLD", label: "Bowman All-America Game Autos Gold" },
    ]);
    const [c1] = await addCards(t, baseId, [{ n: "AA-1", sl: { ref: "#AA-1g", src: "s0" } }]);
    await addCards(t, ids.goldId, [{ n: "AA-5", bsc: { ref: "b5", src: "b0" } }]);
    const before = bscSide(await get(t, ids.goldId));

    const result = await convert(t, setId, ids.insertTypeId, {
      kind: "joinParallel",
      parallelId: ids.goldId,
    });
    expect(result).toMatchObject({ created: false, landedValue: "Gold" });
    expect(result.path.map((p) => p._id)).toEqual([
      ids.bowmanId,
      ids.insertTypeId,
      ids.autosId,
      ids.goldId,
    ]);
    const dest = (await get(t, ids.goldId))!;
    expect(bscSide(dest)).toEqual(before);
    expect(dest.platformData.sportlots).toEqual({ s0: "SL-AA-GOLD" });
    expect((await card(t, c1))!).toMatchObject({
      selectorOptionId: ids.goldId,
      platformData: { sportlots: { ref: "#AA-1g", src: "s0" } },
      // Appended after the destination's own card; the restamp chain re-numbers.
      sortOrder: 1,
    });
    expect(await get(t, setId)).toBeNull();
    expect(await get(t, baseId)).toBeNull();
    expect(await covered(t, ids.brandId)).toContain("SL-AA-GOLD");
  });

  test("newInsertNamed: the typed insert (no links) and the row as a new parallel of it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "Rookie Autos Blue Ink", [
      { id: "SL-RA-BLUE", label: "Bowman Rookie Autos Blue Ink" },
    ], { teamIds: [] });
    const [c1] = await addCards(t, row, [{ n: "RA-1", sl: { ref: "#RA-1", src: "s0" } }]);

    const result = await convert(t, row, ids.insertTypeId, {
      kind: "newInsertNamed",
      name: "Rookie Autos",
    });
    expect(result).toMatchObject({ created: true, landedValue: "Blue Ink" });
    expect(result.path.map((p) => [p.level, p.value])).toEqual([
      ["setName", "Bowman"],
      ["variantType", "Insert"],
      ["insert", "Rookie Autos"],
      ["parallel", "Blue Ink"],
    ]);
    const insert = (await get(t, result.path[2]._id))!;
    expect(insert).toMatchObject({
      parentId: ids.insertTypeId,
      platformData: {},
      metadata: { isInsert: true },
      features: { season: "2026", cardType: "Insert" },
    });
    const parallel = (await get(t, result.path[3]._id))!;
    expect(parallel).toMatchObject({
      parentId: insert._id,
      platformData: { sportlots: { s0: "SL-RA-BLUE" } },
      platformLabels: { sportlots: { s0: "Bowman Rookie Autos Blue Ink" } },
      metadata: { isParallel: true },
    });
    expect(insert.children).toEqual([parallel._id]);
    expect((await card(t, c1))!.selectorOptionId).toBe(parallel._id);
    expect(await get(t, row)).toBeNull();
    expect(await covered(t, ids.brandId)).toContain("SL-RA-BLUE");
  });

  test("S2 under the Insert type itself: it can become a parallel of a sibling insert", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // The SportLots-only review files names under an Insert type too.
    const row = await slRow(t, ids.insertTypeId, "All-America Game Autos Red Ink", [RED_INK], {
      metadata: { isInsert: true },
      features: { cardType: "Insert" },
    });
    const result = await convert(t, row, ids.insertTypeId, {
      kind: "newParallel",
      insertId: ids.autosId,
    });
    expect(result.landedValue).toBe("Red Ink");
    expect(await get(t, row)).toBeNull();
    expect((await get(t, ids.insertTypeId))!.children).toEqual([ids.autosId]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refusals write nothing
// ───────────────────────────────────────────────────────────────────────────

describe("convertToInsert — refusals", () => {
  test("a caller who is not an admin", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "Red Ink", [RED_INK]);
    const args = { rowId: row, targetInsertTypeId: ids.insertTypeId, landing: { kind: "newInsert" as const } };
    await expect(
      t.withIdentity(SIGNED_IN).mutation(api.setInsertConversion.convertToInsert, args),
    ).rejects.toThrow();
    await expect(t.mutation(api.setInsertConversion.convertToInsert, args)).rejects.toThrow();
  });

  test("source guards: BSC link, parallels under it, not a set or insert row", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const futures = await slRow(t, ids.parallelTypeId, "Futures", [{ id: "SL-FUT", label: "Futures" }]);
    await insertRow(t, { level: "parallel", value: "Blue", parentId: futures });
    const landing = { kind: "newInsert" as const };
    await expectRefusal(
      t,
      () => convert(t, ids.autosId, ids.insertTypeId, landing),
      insertConversionRefusal.onBscRow("All-America Game Autos"),
    );
    await expectRefusal(
      t,
      () => convert(t, ids.bowmanId, ids.insertTypeId, landing),
      insertConversionRefusal.onBsc("Bowman"),
    );
    await expectRefusal(
      t,
      () => convert(t, futures, ids.insertTypeId, landing),
      insertConversionRefusal.hasChildren("Futures"),
    );
    await expectRefusal(
      t,
      () => convert(t, ids.goldId, ids.insertTypeId, landing),
      insertConversionRefusal.notEligible(),
    );
  });

  test("target guards: other brand, not an Insert type (by role, never name), gone", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "Red Ink", [RED_INK]);
    // A type NAMED "Insert" with no NB role is not an Insert type.
    const named = await insertRow(t, { level: "variantType", value: "Insert", parentId: ids.chromeId });
    const landing = { kind: "newInsert" as const };
    await expectRefusal(
      t,
      () => convert(t, row, ids.toppsInsertTypeId, landing),
      insertConversionRefusal.otherBrand("Topps", "Bowman"),
    );
    await expectRefusal(
      t,
      () => convert(t, row, ids.parallelTypeId, landing),
      insertConversionRefusal.notInsertType("Parallel", "Bowman"),
    );
    await expectRefusal(
      t,
      () => convert(t, row, named, landing),
      insertConversionRefusal.notInsertType("Insert", "Bowman Chrome"),
    );
    await expectRefusal(
      t,
      () => convert(t, row, ids.autosId, landing),
      insertConversionRefusal.insertTypeGone(),
    );
  });

  test("the link-taken rule reaches the parallels under the inserts, in every landing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK]);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.goldId, {
        platformData: { bsc: { b0: "aa-autos-gold" }, sportlots: { s0: RED_INK.id } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    const reason = insertConversionRefusal.linkTaken(
      "All-America Game Autos Gold",
      "Bowman",
      "All-America Game Autos Red Ink",
    );
    for (const landing of [
      { kind: "newInsert" as const },
      { kind: "joinInsert" as const, insertId: ids.autosId },
      { kind: "newParallel" as const, insertId: ids.autosId },
      { kind: "joinParallel" as const, parallelId: ids.goldId },
      { kind: "newInsertNamed" as const, name: "Something Else" },
    ]) {
      await expectRefusal(t, () => convert(t, row, ids.insertTypeId, landing), reason);
    }
  });

  test("the link-taken rule on an insert itself", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "All-America Game Autos Red Ink", [RED_INK]);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.autosId, {
        platformData: { bsc: { b0: "aa-autos" }, sportlots: { s0: RED_INK.id } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
      });
    });
    await expectRefusal(
      t,
      () => convert(t, row, ids.insertTypeId, { kind: "newInsert" }),
      insertConversionRefusal.linkTaken(
        "All-America Game Autos",
        "Bowman",
        "All-America Game Autos Red Ink",
      ),
    );
  });

  test("an open checklist review on the source, or on the row it would join", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "Red Ink", [RED_INK]);
    const review = (selectorOptionId: RowId) =>
      t.run(async (ctx) =>
        ctx.db.insert("checklistCandidates", {
          selectorOptionId,
          batchId: "batch-neo306",
          createdByUserId: "another_admin",
          cardNumber: "1",
          cardName: "Card 1",
          platformData: {},
          bucket: "matched",
          stem: "1",
          status: "ready",
          lastUpdated: SENTINEL,
        }),
      );
    const reviewId = await review(ids.goldId);
    await expectRefusal(
      t,
      () => convert(t, row, ids.insertTypeId, { kind: "joinParallel", parallelId: ids.goldId }),
      insertConversionRefusal.reviewOpen("Gold"),
    );
    await t.run(async (ctx) => ctx.db.delete(reviewId));
    await review(row);
    await expectRefusal(
      t,
      () => convert(t, row, ids.insertTypeId, { kind: "newInsert" }),
      insertConversionRefusal.reviewOpen("Red Ink"),
    );
  });

  test("names: the set's own name, an insert's name, a taken parallel, the whole typed name, already there", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const bowmanRow = await slRow(t, ids.parallelTypeId, "Bowman SL", [
      { id: "SL-BOWMAN", label: "Bowman" },
    ]);
    await expectRefusal(
      t,
      () => convert(t, bowmanRow, ids.insertTypeId, { kind: "newInsert" }),
      insertConversionRefusal.ownName("Bowman", "Bowman"),
    );
    const autosRow = await slRow(t, ids.parallelTypeId, "AA Autos", [
      { id: "SL-AA-AUTOS", label: "Bowman All-America Game Autos" },
    ]);
    await expectRefusal(
      t,
      () => convert(t, autosRow, ids.insertTypeId, { kind: "newInsert" }),
      insertConversionRefusal.insertNameTaken("Bowman", "All-America Game Autos"),
    );
    await expectRefusal(
      t,
      () => convert(t, autosRow, ids.insertTypeId, { kind: "newParallel", insertId: ids.autosId }),
      insertConversionRefusal.insertOwnName("Bowman All-America Game Autos", "All-America Game Autos"),
    );
    const goldRow = await slRow(t, ids.parallelTypeId, "AA Gold", [
      { id: "SL-AA-GOLD", label: "All-America Game Autos Gold" },
    ]);
    await expectRefusal(
      t,
      () => convert(t, goldRow, ids.insertTypeId, { kind: "newParallel", insertId: ids.autosId }),
      insertConversionRefusal.parallelNameTaken("All-America Game Autos", "Gold"),
    );
    await expectRefusal(
      t,
      () =>
        convert(t, goldRow, ids.insertTypeId, {
          kind: "newInsertNamed",
          name: "All-America Game Autos Gold",
        }),
      insertConversionRefusal.wholeName("All-America Game Autos Gold"),
    );
    const already = await slRow(t, ids.insertTypeId, "Stars", [{ id: "SL-STARS", label: "Stars" }]);
    await expectRefusal(
      t,
      () => convert(t, already, ids.insertTypeId, { kind: "newInsert" }),
      insertConversionRefusal.alreadyThere("Stars", "Bowman"),
    );
    await expectRefusal(
      t,
      () => convert(t, already, ids.insertTypeId, { kind: "joinInsert", insertId: already }),
      insertConversionRefusal.self("Stars"),
    );
  });

  test("a destination that moved is refused; a parallel under another type's insert too", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "Red Ink", [RED_INK]);
    const elsewhere = await insertRow(t, {
      level: "insert",
      value: "Elsewhere",
      parentId: ids.toppsInsertTypeId,
    });
    const strayParallel = await insertRow(t, { level: "parallel", value: "Blue", parentId: elsewhere });
    await expectRefusal(
      t,
      () => convert(t, row, ids.insertTypeId, { kind: "joinInsert", insertId: elsewhere }),
      insertConversionRefusal.insertGone(),
    );
    await expectRefusal(
      t,
      () => convert(t, row, ids.insertTypeId, { kind: "joinParallel", parallelId: strayParallel }),
      insertConversionRefusal.parallelGone(),
    );
  });

  test("more cards than one move can carry is refused before anything is written", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "Red Ink", [RED_INK]);
    await addCards(
      t,
      row,
      Array.from({ length: MAX_CARDS_PER_MOVE + 1 }, (_, i) => ({ n: String(i) })),
    );
    await expectRefusal(
      t,
      () => convert(t, row, ids.insertTypeId, { kind: "newInsert" }),
      insertConversionRefusal.tooManyCards("Red Ink", MAX_CARDS_PER_MOVE),
    );
  });

  test("more than MAX_INSERT_TREE_ROWS rows under the target Insert type: the read is refused, not judged partially", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = await slRow(t, ids.parallelTypeId, "Red Ink", [RED_INK]);

    // One row over the bound, inserted directly (bypassing the mutation) so
    // the fixture cost is one bulk write rather than MAX_INSERT_TREE_ROWS+1
    // convert() calls. Every filler row is childless and link-less: nothing
    // about ITS shape matters, only that the read stops counting.
    await t.run(async (ctx) => {
      const fillerIds: RowId[] = [];
      for (let i = 0; i < MAX_INSERT_TREE_ROWS + 1; i++) {
        fillerIds.push(
          await ctx.db.insert("selectorOptions", {
            level: "insert",
            value: `Filler ${i}`,
            parentId: ids.insertTypeId,
            platformData: {},
            children: [],
            lastUpdated: SENTINEL,
          }),
        );
      }
      const type = await ctx.db.get(ids.insertTypeId);
      await ctx.db.patch(ids.insertTypeId, {
        children: [...(type?.children ?? []), ...fillerIds],
      });
    });

    // The dialog's own read says so and offers no landing under this set.
    const detail = await t
      .withIdentity(ADMIN)
      .query(api.setInsertConversion.getMakeInsertTargetDetail, {
        rowId: row,
        targetSetId: ids.bowmanId,
      });
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.truncated).toBe(true);
      expect(detail.holdsLinkReason).toBe(insertConversionRefusal.tooManyRows("Bowman"));
    }

    // The mutation refuses the same way rather than risking a second SL id
    // landing on a row the read never reached — fail closed, not partial.
    const before = await t.run(async (ctx) => (await ctx.db.get(ids.insertTypeId))?.children?.length);
    await expect(
      convert(t, row, ids.insertTypeId, { kind: "newInsert" }),
    ).rejects.toThrow(insertConversionRefusal.tooManyRows("Bowman"));
    const after = await t.run(async (ctx) => (await ctx.db.get(ids.insertTypeId))?.children?.length);
    expect(after).toBe(before);
    expect(await get(t, row)).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Round trip
// ───────────────────────────────────────────────────────────────────────────

describe("set → parallel of an insert → set", () => {
  test("id and label survive every step, and the id stays covered", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const link = { id: "SL-AA-RED", label: "Bowman All-America Game Autos Red Ink" };
    const { setId, baseId } = await slSet(t, ids.brandId, "Bowman All-America Game Autos Red Ink", [
      link,
    ]);
    const [c1] = await addCards(t, baseId, [{ n: "AA-1", sl: { ref: "#AA-1", src: "s0" } }]);

    const made = await convert(t, setId, ids.insertTypeId, {
      kind: "newParallel",
      insertId: ids.autosId,
    });
    const parallelId = made.path[3]._id;
    expect(made.landedValue).toBe("Red Ink");
    expect(await covered(t, ids.brandId)).toContain(link.id);

    const back = await t
      .withIdentity(ADMIN)
      .mutation(api.setParallelConversion.promoteParallelToSet, {
        parallelId,
        slSlotKey: "s0",
      });
    expect(back).toMatchObject({
      setValue: "Bowman All-America Game Autos Red Ink",
      created: true,
      parallelKept: false,
    });
    const base = (await get(t, back.baseId))!;
    expect(base.platformData).toEqual({ sportlots: { s0: link.id } });
    expect(base.platformLabels).toEqual({ sportlots: { s0: link.label } });
    expect((await card(t, c1))!).toMatchObject({
      selectorOptionId: back.baseId,
      platformData: { sportlots: { ref: "#AA-1", src: "s0" } },
    });
    expect(await get(t, parallelId)).toBeNull();
    expect(await childrenAt(t, "parallel", ids.autosId)).toHaveLength(1); // Gold only
    expect(await covered(t, ids.brandId)).toContain(link.id);

    // …and it can go again: the promoted set is S1 once more.
    const again = await convert(t, back.setId, ids.insertTypeId, {
      kind: "newParallel",
      insertId: ids.autosId,
    });
    expect(again.landedValue).toBe("Red Ink");
    expect(await covered(t, ids.brandId)).toContain(link.id);
  });
});
