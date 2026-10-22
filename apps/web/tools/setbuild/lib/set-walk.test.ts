import { describe, expect, test } from "vitest";
import { attentionRows } from "./attention";
import { fakeNbClient, row, type FakeNbClient } from "./fake-nb-client";
import { READ_CONCURRENCY, mapLimit, walkSet } from "./set-walk";
import { inspectPath } from "../runner/inspect";
import type { ResolvedSet } from "../spec/resolve";

// ---------------------------------------------------------------------------
// A set big enough to need several waves of reads, whose reads land out of
// order: each call waits a scrambled few milliseconds, so a later call often
// answers before an earlier one.
// ---------------------------------------------------------------------------

const SET: ResolvedSet = {
  sportId: "sport" as never,
  yearId: "year" as never,
  manufacturerId: "mfr" as never,
  setId: "set" as never,
  rows: {
    sport: row("sport", "sport", "Baseball") as never,
    year: row("year", "year", "2024") as never,
    manufacturer: row("mfr", "manufacturer", "Topps") as never,
    set: row("set", "setName", "Topps Chrome") as never,
  },
};

type Row = ReturnType<typeof row>;

/** Base, an Inserts type of 40 rows (every third with 1–3 parallels), a Parallels type of 12 rows. */
function bigTree(): Record<string, Row[]> {
  const tree: Record<string, Row[]> = {
    "sport:": [row("sport", "sport", "Baseball")],
    "year:sport": [row("year", "year", "2024")],
    "manufacturer:year": [row("mfr", "manufacturer", "Topps")],
    "setName:mfr": [row("set", "setName", "Topps Chrome")],
    "variantType:set": [row("vt-base", "variantType", "Base"), row("vt-ins", "variantType", "Inserts"), row("vt-par", "variantType", "Parallels")],
  };
  tree["insert:vt-ins"] = Array.from({ length: 40 }, (_, i) => row(`ins-${i}`, "insert", `Insert ${i}`));
  tree["insert:vt-par"] = Array.from({ length: 12 }, (_, i) => row(`par-${i}`, "insert", `Refractor ${i}`));
  for (let i = 0; i < 40; i += 3) {
    tree[`parallel:ins-${i}`] = Array.from({ length: 1 + (i % 3 === 0 ? i % 4 : 0) }, (_, j) => row(`ins-${i}-p${j}`, "parallel", `Gold ${i}.${j}`));
  }
  return tree;
}

/** A fake client over `tree` whose every read waits a scrambled delay, counting reads in flight. */
function scrambledClient(tree: Record<string, Row[]>): FakeNbClient & { maxInFlight: () => number } {
  let seq = 0;
  let inFlight = 0;
  let max = 0;
  const later = async <T>(value: T): Promise<T> => {
    inFlight++;
    max = Math.max(max, inFlight);
    const delay = (seq++ * 7919) % 11; // 0–10 ms, scrambled across calls
    await new Promise((r) => setTimeout(r, delay));
    inFlight--;
    return value;
  };
  const client = fakeNbClient({
    "selectorOptions:getSelectorOptions": (a) => later(tree[`${a.level}:${a.parentId ? String(a.parentId) : ""}`] ?? []),
    "selectorOptions:getSlotCardCounts": (a) => later({ bsc: {}, sportlots: {}, total: String(a.selectorOptionId).length }),
  });
  return Object.assign(client, { maxInFlight: () => max });
}

/** The walk as it ran before NEO-339's concurrency change: one read at a time, in order. */
function serialOrder(tree: Record<string, Row[]>): string[] {
  const out: string[] = [];
  for (const t of tree["variantType:set"]) {
    if (t.value === "Base") {
      out.push(t.value);
      continue;
    }
    for (const r of tree[`insert:${t._id}`] ?? []) {
      out.push(`${t.value} › ${r.value}`);
      for (const p of tree[`parallel:${r._id}`] ?? []) out.push(`${t.value} › ${r.value} › ${p.value}`);
    }
  }
  return out;
}

