/**
 * NEO-339 part B — `draftSet` on a scripted client: what becomes a proposal
 * and what stays open, that an unresolved set reads nothing and writes
 * nothing, that a tie is never picked, the review's create/open rule, Group
 * Parallels suggestions as proposals, the draft client's refusals, the
 * session and team-lookup guards, and the answers merge the CI proof uses.
 */
import { describe, expect, test } from "vitest";
import { api } from "../../../convex/_generated/api";
import { contentDigest } from "../client/target";
import { countOpenDecisions, specConfirmPhrase, type DraftedReport, type UnresolvedDraftReport } from "../service";
import { parseSpec } from "../spec/schema";
import { draftSet, entitySlices, mergeDraftAnswers, placeholdersIn } from "./draft";
import { FAKE_TARGET, fakeClient, type FakeClient } from "./fake-client";
import { DRAFT_READ_ACTIONS, draftClient, PlanWouldWrite } from "./read-only-client";

const PATH = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome Black" };

const sel = (id: string, level: string, value: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  _creationTime: 1,
  level,
  value,
  platformData: {},
  lastUpdated: 1,
  ...extra,
});
const item = (value: string, platformValue: string) => ({ value, platformValue });

function raw(o: { autoMatched?: Array<[string, string, string, string]>; bsc?: Array<[string, string]>; sl?: Array<[string, string]> }) {
  const autoMatched = (o.autoMatched ?? []).map(([bv, bid, sv, sid]) => ({ displayName: bv, bsc: item(bv, bid), sl: item(sv, sid), confidence: 0.99 }));
  const unmatchedBsc = (o.bsc ?? []).map(([v, id]) => item(v, id));
  const unmatchedSl = (o.sl ?? []).map(([v, id]) => item(v, id));
  return {
    success: true,
    bscOptions: [...autoMatched.map((m) => m.bsc), ...unmatchedBsc],
    slOptions: [...autoMatched.map((m) => m.sl), ...unmatchedSl],
    autoMatched,
    unmatchedBsc,
    unmatchedSl,
    slCandidates: [],
    errors: [],
    message: "",
    skippedSides: [],
    pausedSides: [],
    twinIds: { bsc: [], sportlots: [] },
  };
}

interface Card {
  num: string;
  players: string[];
  teams?: string[];
  bsc?: string;
  sl?: string;
}
const card = (c: Card) => ({
  cardNumber: c.num,
  cardName: c.players.join(", "),
  players: c.players,
  ...(c.teams ? { teams: c.teams } : {}),
  platformData: { ...(c.bsc ? { bsc: { ref: c.bsc } } : {}), ...(c.sl ? { sportlots: { ref: c.sl } } : {}) },
});
function preview(matched: Card[], bscOnly: Card[] = [], opts: { needed?: number; extra?: Record<string, unknown> } = {}) {
  return {
    success: true,
    message: "ok",
    attachedSides: ["bsc", "sportlots"],
    pausedSides: [],
    matched: matched.map((c) => ({ card: card(c), confidence: 1 })),
    bscOnly: bscOnly.map(card),
    slOnly: [],
    teamLookup: { needed: opts.needed ?? 0, performed: (opts.needed ?? 0) > 0, resolved: 0 },
    marketplaceCalls: 3,
    ...opts.extra,
  };
}

/** NB's players: a name with candidates, and the ones NB knows exactly. */
const PLAYERS: Record<string, { status: "known" | "unknown"; candidates: Array<{ playerId: string; name: string }> }> = {
  "Mike Trout": { status: "known", candidates: [] },
  "Aaron Judge": { status: "unknown", candidates: [{ playerId: "pj1", name: "Aaron Judge" }, { playerId: "pj2", name: "Aaron Judge" }] },
};

interface WorldOpts {
  setExists?: boolean;
  setsSynced?: boolean;
  baseSl?: Array<[string, string]>;
  basePreview?: unknown;
  insertPreview?: (args: Record<string, unknown>) => unknown;
}

/**
 * 2024 Topps: Topps Chrome Black (cold: no variant types yet) and Topps
 * Chrome, whose Future Stars row holds SportLots `sl-held`. BSC lists Base,
 * Insert and Parallel for Chrome Black.
 */
