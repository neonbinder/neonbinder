/**
 * NEO-496 — saving a set's publisher checklist: the batch plan, the
 * start -> addSections x N -> finish run, and the operator copy for a refusal.
 *
 * `.tsx` on purpose: a `.test.ts` under components/ is collected by nothing
 * (vitest.include.mjs).
 */

import { ConvexError } from "convex/values";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_ROWS,
  BATCH_MAX_SECTIONS,
  MAX_SECTION_ROWS,
  storedRowBytes,
} from "../../convex/lib/publishedChecklistSections";
import type { ChecklistSection, ChecklistSectionRow } from "@/lib/checklists/checklist-sections";
import {
  SAVE_INTERRUPTED,
  planChecklistBatches,
  uploadChecklist,
  uploadFailure,
  type ChecklistBatch,
  type ChecklistUploadApi,
} from "./published-checklist-upload";

const SET = "set1" as Id<"selectorOptions">;
const CHK = "chk1" as Id<"publishedChecklists">;

const row = (n: number, player = `P${n}`): ChecklistSectionRow => ({
  number: String(n),
  players: [player],
  teams: [],
});

const section = (name: string, rows: ChecklistSectionRow[], group?: string): ChecklistSection => ({
  name,
  key: name.toLowerCase(),
  rows,
  ...(group ? { group } : {}),
});

const rowsOf = (count: number): ChecklistSectionRow[] =>
  Array.from({ length: count }, (_, i) => row(i + 1));

/** Mirror of the module's private row size: both flags present. */
const sizeOf = (r: ChecklistSectionRow) =>
  storedRowBytes({
    number: r.number,
    players: r.players,
    teams: r.teams,
    noNumber: true,
    noTeam: true,
  });

