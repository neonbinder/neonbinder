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
