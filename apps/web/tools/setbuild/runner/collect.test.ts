/**
 * NEO-339 — `apply` with `stopAt: "end"`: every open decision of the run in
 * one report, dependents of an open step blocked without running, siblings
 * carried on; and `stopAt: "first"` exactly as before. Also the new Group
 * Parallels and insert-parallels steps through the engine.
 */
import { describe, expect, test } from "vitest";
import { countOpenDecisions, specConfirmPhrase } from "../service";
import { parseSpec } from "../spec/schema";
import { DECISION_PLACEHOLDER } from "../lib/review";
import { applySpec } from "./apply";
import { FAKE_TARGET, fakeClient, type FakeClient } from "./fake-client";
import { planSpec } from "./plan";

const PATH = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome" };
const SCOPE = "Baseball/2024/Topps/Topps Chrome";
const confirmFor = (raw: unknown) => specConfirmPhrase(FAKE_TARGET, parseSpec(raw));
const NO_REVIEW = { players: [], teams: [], leagues: [] };
const checklist = (expectCards?: number) => ({
  pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" },
  review: NO_REVIEW,
  ...(expectCards !== undefined ? { expectCards } : {}),
});

const sel = (id: string, level: string, value: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  _creationTime: 1,
  level,
  value,
  platformData: {},
  lastUpdated: 1,
  ...extra,
});

/** Which player each row's fetched checklist carries (one card each, both sides). */
const PLAYER: Record<string, string> = { vtB: "Shohei Ohtani", iFS: "Aaron Judge", iYQ: "Bobby Witt Jr." };
const NAME: Record<string, string> = {
  vtB: "Base",
  vtP: "Parallel",
  pS: "Sepia Refractors",
  iFS: "Future Stars",
  iYQ: "Youthquake",
  fsG: "Future Stars Gold",
  yqR: "Youthquake Red",
};

/**
 * Topps Chrome: Base mapped; a Parallel type (Sepia, built from Base); an
 * Insert type whose two rows each hold one parallel. `cards` is the live card
 * count per row; a fetched checklist's one player is always unknown, so its
 * review opens unless the spec answers it.
 */
