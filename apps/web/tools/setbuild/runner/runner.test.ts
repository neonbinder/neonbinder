import { describe, expect, test } from "vitest";
import { ConfirmMismatch, confirmPhrase } from "../client/target";
import { countOpenDecisions } from "../service";
import { DECISION_PLACEHOLDER } from "../lib/review";
import { applySpec } from "./apply";
import { FAKE_TARGET, fakeClient, type FakeClient } from "./fake-client";
import { planSpec } from "./plan";
import { PlanWouldWrite, readOnlyClient } from "./read-only-client";
import { createSetBuildService } from "./service";

const PATH = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome" };
const SCOPE = "Baseball/2024/Topps/Topps Chrome";
const CONFIRM = confirmPhrase(FAKE_TARGET, SCOPE);

function spec(review: unknown = { players: [], teams: [], leagues: [] }) {
  return {
    version: 1,
    scope: SCOPE,
    steps: [
      {
        kind: "set",
        path: PATH,
        variantTypes: { sync: true },
        base: {
          map: { bsc: "bsc-chrome", sportlots: "sl-chrome", whenPaused: "bsc-only" },
          checklist: { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, review, expectCards: 2 },
        },
        variants: [{ type: "Parallel", rows: [{ name: "Sepia Refractors", buildFromBase: {}, expectCards: 2 }] }],
      },
    ],
  };
}

interface World {
  synced: boolean;
  baseCards: number;
  sepiaCards: number;
  reviewRows: Array<Record<string, unknown>>;
}

const sel = (id: string, level: string, value: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  _creationTime: 1,
  level,
  value,
  platformData: {},
  lastUpdated: 1,
  ...extra,
});

/** A deployment holding Baseball › 2024 › Topps › Topps Chrome, Base mapped, a Parallel type with Sepia. */
function world(w: World): FakeClient {
  const tree: Record<string, unknown[]> = {
    "sport:": [sel("sp", "sport", "Baseball")],
    "year:sp": [sel("yr", "year", "2024")],
    "manufacturer:yr": [sel("mf", "manufacturer", "Topps")],
    "setName:mf": [sel("st", "setName", "Topps Chrome")],
    "variantType:st": [
      sel("vtB", "variantType", "Base", {
        metadata: { isBase: true },
        platformData: { bsc: { s1: "bsc-chrome" }, sportlots: { s1: "sl-chrome" } },
      }),
      sel("vtP", "variantType", "Parallel", { metadata: { variantRole: "parallel" } }),
    ],
    "insert:vtP": [sel("pS", "insert", "Sepia Refractors", { platformData: { bsc: { s1: "bsc-sepia" } } })],
  };
  const candidates = { batchId: undefined as string | undefined, cards: [] as unknown[] };
  return fakeClient()
    .on("marketplacePause:getPausedPlatforms", [])
    .on("selectorOptions:getSelectorOptions", (a) => {
      const key = `${a.level}:${a.parentId ?? ""}`;
      if (!w.synced && key !== "sport:") return [];
      return tree[key] ?? [];
    })
    .on("selectorOptions:getAncestorChain", [
      sel("sp", "sport", "Baseball"),
      sel("yr", "year", "2024"),
      sel("mf", "manufacturer", "Topps"),
      sel("st", "setName", "Topps Chrome"),
      sel("vtB", "variantType", "Base", { metadata: { isBase: true } }),
    ])
    .on("selectorOptions:getSlotCardCounts", (a) => ({
      bsc: {},
      sportlots: {},
      total: a.selectorOptionId === "vtB" ? w.baseCards : w.sepiaCards,
    }))
    .on("parallelChecklistBuild:getParallelsForBuild", () => ({
      source: { id: "vtB", value: "Base", kind: "base", hasCards: w.baseCards > 0 },
      parallels: [{ _id: "pS", value: "Sepia Refractors", sides: { bsc: true, sportlots: false }, hasCards: w.sepiaCards > 0 }],
      truncated: false,
    }))
    .on("parallelChecklistBuild:buildParallelChecklist", () => {
      w.sepiaCards = 2;
      return { status: "built", copied: 2 };
    })
    .on("checklistCandidates:getReadyCandidates", () => ({
      batchId: candidates.batchId,
      total: candidates.cards.length,
      ready: candidates.cards.length,
      cards: candidates.cards,
    }))
    .on("selectorOptions:fetchCardChecklist", () => {
      candidates.batchId = `cb${Math.random()}`;
      candidates.cards = ["1", "2"].map((n) => ({
        _id: `c${n}`,
        cardNumber: n,
        cardName: n === "1" ? "Shohei Ohtani" : "J.T. Realmuto",
        platformData: { bsc: { ref: `b${n}` }, sportlots: { ref: `s${n}` } },
        bucket: "matched",
        stem: n,
        teamResolved: true,
      }));
      return { success: true, message: "2 matched", candidateCount: 2, attachedSides: ["bsc", "sportlots"], pausedSides: [] };
    })
    .on("selectorOptions:diffChecklistAgainstExisting", {
      cards: [],
      removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 },
      conflicts: [],
      collisionInsertCount: 0,
    })
    .on("selectorOptions:resolveChecklistEntities", () => ({
      unknownPlayers: ["Shohei Ohtani"],
      unknownTeams: [],
      batchId: "rb1",
    }))
    .on("entityReviewQueue:getBatch", () => structuredClone(w.reviewRows))
    .on("entityReviewQueue:stageCareerTeamRows", 0)
    .on("entityReviewQueue:recordDecision", (a) => {
      const r = w.reviewRows.find((x) => x._id === a.reviewRowId)!;
      r.decision = { action: a.action };
      return null;
    })
    .on("players:nearMatches", [])
    .on("selectorOptions:commitCardChecklist", () => {
      w.baseCards = 2;
      return {
        success: true,
        count: 2,
        createdPlayerIds: [],
        createdTeamIds: [],
        unmatchedExistingCount: 0,
        conflicts: [],
        collisionInserts: 0,
        staleDecisions: 0,
        operatorDeleted: 0,
        unreviewedNameCount: 0,
        droppedPendingNameCount: 0,
      };
    })
    .on("checklistCandidates:discardCandidates", { deleted: 2, hasMore: false });
}

