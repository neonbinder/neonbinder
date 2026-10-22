/**
 * NEO-339 part B — the oneshot-smoke sequence over an in-memory MCP pair and a
 * fake service (CI runs it over stdio against the PR preview), and the
 * command's refusal of an unmeasured fixture.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { main, type CliIO } from "./cli";
import { parseTarget } from "./client/target";
import { registerTools } from "./mcp-tools";
import {
  autographReadBackProblem,
  autographsAnswered,
  reachedAutographRows,
  compareDraft,
  differingPaths,
  fixForRun,
  NOT_MEASURED,
  oneshotExpectSchema,
  runOneshotSequence,
  specAutographRows,
  specBuiltFromBase,
  type AutographRowReader,
  type OneshotExpect,
} from "./mcp-oneshot";

/** NEO-345: the read-back's NB answer for a row the run answered: formatted, every AU card marked. */
const READ_OK: AutographRowReader = async () => ({ format: "On Card", autographed: 1, unformatted: 0 });
import { specConfirmPhrase, type InspectReport, type OpenDecisions, type SetBuildService } from "./service";
import { parseSpec } from "./spec/schema";
import { APP, knownResolver, linkAt, SET_LINK, SET_LINK_ABS } from "./link-checks.fixture";

const TARGET = parseTarget("https://happy-otter-123.convex.cloud");
const PATH = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome Black" };
const SCOPE = "Baseball/2024/Topps/Topps Chrome Black";

/** The committed spec: the draft's spec, its pending set a `leave` proposal. */
const ANSWERS = {
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
          sync: { pairs: [{ name: "Future Stars", bsc: ["fs"] }], pending: [{ side: "sportlots", id: "sl-x", decision: "leave" }] },
        },
      ],
    },
  ],
};
/** The draft settles everything: no template, just the spec. */
const DRAFTED = structuredClone(ANSWERS);
const PHRASE = specConfirmPhrase(TARGET, parseSpec(ANSWERS));

function none(): OpenDecisions {
  return { names: [], baseCandidates: [], reconcile: [], review: { players: [], teams: [], leagues: [] }, slReview: [], conflicts: [], grouping: [] };
}
const ONE_OPEN: OpenDecisions = {
  ...none(),
  baseCandidates: [{ at: "steps[0].base.map.sportlots", path: SCOPE, side: "sportlots", candidates: [{ id: "a", name: "A" }, { id: "b", name: "A" }] }],
};

/** Every row of the fake build links to the same real-looking row in the fixture world. */
const LINK_ROW = linkAt(5);

const built: InspectReport = {
  target: { convexUrl: TARGET.convexUrl, host: TARGET.host },
  path: PATH,
  pathText: SCOPE,
  found: true,
  link: SET_LINK,
  base: { name: "Base", cards: 100, isBase: true, links: { buysportscards: ["b"], sportlots: ["s"] }, link: LINK_ROW },
  variantTypes: [
    {
      type: "Insert",
      link: LINK_ROW,
      rows: [
        {
          name: "Future Stars",
          cards: 10,
          isBase: false,
          links: { buysportscards: ["fs"], sportlots: [] },
          link: LINK_ROW,
          parallels: [{ name: "Future Stars Gold", cards: 10, isBase: false, links: { buysportscards: ["fsg"], sportlots: [] }, link: LINK_ROW }],
        },
      ],
    },
    { type: "Parallel", link: LINK_ROW, rows: [{ name: "Gold", cards: 100, isBase: false, links: { buysportscards: ["g"], sportlots: [] }, link: LINK_ROW }] },
  ],
};

const FIX = {
  cards: [{ cardNumber: "7", answer: { noTeam: true } }],
  names: [{ side: "sportlots", action: "decline", label: "Chrome Black" }],
};
const MEASURED = { measured: true, totals: { cards: 1, byKind: { missingTeam: 1 }, namesToCheck: 1 }, fix: FIX };

/** `attention` is required; the base expectations carry the measured block. */
const BASE_EXPECT = {
  path: PATH,
  apply: { counts: { reconciled: 2, grouped: 1, committed: 110, built: 110 } },
};
const EXPECT: OneshotExpect = oneshotExpectSchema.parse({ ...BASE_EXPECT, attention: MEASURED });

const SUMMARY = { cards: 0, byKind: {}, awaitingTeamLookup: 0, namesToCheck: 0, slSetsToSort: 0, autographRows: 0, summary: "All clear — nothing on this checklist needs attention." };

/** A built set with one missing-team card and one name to check, then (after nb_fix) neither. */
function attentionWorld(
  o: {
    awaiting?: number[];
    fixOutcome?: "applied" | "refused";
    autographRows?: number;
    ivory?: boolean;
    /** Ivory's two parallels are listed too; `reach` (default true) says the server's answer reached them. */
    ivoryParallels?: { reach?: boolean };
  } = {},
) {
  const IVORY_PARALLELS = o.ivoryParallels
    ? [
        { row: { type: "Insert", name: "Ivory Autographs", parallel: "Red Trim" }, rowId: "ivory-red", rowLabel: "Insert › Ivory Autographs › Red Trim", cards: 17 },
        { row: { type: "Insert", name: "Ivory Autographs", parallel: "Gold Trim" }, rowId: "ivory-gold", rowLabel: "Insert › Ivory Autographs › Gold Trim", cards: 17 },
      ]
    : [];
  const reach = o.ivoryParallels?.reach !== false;
  let fixed = false;
  const awaiting = [...(o.awaiting ?? [0])];
  const before = () => ({
    pathText: SCOPE,
    totals: {
      cards: 1,
      byKind: { missingTeam: 1 },
      awaitingTeamLookup: awaiting.length > 1 ? awaiting.shift()! : awaiting[0],
      namesToCheck: 1,
      slSetsToSort: 0,
      autographRows: (o.autographRows ?? 0) + (o.ivory ? 1 : 0) + IVORY_PARALLELS.length,
    },
    summary: "1 card needs you on Topps Chrome Black; 1 name to check.",
    cards: [{ row: { type: "Base" }, rowLabel: "Base", cardNumber: "7", cardName: "Card 7", cardId: "card-7", kinds: ["missingTeam"] }],
    names: [{ path: PATH, row: {}, where: SCOPE, rowId: "set-1", sides: [{ side: "sportlots", label: "Chrome Black", foldEqual: false }] }],
    autographs: [
      ...Array.from({ length: o.autographRows ?? 0 }, (_, i) => ({ row: { type: "Insert", name: `Autos ${i}` }, rowId: `autos-${i}`, rowLabel: `Insert › Autos ${i}`, cards: 3 })),
      ...(o.ivory ? [{ row: { type: "Insert", name: "Ivory Autographs" }, rowId: "ivory", rowLabel: "Insert › Ivory Autographs", cards: 17 }] : []),
      ...IVORY_PARALLELS,
    ],
    notices: [],
  });
  const after = () => ({
    ...before(),
    totals: {
      ...before().totals,
      cards: 0,
      byKind: {},
      namesToCheck: 0,
      autographRows: (o.autographRows ?? 0) + (reach ? 0 : IVORY_PARALLELS.length),
    },
    summary: SUMMARY.summary,
    cards: [],
    names: [],
    autographs: before().autographs.filter((a) => a.rowId !== "ivory" && (!reach || !a.rowId.startsWith("ivory-"))),
  });
  return {
    attention: vi.fn(async () => (fixed ? after() : before())),
    fix: vi.fn(async (_p: unknown, a: { cards?: unknown[]; names?: unknown[]; autographs?: unknown[] }) => {
      fixed = o.fixOutcome !== "refused";
      const n = (a.cards?.length ?? 0) + (a.names?.length ?? 0);
      const autographs = (a.autographs ?? []).map((_x, i) => ({
        at: `autographs[${i}]`,
        outcome: o.fixOutcome ?? "applied",
        detail: "d",
        format: "On Card",
        // The server's reach onto Ivory's parallels, as nb_fix reports it.
        ...(IVORY_PARALLELS.length > 0 && reach ? { parallels: { count: 2, rowIds: IVORY_PARALLELS.map((p) => p.rowId) } } : {}),
      }));
      return {
        results: [...Array.from({ length: n }, (_, i) => ({ at: `x[${i}]`, outcome: o.fixOutcome ?? "applied", detail: "d" })), ...autographs],
        summary: SUMMARY.summary,
      };
    }),
  };
}

