/**
 * NEO-496 (D7) — `fetchRawOptions` carries the set's stored checklist into
 * the Inserts / Parallels sync, including on the FIRST sync and with no
 * marketplace ids at all (a checklist alone is a source, so Reconcile opens).
 *
 * `rowLinks` is pinned here end to end: every row under the type being
 * synced that links a section, and at the Base (Map Base Set) the Base row
 * itself, so the client can echo each row's full key set (rule 5).
 * Matching details live in `setReconciliation.checklistSections.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { NO_MARKETPLACE_IDS_MESSAGE } from "./marketplaceResolvability";
import { setRowChecklistSections } from "./lib/publishedChecklistSections";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_raw_checklist_496", role: "admin" };
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

/** A hand-made set (no marketplace ids anywhere) with Base and Parallel types. */
async function seed(t: T) {
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
    const baseId = await node("variantType", "Base", setId);
    const parallelTypeId = await node("variantType", "Parallel", setId);
    const insertTypeId = await node("variantType", "Insert", setId);
    const redId = await node("insert", "Red", parallelTypeId);
    return { setId, baseId, parallelTypeId, insertTypeId, redId };
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
    // Every section's one card is #1, as a run prints its base's numbers: the
    // classifier reads the stored numbers now, and distinct numbers after the
    // base's ("2" after "1") would make a section a subset of the base.
    sections: names.map((name, i) => ({
      name,
      rows: [{ number: "1", players: [`Player ${i + 1}`], teams: ["Team"] }],
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

const fetchRaw = (t: T, parentId: SO) =>
  t.withIdentity(ADMIN).action(api.setReconciliation.fetchRawOptions, {
    level: "insert",
    parentId,
  });

const SECTIONS = ["Base", "Base Red", "Base Blue", "Ballpark Stars"];

describe("fetchRawOptions — the set's checklist (NEO-496 D7)", () => {
  test("no marketplace ids, first sync of Parallels: no marketplace asked, the checklist comes back", async () => {
    const t = convexTest(schema, modules);
    const { setId, baseId, parallelTypeId } = await seed(t);
    const checklistId = await upload(t, setId, SECTIONS);
    await link(t, baseId, setId, ["base"]);

    const res = await fetchRaw(t, parallelTypeId);

    expect(outgoing).toEqual([]);
    expect(res.success).toBe(true);
    expect(res.skippedSides.slice().sort()).toEqual(["bsc", "sportlots"]);
    expect(res.message).toBe(NO_MARKETPLACE_IDS_MESSAGE);
    expect(res.checklist?.checklistId).toBe(checklistId);
    expect(res.checklist?.baseSectionNames).toEqual(["Base"]);
    // The Base's section is linked, so it is not offered again.
    expect(res.checklist?.sections.map((s) => [s.sectionKey, s.kind])).toEqual([
      ["base red", "base-child"],
      ["base blue", "base-child"],
      ["ballpark stars", "other"],
    ]);
  });

  test("an existing parallel row is a target: 'Base Red' matches the row named Red", async () => {
    const t = convexTest(schema, modules);
    const { setId, baseId, parallelTypeId, redId } = await seed(t);
    await upload(t, setId, SECTIONS);
    await link(t, baseId, setId, ["base"]);

    const res = await fetchRaw(t, parallelTypeId);

    expect(res.checklist?.matches).toEqual([
      { sectionKey: "base red", target: { kind: "row", rowId: redId }, confidence: 1 },
    ]);
    expect(res.checklist?.unmatchedSectionKeys).toEqual(["base blue"]);
    expect(res.checklist?.rowLinks).toEqual([]);
  });

  test("rowLinks: a sibling's links come back in full, a section no longer in the checklist included", async () => {
    const t = convexTest(schema, modules);
    const { setId, parallelTypeId, redId } = await seed(t);
    await upload(t, setId, ["Base", "Base Red", "Red Wave"]);
    await link(t, redId, setId, ["base red", "red wave"]);
    // Replace the checklist with one that no longer holds "Red Wave".
    await upload(t, setId, ["Base", "Base Red"]);

    const res = await fetchRaw(t, parallelTypeId);

    expect(res.checklist?.rowLinks).toEqual([
      {
        rowId: redId,
        sections: [
          { sectionKey: "base red", name: "Base Red", rowCount: 1 },
          { sectionKey: "red wave", name: "red wave" },
        ],
      },
    ]);
    // A linked section is not offered again.
    expect(res.checklist?.sections.map((s) => s.sectionKey)).toEqual(["base"]);
  });

  test("Map Base Set (the Base type): the Base row's own links are in rowLinks, nothing auto-matched", async () => {
    const t = convexTest(schema, modules);
    const { setId, baseId } = await seed(t);
    await upload(t, setId, SECTIONS);
    await link(t, baseId, setId, ["base", "base red"]);

    const res = await fetchRaw(t, baseId);

    expect(res.checklist?.rowLinks).toEqual([
      {
        rowId: baseId,
        sections: [
          { sectionKey: "base", name: "Base", rowCount: 1 },
          { sectionKey: "base red", name: "Base Red", rowCount: 1 },
        ],
      },
    ]);
    expect(res.checklist?.matches).toEqual([]);
    expect(res.checklist?.unmatchedSectionKeys).toEqual([]);
  });

  test("no checklist on the set: no `checklist` field, the skip is unchanged", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t);

    const res = await fetchRaw(t, insertTypeId);

    expect(res.checklist).toBeUndefined();
    expect(res.success).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("a parallel-level sync (parent is an insert row) carries no checklist", async () => {
    const t = convexTest(schema, modules);
    const { setId, redId } = await seed(t);
    await upload(t, setId, SECTIONS);

    const res = await t.withIdentity(ADMIN).action(api.setReconciliation.fetchRawOptions, {
      level: "parallel",
      parentId: redId,
    });

    expect(res.checklist).toBeUndefined();
  });
});
