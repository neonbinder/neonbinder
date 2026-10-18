/**
 * NEO-339 — `apply` with `stopAt: "end"`: every open decision of the run in
 * one report, dependents of an open step blocked without running, siblings
 * carried on; and `stopAt: "first"` exactly as before. Also the new Group
 * Parallels and insert-parallels steps through the engine.
 */
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { countOpenDecisions, specConfirmPhrase } from "../service";
import { parseSpec } from "../spec/schema";
import { DECISION_PLACEHOLDER } from "../lib/review";
import { applySpec } from "./apply";
import { noSharedNumbers, RunFailed } from "./engine";
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
function world(cards: Record<string, number>, tweak?: (tree: Record<string, unknown[]>) => void): FakeClient {
  const tree: Record<string, unknown[]> = {
    "sport:": [sel("sp", "sport", "Baseball")],
    "year:sp": [sel("yr", "year", "2024")],
    "manufacturer:yr": [sel("mf", "manufacturer", "Topps")],
    "setName:mf": [sel("st", "setName", "Topps Chrome")],
    "variantType:st": [
      sel("vtB", "variantType", "Base", {
        platformData: { bsc: { b0: "bsc-chrome" }, sportlots: { s0: "sl-chrome" } },
      }),
      sel("vtP", "variantType", "Parallel"),
      sel("vtI", "variantType", "Insert"),
    ],
    "insert:vtP": [sel("pS", "insert", "Sepia Refractors", { platformData: { bsc: { b0: "bsc-sepia" } } })],
    "insert:vtI": [
      sel("iFS", "insert", "Future Stars", { platformData: { bsc: { b0: "future-stars" } } }),
      sel("iYQ", "insert", "Youthquake", { platformData: { bsc: { b0: "youthquake" } } }),
    ],
    "parallel:iFS": [sel("fsG", "parallel", "Future Stars Gold", { platformData: { bsc: { b0: "future-stars-gold" } } })],
    "parallel:iYQ": [sel("yqR", "parallel", "Youthquake Red", { platformData: { bsc: { b0: "youthquake-red" } } })],
  };
  tweak?.(tree);
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

describe("a parallel build that shares no card number with its source (NEO-339: 1989 Topps Chrome Autographs)", () => {
  /** Youthquake Red already sits under Youthquake (the group answer is in place); Sepia is built from Base. */
  function spec() {
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
              group: { parents: [{ insert: "Youthquake", parallels: ["Youthquake Red"] }] },
              rows: [{ name: "Youthquake", checklist: checklist(20), parallels: [{ name: "Youthquake Red", build: {} }] }],
            },
          ],
        },
      ],
    };
  }
  /** The server's answer for a build: `copied` cards linked, `listed` of the parallel's own cards matched nothing. */
  const built = (copied: number, listed: { bsc?: number; sportlots?: number } = {}) => ({
    status: "built",
    copied,
    extraOnMarketplace: {
      bsc: { count: listed.bsc ?? 0, cards: [] },
      sportlots: { count: listed.sportlots ?? 0, cards: [] },
    },
  });
  /** `world`, with Youthquake Red's build answered by `answer`; every other build copies its source as before. */
  function worldWith(answer: ReturnType<typeof built>) {
    const cards = { ...WIDE(), vtB: 2 } as Record<string, number>;
    const client = world(cards);
    client.on("parallelChecklistBuild:buildParallelChecklist", (a) => {
      const id = a.parallelId as string;
      if (id === "yqR") {
        cards.yqR = answer.copied;
        return answer;
      }
      cards[id] = cards.vtB;
      return built(cards[id]);
    });
    return client;
  }
  const RED = "build Insert › Youthquake › Youthquake Red from Insert › Youthquake";

  test("zero overlap while the marketplace returned cards: an open decision, not done; the run carries on", async () => {
    const raw = spec();
    const client = worldWith(built(0, { bsc: 3, sportlots: 2 }));
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    const byAction = Object.fromEntries(r.steps.map((s) => [s.action, s]));
    expect(byAction[RED]).toMatchObject({ status: "blocked", detail: '"Youthquake Red" shares no card numbers with "Youthquake"' });
    expect(byAction["build Parallel › Sepia Refractors from Base"]).toMatchObject({ status: "done" });
    expect(r.openDecisions.grouping).toEqual([
      {
        at: "steps[0].variants[1].rows[0].parallels[0]",
        path: SCOPE,
        type: "Insert",
        problem: "no-shared-numbers",
        name: "Youthquake Red",
        detail:
          '"Youthquake Red" lists 5 marketplace cards and none share a number with "Youthquake", so it is probably its own insert, not a parallel. ' +
          "To keep it its own set: move it from steps[0].variants[1].group.parents to steps[0].variants[1].group.topLevel, " +
          'remove it from "Youthquake"\'s parallels, and give it its own row.',
      },
    ]);
    expect(countOpenDecisions(r.openDecisions)).toBe(1);
    expect(r.stops).toEqual([{ step: 0, reason: '"Youthquake Red" shares no card numbers with "Youthquake"' }]);
    expect(r.counts.built).toBe(2);
    const tpl = r.template as { steps: Array<{ variants: Array<{ rows: Array<{ parallels: unknown[] }> }> }> };
    expect(tpl.steps[0].variants[1].rows[0].parallels[0]).toMatch(/^<"Youthquake Red" shares no card numbers with "Youthquake": probably its own insert\./);
  });

  test("a parallel of Base: the link is appended to the Set Builder sentence; with none the sentence ends as before", () => {
    const link = "https://app.example.test/admin/set-builder?sport=sp&year=yr&brand=mf&set=st&type=vtP&insert=pS";
    const detail = noSharedNumbers("Sepia", "Base", 2, { type: "Parallel", link }).detail;
    expect(detail.slice(detail.indexOf("done in the Set Builder"))).toBe(`done in the Set Builder: ${link}`);
    expect(noSharedNumbers("Sepia", "Base", 2, { type: "Parallel" }).detail).toMatch(/done in the Set Builder\.$/);
  });

  test("a one-card listing reads in the singular", () => {
    expect(noSharedNumbers("Gold Auto", "Chrome", 1, { type: "Insert", groupAt: "g" }).detail).toMatch(
      /^"Gold Auto" lists 1 marketplace card and it shares no number with "Chrome", so/,
    );
  });

  test('stopAt "first" stops there, like every other open decision', async () => {
    const raw = spec();
    const client = worldWith(built(0, { sportlots: 5 }));
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "first" });
    expect(r.stoppedAt).toEqual({ step: 0, reason: '"Youthquake Red" shares no card numbers with "Youthquake"' });
    expect(r.openDecisions.grouping.map((g) => g.problem)).toEqual(["no-shared-numbers"]);
  });

  test("a spec that expects cards still gets the reason, not a count mismatch", async () => {
    const raw = spec();
    const insertRow = raw.steps[0].variants[1].rows[0] as { parallels: Array<Record<string, unknown>> };
    insertRow.parallels = [{ name: "Youthquake Red", build: {}, expectCards: 20 }];
    const client = worldWith(built(0, { bsc: 5 }));
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.openDecisions.grouping.map((g) => g.problem)).toEqual(["no-shared-numbers"]);
  });

  test("partial overlap is a real subset (a short-print parallel): done", async () => {
    const raw = spec();
    const client = worldWith(built(20, { bsc: 30 }));
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.stops).toBeUndefined();
    expect(Object.fromEntries(r.steps.map((s) => [s.action, s]))[RED]).toMatchObject({ status: "done", detail: "built 20, holds 20" });
    expect(countOpenDecisions(r.openDecisions)).toBe(0);
  });

  test("zero marketplace cards: unchanged, done with 0 built", async () => {
    const raw = spec();
    const client = worldWith(built(0));
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.stops).toBeUndefined();
    expect(Object.fromEntries(r.steps.map((s) => [s.action, s]))[RED]).toMatchObject({ status: "done", detail: "built 0, holds 0" });
  });

  test("a parallel of Base that shares no number with Base is flagged too, its fill-in on buildFromBase", async () => {
    const raw = spec();
    const cards = { ...WIDE(), vtB: 2 } as Record<string, number>;
    const client = world(cards);
    client.on("parallelChecklistBuild:buildParallelChecklist", (a) => {
      const id = a.parallelId as string;
      if (id === "pS") return built(0, { bsc: 4 });
      cards[id] = 20;
      return built(20);
    });
    const SET_CHAIN = [sel("sp", "sport", "Baseball"), sel("yr", "year", "2024"), sel("mf", "manufacturer", "Topps"), sel("st", "setName", "Topps Chrome")];
    client.on("selectorOptions:getAncestorChain", (a) =>
      a.id === "pS" ? [...SET_CHAIN, sel("vtP", "variantType", "Parallel"), sel("pS", "insert", "Sepia Refractors")] : SET_CHAIN,
    );
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.openDecisions.grouping).toMatchObject([
      { at: "steps[0].variants[0].rows[0]", type: "Parallel", problem: "no-shared-numbers", name: "Sepia Refractors" },
    ]);
    expect(r.openDecisions.grouping[0].detail).toBe(
      '"Sepia Refractors" lists 4 marketplace cards and none share a number with "Base", so it is probably an insert, not a parallel of "Base". ' +
        "Remove its buildFromBase; moving it to an insert type is done in the Set Builder: " +
        "/admin/set-builder?sport=sp&year=yr&brand=mf&set=st&type=vtP&insert=pS",
    );
    const tpl = r.template as { steps: Array<{ variants: Array<{ rows: Array<{ buildFromBase: unknown }> }> }> };
    expect(tpl.steps[0].variants[0].rows[0].buildFromBase).toBe('<"Sepia Refractors" shares no card numbers with "Base": probably an insert. Remove buildFromBase>');
  });

  test("the link belongs to a parallel of Base only: an insert's parallel carries none and costs no ancestor read", async () => {
    const raw = spec();
    const cards = { ...WIDE(), vtB: 2 } as Record<string, number>;
    const client = world(cards);
    // Both the parallel of Base (Sepia) and the insert's parallel (Youthquake Red) share no number with their sources.
    client.on("parallelChecklistBuild:buildParallelChecklist", (a) => {
      cards[a.parallelId as string] = 0;
      return built(0, { bsc: a.parallelId === "pS" ? 4 : 3 });
    });
    const SET_CHAIN = [sel("sp", "sport", "Baseball"), sel("yr", "year", "2024"), sel("mf", "manufacturer", "Topps"), sel("st", "setName", "Topps Chrome")];
    client.on("selectorOptions:getAncestorChain", (a) =>
      a.id === "pS"
        ? [...SET_CHAIN, sel("vtP", "variantType", "Parallel"), sel("pS", "insert", "Sepia Refractors")]
        : a.id === "yqR"
          ? [...SET_CHAIN, sel("vtI", "variantType", "Insert"), sel("iYQ", "insert", "Youthquake"), sel("yqR", "parallel", "Youthquake Red")]
          : SET_CHAIN,
    );
    // The tool was given the app origin: a link is absolute on it.
    Object.assign(client, { target: { ...FAKE_TARGET, appOrigin: "https://app.example.test" } });
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });

    const grouping = Object.fromEntries(r.openDecisions.grouping.map((g) => [g.name, g]));
    expect(Object.keys(grouping).sort()).toEqual(["Sepia Refractors", "Youthquake Red"]);
    // Base's parallel: the sentence ends on its own, absolute, Set Builder link (root-first ids through the parallel's row).
    expect(grouping["Sepia Refractors"].detail).toMatch(
      /done in the Set Builder: https:\/\/app\.example\.test\/admin\/set-builder\?sport=sp&year=yr&brand=mf&set=st&type=vtP&insert=pS$/,
    );
    // The insert's: answered in the spec, so no link and no mention of the Set Builder.
    expect(grouping["Youthquake Red"].detail).not.toMatch(/set-builder|Set Builder|https?:/);
    // The link cost exactly one ancestor read, for the parallel of Base.
    const ancestorReads = client.callsTo("selectorOptions:getAncestorChain").map((c) => c.args.id);
    expect(ancestorReads.filter((id) => id === "pS")).toHaveLength(1);
    expect(ancestorReads).not.toContain("yqR");
    expect(r.openDecisions.grouping).toHaveLength(2);
  });
});