function fakeService(
  o: {
    spec?: unknown;
    open?: OpenDecisions;
    counts?: Record<string, number>;
    attention?: ReturnType<typeof attentionWorld>;
    autographFormats?: Array<{ at: string; label: string }>;
    setLinks?: Array<{ path: string; link: string; attention?: typeof SUMMARY }>;
    inspect?: InspectReport;
  } = {},
) {
  const att = o.attention ?? attentionWorld();
  return {
    target: TARGET,
    read: {
      inspect: vi.fn(async () => o.inspect ?? built),
      plan: vi.fn(async () => ({ scope: SCOPE, confirmPhrase: PHRASE, steps: [{}], openDecisions: none() })),
      reviewItems: vi.fn(),
      draftSet: vi.fn(async () => ({
        status: "drafted",
        spec: o.spec ?? DRAFTED,
        template: null,
        openDecisions: o.open ?? none(),
        proposals: [],
        ...(o.autographFormats ? { autographFormats: o.autographFormats } : {}),
        marketplaceCalls: 12,
        durationMs: 3000,
      })),
      attention: att.attention,
    },
    write: {
      apply: vi.fn(async () => ({
        counts: o.counts ?? { reconciled: 2, grouped: 1, committed: 110, built: 110, skipped: 0 },
        durationMs: 9000,
        setLinks: o.setLinks ?? [{ path: SCOPE, link: SET_LINK, attention: SUMMARY }],
        attentionLine: "Built and all clear.",
      })),
      decide: vi.fn(),
      buildParallel: vi.fn(),
      slReviewApply: vi.fn(),
      fix: att.fix,
    },
  };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function connect(service: unknown) {
  const server = new McpServer({ name: "nb-setbuild", version: "0.0.0" });
  registerTools(server, service as SetBuildService, {
    secrets: [],
    cwd: "/",
    readSpecFile: async () => JSON.stringify(ANSWERS),
    resolveSpecPath: async (p) => p,
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "oneshot-test", version: "0.0.0" });
  await client.connect(c);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const run = (service: ReturnType<typeof fakeService>, expect: OneshotExpect = EXPECT, link: { appOrigin?: string } = {}, answers: unknown = ANSWERS) =>
  connect(service).then((client) =>
    runOneshotSequence(client, { answersPath: "/oneshot.spec.json", answers, expect, confirm: PHRASE, sleep: async () => {}, resolveDrill: knownResolver(), readAutographRow: READ_OK, ...link }),
  );

describe("runOneshotSequence", () => {
  test("draft → merge → plan → apply (stopAt end) → inspect, all green", async () => {
    const service = fakeService();
    const checks = await run(service);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.label)).toEqual([
      "tools/list",
      "nb_draft_set",
      "draft + answers",
      "leave lists",
      "autograph formats",
      "review answers",
      "nb_plan",
      "nb_apply",
      "nb_apply attention",
      "nb_apply links",
      "nb_inspect links",
      "insert with a built parallel",
      "Parallel rows built from Base",
      "autograph read-back (spec)",
      "nb_attention",
      "nb_fix answers",
      "nb_fix",
      "nb_attention after nb_fix",
    ]);
    expect(service.read.draftSet).toHaveBeenCalledWith(PATH, {});
    expect(service.write.apply).toHaveBeenCalledTimes(1);
    expect(service.write.apply.mock.calls[0]).toEqual([ANSWERS, PHRASE, { stopAt: "end" }]);
  });

  test("drift: a draft that no longer merges to the committed spec stops before any write, naming where", async () => {
    const drifted = structuredClone(DRAFTED);
    drifted.steps[0].variants[0].sync.pairs.push({ name: "New Insert", bsc: ["new"] });
    const service = fakeService({ spec: drifted });
    const checks = await run(service);
    const merge = checks.find((c) => c.label === "draft + answers")!;
    expect(merge.ok).toBe(false);
    expect(merge.detail).toMatch(/steps\[0\]\.variants\[0\]\.sync\.pairs\[1\]/);
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("any open decision in the draft fails, naming where, and nothing is applied", async () => {
    const service = fakeService({ open: ONE_OPEN });
    const checks = await run(service);
    const draft = checks.find((c) => c.label === "nb_draft_set")!;
    expect(draft.ok).toBe(false);
    expect(draft.detail).toContain("1 open decision(s), 0 of them card conflicts / review names / unpaired sets for the committed spec to answer; 1 the draft should have settled (Base sportlots at steps[0].base.map.sportlots)");
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("a count that differs fails the apply check", async () => {
    const checks = await run(fakeService({ counts: { reconciled: 2, grouped: 0, committed: 110, built: 110 } }));
    expect(checks.find((c) => c.label === "nb_apply")).toMatchObject({ ok: false, detail: "counts.grouped is 0, expected 1" });
  });

  test("card conflicts the committed spec answers are allowed; one it leaves unanswered fails", async () => {
    const conflicted = { ...none(), conflicts: [{ at: "steps[0].base.checklist.pairing.conflicts", row: null, cardNumber: "21", detail: "name" }] };
    const template = structuredClone(DRAFTED) as typeof DRAFTED & { steps: Array<Record<string, unknown>> };
    (template.steps[0] as Record<string, unknown>).base = {
      map: { bsc: "b", whenPaused: "bsc-only" },
      checklist: { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep", conflicts: [{ field: "name", bsc: "r21", choose: '<"bsc" | "sportlots"> — #21' }] }, review: "none-expected" },
    };
    const answered = structuredClone(template) as typeof template;
    ((answered.steps[0] as unknown as { base: { checklist: { pairing: { conflicts: Array<{ choose: string }> } } } }).base.checklist.pairing.conflicts[0].choose = "bsc");
    const service = fakeService({ open: conflicted, spec: answered });
    (service.read.draftSet as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "drafted", spec: answered, template, openDecisions: conflicted, proposals: [], marketplaceCalls: 1, durationMs: 1 });
    const client = await connect(service);
    const ok = await runOneshotSequence(client, { answersPath: "/oneshot.spec.json", answers: answered, expect: EXPECT, confirm: PHRASE, resolveDrill: knownResolver(), readAutographRow: READ_OK });
    expect(ok.find((c) => c.label === "nb_draft_set")).toMatchObject({ ok: true });
    expect(ok.find((c) => c.label === "draft + answers")).toMatchObject({ ok: true });
    // The committed spec without the answer leaves a fill-in: fail.
    const bad = await runOneshotSequence(await connect(service), { answersPath: "/oneshot.spec.json", answers: DRAFTED, expect: EXPECT, confirm: PHRASE, resolveDrill: knownResolver(), readAutographRow: READ_OK });
    expect(bad.find((c) => c.label === "draft + answers")).toMatchObject({ ok: false, detail: expect.stringContaining("leaves 1 fill-in") });
  });

  test("an unpaired set the draft asks about is the operator's: answered by the committed spec's leave, it passes; unanswered, it fails", async () => {
    const asked = { ...none(), names: [{ at: "steps[0].variants[0].sync.pending[0]", kind: "reconcile-unpaired", name: "X", candidates: [] }] };
    const template = structuredClone(DRAFTED);
    (template.steps[0].variants[0].sync.pending as Array<Record<string, unknown>>) = [
      { side: "sportlots", id: "sl-x", name: "X", decision: '<"leave" | "own-set"> — X' },
    ];
    const spec = structuredClone(DRAFTED);
    spec.steps[0].variants[0].sync.pending = [];
    const service = fakeService({ open: asked, spec });
    (service.read.draftSet as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "drafted", spec, template, openDecisions: asked, proposals: [], marketplaceCalls: 1, durationMs: 1 });
    const ok = await runOneshotSequence(await connect(service), { answersPath: "/oneshot.spec.json", answers: ANSWERS, expect: EXPECT, confirm: PHRASE, resolveDrill: knownResolver(), readAutographRow: READ_OK });
    expect(ok.find((c) => c.label === "nb_draft_set")).toMatchObject({ ok: true, detail: expect.stringContaining("1 open decision(s), 1 of them") });
    expect(ok.find((c) => c.label === "draft + answers")).toMatchObject({ ok: true });
    const noAnswer = structuredClone(ANSWERS);
    noAnswer.steps[0].variants[0].sync.pending = [];
    const bad = await runOneshotSequence(await connect(service), { answersPath: "/oneshot.spec.json", answers: noAnswer, expect: EXPECT, confirm: PHRASE, resolveDrill: knownResolver(), readAutographRow: READ_OK });
    expect(bad.find((c) => c.label === "draft + answers")).toMatchObject({ ok: false, detail: expect.stringContaining("leaves 1 fill-in") });
  });

  test("leaves: a draft that shows FEWER pending sets than the committed spec passes (another writer took some; moot at apply)", async () => {
    const drafted = structuredClone(DRAFTED);
    drafted.steps[0].variants[0].sync.pending = [];
    const service = fakeService({ spec: drafted });
    const checks = await run(service);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.label === "leave lists")!.detail).toBe("Insert drafted 0 / committed 1, 1 moot");
    expect(service.write.apply).toHaveBeenCalledTimes(1);
  });

  test("leaves: a drafted leave the committed spec lacks is a NEW pending set: fails naming the type and id, applies nothing", async () => {
    const drafted = structuredClone(DRAFTED);
    drafted.steps[0].variants[0].sync.pending.push({ side: "sportlots", id: "sl-new", decision: "leave" });
    const service = fakeService({ spec: drafted });
    const checks = await run(service);
    expect(checks.find((c) => c.label === "draft + answers")!.ok).toBe(true);
    const leaves = checks.find((c) => c.label === "leave lists")!;
    expect(leaves.ok).toBe(false);
    expect(leaves.detail).toContain("Insert (steps[0].variants[0]) sportlots:sl-new");
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("leaves aside, any other difference still fails: an own-set where the committed spec leaves", async () => {
    const drafted = structuredClone(DRAFTED);
    (drafted.steps[0].variants[0].sync.pending[0] as { decision: string }).decision = "own-set";
    const service = fakeService({ spec: drafted });
    const checks = await run(service);
    const rest = checks.find((c) => c.label === "draft + answers")!;
    expect(rest.ok).toBe(false);
    expect(rest.detail).toMatch(/steps\[0\]\.variants\[0\]\.sync\.pending\[0\]/);
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("compareDraft counts leaves per type and keys them by side and id", () => {
    const committed = structuredClone(ANSWERS);
    committed.steps[0].variants[0].sync.pending.push({ side: "bsc", id: "sl-x", decision: "leave" });
    const r = compareDraft(ANSWERS, committed);
    expect(r.restSame).toBe(true);
    expect(r.types).toEqual([{ at: "steps[0].variants[0]", type: "Insert", drafted: 1, committed: 2, moot: 1, added: [] }]);
  });

  test("differingPaths names leaf paths", () => {
    expect(differingPaths({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }], c: 1 })).toEqual(["a[1].b", "c"]);
  });
});

describe("setbuild oneshot-smoke (command)", () => {
  function io(): CliIO & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  }

  test("an unmeasured fixture fails loudly, before anything connects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setbuild-oneshot-"));
    const spec = join(dir, "oneshot.spec.json");
    const exp = join(dir, "oneshot.expect.json");
    await writeFile(spec, JSON.stringify({ measured: false, note: "placeholder" }));
    await writeFile(exp, JSON.stringify({ measured: false, note: "placeholder" }));
    const a = io();
    expect(await main(["oneshot-smoke", "--answers", spec, "--expect", exp, "--confirm", PHRASE], a)).toBe(1);
    expect(a.err.join("\n")).toContain(NOT_MEASURED);

    // A real answers file with a placeholder expectations file fails the same way.
    await writeFile(spec, JSON.stringify(ANSWERS));
    const b = io();
    expect(await main(["oneshot-smoke", "--answers", spec, "--expect", exp, "--confirm", PHRASE], b)).toBe(1);
    expect(b.err.join("\n")).toContain(NOT_MEASURED);
  });
});