const ohtaniRow = () => ({
  _id: "rv1",
  _creationTime: 1,
  selectorOptionId: "vtB",
  batchId: "rb1",
  kind: "player",
  name: "Shohei Ohtani",
  sportId: "sp",
  sportValue: "Baseball",
  setSportId: "sp",
  setSportValue: "Baseball",
  status: "ready",
});

const done = (): World => ({ synced: true, baseCards: 2, sepiaCards: 2, reviewRows: [] });

describe("apply — the confirm phrase comes before any network call", () => {
  test.each([
    ["missing", undefined],
    ["wrong host", `BUILD other.convex.cloud ${SCOPE}`],
    ["wrong scope", `BUILD ${FAKE_TARGET.host} e2e-baseline`],
  ])("%s phrase is refused with zero calls", async (_label, phrase) => {
    const client = world(done());
    await expect(applySpec(client, FAKE_TARGET, spec(), phrase)).rejects.toBeInstanceOf(ConfirmMismatch);
    expect(client.calls).toEqual([]);
  });

  test("the service's write methods refuse the same way", async () => {
    const client = world(done());
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    await expect(svc.write.apply(spec(), "nope")).rejects.toBeInstanceOf(ConfirmMismatch);
    await expect(svc.write.decide(PATH, { players: [] }, undefined)).rejects.toBeInstanceOf(ConfirmMismatch);
    await expect(svc.write.buildParallel(PATH, "Sepia Refractors", {}, "nope")).rejects.toBeInstanceOf(ConfirmMismatch);
    await expect(
      svc.write.slReviewApply({ sport: "Baseball", year: "2024", manufacturer: "Bowman" }, [{ slId: "1", placement: "own-set" }], SCOPE),
    ).rejects.toBeInstanceOf(ConfirmMismatch);
    expect(client.calls).toEqual([]);
  });
});