describe("attentionRows with reads landing out of order", () => {
  test("lists the set's checklists in the serial walk's order", async () => {
    const tree = bigTree();
    const client = scrambledClient(tree);
    const nodes = await attentionRows(client, SET);

    expect(nodes.map((n) => n.label)).toEqual(serialOrder(tree));
    // Each node still carries its own ids, not a neighbour's.
    for (const n of nodes) expect(n.drillIds[n.drillIds.length - 1]).toBe(String(n.rowId));
    const gold = nodes.find((n) => n.label === "Inserts › Insert 3 › Gold 3.0")!;
    expect(gold.ref).toEqual({ type: "Inserts", name: "Insert 3", parallel: "Gold 3.0" });
    expect(gold.drillIds).toEqual(["sport", "year", "mfr", "set", "vt-ins", "ins-3", "ins-3-p0"]);
    // Reads overlapped, within the bound.
    expect(client.maxInFlight()).toBeGreaterThan(1);
    expect(client.maxInFlight()).toBeLessThanOrEqual(READ_CONCURRENCY);
  });

  test("reads the same rows the serial walk read: one per non-Base type, one per row, none under Base", async () => {
    const tree = bigTree();
    const client = scrambledClient(tree);
    await walkSet(client, SET.setId, { parallels: true });
    const reads = client.callsTo("selectorOptions:getSelectorOptions").map((c) => `${c.args.level}:${String(c.args.parentId)}`);
    expect(reads).toHaveLength(1 + 2 + 52);
    expect(reads).not.toContain("insert:vt-base");
    expect(new Set(reads).size).toBe(reads.length);
  });

  test("without parallels, reads no row's children", async () => {
    const client = scrambledClient(bigTree());
    const walked = await walkSet(client, SET.setId, { parallels: false });
    expect(client.callsTo("selectorOptions:getSelectorOptions").filter((c) => c.args.level === "parallel")).toEqual([]);
    expect(walked.map((w) => [w.type.value, w.isBase, w.rows.length])).toEqual([
      ["Base", true, 0],
      ["Inserts", false, 40],
      ["Parallels", false, 12],
    ]);
  });
});

describe("inspectPath with reads landing out of order", () => {
  test("lists types, rows, parallels and each row's own card count in the serial walk's order", async () => {
    const tree = bigTree();
    const client = scrambledClient(tree);
    const report = await inspectPath(client, { convexUrl: "https://x.convex.cloud", host: "x.convex.cloud" }, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: "Topps Chrome",
    });

    const listed: string[] = [];
    for (const vt of report.variantTypes ?? []) {
      for (const r of vt.rows) {
        listed.push(vt.type === "Base" ? r.name : `${vt.type} › ${r.name}`);
        for (const p of r.parallels ?? []) listed.push(`${vt.type} › ${r.name} › ${p.name}`);
      }
    }
    expect(listed).toEqual(serialOrder(tree));
    // The fake's count is the row id's length, so a count on the wrong row shows.
    expect(report.base).toMatchObject({ name: "Base", cards: "vt-base".length, isBase: true });
    const ins3 = report.variantTypes![1].rows[3];
    expect(ins3).toMatchObject({ name: "Insert 3", cards: "ins-3".length });
    expect(ins3.parallels!.map((p) => [p.name, p.cards])).toEqual([
      ["Gold 3.0", "ins-3-p0".length],
      ["Gold 3.1", "ins-3-p1".length],
      ["Gold 3.2", "ins-3-p2".length],
      ["Gold 3.3", "ins-3-p3".length],
    ]);
    expect(report.variantTypes![1].rows[1].parallels).toBeUndefined();
    expect(client.maxInFlight()).toBeLessThanOrEqual(READ_CONCURRENCY);
  });
});

describe("mapLimit", () => {
  test("keeps results in input order and never runs more than the limit", async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapLimit([...Array(30).keys()], 5, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, (n * 7) % 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([...Array(30).keys()].map((n) => n * 2));
    expect(max).toBe(5);
  });
});