/** NEO-339 live: review answers drift the same way leaves do (names become known; lookups stage rows). */
describe("compareDraft: review answers", () => {
  const withReview = (players: Array<Record<string, unknown>>, teams: Array<Record<string, unknown>> = []) => {
    const spec = structuredClone(ANSWERS) as typeof ANSWERS & { steps: Array<Record<string, unknown>> };
    (spec.steps[0] as { variants: Array<Record<string, unknown>> }).variants[0].rows = [
      {
        name: "Future Stars",
        checklist: {
          pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" },
          review: players.length + teams.length ? { players, teams, leagues: [] } : "none-expected",
          expectCards: 20,
        },
      },
    ];
    return spec;
  };
  const AT = "steps[0].variants[0].rows[0].checklist";

  test("fewer drafted answers than committed pass: moot names and lookup-staged rows are committed-only", () => {
    const drafted = withReview([{ name: "George Brett", decision: "create" }]);
    const committed = withReview(
      [{ name: "George Brett", decision: "create" }, { name: "Mark McGwire", decision: "create" }],
      [{ name: "Tampa Tarpons", decision: "create", league: "Florida State League" }],
    );
    const r = compareDraft(drafted, committed);
    expect(r.restSame).toBe(true);
    expect(r.answers).toEqual({ drafted: 1, committed: 3, committedOnly: 2, problems: [] });
    // Even a draft whose review opened nothing ("none-expected") against a committed answer list.
    expect(compareDraft(withReview([]), committed).answers.problems).toEqual([]);
  });

  test("a drafted answer the committed spec lacks fails, naming the path", () => {
    const r = compareDraft(withReview([{ name: "Rookie New", decision: "create" }]), withReview([{ name: "George Brett", decision: "create" }]));
    expect(r.answers.problems).toEqual([`${AT}.review.players "Rookie New": drafted, not in the committed spec`]);
  });

  test("a drafted answer the committed spec answers differently fails", () => {
    const r = compareDraft(withReview([{ name: "George Brett", decision: "create" }]), withReview([{ name: "George Brett", decision: "skip" }]));
    expect(r.answers.problems).toEqual([`${AT}.review.players "George Brett": drafted {"decision":"create","name":"George Brett"}, committed {"decision":"skip","name":"George Brett"}`]);
  });

  test("answers aside, the rest is exact: an expectCards difference still fails the digest", () => {
    const committed = withReview([{ name: "George Brett", decision: "create" }]);
    ((committed.steps[0] as unknown as { variants: Array<{ rows: Array<{ checklist: { expectCards: number } }> }> }).variants[0].rows[0].checklist.expectCards = 21);
    const r = compareDraft(withReview([{ name: "George Brett", decision: "create" }]), committed);
    expect(r.restSame).toBe(false);
    expect(r.restDiffers).toEqual([`${AT}.expectCards`]);
  });

  test("through the smoke: a moot-only difference passes, a new answer fails before any write", async () => {
    const committed = withReview([{ name: "George Brett", decision: "create" }, { name: "Mark McGwire", decision: "create" }]);
    const pass = fakeService({ spec: withReview([{ name: "George Brett", decision: "create" }]) });
    const client = await connect(pass);
    const ok = await runOneshotSequence(client, { answersPath: "/oneshot.spec.json", answers: committed, expect: EXPECT, confirm: PHRASE, resolveDrill: knownResolver(), readAutographRow: READ_OK });
    expect(ok.find((c) => c.label === "review answers")).toMatchObject({ ok: true, detail: "drafted 1 / committed 2, 1 committed-only (moot or lookup-staged)" });

    const fail = fakeService({ spec: withReview([{ name: "Rookie New", decision: "create" }]) });
    const bad = await runOneshotSequence(await connect(fail), { answersPath: "/oneshot.spec.json", answers: committed, expect: EXPECT, confirm: PHRASE, resolveDrill: knownResolver(), readAutographRow: READ_OK });
    expect(bad.find((c) => c.label === "review answers")!.ok).toBe(false);
    expect(fail.write.apply).not.toHaveBeenCalled();
  });
});