function world(cards: Record<string, number>): FakeClient {
  const tree: Record<string, unknown[]> = {
    "sport:": [sel("sp", "sport", "Baseball")],
    "year:sp": [sel("yr", "year", "2024")],
    "manufacturer:yr": [sel("mf", "manufacturer", "Topps")],
    "setName:mf": [sel("st", "setName", "Topps Chrome")],
    "variantType:st": [
      sel("vtB", "variantType", "Base", {
        metadata: { isBase: true },
        platformData: { bsc: { b0: "bsc-chrome" }, sportlots: { s0: "sl-chrome" } },
      }),
      sel("vtP", "variantType", "Parallel", { metadata: { variantRole: "parallel" } }),
      sel("vtI", "variantType", "Insert", { metadata: { variantRole: "insert" } }),
    ],
    "insert:vtP": [sel("pS", "insert", "Sepia Refractors", { platformData: { bsc: { b0: "bsc-sepia" } } })],
    "insert:vtI": [
      sel("iFS", "insert", "Future Stars", { platformData: { bsc: { b0: "future-stars" } } }),
      sel("iYQ", "insert", "Youthquake", { platformData: { bsc: { b0: "youthquake" } } }),
    ],
    "parallel:iFS": [sel("fsG", "parallel", "Future Stars Gold", { platformData: { bsc: { b0: "future-stars-gold" } } })],
    "parallel:iYQ": [sel("yqR", "parallel", "Youthquake Red", { platformData: { bsc: { b0: "youthquake-red" } } })],
  };
  const parallelsOf: Record<string, string[]> = { vtP: ["pS"], iFS: ["fsG"], iYQ: ["yqR"] };
  const sourceOf: Record<string, string> = { pS: "vtB", fsG: "iFS", yqR: "iYQ" };
  const candidates = new Map<string, { batchId: string; cards: unknown[] }>();
  const reviewRows: Array<Record<string, unknown>> = [];
  let batch = 0;
  return fakeClient()
    .on("marketplacePause:getPausedPlatforms", [])
    .on("selectorOptions:getSelectorOptions", (a) => tree[`${a.level}:${a.parentId ?? ""}`] ?? [])
    .on("selectorOptions:getAncestorChain", [
      sel("sp", "sport", "Baseball"),
      sel("yr", "year", "2024"),
      sel("mf", "manufacturer", "Topps"),
      sel("st", "setName", "Topps Chrome"),
    ])
    .on("selectorOptions:getInsertTreeByVariantType", (a) =>
      ((tree[`insert:${a.variantTypeId}`] ?? []) as Array<{ _id: string }>).map((insert) => ({
        insert,
        parallels: tree[`parallel:${insert._id}`] ?? [],
      })),
    )
    .on("selectorOptions:getSlotCardCounts", (a) => ({ bsc: {}, sportlots: {}, total: cards[a.selectorOptionId as string] ?? 0 }))
    .on("parallelChecklistBuild:getParallelsForBuild", (a) => {
      const id = a.sourceId as string;
      const source = id === "vtP" ? "vtB" : id;
      return {
        source: { id: source, value: NAME[source], kind: id === "vtP" ? "base" : "insert", hasCards: (cards[source] ?? 0) > 0 },
        parallels: (parallelsOf[id] ?? []).map((p) => ({ _id: p, value: NAME[p], sides: { bsc: true, sportlots: false }, hasCards: (cards[p] ?? 0) > 0 })),
        truncated: false,
      };
    })
    .on("parallelChecklistBuild:buildParallelChecklist", (a) => {
      const id = a.parallelId as string;
      cards[id] = cards[sourceOf[id]];
      return { status: "built", copied: cards[id] };
    })
    .on("checklistCandidates:getReadyCandidates", (a) => {
      const c = candidates.get(a.selectorOptionId as string);
      return { batchId: c?.batchId, total: c?.cards.length ?? 0, ready: c?.cards.length ?? 0, cards: c?.cards ?? [] };
    })
    .on("selectorOptions:fetchCardChecklist", (a) => {
      const id = a.selectorOptionId as string;
      candidates.set(id, {
        batchId: `cb${++batch}`,
        cards: [
          {
            _id: `c-${id}`,
            cardNumber: "1",
            cardName: PLAYER[id],
            platformData: { bsc: { ref: `b-${id}` }, sportlots: { ref: `s-${id}` } },
            bucket: "matched",
            stem: "1",
            teamResolved: true,
          },
        ],
      });
      return { success: true, message: "1 matched", candidateCount: 1, attachedSides: ["bsc", "sportlots"], pausedSides: [] };
    })
    .on("selectorOptions:diffChecklistAgainstExisting", {
      cards: [],
      removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 },
      conflicts: [],
      collisionInsertCount: 0,
    })
    .on("selectorOptions:resolveChecklistEntities", (a) => {
      const id = a.selectorOptionId as string;
      if (!reviewRows.some((r) => r.batchId === `rb-${id}`)) {
        reviewRows.push({
          _id: `rv-${id}`,
          _creationTime: 1,
          selectorOptionId: id,
          batchId: `rb-${id}`,
          kind: "player",
          name: PLAYER[id],
          sportId: "sp",
          sportValue: "Baseball",
          setSportId: "sp",
          setSportValue: "Baseball",
          status: "ready",
        });
      }
      return { unknownPlayers: [PLAYER[id]], unknownTeams: [], batchId: `rb-${id}` };
    })
    .on("entityReviewQueue:getBatch", (a) => structuredClone(reviewRows.filter((r) => r.batchId === a.batchId)))
    .on("entityReviewQueue:stageCareerTeamRows", 0)
    .on("players:nearMatches", []);
}

/** Base checklist and Future Stars' checklist both open a review the spec does not answer. */
function twoReviewsSpec() {
  return {
    version: 1,
    scope: SCOPE,
    steps: [
      {
        kind: "set",
        path: PATH,
        variantTypes: { sync: true },
        base: { map: { bsc: "bsc-chrome", sportlots: "sl-chrome", whenPaused: "bsc-only" }, checklist: checklist() },
        variants: [
          { type: "Parallel", rows: [{ name: "Sepia Refractors", buildFromBase: {} }] },
          {
            type: "Insert",
            rows: [
              { name: "Future Stars", checklist: checklist(), parallels: [{ name: "Future Stars Gold", build: {} }] },
              { name: "Youthquake", checklist: checklist(20), parallels: [{ name: "Youthquake Red", build: {}, expectCards: 20 }] },
            ],
          },
        ],
      },
    ],
  };
}

