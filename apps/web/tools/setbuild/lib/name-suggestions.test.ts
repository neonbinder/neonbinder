import { describe, expect, test } from "vitest";
import { ResolveError } from "../service";
import type { ResolvedBrandYear, ResolvedSet } from "../spec/resolve";
import { fakeNbClient, row } from "./fake-nb-client";
import { applyNameAnswers, describeNameRow, listNameSuggestions, MAX_SUGGESTION_DECISIONS } from "./name-suggestions";

const OPTIONS = "selectorOptions:getSelectorOptions";
const SUGGEST = "selectorOptions:getSelectorSyncSuggestions";
const APPLY = "selectorOptions:applySelectorSyncSuggestions";

const PATH = { sport: "Baseball", year: "2014", manufacturer: "Topps", set: "Topps Chrome" };
const SET = {
  sportId: "sp",
  yearId: "yr",
  manufacturerId: "mf",
  setId: "set",
  rows: {},
} as unknown as ResolvedSet;

type Suggestion = { side: "bsc" | "sportlots"; label: string; foldEqual: boolean };
type SRow = { existingId: string; currentValue: string; suggestions: Suggestion[]; baseVersion: number };

/**
 * A set with Base, an Insert type holding "Future Stars" (with one parallel,
 * "Refractor") and "Rookie Debut". `columns` holds what the suggestions
 * query returns per `level|parentId`; the apply handler removes what it was
 * sent unless `refuse` names the row.
 */
function world(columns: Record<string, SRow[]>, opts: { refuse?: string[]; versionBump?: string[] } = {}) {
  const live = structuredClone(columns);
  const client = fakeNbClient({
    [OPTIONS]: (a) => {
      if (a.level === "variantType") return [row("vt-base", "variantType", "Base"), row("vt-ins", "variantType", "Insert")];
      if (a.level === "insert" && a.parentId === "vt-ins") return [row("r-fs", "insert", "Future Stars"), row("r-rd", "insert", "Rookie Debut")];
      if (a.level === "parallel" && a.parentId === "r-fs") return [row("p-ref", "parallel", "Refractor")];
      if (a.level === "setName") return [row("set", "setName", "Topps Chrome"), row("set-2", "setName", "Topps Chrome Update")];
      return [];
    },
    [SUGGEST]: (a) => live[`${a.level}|${a.parentId}`] ?? [],
    [APPLY]: (a) => {
      const decisions = a.decisions as Array<{ existingId: string; baseVersion: number; side: string; action: string }>;
      const out = { applied: 0, declined: 0, stale: 0, clashed: 0, skipped: 0 };
      const col = live[`${a.level}|${a.parentId}`] ?? [];
      for (const d of decisions) {
        const r = col.find((x) => x.existingId === d.existingId);
        if (!r || opts.refuse?.includes(d.existingId)) {
          out.clashed++;
          continue;
        }
        if (r.baseVersion !== d.baseVersion) {
          out.stale++;
          continue;
        }
        r.suggestions = r.suggestions.filter((s) => s.side !== d.side);
        if (d.action === "accept") out.applied++;
        else out.declined++;
      }
      return out;
    },
  });
  return client;
}

const sug = (id: string, current: string, side: Suggestion["side"], label: string, baseVersion = 1): SRow => ({
  existingId: id,
  currentValue: current,
  suggestions: [{ side, label, foldEqual: false }],
  baseVersion,
});