describe("oneshotExpectSchema — the attention block is required", () => {
  test("an expect file without an attention block is rejected, naming it", () => {
    const parsed = oneshotExpectSchema.safeParse(BASE_EXPECT);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.map((i) => i.path.join("."))).toContain("attention");
  });

  test("the placeholder and the measured block both parse", () => {
    expect(oneshotExpectSchema.safeParse({ ...BASE_EXPECT, attention: { measured: false } }).success).toBe(true);
    expect(oneshotExpectSchema.safeParse({ ...BASE_EXPECT, attention: MEASURED }).success).toBe(true);
  });

  test("the command refuses such a file (exit 2) before it connects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setbuild-oneshot-"));
    const spec = join(dir, "oneshot.spec.json");
    const exp = join(dir, "oneshot.expect.json");
    await writeFile(spec, JSON.stringify(ANSWERS));
    await writeFile(exp, JSON.stringify({ measured: true, ...BASE_EXPECT }));
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["oneshot-smoke", "--answers", spec, "--expect", exp, "--confirm", PHRASE], {
      env: {},
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/not a valid expectations file: attention/);
  });
});

/** Every `/admin/set-builder?` in a report, made absolute on the app origin. */
const absolute = <T,>(report: T): T => JSON.parse(JSON.stringify(report).replaceAll("/admin/set-builder?", `${APP}/admin/set-builder?`)) as T;

