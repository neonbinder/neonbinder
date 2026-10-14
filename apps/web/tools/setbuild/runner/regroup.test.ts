/**
 * NEO-339 — re-planning a spec after apply ran its sync AND its Group
 * Parallels must find everything done.
 *
 * Live repro (2014 Topps Chrome): apply saved the Insert sync's sets, the
 * `group` step moved some of them under their parent inserts, and a plan of
 * the identical spec then asked for those sets' ids again ("reconcile-id",
 * no candidates), because the sync only looked among TOP-LEVEL rows.
 *
 * The world below is one stateful deployment: the sync's store creates rows,
 * Group Parallels moves them, and every read sees the result.
 */
import { describe, expect, test } from "vitest";
import { countOpenDecisions, specConfirmPhrase } from "../service";
import { parseSpec } from "../spec/schema";
import { applySpec } from "./apply";
import { FAKE_TARGET, fakeClient, type FakeClient } from "./fake-client";
import { planSpec } from "./plan";

const PATH = { sport: "Baseball", year: "2014", manufacturer: "Topps", set: "Topps Chrome" };
const SCOPE = "Baseball/2014/Topps/Topps Chrome";
const STORE = "setReconciliation:storeReconciledOptions";
const FETCH = "setReconciliation:fetchRawOptions";
const GROUP = "selectorOptions:applyParallelGroupings";

interface Row {
  _id: string;
  _creationTime: number;
  level: string;
  value: string;
  parentId?: string;
  platformData: Record<string, Record<string, string>>;
  lastUpdated: number;
}

const sel = (id: string, level: string, value: string, parentId?: string, extra: Partial<Row> = {}): Row => ({
  _id: id,
  _creationTime: 1,
  level,
  value,
  ...(parentId ? { parentId } : {}),
  platformData: {},
  lastUpdated: 1,
  ...extra,
});

const slots = (ids: readonly string[] | undefined) =>
  Object.fromEntries((ids ?? []).map((id, i) => [`s${i}`, id]));

/** The Insert sync's spec, its Group Parallels, and the rows it finds afterwards. */
function spec(group?: Record<string, unknown>) {
  return {
    version: 1,
    scope: SCOPE,
    steps: [
      {
        kind: "set",
        path: PATH,
        variantTypes: { sync: true },
        variants: [
          {
            type: "Insert",
            sync: {
              pairs: [
                { name: "Future Stars", bsc: ["fs"], sportlots: ["9001"] },
                { name: "Future Stars Refractors", bsc: ["fsr"], sportlots: ["9002"] },
                { name: "Stars of MLB", bsc: ["smlb"], sportlots: ["9010"] },
              ],
              pending: [
                { side: "bsc", id: "cp", decision: "own-set" },
                { side: "sportlots", id: "9030", decision: "leave" },
              ],
            },
            expectRows: 4,
            group: group ?? {
              parents: [{ insert: "Future Stars", parallels: ["Future Stars Refractors", { bsc: "cp" }] }],
              topLevel: ["Stars of MLB"],
              expectUngrouped: 1,
            },
            rows: [
              { name: "Future Stars", parallels: [{ name: "Future Stars Refractors" }, { name: "Chrome Prospects" }] },
              { name: "Stars of MLB" },
            ],
          },
        ],
      },
    ],
  };
}

const confirmFor = (raw: unknown) => specConfirmPhrase(FAKE_TARGET, parseSpec(raw));

