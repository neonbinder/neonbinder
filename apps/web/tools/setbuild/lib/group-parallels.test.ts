import { describe, expect, test } from "vitest";
import { MAX_PARALLEL_GROUPING_ENTRIES } from "../../../convex/parallelGroupingPlan";
import { PlanWouldWrite, readOnlyClient } from "../runner/read-only-client";
import type { Group } from "../spec/schema";
import { convexCodeError, fakeNbClient, row } from "./fake-nb-client";
import { groupParallels, planGrouping } from "./group-parallels";

const TREE = "selectorOptions:getInsertTreeByVariantType";
const APPLY = "selectorOptions:applyParallelGroupings";
const CTX = { at: "steps[0].variants[1]", path: "Baseball/2026/Bowman/Bowman", type: "Insert" };

type Row = ReturnType<typeof row>;
interface Plan {
  promotions: Array<{ insertId: string; targetInsertId: string }>;
  demotions: Array<{ parallelId: string }>;
  reparentings?: Array<{ parallelId: string; newInsertId: string }>;
}

/**
 * A variant type's rows as the server holds them: `parentOf` maps a parallel
 * to its insert; anything not in it is a top-level insert. The apply handler
 * moves rows the way the mutation does, and refuses the call numbered in
 * `refuse` (1-based) with a ConvexError carrying a sentence.
 */
function world(rows: Row[], parentOf: Record<string, string>, opts: { refuse?: number } = {}) {
  const parent = new Map(Object.entries(parentOf));
  let applyCalls = 0;
  return fakeNbClient({
    [TREE]: () =>
      rows
        .filter((r) => !parent.has(r._id))
        .map((insert) => ({ insert, parallels: rows.filter((p) => parent.get(p._id) === insert._id) })),
    [APPLY]: (a) => {
      applyCalls += 1;
      if (applyCalls === opts.refuse) {
        const err = convexCodeError("refused") as Error & { data: unknown };
        err.data = '"Gold" is already a parallel of "Stars".';
        throw err;
      }
      const plan = a as unknown as Plan;
      for (const p of plan.demotions) parent.delete(p.parallelId);
      for (const r of plan.reparentings ?? []) parent.set(r.parallelId, r.newInsertId);
      for (const p of plan.promotions) parent.set(p.insertId, p.targetInsertId);
      return {
        success: true,
        promoted: plan.promotions.length,
        demoted: plan.demotions.length,
        reparented: (plan.reparentings ?? []).length,
      };
    },
  });
}

const ins = (id: string, value: string, extra: Record<string, unknown> = {}) => row(id, "insert", value, extra);
const par = (id: string, value: string, extra: Record<string, unknown> = {}) => row(id, "parallel", value, extra);

