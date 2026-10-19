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
import { SAME_NAME_PLAYER_PLACEHOLDER } from "../lib/review";
import {
  compactDraftReport,
  conflictDependentPlayers,
  draftSet,
  entitySlices,
  mergeDraftAnswers,
  namesOnCards,
  placeholdersIn,
  SUMMARY_OUTSIDE_SCOPE,
  SUMMARY_PROPOSALS_PER_KIND,
  unsyncedMessage,
  type CompactDraftReport,
} from "./draft";
import { filedByOtherTypes } from "./engine";
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
const PLAYERS: Record<string, { status: "known" | "unknown"; candidates: Array<{ playerId: string; name: string; birthYear?: number }> }> = {
  "Mike Trout": { status: "known", candidates: [] },
  "Aaron Judge": {
    status: "unknown",
    candidates: [{ playerId: "pj1", name: "Aaron Judge", birthYear: 1992 }, { playerId: "pj2", name: "Aaron Judge" }],
  },
};

interface WorldOpts {
  setExists?: boolean;
  setsSynced?: boolean;
  /** false: Baseball › 2024 holds no manufacturer at all (its column never synced). */
  manufacturersSynced?: boolean;
  /** Extra SportLots sets every Insert/Parallel fetch lists (SportLots' brand-year-wide list). */
  brandYearSl?: Array<[string, string]>;
  baseSl?: Array<[string, string]>;
  basePreview?: unknown;
  insertPreview?: (args: Record<string, unknown>) => unknown;
  /** The Insert type's candidates, in place of the Future Stars / Gold pair. */
  insertCandidates?: ReturnType<typeof raw>;
  /** The brand's SportLots review (`slSetReview:getSlSetReview`); null = none waits. */
  slReview?: unknown;
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
    "manufacturer:yr": o.manufacturersSynced === false ? [] : [sel("mf", "manufacturer", "Topps")],
    "setName:mf": sets,
    "variantType:tc": [sel("tcI", "variantType", "Insert")],
  };
  const baseCands = raw({ bsc: [["Topps Chrome Black", "topps-chrome-black"]], sl: o.baseSl ?? [["Topps Chrome Black", "sl-black"], ["Topps Chrome", "sl-chrome"]] });
  return fakeClient()
    .on("marketplacePause:getPausedPlatforms", [])
    .on("slSetReview:getSlSetReview", o.slReview ?? null)
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
          candidates: o.insertCandidates ?? raw({
            autoMatched: [
              ["Future Stars", "fs", "2024 Topps Chrome Black Future Stars", "sl-fs"],
              ["Future Stars Gold", "fs-gold", "2024 Topps Chrome Black Future Stars Gold", "sl-fsg"],
            ],
            // SportLots names are brand-stripped ("Chrome Black …"). "Heritage
            // Chrome" is another product of the brand-year: outside the set's
            // SportLots filter. sl-gold is the Parallel type's to pair.
            sl: [
              ["Chrome Black Something", "sl-other"],
              ["2024 Topps Chrome Future Stars", "sl-held"],
              ["Heritage Chrome", "sl-heritage"],
              ["Chrome Black Gold Refractors", "sl-gold"],
              ...(o.brandYearSl ?? []),
            ],
          }),
        },
        {
          bscVariantId: "parallel",
          label: "Parallel",
          role: "parallel",
          // SportLots lists the brand-year flat: the Parallel fetch offers the
          // set the Insert sync pairs, too.
          candidates: raw({
            autoMatched: [["Gold Refractors", "gold", "2024 Topps Chrome Black Gold Refractors", "sl-gold"]],
            sl: [
              ["2024 Topps Chrome Black Future Stars", "sl-fs"],
              ["Chrome Black Something", "sl-other"],
              ["Heritage Chrome", "sl-heritage"],
              ...(o.brandYearSl ?? []),
            ],
          }),
        },
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
      // Each with the marketplace's name, so it can be paired from the draft.
      pending: [{ side: "sportlots", id: "sl-other", name: "Chrome Black Something", decision: "leave" }],
    });
    expect(r.openDecisions.reconcile).toEqual([]);
    // Not listed, only counted: Heritage Chrome (another product: outside the
    // set's SportLots filter) and sl-gold (the Parallel type pairs it).
    expect(r.leftUnasked).toEqual([
      {
        at: "steps[0].variants[0].sync.pending",
        type: "Insert",
        outsideScope: 1,
        pairedElsewhere: 1,
        outsideScopeSets: [{ id: "sl-heritage", name: "Heritage Chrome" }],
      },
      {
        at: "steps[0].variants[1].sync.pending",
        type: "Parallel",
        outsideScope: 1,
        pairedElsewhere: 0,
        outsideScopeSets: [{ id: "sl-heritage", name: "Heritage Chrome" }],
      },
    ]);
    expect(r.proposals.filter((p) => p.kind === "reconcile-leave")).toEqual([
      {
        at: "steps[0].variants[0].sync.pending",
        kind: "reconcile-leave",
        detail:
          "1 Insert set(s) not paired (SportLots 1); Save leaves them in Pending. Each is listed with its name: pair any that belong together. " +
          "Not asked about: 1 SportLots set(s) outside this set's SportLots filter (other products of the brand-year); 1 set(s) another variant type pairs.",
      },
      {
        at: "steps[0].variants[1].sync.pending",
        kind: "reconcile-leave",
        detail:
          "1 Parallel set(s) not paired (SportLots 1); Save leaves them in Pending. Each is listed with its name: pair any that belong together. " +
          "Not asked about: 1 SportLots set(s) outside this set's SportLots filter (other products of the brand-year).",
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
    // Ohtani is on both checklists, so BOTH answer him (NEO-339 live: George
    // Brett). Apply creates him at the Base; Future Stars' answer is then moot.
    expect(insert.rows![0].checklist).toMatchObject({
      review: {
        players: [
          { name: "Shohei Ohtani", decision: "create" },
          { name: "Bobby Witt Jr.", decision: "create" },
        ],
      },
      expectCards: 2,
    });
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

  test("a later type's lists are drafted as apply sees them after the earlier types' syncs (NEO-339 live drift b)", async () => {
    const r = await drafted(world());
    const spec = r.spec as unknown as Spec;
    const parallel = spec.steps[0].variants!.find((v) => v.type === "Parallel")!;
    // sl-fs is paired by the Insert sync, which apply runs first: by the
    // Parallel sync it is held (NEO-312), so it is not pending there and gets
    // no `leave`. sl-other is still pending in both types.
    expect(parallel.sync!.pending).toEqual([{ side: "sportlots", id: "sl-other", name: "Chrome Black Something", decision: "leave" }]);
    // The other way round too: sl-gold waits in the Insert dialog's Pending,
    // but the Parallel type pairs it, so the Insert sync does not leave it.
    const insert = spec.steps[0].variants!.find((v) => v.type === "Insert")!;
    expect(insert.sync!.pending.map((p) => (p as { id: string }).id)).toEqual(["sl-other"]);
    // And the engine makes apply honour that order: the Parallel sync waits
    // on an open Insert sync rather than run with sl-fs unheld (collect.test.ts).
    expect(spec.steps[0].variants!.map((v) => v.type)).toEqual(["Insert", "Parallel"]);
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
    const judge = tpl.steps[0].base.checklist.review.players.find((p) => p.name === "Aaron Judge")!.decision;
    expect(judge).toMatch(/^<"create" \| "skip" \| \{"link"/);
    // A same-name pick offers the birth-year form and lists each candidate's year.
    expect(judge.startsWith(SAME_NAME_PLAYER_PLACEHOLDER)).toBe(true);
    expect(judge).toContain("Aaron Judge (born 1992) [pj1]");
    expect(r.openDecisions.review.players[0].candidates).toEqual([
      { id: "pj1", name: "Aaron Judge", detail: "born 1992" },
      { id: "pj2", name: "Aaron Judge" },
    ]);
  });
});

describe("draftSet: multi-team cards (NEO-333)", () => {
  // The preview hands each card the teams the staged row ends up with
  // (`previewCandidateTeams`): a dual-team value already split into two teams,
  // a known comma-bearing team ("Korea, South") whole. The draft must keep
  // both shapes: two team answers for the first, one for the second, and never
  // a combined name or a further split.
  const multiTeamWorld = () =>
    world({
      basePreview: preview(
        [
          { num: "1", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"], bsc: "b1", sl: "s1" },
          { num: "5", players: ["Two Team Guy"], teams: ["Cleveland Guardians", "Washington Nationals"], bsc: "b5", sl: "s5" },
        ],
        [{ num: "6", players: ["Ji-Hwan Bae"], teams: ["Korea, South"], bsc: "b6" }],
        { needed: 3 },
      ),
    });

  test("a dual-team card proposes two team answers; a comma-bearing team stays one", async () => {
    const client = multiTeamWorld();
    const r = await drafted(client);
    const step = (r.spec as unknown as Spec).steps[0];

    const asked = client
      .callsTo("selectorOptions:previewChecklistEntities")
      .flatMap((c) => c.args.teams as string[]);
    expect(asked).toEqual(expect.arrayContaining(["Cleveland Guardians", "Washington Nationals", "Korea, South"]));
    expect(asked).not.toContain("Cleveland Guardians, Washington Nationals");
    expect(asked).not.toContain("Korea");
    expect(asked).not.toContain("South");

    // The dual-team card's player is checked against BOTH of its teams.
    const cardTeams = client
      .callsTo("selectorOptions:previewChecklistEntities")
      .flatMap((c) => (c.args.playerCardTeams as Array<{ player: string; teams: string[] }> | undefined) ?? []);
    expect(cardTeams).toContainEqual({ player: "Two Team Guy", teams: ["Cleveland Guardians", "Washington Nationals"] });
    expect(cardTeams).toContainEqual({ player: "Ji-Hwan Bae", teams: ["Korea, South"] });

    const review = step.base!.checklist!.review as { teams: Array<{ name: string; decision: string }> };
    expect(review.teams).toEqual([
      { name: "Cleveland Guardians", decision: "create" },
      { name: "Washington Nationals", decision: "create" },
      { name: "Korea, South", decision: "create" },
    ]);
  });

  test("namesOnCards keeps each card's teams as given: never joined, never re-split", () => {
    const names = namesOnCards([
      { cardNumber: "5", cardName: "x", players: ["Two Team Guy"], teams: ["Cleveland Guardians", "Washington Nationals"] },
      { cardNumber: "6", cardName: "y", players: ["Ji-Hwan Bae"], teams: ["Korea, South"] },
      { cardNumber: "7", cardName: "z", players: ["Other"], teams: ["Washington Nationals"] },
    ] as unknown as Parameters<typeof namesOnCards>[0]);
    expect(names.teams).toEqual(["Cleveland Guardians", "Washington Nationals", "Korea, South"]);
    expect(names.playerCardTeams.get("Two Team Guy")).toEqual(["Cleveland Guardians", "Washington Nationals"]);
    expect(names.playerCardTeams.get("Ji-Hwan Bae")).toEqual(["Korea, South"]);
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

describe("draftSet: SportLots' brand-year-wide list stays bounded (NEO-339 live: 641,833 characters on 2014 Topps Chrome)", () => {
  // 2014 Topps on SportLots: about a thousand sets, every product of the
  // brand-year, returned by every Insert and Parallel fetch of every set.
  const BRAND_YEAR = Array.from({ length: 1500 }, (_, i): [string, string] => [
    `${["Heritage", "Update", "Allen & Ginter", "Archives", "Stadium Club"][i % 5]} Insert ${i}`,
    `9${String(i).padStart(5, "0")}`,
  ]);

  test("only the set's own sets are listed, each with its name; the brand-year's other products are counted", async () => {
    const r = await drafted(world({ brandYearSl: BRAND_YEAR }));
    const spec = r.spec as unknown as Spec;
    for (const v of spec.steps[0].variants!) {
      expect(v.sync!.pending).toEqual([{ side: "sportlots", id: "sl-other", name: "Chrome Black Something", decision: "leave" }]);
    }
    expect(r.leftUnasked.map((l) => [l.type, l.outsideScope])).toEqual([
      ["Insert", BRAND_YEAR.length + 1],
      ["Parallel", BRAND_YEAR.length + 1],
    ]);
    // Not one brand-year id reaches the spec, the template or a proposal.
    const text = JSON.stringify({ spec: r.spec, template: r.template, proposals: r.proposals });
    expect(text).not.toContain(BRAND_YEAR[0][1]);
    expect(text).not.toContain(BRAND_YEAR[BRAND_YEAR.length - 1][1]);
  });

  test("the summary result (nb_draft_set's default) stays small; detail full keeps every entry", async () => {
    const small = await drafted(world());
    const big = await drafted(world({ brandYearSl: BRAND_YEAR }));
    const size = (x: unknown) => JSON.stringify(x).length;
    const summary = compactDraftReport(big) as CompactDraftReport;
    // A thousand and a half more SportLots sets cost the summary only their counts.
    expect(size(summary)).toBeLessThan(size(compactDraftReport(small)) + 1_000);
    expect(size(summary)).toBeLessThan(20_000);
    for (const l of summary.leftUnasked) expect(l.outsideScopeSets).toHaveLength(SUMMARY_OUTSIDE_SCOPE);
    expect(summary.summary!.omitted.outsideScopeSets).toBe(2 * (BRAND_YEAR.length + 1 - SUMMARY_OUTSIDE_SCOPE));
    // What a run needs is whole: the template (spec left out while it carries it) and every open decision.
    expect(summary.template).toEqual(big.template);
    expect(summary.spec).toBeUndefined();
    expect(summary.summary!.specInTemplate).toBe(true);
    expect(summary.openDecisions).toEqual(big.openDecisions);
    expect(summary.openCount).toBe(big.openCount);
    // Full: nothing cut, no summary.
    const full = compactDraftReport(big, "full") as typeof big;
    expect(full).toBe(big);
    expect(full.leftUnasked[0].outsideScopeSets).toHaveLength(BRAND_YEAR.length + 1);
  });

  test("a summary keeps the first few proposals of each kind, every step not done, and says what it cut", () => {
    const proposals = Array.from({ length: 30 }, (_, i) => ({ at: `p${i}`, kind: i % 2 ? ("build" as const) : ("expect" as const), detail: "" }));
    const steps = Array.from({ length: 12 }, (_, i) => ({ index: 0, kind: "x", path: "p", action: `a${i}`, status: i < 4 ? "todo" : "done" }));
    const r = {
      status: "drafted",
      proposals,
      steps,
      notes: [],
      leftUnasked: [],
      template: null,
      spec: { version: 1 },
      openDecisions: {},
    } as unknown as DraftedReport;
    const c = compactDraftReport(r) as CompactDraftReport;
    expect(c.proposals).toHaveLength(2 * SUMMARY_PROPOSALS_PER_KIND);
    expect(c.summary!.proposalCounts).toEqual({ expect: 15, build: 15 });
    expect(c.steps.map((s) => s.action)).toEqual(["a0", "a1", "a2", "a3"]);
    expect(c.summary!.stepCounts).toEqual({ todo: 4, done: 8 });
    expect(c.summary!.omitted).toMatchObject({ proposals: 30 - 2 * SUMMARY_PROPOSALS_PER_KIND, steps: 8 });
    // Nothing open: the spec is what apply takes, so it stays.
    expect(c.spec).toEqual({ version: 1 });
  });
});

describe("draftSet: review names that ride on an unanswered card conflict", () => {
  const conflicted = (bsc: string[], sl: string[], extra: Card[] = []) =>
    world({
      basePreview: {
        ...preview(extra),
        matched: [
          ...extra.map((c) => ({ card: card(c), confidence: 1 })),
          {
            card: { ...card({ num: "12", players: bsc, bsc: "b12", sl: "s12" }), playersConflict: { bsc, sportlots: sl } },
            confidence: 1,
          },
        ],
      },
    });

  test("a spelling only one side carries is never pre-filled: it is open, naming the conflict it rides on", async () => {
    const r = await drafted(conflicted(["Alex Guerrero"], ["Alexander Guerrero"]));
    const step = (r.spec as unknown as Spec).steps[0];
    // No create for either spelling: which one the review asks about is the conflict's answer.
    expect(step.base!.checklist!.review).toBe("none-expected");
    expect(r.proposals.filter((p) => p.kind === "review-create" && p.at.startsWith("steps[0].base"))).toEqual([]);
    expect(r.openDecisions.conflicts).toEqual([expect.objectContaining({ cardNumber: "12" })]);
    const open = r.openDecisions.review.players.filter((p) => p.at === "steps[0].base.checklist.review.players");
    expect(open.map((p) => p.name)).toEqual(["Alex Guerrero", "Alexander Guerrero"]);
    expect(open[0].detail).toContain(`asked only if card #12's players conflict is answered "bsc"`);
    expect(open[1].detail).toContain(`asked only if card #12's players conflict is answered "sportlots"`);
    expect(open[1].detail).toContain("no NB player has this name");
    // The fill-ins say the same, and the conflict's own fill-in sits beside them.
    const tpl = r.template as unknown as { steps: Array<{ base: { checklist: { review: { players: Array<{ name: string; decision: string }> } } } }> };
    const fills = tpl.steps[0].base.checklist.review.players;
    expect(fills.map((f) => f.name)).toEqual(["Alex Guerrero", "Alexander Guerrero"]);
    for (const f of fills) expect(f.decision).toMatch(/^<"create" \| "skip"/);
    expect(fills[1].decision).toContain('answered "sportlots"');
    expect(placeholdersIn(r.template)).toContain("steps[0].base.checklist.pairing.conflicts[0].choose");
    expect(r.confirmPhrase).toBeNull();
  });

  test("a name both sides carry, or another card carries, is asked whatever the answer: proposed as before", async () => {
    const r = await drafted(
      conflicted(["Kris Bryant", "Javier Baez"], ["Kris Bryant"], [{ num: "13", players: ["Javier Baez"], bsc: "b13", sl: "s13" }]),
    );
    const review = (r.spec as unknown as Spec).steps[0].base!.checklist!.review as { players: Array<{ name: string }> };
    expect(review.players.map((p) => p.name)).toEqual(["Javier Baez", "Kris Bryant"]);
    expect(r.openDecisions.review.players.filter((p) => p.at.startsWith("steps[0].base"))).toEqual([]);
  });

  test("conflictDependentPlayers: one side only, not settled elsewhere, folded by name", () => {
    const deps = conflictDependentPlayers([
      { cardNumber: "1", cardName: "", players: ["A. Guerrero"], playersConflict: { bsc: ["A. Guerrero", "Both"], sportlots: ["Alexander Guerrero", "both"] } },
      { cardNumber: "2", cardName: "", players: ["Elsewhere"], playersConflict: { bsc: ["Elsewhere"], sportlots: ["Other Side"] } },
      { cardNumber: "3", cardName: "", players: ["Elsewhere"] },
    ] as unknown as Parameters<typeof conflictDependentPlayers>[0]);
    expect([...deps.entries()]).toEqual([
      [expect.stringMatching(/guerrero/i), [{ cardNumber: "1", side: "bsc" }]],
      [expect.stringMatching(/alexander/i), [{ cardNumber: "1", side: "sportlots" }]],
      [expect.stringMatching(/other/i), [{ cardNumber: "2", side: "sportlots" }]],
    ]);
  });
});

describe("draftSet: a brand-year not synced yet (NEO-339 live: 2014 Topps)", () => {
  test("an empty Manufacturers column says the brand's year is not synced yet, and offers the prepare spec", async () => {
    const r = (await draftSet(world({ manufacturersSynced: false }), FAKE_TARGET, PATH, {})) as UnresolvedDraftReport;
    expect(r).toMatchObject({ status: "unresolved", kind: "manufacturer", candidates: [] });
    expect(r.message).toBe(unsyncedMessage("Baseball/2024/Topps"));
    expect(r.message).toBe("Baseball/2024/Topps has not been synced yet. Apply the prepare spec, then draft this set again.");
    expect(r.prepare?.spec).toMatchObject({ steps: [{ kind: "brand-year", syncSets: true }] });
  });

  test("a name the synced column does not hold keeps the plain message", async () => {
    const r = (await draftSet(world(), FAKE_TARGET, { ...PATH, manufacturer: "Leaf" }, {})) as UnresolvedDraftReport;
    expect(r.message).toBe('No manufacturer named "Leaf".');
    expect(r.prepare).toBeDefined();
  });

  test("Sets never synced say so", async () => {
    const r = (await draftSet(world({ setsSynced: false }), FAKE_TARGET, PATH, {})) as UnresolvedDraftReport;
    expect(r.message).toBe("Baseball/2024/Topps's Sets have not been synced yet. Apply the prepare spec, then draft this set again.");
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
  test("filedByOtherTypes: every other type's paired and own-set ids, never this type's or a leave", () => {
    const variants = [
      { type: "Insert", sync: { pairs: [{ name: "A", bsc: ["a"], sportlots: ["1"] }], pending: [{ side: "sportlots", id: "9", decision: "leave" }] } },
      { type: "Parallel", sync: { pairs: [{ name: "B", sportlots: ["2"] }], pending: [{ side: "bsc", id: "own", decision: "own-set" }, { side: "sportlots", id: "8", decision: "leave" }] } },
      { type: "Short Prints" },
    ] as unknown as Parameters<typeof filedByOtherTypes>[0];
    expect(filedByOtherTypes(variants, 0)).toEqual({ bsc: ["own"], sportlots: ["2"] });
    expect(filedByOtherTypes(variants, 1)).toEqual({ bsc: ["a"], sportlots: ["1"] });
    expect(filedByOtherTypes(variants, 2)).toEqual({ bsc: ["a", "own"], sportlots: ["1", "2"] });
  });

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

  test("mergeDraftAnswers takes a pairing.unlink answer in place of that pair's conflict fill-ins", () => {
    const spec = (pairing: Record<string, unknown>) => ({
      version: 1,
      scope: "Baseball/2014/Topps/Topps Chrome",
      steps: [
        {
          kind: "set",
          path: { sport: "Baseball", year: "2014", manufacturer: "Topps", set: "Topps Chrome" },
          variantTypes: { sync: true },
          base: {
            map: { bsc: "bsc-chrome", whenPaused: "bsc-only" },
            checklist: { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep", ...pairing }, review: "none-expected" },
          },
        },
      ],
    });
    const fill = (field: string, n: string) => ({ field, bsc: `b${n}`, sportlots: `s${n}`, choose: `<"bsc" | "sportlots"> — #${n}` });
    const template = spec({ conflicts: [fill("name", "482"), fill("players", "482"), fill("name", "9")] });
    // The operator unlinks #482 (two cards) and answers #9 with a side.
    const answers = spec({
      unlink: [{ bsc: "b482", sportlots: "s482" }],
      conflicts: [{ field: "name", bsc: "b9", sportlots: "s9", choose: "sportlots" }],
    });
    const merged = mergeDraftAnswers(template, answers);
    expect(placeholdersIn(merged)).toEqual([]);
    expect(contentDigest(parseSpec(merged))).toBe(contentDigest(parseSpec(answers)));
    // Only an unlink: no conflicts key is left behind.
    const onlyUnlink = spec({ unlink: [{ bsc: "b482", sportlots: "s482" }] });
    const merged2 = mergeDraftAnswers(spec({ conflicts: [fill("name", "482")] }), onlyUnlink);
    expect(contentDigest(parseSpec(merged2))).toBe(contentDigest(parseSpec(onlyUnlink)));
  });
});

describe("draftSet: NEO-345 the autograph format is the operator's", () => {
  /** Future Stars previews two AU cards (the token case-folded) and a plain one. */
  const auPreview = () => {
    const p = preview([
      { num: "FS-1", players: ["Shohei Ohtani"], bsc: "fs1", sl: "sfs1" },
      { num: "FS-2", players: ["Bobby Witt Jr."], bsc: "fs2", sl: "sfs2" },
      { num: "FS-3", players: ["Mike Trout"], bsc: "fs3", sl: "sfs3" },
    ]);
    Object.assign(p.matched[0].card, { attributes: ["AU"] });
    Object.assign(p.matched[1].card, { attributes: ["RC", " au "] });
    return p;
  };

  test("an AU checklist is listed with where its answer goes, never filled, and never blocks the phrase", async () => {
    const plain = await drafted(world());
    const r = await drafted(world({ insertPreview: auPreview }));
    expect(plain.autographFormats).toEqual([]);
    expect(r.autographFormats.length).toBeGreaterThan(0);
    const fs = r.autographFormats.find((q) => q.label === "Insert › Future Stars")!;
    expect(fs).toMatchObject({
      row: { type: "Insert", name: "Future Stars" },
      cards: 2,
      question: "2 autographed cards — on card or sticker?",
      answers: [
        { format: "On Card", label: "On card" },
        { format: "Sticker/Label", label: "Sticker" },
      ],
    });
    expect(fs.at).toMatch(/^steps\[0\]\.variants\[\d+\]\.rows\[\d+\]\.checklist\.autographFormat$/);
    // The draft holds no answer and no fill-in for it, and counts nothing open for it.
    expect(JSON.stringify(r.spec)).not.toContain("autographFormat");
    expect(JSON.stringify(r.template)).not.toContain("autographFormat");
    expect(r.openCount).toBe(plain.openCount);
    // Base previewed no AU card: not listed.
    expect(r.autographFormats.some((q) => q.label === "Base")).toBe(false);
  });

  test("mergeDraftAnswers takes a checklist's autographFormat from the answers (the draft never drafts one)", async () => {
    const r = await drafted(world({ insertPreview: auPreview }));
    const at = r.autographFormats[0].at;
    const committed = structuredClone(r.template ?? r.spec) as Record<string, unknown>;
    // Answer the template's fill-ins with themselves resolved, then the format.
    const answered = JSON.parse(JSON.stringify(committed).replace(/"<[^"]*>"/g, '"create"')) as Record<string, unknown>;
    const parts = at.replace(/\.autographFormat$/, "");
    const node = parts.split(/\.|\[|\]/).filter(Boolean).reduce<Record<string, unknown>>((n, k) => n[k] as Record<string, unknown>, answered);
    node.autographFormat = "On Card";
    const merged = mergeDraftAnswers(r.template ?? r.spec, answered);
    expect(JSON.stringify(merged)).toContain('"autographFormat":"On Card"');
    // Only on a checklist: the same key elsewhere in the answers is not taken.
    const stray = mergeDraftAnswers(r.template ?? r.spec, { ...answered, autographFormat: "On Card" }) as Record<string, unknown>;
    expect("autographFormat" in stray).toBe(false);
  });
});

describe("draftSet: Group Parallels never swallows an insert's own family (NEO-339, 2023 Topps Chrome Future Stars)", () => {
  // BSC lists the autographs and their parallels flat beside Future Stars.
  const family = raw({
    autoMatched: [
      ["Future Stars", "fs", "Chrome Black Future Stars", "sl-fs"],
      ["Future Stars Red", "fs-red", "Chrome Black Future Stars Red", "sl-fs-red"],
      ["Future Stars Autographs", "fsa", "Chrome Black Future Stars Autographs", "sl-fsa"],
      ["Future Stars Autographs SuperFractor", "fsa-sf", "Chrome Black Future Stars Autographs SuperFractor", "sl-fsa-sf"],
      ["Future Stars Autographs Red", "fsa-red", "Chrome Black Future Stars Autographs Red", "sl-fsa-red"],
      ["Future Stars Autographs Orange", "fsa-or", "Chrome Black Future Stars Autographs Orange", "sl-fsa-or"],
    ],
  });
  /** Future Stars cards are FS-n; the autographs are FSA-xx unless `sameNumbers`. */
  const byIds = (sameNumbers: boolean) => (a: Record<string, unknown>) => {
    const ids = ((a.cold as { insert?: { bscVariantNameIds?: string[] } }).insert?.bscVariantNameIds ?? []).join();
    const autos = ids.startsWith("fsa") && !sameNumbers;
    return preview([
      { num: autos ? "FSA-AB" : "FS-1", players: ["Shohei Ohtani"], bsc: `${ids}-1`, sl: `s-${ids}-1` },
      { num: autos ? "FSA-CD" : "FS-2", players: ["Bobby Witt Jr."], bsc: `${ids}-2`, sl: `s-${ids}-2` },
    ]);
  };
  const insertOf = (r: DraftedReport) => (r.spec as unknown as Spec).steps[0].variants!.find((v) => v.type === "Insert")!;
  const previewsOf = (client: FakeClient) =>
    client.callsTo("selectorOptions:previewCardChecklist").map((c) => (c.args.cold as { insert?: { bscVariantNameIds?: string[] } }).insert?.bscVariantNameIds?.join() ?? "base");

  test("no shared card number: Future Stars Autographs stays its own insert and parents its SuperFractor, Red and Orange", async () => {
    const client = world({ insertCandidates: family, insertPreview: byIds(false) });
    const r = await drafted(client);
    const insert = insertOf(r);
    expect(insert.group!.parents).toEqual([
      { insert: { bsc: "fs" }, parallels: [{ bsc: "fs-red" }] },
      { insert: { bsc: "fsa" }, parallels: [{ bsc: "fsa-sf" }, { bsc: "fsa-red" }, { bsc: "fsa-or" }] },
    ]);
    expect(insert.rows!.map((row) => [row.name, (row.parallels as Array<{ name: string }> | undefined)?.map((p) => p.name)])).toEqual([
      ["Future Stars", ["Future Stars Red"]],
      ["Future Stars Autographs", ["Future Stars Autographs SuperFractor", "Future Stars Autographs Red", "Future Stars Autographs Orange"]],
    ]);
    expect(r.proposals).toContainEqual({
      at: "steps[0].variants[0].group.parents",
      kind: "grouping",
      detail: "Insert › Future Stars Autographs shares no card number with Future Stars, so it stays its own insert and parents the rows that extend its name",
    });
    // Each checklist is previewed once: the evidence and the row's own checklist share the answer.
    expect(previewsOf(client).sort()).toEqual(["base", "fs", "fsa"]);
  });

  const allUnderFutureStars = [
    {
      insert: { bsc: "fs" },
      parallels: [{ bsc: "fs-red" }, { bsc: "fsa" }, { bsc: "fsa-sf" }, { bsc: "fsa-red" }, { bsc: "fsa-or" }],
    },
  ];

  test("a shared card number nests the family under Future Stars, as the prefix rule always did", async () => {
    const r = await drafted(world({ insertCandidates: family, insertPreview: byIds(true) }));
    const insert = insertOf(r);
    expect(insert.group!.parents).toEqual(allUnderFutureStars);
    expect(r.proposals.filter((p) => p.at.endsWith(".group.parents"))).toEqual([]);
  });

  test("with no previews to compare, the plain prefix rule stands: the family goes under Future Stars", async () => {
    const client = world({ insertCandidates: family });
    const r = await drafted(client, { checklists: false });
    expect(insertOf(r).group!.parents).toEqual(allUnderFutureStars);
    expect(client.callsTo("selectorOptions:previewCardChecklist")).toEqual([]);
  });
});

describe("draftSet: a SportLots set no NB set has placed is never paired by name (NEO-339: 2023 Topps Chrome took the flagship's 1988 Topps Autos Red)", () => {
  // BSC lists the autographs under this set; the matcher paired them with the
  // flagship's SportLots set 269998, which the brand's SportLots review still holds.
  const candidates = raw({
    autoMatched: [
      ["Future Stars", "fs", "2024 Topps Chrome Black Future Stars", "sl-fs"],
      ["1988 Topps Baseball Autographs Red", "1988-topps-baseball-autographs-red", "1988 Topps Autos Red", "269998"],
    ],
    sl: [["Chrome Black Something", "sl-other"]],
  });
  const review = { entries: [{ slId: "269998", label: "1988 Topps Autos Red", defaultName: "1988 Topps Autos Red" }] };
  const insertOf = (r: DraftedReport) => (r.spec as unknown as Spec).steps[0].variants!.find((v) => v.type === "Insert")!;

  test("the row is drafted from BSC alone and the SportLots set is an open decision, never a pair or a silent leave", async () => {
    const client = world({ insertCandidates: candidates, slReview: review });
    const r = await drafted(client);
    const insert = insertOf(r);
    expect(insert.sync!.pairs).toEqual([
      { name: "Future Stars", bsc: ["fs"], sportlots: ["sl-fs"] },
      { name: "1988 Topps Baseball Autographs Red", bsc: ["1988-topps-baseball-autographs-red"] },
    ]);
    expect(JSON.stringify(r.spec)).not.toContain("269998");
    expect(r.openDecisions.names).toContainEqual(
      expect.objectContaining({
        at: "steps[0].variants[0].sync.pending[1]",
        kind: "reconcile-unsorted-sportlots",
        name: "1988 Topps Autos Red",
        candidates: [expect.objectContaining({ id: "269998" })],
      }),
    );
    expect(r.confirmPhrase).toBeNull();
    // One read per draft, however many types the matcher paired in.
    expect(client.callsTo("slSetReview:getSlSetReview")).toHaveLength(1);
    const pending = (r.template as unknown as Spec).steps[0].variants![0].sync!.pending;
    expect(pending[1]).toMatchObject({ side: "sportlots", id: "269998", decision: expect.stringMatching(/^<"leave" \| "own-set">/) });
    // Asked, so neither listed as a leave nor counted as left unasked.
    expect(r.leftUnasked.find((l) => l.type === "Insert")?.outsideScopeSets ?? []).not.toContainEqual(expect.objectContaining({ id: "269998" }));
    // The checklist is previewed from BSC alone: no SportLots id reaches it.
    const autosPreview = client
      .callsTo("selectorOptions:previewCardChecklist")
      .map((c) => (c.args.cold as { insert?: Record<string, unknown> }).insert)
      .find((i) => (i?.bscVariantNameIds as string[] | undefined)?.[0] === "1988-topps-baseball-autographs-red");
    expect(autosPreview).toEqual({ bscVariantNameIds: ["1988-topps-baseball-autographs-red"] });
  });

  test("with nothing in the review the matcher's pair is drafted as before", async () => {
    const r = await drafted(world({ insertCandidates: candidates }));
    expect(insertOf(r).sync!.pairs).toContainEqual({
      name: "1988 Topps Baseball Autographs Red",
      bsc: ["1988-topps-baseball-autographs-red"],
      sportlots: ["269998"],
    });
  });
});