describe("runOneshotSequence — live link assertions", () => {
  const verdict = (checks: Awaited<ReturnType<typeof run>>, label: string) => checks.find((c) => c.label === label)!;

  test("an apply report with no setLinks fails nb_apply links", async () => {
    const checks = await run(fakeService({ setLinks: [] }));
    expect(verdict(checks, "nb_apply links")).toMatchObject({ ok: false, detail: expect.stringContaining("no setLinks") });
  });

  test("a set link that is the bare Set Builder root fails: it does not open the set", async () => {
    const checks = await run(fakeService({ setLinks: [{ path: SCOPE, link: "/admin/set-builder", attention: SUMMARY }] }));
    expect(verdict(checks, "nb_apply links")).toMatchObject({ ok: false, detail: expect.stringContaining("at its root") });
  });

  test("a set link that is not four ids deep fails", async () => {
    const checks = await run(fakeService({ setLinks: [{ path: SCOPE, link: linkAt(3), attention: SUMMARY }] }));
    expect(verdict(checks, "nb_apply links").detail).toMatch(/3 ids deep, expected 4/);
  });

  test("a link built from ids the resolver does not know fails with how far it got", async () => {
    const stale = linkAt(4, undefined, ["sp1", "yr1", "br1", "gone"]);
    const checks = await run(fakeService({ setLinks: [{ path: SCOPE, link: stale, attention: SUMMARY }] }));
    expect(verdict(checks, "nb_apply links").detail).toMatch(/answered 3 of 4 levels, so the link does not open the row/);
  });

  test("an inspect link that is not a Set Builder link fails nb_inspect links", async () => {
    const wrong = structuredClone(built);
    wrong.variantTypes![1].rows[0].link = "https://elsewhere.example/set?x=1";
    const checks = await run(fakeService({ inspect: wrong }));
    expect(verdict(checks, "nb_inspect links")).toMatchObject({ ok: false });
    expect(verdict(checks, "nb_inspect links").detail).toContain("Parallel › Gold link");
  });

  test("with an app origin every link must be absolute on it; relative ones fail", async () => {
    const rel = await run(fakeService(), EXPECT, { appOrigin: APP });
    expect(verdict(rel, "nb_apply links").ok).toBe(false);
    expect(verdict(rel, "nb_apply links").detail).toMatch(/is not absolute/);
    expect(verdict(rel, "nb_inspect links").ok).toBe(false);

    const abs = await run(
      fakeService({ setLinks: [{ path: SCOPE, link: SET_LINK_ABS, attention: SUMMARY }], inspect: absolute(built) }),
      EXPECT,
      { appOrigin: APP },
    );
    expect(abs.filter((c) => !c.ok)).toEqual([]);
  });

  test("an absolute link on another origin fails", async () => {
    const checks = await run(
      fakeService({ setLinks: [{ path: SCOPE, link: SET_LINK_ABS.replace(APP, "https://other.example.test"), attention: SUMMARY }] }),
      EXPECT,
      { appOrigin: APP },
    );
    expect(verdict(checks, "nb_apply links").detail).toMatch(/not on the app origin/);
  });
});

describe("runOneshotSequence — attention (step 7)", () => {
  test("an unmeasured block lists, FAILS, and prints what it measured; nothing is answered", async () => {
    const service = fakeService();
    const checks = await run(service, oneshotExpectSchema.parse({ ...EXPECT, attention: { measured: false } }));
    const att = checks.find((c) => c.label === "nb_attention")!;
    expect(att.ok).toBe(false);
    expect(att.detail).toContain(NOT_MEASURED);
    expect(att.detail).toContain('cards 1, byKind {"missingTeam":1}, namesToCheck 1');
    expect(att.detail).toContain("Base #7 (missingTeam)");
    expect(att.detail).toContain("sportlots “Chrome Black”");
    expect(service.write.fix).not.toHaveBeenCalled();
  });

  test("measured: waits out the team lookup, matches the totals, fixes, and sees exactly those gone", async () => {
    const att = attentionWorld({ awaiting: [3, 1, 0] });
    const service = fakeService({ attention: att });
    const checks = await run(service, oneshotExpectSchema.parse({ ...EXPECT, attention: MEASURED }));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.slice(-4).map((c) => c.label)).toEqual(["nb_attention", "nb_fix answers", "nb_fix", "nb_attention after nb_fix"]);
    expect(att.attention.mock.calls.length).toBeGreaterThanOrEqual(4);
    // One refused call (no phrase), then one with the tool's own phrase.
    expect(att.fix).toHaveBeenCalledTimes(1);
  });

  test("totals that drift from the measured block fail before any answer", async () => {
    const service = fakeService();
    const checks = await run(service, oneshotExpectSchema.parse({ ...EXPECT, attention: { ...MEASURED, totals: { ...MEASURED.totals, cards: 2 } } }));
    expect(checks.at(-1)).toMatchObject({ ok: false, label: "nb_attention" });
    expect(service.write.fix).not.toHaveBeenCalled();
  });

  test("an answer that is refused fails nb_fix and stops there", async () => {
    const service = fakeService({ attention: attentionWorld({ fixOutcome: "refused" }) });
    const checks = await run(service, oneshotExpectSchema.parse({ ...EXPECT, attention: MEASURED }));
    expect(checks.at(-1)).toMatchObject({ ok: false, label: "nb_fix" });
  });

  test("NEO-345: autographRows, when the file gives it, must match; rows still asking fail, naming them", async () => {
    const want = oneshotExpectSchema.parse({ ...EXPECT, attention: { ...MEASURED, totals: { ...MEASURED.totals, autographRows: 0 } } });
    const green = await run(fakeService(), want);
    expect(green.filter((c) => !c.ok)).toEqual([]);

    const service = fakeService({ attention: attentionWorld({ autographRows: 2 }) });
    const checks = await run(service, want);
    const att = checks.find((c) => c.label === "nb_attention")!;
    expect(att.ok).toBe(false);
    expect(att.detail).toContain("autographRows 2");
    expect(att.detail).toContain("expected cards 1, byKind {\"missingTeam\":1}, namesToCheck 1, autographRows 0");
    expect(att.detail).toContain("autograph rows: Insert › Autos 0 (3); Insert › Autos 1 (3)");
    expect(service.write.fix).not.toHaveBeenCalled();
  });

  test("a file without autographRows does not compare them (an older measurement still holds)", async () => {
    const checks = await run(fakeService({ attention: attentionWorld({ autographRows: 1 }) }), oneshotExpectSchema.parse({ ...EXPECT, attention: MEASURED }));
    expect(checks.find((c) => c.label === "nb_attention")?.ok).toBe(true);
  });
});

describe("runOneshotSequence — NEO-345 autograph formats", () => {
  const checklist = { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, review: "none-expected", expectCards: 10 };
  /** The draft never fills the format; the committed spec carries the operator's answer. */
  const map = { bsc: "base-bsc", whenPaused: "bsc-only" };
  const drafted = { ...structuredClone(ANSWERS), steps: [{ ...structuredClone(ANSWERS.steps[0]), base: { map, checklist } }] };
  const answered = { ...structuredClone(drafted), steps: [{ ...structuredClone(drafted.steps[0]), base: { map, checklist: { ...checklist, autographFormat: "On Card" } } }] };
  const asked = [{ at: "steps[0].base.checklist.autographFormat", label: "Base" }];

  test("every AU checklist the draft lists is answered in the committed spec: the merge keeps the answer and the digest holds", async () => {
    const checks = await run(fakeService({ spec: drafted, autographFormats: asked }), EXPECT, {}, answered);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.label === "autograph formats")?.detail).toBe("1 AU checklist(s): 1 answered in the spec, 0 by the fix answers");
    expect(checks.find((c) => c.label === "autograph read-back (spec)")?.detail).toBe("1 row(s) hold their format, every AU card marked");
  });

  test("an AU checklist the committed spec leaves unanswered fails, naming it, and nothing is applied", async () => {
    const service = fakeService({ spec: drafted, autographFormats: asked });
    const checks = await run(service, EXPECT, {}, drafted);
    expect(checks.find((c) => c.label === "autograph formats")).toMatchObject({
      ok: false,
      detail: "neither the committed spec nor the fix answers say how these are signed: Base (steps[0].base.checklist.autographFormat)",
    });
    expect(service.write.apply).not.toHaveBeenCalled();
  });
});