describe("apply — idempotent and resumable", () => {
  test("a finished set is skipped step by step and writes nothing", async () => {
    const client = world(done());
    const r = await applySpec(client, FAKE_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    expect(r.stoppedAt).toBeUndefined();
    expect(client.writes()).toEqual([]);
    expect(r.counts).toMatchObject({ built: 0, committed: 0 });
    expect(r.counts.skipped).toBeGreaterThanOrEqual(4);
    expect(r.steps.every((s) => s.status === "done")).toBe(true);
  });

  test("an empty parallel is built from Base and the expected count asserted", async () => {
    const client = world({ ...done(), sepiaCards: 0 });
    const r = await applySpec(client, FAKE_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    expect(r.counts.built).toBe(2);
    expect(client.writes().map((c) => c.fn)).toEqual(["parallelChecklistBuild:buildParallelChecklist"]);
  });

  test("an undecided review row stops the run with a fill-in template; decide answers it; a re-run resumes and commits", async () => {
    const w: World = { ...done(), baseCards: 0, sepiaCards: 0, reviewRows: [ohtaniRow()] };
    const client = world(w);
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });

    const first = await svc.write.apply(spec(), CONFIRM);
    expect(first.stoppedAt).toMatchObject({ step: 0 });
    expect(first.openDecisions.review.players).toMatchObject([{ name: "Shohei Ohtani", reason: "unanswered" }]);
    expect(countOpenDecisions(first.openDecisions)).toBe(1);
    expect(client.callsTo("entityReviewQueue:recordDecision")).toEqual([]);
    expect(client.callsTo("selectorOptions:commitCardChecklist")).toEqual([]);
    expect(client.callsTo("parallelChecklistBuild:buildParallelChecklist")).toEqual([]);
    const tpl = first.template as { steps: Array<{ base: { checklist: { review: { players: unknown[] } } } }> };
    expect(tpl.steps[0].base.checklist.review.players).toEqual([{ name: "Shohei Ohtani", decision: DECISION_PLACEHOLDER }]);
    expect("sessions" in first).toBe(false);

    const items = await svc.read.reviewItems(PATH);
    expect(items.review.players.map((p) => p.name)).toEqual(["Shohei Ohtani"]);

    const decided = await svc.write.decide(PATH, { players: [{ name: "Shohei Ohtani", decision: "create" }] }, CONFIRM);
    expect(decided.applied.players).toBe(1);
    expect(client.callsTo("entityReviewQueue:recordDecision").map((c) => c.args)).toEqual([
      { reviewRowId: "rv1", action: "create" },
    ]);

    const second = await svc.write.apply(spec(), CONFIRM);
    expect(second.stoppedAt).toBeUndefined();
    expect(second.counts).toMatchObject({ committed: 2, built: 2 });
    const commit = client.callsTo("selectorOptions:commitCardChecklist")[0].args;
    expect(commit).toMatchObject({ selectorOptionId: "vtB", sportId: "sp", batchId: "rb1" });
    expect((commit.cards as unknown[]).length).toBe(2);
  });

  test("a review answered in the spec is walked and committed in one run", async () => {
    const w: World = { ...done(), baseCards: 0, sepiaCards: 2, reviewRows: [ohtaniRow()] };
    const client = world(w);
    const r = await applySpec(
      client,
      FAKE_TARGET,
      spec({ players: [{ name: "Shohei Ohtani", decision: "create" }], teams: [], leagues: [] }),
      CONFIRM,
      { pausedPlatforms: "" },
    );
    expect(r.stoppedAt).toBeUndefined();
    expect(r.counts).toMatchObject({ committed: 2, reviewed: 1 });
    expect(client.writes().map((c) => c.fn)).toEqual([
      "selectorOptions:fetchCardChecklist",
      "selectorOptions:resolveChecklistEntities",
      "entityReviewQueue:recordDecision",
      "selectorOptions:commitCardChecklist",
      "checklistCandidates:discardCandidates",
    ]);
  });
});

describe("plan — read-only", () => {
  test("never sends a mutation, nor an action other than the marketplace candidate read", async () => {
    for (const w of [
      { synced: false, baseCards: 0, sepiaCards: 0, reviewRows: [] },
      { ...done(), baseCards: 0, sepiaCards: 0 },
      done(),
    ]) {
      const client = world(w);
      const r = await planSpec(client, FAKE_TARGET, spec(), { pausedPlatforms: "" });
      expect(client.calls.filter((c) => c.kind === "mutation")).toEqual([]);
      expect(client.calls.filter((c) => c.kind === "action" && c.fn !== "setReconciliation:fetchRawOptions")).toEqual([]);
      expect(r.confirmPhrase).toBe(CONFIRM);
    }
  });

  test("reports what apply would do", async () => {
    const r = await planSpec(world({ ...done(), baseCards: 0, sepiaCards: 0 }), FAKE_TARGET, spec(), { pausedPlatforms: "" });
    const byKind = Object.fromEntries(r.steps.map((s) => [s.kind, s.status]));
    expect(byKind).toMatchObject({ set: "done", "base-map": "done", checklist: "todo", "build-parallel": "blocked" });
  });

  test("an unsynced tree is todo, not an error", async () => {
    const r = await planSpec(world({ synced: false, baseCards: 0, sepiaCards: 0, reviewRows: [] }), FAKE_TARGET, spec(), { pausedPlatforms: "" });
    expect(r.steps[0]).toMatchObject({ kind: "set", status: "todo" });
    expect(countOpenDecisions(r.openDecisions)).toBe(0);
  });
});

describe("readOnlyClient", () => {
  test("refuses mutations and write actions before they reach the client", async () => {
    const inner = fakeClient().on("setReconciliation:fetchRawOptions", { success: true }).on("selectorOptions:getSelectorOptions", []);
    const ro = readOnlyClient(inner);
    const { api } = await import("../../../convex/_generated/api");
    await expect(ro.mutation(api.entityReviewQueue.recordDecision, { reviewRowId: "x" as never, action: "skip" })).rejects.toBeInstanceOf(PlanWouldWrite);
    await expect(ro.action(api.selectorOptions.fetchCardChecklist, { selectorOptionId: "x" as never })).rejects.toBeInstanceOf(PlanWouldWrite);
    await ro.action(api.setReconciliation.fetchRawOptions, { level: "insert" } as never);
    await ro.query(api.selectorOptions.getSelectorOptions, { level: "sport" });
    expect(inner.calls.map((c) => `${c.kind} ${c.fn}`)).toEqual([
      "action setReconciliation:fetchRawOptions",
      "query selectorOptions:getSelectorOptions",
    ]);
  });
});
