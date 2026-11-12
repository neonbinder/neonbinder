/**
 * NEO-496 — the set's checklist and its variant TYPES: Sync Variant Types
 * adds the kinds a checklist calls for (D16), and the Map Base Set save
 * writes the Base's sections (D7, Q4).
 *
 * Fixture copied from `fetchRawOptions.checklist.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { linksForRow, setRowChecklistSections } from "./lib/publishedChecklistSections";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_vt_checklist_496", role: "admin" };
const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;
type SO = Id<"selectorOptions">;

const outgoing: string[] = [];

beforeEach(() => {
  outgoing.length = 0;
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL | Request) => {
      outgoing.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A hand-made set (no marketplace ids anywhere) with the variant types named. */
async function seed(t: T, withTypes: string[] = []) {
  return t.run(async (ctx) => {
    const node = async (level: string, value: string, parentId?: SO): Promise<SO> => {
      const id = await ctx.db.insert("selectorOptions", {
        level: level as never,
        value,
        ...(parentId ? { parentId } : {}),
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      });
      if (parentId) {
        const parent = await ctx.db.get(parentId);
        await ctx.db.patch(parentId, { children: [...(parent?.children ?? []), id] });
      }
      return id;
    };
    const sport = await node("sport", "Baseball");
    const year = await node("year", "2025", sport);
    const brand = await node("manufacturer", "Panini", year);
    const setId = await node("setName", "Donruss", brand);
    const types: Record<string, SO> = {};
    for (const title of withTypes) types[title] = await node("variantType", title, setId);
    return { setId, types };
  });
}

async function upload(t: T, setId: SO, names: string[]) {
  const who = t.withIdentity(ADMIN);
  const { checklistId } = await who.mutation(api.publishedChecklists.start, {
    setId,
    fileName: "donruss.csv",
    format: "csv",
  });
  await who.mutation(api.publishedChecklists.addSections, {
    checklistId,
    firstOrdinal: 0,
    sections: names.map((name, i) => ({
      name,
      rows: [{ number: `${i + 1}`, players: [`Player ${i + 1}`], teams: ["Team"] }],
    })),
  });
  await who.mutation(api.publishedChecklists.finish, {
    checklistId,
    sectionCount: names.length,
    rowCount: names.length,
  });
  return checklistId;
}

const link = (t: T, rowId: SO, setId: SO, keys: string[]) =>
  t.run((ctx) => setRowChecklistSections(ctx, { rowId, setId, keys, userId: ADMIN.subject }));

const syncVariantTypes = (t: T, setId: SO) =>
  t.withIdentity(ADMIN).action(api.selectorOptions.fetchAggregatedOptions, {
    level: "variantType",
    parentId: setId,
    parentFilters: { sport: "Baseball", year: "2025", manufacturer: "Panini", setName: "Donruss" },
  });

async function typeTitles(t: T, setId: SO): Promise<string[]> {
  return t.run(async (ctx) =>
    (
      await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) => q.eq("level", "variantType").eq("parentId", setId))
        .collect()
    )
      .map((r) => r.value)
      .sort(),
  );
}

const keysOf = (t: T, rowId: SO) =>
  t.run(async (ctx) => (await linksForRow(ctx.db, rowId)).map((l) => l.sectionKey).sort());

const saveBase = (t: T, baseId: SO, checklistSectionKeys?: string[]) =>
  t.withIdentity(ADMIN).mutation(api.selectorOptions.setVariantTypePlatformData, {
    variantTypeId: baseId,
    platformData: {},
    ...(checklistSectionKeys !== undefined ? { checklistSectionKeys } : {}),
  });

describe("Sync Variant Types from the set's checklist (NEO-496 D16)", () => {
  test("no marketplace ids, no types: Base, Inserts and Parallels come from the checklist", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seed(t);
    await upload(t, setId, ["Base", "Base Red", "Ballpark Stars", "Ballpark Stars Signatures"]);

    const res = await syncVariantTypes(t, setId);

    expect(res.success).toBe(true);
    expect(res.optionsCount).toBe(3);
    expect(res.message).toBe("Added 3 variant types from your checklist.");
    expect(outgoing).toEqual([]);
    expect(await typeTitles(t, setId)).toEqual(["Base", "Inserts", "Parallels"]);

    // Again: every kind is there, nothing is added twice.
    await syncVariantTypes(t, setId);
    expect(await typeTitles(t, setId)).toEqual(["Base", "Inserts", "Parallels"]);
  });

  test("a kind the set already has by its word (singular or plural) is skipped", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seed(t, ["Base", "Insert"]);
    await upload(t, setId, ["Base", "Base Red", "Ballpark Stars"]);

    const res = await syncVariantTypes(t, setId);

    expect(res.optionsCount).toBe(1);
    expect(await typeTitles(t, setId)).toEqual(["Base", "Insert", "Parallels"]);
  });

  test("a checklist with no base-children adds no Parallels; no base section adds no Base", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seed(t);
    await upload(t, setId, ["Ballpark Stars", "Rated Rookies"]);

    await syncVariantTypes(t, setId);

    expect(await typeTitles(t, setId)).toEqual(["Inserts"]);
  });

  test("no checklist: the plain no-ids skip, nothing added", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seed(t);

    const res = await syncVariantTypes(t, setId);

    expect(res.success).toBe(true);
    expect(res.optionsCount).toBe(0);
    expect(await typeTitles(t, setId)).toEqual([]);
  });
});

describe("Map Base Set saves the Base's checklist sections (NEO-496 D7, Q4)", () => {
  test("present keys replace the Base's links; absent leaves them; [] clears", async () => {
    const t = convexTest(schema, modules);
    const { setId, types } = await seed(t, ["Base"]);
    await upload(t, setId, ["Base", "Base Rated Prospects", "Base Red"]);
    const baseId = types["Base"];

    await saveBase(t, baseId, ["Base", "base rated prospects"]);
    expect(await keysOf(t, baseId)).toEqual(["base", "base rated prospects"]);

    await saveBase(t, baseId);
    expect(await keysOf(t, baseId)).toEqual(["base", "base rated prospects"]);

    await saveBase(t, baseId, ["base"]);
    expect(await keysOf(t, baseId)).toEqual(["base"]);

    await saveBase(t, baseId, []);
    expect(await keysOf(t, baseId)).toEqual([]);
  });

  test("a key the checklist does not hold is refused and the links stand", async () => {
    const t = convexTest(schema, modules);
    const { setId, types } = await seed(t, ["Base"]);
    await upload(t, setId, ["Base"]);
    const baseId = types["Base"];
    await saveBase(t, baseId, ["base"]);

    await expect(saveBase(t, baseId, ["base", "not in the file"])).rejects.toThrow();
    expect(await keysOf(t, baseId)).toEqual(["base"]);
  });
});