describe("runOneshotSequence — NEO-345 the autograph path, proven live", () => {
  const checklist = { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, review: "none-expected", expectCards: 10 };
  const map = { bsc: "base-bsc", whenPaused: "bsc-only" };
  const drafted = { ...structuredClone(ANSWERS), steps: [{ ...structuredClone(ANSWERS.steps[0]), base: { map, checklist } }] };
  const answered = { ...structuredClone(drafted), steps: [{ ...structuredClone(drafted.steps[0]), base: { map, checklist: { ...checklist, autographFormat: "On Card" } } }] };
  const BASE_AT = "steps[0].base.checklist.autographFormat";
  const IVORY_AT = "steps[0].variants[0].rows[0].checklist.autographFormat";
  const IVORY = { type: "Insert", name: "Ivory Autographs" };
  const asked = [
    { at: BASE_AT, label: "Base", row: null },
    { at: IVORY_AT, label: "Insert › Ivory Autographs", row: IVORY },
  ];
  const IVORY_FIX = { ...FIX, autographs: [{ row: IVORY, format: "On Card" }] };
  const expectWith = (o: { pinned?: string[]; fix?: unknown; autographRows?: number } = {}) =>
    oneshotExpectSchema.parse({
      ...BASE_EXPECT,
      ...(o.pinned ? { draft: { autographFormats: o.pinned } } : {}),
      attention: { ...MEASURED, totals: { ...MEASURED.totals, autographRows: o.autographRows ?? 1 }, fix: o.fix ?? IVORY_FIX },
    });
  const reads: Array<unknown> = [];
  const reader: AutographRowReader = async (row) => {
    reads.push(row ?? null);
    return { format: "On Card", autographed: 2, unformatted: 0 };
  };
  const go = (service: ReturnType<typeof fakeService>, expect: OneshotExpect, readAutographRow: AutographRowReader = reader) =>
    connect(service).then((client) =>
      runOneshotSequence(client, { answersPath: "/oneshot.spec.json", answers: answered, expect, confirm: PHRASE, sleep: async () => {}, resolveDrill: knownResolver(), readAutographRow }),
    );

  test("one checklist answered by the spec, one by nb_fix: listed once before, gone after, both read back formatted", async () => {
    reads.length = 0;
    const att = attentionWorld({ ivory: true });
    const service = fakeService({ spec: drafted, autographFormats: asked, attention: att });
    const checks = await go(service, expectWith({ pinned: [IVORY_AT, BASE_AT] }));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.label === "autograph formats")?.detail).toBe("2 AU checklist(s): 1 answered in the spec, 1 by the fix answers");
    expect(checks.find((c) => c.label === "nb_fix answers")?.detail).toBe("1 cards, 1 names, 1 autograph rows, each listed once");
    expect(checks.at(-1)).toMatchObject({ ok: true, label: "autograph read-back (nb_fix)", detail: "1 row(s) hold their format, every AU card marked" });
    // The fix carried the autograph answer to the service, beside the others.
    expect(att.fix.mock.calls[0][1]).toMatchObject({ autographs: [{ row: IVORY, format: "On Card" }] });
    // The spec's row (Base) after apply, the fix's row after nb_fix.
    expect(reads).toEqual([null, IVORY]);
  });

  test("the pinned list must match exactly: a draft that lists none (or other rows) fails before any write", async () => {
    const service = fakeService({ spec: drafted, autographFormats: [], attention: attentionWorld({ ivory: true }) });
    const checks = await go(service, expectWith({ pinned: [IVORY_AT, BASE_AT] }));
    expect(checks.find((c) => c.label === "autograph formats")).toMatchObject({
      ok: false,
      detail: `the draft lists 0 AU checklist(s) (none), expected 2 (${[IVORY_AT, BASE_AT].sort().join(", ")})`,
    });
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("a row whose read-back shows no format, or AU cards still None, fails naming it", async () => {
    const service = fakeService({ spec: drafted, autographFormats: asked, attention: attentionWorld({ ivory: true }) });
    const checks = await go(service, expectWith(), async () => ({ autographed: 2, unformatted: 2 }));
    expect(checks.find((c) => c.label === "autograph read-back (spec)")).toMatchObject({ ok: false, detail: 'Base holds autographFormat none, expected "On Card"' });
    expect(autographReadBackProblem("Insert › Ivory Autographs", "On Card", { format: "On Card", autographed: 17, unformatted: 3 })).toBe(
      "Insert › Ivory Autographs: 3 of 17 AU cards still marked None",
    );
    expect(autographReadBackProblem("Base", "On Card", { format: "On Card", autographed: 0, unformatted: 0 })).toBe("Base holds no AU card");
    expect(autographReadBackProblem("Base", "On Card", { format: "On Card", autographed: 4, unformatted: 0 })).toBeUndefined();
  });

  test("an autograph answer that addresses no listed row fails before the fix; one still listed after it fails", async () => {
    const missing = await go(fakeService({ spec: drafted, autographFormats: asked, attention: attentionWorld() }), expectWith({ autographRows: 0 }));
    expect(missing.find((c) => c.label === "nb_fix answers")).toMatchObject({ ok: false, detail: "autographs[0] addresses 0 listed autograph rows" });

    // The server never took the answer: the second listing still shows everything.
    const att = attentionWorld({ ivory: true });
    const first = await att.attention();
    const stuck = { ...att, attention: vi.fn(async () => structuredClone(first)) };
    const checks = await go(fakeService({ spec: drafted, autographFormats: asked, attention: stuck as never }), expectWith());
    const after = checks.find((c) => c.label === "nb_attention after nb_fix")!;
    expect(after.ok).toBe(false);
    expect(after.detail).toContain("autograph rows 1 → 1");
    expect(after.detail).toMatch(/^3 answered item\(s\) still listed, 0 new/);
  });

  // Jason, 2026-10-18 — answering Ivory alone reaches its two listed parallels.
  const expectReach = (afterAutographRows?: number) =>
    oneshotExpectSchema.parse({
      ...BASE_EXPECT,
      attention: {
        ...MEASURED,
        totals: { ...MEASURED.totals, autographRows: 3 },
        fix: IVORY_FIX,
        ...(afterAutographRows !== undefined ? { afterAutographRows } : {}),
      },
    });

  test("an insert answered alone reaches its listed parallels: 3 rows before, 0 after, and all three read back formatted", async () => {
    reads.length = 0;
    const service = fakeService({ spec: drafted, autographFormats: asked, attention: attentionWorld({ ivory: true, ivoryParallels: {} }) });
    const checks = await go(service, expectReach(0));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.label === "nb_fix")?.detail).toMatch(/answers applied \(2 listed parallel row\(s\) reached\)/);
    expect(checks.at(-1)).toMatchObject({ ok: true, label: "autograph read-back (nb_fix)", detail: "3 row(s) hold their format, every AU card marked" });
    expect(reads.slice(-3)).toEqual([
      IVORY,
      { ...IVORY, parallel: "Red Trim" },
      { ...IVORY, parallel: "Gold Trim" },
    ]);
  });

  test("a server that did not reach the parallels fails the pinned after-count, naming it", async () => {
    const service = fakeService({ spec: drafted, autographFormats: asked, attention: attentionWorld({ ivory: true, ivoryParallels: { reach: false } }) });
    const checks = await go(service, expectReach(0));
    const after = checks.find((c) => c.label === "nb_attention after nb_fix")!;
    expect(after.ok).toBe(false);
    expect(after.detail).toContain("autograph rows 3 → 2 (expected 0 after)");
    // Without the pin the accounting alone holds: the one answered row is gone.
    const unpinned = await go(
      fakeService({ spec: drafted, autographFormats: asked, attention: attentionWorld({ ivory: true, ivoryParallels: { reach: false } }) }),
      expectReach(),
    );
    expect(unpinned.find((c) => c.label === "nb_attention after nb_fix")?.ok).toBe(true);
  });

  test("reachedAutographRows: only applied answers, only rows the listing showed, each with its answer's format", () => {
    const listing = [
      { row: { ...IVORY, parallel: "Red Trim" }, rowId: "r", rowLabel: "Insert › Ivory Autographs › Red Trim" },
    ] as never[];
    const report = {
      results: [
        { at: "autographs[0]", outcome: "applied", format: "Sticker/Label", parallels: { count: 2, rowIds: ["r", "unlisted"] } },
        { at: "autographs[1]", outcome: "moot", format: "On Card", parallels: { count: 1, rowIds: ["r"] } },
      ],
    } as never;
    expect([...reachedAutographRows(report, listing)]).toEqual([
      ["r", { row: { ...IVORY, parallel: "Red Trim" }, label: "Insert › Ivory Autographs › Red Trim", format: "Sticker/Label" }],
    ]);
  });

  test("autographsAnswered: Base by an omitted row, a row by type, name and parallel", () => {
    const items = [
      { row: { type: "Base" }, rowId: "b" },
      { row: IVORY, rowId: "i" },
      { row: { ...IVORY, parallel: "Gold" }, rowId: "g" },
    ] as never[];
    expect(autographsAnswered(items, { format: "On Card" }).map((x: { rowId: string }) => x.rowId)).toEqual(["b"]);
    expect(autographsAnswered(items, { row: IVORY, format: "On Card" }).map((x: { rowId: string }) => x.rowId)).toEqual(["i"]);
    expect(autographsAnswered(items, { row: { ...IVORY, parallel: "Gold" }, format: "On Card" }).map((x: { rowId: string }) => x.rowId)).toEqual(["g"]);
  });
});