/**
 * Security audit S2 — the gating rows of the engine's table that had no test,
 * and the duplicate-set-step case: the gate state is run-level, keyed by the
 * folded set path, so a second step naming the same set still waits.
 */
describe('stopAt: "end" — what waits on what', () => {
  /** `fetchRawOptions`: the Base picker's list under vtB; under any other type, one BSC and one SportLots set. */
  function withFetch(client: FakeClient): FakeClient {
    return client
      .on("setReconciliation:fetchRawOptions", (a) => {
        const base = a.parentId === "vtB";
        const bsc = base ? [{ value: "Topps Chrome", platformValue: "bsc-chrome" }] : [{ value: "Future Stars", platformValue: "future-stars" }];
        const sl = base ? [{ value: "2024 Topps Chrome", platformValue: "sl-chrome" }] : [{ value: "2024 Topps Chrome Future Stars", platformValue: "sl-fs" }];
        return {
          success: true,
          bscOptions: bsc,
          slOptions: sl,
          autoMatched: [],
          unmatchedBsc: bsc,
          unmatchedSl: sl,
          slCandidates: [],
          errors: [],
          message: "",
          skippedSides: [],
          pausedSides: [],
          twinIds: { bsc: [], sportlots: [] },
        };
      })
      .on("selectorOptions:getBaseVariantBySet", null)
      .on("setParallelConversion:getBrandSlHolders", { rows: [], truncated: false })
      .on("selectorOptions:getUsedInsertIdentifiersBySet", { values: [], slPlatformValues: [], bscPlatformValues: [] });
  }

  const setStep = (extra: Record<string, unknown>) => ({ kind: "set", path: PATH, variantTypes: { sync: true }, ...extra });
  const OPEN_BASE = { map: { bsc: "bsc-not-offered", whenPaused: "bsc-only" } };
  const MAPPED_BASE = { map: { bsc: "bsc-chrome", sportlots: "sl-chrome", whenPaused: "bsc-only" } };
  const run = async (steps: unknown[], cards = WIDE()) => {
    const raw = { version: 1, scope: SCOPE, steps };
    const client = withFetch(world(cards));
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    return { r, client, step: (action: string) => r.steps.filter((s) => s.action === action) };
  };

  test("an open Base mapping: every variant sync and every buildFromBase waits, nothing is fetched under them", async () => {
    const { r, client, step } = await run([
      setStep({
        base: OPEN_BASE,
        variants: [
          { type: "Insert", sync: { pairs: [{ name: "Future Stars", bsc: ["future-stars"] }], pending: [] } },
          { type: "Parallel", rows: [{ name: "Sepia Refractors", buildFromBase: {} }] },
        ],
      }),
    ]);
    expect(r.openDecisions.baseCandidates).toHaveLength(1);
    const on = "waits: the Base mapping (steps[0].base.map)";
    expect(step("sync Insert rows")).toEqual([expect.objectContaining({ status: "blocked", detail: on })]);
    expect(step("build Parallel › Sepia Refractors from Base")).toEqual([expect.objectContaining({ status: "blocked", detail: on })]);
    // Only the Base picker's fetch: the Insert sync never asked a marketplace.
    expect(client.callsTo("setReconciliation:fetchRawOptions").map((c) => c.args.parentId)).toEqual(["vtB"]);
    expect(client.writes().filter((c) => c.kind === "mutation")).toEqual([]);
  });

  test("an open variant-type sync: that type's rows wait; another type carries on", async () => {
    const { r, client, step } = await run([
      setStep({
        base: MAPPED_BASE,
        variants: [
          {
            type: "Insert",
            sync: { pairs: [{ name: "Future Stars", bsc: ["not-fetched"] }], pending: [] },
            rows: [{ name: "Future Stars", checklist: checklist() }],
          },
          { type: "Parallel", rows: [{ name: "Sepia Refractors", buildFromBase: {} }] },
        ],
      }),
    ], { ...WIDE(), vtB: 2 });
    expect(r.stops).toHaveLength(1);
    expect(step("Insert rows")).toEqual([
      expect.objectContaining({ status: "blocked", detail: "waits: the Insert sync (steps[0].variants[0].sync)" }),
    ]);
    expect(client.callsTo("selectorOptions:fetchCardChecklist")).toEqual([]);
    expect(step("build Parallel › Sepia Refractors from Base")).toEqual([expect.objectContaining({ status: "done" })]);
  });

  test("an open brand-year: every later set step under it waits", async () => {
    const BAD = { sport: "Baseball", year: "2024", manufacturer: "Topp" };
    const { r, client, step } = await run([
      { kind: "brand-year", path: BAD, syncSets: true },
      { kind: "set", path: { ...BAD, set: "Topps Chrome" }, variantTypes: { sync: true }, base: MAPPED_BASE },
    ]);
    expect(r.openDecisions.names.map((n) => n.at)).toEqual(["steps[0].path.manufacturer"]);
    expect(step("everything below the set")).toEqual([
      expect.objectContaining({ index: 1, status: "blocked", detail: "waits: Baseball/2024/Topp does not resolve (steps[0])" }),
    ]);
    expect(client.callsTo("setReconciliation:fetchRawOptions")).toEqual([]);
  });

  test("two steps naming one set share the gate: the second step's builds and syncs wait on the first's open Base", async () => {
    const { client, step } = await run([
      setStep({ base: OPEN_BASE }),
      setStep({
        variants: [
          { type: "Insert", sync: { pairs: [{ name: "Future Stars", bsc: ["future-stars"] }], pending: [] } },
          { type: "Parallel", rows: [{ name: "Sepia Refractors", buildFromBase: {} }] },
        ],
      }),
    ], { ...WIDE(), vtB: 2 });
    const on = "waits: the Base mapping (steps[0].base.map)";
    expect(step("build Parallel › Sepia Refractors from Base")).toEqual([expect.objectContaining({ index: 1, status: "blocked", detail: on })]);
    expect(step("sync Insert rows")).toEqual([expect.objectContaining({ index: 1, status: "blocked", detail: on })]);
    expect(client.callsTo("parallelChecklistBuild:buildParallelChecklist")).toEqual([]);
  });

  test("two steps naming one set: rows of a type whose sync the first step left open wait in the second", async () => {
    const { client, step } = await run([
      setStep({ base: MAPPED_BASE, variants: [{ type: "Insert", sync: { pairs: [{ name: "Future Stars", bsc: ["not-fetched"] }], pending: [] } }] }),
      setStep({ variants: [{ type: "Insert", rows: [{ name: "Future Stars", checklist: checklist() }] }] }),
    ], { ...WIDE(), vtB: 2 });
    expect(step("Insert rows").map((s) => [s.index, s.detail])).toEqual([
      [0, "waits: the Insert sync (steps[0].variants[0].sync)"],
      [1, "waits: the Insert sync (steps[0].variants[0].sync)"],
    ]);
    expect(client.callsTo("selectorOptions:fetchCardChecklist")).toEqual([]);
  });
});