describe("listNameSuggestions (set path)", () => {
  test("lists the set's own row, its variant types, rows and parallels; never a sibling set", async () => {
    const client = world({
      "setName|mf": [sug("set", "Topps Chrome", "bsc", "Chrome"), sug("set-2", "Topps Chrome Update", "bsc", "Update")],
      "variantType|set": [sug("vt-base", "Base", "sportlots", "Topps Chrome")],
      "insert|vt-ins": [sug("r-fs", "Future Stars", "bsc", "Future Stars Inserts")],
      "parallel|r-fs": [sug("p-ref", "Refractor", "sportlots", "Refractors")],
    });
    const items = await listNameSuggestions(client, PATH, SET);
    expect(items.map((i) => [i.where, i.sides[0].label])).toEqual([
      ["Baseball/2014/Topps/Topps Chrome", "Chrome"],
      ["Baseball/2014/Topps/Topps Chrome › Base", "Topps Chrome"],
      ["Baseball/2014/Topps/Topps Chrome › Insert › Future Stars", "Future Stars Inserts"],
      ["Baseball/2014/Topps/Topps Chrome › Insert › Future Stars › Refractor", "Refractors"],
    ]);
    expect(items[3].row).toEqual({ type: "Insert", name: "Future Stars", parallel: "Refractor" });
    expect(items[0].row).toEqual({});
    expect(items[2].link).toBe("/admin/set-builder?" + new URLSearchParams({ sport: "sp", year: "yr", brand: "mf", set: "set", type: "vt-ins", insert: "r-fs" }).toString());
    // Read-only.
    expect(client.calls.every((c) => c.kind === "query")).toBe(true);
  });

  test("brand-year: the manufacturer's own row, and each set row answered on its own set path", async () => {
    const client = world({
      "manufacturer|yr": [sug("mf", "Topps", "bsc", "Topps Inc"), sug("mf-2", "Bowman", "bsc", "Bowman Inc")],
      "setName|mf": [sug("set-2", "Topps Chrome Update", "sportlots", "Chrome Update")],
    });
    const brand = { sportId: "sp", yearId: "yr", manufacturerId: "mf", rows: {} } as unknown as ResolvedBrandYear;
    const by = { sport: "Baseball", year: "2014", manufacturer: "Topps" };
    const items = await listNameSuggestions(client, by, brand);
    expect(items.map((i) => [i.path, i.row, i.currentValue])).toEqual([
      [by, {}, "Topps"],
      [{ ...by, set: "Topps Chrome Update" }, {}, "Topps Chrome Update"],
    ]);
  });
});

