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
import { compareDraft, differingPaths, NOT_MEASURED, oneshotExpectSchema, runOneshotSequence, type OneshotExpect } from "./mcp-oneshot";
import { specConfirmPhrase, type InspectReport, type OpenDecisions, type SetBuildService } from "./service";
import { parseSpec } from "./spec/schema";

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

const built: InspectReport = {
  target: { convexUrl: TARGET.convexUrl, host: TARGET.host },
  path: PATH,
  pathText: SCOPE,
  found: true,
  base: { name: "Base", cards: 100, isBase: true, links: { buysportscards: ["b"], sportlots: ["s"] }, link: "/admin/set-builder" },
  variantTypes: [
    {
      type: "Insert",
      link: "/admin/set-builder",
      rows: [
        {
          name: "Future Stars",
          cards: 10,
          isBase: false,
          links: { buysportscards: ["fs"], sportlots: [] },
          link: "/admin/set-builder",
          parallels: [{ name: "Future Stars Gold", cards: 10, isBase: false, links: { buysportscards: ["fsg"], sportlots: [] }, link: "/admin/set-builder" }],
        },
      ],
    },
    { type: "Parallel", link: "/admin/set-builder", rows: [{ name: "Gold", cards: 100, isBase: false, links: { buysportscards: ["g"], sportlots: [] }, link: "/admin/set-builder" }] },
  ],
};

const EXPECT: OneshotExpect = oneshotExpectSchema.parse({
  path: PATH,
  apply: { counts: { reconciled: 2, grouped: 1, committed: 110, built: 110 } },
});

function fakeService(o: { spec?: unknown; open?: OpenDecisions; counts?: Record<string, number> } = {}) {
  return {
    target: TARGET,
    read: {
      inspect: vi.fn(async () => built),
      plan: vi.fn(async () => ({ scope: SCOPE, confirmPhrase: PHRASE, steps: [{}], openDecisions: none() })),
      reviewItems: vi.fn(),
      draftSet: vi.fn(async () => ({
        status: "drafted",
        spec: o.spec ?? DRAFTED,
        template: null,
        openDecisions: o.open ?? none(),
        proposals: [],
        marketplaceCalls: 12,
        durationMs: 3000,
      })),
    },
    write: {
      apply: vi.fn(async () => ({ counts: o.counts ?? { reconciled: 2, grouped: 1, committed: 110, built: 110, skipped: 0 }, durationMs: 9000 })),
      decide: vi.fn(),
      buildParallel: vi.fn(),
      slReviewApply: vi.fn(),
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

const run = (service: ReturnType<typeof fakeService>, expect: OneshotExpect = EXPECT) =>
  connect(service).then((client) =>
    runOneshotSequence(client, { answersPath: "/oneshot.spec.json", answers: ANSWERS, expect, confirm: PHRASE }),
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
      "review answers",
      "nb_plan",
      "nb_apply",
      "insert with a built parallel",
      "Parallel rows built from Base",
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
    expect(draft.detail).toContain("1 open decision(s), 0 of them card conflicts / review names for the committed spec to answer; 1 the draft should have settled (Base sportlots at steps[0].base.map.sportlots)");
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
    const ok = await runOneshotSequence(client, { answersPath: "/oneshot.spec.json", answers: answered, expect: EXPECT, confirm: PHRASE });
    expect(ok.find((c) => c.label === "nb_draft_set")).toMatchObject({ ok: true });
    expect(ok.find((c) => c.label === "draft + answers")).toMatchObject({ ok: true });
    // The committed spec without the answer leaves a fill-in: fail.
    const bad = await runOneshotSequence(await connect(service), { answersPath: "/oneshot.spec.json", answers: DRAFTED, expect: EXPECT, confirm: PHRASE });
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
    const ok = await runOneshotSequence(client, { answersPath: "/oneshot.spec.json", answers: committed, expect: EXPECT, confirm: PHRASE });
    expect(ok.find((c) => c.label === "review answers")).toMatchObject({ ok: true, detail: "drafted 1 / committed 2, 1 committed-only (moot or lookup-staged)" });

    const fail = fakeService({ spec: withReview([{ name: "Rookie New", decision: "create" }]) });
    const bad = await runOneshotSequence(await connect(fail), { answersPath: "/oneshot.spec.json", answers: committed, expect: EXPECT, confirm: PHRASE });
    expect(bad.find((c) => c.label === "review answers")!.ok).toBe(false);
    expect(fail.write.apply).not.toHaveBeenCalled();
  });
});