/**
 * NEO-339 live measurement (2024 Topps Chrome Black on the PR preview): the
 * two drifts between a draft and its apply.
 *
 * (a) Between the draft and the apply another writer synced the brand's
 *     flagship set, so 154 SportLots sets the draft had drafted `leave` for
 *     were now HELD elsewhere in the brand and no longer in the dialog. A
 *     `leave` for such an id is a reported no-op: the dialog would create no
 *     row for it either way. An `own-set` for it stays open.
 * (b) The Insert sync stopped open, and the Parallel sync then ran with the
 *     Insert-paired SportLots sets unheld, so they came back as pending. A
 *     later type's sync now waits on an earlier open one in the same set.
 */
describe("draft → apply drift (NEO-339 live measurement)", () => {
  function fetchWorld(cards: Record<string, number>, holders: string[]) {
    const bsc = [{ value: "Future Stars", platformValue: "future-stars" }];
    const yq = { value: "Youthquake", platformValue: "youthquake" };
    const sl = [
      { value: "2024 Topps Chrome Future Stars", platformValue: "sl-fs" },
      { value: "2024 Topps All Topps Team", platformValue: "sl-att" },
    ];
    return world(cards)
      .on("setReconciliation:fetchRawOptions", (a) => ({
        success: true,
        bscOptions: a.parentId === "vtB" ? [{ value: "Topps Chrome", platformValue: "bsc-chrome" }] : [...bsc, yq],
        slOptions: sl,
        autoMatched: a.parentId === "vtB" ? [] : [{ displayName: "Future Stars", bsc: bsc[0], sl: sl[0], confidence: 0.99 }],
        unmatchedBsc: a.parentId === "vtB" ? [] : [yq],
        unmatchedSl: [sl[1]],
        slCandidates: [],
        errors: [],
        message: "",
        skippedSides: [],
        pausedSides: [],
        twinIds: { bsc: [], sportlots: [] },
      }))
      .on("selectorOptions:getBaseVariantBySet", null)
      .on("setParallelConversion:getBrandSlHolders", {
        rows: holders.map((id) => ({ key: `held-${id}`, name: "Topps All Topps Team", sportlots: [id] })),
        truncated: false,
      })
      .on("selectorOptions:getUsedInsertIdentifiersBySet", { values: [], slPlatformValues: [], bscPlatformValues: [] })
      .on("setReconciliation:storeReconciledOptions", { optionsCount: 1, unlinkedTotal: 0, done: true });
  }
  const MAPPED = { map: { bsc: "bsc-chrome", sportlots: "sl-chrome", whenPaused: "bsc-only" } };
  const spec = (decision: "leave" | "own-set", variants: unknown[] = []) => ({
    version: 1,
    scope: SCOPE,
    steps: [
      {
        kind: "set",
        path: PATH,
        variantTypes: { sync: true },
        base: MAPPED,
        variants: [
          {
            type: "Insert",
            sync: {
              pairs: [
                { name: "Future Stars", bsc: ["future-stars"], sportlots: ["sl-fs"] },
                { name: "Youthquake", bsc: ["youthquake"] },
              ],
              pending: [{ side: "sportlots", id: "sl-att", decision }],
            },
          },
          ...variants,
        ],
      },
    ],
  });

  test("(a) a drafted `leave` for a set another row of the brand now holds is a reported no-op, not an open decision", async () => {
    const raw = spec("leave");
    const client = fetchWorld({ ...WIDE(), vtB: 2 }, ["sl-att"]);
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.stops).toBeUndefined();
    expect(countOpenDecisions(r.openDecisions)).toBe(0);
    expect(r.steps.find((s) => s.action === "sync Insert rows")).toMatchObject({
      status: "done",
      detail: expect.stringContaining('1 "leave" entry had nothing to leave (1 now held by another NB row)'),
    });
  });

  test("(a) an `own-set` for a now-held set stays open: it asked for a row that cannot be made", async () => {
    const raw = spec("own-set");
    const client = fetchWorld({ ...WIDE(), vtB: 2 }, ["sl-att"]);
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.openDecisions.names).toEqual([expect.objectContaining({ at: "steps[0].variants[0].sync.pending[0]", kind: "reconcile-id", name: "sl-att" })]);
    expect(client.callsTo("setReconciliation:storeReconciledOptions")).toEqual([]);
  });

  test("a set waiting in one type's Pending that the spec pairs under another type is left unasked there, and named in the step", async () => {
    // "Chrome Gold" sits inside the set's SportLots filter: unanswered, it
    // would be an open decision for the Insert sync. The Parallel entry pairs
    // it, so the Insert sync leaves it in Pending (that sync files it).
    const gold = { value: "Chrome Gold", platformValue: "sl-gold" };
    const client = fetchWorld({ ...WIDE(), vtB: 2 }, []).on("setReconciliation:fetchRawOptions", (a) => {
      const fs = { value: "Future Stars", platformValue: "future-stars" };
      const slFs = { value: "2024 Topps Chrome Future Stars", platformValue: "sl-fs" };
      const yq = { value: "Youthquake", platformValue: "youthquake" };
      const insert = a.parentId === "vtI";
      return {
        success: true,
        bscOptions: insert ? [fs, yq] : [{ value: "Gold", platformValue: "bsc-gold" }],
        slOptions: [slFs, gold],
        autoMatched: insert ? [{ displayName: "Future Stars", bsc: fs, sl: slFs, confidence: 0.99 }] : [],
        unmatchedBsc: insert ? [yq] : [{ value: "Gold", platformValue: "bsc-gold" }],
        unmatchedSl: insert ? [gold] : [slFs, gold],
        slCandidates: [],
        errors: [],
        message: "",
        skippedSides: [],
        pausedSides: [],
        twinIds: { bsc: [], sportlots: [] },
      };
    });
    const raw = {
      version: 1,
      scope: SCOPE,
      steps: [
        {
          kind: "set",
          path: PATH,
          variantTypes: { sync: true },
          base: MAPPED,
          variants: [
            {
              type: "Insert",
              sync: {
                pairs: [
                  { name: "Future Stars", bsc: ["future-stars"], sportlots: ["sl-fs"] },
                  { name: "Youthquake", bsc: ["youthquake"] },
                ],
                pending: [],
              },
            },
          ],
        },
      ],
    };
    const lone = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    // Alone, the Insert spec leaves "Chrome Gold" unanswered: open, with its name.
    expect(lone.openDecisions.reconcile).toEqual([expect.objectContaining({ pending: [{ side: "sportlots", id: "sl-gold", name: "Chrome Gold" }] })]);

    const both = structuredClone(raw) as typeof raw & { steps: Array<{ variants: unknown[] }> };
    both.steps[0].variants.push({
      type: "Parallel",
      sync: { pairs: [{ name: "Gold", bsc: ["bsc-gold"], sportlots: ["sl-gold"] }], pending: [{ side: "sportlots", id: "sl-fs", decision: "leave" }] },
    });
    const r = await applySpec(client, FAKE_TARGET, both, confirmFor(both), { pausedPlatforms: "", stopAt: "end" });
    // (The fixture's Parallel type has a saved row this spec does not name; only the Insert sync is under test.)
    expect(r.openDecisions.reconcile.filter((x) => x.type === "Insert")).toEqual([]);
    expect(r.steps.find((s) => s.action === "sync Insert rows")).toMatchObject({
      status: "done",
      detail: expect.stringContaining("1 set(s) another variant type files left in Pending"),
    });
  });

  test("(b) a later type's sync waits on an earlier open one in the same set, and never fetches with stale held ids", async () => {
    // The Insert sync is open (a pair names an id the fetch did not return).
    const raw = {
      version: 1,
      scope: SCOPE,
      steps: [
        {
          kind: "set",
          path: PATH,
          variantTypes: { sync: true },
          base: MAPPED,
          variants: [
            { type: "Insert", sync: { pairs: [{ name: "Future Stars", bsc: ["not-fetched"] }], pending: [] } },
            { type: "Parallel", sync: { pairs: [], pending: [{ side: "sportlots", id: "sl-att", decision: "leave" }] } },
          ],
        },
      ],
    };
    const client = fetchWorld({ ...WIDE(), vtB: 2 }, []);
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.stops).toHaveLength(1);
    expect(r.steps.find((s) => s.action === "sync Parallel rows")).toMatchObject({
      status: "blocked",
      detail: "waits: the Insert sync (steps[0].variants[0].sync)",
    });
    expect(client.callsTo("setReconciliation:fetchRawOptions").map((c) => c.args.parentId)).toEqual(["vtI"]);
  });
});

