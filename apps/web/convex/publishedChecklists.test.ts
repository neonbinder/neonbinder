/**
 * NEO-496 — a set's publisher checklist: upload lifecycle, the server's
 * re-checks (D5), replace / remove, clean-up, and the reads (D9).
 *
 * Every public query has a reader test here: convex-test validates `returns`,
 * and a green typecheck does not prove a returns validator.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getConvexSize } from "convex/values";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  ABANDON_MS,
  CHUNK_ROW_BYTES,
  LEAF_READ_MAX_BYTES,
  MAX_CHECKLIST_BYTES,
  MAX_CHECKLIST_ROWS,
  MAX_SECTIONS,
  sectionKeyOf,
  setRowChecklistSections,
} from "./lib/publishedChecklistSections";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin_a", role: "admin" };
const ADMIN_B = { subject: "admin_b", role: "admin" };
const MEMBER = { subject: "member", role: "member" };
const NOW = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;
type SO = Id<"selectorOptions">;
type Row = {
  number: string;
  players: string[];
  teams: string[];
  noNumber?: boolean;
  noTeam?: boolean;
  subset?: string;
};
type Section = { name: string; group?: string; rows: Row[] };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Drain every scheduled purge / expiry before the test ends. */
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

const row = (number: string, player = `Player ${number}`, team = "Team"): Row => ({
  number,
  players: [player],
  teams: [team],
});
const rows = (n: number, prefix = ""): Row[] =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${i + 1}`));

/** A legal row of ~10 KB: 20 players and 8 teams of 120 three-byte characters. */
const heavyRow = (number: string): Row => ({
  number,
  players: Array.from({ length: 20 }, (_, i) => `${"€".repeat(119)}${String.fromCharCode(65 + i)}`),
  teams: Array.from({ length: 8 }, (_, i) => `${"€".repeat(119)}${String.fromCharCode(97 + i)}`),
});

async function seedTree(t: T) {
  return t.run(async (ctx) => {
    const node = async (level: string, value: string, parentId?: SO): Promise<SO> =>
      ctx.db.insert("selectorOptions", {
        level: level as never,
        value,
        ...(parentId ? { parentId } : {}),
        platformData: {},
        children: [],
        lastUpdated: NOW,
      });
    const sport = await node("sport", "Baseball");
    const year = await node("year", "2026", sport);
    const brand = await node("manufacturer", "Topps", year);
    const set = await node("setName", "Topps Chrome", brand);
    const otherSet = await node("setName", "Topps Finest", brand);
    const baseVt = await node("variantType", "Base", set);
    const insertVt = await node("variantType", "Insert", set);
    const insA = await node("insert", "Future Stars", insertVt);
    const parA = await node("parallel", "Refractor", insA);
    const otherVt = await node("variantType", "Base", otherSet);
    return { sport, year, brand, set, otherSet, baseVt, insertVt, insA, parA, otherVt };
  });
}

async function upload(
  t: T,
  setId: SO,
  sections: Section[],
  as = ADMIN,
  fileName = "checklist.csv",
): Promise<Id<"publishedChecklists">> {
  const who = t.withIdentity(as);
  const { checklistId } = await who.mutation(api.publishedChecklists.start, {
    setId,
    fileName,
    format: "csv",
  });
  // Whole sections, at most 100 sections and 2,000 rows a batch, like the client.
  let ordinal = 0;
  while (ordinal < sections.length) {
    const batch: Section[] = [];
    let batchRows = 0;
    while (
      ordinal + batch.length < sections.length &&
      batch.length < 100 &&
      (batch.length === 0 || batchRows + sections[ordinal + batch.length].rows.length <= 2000)
    ) {
      batchRows += sections[ordinal + batch.length].rows.length;
      batch.push(sections[ordinal + batch.length]);
    }
    await who.mutation(api.publishedChecklists.addSections, {
      checklistId,
      firstOrdinal: ordinal,
      sections: batch,
    });
    ordinal += batch.length;
  }
  await who.mutation(api.publishedChecklists.finish, {
    checklistId,
    sectionCount: sections.length,
    rowCount: sections.reduce((n, s) => n + s.rows.length, 0),
  });
  return checklistId;
}

const link = (t: T, rowId: SO, setId: SO, keys: string[]) =>
  t.run((ctx) => setRowChecklistSections(ctx, { rowId, setId, keys, userId: "admin_a" }));

const headers = (t: T) =>
  t.run(async (ctx) => await ctx.db.query("publishedChecklists").collect());
const allLinks = (t: T) =>
  t.run(async (ctx) => await ctx.db.query("publishedChecklistLinks").collect());
const tableSizes = (t: T) =>
  t.run(async (ctx) => ({
    headers: (await ctx.db.query("publishedChecklists").collect()).length,
    sections: (await ctx.db.query("publishedChecklistSections").collect()).length,
    chunks: (await ctx.db.query("publishedChecklistChunks").collect()).length,
  }));

// ───────────────────────────────────────────────────────────────────────────

describe("upload: start → addSections → finish", () => {
  test("stores sections in file order, rows re-checked, counters and number range set", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const checklistId = await upload(t, f.set, [
      {
        name: "  Base   Cards ",
        rows: [
          { number: "NNO", players: ["Lead Card"], teams: ["Team"] },
          { number: "1", players: [" Shohei Ohtani "], teams: ["No Team"], subset: "Base" },
          row("2"),
          { number: "", players: ["Tail"], teams: [] },
        ],
      },
      { name: "Future Stars", group: " Inserts ", rows: rows(3, "FS-") },
    ]);

    const stored = await t.run(async (ctx) => {
      const header = await ctx.db.get(checklistId);
      const sections = await ctx.db
        .query("publishedChecklistSections")
        .withIndex("by_checklist_and_ordinal", (q) => q.eq("checklistId", checklistId))
        .collect();
      const chunks = await ctx.db
        .query("publishedChecklistChunks")
        .withIndex("by_section_and_seq", (q) => q.eq("sectionId", sections[0]._id))
        .collect();
      return { header, sections, chunks };
    });
    expect(stored.header).toMatchObject({
      status: "ready",
      fileName: "checklist.csv",
      sectionCount: 2,
      rowCount: 7,
      createdByUserId: "admin_a",
    });
    expect(stored.sections.map((s) => [s.ordinal, s.name, s.sectionKey, s.group])).toEqual([
      [0, "Base   Cards", "base cards", undefined],
      [1, "Future Stars", "future stars", "Inserts"],
    ]);
    // First / last NUMBERED rows only: the NNO and the blank number are skipped.
    expect(stored.sections[0]).toMatchObject({ firstNumber: "1", lastNumber: "2", rowCount: 4 });
    expect(stored.sections[1]).toMatchObject({ firstNumber: "FS-1", lastNumber: "FS-3" });
    expect(stored.chunks).toHaveLength(1);
    // The re-check ran: trimmed, No Team folded to a flag, NNO flagged, subset dropped.
    expect(stored.chunks[0].rows).toEqual([
      { number: "NNO", players: ["Lead Card"], teams: ["Team"], noNumber: true },
      { number: "1", players: ["Shohei Ohtani"], teams: [], noTeam: true },
      { number: "2", players: ["Player 2"], teams: ["Team"] },
      { number: "", players: ["Tail"], teams: [], noNumber: true },
    ]);
    const bytes = stored.chunks[0].rows.reduce((n, r) => n + getConvexSize(r), 0);
    expect(stored.sections[0].byteSize).toBe(bytes);
    await settle(t);
  });

  test("a 3-byte-character row is measured in bytes, not characters, and chunked past 256 KiB", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const heavy = Array.from({ length: 40 }, (_, i) => heavyRow(String(i + 1)));
    const one = getConvexSize(heavy[0]);
    // 28 names of 120 characters is 3,360 characters; in three-byte UTF-8 it
    // is three times that.
    expect(one).toBeGreaterThan(3 * 28 * 119);
    const checklistId = await upload(t, f.set, [{ name: "Heavy", rows: heavy }]);
    const { section, chunks } = await t.run(async (ctx) => {
      const section = (await ctx.db
        .query("publishedChecklistSections")
        .withIndex("by_checklist_and_ordinal", (q) => q.eq("checklistId", checklistId))
        .first())!;
      const chunks = await ctx.db
        .query("publishedChecklistChunks")
        .withIndex("by_section_and_seq", (q) => q.eq("sectionId", section._id))
        .collect();
      return { section, chunks };
    });
    expect(section.byteSize).toBe(heavy.reduce((n, r) => n + getConvexSize(r), 0));
    expect(chunks.length).toBeGreaterThan(1);
    expect(section.chunkCount).toBe(chunks.length);
    let next = 0;
    for (const [seq, chunk] of chunks.entries()) {
      expect(chunk.seq).toBe(seq);
      expect(chunk.firstRow).toBe(next);
      expect(chunk.rows.reduce((n, r) => n + getConvexSize(r), 0)).toBeLessThanOrEqual(
        CHUNK_ROW_BYTES,
      );
      next += chunk.rows.length;
    }
    expect(next).toBe(40);
    await settle(t);
  });

  test("batches append in order; a replayed or skipped batch is refused", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const who = t.withIdentity(ADMIN);
    const { checklistId } = await who.mutation(api.publishedChecklists.start, {
      setId: f.set,
      fileName: "c.csv",
      format: "csv",
    });
    const first = { checklistId, firstOrdinal: 0, sections: [{ name: "A", rows: rows(2) }] };
    expect(await who.mutation(api.publishedChecklists.addSections, first)).toMatchObject({
      sectionCount: 1,
      rowCount: 2,
    });
    await expect(who.mutation(api.publishedChecklists.addSections, first)).rejects.toThrow(
      /starts at section 1, but 1 sections have arrived/,
    );
    await expect(
      who.mutation(api.publishedChecklists.addSections, {
        checklistId,
        firstOrdinal: 2,
        sections: [{ name: "C", rows: rows(1) }],
      }),
    ).rejects.toThrow(/starts at section 3/);
    expect(
      await who.mutation(api.publishedChecklists.addSections, {
        checklistId,
        firstOrdinal: 1,
        sections: [{ name: "B", rows: rows(1) }],
      }),
    ).toMatchObject({ sectionCount: 2, rowCount: 3 });
    await settle(t);
  });
});

describe("D5: every refusal writes nothing", () => {
  async function started(t: T) {
    const f = await seedTree(t);
    const who = t.withIdentity(ADMIN);
    const { checklistId } = await who.mutation(api.publishedChecklists.start, {
      setId: f.set,
      fileName: "c.csv",
      format: "csv",
    });
    return { f, who, checklistId };
  }
  const send = (
    who: ReturnType<T["withIdentity"]>,
    checklistId: Id<"publishedChecklists">,
    sections: Section[],
    firstOrdinal = 0,
  ) => who.mutation(api.publishedChecklists.addSections, { checklistId, firstOrdinal, sections });

  test("start refuses a non-set row and a bad file name", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const who = t.withIdentity(ADMIN);
    for (const setId of [f.brand, f.baseVt, f.insA]) {
      await expect(
        who.mutation(api.publishedChecklists.start, { setId, fileName: "c.csv", format: "csv" }),
      ).rejects.toThrow(/only be added to a set/);
    }
    for (const [fileName, why] of [
      ["   ", /blank/],
      ["x".repeat(201), /over 200/],
      ["a\u0007.csv", /control character/],
    ] as const) {
      await expect(
        who.mutation(api.publishedChecklists.start, { setId: f.set, fileName, format: "pdf" }),
      ).rejects.toThrow(why);
    }
    expect(await headers(t)).toEqual([]);
  });

  test.each([
    ["an empty batch", [] as Section[], /at least one section/],
    [
      "more than 100 sections",
      Array.from({ length: 101 }, (_, i) => ({ name: `S${i}`, rows: rows(1) })),
      /at most 100 sections/,
    ],
    ["more than 2,000 rows", [{ name: "Big", rows: rows(2001) }], /at most 2000 rows/],
    ["a blank name", [{ name: "  ", rows: rows(1) }], /Section 1's name is blank/],
    ["a 121-character name", [{ name: "x".repeat(121), rows: rows(1) }], /over 120 characters/],
    ["a control character", [{ name: "Base\u0000", rows: rows(1) }], /control character/],
    [
      "two names that fold to one key",
      [
        { name: "Future Stars", rows: rows(1) },
        { name: "future   STARS", rows: rows(1) },
      ],
      /Two sections are named “future   STARS”/,
    ],
    ["a section with no rows", [{ name: "Empty", rows: [] }], /“Empty” has no rows/],
    [
      "a group with a control character",
      [{ name: "Ok", group: "\u0001", rows: rows(1) }],
      /The group of section “Ok” has a control character/,
    ],
    [
      "a bad card number, named by its section",
      [{ name: "Future Stars", rows: [row("1"), row("1<script>")] }],
      /Row 2 of section “Future Stars” has a card number with characters/,
    ],
    [
      "a row that says No Team and names a team",
      [{ name: "Base", rows: [{ number: "1", players: ["A"], teams: ["No Team", "Cubs"] }] }],
      /Row 1 of section “Base” says No Team and names a team/,
    ],
    [
      "a section over 2 MiB",
      [{ name: "Heavy", rows: Array.from({ length: 250 }, (_, i) => heavyRow(String(i))) }],
      /“Heavy” is too large to store/,
    ],
    [
      "a batch over 4 MiB",
      [0, 1, 2].map((s) => ({
        name: `Heavy ${s}`,
        rows: Array.from({ length: 190 }, (_, i) => heavyRow(String(i))),
      })),
      /This batch is too large/,
    ],
  ])("addSections refuses %s", async (_label, sections, why) => {
    const t = convexTest(schema, modules);
    const { who, checklistId } = await started(t);
    await expect(send(who, checklistId, sections)).rejects.toThrow(why);
    expect(await tableSizes(t)).toEqual({ headers: 1, sections: 0, chunks: 0 });
    await settle(t);
  });

  test("a name already sent in an earlier batch is refused", async () => {
    const t = convexTest(schema, modules);
    const { who, checklistId } = await started(t);
    await send(who, checklistId, [{ name: "Base", rows: rows(1) }]);
    await expect(send(who, checklistId, [{ name: " BASE ", rows: rows(1) }], 1)).rejects.toThrow(
      /Two sections are named “BASE”/,
    );
    await settle(t);
  });

  test("running totals: sections, rows and bytes", async () => {
    const t = convexTest(schema, modules);
    const { who, checklistId } = await started(t);
    // Totals are checked against the header, so the header is put at the cap.
    await t.run((ctx) => ctx.db.patch(checklistId, { sectionCount: MAX_SECTIONS }));
    await expect(send(who, checklistId, [{ name: "A", rows: rows(1) }], MAX_SECTIONS)).rejects.toThrow(
      /at most 1000 sections/,
    );
    await t.run((ctx) =>
      ctx.db.patch(checklistId, { sectionCount: 0, rowCount: MAX_CHECKLIST_ROWS - 1 }),
    );
    await expect(send(who, checklistId, [{ name: "A", rows: rows(2) }])).rejects.toThrow(
      /at most 50000 rows/,
    );
    await t.run((ctx) =>
      ctx.db.patch(checklistId, { rowCount: 0, byteSize: MAX_CHECKLIST_BYTES - 10 }),
    );
    await expect(send(who, checklistId, [{ name: "A", rows: rows(1) }])).rejects.toThrow(
      /checklist is too large to store/,
    );
    expect(await tableSizes(t)).toEqual({ headers: 1, sections: 0, chunks: 0 });
    await settle(t);
  });

  test("only the uploader may send batches or finish, and only while uploading", async () => {
    const t = convexTest(schema, modules);
    const { who, checklistId } = await started(t);
    const other = t.withIdentity(ADMIN_B);
    await expect(send(other, checklistId, [{ name: "A", rows: rows(1) }])).rejects.toThrow(
      /upload was not found/,
    );
    await send(who, checklistId, [{ name: "A", rows: rows(1) }]);
    await expect(
      other.mutation(api.publishedChecklists.finish, { checklistId, sectionCount: 1, rowCount: 1 }),
    ).rejects.toThrow(/upload was not found/);
    await who.mutation(api.publishedChecklists.finish, { checklistId, sectionCount: 1, rowCount: 1 });
    await expect(send(who, checklistId, [{ name: "B", rows: rows(1) }], 1)).rejects.toThrow(
      /already finished/,
    );
    await settle(t);
  });

  test("finish refuses a count mismatch and an empty upload", async () => {
    const t = convexTest(schema, modules);
    const { who, checklistId } = await started(t);
    await expect(
      who.mutation(api.publishedChecklists.finish, { checklistId, sectionCount: 0, rowCount: 0 }),
    ).rejects.toThrow(/no sections yet/);
    await send(who, checklistId, [{ name: "A", rows: rows(3) }]);
    await expect(
      who.mutation(api.publishedChecklists.finish, { checklistId, sectionCount: 2, rowCount: 3 }),
    ).rejects.toThrow(/upload is incomplete: 1 sections and 3 rows arrived, not 2 and 3/);
    await expect(
      who.mutation(api.publishedChecklists.finish, { checklistId, sectionCount: 1, rowCount: 2 }),
    ).rejects.toThrow(/upload is incomplete/);
    expect((await headers(t))[0].status).toBe("uploading");
    await settle(t);
  });
});

describe("replace and remove", () => {
  test("two finishes leave exactly one ready checklist, the last; the old one is purged", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const a = t.withIdentity(ADMIN);
    const b = t.withIdentity(ADMIN_B);
    const first = await a.mutation(api.publishedChecklists.start, {
      setId: f.set,
      fileName: "a.csv",
      format: "csv",
    });
    const second = await b.mutation(api.publishedChecklists.start, {
      setId: f.set,
      fileName: "b.xlsx",
      format: "xlsx",
    });
    // Another admin's start does not retire the first upload.
    expect((await headers(t)).map((h) => h.status)).toEqual(["uploading", "uploading"]);
    for (const [who, id] of [
      [a, first.checklistId],
      [b, second.checklistId],
    ] as const) {
      await who.mutation(api.publishedChecklists.addSections, {
        checklistId: id,
        firstOrdinal: 0,
        sections: [{ name: "Base", rows: rows(2) }],
      });
    }
    await a.mutation(api.publishedChecklists.finish, {
      checklistId: first.checklistId,
      sectionCount: 1,
      rowCount: 2,
    });
    await b.mutation(api.publishedChecklists.finish, {
      checklistId: second.checklistId,
      sectionCount: 1,
      rowCount: 2,
    });
    await settle(t);
    const left = await headers(t);
    expect(left.map((h) => [h._id, h.status])).toEqual([[second.checklistId, "ready"]]);
    expect(await tableSizes(t)).toEqual({ headers: 1, sections: 1, chunks: 1 });
    expect(await t.withIdentity(ADMIN).query(api.publishedChecklists.getForSet, { setId: f.set }))
      .toMatchObject({ checklistId: second.checklistId, fileName: "b.xlsx", format: "xlsx" });
  });

  test("start retires the caller's own unfinished upload for the set", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const who = t.withIdentity(ADMIN);
    const first = await who.mutation(api.publishedChecklists.start, {
      setId: f.set,
      fileName: "a.csv",
      format: "csv",
    });
    await who.mutation(api.publishedChecklists.start, {
      setId: f.set,
      fileName: "a.csv",
      format: "csv",
    });
    const byId = new Map((await headers(t)).map((h) => [h._id, h.status]));
    expect(byId.get(first.checklistId)).toBe("retired");
    expect([...byId.values()].sort()).toEqual(["retired", "uploading"]);
    // Draining runs the hour-later expiry too: the idle second upload goes as well.
    await settle(t);
    expect(await headers(t)).toEqual([]);
  });

  test("links survive a replace and a remove, and resolve against the current checklist", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    await upload(t, f.set, [
      { name: "Base", rows: rows(3) },
      { name: "Future Stars", rows: rows(2, "FS-") },
    ]);
    await link(t, f.insA, f.set, ["Future Stars"]);
    const before = await allLinks(t);

    // Replace: Future Stars is still there with new rows.
    await upload(t, f.set, [
      { name: "Base", rows: rows(3) },
      { name: "FUTURE STARS", rows: rows(4, "FS-") },
    ]);
    await settle(t);
    expect(await allLinks(t)).toEqual(before);
    const leaf = await t.query(internal.publishedChecklists.rowsForLeaf, {
      selectorOptionId: f.insA,
    });
    expect(leaf).toMatchObject({ kind: "rows", sections: [{ name: "FUTURE STARS", rowCount: 4 }] });

    // Replace without the section: the link resolves to nothing, and stays.
    await upload(t, f.set, [{ name: "Base", rows: rows(3) }]);
    await settle(t);
    expect(await allLinks(t)).toEqual(before);
    expect(
      await t.query(internal.publishedChecklists.rowsForLeaf, { selectorOptionId: f.insA }),
    ).toEqual({ kind: "none" });

    // Remove: nothing ready, links untouched.
    expect(
      await t.withIdentity(ADMIN).mutation(api.publishedChecklists.remove, { setId: f.set }),
    ).toEqual({ removed: true });
    expect(
      await t.withIdentity(ADMIN).mutation(api.publishedChecklists.remove, { setId: f.set }),
    ).toEqual({ removed: false });
    await settle(t);
    expect(await allLinks(t)).toEqual(before);
    expect(await tableSizes(t)).toEqual({ headers: 0, sections: 0, chunks: 0 });
    expect(
      await t.withIdentity(ADMIN).query(api.publishedChecklists.getForSet, { setId: f.set }),
    ).toBeNull();
  });
});

describe("clean-up", () => {
  test("expireUpload retires an idle upload, and reschedules for one still receiving batches", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const who = t.withIdentity(ADMIN);
    const { checklistId } = await who.mutation(api.publishedChecklists.start, {
      setId: f.set,
      fileName: "a.csv",
      format: "csv",
    });
    // Active 30 minutes in: the first expiry at +1 h must not retire it.
    vi.advanceTimersByTime(ABANDON_MS / 2);
    await who.mutation(api.publishedChecklists.addSections, {
      checklistId,
      firstOrdinal: 0,
      sections: [{ name: "A", rows: rows(1) }],
    });
    vi.setSystemTime(Date.now() + ABANDON_MS / 2 + 1);
    await t.mutation(internal.publishedChecklists.expireUpload, { checklistId });
    expect((await headers(t))[0].status).toBe("uploading");
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.name.includes("expireUpload") && job.state.kind === "pending",
      ),
    );
    expect(pending.length).toBeGreaterThan(0);

    // Idle a full hour since the batch: retired, then purged.
    vi.setSystemTime(Date.now() + ABANDON_MS);
    await t.mutation(internal.publishedChecklists.expireUpload, { checklistId });
    expect((await headers(t))[0].status).toBe("retired");
    await settle(t);
    expect(await tableSizes(t)).toEqual({ headers: 0, sections: 0, chunks: 0 });
  });

  test("expireUpload leaves a finished checklist alone", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const id = await upload(t, f.set, [{ name: "A", rows: rows(1) }]);
    vi.setSystemTime(Date.now() + 2 * ABANDON_MS);
    await t.mutation(internal.publishedChecklists.expireUpload, { checklistId: id });
    await settle(t);
    expect((await headers(t)).map((h) => h.status)).toEqual(["ready"]);
  });

  test("purge drains a multi-chunk checklist across runs, then picks the next retired one", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    // Two retired checklists written by hand: 30 chunks in one section (more
    // than one run's 24), and a small one.
    const ids = await t.run(async (ctx) => {
      const make = async (chunkCount: number) => {
        const id = await ctx.db.insert("publishedChecklists", {
          setId: f.set,
          status: "retired",
          fileName: "x.csv",
          format: "csv",
          createdByUserId: "admin_a",
          startedAt: NOW,
          lastActivityAt: NOW,
          retiredAt: NOW,
          sectionCount: 2,
          rowCount: chunkCount,
          byteSize: 10,
        });
        for (let s = 0; s < 2; s += 1) {
          const sectionId = await ctx.db.insert("publishedChecklistSections", {
            checklistId: id,
            ordinal: s,
            name: `S${s}`,
            sectionKey: `s${s}`,
            rowCount: s === 0 ? chunkCount : 0,
            byteSize: 1,
            chunkCount: s === 0 ? chunkCount : 0,
          });
          if (s !== 0) continue;
          for (let c = 0; c < chunkCount; c += 1) {
            await ctx.db.insert("publishedChecklistChunks", {
              checklistId: id,
              sectionId,
              seq: c,
              firstRow: c,
              rows: [{ number: String(c), players: [], teams: [] }],
            });
          }
        }
        return id;
      };
      return [await make(30), await make(2)];
    });

    // One run, by hand: 24 chunks gone, the section and header stay.
    await t.mutation(internal.publishedChecklists.purge, { checklistId: ids[0] });
    expect(await tableSizes(t)).toEqual({ headers: 2, sections: 4, chunks: 8 });

    await settle(t);
    expect(await tableSizes(t)).toEqual({ headers: 0, sections: 0, chunks: 0 });
  });

  test("purge with no target finds an abandoned upload, retires it and deletes it", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    await t.run((ctx) =>
      ctx.db.insert("publishedChecklists", {
        setId: f.set,
        status: "uploading",
        fileName: "x.csv",
        format: "csv",
        createdByUserId: "admin_a",
        startedAt: NOW,
        lastActivityAt: Date.now() - ABANDON_MS - 1,
        sectionCount: 0,
        rowCount: 0,
        byteSize: 0,
      }),
    );
    // A fresh upload is not abandoned.
    await t.withIdentity(ADMIN_B).mutation(api.publishedChecklists.start, {
      setId: f.set,
      fileName: "y.csv",
      format: "csv",
    });
    await t.mutation(internal.publishedChecklists.purge, {});
    const left = await headers(t);
    expect(left.map((h) => [h.fileName, h.status])).toEqual([["y.csv", "uploading"]]);
    await settle(t);
  });
});

describe("reads", () => {
  test("getForSet: null signed out, refused for a member, a projection for an admin", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const id = await upload(t, f.set, [{ name: "Base", rows: rows(3) }]);
    expect(await t.query(api.publishedChecklists.getForSet, { setId: f.set })).toBeNull();
    await expect(
      t.withIdentity(MEMBER).query(api.publishedChecklists.getForSet, { setId: f.set }),
    ).rejects.toThrow(/Admin access required/);
    const got = await t.withIdentity(ADMIN).query(api.publishedChecklists.getForSet, {
      setId: f.set,
    });
    expect(got).toEqual({
      checklistId: id,
      fileName: "checklist.csv",
      format: "csv",
      sectionCount: 1,
      rowCount: 3,
      byteSize: expect.any(Number),
      finishedAt: expect.any(Number),
    });
    expect(
      await t.withIdentity(ADMIN).query(api.publishedChecklists.getForSet, { setId: f.otherSet }),
    ).toBeNull();
    await settle(t);
  });

  test("listSections pages at most 100 in file order; signed out reads an empty page", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const id = await upload(
      t,
      f.set,
      Array.from({ length: 100 }, (_, i) => ({ name: `Section ${i}`, rows: rows(1) })),
    );
    const who = t.withIdentity(ADMIN);
    const { checklistId: id2 } = await who.mutation(api.publishedChecklists.start, {
      setId: f.otherSet,
      fileName: "o.csv",
      format: "csv",
    });
    await who.mutation(api.publishedChecklists.addSections, {
      checklistId: id2,
      firstOrdinal: 0,
      sections: [{ name: "Other", rows: rows(1) }],
    });
    // Another set's upload never shows. Page 40, then ask for 500 (capped at 100).
    const page1 = await who.query(api.publishedChecklists.listSections, {
      checklistId: id,
      paginationOpts: { numItems: 40, cursor: null },
    });
    expect(page1.page.map((s) => s.ordinal)).toEqual([...Array(40).keys()]);
    expect(page1.page[0]).toEqual({
      ordinal: 0,
      name: "Section 0",
      sectionKey: "section 0",
      rowCount: 1,
      byteSize: expect.any(Number),
      firstNumber: "1",
      lastNumber: "1",
    });
    const page2 = await who.query(api.publishedChecklists.listSections, {
      checklistId: id,
      paginationOpts: { numItems: 500, cursor: page1.continueCursor },
    });
    expect(page2.page.map((s) => s.ordinal)).toEqual([...Array(60).keys()].map((i) => i + 40));
    expect(
      await t.query(api.publishedChecklists.listSections, {
        checklistId: id,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).toEqual({ page: [], isDone: true, continueCursor: "" });
    await expect(
      t.withIdentity(MEMBER).query(api.publishedChecklists.listSections, {
        checklistId: id,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/Admin access required/);
    await settle(t);
  });

  test("leafChecklistSummary: none, rows and tooBig, without reading a row", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const who = t.withIdentity(ADMIN);
    const summary = (selectorOptionId: SO) =>
      who.query(api.publishedChecklists.leafChecklistSummary, { selectorOptionId });

    expect(await t.query(api.publishedChecklists.leafChecklistSummary, { selectorOptionId: f.insA }))
      .toBeNull();
    expect(await summary(f.insA)).toEqual({ kind: "none", linkedKeys: [] });
    expect(await summary(f.sport)).toEqual({ kind: "none", linkedKeys: [] });

    const id = await upload(t, f.set, [
      { name: "Base", rows: rows(3) },
      { name: "Base Rated Prospects", rows: rows(2, "RP-") },
    ]);
    await link(t, f.baseVt, f.set, ["Base Rated Prospects", "base"]);
    expect(await summary(f.baseVt)).toEqual({
      kind: "rows",
      checklistId: id,
      linkedKeys: ["base", "base rated prospects"],
      sections: [
        { sectionKey: "base", name: "Base", rowCount: 3 },
        { sectionKey: "base rated prospects", name: "Base Rated Prospects", rowCount: 2 },
      ],
      rowCount: 5,
      byteSize: expect.any(Number),
    });
    expect(await summary(f.insA)).toMatchObject({ kind: "rows", sections: [], rowCount: 0 });

    await t.run(async (ctx) => {
      const base = await ctx.db
        .query("publishedChecklistSections")
        .withIndex("by_checklist_and_key", (q) => q.eq("checklistId", id).eq("sectionKey", "base"))
        .unique();
      await ctx.db.patch(base!._id, { byteSize: LEAF_READ_MAX_BYTES });
    });
    expect(await summary(f.baseVt)).toMatchObject({ kind: "tooBig" });

    // Removed: the links are kept and still reported.
    await who.mutation(api.publishedChecklists.remove, { setId: f.set });
    expect(await summary(f.baseVt)).toEqual({
      kind: "none",
      linkedKeys: ["base", "base rated prospects"],
    });
    await settle(t);
  });

  test("sectionsForSet and linksForSet", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    expect(await t.query(internal.publishedChecklists.sectionsForSet, { setId: f.set })).toBeNull();
    const id = await upload(t, f.set, [
      { name: "Base", rows: rows(3) },
      { name: "Future Stars", group: "Inserts", rows: rows(2, "FS-") },
    ]);
    expect(await t.query(internal.publishedChecklists.sectionsForSet, { setId: f.set })).toEqual({
      checklistId: id,
      sections: [
        expect.objectContaining({ ordinal: 0, name: "Base", sectionKey: "base" }),
        expect.objectContaining({
          ordinal: 1,
          name: "Future Stars",
          sectionKey: "future stars",
          group: "Inserts",
          firstNumber: "FS-1",
          lastNumber: "FS-2",
        }),
      ],
    });
    await link(t, f.baseVt, f.set, ["Base"]);
    await link(t, f.insA, f.set, ["Future Stars"]);
    expect(await t.query(internal.publishedChecklists.linksForSet, { setId: f.set })).toEqual([
      { selectorOptionId: f.baseVt, sectionKey: "base" },
      { selectorOptionId: f.insA, sectionKey: "future stars" },
    ]);
    expect(await t.query(internal.publishedChecklists.linksForSet, { setId: f.otherSet })).toEqual(
      [],
    );
    await settle(t);
  });
});

describe("D9: rowsForLeaf", () => {
  const leaf = (t: T, selectorOptionId: SO) =>
    t.query(internal.publishedChecklists.rowsForLeaf, { selectorOptionId });

  test("none without a checklist, without links, and for a row outside any set", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    expect(await leaf(t, f.insA)).toEqual({ kind: "none" });
    await upload(t, f.set, [{ name: "Future Stars", rows: rows(2) }]);
    expect(await leaf(t, f.insA)).toEqual({ kind: "none" });
    expect(await leaf(t, f.sport)).toEqual({ kind: "none" });
    await settle(t);
  });

  test("returns only the leaf's OWN linked sections, in file order, chunks in order", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const heavy = Array.from({ length: 40 }, (_, i) => heavyRow(`H-${i + 1}`));
    const id = await upload(t, f.set, [
      { name: "Base", rows: rows(2) },
      { name: "Heavy", rows: heavy },
      { name: "Future Stars", rows: rows(2, "FS-") },
    ]);
    await link(t, f.insA, f.set, ["Future Stars", "Heavy"]);
    // The parallel under it has no link of its own: no parent fallback.
    expect(await leaf(t, f.parA)).toEqual({ kind: "none" });
    const got = await leaf(t, f.insA);
    expect(got.kind).toBe("rows");
    if (got.kind !== "rows") throw new Error("unreachable");
    expect(got.checklistId).toBe(id);
    expect(got.sections.map((s) => s.name)).toEqual(["Heavy", "Future Stars"]);
    expect(got.rows.map((r) => r.number)).toEqual([
      ...heavy.map((r) => r.number),
      "FS-1",
      "FS-2",
    ]);
    await settle(t);
  });

  test("a link written under another set is ignored", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    await upload(t, f.set, [{ name: "Future Stars", rows: rows(2) }]);
    await t.run((ctx) =>
      ctx.db.insert("publishedChecklistLinks", {
        setId: f.otherSet,
        selectorOptionId: f.insA,
        sectionKey: "future stars",
        createdAt: NOW,
        createdByUserId: "admin_a",
      }),
    );
    expect(await leaf(t, f.insA)).toEqual({ kind: "none" });
    await settle(t);
  });

  test("tooBig by rows or by bytes, before any chunk is read", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const id = await upload(t, f.set, [
      { name: "A", rows: rows(1500) },
      { name: "B", rows: rows(501, "B-") },
    ]);
    await link(t, f.insA, f.set, ["A", "B"]);
    expect(await leaf(t, f.insA)).toEqual({
      kind: "tooBig",
      rowCount: 2001,
      byteSize: expect.any(Number),
    });
    await link(t, f.insA, f.set, ["B"]);
    expect((await leaf(t, f.insA)).kind).toBe("rows");
    await t.run(async (ctx) => {
      const b = await ctx.db
        .query("publishedChecklistSections")
        .withIndex("by_checklist_and_key", (q) => q.eq("checklistId", id).eq("sectionKey", "b"))
        .unique();
      await ctx.db.patch(b!._id, { byteSize: LEAF_READ_MAX_BYTES + 1 });
    });
    expect(await leaf(t, f.insA)).toEqual({
      kind: "tooBig",
      rowCount: 501,
      byteSize: LEAF_READ_MAX_BYTES + 1,
    });
    await settle(t);
  });

  test("a section whose chunks do not line up is skipped and logged", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await upload(t, f.set, [
      { name: "Heavy", rows: Array.from({ length: 40 }, (_, i) => heavyRow(String(i))) },
      { name: "Fine", rows: rows(2) },
    ]);
    await link(t, f.insA, f.set, ["Heavy", "Fine"]);
    await t.run(async (ctx) => {
      const chunk = await ctx.db
        .query("publishedChecklistChunks")
        .filter((q) => q.eq(q.field("seq"), 1))
        .first();
      await ctx.db.patch(chunk!._id, { firstRow: 0 });
    });
    const got = await leaf(t, f.insA);
    expect(got).toMatchObject({ kind: "rows", sections: [{ name: "Fine" }] });
    expect(warn.mock.calls.join(" ")).toContain("published_checklist_section_chunks_broken");
    warn.mockRestore();
    await settle(t);
  });
});

describe("setRowChecklistSections, the one link writer", () => {
  test("refuses a row outside the set, a set-level row, a missing key, no checklist and >50 keys", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    await expect(link(t, f.insA, f.set, ["Base"])).rejects.toThrow(/no checklist/);
    await upload(t, f.set, [{ name: "Base", rows: rows(1) }]);
    await expect(link(t, f.otherVt, f.set, ["Base"])).rejects.toThrow(
      /Only a variant, insert or parallel of this set/,
    );
    await expect(link(t, f.set, f.set, ["Base"])).rejects.toThrow(/Only a variant/);
    await expect(link(t, f.insA, f.set, ["Base", "Nope"])).rejects.toThrow(
      /no section named “nope”/,
    );
    await expect(
      link(t, f.insA, f.set, Array.from({ length: 51 }, (_, i) => `k${i}`)),
    ).rejects.toThrow(/at most 50/);
    expect(await allLinks(t)).toEqual([]);
    await settle(t);
  });

  test("folds keys, writes nothing when unchanged, replaces on change, clears with []", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    await upload(t, f.set, [
      { name: "Base", rows: rows(1) },
      { name: "Base Rated Prospects", rows: rows(1) },
    ]);
    expect(await link(t, f.baseVt, f.set, [" BASE ", "base"])).toEqual({ added: 1, removed: 0 });
    const first = await allLinks(t);
    expect(first.map((l) => l.sectionKey)).toEqual(["base"]);
    expect(await link(t, f.baseVt, f.set, ["Base"])).toEqual({ added: 0, removed: 0 });
    expect(await allLinks(t)).toEqual(first);
    expect(await link(t, f.baseVt, f.set, ["Base Rated Prospects"])).toEqual({
      added: 1,
      removed: 1,
    });
    expect((await allLinks(t)).map((l) => l.sectionKey)).toEqual(["base rated prospects"]);
    // Clearing needs no checklist.
    await t.withIdentity(ADMIN).mutation(api.publishedChecklists.remove, { setId: f.set });
    expect(await link(t, f.baseVt, f.set, [])).toEqual({ added: 0, removed: 1 });
    expect(await allLinks(t)).toEqual([]);
    await settle(t);
  });

  test("a write drops the row's links left under another set", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    await upload(t, f.set, [{ name: "Base", rows: rows(1) }]);
    await t.run((ctx) =>
      ctx.db.insert("publishedChecklistLinks", {
        setId: f.otherSet,
        selectorOptionId: f.baseVt,
        sectionKey: "base",
        createdAt: NOW,
        createdByUserId: "x",
      }),
    );
    expect(await link(t, f.baseVt, f.set, ["Base"])).toEqual({ added: 1, removed: 1 });
    expect((await allLinks(t)).map((l) => l.setId)).toEqual([f.set]);
    await settle(t);
  });

  test("refuses past 4,000 links in one set", async () => {
    const t = convexTest(schema, modules);
    const f = await seedTree(t);
    await upload(t, f.set, [
      { name: "Base", rows: rows(1) },
      { name: "Extra", rows: rows(1) },
    ]);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3999; i += 1) {
        await ctx.db.insert("publishedChecklistLinks", {
          setId: f.set,
          selectorOptionId: f.parA,
          sectionKey: `filler ${i}`,
          createdAt: NOW,
          createdByUserId: "x",
        });
      }
    });
    expect(await link(t, f.baseVt, f.set, ["Base"])).toEqual({ added: 1, removed: 0 });
    await expect(link(t, f.insA, f.set, ["Extra"])).rejects.toThrow(/at most 4000 checklist links/);
    await settle(t);
  });

  test("sectionKeyOf is NFC, trimmed, whitespace-collapsed, lower-cased", () => {
    expect(sectionKeyOf("  Café   Stars\t")).toBe("café stars");
    expect(sectionKeyOf("BASE")).toBe(sectionKeyOf("base"));
  });
});
