import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfirmMismatch } from "../client/target";
import { READ_TOOLS, registerTools } from "../mcp-tools";
import { countOpenDecisions, decideConfirmPhrase, fixConfirmPhrase, specConfirmPhrase } from "../service";
import { parseSpec } from "../spec/schema";
import { DECISION_PLACEHOLDER } from "../lib/review";
import { applySpec } from "./apply";
import { FAKE_TARGET, fakeClient, type FakeClient } from "./fake-client";
import { planSpec } from "./plan";
import { DRAFT_READ_ACTIONS, PlanWouldWrite, queryOnlyClient, ReadOnlyViolation, readOnlyClient } from "./read-only-client";
import { createSetBuildService } from "./service";
import { FixAborted } from "./attention";
import { parseFixAnswers } from "../lib/fix-answers";

const PATH = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome" };
const SCOPE = "Baseball/2024/Topps/Topps Chrome";
/** The phrase `apply` needs for a spec: host, scope and the parsed spec's digest. */
const confirmFor = (raw: unknown) => specConfirmPhrase(FAKE_TARGET, parseSpec(raw));
const CONFIRM = confirmFor(spec());

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
  /** `getCardChecklist` rows on Base, for the attention reads. */
  attentionCards?: Array<Record<string, unknown>>;
  /** `getSelectorSyncSuggestions` by `level:parentId`. */
  suggestions?: Record<string, unknown[]>;
  /** NEO-345: the Base row's own `features` (its `autographFormat`). */
  baseFeatures?: Record<string, string>;
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
        platformData: { bsc: { s1: "bsc-chrome" }, sportlots: { s1: "sl-chrome" } },
        ...(w.baseFeatures ? { features: w.baseFeatures } : {}),
      }),
      sel("vtP", "variantType", "Parallel"),
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
      sel("vtB", "variantType", "Base"),
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
    .on("checklistCandidates:discardCandidates", { deleted: 2, hasMore: false })
    // What attention reads (the end of every apply, nb_attention, inspect --attention).
    .on("selectorOptions:getCardChecklist", (a) => (a.selectorOptionId === "vtB" ? w.attentionCards ?? [] : []))
    .on("selectorOptions:getSelectorSyncSuggestions", (a) => w.suggestions?.[`${a.level}:${a.parentId ?? ""}`] ?? [])
    .on("selectorOptions:getSelectorSyncStatus", null)
    .on("slSetReview:getSlSetReviewSummary", null)
    .on("slSetReview:getSlSetReview", null);
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

  test("the phrase is bound to the spec's content: an edited spec needs a new phrase", async () => {
    const edited = spec();
    edited.steps[0].base.checklist.expectCards = 3;
    expect(confirmFor(edited)).not.toBe(CONFIRM);
    expect(confirmFor(edited).slice(0, -8)).toBe(CONFIRM.slice(0, -8));
    const client = world(done());
    await expect(applySpec(client, FAKE_TARGET, edited, CONFIRM)).rejects.toMatchObject({
      name: "ConfirmMismatch",
      expected: confirmFor(edited),
    });
    expect(client.calls).toEqual([]);
    // Key order is not content: the same spec written in another order keeps its phrase.
    const reordered = JSON.parse(JSON.stringify({ steps: spec().steps, scope: SCOPE, version: 1 }));
    expect(confirmFor(reordered)).toBe(CONFIRM);
  });

  test("a decide phrase is bound to its answers", async () => {
    const client = world(done());
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const create = { players: [{ name: "Shohei Ohtani", decision: "create" as const }] };
    const skip = { players: [{ name: "Shohei Ohtani", decision: "skip" as const }] };
    await expect(svc.write.decide(PATH, skip, decideConfirmPhrase(FAKE_TARGET, PATH, create))).rejects.toBeInstanceOf(
      ConfirmMismatch,
    );
    // An apply phrase never confirms a decide on the same set.
    await expect(svc.write.decide(PATH, create, CONFIRM)).rejects.toBeInstanceOf(ConfirmMismatch);
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

    const answers = { players: [{ name: "Shohei Ohtani", decision: "create" as const }] };
    const decided = await svc.write.decide(PATH, answers, decideConfirmPhrase(FAKE_TARGET, PATH, answers));
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
    const answered = spec({ players: [{ name: "Shohei Ohtani", decision: "create" }], teams: [], leagues: [] });
    const r = await applySpec(client, FAKE_TARGET, answered, confirmFor(answered), { pausedPlatforms: "" });
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

/** A set link without its `attention` (the attention tests below cover that). */
const linksOnly = (l: Array<{ path: string; link: string }> | undefined) => l?.map(({ path, link }) => ({ path, link }));

describe("Set Builder links (Jason: every build gives the operator the link to inspect it)", () => {
  const ORIGIN_TARGET = { ...FAKE_TARGET, appOrigin: "https://app.example.test" };
  const SET_LINK = "https://app.example.test/admin/set-builder?sport=sp&year=yr&brand=mf&set=st";
  const RELATIVE = "/admin/set-builder?sport=sp&year=yr&brand=mf&set=st";

  test("a finished run that built: the set's link, absolute on the app origin, at the top of the report", async () => {
    const r = await applySpec(world({ ...done(), sepiaCards: 0 }), ORIGIN_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    expect(r.counts.built).toBe(2);
    expect(r.stoppedAt).toBeUndefined();
    expect(linksOnly(r.setLinks)).toEqual([{ path: SCOPE, link: SET_LINK }]);
    expect(Object.keys(r).slice(0, 3)).toEqual(["target", "scope", "setLinks"]);
  });

  test("a re-run where every step was skipped still gives the link", async () => {
    const client = world(done());
    const r = await applySpec(client, ORIGIN_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    expect(client.writes()).toEqual([]);
    expect(linksOnly(r.setLinks)).toEqual([{ path: SCOPE, link: SET_LINK }]);
  });

  test("a blocked run gives the link too; with no app origin it is root-relative", async () => {
    const r = await applySpec(world({ ...done(), baseCards: 0, sepiaCards: 0, reviewRows: [ohtaniRow()] }), FAKE_TARGET, spec(), CONFIRM, {
      pausedPlatforms: "",
    });
    expect(r.stoppedAt).toMatchObject({ step: 0 });
    expect(linksOnly(r.setLinks)).toEqual([{ path: SCOPE, link: RELATIVE }]);
  });

  test("a set that never resolves gets no link, never an invented one", async () => {
    const raw = { ...spec(), scope: "Baseball/2024/Topps/Nope" };
    raw.steps = [{ ...raw.steps[0], path: { ...PATH, set: "Nope" } }];
    const r = await applySpec(world(done()), ORIGIN_TARGET, raw, confirmFor(raw), { pausedPlatforms: "", stopAt: "end" });
    expect(r.openDecisions.names.map((n) => n.name)).toEqual(["Nope"]);
    expect(r.setLinks).toEqual([]);
  });

  test("a set two steps name is listed once, and the link costs no query", async () => {
    const one = world(done());
    await applySpec(one, ORIGIN_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    const raw = spec();
    raw.steps = [raw.steps[0], raw.steps[0]];
    const client = world(done());
    const r = await applySpec(client, ORIGIN_TARGET, raw, confirmFor(raw), { pausedPlatforms: "" });
    expect(linksOnly(r.setLinks)).toEqual([{ path: SCOPE, link: SET_LINK }]);
    // The only chain reads are the Base mapping's own, one per step: none for the link.
    expect(one.callsTo("selectorOptions:getAncestorChain")).toHaveLength(1);
    expect(client.callsTo("selectorOptions:getAncestorChain")).toHaveLength(2);
  });

  test("plan: the link once the set resolves to an existing row; none on a tree that has not synced it yet", async () => {
    const ok = await planSpec(world({ ...done(), baseCards: 0, sepiaCards: 0 }), ORIGIN_TARGET, spec(), { pausedPlatforms: "" });
    expect(ok.setLinks).toEqual([{ path: SCOPE, link: SET_LINK }]);
    const unsynced = await planSpec(world({ synced: false, baseCards: 0, sepiaCards: 0, reviewRows: [] }), ORIGIN_TARGET, spec(), {
      pausedPlatforms: "",
    });
    expect(unsynced.setLinks).toEqual([]);
  });

  test("inspect: the set, every variant type and every row carry a link built from the ids it already holds", async () => {
    const client = world(done());
    const svc = createSetBuildService(client, ORIGIN_TARGET, { pausedPlatforms: "" });
    const r = await svc.read.inspect(PATH);
    expect(r.link).toBe(SET_LINK);
    expect(r.variantTypes!.map((t) => [t.type, t.link])).toEqual([
      ["Base", `${SET_LINK}&type=vtB`],
      ["Parallel", `${SET_LINK}&type=vtP`],
    ]);
    expect(r.base!.link).toBe(`${SET_LINK}&type=vtB`);
    expect(r.variantTypes![1].rows.map((row) => [row.name, row.link])).toEqual([["Sepia Refractors", `${SET_LINK}&type=vtP&insert=pS`]]);
    expect(client.callsTo("selectorOptions:getAncestorChain")).toEqual([]);

    const brand = await svc.read.inspect({ sport: "Baseball", year: "2024", manufacturer: "Topps" });
    expect(brand.link).toBe("https://app.example.test/admin/set-builder?sport=sp&year=yr&brand=mf");
    expect(brand.sets).toEqual([{ name: "Topps Chrome", links: { buysportscards: [], sportlots: [] }, link: SET_LINK }]);

    const missing = await svc.read.inspect({ ...PATH, set: "Nope" });
    expect(missing.found).toBe(false);
    expect(missing.link).toBeUndefined();
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

describe("MCP read tools — structurally read-only (security audit item 2)", () => {
  /** A seeded world whose every mutation and action THROWS, recording the attempt. */
  function throwingWorld(w: World) {
    const inner = world(w);
    const attempts: string[] = [];
    const client: FakeClient = {
      ...inner,
      mutation: async (fn, args) => {
        void args;
        const { getFunctionName } = await import("convex/server");
        attempts.push(`mutation ${getFunctionName(fn as never)}`);
        throw new Error("this test's client refuses every mutation");
      },
      action: async (fn, args) => {
        void args;
        const { getFunctionName } = await import("convex/server");
        attempts.push(`action ${getFunctionName(fn as never)}`);
        throw new Error("this test's client refuses every action");
      },
    };
    return { client, inner, attempts };
  }

  async function connect(client: FakeClient) {
    const server = new McpServer({ name: "nb-setbuild-readonly-test", version: "0.0.0" });
    registerTools(server, createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" }), { secrets: [] });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "readonly-test", version: "0.0.0" });
    await mcp.connect(clientSide);
    return { mcp, close: async () => (await mcp.close(), await server.close()) };
  }

  test.each([
    ["a finished set", done()],
    ["an empty set", { ...done(), baseCards: 0, sepiaCards: 0 }],
    ["an unsynced tree", { synced: false, baseCards: 0, sepiaCards: 0, reviewRows: [] }],
  ])("every read tool answers on %s and attempts no mutation or action", async (_label, w) => {
    const { client, attempts } = throwingWorld(w);
    const { mcp, close } = await connect(client);
    try {
      const calls: Record<Exclude<(typeof READ_TOOLS)[number], "nb_draft_set">, Record<string, unknown>> = {
        nb_inspect: { path: PATH, attention: true },
        nb_plan: { spec: spec() },
        nb_review_items: { path: PATH },
        nb_attention: { path: PATH, detail: "full" },
      };
      // nb_draft_set reads marketplaces through the preview actions; its own
      // test below holds it to exactly those.
      for (const tool of READ_TOOLS.filter((t) => t !== "nb_draft_set") as Array<keyof typeof calls>) {
        const r = await mcp.callTool({ name: tool, arguments: calls[tool] });
        const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
        // nb_attention names a set that does not resolve (yet) with candidates, as every tool but inspect does.
        if (tool === "nb_attention" && r.isError && JSON.parse(text).error === "resolve") continue;
        expect(r.isError, `${tool}: ${text}`).not.toBe(true);
      }
      // The brand-year forms too (the world may not model every read they make;
      // what matters here is that nothing but a query is attempted).
      const brandYear = { sport: "Baseball", year: "2024", manufacturer: "Topps" };
      await mcp.callTool({ name: "nb_inspect", arguments: { path: brandYear } });
      await mcp.callTool({ name: "nb_review_items", arguments: { path: brandYear } });
      await mcp.callTool({ name: "nb_attention", arguments: { path: brandYear } });
      expect(attempts).toEqual([]);
      expect(client.calls.filter((c) => c.kind === "mutation" || c.kind === "action")).toEqual([]);
    } finally {
      await close();
    }
  });

  test.each([
    ["a finished set", done()],
    ["an unsynced tree", { synced: false, baseCards: 0, sepiaCards: 0, reviewRows: [] }],
  ])("nb_draft_set on %s attempts no mutation, and no action beyond the draft's marketplace reads", async (_label, w) => {
    const { client, attempts } = throwingWorld(w);
    const { mcp, close } = await connect(client);
    try {
      await mcp.callTool({ name: "nb_draft_set", arguments: { path: PATH } });
      expect(attempts.filter((a) => a.startsWith("mutation"))).toEqual([]);
      for (const a of attempts) expect(DRAFT_READ_ACTIONS.has(a.replace(/^action /, "")), a).toBe(true);
    } finally {
      await close();
    }
  });

  test("queryOnlyClient refuses every mutation and action before it reaches the client", async () => {
    const inner = fakeClient()
      .on("selectorOptions:getSelectorOptions", [])
      .on("setReconciliation:fetchRawOptions", { success: true });
    const qo = queryOnlyClient(inner);
    const { api } = await import("../../../convex/_generated/api");
    await expect(
      qo.mutation(api.entityReviewQueue.recordDecision, { reviewRowId: "x" as never, action: "skip" }),
    ).rejects.toBeInstanceOf(ReadOnlyViolation);
    // Even plan's one allowed marketplace read is refused here.
    await expect(qo.action(api.setReconciliation.fetchRawOptions, { level: "insert" } as never)).rejects.toBeInstanceOf(
      ReadOnlyViolation,
    );
    await qo.query(api.selectorOptions.getSelectorOptions, { level: "sport" });
    expect(inner.calls.map((c) => `${c.kind} ${c.fn}`)).toEqual(["query selectorOptions:getSelectorOptions"]);
  });
});

describe("attention: a build that leaves something for a person never reads as done", () => {
  /** A Base card with no team and no lookup pending: the walker's missingTeam. */
  const teamless = (n: string) => ({
    _id: `card-${n}`,
    _creationTime: 1,
    cardNumber: n,
    cardName: `Player ${n}`,
    selectorOptionId: "vtB",
    playerIds: ["pl1"],
    teamOnCardIds: [],
    platformData: {},
  });
  const nameToCheck = {
    "setName:mf": [
      { existingId: "st", currentValue: "Topps Chrome", suggestions: [{ side: "sportlots", label: "Chrome", foldEqual: false }], baseVersion: 4 },
    ],
  };

  /** The per-card fixer reads `nb_attention` makes; the end of an apply and inspect make none. */
  const FIXER_READS = [
    "cardChecklist:suggestedTeamsForCard",
    "players:getManyByIds",
    "teams:getManyByIds",
    "teams:erasByNameAndSport",
    "selectorOptions:previewListingTitle",
  ];
  const fixerReads = (client: ReturnType<typeof world>) => client.calls.filter((c) => FIXER_READS.includes(c.fn));

  test("apply: each set link carries attention, and the last line says what is left", async () => {
    const client = world({ ...done(), attentionCards: [teamless("7")], suggestions: nameToCheck });
    const r = await applySpec(client, FAKE_TARGET, spec(), CONFIRM, {
      pausedPlatforms: "",
    });
    // Totals only: the checklist walk and the rule, no per-card fixer read.
    expect(fixerReads(client)).toEqual([]);
    expect(r.setLinks?.[0].attention).toMatchObject({ cards: 1, byKind: { missingTeam: 1 }, namesToCheck: 1, slSetsToSort: 0 });
    expect(r.setLinks?.[0].attention?.summary).toBe("1 card needs you on Topps Chrome; 1 name to check.");
    expect(r.attentionLine).toBe("Built, but not done: 1 card needs you on Topps Chrome; 1 name to check. Run nb_attention to walk them.");
  });

  test("apply: all clear only when nothing is waiting", async () => {
    const r = await applySpec(world(done()), FAKE_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    expect(r.attentionLine).toBe("Built and all clear.");
    expect(r.setLinks?.[0].attention?.summary).toBe("All clear — nothing on this checklist needs attention.");
  });

  test("apply: the attention read is queries only, and its failure costs the report nothing", async () => {
    const client = world(done());
    await applySpec(client, FAKE_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    const before = client.writes().length;
    client.on("selectorOptions:getCardChecklist", () => {
      throw new Error("Convex is down");
    });
    const r = await applySpec(client, FAKE_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    expect(client.writes().length).toBe(before);
    expect(r.setLinks?.[0].attention).toBeUndefined();
    expect(r.attentionLine).toMatch(/^Built, but not done: could not read what still needs you on Baseball\/2024\/Topps\/Topps Chrome \(Convex is down\)/);
  });

  test("service.attention lists on queries only; inspect adds the summary only when asked", async () => {
    const client = world({ ...done(), attentionCards: [teamless("7"), teamless("12")], suggestions: nameToCheck });
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const a = await svc.read.attention(PATH);
    expect(a.totals).toMatchObject({ cards: 2, namesToCheck: 1, awaitingTeamLookup: 0 });
    expect(a.cards.map((c) => c.cardNumber)).toEqual(["7", "12"]);
    expect(a.names[0]).toMatchObject({ where: SCOPE, currentValue: "Topps Chrome", answers: ["accept", "decline"] });
    expect(a.slReview).toBeNull();
    expect(a.review).toBeNull();
    expect(a.summary).toBe("2 cards need you on Topps Chrome; 1 name to check.");
    expect(client.writes()).toEqual([]);

    expect((await svc.read.inspect(PATH)).attention).toBeUndefined();
    const readsBefore = fixerReads(client).length;
    expect((await svc.read.inspect(PATH, { attention: true })).attention?.summary).toBe(a.summary);
    // inspect --attention is totals only: no per-card fixer read.
    expect(fixerReads(client).length).toBe(readsBefore);
    expect(client.writes()).toEqual([]);
  });

  test("service.fix checks its phrase before any call, and the phrase binds the answers", async () => {
    const client = world({ ...done(), suggestions: nameToCheck });
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const answers = { names: [{ side: "sportlots" as const, action: "decline" as const, label: "Chrome" }] };
    const phrase = fixConfirmPhrase(FAKE_TARGET, PATH, answers);
    const calls = client.calls.length;
    await expect(svc.write.fix(PATH, answers, undefined)).rejects.toBeInstanceOf(ConfirmMismatch);
    await expect(
      svc.write.fix(PATH, { names: [{ ...answers.names[0], action: "accept" }] }, phrase),
    ).rejects.toBeInstanceOf(ConfirmMismatch);
    expect(client.calls.length).toBe(calls);

    let declined = false;
    client.on("selectorOptions:getSelectorSyncSuggestions", (a) => (a.level === "setName" && !declined ? nameToCheck["setName:mf"] : []));
    client.on("selectorOptions:applySelectorSyncSuggestions", () => {
      declined = true;
      return { applied: 0, declined: 1, stale: 0, clashed: 0, skipped: 0 };
    });
    const r = await svc.write.fix(PATH, answers, phrase);
    expect(client.callsTo("selectorOptions:applySelectorSyncSuggestions")[0].args).toEqual({
      level: "setName",
      parentId: "mf",
      decisions: [{ existingId: "st", baseVersion: 4, side: "sportlots", action: "decline" }],
    });
    expect(r.applied).toEqual({ cards: 0, names: 1, autographs: 0 });
    expect(r.remaining.namesToCheck).toBe(0);
    expect(r.summary).toBe("All clear — nothing on this checklist needs attention.");
  });

  describe("a fix that stops part-way never loses what it wrote (security audit)", () => {
    const answers = {
      cards: [{ cardNumber: "7", answer: { noTeam: true as const } }],
      names: [{ side: "sportlots" as const, action: "decline" as const, label: "Chrome" }],
    };
    const setup = () => {
      const client = world({ ...done(), attentionCards: [teamless("7")], suggestions: nameToCheck });
      client.on("cardChecklist:confirmCardNoTeam", { confirmed: true, stamped: true });
      return { client, svc: createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" }), phrase: fixConfirmPhrase(FAKE_TARGET, PATH, answers) };
    };

    test("a names-phase failure after a card was written throws FixAborted with the card result and the unconfirmed name", async () => {
      const { client, svc, phrase } = setup();
      client.on("selectorOptions:applySelectorSyncSuggestions", () => {
        throw new Error("socket closed");
      });
      const err = (await svc.write.fix(PATH, answers, phrase).catch((e) => e)) as FixAborted;
      expect(err).toBeInstanceOf(FixAborted);
      expect(err.results.map((r) => [r.at, r.outcome])).toEqual([["cards[0]", "applied"]]);
      expect(err.unconfirmed).toEqual(["names[0]"]);
      expect(err.message).toBe(
        "fix stopped part-way (socket closed). The answers it settled are listed; list attention again before answering the rest.",
      );
      expect((err.cause as Error).message).toBe("socket closed");
      expect(client.callsTo("cardChecklist:confirmCardNoTeam")).toHaveLength(1);
    });

    test("a card-phase failure throws FixAborted with the cards settled before it", async () => {
      const { client, svc } = setup();
      const two = { cards: [...answers.cards, { cardNumber: "12", answer: { noTeam: true as const } }] };
      client.on("selectorOptions:getCardChecklist", (a) => (a.selectorOptionId === "vtB" ? [teamless("7"), teamless("12")] : []));
      client.on("cardChecklist:confirmCardNoTeam", (a) => {
        if (a.cardId === "card-12") throw new Error("socket closed");
        return { confirmed: true, stamped: true };
      });
      const err = (await svc.write.fix(PATH, two, fixConfirmPhrase(FAKE_TARGET, PATH, two)).catch((e) => e)) as FixAborted;
      expect(err).toBeInstanceOf(FixAborted);
      expect(err.results.map((r) => r.at)).toEqual(["cards[0]"]);
      expect(err.unconfirmed).toEqual([]);
    });

    test("NEO-345: an autograph-phase failure after a card was written throws FixAborted carrying the card and the rows saved before it", async () => {
      const { client, svc } = setup();
      const au = (n: string, home: string) => ({ ...teamless(n), selectorOptionId: home, teamOnCardIds: ["t1"], attributes: ["AU"] });
      const formats: Record<string, Record<string, string>> = {};
      client.on("selectorOptions:getCardChecklist", (a) =>
        a.selectorOptionId === "vtB" ? [teamless("7"), au("8", "vtB")] : a.selectorOptionId === "pS" ? [au("S-1", "pS")] : [],
      );
      client.on("selectorOptions:getSelectorOptionById", (a) =>
        ({ _id: a.id, _creationTime: 1, level: a.id === "vtB" ? "variantType" : "insert", value: String(a.id), platformData: {}, lastUpdated: 1, ...(formats[String(a.id)] ? { features: formats[String(a.id)] } : {}) }),
      );
      client.on("autographFormat:setAutographFormat", (a) => {
        if (a.selectorOptionId === "vtB") throw new Error("socket closed");
        formats[String(a.selectorOptionId)] = { autographFormat: String(a.value) };
        return null;
      });
      const mixed = {
        cards: answers.cards,
        autographs: [{ format: "On Card" as const }, { row: { type: "Parallel", name: "Sepia Refractors" }, format: "On Card" as const }],
      };
      const err = (await svc.write.fix(PATH, mixed, fixConfirmPhrase(FAKE_TARGET, PATH, mixed)).catch((e) => e)) as FixAborted;
      expect(err).toBeInstanceOf(FixAborted);
      // The deeper row (the Base's parallel) is written before the Base, so
      // the Base's own answer can never reach a parallel answered beside it.
      expect(err.results.map((r) => [r.at, r.outcome])).toEqual([
        ["cards[0]", "applied"],
        ["autographs[1]", "applied"],
      ]);
      expect((err.results[1] as { warning?: string }).warning).toBe("The run stopped before this row's cards were checked; list attention again.");
      expect(err.unconfirmed).toEqual([]);
      expect((err.cause as Error).message).toBe("socket closed");
      expect(client.callsTo("autographFormat:setAutographFormat").map((c) => c.args.selectorOptionId)).toEqual(["pS", "vtB"]);
    });

    test("the closing re-read failing after the writes still returns every result", async () => {
      const { client, svc, phrase } = setup();
      let written = false;
      client.on("selectorOptions:applySelectorSyncSuggestions", () => {
        written = true;
        return { applied: 0, declined: 1, stale: 0, clashed: 0, skipped: 0 };
      });
      client.on("selectorOptions:getSelectorSyncSuggestions", (a) => {
        if (written && a.level === "variantType") throw new Error("Convex is down");
        return a.level === "setName" && !written ? nameToCheck["setName:mf"] : [];
      });
      const err = (await svc.write.fix(PATH, answers, phrase).catch((e) => e)) as FixAborted;
      expect(err).toBeInstanceOf(FixAborted);
      expect(err.results.map((r) => [r.at, r.outcome])).toEqual([
        ["cards[0]", "applied"],
        ["names[0]", "applied"],
      ]);
    });
  });

  test("a batch is capped: 100 card answers and 200 name answers per call, refused before any call", async () => {
    const client = world(done());
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const cards = Array.from({ length: 101 }, (_, i) => ({ cardNumber: String(i + 1), answer: { noTeam: true as const } }));
    const names = Array.from({ length: 201 }, () => ({ side: "bsc" as const, action: "decline" as const, label: "X" }));
    const calls = client.calls.length;
    await expect(svc.write.fix(PATH, { cards }, fixConfirmPhrase(FAKE_TARGET, PATH, { cards }))).rejects.toThrow(
      "cards: At most 100 card answers per call; split the batch and confirm each part.",
    );
    await expect(svc.write.fix(PATH, { names }, fixConfirmPhrase(FAKE_TARGET, PATH, { names }))).rejects.toThrow(
      "names: At most 200 name answers per call; split the batch and confirm each part.",
    );
    expect(client.calls.length).toBe(calls);
    // The caps themselves are accepted.
    expect(() => parseFixAnswers({ cards: cards.slice(0, 100), names: names.slice(0, 200) })).not.toThrow();
  });

  test("service.fix refuses card answers on a brand-year path, before any call", async () => {
    const client = world(done());
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const brand = { sport: "Baseball", year: "2024", manufacturer: "Topps" };
    const answers = { cards: [{ cardNumber: "7", answer: { noTeam: true as const } }] };
    const calls = client.calls.length;
    await expect(svc.write.fix(brand, answers, fixConfirmPhrase(FAKE_TARGET, brand, answers))).rejects.toThrow(/brand-year/);
    expect(client.calls.length).toBe(calls);
  });
});

describe("NEO-345: the autograph format, through the spec, the listing and nb_fix", () => {
  const auCard = (n: string, autographed?: string) => ({
    _id: `card-${n}`,
    _creationTime: 1,
    cardNumber: n,
    cardName: `Auto ${n}`,
    selectorOptionId: "vtB",
    // NEO-339: linked to a player and a team, so the autograph prompt is the
    // only thing these cards ask.
    playerIds: ["p1"],
    teamOnCardIds: ["t1"],
    listingTitle: "T",
    attributes: ["AU"],
    platformData: {},
    ...(autographed ? { features: { autographed } } : {}),
  });

  test("a spec's autographFormat rides on the commit as the wizard's answer, and the plan shows it", async () => {
    const answered = spec();
    (answered.steps[0].base.checklist as Record<string, unknown>).autographFormat = "On Card";
    const w: World = { ...done(), baseCards: 0, sepiaCards: 2, reviewRows: [] };
    const client = world(w);
    client.on("selectorOptions:resolveChecklistEntities", () => ({ unknownPlayers: [], unknownTeams: [] }));
    const plan = await planSpec(world({ ...done(), baseCards: 0, sepiaCards: 2, reviewRows: [] }), FAKE_TARGET, answered, { pausedPlatforms: "" });
    expect(plan.steps.find((s) => s.kind === "checklist")?.detail).toBe("the review is only known once apply fetches it; autographs: On Card");
    const r = await applySpec(client, FAKE_TARGET, answered, confirmFor(answered), { pausedPlatforms: "" });
    expect(r.stoppedAt).toBeUndefined();
    expect(client.callsTo("selectorOptions:commitCardChecklist")[0].args).toMatchObject({ selectorOptionId: "vtB", autographFormat: "On Card" });
    // Without it the commit sends none (the default: save and list).
    const plain = world({ ...done(), baseCards: 0, sepiaCards: 2, reviewRows: [] });
    plain.on("selectorOptions:resolveChecklistEntities", () => ({ unknownPlayers: [], unknownTeams: [] }));
    await applySpec(plain, FAKE_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    expect("autographFormat" in plain.callsTo("selectorOptions:commitCardChecklist")[0].args).toBe(false);
  });

  test("apply with the format unanswered still builds, and its last line names the rows; nb_attention lists them with the links note", async () => {
    const client = world({ ...done(), attentionCards: [auCard("1"), auCard("2", "None")] });
    const r = await applySpec(client, FAKE_TARGET, spec(), CONFIRM, { pausedPlatforms: "" });
    expect(r.setLinks?.[0].attention).toMatchObject({ autographRows: 1, cards: 0 });
    expect(r.attentionLine).toBe("Built, but not done: 1 autograph row to mark on-card or sticker on Topps Chrome. Run nb_attention to walk them.");
    expect(r.linksNote).toBe("Links are paths only: set NB_SETBUILD_APP_URL to the app address for this deployment.");

    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const a = await svc.read.attention(PATH);
    expect(a.autographs).toEqual([
      expect.objectContaining({ row: { type: "Base" }, rowLabel: "Base", rowId: "vtB", cards: 2, prompt: "2 autographed cards — on card or sticker?", link: "/admin/set-builder?sport=sp&year=yr&brand=mf&set=st&type=vtB" }),
    ]);
    expect(a.linksNote).toBe("Links are paths only: set NB_SETBUILD_APP_URL to the app address for this deployment.");
    expect((await svc.read.inspect(PATH)).linksNote).toBe(a.linksNote);
    // With an app address the links are absolute and there is nothing to say.
    const withApp = { ...FAKE_TARGET, appOrigin: "https://app.example.test" };
    const appClient = Object.assign(world({ ...done(), attentionCards: [auCard("1")] }), { target: withApp });
    const b = await createSetBuildService(appClient, withApp, { pausedPlatforms: "" }).read.attention(PATH);
    expect(b.linksNote).toBeUndefined();
    expect(b.autographs[0].link.startsWith("https://app.example.test/admin/set-builder?")).toBe(true);
  });

  test("nb_fix autographs: the phrase binds them, the prompt's mutation writes the row, the wait sees the cards marked", async () => {
    const w: World = { ...done(), attentionCards: [auCard("1"), auCard("2")] };
    const client = world(w);
    client.on("selectorOptions:getSelectorOptionById", (a) => (a.id === "vtB" ? sel("vtB", "variantType", "Base", w.baseFeatures ? { features: w.baseFeatures } : {}) : null));
    client.on("autographFormat:setAutographFormat", (a) => {
      w.baseFeatures = { autographFormat: String(a.value) };
      // The server's scheduled walk: the row's AU cards take the format.
      w.attentionCards = (w.attentionCards ?? []).map((c) => ({ ...c, features: { autographed: String(a.value) } }));
      return null;
    });
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const answers = { autographs: [{ format: "Sticker/Label" as const }] };
    const phrase = fixConfirmPhrase(FAKE_TARGET, PATH, answers);
    // The digest binds the answer: another format, or none, is another phrase.
    expect(fixConfirmPhrase(FAKE_TARGET, PATH, { autographs: [{ format: "On Card" }] })).not.toBe(phrase);
    expect(fixConfirmPhrase(FAKE_TARGET, PATH, {})).not.toBe(phrase);
    // An empty list is the phrase it always was.
    expect(fixConfirmPhrase(FAKE_TARGET, PATH, { autographs: [] })).toBe(fixConfirmPhrase(FAKE_TARGET, PATH, {}));
    await expect(svc.write.fix(PATH, { autographs: [{ format: "On Card" }] }, phrase)).rejects.toBeInstanceOf(ConfirmMismatch);
    expect(client.callsTo("autographFormat:setAutographFormat")).toEqual([]);

    const r = await svc.write.fix(PATH, answers, phrase);
    expect(client.callsTo("autographFormat:setAutographFormat").map((c) => c.args)).toEqual([{ selectorOptionId: "vtB", value: "Sticker/Label" }]);
    expect(r.applied).toEqual({ cards: 0, names: 0, autographs: 1 });
    expect(r.results).toEqual([
      expect.objectContaining({ at: "autographs[0]", outcome: "applied", detail: "Autographs saved as sticker. 2 cards on Base now marked sticker." }),
    ]);
    expect(r.remaining.autographRows).toBe(0);
    expect(r.summary).toBe("All clear — nothing on this checklist needs attention.");
  });

  test("autograph answers go on a set path; the parse holds the vocabulary", async () => {
    const client = world(done());
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const brand = { sport: "Baseball", year: "2024", manufacturer: "Topps" };
    const answers = { autographs: [{ format: "On Card" as const }] };
    await expect(svc.write.fix(brand, answers, fixConfirmPhrase(FAKE_TARGET, brand, answers))).rejects.toThrow(
      "Baseball/2024/Topps is a brand-year; card, autograph and detach answers go on the set's path (Sport/Year/Manufacturer/Set).",
    );
    expect(() => parseFixAnswers({ autographs: [{ format: "on card" }] })).toThrow(/autographs\.0\.format/);
    expect(() => parseFixAnswers({ autographs: Array.from({ length: 51 }, () => ({ format: "On Card" })) })).toThrow(
      "At most 50 autograph answers per call; split the batch and confirm each part.",
    );
  });

  test("the SportLots count is named for the brand-year NB resolved, not attached to the set", async () => {
    const client = world(done());
    client.on("slSetReview:getSlSetReviewSummary", { pending: 2, partial: false, moreNextSync: 0 });
    const a = await createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" }).read.attention({ ...PATH, manufacturer: "topps" });
    expect(a.summary).toBe("2 SportLots sets to sort for Topps 2024.");
  });
});

describe("NEO-339: nb_fix detach, the Sources panel's × as an answer", () => {
  test("the phrase binds the link, the panel's mutation detaches it, and the cards it brought are counted, not removed", async () => {
    const client = world(done());
    const sepia = sel("pS", "insert", "Sepia Refractors", { platformData: { bsc: { s1: "bsc-sepia" } } });
    client.on("selectorOptions:getSelectorOptionById", (a) => (a.id === "pS" ? sepia : null));
    client.on("selectorOptions:getSlotCardCounts", () => ({ bsc: { s1: 2 }, sportlots: {}, total: 2 }));
    client.on("selectorOptions:detachPlatformId", () => ({ success: true, message: "ok", orphanedCards: 2 }));
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const answers = { detach: [{ row: { type: "Parallel", name: "Sepia Refractors" }, side: "bsc" as const, id: "bsc-sepia" }] };
    const phrase = fixConfirmPhrase(FAKE_TARGET, PATH, answers);
    await expect(svc.write.fix(PATH, { detach: [{ ...answers.detach[0], id: "other" }] }, phrase)).rejects.toBeInstanceOf(ConfirmMismatch);
    expect(client.callsTo("selectorOptions:detachPlatformId")).toEqual([]);

    const r = await svc.write.fix(PATH, answers, phrase);
    expect(client.callsTo("selectorOptions:detachPlatformId").map((c) => c.args)).toEqual([
      { selectorOptionId: "pS", side: "bsc", slot: "s1", confirmPrimary: true, acknowledgedCards: 2 },
    ]);
    expect(r.applied).toEqual({ cards: 0, names: 0, autographs: 0, detach: 1 });
    expect(r.results).toEqual([expect.objectContaining({ at: "detach[0]", outcome: "applied", orphanedCards: 2, primary: true })]);
    // Nothing else is written: no card is deleted.
    expect(client.writes().map((c) => c.fn)).toEqual(["selectorOptions:detachPlatformId"]);
  });

  test("detach answers go on a set path", async () => {
    const client = world(done());
    const svc = createSetBuildService(client, FAKE_TARGET, { pausedPlatforms: "" });
    const brand = { sport: "Baseball", year: "2024", manufacturer: "Topps" };
    const answers = { detach: [{ side: "sportlots" as const, id: "269998" }] };
    await expect(svc.write.fix(brand, answers, fixConfirmPhrase(FAKE_TARGET, brand, answers))).rejects.toThrow(/is a brand-year; card, autograph and detach answers/);
    expect(client.callsTo("selectorOptions:detachPlatformId")).toEqual([]);
  });
});