/**
 * A spec check that fails mid-apply (an expected count, a Match Cards answer
 * naming no fetched card) stops ITS step like an open decision, and the run
 * returns its report: every step done before it, with its counts. Only an
 * error that is not a spec check throws, as RunFailed carrying the report.
 */
describe("a failed spec check stops its step and the run returns its report", () => {
  /** The Insert type grouped (Youthquake Red already under Youthquake) and its one row, after a Sepia build from Base. */
  function groupedSpec(expectUngrouped: number) {
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
              group: { parents: [{ insert: "Youthquake", parallels: ["Youthquake Red"] }], expectUngrouped },
              rows: [{ name: "Youthquake", checklist: checklist(20), parallels: [{ name: "Youthquake Red", build: {} }] }],
            },
          ],
        },
      ],
    };
  }
  const UNGROUPED = "steps[0].variants[1].group.expectUngrouped: Insert leaves 0 rows ungrouped; the spec expects 1.";

  test('group.expectUngrouped, stopAt "first": a report, not a throw, with the steps done before it', async () => {
    const raw = groupedSpec(1);
    const client = world({ ...WIDE(), vtB: 2 });
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "first" });
    expect(r.stoppedAt).toEqual({ step: 0, reason: UNGROUPED });
    const byAction = Object.fromEntries(r.steps.map((s) => [s.action, s]));
    expect(byAction["build Parallel › Sepia Refractors from Base"]).toMatchObject({ status: "done", detail: "built 2, holds 2" });
    expect(byAction["group Insert parallels (1 insert)"]).toMatchObject({ status: "done" });
    expect(byAction["Insert leaves 1 rows ungrouped"]).toMatchObject({ status: "blocked", detail: "0 now" });
    expect(r.counts.built).toBe(2);
    // Nothing after the stop ran.
    expect(client.callsTo("parallelChecklistBuild:buildParallelChecklist").map((c) => c.args)).toEqual([{ parallelId: "pS" }]);
  });

  test('group.expectUngrouped, stopAt "end": the rows\' parallels wait on it; the rows\' checklists carry on', async () => {
    const raw = groupedSpec(1);
    const client = world({ ...WIDE(), vtB: 2 });
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.stops).toEqual([{ step: 0, reason: UNGROUPED }]);
    const byAction = Object.fromEntries(r.steps.map((s) => [s.action, s]));
    expect(byAction["fetch and commit the Insert › Youthquake checklist"]).toMatchObject({ status: "done" });
    expect(byAction["build Insert › Youthquake › Youthquake Red from Insert › Youthquake"]).toMatchObject({
      status: "blocked",
      detail: "waits: steps[0].variants[1].group.expectUngrouped",
    });
  });

  test("expectRows: the type's grouping and rows wait on it", async () => {
    const raw = groupedSpec(0);
    (raw.steps[0].variants[1] as Record<string, unknown>).expectRows = 9;
    const r = await applySpec(world({ ...WIDE(), vtB: 2 }), FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.stops).toEqual([{ step: 0, reason: "steps[0].variants[1].expectRows: Insert holds 4 rows; the spec expects 9." }]);
    const byAction = Object.fromEntries(r.steps.map((s) => [s.action, s]));
    expect(byAction["Insert rows"]).toMatchObject({ status: "blocked", detail: "waits: steps[0].variants[1].expectRows" });
    expect(byAction["group Insert parallels (1 insert)"]).toBeUndefined();
    // The other type ran.
    expect(byAction["build Parallel › Sepia Refractors from Base"]).toMatchObject({ status: "done" });
  });

  test("a checklist's Match Cards answer naming no fetched card blocks that checklist; its parallels wait, siblings carry on", async () => {
    const raw = {
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
              rows: [
                {
                  name: "Future Stars",
                  checklist: {
                    ...checklist(),
                    pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep", unlink: [{ bsc: "b-gone", sportlots: "s-iFS" }] },
                  },
                  parallels: [{ name: "Future Stars Gold", build: {} }],
                },
                { name: "Youthquake", checklist: checklist(20), parallels: [{ name: "Youthquake Red", build: {} }] },
              ],
            },
          ],
        },
      ],
    };
    const client = world(WIDE());
    const r = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    const reason =
      'steps[0].variants[0].rows[0].checklist: pairing.unlink[0]: BSC card "b-gone" and SportLots card "s-iFS" cannot be unlinked: ' +
      "the BSC card is not in this fetch.";
    expect(r.stops).toEqual([{ step: 0, reason }]);
    const byAction = Object.fromEntries(r.steps.map((s) => [s.action, s]));
    expect(byAction["fetch and commit the Insert › Future Stars checklist"]).toMatchObject({ status: "blocked", detail: reason });
    expect(byAction["build Insert › Future Stars › Future Stars Gold from Insert › Future Stars"]).toMatchObject({
      status: "blocked",
      detail: "waits: the Insert › Future Stars checklist (steps[0].variants[0].rows[0].checklist)",
    });
    expect(byAction["build Insert › Youthquake › Youthquake Red from Insert › Youthquake"]).toMatchObject({ status: "done" });
    expect(client.callsTo("selectorOptions:commitCardChecklist")).toEqual([]);
  });

  test("an error that is not a spec check still throws RunFailed, carrying the steps done before it", async () => {
    const raw = groupedSpec(0);
    const client = world({ ...WIDE(), vtB: 2 });
    client.on("selectorOptions:getInsertTreeByVariantType", () => {
      throw new Error("network down");
    });
    const err = await applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunFailed);
    const report = (err as RunFailed).report;
    expect(report.steps.find((s) => s.action === "build Parallel › Sepia Refractors from Base")).toMatchObject({ status: "done" });
    expect(report.counts?.built).toBe(2);
    // The set had resolved before the error, so the partial report carries its link.
    expect(report.setLinks).toEqual([{ path: SCOPE, link: "/admin/set-builder?sport=sp&year=yr&brand=mf&set=st" }]);
  });
});