const WIDE = () => ({ vtB: 0, pS: 0, iFS: 0, iYQ: 20, fsG: 0, yqR: 0 });

describe('apply stopAt: "end" — collect every open decision', () => {
  test("two open checklists come back together, each with its template, and their dependents wait", async () => {
    const raw = twoReviewsSpec();
    const client = world(WIDE());
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });

    expect(r.stops).toEqual([
      { step: 0, reason: "Base: the entity review has rows the spec does not answer" },
      { step: 0, reason: "Insert › Future Stars: the entity review has rows the spec does not answer" },
    ]);
    expect(r.stoppedAt).toEqual(r.stops![0]);
    expect(r.openDecisions.review.players.map((p) => [p.name, p.at])).toEqual([
      ["Shohei Ohtani", "steps[0].base.checklist.review.players"],
      ["Aaron Judge", "steps[0].variants[1].rows[0].checklist.review.players"],
    ]);
    expect(countOpenDecisions(r.openDecisions)).toBe(2);

    // ONE template carrying both fill-ins.
    const tpl = r.template as {
      steps: Array<{ base: { checklist: { review: { players: unknown[] } } }; variants: Array<{ rows: Array<{ checklist: { review: { players: unknown[] } } }> }> }>;
    };
    expect(tpl.steps[0].base.checklist.review.players).toEqual([{ name: "Shohei Ohtani", decision: DECISION_PLACEHOLDER }]);
    expect(tpl.steps[0].variants[1].rows[0].checklist.review.players).toEqual([{ name: "Aaron Judge", decision: DECISION_PLACEHOLDER }]);
    // Both reviews stay open for decide.
    expect(r.sessions.map((s) => s.selectorOptionId)).toEqual(["vtB", "iFS"]);

    // Dependents: Sepia waits on the Base checklist, Future Stars Gold on its insert's.
    const step = (action: string) => r.steps.find((s) => s.action === action);
    expect(step("build Parallel › Sepia Refractors from Base")).toMatchObject({
      status: "blocked",
      detail: "waits: the Base checklist (steps[0].base.checklist)",
    });
    expect(step("build Insert › Future Stars › Future Stars Gold from Insert › Future Stars")).toMatchObject({
      status: "blocked",
      detail: "waits: the Insert › Future Stars checklist (steps[0].variants[1].rows[0].checklist)",
    });
    // The sibling with no open decision ran: Youthquake Red was built from Youthquake.
    expect(step("build Insert › Youthquake › Youthquake Red from Insert › Youthquake")).toMatchObject({ status: "done" });
    expect(r.counts.built).toBe(20);
    expect(client.callsTo("parallelChecklistBuild:buildParallelChecklist").map((c) => c.args)).toEqual([{ parallelId: "yqR" }]);
    expect(client.callsTo("selectorOptions:commitCardChecklist")).toEqual([]);
    expect(client.callsTo("selectorOptions:fetchCardChecklist").map((c) => c.args.selectorOptionId)).toEqual(["vtB", "iFS"]);
  });

  test('stopAt: "first" (and no stopAt) is unchanged: the first open checklist ends the run', async () => {
    const raw = twoReviewsSpec();
    for (const opts of [{ stopAt: "first" as const }, {}]) {
      const client = world(WIDE());
      const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", ...opts });
      expect(r.stoppedAt).toEqual({ step: 0, reason: "Base: the entity review has rows the spec does not answer" });
      expect(r.stops).toBeUndefined();
      expect(r.openDecisions.review.players.map((p) => p.name)).toEqual(["Shohei Ohtani"]);
      expect(r.steps.at(-1)).toMatchObject({ kind: "checklist", status: "blocked" });
      expect(client.callsTo("selectorOptions:fetchCardChecklist").map((c) => c.args.selectorOptionId)).toEqual(["vtB"]);
      expect(client.writes().map((c) => c.fn)).not.toContain("parallelChecklistBuild:buildParallelChecklist");
    }
  });

  test("the confirm phrase does not depend on stopAt", async () => {
    const raw = twoReviewsSpec();
    const client = world(WIDE());
    await expect(applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" })).resolves.toBeTruthy();
    expect((await applySpec(world(WIDE()), FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "" })).confirmPhrase).toBe(confirmFor(raw));
  });
});