function world(o: WorldOpts = {}): FakeClient {
  const sets = o.setsSynced === false
    ? []
    : [
        ...(o.setExists === false ? [] : [sel("st", "setName", "Topps Chrome Black", { platformData: { bsc: { b0: "topps-chrome-black" } } })]),
        sel("tc", "setName", "Topps Chrome", { platformData: { bsc: { b0: "topps-chrome" } } }),
      ];
  const tree: Record<string, unknown[]> = {
    "sport:": [sel("sp", "sport", "Baseball")],
    "year:sp": [sel("yr", "year", "2024")],
    "manufacturer:yr": [sel("mf", "manufacturer", "Topps")],
    "setName:mf": sets,
    "variantType:tc": [sel("tcI", "variantType", "Insert", { metadata: { variantRole: "insert" } })],
  };
  const baseCands = raw({ bsc: [["Topps Chrome Black", "topps-chrome-black"]], sl: o.baseSl ?? [["Topps Chrome Black", "sl-black"], ["Topps Chrome", "sl-chrome"]] });
  return fakeClient()
    .on("marketplacePause:getPausedPlatforms", [])
    .on("selectorOptions:getSelectorOptions", (a) => tree[`${a.level}:${a.parentId ?? ""}`] ?? [])
    .on("selectorOptions:getInsertTreeByVariantType", (a) =>
      a.variantTypeId === "tcI"
        ? [{ insert: sel("tcFS", "insert", "Future Stars", { platformData: { sportlots: { s0: "sl-held" } } }), parallels: [] }]
        : [],
    )
    .on("selectorOptions:getUsedInsertIdentifiersBySet", { values: [], slPlatformValues: [], bscPlatformValues: [] })
    .on("setReconciliation:previewSetStructure", (a) => ({
      success: true,
      message: "",
      variantTypes: raw({ bsc: [["Base", "base"], ["Insert", "insert"], ["Parallel", "parallel"]] }),
      types: [
        { bscVariantId: "base", label: "Base", role: "base", candidates: baseCands },
        {
          bscVariantId: "insert",
          label: "Insert",
          role: "insert",
          candidates: raw({
            autoMatched: [
              ["Future Stars", "fs", "2024 Topps Chrome Black Future Stars", "sl-fs"],
              ["Future Stars Gold", "fs-gold", "2024 Topps Chrome Black Future Stars Gold", "sl-fsg"],
            ],
            sl: [["2024 Topps Chrome Black Something", "sl-other"], ["2024 Topps Chrome Future Stars", "sl-held"]],
          }),
        },
        { bscVariantId: "parallel", label: "Parallel", role: "parallel", candidates: raw({ autoMatched: [["Gold Refractors", "gold", "2024 Topps Chrome Black Gold Refractors", "sl-gold"]] }) },
      ],
      ...(a.baseSportlotsId ? { baseSportlots: { id: a.baseSportlotsId, label: "Topps Chrome Black", source: "argument" } } : {}),
      skippedTypes: 0,
      marketplaceCalls: a.baseSportlotsId ? 5 : 5,
    }))
    .on("selectorOptions:previewCardChecklist", (a) => {
      const cold = a.cold as { insert?: unknown } | undefined;
      if (cold && !cold.insert) {
        return o.basePreview ?? preview(
          [
            { num: "1", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"], bsc: "b1", sl: "s1" },
            { num: "2", players: ["Aaron Judge"], bsc: "b2", sl: "s2" },
            { num: "3", players: ["Mike Trout"], bsc: "b3", sl: "s3" },
          ],
          [{ num: "4", players: ["New Guy"], bsc: "b4" }],
        );
      }
      return o.insertPreview?.(a) ?? preview([
        { num: "FS-1", players: ["Shohei Ohtani"], bsc: "fs1", sl: "sfs1" },
        { num: "FS-2", players: ["Bobby Witt Jr."], bsc: "fs2", sl: "sfs2" },
      ]);
    })
    .on("selectorOptions:previewChecklistEntities", (a) => ({
      setYear: 2024,
      players: (a.players as string[]).map((name) => {
        const p = PLAYERS[name] ?? { status: "unknown", candidates: [] };
        return {
          name,
          status: p.status,
          matchCount: p.status === "known" ? 1 : p.candidates.length,
          ...(p.status === "known" ? { playerId: "pk" } : {}),
          candidates: p.candidates,
        };
      }),
      teams: (a.teams as string[]).map((name) => ({ name, status: name === "Los Angeles Dodgers" ? "known" : "unknown", candidates: [] })),
    }));
}

type Spec = {
  steps: Array<{
    base?: { map: Record<string, string>; checklist?: { review: unknown; expectCards?: number } };
    variants?: Array<{ type: string; sync?: { pairs: unknown[]; pending: unknown[] }; expectRows?: number; group?: { parents: unknown[]; expectUngrouped?: number }; rows?: Array<Record<string, unknown>> }>;
  }>;
};

async function drafted(client: FakeClient, opts = {}): Promise<DraftedReport> {
  const r = await draftSet(client, FAKE_TARGET, PATH, opts);
  expect(r.status).toBe("drafted");
  return r as DraftedReport;
}

describe("draftSet: proposals vs open decisions", () => {
  test("a cold set is drafted whole: proposals filled (pending sets left, explicitly), every name with candidates left open", async () => {
    const client = world();
    const r = await drafted(client);
    const spec = r.spec as unknown as Spec;
    const step = spec.steps[0];

    // Base: the sole BSC candidate, SportLots' sole exact match.
    expect(step.base!.map).toEqual({ bsc: "topps-chrome-black", sportlots: "sl-black", whenPaused: "bsc-only" });
    // Insert: the two auto-matches are pairs; the pending SportLots set is an
    // explicit `leave` (what Save does with Pending; own-set is never
    // proposed), and the set Topps Chrome holds is not pending at all.
    const insert = step.variants!.find((v) => v.type === "Insert")!;
    expect(insert.sync).toEqual({
      pairs: [
        { name: "Future Stars", bsc: ["fs"], sportlots: ["sl-fs"] },
        { name: "Future Stars Gold", bsc: ["fs-gold"], sportlots: ["sl-fsg"] },
      ],
      pending: [{ side: "sportlots", id: "sl-other", decision: "leave" }],
    });
    expect(r.openDecisions.reconcile).toEqual([]);
    expect(r.proposals.filter((p) => p.kind === "reconcile-leave")).toEqual([
      {
        at: "steps[0].variants[0].sync.pending",
        kind: "reconcile-leave",
        detail: "1 Insert set(s) not paired; the dialog leaves them in Pending (SportLots 1: sl-other)",
      },
    ]);
    expect(JSON.stringify(r.spec)).not.toContain("own-set");
    // With every pending set answered, the counts are proposals too.
    expect(insert.expectRows).toBe(2);
    expect(insert.group!.expectUngrouped).toBe(0);

    // Review: zero candidates → create; candidates → open, never linked.
    expect(step.base!.checklist!.review).toEqual({
      players: [
        { name: "Shohei Ohtani", decision: "create" },
        { name: "New Guy", decision: "create" },
      ],
      teams: [],
      leagues: [],
    });
    expect(r.openDecisions.review.players.map((p) => [p.name, p.candidates.map((c) => c.id)])).toEqual([["Aaron Judge", ["pj1", "pj2"]]]);
    // Ohtani is decided at the Base (apply creates him there), so Future Stars' review does not list him.
    expect(insert.rows![0].checklist).toMatchObject({ review: { players: [{ name: "Bobby Witt Jr.", decision: "create" }] }, expectCards: 2 });
    expect(step.base!.checklist!.expectCards).toBe(4);

    // Open → no phrase; the template carries every fill-in and nothing else is missing.
    expect(r.openCount).toBe(countOpenDecisions(r.openDecisions));
    expect(r.openCount).toBe(1);
    expect(r.confirmPhrase).toBeNull();
    expect(placeholdersIn(r.template)).toEqual(["steps[0].base.checklist.review.players[2].decision"]);
    // The partial spec is still a spec.
    expect(() => parseSpec(r.spec)).not.toThrow();
    expect(r.proposals.map((p) => p.kind)).toEqual(
      expect.arrayContaining(["base-map", "reconcile-pairs", "reconcile-leave", "grouping", "review-create", "pairing", "expect", "build"]),
    );
  });

  test("Group Parallels suggestions become group entries by marketplace id, and the child is built from its insert", async () => {
    const r = await drafted(world());
    const insert = (r.spec as unknown as Spec).steps[0].variants!.find((v) => v.type === "Insert")!;
    expect(insert.group!.parents).toEqual([{ insert: { bsc: "fs" }, parallels: [{ bsc: "fs-gold" }] }]);
    expect(insert.rows).toEqual([
      expect.objectContaining({ name: "Future Stars", parallels: [{ name: "Future Stars Gold", build: {} }] }),
    ]);
    expect(r.proposals.find((p) => p.kind === "grouping")).toMatchObject({ at: "steps[0].variants[0].group" });
    // Parallel rows are built from Base.
    const parallel = (r.spec as unknown as Spec).steps[0].variants!.find((v) => v.type === "Parallel")!;
    expect(parallel.rows).toEqual([{ name: "Gold Refractors", buildFromBase: {} }]);
    expect(parallel.expectRows).toBe(1);
    expect(parallel.group).toBeUndefined();
  });

  test("the previews are sent only ids this draft's structure preview returned; nothing writes", async () => {
    const client = world();
    await drafted(client);
    const structure = client.callsTo("setReconciliation:previewSetStructure").map((c) => c.args);
    // Re-read against the draft's own Base SportLots pick.
    expect(structure).toEqual([{ setId: "st" }, { setId: "st", baseSportlotsId: "sl-black" }]);
    const previews = client.callsTo("selectorOptions:previewCardChecklist").map((c) => c.args);
    expect(previews).toEqual([
      { cold: { setId: "st", variantType: { bscVariantId: "base", sportlotsIds: ["sl-black"] } }, lookupTeams: true },
      { cold: { setId: "st", variantType: { bscVariantId: "insert" }, insert: { bscVariantNameIds: ["fs"], sportlotsIds: ["sl-fs"] } }, lookupTeams: true },
    ]);
    // Entities: one-shot queries, never a subscription.
    expect(client.calls.filter((c) => c.kind === "waitFor")).toEqual([]);
    expect(client.callsTo("selectorOptions:previewChecklistEntities").every((c) => c.kind === "query")).toBe(true);
    expect(client.calls.filter((c) => c.kind === "mutation")).toEqual([]);
    for (const w of client.writes()) expect(DRAFT_READ_ACTIONS.has(w.fn), w.fn).toBe(true);
    // The engine's step walk sends no action at all.
    expect(client.callsTo("selectorOptions:ensureSelectorOptions")).toEqual([]);
  });

  test("with nothing open, the spec is complete and carries the apply phrase", async () => {
    const client = world({
      basePreview: preview([{ num: "1", players: ["Mike Trout"], bsc: "b1", sl: "s1" }]),
    }).on("setReconciliation:previewSetStructure", (a) => ({
      success: true,
      message: "",
      variantTypes: raw({}),
      types: [
        { bscVariantId: "base", label: "Base", role: "base", candidates: raw({ bsc: [["Topps Chrome Black", "topps-chrome-black"]], sl: [["Topps Chrome Black", "sl-black"]] }) },
        { bscVariantId: "parallel", label: "Parallel", role: "parallel", candidates: raw({ autoMatched: [["Gold", "gold", "Black Gold", "sl-gold"]] }) },
      ],
      ...(a.baseSportlotsId ? { baseSportlots: { id: "sl-black", label: "Topps Chrome Black", source: "argument" } } : {}),
      skippedTypes: 0,
      marketplaceCalls: 3,
    }));
    const r = await drafted(client);
    expect(r.openCount).toBe(0);
    expect(r.template).toBeNull();
    expect(r.confirmPhrase).toBe(specConfirmPhrase(FAKE_TARGET, parseSpec(r.spec)));
    expect((r.spec as unknown as Spec).steps[0].base!.checklist).toEqual({
      pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" },
      review: "none-expected",
      expectCards: 1,
    });
    expect(r.marketplaceCalls).toBe(3 + 3 + 3);
  });
});

describe("draftSet: never guesses", () => {
  test("an unresolved set returns its candidates, reads no marketplace and writes nothing", async () => {
    const client = world();
    const r = (await draftSet(client, FAKE_TARGET, { ...PATH, set: "Topps Chrome Blk" }, {})) as UnresolvedDraftReport;
    expect(r.status).toBe("unresolved");
    expect(r.kind).toBe("set");
    expect(r.prepare).toBeUndefined();
    expect(client.writes()).toEqual([]);
    expect(client.calls.every((c) => c.kind === "query")).toBe(true);

    const near = (await draftSet(world(), FAKE_TARGET, { ...PATH, set: "Chrome" }, {})) as UnresolvedDraftReport;
    expect(near.candidates.map((c) => c.name)).toEqual(["Topps Chrome Black", "Topps Chrome"]);
  });

  test("a brand-year whose Sets were never synced comes back with the prepare spec", async () => {
    const client = world({ setsSynced: false });
    const r = (await draftSet(client, FAKE_TARGET, PATH, {})) as UnresolvedDraftReport;
    expect(r.status).toBe("unresolved");
    expect(r.prepare?.spec).toEqual({
      version: 1,
      scope: "Baseball/2024/Topps",
      steps: [{ kind: "brand-year", path: { sport: "Baseball", year: "2024", manufacturer: "Topps" }, syncSets: true }],
    });
    expect(() => parseSpec(r.prepare!.spec)).not.toThrow();
    expect(client.writes()).toEqual([]);
  });

  test("a tie is never picked: two exact SportLots Base candidates leave the mapping open, and nothing below it is guessed", async () => {
    const client = world({ baseSl: [["Topps Chrome Black", "sl-a"], ["Topps Chrome Black", "sl-b"]] });
    const r = await drafted(client);
    const spec = r.spec as unknown as Spec;
    expect(spec.steps[0].base).toBeUndefined();
    expect(r.openDecisions.baseCandidates).toEqual([
      expect.objectContaining({ side: "sportlots", at: "steps[0].base.map.sportlots", candidates: [expect.objectContaining({ id: "sl-a" }), expect.objectContaining({ id: "sl-b" })] }),
    ]);
    const tpl = r.template as unknown as Spec;
    expect(tpl.steps[0].base!.map).toEqual({ bsc: "topps-chrome-black", sportlots: "<one of: sl-a (Topps Chrome Black) | sl-b (Topps Chrome Black)>", whenPaused: "bsc-only" });
    // No re-read against a Base pick, and no Base checklist preview.
    expect(client.callsTo("setReconciliation:previewSetStructure")).toHaveLength(1);
    expect(client.callsTo("selectorOptions:previewCardChecklist").every((c) => (c.args.cold as { insert?: unknown }).insert)).toBe(true);
    expect(r.openDecisions.names.map((n) => n.kind)).toContain("checklist-preview");
  });

  test("a name with ZERO candidates is proposed create; one with any candidate is open with them", async () => {
    const r = await drafted(world());
    const creates = r.proposals.filter((p) => p.kind === "review-create");
    expect(creates.map((p) => p.at)).toEqual(["steps[0].base.checklist.review", "steps[0].variants[0].rows[0].checklist.review"]);
    expect(r.openDecisions.review.players).toEqual([
      expect.objectContaining({ name: "Aaron Judge", reason: "unanswered", at: "steps[0].base.checklist.review.players" }),
    ]);
    const tpl = r.template as { steps: Array<{ base: { checklist: { review: { players: Array<{ name: string; decision: string }> } } } }> };
    expect(tpl.steps[0].base.checklist.review.players.find((p) => p.name === "Aaron Judge")!.decision).toMatch(/^<"create" \| "skip" \| \{"link"/);
  });
});

describe("draftSet: sessions and budgets (security audit)", () => {
  test("a refused session stops every later preview needing that side, and its text is never copied", async () => {
    const client = world({
      basePreview: { ...preview([]), success: false, message: "Failed to preview checklist: BSC API 401 after re-auth (token abc.def)" },
    });
    const r = await drafted(client);
    // Base failed; Future Stars needs BSC too, so it is not sent.
    expect(client.callsTo("selectorOptions:previewCardChecklist")).toHaveLength(1);
    const conditions = r.openDecisions.names.filter((n) => n.kind === "checklist-preview").map((n) => n.at);
    expect(conditions).toEqual(["steps[0].base.checklist", "steps[0].variants[0].rows[0].checklist"]);
    const text = JSON.stringify(r);
    expect(text).not.toContain("401 after re-auth");
    expect(text).not.toContain("abc.def");
    expect(r.notes.join(" ")).toMatch(/BSC refused the session/);
  });

  test("the team-lookup budget is checked before each preview and never exceeded twice", async () => {
    const client = world({
      basePreview: preview([{ num: "1", players: ["Mike Trout"], bsc: "b1", sl: "s1" }], [], { needed: 5 }),
    });
    const r = await drafted(client, { teamLookupBudget: 3 });
    expect(client.callsTo("selectorOptions:previewCardChecklist").map((c) => c.args.lookupTeams)).toEqual([true, false]);
    expect(r.notes.join(" ")).not.toMatch(/budget is spent/); // the insert needed none
    const off = world();
    await drafted(off, { teamLookupBudget: 0 });
    expect(off.callsTo("selectorOptions:previewCardChecklist").every((c) => c.args.lookupTeams === false)).toBe(true);
  });

  test("checklists: false and builds: false draft structure only", async () => {
    const client = world();
    const r = await drafted(client, { checklists: false, builds: false });
    expect(client.callsTo("selectorOptions:previewCardChecklist")).toEqual([]);
    const spec = r.spec as unknown as Spec;
    expect(spec.steps[0].base!.checklist).toBeUndefined();
    expect(spec.steps[0].variants!.find((v) => v.type === "Parallel")!.rows).toBeUndefined();
    expect(spec.steps[0].variants!.find((v) => v.type === "Insert")!.rows).toEqual([
      { name: "Future Stars", parallels: [{ name: "Future Stars Gold" }] },
    ]);
  });
});

describe("the draft client", () => {
  test("refuses every mutation and every action but fetchRawOptions and the two previews", async () => {
    const inner = fakeClient()
      .on("setReconciliation:previewSetStructure", { ok: 1 })
      .on("selectorOptions:previewCardChecklist", { ok: 2 })
      .on("setReconciliation:fetchRawOptions", { ok: 3 });
    const dc = draftClient(inner);
    expect([...DRAFT_READ_ACTIONS].sort()).toEqual([
      "selectorOptions:previewCardChecklist",
      "setReconciliation:fetchRawOptions",
      "setReconciliation:previewSetStructure",
    ]);
    await expect(dc.action(api.selectorOptions.fetchCardChecklist, { selectorOptionId: "x" as never })).rejects.toBeInstanceOf(PlanWouldWrite);
    await expect(dc.action(api.selectorOptions.resolveChecklistEntities, {} as never)).rejects.toBeInstanceOf(PlanWouldWrite);
    await expect(dc.action(api.selectorOptions.commitCardChecklist, {} as never)).rejects.toBeInstanceOf(PlanWouldWrite);
    await expect(dc.action(api.parallelChecklistBuild.buildParallelChecklist, {} as never)).rejects.toBeInstanceOf(PlanWouldWrite);
    await expect(dc.action(api.selectorOptions.ensureSelectorOptions, {} as never)).rejects.toBeInstanceOf(PlanWouldWrite);
    await expect(dc.mutation(api.selectorOptions.applyParallelGroupings, {} as never)).rejects.toBeInstanceOf(PlanWouldWrite);
    await expect(dc.mutation(api.setReconciliation.storeReconciledOptions, {} as never)).rejects.toBeInstanceOf(PlanWouldWrite);
    await dc.action(api.setReconciliation.previewSetStructure, { setId: "s" as never });
    await dc.action(api.selectorOptions.previewCardChecklist, {});
    await dc.action(api.setReconciliation.fetchRawOptions, { level: "insert" } as never);
    expect(inner.calls.map((c) => c.fn)).toEqual([
      "setReconciliation:previewSetStructure",
      "selectorOptions:previewCardChecklist",
      "setReconciliation:fetchRawOptions",
    ]);
  });
});

describe("pure helpers", () => {
  test("entitySlices never sends more than 200 names in one call", () => {
    const players = Array.from({ length: 250 }, (_, i) => `P${i}`);
    const teams = Array.from({ length: 30 }, (_, i) => `T${i}`);
    const slices = entitySlices(players, teams);
    expect(slices.map((s) => s.players.length + s.teams.length)).toEqual([200, 80]);
    expect(slices.flatMap((s) => s.players)).toEqual(players);
    expect(slices.flatMap((s) => s.teams)).toEqual(teams);
  });

  test("mergeDraftAnswers fills every <…> from the answers and keeps the rest from the draft", async () => {
    const r = await drafted(world());
    const answers = mergeDraftAnswers(r.template, {}) as Record<string, unknown>;
    // With no answers, the fill-in stays.
    expect(placeholdersIn(answers)).toHaveLength(1);
    // A committed answers file: the template with each fill-in answered.
    const committed = structuredClone(r.template) as Spec;
    const base = committed.steps[0].base!.checklist!.review as { players: Array<{ name: string; decision: unknown }> };
    base.players[2].decision = { link: "Aaron Judge" };
    const withCreds = { ...committed, credentials: { seed: ["buysportscards", "sportlots"], warm: true } };
    const merged = mergeDraftAnswers(r.template, withCreds);
    expect(placeholdersIn(merged)).toEqual([]);
    expect(contentDigest(parseSpec(merged))).toBe(contentDigest(parseSpec(withCreds)));
    // Drift is visible: an answers file with an extra pair does not merge to itself.
    const drifted = structuredClone(withCreds) as Spec & Record<string, unknown>;
    drifted.steps[0].variants![0].sync!.pairs.push({ name: "New Insert", bsc: ["new"] });
    expect(contentDigest(parseSpec(mergeDraftAnswers(r.template, drifted)))).not.toBe(contentDigest(parseSpec(drifted)));
  });
});