/**
 * A spec check that fails MID-APPLY (every class extends `StepCheckError`):
 * the step is recorded blocked with the check's own message, the run does not
 * throw, the report comes back, and with `stopAt: "end"` the work that does
 * not depend on the failed step still runs.
 */
describe("a StepCheckError raised mid-apply", () => {
  const MAPPED = { map: { bsc: "bsc-chrome", sportlots: "sl-chrome", whenPaused: "bsc-only" } };
  const SEPIA = "build Parallel › Sepia Refractors from Base";
  const RED = "build Insert › Youthquake › Youthquake Red from Insert › Youthquake";
  const byAction = (r: Awaited<ReturnType<typeof applySpec>>) => Object.fromEntries(r.steps.map((s) => [s.action, s]));
  const go = (raw: unknown, client: FakeClient) => applySpec(client, FAKE_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
  /** The healthy tail every case ends with: an Insert's checklist and its parallel's build. */
  const TAIL = { type: "Insert", rows: [{ name: "Youthquake", checklist: checklist(20), parallels: [{ name: "Youthquake Red", build: {} }] }] };
  const expectTailRan = (r: Awaited<ReturnType<typeof applySpec>>, client: FakeClient) => {
    expect(byAction(r)[RED]).toMatchObject({ status: "done" });
    expect(client.callsTo("parallelChecklistBuild:buildParallelChecklist").map((c) => c.args.parallelId)).toContain("yqR");
  };

  test("AddRowRefused: a manufacturer the server refuses blocks its brand-year step; the set below still runs", async () => {
    const raw = {
      version: 1,
      scope: SCOPE,
      steps: [
        { kind: "brand-year", path: { sport: "Baseball", year: "2024", manufacturer: "Panini!" }, manufacturer: { whenMissing: "create" }, syncSets: true },
        { kind: "set", path: PATH, variantTypes: { sync: true }, base: MAPPED, variants: [TAIL] },
      ],
    };
    const client = world({ ...WIDE(), vtB: 2 });
    client.on("selectorOptions:addCustomSelectorOption", () => {
      throw new ConvexError({ code: "CUSTOM_VALUE_INVALID" });
    });
    const r = await go(raw, client);
    expect(r.steps.find((s) => s.index === 0 && s.status === "blocked")).toMatchObject({
      kind: "brand-year",
      status: "blocked",
      detail: '"Panini!" is not a valid name here.',
    });
    expect(r.stops).toEqual([{ step: 0, reason: '"Panini!" is not a valid name here.' }]);
    expect(r.confirmPhrase).toBe(confirmFor(raw));
    expect(client.callsTo("selectorOptions:addCustomSelectorOption")).toHaveLength(1);
    expectTailRan(r, client);
  });

  /** The set's variant types without its Base (a Base deleted or renamed under the run). */
  const withoutBase = (tree: Record<string, unknown[]>) => {
    tree["variantType:st"] = (tree["variantType:st"] as Array<{ _id: string }>).filter((t) => t._id !== "vtB");
  };
  const NO_BASE = "The set st has no Base variant type yet; sync its variant types first.";
  const TWO_STEPS = (base: Record<string, unknown>) => ({
    version: 1,
    scope: SCOPE,
    steps: [
      { kind: "set", path: PATH, variantTypes: { sync: true }, base, variants: [{ type: "Parallel", rows: [{ name: "Sepia Refractors", buildFromBase: {} }] }] },
      { kind: "brand-year", path: { sport: "Baseball", year: "2024", manufacturer: "Topps" }, syncSets: true },
    ],
  });

  test("NoBaseVariantType at the Base mapping: the step is blocked, the Base checklist and the build from Base wait, the next step runs", async () => {
    const raw = TWO_STEPS({ ...MAPPED, checklist: checklist() });
    const client = world({ ...WIDE(), vtB: 2 }, withoutBase);
    const r = await go(raw, client);
    const steps = byAction(r);
    expect(steps["map Base to BSC bsc-chrome + SportLots sl-chrome"]).toMatchObject({ status: "blocked", detail: NO_BASE });
    expect(r.stops).toEqual([{ step: 0, reason: NO_BASE }]);
    expect(steps["fetch and commit the Base checklist"]).toMatchObject({ status: "blocked", detail: "waits: the Base mapping (steps[0].base.map)" });
    expect(steps[SEPIA]).toMatchObject({ status: "blocked" });
    expect(client.callsTo("selectorOptions:fetchCardChecklist")).toEqual([]);
    expect(client.callsTo("parallelChecklistBuild:buildParallelChecklist")).toEqual([]);
    expect(r.steps.filter((s) => s.index === 1).map((s) => s.status)).not.toContain("blocked");
    expect(r.steps.filter((s) => s.index === 1).length).toBeGreaterThan(0);
    expect(r.confirmPhrase).toBe(confirmFor(raw));
  });

  test("NoBaseVariantType between the mapping and the Base checklist (the engine's own findBaseVariantType): blocked, dependents wait, the next step runs", async () => {
    const raw = TWO_STEPS({ ...MAPPED, checklist: checklist() });
    let treeRef: Record<string, unknown[]> = {};
    const client = world({ ...WIDE(), vtB: 2 }, (t) => {
      treeRef = t;
    });
    // The mapping reads the Base (and its chain) and finds it already mapped; the Base is gone by the time the checklist step looks again.
    client.on("selectorOptions:getAncestorChain", () => {
      withoutBase(treeRef);
      return [sel("sp", "sport", "Baseball"), sel("yr", "year", "2024"), sel("mf", "manufacturer", "Topps"), sel("st", "setName", "Topps Chrome")];
    });
    const r = await go(raw, client);
    const steps = byAction(r);
    expect(steps["map Base to BSC bsc-chrome + SportLots sl-chrome"]).toMatchObject({ status: "done" });
    expect(steps["fetch and commit the Base checklist"]).toMatchObject({ status: "blocked", detail: NO_BASE });
    expect(r.stops).toEqual([{ step: 0, reason: NO_BASE }]);
    // The build from Base rests on the Base checklist the run could not reach.
    expect(steps[SEPIA]).toMatchObject({ status: "blocked", detail: "waits: the Base checklist (steps[0].base.checklist)" });
    expect(client.callsTo("selectorOptions:fetchCardChecklist")).toEqual([]);
    expect(r.steps.filter((s) => s.index === 1).length).toBeGreaterThan(0);
    expect(r.steps.filter((s) => s.index === 1).map((s) => s.status)).not.toContain("blocked");
  });

  test('a variant type named "Base" in the spec: reconcile refuses it as the set\'s Base, the Parallel type and the Insert tail still run', async () => {
    const raw = {
      version: 1,
      scope: SCOPE,
      steps: [
        {
          kind: "set",
          path: PATH,
          variantTypes: { sync: true },
          base: MAPPED,
          variants: [
            { type: "Base", sync: { pairs: [{ name: "Anything", bsc: ["x"] }], pending: [] } },
            { type: "Parallel", rows: [{ name: "Sepia Refractors", buildFromBase: {} }] },
            TAIL,
          ],
        },
      ],
    };
    const client = world({ ...WIDE(), vtB: 2 });
    const r = await go(raw, client);
    const reason = '"Base" is the set\'s Base; it has no rows to sync (map it with base.map instead).';
    expect(byAction(r)["sync Base rows"]).toMatchObject({ kind: "reconcile", status: "blocked", detail: reason });
    expect(r.stops).toEqual([{ step: 0, reason }]);
    // That type's rows wait on its sync; nothing else does.
    expect(byAction(r)["Base rows"]).toMatchObject({ status: "blocked", detail: "waits: the Base sync (steps[0].variants[0].sync)" });
    expect(byAction(r)[SEPIA]).toMatchObject({ status: "done" });
    expectTailRan(r, client);
  });

  test("BuildParallelError: a build the server refuses blocks that parallel; its sibling, the next type and the next step run", async () => {
    const raw = {
      version: 1,
      scope: SCOPE,
      steps: [
        { kind: "set", path: PATH, variantTypes: { sync: true }, base: MAPPED, variants: [{ type: "Parallel", rows: [{ name: "Sepia Refractors", buildFromBase: {} }] }, TAIL] },
        { kind: "brand-year", path: { sport: "Baseball", year: "2024", manufacturer: "Topps" }, syncSets: true },
      ],
    };
    const cards = { ...WIDE(), vtB: 2 } as Record<string, number>;
    const client = world(cards);
    client.on("parallelChecklistBuild:buildParallelChecklist", (a) => {
      const id = a.parallelId as string;
      if (id === "pS") return { status: "blocked", blockedReason: "its source holds no cards on this marketplace", deletedCount: 0, copied: 0 };
      cards[id] = 20;
      return { status: "built", copied: 20, extraOnMarketplace: { bsc: { count: 0, cards: [] }, sportlots: { count: 0, cards: [] } } };
    });
    const r = await go(raw, client);
    const sepia = byAction(r)[SEPIA];
    expect(sepia.status).toBe("blocked");
    expect(sepia.detail).toContain('the build of "Sepia Refractors" was refused: its source holds no cards on this marketplace');
    expect(r.stops).toEqual([{ step: 0, reason: sepia.detail }]);
    expect(r.counts.built).toBe(20);
    expectTailRan(r, client);
    expect(r.steps.filter((s) => s.index === 1).length).toBeGreaterThan(0);
    expect(r.confirmPhrase).toBe(confirmFor(raw));
  });

});