describe("Group Parallels and insert parallels through the engine", () => {
  /** Base already built; the Insert type's group names a parallel as a parent. */
  function groupSpec(parent: string) {
    return {
      version: 1,
      scope: SCOPE,
      steps: [
        {
          kind: "set",
          path: PATH,
          variantTypes: { sync: true },
          variants: [
            { type: "Parallel", rows: [{ name: "Sepia Refractors", buildFromBase: {} }] },
            {
              type: "Insert",
              group: { parents: [{ insert: parent, parallels: ["Youthquake Red"] }], expectUngrouped: 0 },
              rows: [{ name: "Youthquake", checklist: checklist(20), parallels: [{ name: "Youthquake Red", build: {} }] }],
            },
          ],
        },
      ],
    };
  }

  test("an open grouping blocks only the type's insert parallels; the checklist and other types carry on", async () => {
    const raw = groupSpec("Future Stars Gold");
    const client = world({ ...WIDE(), vtB: 2 });
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.openDecisions.grouping).toMatchObject([
      { problem: "parent-is-parallel", name: "Future Stars Gold", at: "steps[0].variants[1].group.parents[0].insert" },
    ]);
    expect(r.stops).toHaveLength(1);
    const byAction = Object.fromEntries(r.steps.map((s) => [s.action, s]));
    expect(byAction["build Parallel › Sepia Refractors from Base"]).toMatchObject({ status: "done" });
    expect(byAction["fetch and commit the Insert › Youthquake checklist"]).toMatchObject({ status: "done" });
    expect(byAction["build Insert › Youthquake › Youthquake Red from Insert › Youthquake"]).toMatchObject({
      status: "blocked",
      detail: "waits: Group Parallels for Insert (steps[0].variants[1].group)",
    });
    expect(client.callsTo("selectorOptions:applyParallelGroupings")).toEqual([]);
    const tpl = r.template as { steps: Array<{ variants: Array<{ group: { parents: Array<{ insert: string }> } }> }> };
    expect(tpl.steps[0].variants[1].group.parents[0].insert).toMatch(/^<"Future Stars Gold" is a parallel of "Future Stars"/);
  });

  test("an answered grouping that is already in place is skipped, and expectUngrouped is asserted", async () => {
    // Youthquake Red already sits under Youthquake; Future Stars holds Gold: 0 rows stand alone.
    const raw = groupSpec("Youthquake");
    const client = world({ ...WIDE(), vtB: 2 });
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.stoppedAt).toBeUndefined();
    const byKind = Object.fromEntries(r.steps.map((s) => [s.kind, s]));
    expect(byKind.group).toMatchObject({ status: "done", detail: "already grouped" });
    expect(byKind["expect-ungrouped"]).toMatchObject({ status: "done", detail: "0 now" });
    expect(client.callsTo("parallelChecklistBuild:buildParallelChecklist").map((c) => c.args)).toEqual([
      { parallelId: "pS" },
      { parallelId: "yqR" },
    ]);
  });

  test("plan reports the grouping and the insert parallels without writing", async () => {
    const r = await planSpec(world({ ...WIDE(), vtB: 2 }), FAKE_TARGET, groupSpec("Future Stars Gold"), { pausedPlatforms: "" });
    expect(r.openDecisions.grouping).toHaveLength(1);
    const byAction = Object.fromEntries(r.steps.map((s) => [s.action, s]));
    expect(byAction["build Insert › Youthquake › Youthquake Red from Insert › Youthquake"]).toMatchObject({
      status: "blocked",
      detail: "checked once Group Parallels has its answers",
    });
    const ok = await planSpec(world({ ...WIDE(), vtB: 2 }), FAKE_TARGET, groupSpec("Youthquake"), { pausedPlatforms: "" });
    expect(Object.fromEntries(ok.steps.map((s) => [s.action, s.status]))).toMatchObject({
      "build Insert › Youthquake › Youthquake Red from Insert › Youthquake": "todo",
    });
  });
});