/** Baseball › 2014 › Topps › Topps Chrome with a mapped Base and an empty Insert type. */
function world(initial: Row[] = []): FakeClient & { rows: Row[] } {
  const rows: Row[] = [
    sel("sp", "sport", "Baseball"),
    sel("yr", "year", "2014", "sp"),
    sel("mf", "manufacturer", "Topps", "yr"),
    sel("st", "setName", "Topps Chrome", "mf"),
    sel("vtB", "variantType", "Base", "st", {
      platformData: { bsc: { s0: "bsc-chrome" }, sportlots: { s0: "sl-chrome" } },
    }),
    sel("vtI", "variantType", "Insert", "st"),
    ...initial,
  ];
  let seq = 0;
  const item = (value: string, platformValue: string) => ({ value, platformValue });
  const fs = item("Future Stars", "fs");
  const fsr = item("Future Stars Refractors", "fsr");
  const smlb = item("Stars of MLB", "smlb");
  const cp = item("Chrome Prospects", "cp");
  const fsS = item("Topps Chrome Future Stars", "9001");
  const fsrS = item("Topps Chrome Future Stars Refractors", "9002");
  const smlbS = item("Topps Chrome Stars of MLB", "9010");
  const bowman = item("Bowman Chrome", "9030");
  const tree = () =>
    rows
      .filter((r) => r.level === "insert" && r.parentId === "vtI")
      .map((insert) => ({ insert, parallels: rows.filter((p) => p.level === "parallel" && p.parentId === insert._id) }));
  const client = fakeClient()
    .on("marketplacePause:getPausedPlatforms", [])
    .on("selectorOptions:getSelectorOptions", (a) =>
      structuredClone(rows.filter((r) => r.level === a.level && (r.parentId ?? "") === (a.parentId ?? ""))),
    )
    .on("selectorOptions:getAncestorChain", () => structuredClone(rows.filter((r) => ["sp", "yr", "mf", "st", "vtI"].includes(r._id))))
    .on("selectorOptions:getBaseVariantBySet", () => structuredClone({ ...rows.find((r) => r._id === "vtB")!, platformLabels: { sportlots: { s0: "Topps Chrome" } } }))
    .on("selectorOptions:getInsertTreeByVariantType", () => structuredClone(tree()))
    .on("setParallelConversion:getBrandSlHolders", { rows: [], truncated: false })
    .on("selectorOptions:getUsedInsertIdentifiersBySet", { values: [], slPlatformValues: [], bscPlatformValues: [] })
    .on(FETCH, {
      success: true,
      slCandidates: [],
      errors: [],
      skippedSides: [],
      pausedSides: [],
      twinIds: { bsc: [], sportlots: [] },
      bscOptions: [fs, fsr, smlb, cp],
      slOptions: [fsS, fsrS, smlbS, bowman],
      autoMatched: [
        { displayName: "Future Stars", bsc: fs, sl: fsS, confidence: 0.9 },
        { displayName: "Future Stars Refractors", bsc: fsr, sl: fsrS, confidence: 0.9 },
        { displayName: "Stars of MLB", bsc: smlb, sl: smlbS, confidence: 0.9 },
      ],
      unmatchedBsc: [cp],
      unmatchedSl: [bowman],
    })
    .on(STORE, (a) => {
      const items = a.reconciledItems as Array<{
        value: string;
        existingId?: string;
        platformData: { bsc?: string[]; sportlots?: string[] };
      }>;
      for (const it of items) {
        const platformData = {
          ...(it.platformData.bsc?.length ? { bsc: slots(it.platformData.bsc) } : {}),
          ...(it.platformData.sportlots?.length ? { sportlots: slots(it.platformData.sportlots) } : {}),
        };
        const existing = it.existingId ? rows.find((r) => r._id === it.existingId) : undefined;
        if (existing) Object.assign(existing, { value: it.value, platformData });
        else rows.push(sel(`ins${++seq}`, "insert", it.value, a.parentId as string, { platformData }));
      }
      return { success: true, message: "ok", optionsCount: items.length, hasMore: false };
    })
    .on(GROUP, (a) => {
      const plan = a as {
        promotions: Array<{ insertId: string; targetInsertId: string }>;
        demotions: Array<{ parallelId: string }>;
        reparentings?: Array<{ parallelId: string; newInsertId: string }>;
      };
      const at = (id: string) => rows.find((r) => r._id === id)!;
      for (const d of plan.demotions) Object.assign(at(d.parallelId), { level: "insert", parentId: "vtI" });
      for (const r of plan.reparentings ?? []) at(r.parallelId).parentId = r.newInsertId;
      for (const p of plan.promotions) Object.assign(at(p.insertId), { level: "parallel", parentId: p.targetInsertId });
      return {
        success: true,
        promoted: plan.promotions.length,
        demoted: plan.demotions.length,
        reparented: (plan.reparentings ?? []).length,
      };
    });
  return Object.assign(client, { rows });
}

/** Every Insert-type row, top-level and grouped, as `name ← parent` lines. */
function insertRows(w: { rows: Row[] }): string[] {
  const nameOf = (id?: string) => w.rows.find((r) => r._id === id)?.value ?? "";
  return w.rows
    .filter((r) => (r.level === "insert" && r.parentId === "vtI") || r.level === "parallel")
    .map((r) => (r.level === "parallel" ? `${r.value} ← ${nameOf(r.parentId)}` : r.value))
    .sort();
}

const GROUPED = [
  "Chrome Prospects ← Future Stars",
  "Future Stars",
  "Future Stars Refractors ← Future Stars",
  "Stars of MLB",
];