describe("planChecklistBatches", () => {
  test("no sections plan no calls", () => {
    expect(planChecklistBatches([])).toEqual([]);
  });

  test("small sections share one call, ordinals start at 0", () => {
    const a = section("A", rowsOf(2));
    const b = section("B", rowsOf(3), "AUTOGRAPH");
    const [batch, ...rest] = planChecklistBatches([a, b]);
    expect(rest).toEqual([]);
    expect(batch.firstOrdinal).toBe(0);
    expect(batch.rowCount).toBe(5);
    expect(batch.byteSize).toBe([...a.rows, ...b.rows].reduce((n, r) => n + sizeOf(r), 0));
    // The wire section drops `key` and carries `group` only when there is one.
    expect(batch.sections).toEqual([
      { name: "A", rows: a.rows },
      { name: "B", group: "AUTOGRAPH", rows: b.rows },
    ]);
  });

  test("exactly BATCH_MAX_SECTIONS sections fit one call; one more starts the next at that ordinal", () => {
    const full = Array.from({ length: BATCH_MAX_SECTIONS }, (_, i) => section(`S${i}`, rowsOf(1)));
    expect(planChecklistBatches(full)).toHaveLength(1);
    const over = [...full, section("Extra", rowsOf(1))];
    const batches = planChecklistBatches(over);
    expect(batches.map((b) => [b.firstOrdinal, b.sections.length])).toEqual([
      [0, BATCH_MAX_SECTIONS],
      [BATCH_MAX_SECTIONS, 1],
    ]);
  });

  test("exactly BATCH_MAX_ROWS rows fit one call; one more row moves the section on", () => {
    const half = BATCH_MAX_ROWS / 2;
    expect(
      planChecklistBatches([section("A", rowsOf(half)), section("B", rowsOf(half))]),
    ).toHaveLength(1);
    const batches = planChecklistBatches([
      section("A", rowsOf(half)),
      section("B", rowsOf(half + 1)),
    ]);
    expect(batches.map((b) => [b.firstOrdinal, b.rowCount])).toEqual([
      [0, half],
      [1, half + 1],
    ]);
  });

  test("a section exactly at the byte limit shares a call; one byte under the limit splits it", () => {
    const a = section("A", [row(1)]);
    const b = section("B", [row(2)]);
    const total = sizeOf(a.rows[0]) + sizeOf(b.rows[0]);
    expect(planChecklistBatches([a, b], { bytes: total })).toHaveLength(1);
    const split = planChecklistBatches([a, b], { bytes: total - 1 });
    expect(split.map((x) => x.firstOrdinal)).toEqual([0, 1]);
  });

  test("with the real BATCH_MAX_BYTES, a section filling it exactly takes a call and the next section a second", () => {
    // Pad one row's player name until the section is exactly BATCH_MAX_BYTES.
    const rows: ChecklistSectionRow[] = [];
    let used = 0;
    while (used + 3_000 < BATCH_MAX_BYTES && rows.length < MAX_SECTION_ROWS - 1) {
      const r = row(rows.length + 1, "x".repeat(2_000));
      rows.push(r);
      used += sizeOf(r);
    }
    let pad = 1;
    let last = row(rows.length + 1, "y".repeat(pad));
    while (used + sizeOf(last) < BATCH_MAX_BYTES) {
      pad += 1;
      last = row(rows.length + 1, "y".repeat(pad));
    }
    expect(used + sizeOf(last)).toBe(BATCH_MAX_BYTES);
    const big = section("Big", [...rows, last]);
    const batches = planChecklistBatches([big, section("Tiny", [row(1)])]);
    expect(batches.map((b) => [b.firstOrdinal, b.sections.length, b.byteSize])).toEqual([
      [0, 1, BATCH_MAX_BYTES],
      [1, 1, sizeOf(row(1))],
    ]);
  });

  test("a section too big for any call gets one to itself, between its neighbours", () => {
    const batches = planChecklistBatches(
      [section("A", rowsOf(1)), section("Huge", rowsOf(5)), section("C", rowsOf(1))],
      { rows: 3 },
    );
    expect(batches.map((b) => [b.firstOrdinal, b.sections.map((s) => s.name)])).toEqual([
      [0, ["A"]],
      [1, ["Huge"]],
      [2, ["C"]],
    ]);
  });

  test("an empty section still takes an ordinal", () => {
    const batches = planChecklistBatches([section("A", []), section("B", rowsOf(1))]);
    expect(batches).toHaveLength(1);
    expect(batches[0].sections.map((s) => s.name)).toEqual(["A", "B"]);
    expect(batches[0].rowCount).toBe(1);
  });

  test("the plan is a pure function of the sections", () => {
    const input = Array.from({ length: 250 }, (_, i) => section(`S${i}`, rowsOf(2)));
    expect(planChecklistBatches(input)).toEqual(planChecklistBatches(input));
  });

  test("duplicate section names are kept as given, each with its own ordinal", () => {
    const batches = planChecklistBatches([section("Dup", rowsOf(1)), section("Dup", rowsOf(1))], {
      sections: 1,
    });
    expect(batches.map((b) => [b.firstOrdinal, b.sections[0].name])).toEqual([
      [0, "Dup"],
      [1, "Dup"],
    ]);
  });
});

const batch = (firstOrdinal: number, names: string[], rowCount = 1): ChecklistBatch => ({
  firstOrdinal,
  sections: names.map((name) => ({ name, rows: rowsOf(rowCount) })),
  rowCount: names.length * rowCount,
  byteSize: 0,
});

function fakeApi(over: Partial<ChecklistUploadApi> = {}) {
  let saved = 0;
  const api: ChecklistUploadApi = {
    start: vi.fn(async () => ({ checklistId: CHK })),
    addSections: vi.fn(async (args) => {
      saved = args.firstOrdinal + args.sections.length;
      return { sectionCount: saved, rowCount: 0, byteSize: 0 };
    }),
    finish: vi.fn(async () => null),
    ...over,
  };
  return api;
}