describe("groupParallels", () => {
  test("a top-level row is promoted and a parallel under another insert is reparented, in one save", async () => {
    const client = world(
      [ins("stars", "Stars"), ins("gold", "Stars Gold"), ins("chrome", "Chrome"), par("red", "Stars Red")],
      { red: "chrome" },
    );
    const group: Group = { parents: [{ insert: "Stars", parallels: ["Stars Gold", "Stars Red"] }] };
    const r = await groupParallels(client, "vt" as never, group, CTX);
    expect(r).toEqual({ outcome: "grouped", moved: 2, saves: 1, ungrouped: 1 });
    expect(client.callsTo(APPLY).map((c) => c.args)).toEqual([
      {
        variantTypeId: "vt",
        promotions: [{ insertId: "gold", targetInsertId: "stars" }],
        demotions: [],
        reparentings: [{ parallelId: "red", newInsertId: "stars" }],
      },
    ]);
  });

  test("already grouped: nothing is sent, and a re-run of a finished grouping is skipped", async () => {
    const client = world([ins("stars", "Stars"), par("gold", "Stars Gold")], { gold: "stars" });
    const group: Group = { parents: [{ insert: "Stars", parallels: ["Stars Gold"] }] };
    expect(await groupParallels(client, "vt" as never, group, CTX)).toEqual({ outcome: "skipped", ungrouped: 0 });
    expect(client.callsTo(APPLY)).toEqual([]);

    const fresh = world([ins("stars", "Stars"), ins("gold", "Stars Gold")], {});
    const once = { parents: [{ insert: "Stars", parallels: ["Stars Gold"] }] };
    expect((await groupParallels(fresh, "vt" as never, once, CTX)).outcome).toBe("grouped");
    expect((await groupParallels(fresh, "vt" as never, once, CTX)).outcome).toBe("skipped");
    expect(fresh.callsTo(APPLY)).toHaveLength(1);
  });

  test("rows the spec does not name stay where they are: no prefix suggestion is taken", async () => {
    // "Stars Blue" word-prefixes "Stars" exactly like "Stars Gold"; the dialog would suggest it.
    const client = world([ins("stars", "Stars"), ins("gold", "Stars Gold"), ins("blue", "Stars Blue")], {});
    const r = await groupParallels(client, "vt" as never, { parents: [{ insert: "Stars", parallels: ["Stars Gold"] }] }, CTX);
    expect(r).toMatchObject({ outcome: "grouped", moved: 1, ungrouped: 1 });
    expect(client.callsTo(APPLY)[0].args.promotions).toEqual([{ insertId: "gold", targetInsertId: "stars" }]);
  });

  test("an insert named as the parent that is itself a parallel is an open decision; nothing is sent", async () => {
    const client = world([ins("chrome", "Chrome"), par("red", "Chrome Red"), ins("redgold", "Chrome Red Gold")], {
      red: "chrome",
    });
    const r = await groupParallels(client, "vt" as never, { parents: [{ insert: "Chrome Red", parallels: ["Chrome Red Gold"] }] }, CTX);
    expect(r).toMatchObject({
      outcome: "open",
      names: [],
      grouping: [
        {
          at: "steps[0].variants[1].group.parents[0].insert",
          problem: "parent-is-parallel",
          name: "Chrome Red",
          path: CTX.path,
          type: "Insert",
        },
      ],
    });
    expect(r.outcome === "open" && r.fills[0]).toMatchObject({ at: "steps[0].variants[1].group.parents[0].insert" });
    expect(client.callsTo(APPLY)).toEqual([]);
  });

  test.each([
    [
      "a row named as a parallel twice",
      { parents: [{ insert: "Stars", parallels: ["Stars Gold"] }, { insert: "Chrome", parallels: ["Stars Gold"] }] },
      "named-twice",
      "steps[0].variants[1].group.parents[1].parallels[0]",
    ],
    [
      "a row named as an insert and as a parallel",
      { parents: [{ insert: "Stars", parallels: ["Stars Gold"] }, { insert: "Stars Gold", parallels: ["Chrome"] }] },
      "chain",
      "steps[0].variants[1].group.parents[1].insert",
    ],
    [
      "a parallel that holds parallels of its own",
      { parents: [{ insert: "Stars", parallels: ["Prizm"] }] },
      "child-holds-parallels",
      "steps[0].variants[1].group.parents[0].parallels[0]",
    ],
    ["a row under itself", { parents: [{ insert: "Stars", parallels: ["Stars"] }] }, "self", "steps[0].variants[1].group.parents[0].parallels[0]"],
  ])("%s is an open decision", async (_label, group, problem, at) => {
    const client = world(
      [ins("stars", "Stars"), ins("gold", "Stars Gold"), ins("chrome", "Chrome"), ins("prizm", "Prizm"), par("pg", "Prizm Gold")],
      { pg: "prizm" },
    );
    const r = await groupParallels(client, "vt" as never, group as Group, CTX);
    expect(r.outcome).toBe("open");
    expect(r.outcome === "open" && r.grouping.map((g) => [g.problem, g.at])).toContainEqual([problem, at]);
    expect(client.callsTo(APPLY)).toEqual([]);
  });

  test("by-id refs resolve through the rows' platform slots, grouped rows included", async () => {
    const client = world(
      [
        ins("stars", "Stars", { platformData: { bsc: { b0: "stars-slug" } } }),
        ins("gold", "Stars Gold Renamed", { platformData: { sportlots: { s0: "377920" } } }),
        ins("chrome", "Chrome"),
        par("red", "Red", { platformData: { bsc: { b0: "stars-red" } } }),
      ],
      { red: "chrome" },
    );
    const group: Group = { parents: [{ insert: { bsc: "stars-slug" }, parallels: [{ sportlots: "377920" }, { bsc: "stars-red" }] }] };
    const r = await groupParallels(client, "vt" as never, group, CTX);
    expect(r).toMatchObject({ outcome: "grouped", moved: 2 });
    expect(client.callsTo(APPLY)[0].args).toMatchObject({
      promotions: [{ insertId: "gold", targetInsertId: "stars" }],
      reparentings: [{ parallelId: "red", newInsertId: "stars" }],
    });
  });

  test("a name or id that matches zero or several rows is an open name with every candidate; never picked by position", async () => {
    const client = world(
      [
        ins("stars", "Stars"),
        ins("a", "Stars Gold", { platformData: { bsc: { b0: "dup" } } }),
        ins("chrome", "Chrome"),
        par("b", "Stars Gold", { platformData: { bsc: { b0: "dup" } } }),
      ],
      { b: "chrome" },
    );
    const group: Group = { parents: [{ insert: "Stars", parallels: ["Stars Gold", { bsc: "dup" }, { sportlots: "nope" }] }] };
    const r = await groupParallels(client, "vt" as never, group, CTX);
    expect(r.outcome).toBe("open");
    if (r.outcome !== "open") return;
    expect(r.names.map((n) => [n.at, n.kind, n.candidates.map((c) => c.id)])).toEqual([
      ["steps[0].variants[1].group.parents[0].parallels[0]", "row", ["a", "b"]],
      ["steps[0].variants[1].group.parents[0].parallels[1]", "BSC id", ["a", "b"]],
      ["steps[0].variants[1].group.parents[0].parallels[2]", "SportLots id", []],
    ]);
    expect(r.names[0].candidates.map((c) => c.detail)).toEqual(["insert", "parallel of Chrome"]);
    expect(client.callsTo(APPLY)).toEqual([]);
  });

  test("a plan past the server's cap goes in chunks, sequentially; a refused chunk reports what landed", async () => {
    const n = MAX_PARALLEL_GROUPING_ENTRIES + 5;
    const kids = Array.from({ length: n }, (_, k) => ins(`k${k}`, `Stars Kid ${k}`));
    const group: Group = { parents: [{ insert: "Stars", parallels: kids.map((k) => k.value) }] };

    const ok = world([ins("stars", "Stars"), ...kids], {});
    expect(await groupParallels(ok, "vt" as never, group, CTX)).toEqual({ outcome: "grouped", moved: n, saves: 2, ungrouped: 0 });
    expect(ok.callsTo(APPLY).map((c) => (c.args.promotions as unknown[]).length)).toEqual([MAX_PARALLEL_GROUPING_ENTRIES, 5]);

    const refused = world([ins("stars", "Stars"), ...kids], {}, { refuse: 2 });
    const r = await groupParallels(refused, "vt" as never, group, CTX);
    expect(r.outcome).toBe("open");
    if (r.outcome !== "open") return;
    expect(r.grouping).toHaveLength(1);
    expect(r.grouping[0]).toMatchObject({ problem: "refused", at: "steps[0].variants[1].group", name: "Insert" });
    expect(r.grouping[0].detail).toMatch(/refused save 2 of 2: "Gold" is already a parallel of "Stars"\./);
    expect(r.grouping[0].detail).toMatch(/1 earlier save landed \(200 rows moved\)/);
    expect(refused.callsTo(APPLY)).toHaveLength(2);

    // A re-run reads the tree again and sends only what did not land.
    const again = await groupParallels(refused, "vt" as never, group, CTX);
    expect(again).toMatchObject({ outcome: "grouped", moved: 5, saves: 1 });
  });

  test("a refusal on the first save says nothing moved", async () => {
    const client = world([ins("stars", "Stars"), ins("gold", "Stars Gold")], {}, { refuse: 1 });
    const r = await groupParallels(client, "vt" as never, { parents: [{ insert: "Stars", parallels: ["Stars Gold"] }] }, CTX);
    expect(r.outcome === "open" && r.grouping[0].detail).toMatch(/refused save 1 of 1: .* Nothing was moved\.$/);
  });

  test("plan: planGrouping reports the moves and the projected ungrouped count without writing; on readOnlyClient groupParallels stops before the mutation", async () => {
    const client = world([ins("stars", "Stars"), ins("gold", "Stars Gold"), ins("chrome", "Chrome")], {});
    const group: Group = { parents: [{ insert: "Stars", parallels: ["Stars Gold"] }] };
    const p = await planGrouping(client, "vt" as never, group, CTX);
    expect(p).toMatchObject({ outcome: "todo", moves: 1, ungrouped: 1 });
    await expect(groupParallels(readOnlyClient(client), "vt" as never, group, CTX)).rejects.toBeInstanceOf(PlanWouldWrite);
    expect(client.callsTo(APPLY)).toEqual([]);
  });
});