describe("re-planning after apply ran Group Parallels (2014 Topps Chrome repro)", () => {
  test("the identical spec plans with no open decision, every step done, and a re-apply writes nothing", async () => {
    const w = world();
    const raw = spec();
    const first = await applySpec(w, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "" });
    expect(first.stoppedAt).toBeUndefined();
    expect(first.counts).toMatchObject({ reconciled: 4, grouped: 2 });
    expect(insertRows(w)).toEqual(GROUPED);

    const fetchesBefore = w.callsTo(FETCH).length;
    const plan = await planSpec(w, FAKE_TARGET, raw, { pausedPlatforms: "" });
    expect(plan.openDecisions.names).toEqual([]);
    expect(plan.openDecisions.reconcile).toEqual([]);
    expect(plan.openDecisions.grouping).toEqual([]);
    expect(countOpenDecisions(plan.openDecisions)).toBe(0);
    expect(plan.template).toBeNull();
    expect(plan.steps.filter((s) => s.status !== "done")).toEqual([]);
    expect(plan.steps.find((s) => s.kind === "reconcile")).toMatchObject({ status: "done", detail: expect.stringMatching(/^already-saved/) });
    expect(plan.steps.find((s) => s.kind === "group")).toMatchObject({ status: "done", detail: "already grouped" });
    // Settled from the rows alone: no marketplace call.
    expect(w.callsTo(FETCH).length).toBe(fetchesBefore);

    const writesBefore = w.writes().length;
    const again = await applySpec(w, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "" });
    expect(again.stoppedAt).toBeUndefined();
    expect(again.counts).toMatchObject({ reconciled: 0, grouped: 0 });
    expect(w.writes().length).toBe(writesBefore);
    // No duplicate: the grouped rows were not re-created at the top level.
    expect(insertRows(w)).toEqual(GROUPED);
  });

  test("group.topLevel: a grouped row the spec names there is moved out once, then the spec plans done", async () => {
    // An operator grouped "Stars of MLB" under "Future Stars" before the spec ran.
    const w = world([
      sel("fsRow", "insert", "Future Stars", "vtI", { platformData: { bsc: { s0: "fs" }, sportlots: { s0: "9001" } } }),
      sel("smRow", "parallel", "Stars of MLB", "fsRow", { platformData: { bsc: { s0: "smlb" }, sportlots: { s0: "9010" } } }),
    ]);
    const raw = spec();
    const first = await applySpec(w, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "" });
    expect(first.stoppedAt).toBeUndefined();
    // The grouped row already carried its pair: the sync did not send it, so did not re-create it.
    const sent = w.callsTo(STORE).flatMap((c) => c.args.reconciledItems as Array<{ value: string; platformData: { bsc?: string[] } }>);
    expect(sent.map((i) => i.value).sort()).toEqual(["Chrome Prospects", "Future Stars", "Future Stars Refractors"]);
    expect(sent.flatMap((i) => i.platformData.bsc ?? [])).not.toContain("smlb");
    expect(first.steps.find((s) => s.kind === "reconcile")?.detail).toContain("1 already saved on grouped parallel(s)");
    expect(first.counts.grouped).toBe(3);
    expect(w.callsTo(GROUP)[0].args).toMatchObject({ demotions: [{ parallelId: "smRow" }] });
    expect(insertRows(w)).toEqual(GROUPED);

    const plan = await planSpec(w, FAKE_TARGET, raw, { pausedPlatforms: "" });
    expect(countOpenDecisions(plan.openDecisions)).toBe(0);
    expect(plan.steps.filter((s) => s.status !== "done")).toEqual([]);
  });

  test("a grouped row holding only SOME of a pair's ids is still the open decision it was", async () => {
    // "Future Stars Refractors" grouped, carrying the BSC id but a different SportLots id.
    const w = world([
      sel("fsRow", "insert", "Future Stars", "vtI", { platformData: { bsc: { s0: "fs" }, sportlots: { s0: "9001" } } }),
      sel("fsrRow", "parallel", "Future Stars Refractors", "fsRow", { platformData: { bsc: { s0: "fsr" }, sportlots: { s0: "9099" } } }),
    ]);
    const plan = await planSpec(w, FAKE_TARGET, spec(), { pausedPlatforms: "" });
    expect(plan.openDecisions.names).toContainEqual(
      expect.objectContaining({ at: "steps[0].variants[0].sync.pairs[1].bsc", kind: "reconcile-id", name: "fsr" }),
    );
  });
});