const OPTS = { setId: SET, fileName: "f.csv", format: "csv" as const };

describe("uploadChecklist", () => {
  test("runs start, each batch in order, then finish with the totals", async () => {
    const api = fakeApi();
    const batches = [batch(0, ["A", "B"], 2), batch(2, ["C"], 3)];
    const result = await uploadChecklist(api, { ...OPTS, batches });
    expect(result).toEqual({ ok: true, sectionCount: 3, rowCount: 7 });
    expect(api.start).toHaveBeenCalledWith({ setId: SET, fileName: "f.csv", format: "csv" });
    expect(vi.mocked(api.addSections).mock.calls.map(([a]) => [a.checklistId, a.firstOrdinal])).toEqual([
      [CHK, 0],
      [CHK, 2],
    ]);
    expect(api.finish).toHaveBeenCalledWith({ checklistId: CHK, sectionCount: 3, rowCount: 7 });
  });

  test("empty input starts and finishes with zero counts and sends no batch", async () => {
    const api = fakeApi();
    const result = await uploadChecklist(api, { ...OPTS, batches: [] });
    expect(result).toEqual({ ok: true, sectionCount: 0, rowCount: 0 });
    expect(api.addSections).not.toHaveBeenCalled();
    expect(api.finish).toHaveBeenCalledWith({ checklistId: CHK, sectionCount: 0, rowCount: 0 });
  });

  test("progress reports 0 first, then the server's confirmed count after each call", async () => {
    const onProgress = vi.fn();
    await uploadChecklist(fakeApi(), {
      ...OPTS,
      batches: [batch(0, ["A", "B"]), batch(2, ["C"])],
      onProgress,
    });
    expect(onProgress.mock.calls).toEqual([
      [0, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  test("progress follows what the server confirms, not what was sent", async () => {
    const onProgress = vi.fn();
    const api = fakeApi({
      addSections: vi.fn(async () => ({ sectionCount: 1, rowCount: 0, byteSize: 0 })),
    });
    await uploadChecklist(api, { ...OPTS, batches: [batch(0, ["A", "B"])], onProgress });
    expect(onProgress).toHaveBeenLastCalledWith(1, 2);
  });

  test("a refusal mid-upload returns the error and the confirmed checkpoint, and never finishes", async () => {
    const boom = new ConvexError("Section “B” has 3000 rows; the limit is 2,000.");
    const addSections = vi
      .fn<ChecklistUploadApi["addSections"]>()
      .mockResolvedValueOnce({ sectionCount: 1, rowCount: 0, byteSize: 0 })
      .mockRejectedValueOnce(boom);
    const api = fakeApi({ addSections });
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A"]), batch(1, ["B"]), batch(2, ["C"])],
    });
    expect(result).toEqual({
      ok: false,
      error: boom,
      checkpoint: { checklistId: CHK, sectionsSaved: 1 },
    });
    expect(addSections).toHaveBeenCalledTimes(2);
    expect(api.finish).not.toHaveBeenCalled();
  });

  test("a refused start returns a null checkpoint and calls nothing else", async () => {
    const boom = new ConvexError("A checklist can only be added to a set.");
    const api = fakeApi({ start: vi.fn(async () => Promise.reject(boom)) });
    const result = await uploadChecklist(api, { ...OPTS, batches: [batch(0, ["A"])] });
    expect(result).toEqual({ ok: false, error: boom, checkpoint: null });
    expect(api.addSections).not.toHaveBeenCalled();
    expect(api.finish).not.toHaveBeenCalled();
  });

  test("a refused finish returns the error with everything saved as the checkpoint", async () => {
    const boom = new Error("net");
    const api = fakeApi({ finish: vi.fn(async () => Promise.reject(boom)) });
    const result = await uploadChecklist(api, { ...OPTS, batches: [batch(0, ["A"])] });
    expect(result).toEqual({
      ok: false,
      error: boom,
      checkpoint: { checklistId: CHK, sectionsSaved: 1 },
    });
  });

  test("shouldStop before the first call stops without sending any batch or finishing", async () => {
    const api = fakeApi();
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A"])],
      shouldStop: () => true,
    });
    expect(result).toEqual({ ok: false, stopped: true });
    expect(api.addSections).not.toHaveBeenCalled();
    expect(api.finish).not.toHaveBeenCalled();
  });

  test("shouldStop between calls stops after the batch in flight and never finishes", async () => {
    let stop = false;
    const api = fakeApi();
    vi.mocked(api.addSections).mockImplementation(async (args) => {
      stop = true;
      return { sectionCount: args.firstOrdinal + args.sections.length, rowCount: 0, byteSize: 0 };
    });
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A"]), batch(1, ["B"])],
      shouldStop: () => stop,
    });
    expect(result).toEqual({ ok: false, stopped: true });
    expect(api.addSections).toHaveBeenCalledTimes(1);
    expect(api.finish).not.toHaveBeenCalled();
  });

  test("shouldStop after the last batch still stops before finish", async () => {
    let calls = 0;
    const api = fakeApi();
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A"])],
      // false for the loop's check, true for the check before finish
      shouldStop: () => ++calls > 1,
    });
    expect(result).toEqual({ ok: false, stopped: true });
    expect(api.finish).not.toHaveBeenCalled();
  });

  test("resuming skips the confirmed batches, does not call start, and finishes with the full totals", async () => {
    const api = fakeApi();
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A"]), batch(1, ["B"]), batch(2, ["C"])],
      resumeFrom: { checklistId: CHK, sectionsSaved: 1 },
    });
    expect(result).toEqual({ ok: true, sectionCount: 3, rowCount: 3 });
    expect(api.start).not.toHaveBeenCalled();
    expect(vi.mocked(api.addSections).mock.calls.map(([a]) => a.firstOrdinal)).toEqual([1, 2]);
  });

  test("resuming with everything saved only finishes", async () => {
    const api = fakeApi();
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A"])],
      resumeFrom: { checklistId: CHK, sectionsSaved: 1 },
    });
    expect(result.ok).toBe(true);
    expect(api.addSections).not.toHaveBeenCalled();
    expect(api.finish).toHaveBeenCalledTimes(1);
  });

  test("a resumed run whose first call is refused starts the upload over once", async () => {
    const OLD = "old" as Id<"publishedChecklists">;
    const addSections = vi
      .fn<ChecklistUploadApi["addSections"]>()
      .mockRejectedValueOnce(new Error("expired"))
      .mockImplementation(async (args) => ({
        sectionCount: args.firstOrdinal + args.sections.length,
        rowCount: 0,
        byteSize: 0,
      }));
    const api = fakeApi({ addSections });
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A"]), batch(1, ["B"])],
      resumeFrom: { checklistId: OLD, sectionsSaved: 1 },
    });
    expect(result).toEqual({ ok: true, sectionCount: 2, rowCount: 2 });
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(addSections.mock.calls.map(([a]) => [a.checklistId, a.firstOrdinal])).toEqual([
      [OLD, 1],
      [CHK, 0],
      [CHK, 1],
    ]);
  });

  test("a resumed run refused after its first call is NOT restarted", async () => {
    const boom = new Error("net");
    const addSections = vi
      .fn<ChecklistUploadApi["addSections"]>()
      .mockResolvedValueOnce({ sectionCount: 2, rowCount: 0, byteSize: 0 })
      .mockRejectedValueOnce(boom);
    const api = fakeApi({ addSections });
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A"]), batch(1, ["B"]), batch(2, ["C"])],
      resumeFrom: { checklistId: CHK, sectionsSaved: 1 },
    });
    expect(result).toEqual({
      ok: false,
      error: boom,
      checkpoint: { checklistId: CHK, sectionsSaved: 2 },
    });
    expect(api.start).not.toHaveBeenCalled();
  });

  test("a checkpoint off a call boundary restarts from scratch", async () => {
    const api = fakeApi();
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A", "B"]), batch(2, ["C"])],
      resumeFrom: { checklistId: CHK, sectionsSaved: 1 },
    });
    expect(result.ok).toBe(true);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.addSections).mock.calls.map(([a]) => a.firstOrdinal)).toEqual([0, 2]);
  });

  test("a restart that is refused too reports that refusal with the new upload's checkpoint", async () => {
    const boom = new Error("no");
    const api = fakeApi({ addSections: vi.fn(async () => Promise.reject(boom)) });
    const result = await uploadChecklist(api, {
      ...OPTS,
      batches: [batch(0, ["A"])],
      resumeFrom: { checklistId: "old" as Id<"publishedChecklists">, sectionsSaved: 0 },
    });
    expect(result).toEqual({
      ok: false,
      error: boom,
      checkpoint: { checklistId: CHK, sectionsSaved: 0 },
    });
    expect(api.start).toHaveBeenCalledTimes(1);
  });
});