describe("applyNameAnswers", () => {
  test("accept and decline go through the dialog's mutation with the baseVersion read at fix time", async () => {
    const client = world({
      "insert|vt-ins": [sug("r-fs", "Future Stars", "bsc", "Future Stars Inserts", 7), sug("r-rd", "Rookie Debut", "sportlots", "Rookie Debuts", 9)],
    });
    const r = await applyNameAnswers(client, PATH, SET, [
      { row: { type: "Insert", name: "Future Stars" }, side: "bsc", action: "accept", label: "Future Stars Inserts" },
      { row: { type: "Insert", name: "Rookie Debut" }, side: "sportlots", action: "decline", label: "Rookie Debuts" },
    ]);
    const sent = client.callsTo(APPLY);
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toEqual({
      level: "insert",
      parentId: "vt-ins",
      decisions: [
        { existingId: "r-fs", baseVersion: 7, side: "bsc", action: "accept" },
        { existingId: "r-rd", baseVersion: 9, side: "sportlots", action: "decline" },
      ],
    });
    // No label on the wire: the server writes the label it reads off the row.
    expect(JSON.stringify(sent[0].args)).not.toContain("Future Stars Inserts");
    expect(r.counts).toEqual({ applied: 1, declined: 1, stale: 0, clashed: 0, skipped: 0 });
    expect(r.results.map((x) => [x.at, x.outcome])).toEqual([
      ["names[0]", "applied"],
      ["names[1]", "applied"],
    ]);
    expect(r.results[0].detail).toContain("renamed to “Future Stars Inserts”");
  });

  test("a label that moved since the listing is refused, never accepted unseen", async () => {
    const client = world({ "insert|vt-ins": [sug("r-fs", "Future Stars", "bsc", "Future Stars Insert Set")] });
    const r = await applyNameAnswers(client, PATH, SET, [
      { row: { type: "Insert", name: "Future Stars" }, side: "bsc", action: "accept", label: "Future Stars Inserts" },
    ]);
    expect(client.callsTo(APPLY)).toHaveLength(0);
    expect(r.results[0].outcome).toBe("refused");
    expect(r.results[0].detail).toContain("now “Future Stars Insert Set”");
  });

  test("a suggestion that is gone is a reported no-op", async () => {
    const client = world({ "insert|vt-ins": [] });
    const r = await applyNameAnswers(client, PATH, SET, [
      { row: { type: "Insert", name: "Future Stars" }, side: "bsc", action: "decline", label: "X" },
    ]);
    expect(client.callsTo(APPLY)).toHaveLength(0);
    expect(r.results[0].outcome).toBe("moot");
  });

  test("a row the server did not save (clash, stale) is refused with the server's counts", async () => {
    const client = world({ "insert|vt-ins": [sug("r-fs", "Future Stars", "bsc", "Rookie Debut")] }, { refuse: ["r-fs"] });
    const r = await applyNameAnswers(client, PATH, SET, [
      { row: { type: "Insert", name: "Future Stars" }, side: "bsc", action: "accept", label: "Rookie Debut" },
    ]);
    expect(r.counts.clashed).toBe(1);
    expect(r.results[0].outcome).toBe("refused");
  });

  test("the same row and side answered twice is refused, never settled by order", async () => {
    const client = world({ "insert|vt-ins": [sug("r-fs", "Future Stars", "bsc", "FS")] });
    const r = await applyNameAnswers(client, PATH, SET, [
      { row: { type: "Insert", name: "Future Stars" }, side: "bsc", action: "accept", label: "FS" },
      { row: { type: "Insert", name: "Future Stars" }, side: "bsc", action: "decline", label: "FS" },
    ]);
    expect(client.callsTo(APPLY)).toHaveLength(0);
    expect(r.results.map((x) => x.outcome)).toEqual(["refused", "refused"]);
  });

  test("a row name that is not exactly one row stops the batch before anything is written", async () => {
    const client = world({ "insert|vt-ins": [sug("r-fs", "Future Stars", "bsc", "FS")] });
    await expect(
      applyNameAnswers(client, PATH, SET, [
        { row: { type: "Insert", name: "Future Stars" }, side: "bsc", action: "accept", label: "FS" },
        { row: { type: "Insert", name: "Future" }, side: "bsc", action: "accept", label: "FS" },
      ]),
    ).rejects.toBeInstanceOf(ResolveError);
    expect(client.callsTo(APPLY)).toHaveLength(0);
  });

  test("the set's own row is the default; a brand-year refuses a row under it", async () => {
    const client = world({ "setName|mf": [sug("set", "Topps Chrome", "bsc", "Chrome")] });
    const r = await applyNameAnswers(client, PATH, SET, [{ side: "bsc", action: "decline", label: "Chrome" }]);
    expect(client.callsTo(APPLY)[0].args).toMatchObject({ level: "setName", parentId: "mf" });
    expect(r.results[0].outcome).toBe("applied");

    const brand = { sportId: "sp", yearId: "yr", manufacturerId: "mf", rows: {} } as unknown as ResolvedBrandYear;
    await expect(
      applyNameAnswers(client, { sport: "Baseball", year: "2014", manufacturer: "Topps" }, brand, [
        { row: { type: "Base" }, side: "bsc", action: "decline", label: "x" },
      ]),
    ).rejects.toBeInstanceOf(ResolveError);
  });

  test(`chunks a column at ${MAX_SUGGESTION_DECISIONS} decisions per call`, async () => {
    const rows = Array.from({ length: MAX_SUGGESTION_DECISIONS + 5 }, (_, i) => sug(`r${i}`, `Row ${i}`, "bsc", `Row ${i}!`));
    const client = world({ "insert|vt-ins": rows });
    client.on(OPTIONS, (a) =>
      a.level === "variantType" ? [row("vt-ins", "variantType", "Insert")] : a.level === "insert" ? rows.map((x) => row(x.existingId, "insert", x.currentValue)) : [],
    );
    const r = await applyNameAnswers(
      client,
      PATH,
      SET,
      rows.map((x) => ({ row: { type: "Insert", name: x.currentValue }, side: "bsc" as const, action: "decline" as const, label: `${x.currentValue}!` })),
    );
    expect(client.callsTo(APPLY).map((c) => (c.args.decisions as unknown[]).length)).toEqual([MAX_SUGGESTION_DECISIONS, 5]);
    expect(r.counts.declined).toBe(MAX_SUGGESTION_DECISIONS + 5);
    expect(r.calls).toBe(2);
  });
});

test("describeNameRow", () => {
  expect(describeNameRow(PATH, {})).toBe("Baseball/2014/Topps/Topps Chrome");
  expect(describeNameRow(PATH, { type: "Insert", name: "Future Stars" })).toBe("Baseball/2014/Topps/Topps Chrome › Insert › Future Stars");
});