describe("runOneshotSequence — SportLots paused (NEO-339)", () => {
  /** The committed spec as measured live: an insert answered "On Card", one Parallel row built from Base. */
  const PAUSED_ANSWERS = {
    ...ANSWERS,
    steps: [
      {
        ...ANSWERS.steps[0],
        variants: [
          {
            ...ANSWERS.steps[0].variants[0],
            rows: [{ name: "Future Stars", checklist: { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, review: "none-expected", autographFormat: "On Card" } }],
          },
          { type: "Parallel", rows: [{ name: "Gold", buildFromBase: {} }] },
        ],
      },
    ],
  };
  /** A one-sided build: the sync also stored a BSC set the committed spec leaves (no cards), and the Base is BSC-only. */
  const pausedBuild: InspectReport = {
    ...built,
    base: { ...built.base!, cards: 90, links: { buysportscards: ["b"], sportlots: [] } },
    variantTypes: [
      built.variantTypes![0],
      {
        type: "Parallel",
        link: LINK_ROW,
        rows: [
          built.variantTypes![1].rows[0],
          { name: "Left Alone", cards: 0, isBase: false, links: { buysportscards: ["la"], sportlots: [] }, link: LINK_ROW },
        ],
      },
    ],
  };
  /** Paused: no SportLots name to check is listed; one more card than measured live. */
  function pausedAttention(): ReturnType<typeof attentionWorld> {
    let fixed = false;
    const card = (n: string, kind: string) => ({ row: { type: "Base" }, rowLabel: "Base", cardNumber: n, cardName: `Card ${n}`, cardId: `card-${n}`, kinds: [kind] });
    const before = () => ({
      pathText: SCOPE,
      totals: { cards: 2, byKind: { missingTeam: 1, titleTruncated: 1 }, awaitingTeamLookup: 0, namesToCheck: 0, slSetsToSort: 0, autographRows: 0 },
      summary: "2 cards need you on Topps Chrome Black.",
      cards: [card("7", "missingTeam"), card("8", "titleTruncated")],
      names: [],
      autographs: [],
      notices: [],
    });
    const after = () => ({
      ...before(),
      totals: { ...before().totals, cards: 1, byKind: { titleTruncated: 1 } },
      summary: "1 card needs you on Topps Chrome Black.",
      cards: [card("8", "titleTruncated")],
    });
    // The listing's shape is the fake world's own; only its values differ.
    return {
      attention: vi.fn(async () => (fixed ? after() : before())),
      fix: vi.fn(async (_p: unknown, a: { cards?: unknown[]; names?: unknown[] }) => {
        fixed = true;
        const n = (a.cards?.length ?? 0) + (a.names?.length ?? 0);
        return { results: Array.from({ length: n }, (_, i) => ({ at: `x[${i}]`, outcome: "applied", detail: "d" })), summary: "1 card needs you." };
      }),
    } as unknown as ReturnType<typeof attentionWorld>;
  }
  const go = (service: ReturnType<typeof fakeService>, expect: OneshotExpect, paused: string[]) =>
    connect(service).then((client) =>
      runOneshotSequence(client, {
        answersPath: "/oneshot.spec.json",
        answers: PAUSED_ANSWERS,
        expect,
        confirm: PHRASE,
        sleep: async () => {},
        resolveDrill: knownResolver(),
        readAutographRow: READ_OK,
        paused,
      }),
    );
  const by = (checks: Awaited<ReturnType<typeof go>>, label: string) => checks.find((c) => c.label === label)!;
  const LIVE = oneshotExpectSchema.parse({
    ...BASE_EXPECT,
    after: [{ path: PATH, base: { cards: 100, linked: { buysportscards: true, sportlots: true } } }],
    attention: { ...MEASURED, afterAutographRows: 0 },
  });
  /** A one-sided draft: not the committed spec, and its own counts. */
  const drifted = () => {
    const d = structuredClone(DRAFTED) as typeof DRAFTED;
    d.steps[0].variants[0].sync.pairs.push({ name: "BSC Only Insert", bsc: ["bsc-only"] });
    return d;
  };

  test("paused: the draft comparison, live counts, live totals and SportLots answers are not checked; the rest runs green", async () => {
    const att = pausedAttention();
    const service = fakeService({ spec: drifted(), counts: { reconciled: 1, grouped: 0, committed: 90, built: 90 }, inspect: pausedBuild, attention: att });
    const checks = await go(service, LIVE, ["sportlots"]);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    const why = "not checked: sportlots paused (the committed spec was drafted with every marketplace live)";
    for (const label of ["draft + answers", "leave lists", "autograph formats", "review answers"]) expect(by(checks, label)).toMatchObject({ ok: true, detail: why });
    expect(by(checks, "nb_apply").detail).toMatch(/^no count asserted in 9s; not checked \(sportlots paused\): counts\.reconciled, counts\.grouped, counts\.committed, counts\.built$/);
    expect(by(checks, "Parallel rows built from Base").detail).toBe("1 rows, all with cards; not checked (sportlots paused): 1 row(s) the spec does not build from Base");
    expect(by(checks, "after").detail).toBe("as expected; not checked (sportlots paused): Base cards, Base buysportscards link, Base sportlots link");
    expect(by(checks, "autograph read-back (spec)").detail).toBe("1 row(s) hold their format, every AU card marked");
    expect(by(checks, "nb_attention").detail).toMatch(/; not checked \(sportlots paused\): totals$/);
    expect(by(checks, "nb_fix answers").detail).toBe("1 cards, 0 names, 0 autograph rows, each listed once; not checked (sportlots paused): names[0] (sportlots)");
    expect(by(checks, "nb_attention after nb_fix").detail).toBe("1 card needs you on Topps Chrome Black.; not checked (sportlots paused): afterAutographRows");
    // The SportLots name answer is never sent.
    expect(att.fix.mock.calls.at(-1)![1]).toMatchObject({ cards: FIX.cards, names: [] });
    expect(service.write.apply).toHaveBeenCalledTimes(1);
  });

  test("not paused, the same build fails where it should (drift stops before any write)", async () => {
    const service = fakeService({ spec: drifted(), inspect: pausedBuild, attention: pausedAttention() });
    const checks = await go(service, LIVE, []);
    expect(by(checks, "draft + answers").ok).toBe(false);
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("paused with paused values in the file: they are checked (pass and mismatch)", async () => {
    const withPaused = (countsWhenPaused: Record<string, number>, totals: Record<string, unknown>) =>
      oneshotExpectSchema.parse({
        ...BASE_EXPECT,
        apply: { ...BASE_EXPECT.apply, countsWhenPaused },
        after: [{ path: PATH, base: { cards: 100 }, whenPaused: { base: { cards: 90, linked: { sportlots: false } } } }],
        attention: { ...MEASURED, whenPaused: { totals } },
      });
    const service = () => fakeService({ spec: drifted(), counts: { reconciled: 1, grouped: 0, committed: 90, built: 90 }, inspect: pausedBuild, attention: pausedAttention() });
    const ok = await go(service(), withPaused({ committed: 90 }, { cards: 2, byKind: { missingTeam: 1, titleTruncated: 1 }, namesToCheck: 0 }), ["sportlots"]);
    expect(ok.filter((c) => !c.ok)).toEqual([]);
    expect(by(ok, "nb_apply").detail).toMatch(/^committed 90 in 9s; not checked \(sportlots paused\): counts\.reconciled, counts\.grouped, counts\.built$/);
    expect(by(ok, "after").detail).toBe("as expected");

    const bad = await go(service(), withPaused({ committed: 91 }, { cards: 3, byKind: {}, namesToCheck: 0 }), ["sportlots"]);
    expect(by(bad, "nb_apply")).toMatchObject({ ok: false });
    expect(by(bad, "nb_apply").detail).toMatch(/^counts\.committed is 90, expected 91 with sportlots paused/);
  });

  test("paused: a stop in the apply still fails", async () => {
    const service = fakeService({ spec: drifted(), inspect: pausedBuild, attention: pausedAttention() });
    service.write.apply.mockResolvedValueOnce({ counts: {}, durationMs: 1, stops: [{ step: 0, reason: "Base: the entity review has rows the spec does not answer" }], setLinks: [{ path: SCOPE, link: SET_LINK, attention: SUMMARY }], attentionLine: "x" } as never);
    const checks = await go(service, LIVE, ["sportlots"]);
    expect(by(checks, "nb_apply")).toMatchObject({ ok: false });
    expect(by(checks, "nb_apply").detail).toMatch(/^stopped at step 0: Base: the entity review/);
  });

  test("a paused count in the committed spec is its own measurement: the live digest check ignores it", () => {
    const committed = structuredClone(PAUSED_ANSWERS) as unknown as {
      steps: Array<{ variants: Array<Record<string, unknown> & { rows: Array<Record<string, unknown>> }> }>;
    };
    Object.assign(committed.steps[0].variants[1], { expectRows: 1, expectRowsWhenPaused: 2 });
    Object.assign(committed.steps[0].variants[1].rows[0], { expectCards: 5, expectCardsWhenPaused: 4 });
    const drafted = structuredClone(PAUSED_ANSWERS) as unknown as typeof committed;
    Object.assign(drafted.steps[0].variants[1], { expectRows: 1 });
    Object.assign(drafted.steps[0].variants[1].rows[0], { expectCards: 5 });
    expect(compareDraft(drafted, committed).restSame).toBe(true);
    // A live count that differs still fails.
    Object.assign(drafted.steps[0].variants[1].rows[0], { expectCards: 6 });
    expect(compareDraft(drafted, committed).restDiffers).toEqual(["steps[0].variants[1].rows[0].expectCards"]);
  });

  test("specBuiltFromBase, specAutographRows and fixForRun read the committed spec and answers", () => {
    expect([...specBuiltFromBase(PAUSED_ANSWERS, "Parallel")]).toEqual(["Gold"]);
    expect(specAutographRows(PAUSED_ANSWERS)).toEqual([{ label: "Insert › Future Stars", row: { type: "Insert", name: "Future Stars" }, format: "On Card" }]);
    const fix = { ...FIX, detach: [{ side: "bsc", id: "x" }] } as never;
    expect(fixForRun(fix, [])).toEqual({ fix, dropped: [] });
    expect(fixForRun(fix, ["sportlots"])).toEqual({
      fix: { ...FIX, names: [], detach: [{ side: "bsc", id: "x" }] },
      dropped: ["names[0] (sportlots)"],
    });
  });

  test("the committed fixture still parses", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(new URL("../../playwright/seed/oneshot.expect.json", import.meta.url), "utf8"));
    expect(oneshotExpectSchema.safeParse(raw).success).toBe(true);
  });
});