describe("uploadFailure", () => {
  test("a non-Convex error is the interrupted-save copy, retryable", () => {
    expect(uploadFailure(new Error("boom"))).toEqual({ message: SAVE_INTERRUPTED, fix: "retry" });
    expect(uploadFailure(null)).toEqual({ message: SAVE_INTERRUPTED, fix: "retry" });
  });

  test("a ConvexError with non-string data is the interrupted-save copy", () => {
    expect(uploadFailure(new ConvexError({ code: 1 }))).toEqual({
      message: SAVE_INTERRUPTED,
      fix: "retry",
    });
  });

  test("the server's bookkeeping words never reach the operator", () => {
    for (const text of ["Rows arrived out of order.", "No such upload.", "That batch is too big."]) {
      expect(uploadFailure(new ConvexError(text))).toEqual({
        message: SAVE_INTERRUPTED,
        fix: "retry",
      });
    }
  });

  test("a section over the row limit names the section, the count and the limit", () => {
    expect(
      uploadFailure(new ConvexError("Section “Base” has 2500 rows; the limit is 2000.")),
    ).toEqual({
      message: "“Base” has 2,500 cards, and one section holds up to 2,000. Split it in the file, then upload it again.",
      fix: "file",
    });
  });

  test("a section too large to store", () => {
    expect(uploadFailure(new ConvexError("Section “Base” is too large to store."))).toEqual({
      message: "“Base” is too big to keep in one piece. Split it in the file, then upload it again.",
      fix: "file",
    });
  });

  test("a checklist too large, too many sections, too many rows", () => {
    expect(uploadFailure(new ConvexError("This checklist is too large to store.")).fix).toBe("file");
    expect(uploadFailure(new ConvexError("A checklist has at most 1000 sections.")).message).toBe(
      "That's more than 1,000 sections, more than one set holds. Upload just this set's checklist.",
    );
    expect(uploadFailure(new ConvexError("A checklist has at most 50000 rows.")).message).toBe(
      "That's more than 50,000 cards, more than one set holds. Upload just this set's checklist.",
    );
  });

  test("duplicate section names", () => {
    expect(uploadFailure(new ConvexError("Two sections are named “Base”."))).toEqual({
      message: "Two sections are named “Base”. Rename one in the file, then upload it again.",
      fix: "file",
    });
  });

  test("a checklist on something that is not a set", () => {
    expect(uploadFailure(new ConvexError("A checklist can only be added to a set."))).toEqual({
      message: "A checklist goes on a set. Pick the set, then upload it there.",
      fix: "file",
    });
  });

  test("any other server sentence is shown, with what to do about it", () => {
    expect(uploadFailure(new ConvexError("Section 3's name is blank.  "))).toEqual({
      message: "Section 3's name is blank. Fix it in the file, then upload it again.",
      fix: "file",
    });
  });
});
