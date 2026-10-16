import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fetchSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("convex/browser", () => {
  class ConvexClient {
    setAuth() {}
    async query() {
      fetchSpy.calls++;
      throw new Error("no network in this test");
    }
    async close() {}
  }
  class ConvexHttpClient {}
  return { ConvexClient, ConvexHttpClient };
});

import { fakeJwt, publishableKeyFor } from "../auth/test-helpers";
import { main, type CliIO } from "../cli";
import { parseTarget } from "../client/target";
import { specConfirmPhrase } from "../service";
import { parseSpec } from "../spec/schema";
import { BUILD_SET_NEEDS_TTY, draftMarkdown, MACHINE_NEEDS_TTY, parsePathArg } from "./cli-commands";
import { compactDraftReport } from "./draft";
import type { DraftedReport } from "../service";

function io(env: NodeJS.ProcessEnv = {}): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, env, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

const ENV = {
  NB_SETBUILD_CONVEX_URL: "https://happy-otter-123.convex.cloud",
  NB_SETBUILD_AUTH: "machine",
  NB_SETBUILD_API_KEY: "ak_secret_value",
};

describe("parsePathArg", () => {
  test("brand-year and set paths; a set name may carry a slash", () => {
    expect(parsePathArg("Baseball/2024/Topps")).toEqual({ sport: "Baseball", year: "2024", manufacturer: "Topps" });
    expect(parsePathArg("Baseball/2024/Topps/Topps Chrome")).toMatchObject({ set: "Topps Chrome" });
    expect(parsePathArg("Baseball/2024/Topps/Chrome / Update")).toMatchObject({ set: "Chrome / Update" });
    expect(() => parsePathArg("Baseball/2024")).toThrow();
  });
});

/**
 * Every HTTP request the CLI makes (the token mint is the first thing past the
 * confirm gate) lands here and is refused with a 401, which no token source
 * retries. Nothing reaches a real server; a call here means "past the gate".
 */
const net = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ error: "refused in this test" }), { status: 401 }));
/** Calls that could only happen after the confirm gate: HTTP + Convex. */
const sent = () => net.mock.calls.length + fetchSpy.calls;

beforeEach(() => {
  fetchSpy.calls = 0;
  net.mockReset();
  net.mockImplementation(async () => new Response(JSON.stringify({ error: "refused in this test" }), { status: 401 }));
  vi.stubGlobal("fetch", net);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const TESTING_ENV = {
  NB_SETBUILD_CONVEX_URL: "https://happy-otter-123.convex.cloud",
  NB_SETBUILD_AUTH: "testing",
  NB_SETBUILD_APP_URL: "http://localhost:3005",
  TESTING_ENDPOINT_SECRET: "tes_secret_value_123",
  VITE_CLERK_PUBLISHABLE_KEY: publishableKeyFor("foo-bar-1.clerk.accounts.dev"),
};

const SPEC = { version: 1, scope: "e2e-baseline", steps: [] };
const PHRASE = specConfirmPhrase(parseTarget("https://happy-otter-123.convex.cloud"), parseSpec(SPEC));

async function specFile(content: unknown = SPEC): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "setbuild-"));
  const spec = join(dir, "spec.json");
  await writeFile(spec, JSON.stringify(content));
  return spec;
}

/** An io with a terminal: `prompt` answers with `answer` and records the question. */
function ttyIo(env: NodeJS.ProcessEnv, answer: string) {
  const a = io(env);
  const asked: string[] = [];
  return Object.assign(a, {
    asked,
    prompt: async (q: string) => {
      asked.push(q);
      return answer;
    },
  });
}

describe("setbuild apply", () => {

  test("the phrase carries the spec's digest: BUILD <host> <scope> <8 hex>", () => {
    expect(PHRASE).toMatch(/^BUILD happy-otter-123\.convex\.cloud e2e-baseline [0-9a-f]{8}$/);
  });

  test("testing auth without --confirm (no TTY) names the phrase and exits 2 before any network call", async () => {
    const a = io(TESTING_ENV);
    expect(await main(["apply", "--spec", await specFile()], a)).toBe(2);
    expect(a.err.join("\n")).toContain(`--confirm "${PHRASE}"`);
    expect(sent()).toBe(0);
  });

  test("testing auth with a wrong --confirm is refused before any network call, and no secret is printed", async () => {
    const a = io(TESTING_ENV);
    for (const wrong of ["BUILD prod.convex.cloud e2e-baseline 00000000", PHRASE.slice(0, -1) + "x", PHRASE.slice(0, -9)]) {
      expect(await main(["apply", "--spec", await specFile(), "--confirm", wrong], a)).toBe(1);
    }
    expect(a.err.join("\n")).toMatch(/ConfirmMismatch/);
    expect([...a.out, ...a.err].join("\n")).not.toContain("tes_secret_value_123");
    expect(sent()).toBe(0);
  });

  test("testing auth with the right --confirm gets past the gate (and is not prompted)", async () => {
    const a = ttyIo(TESTING_ENV, "never asked");
    await main(["apply", "--spec", await specFile(), "--confirm", PHRASE], a);
    expect(a.asked).toEqual([]);
    expect(sent()).toBeGreaterThan(0);
  });

  test("machine auth without a terminal refuses even a correct --confirm, before any network call", async () => {
    const a = io(ENV);
    expect(await main(["apply", "--spec", await specFile(), "--confirm", PHRASE], a)).toBe(2);
    expect(a.err.join("\n")).toContain(MACHINE_NEEDS_TTY);
    expect(a.err.join("\n")).toMatch(/operator in a terminal|MCP tools/);
    expect([...a.out, ...a.err].join("\n")).not.toContain("ak_secret_value");
    expect(sent()).toBe(0);
  });

  test("machine auth ignores --confirm and checks what the operator types at the prompt", async () => {
    const wrong = ttyIo(ENV, "BUILD happy-otter-123.convex.cloud e2e-baseline 00000000");
    expect(await main(["apply", "--spec", await specFile(), "--confirm", PHRASE], wrong)).toBe(1);
    expect(wrong.err.join("\n")).toMatch(/--confirm is ignored with --auth machine/);
    expect(wrong.err.join("\n")).toContain(PHRASE);
    expect(wrong.asked).toHaveLength(1);
    expect(sent()).toBe(0);

    const right = ttyIo(ENV, ` ${PHRASE} `);
    await main(["apply", "--spec", await specFile()], right);
    expect(right.asked).toHaveLength(1);
    expect(right.err.join("\n")).toContain("WRITES to happy-otter-123.convex.cloud");
    expect(sent()).toBeGreaterThan(0);
  });

  test("--paused-platforms is accepted and reaches the run; it defaults to env PAUSED_PLATFORMS", async () => {
    const spec = await specFile();
    const flag = io(TESTING_ENV);
    expect(await main(["apply", "--spec", spec, "--confirm", PHRASE, "--paused-platforms", "bogus-site"], flag)).toBe(1);
    expect(flag.err.join("\n")).toContain('unknown platform "bogus-site"');

    const fromEnv = io({ ...TESTING_ENV, PAUSED_PLATFORMS: "bogus-env" });
    expect(await main(["plan", "--spec", spec], fromEnv)).toBe(1);
    expect(fromEnv.err.join("\n")).toContain('unknown platform "bogus-env"');

    // An explicit flag (even "") wins over the env.
    const override = io({ ...TESTING_ENV, PAUSED_PLATFORMS: "bogus-env" });
    expect(await main(["plan", "--spec", spec, "--paused-platforms", ""], override)).toBe(1);
    expect(override.err.join("\n")).not.toContain("bogus-env");
    expect(sent()).toBeGreaterThan(0);
  });

  test("a failed run's report files and error are scrubbed of secrets and JWT-shaped strings", async () => {
    const jwt = fakeJwt({ sub: "user_abc", aud: "convex", exp: 1_900_000_000 });
    net.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: `upstream echoed ${jwt} and tes_secret_value_123` }), { status: 401 }),
    );
    const spec = await specFile();
    const report = join(dirname(spec), "report.json");
    const a = io(TESTING_ENV);
    expect(await main(["apply", "--spec", spec, "--confirm", PHRASE, "--report", report], a)).toBe(1);
    const written = [await readFile(report, "utf8"), await readFile(join(dirname(spec), "report.md"), "utf8")];
    for (const text of [...written, a.err.join("\n"), a.out.join("\n")]) {
      expect(text).not.toContain(jwt);
      expect(text).not.toContain("tes_secret_value_123");
    }
    // The failure is still reported, with the token replaced, not dropped.
    expect(JSON.parse(written[0]).stoppedAt.reason).toMatch(/^failed: .*\[redacted-token\]/);
    // The report so far is printed too, not only written to --report.
    expect(a.out.join("\n")).toMatch(/failed: .*\[redacted-token\]/);
  });

  test("a missing --spec is a usage error", async () => {
    const a = io(ENV);
    expect(await main(["plan"], a)).toBe(2);
  });
});

describe("setbuild confirm-phrase", () => {

  test("prints the exact phrase apply and nb_plan use, offline, with no auth configured", async () => {
    const a = io();
    expect(
      await main(["confirm-phrase", "--spec", await specFile(), "--convex-url", "https://happy-otter-123.convex.cloud"], a),
    ).toBe(0);
    expect(a.out).toEqual([PHRASE]);
    expect(sent()).toBe(0);
  });

  test("the digest follows the spec's content, not its key order", async () => {
    const reordered = io();
    await main(
      ["confirm-phrase", "--spec", await specFile({ steps: [], scope: "e2e-baseline", version: 1 }), "--convex-url", "https://happy-otter-123.convex.cloud"],
      reordered,
    );
    expect(reordered.out).toEqual([PHRASE]);
    const other = io();
    await main(
      ["confirm-phrase", "--spec", await specFile({ ...SPEC, scope: "other-scope" }), "--convex-url", "https://happy-otter-123.convex.cloud"],
      other,
    );
    expect(other.out[0]).toMatch(/^BUILD happy-otter-123\.convex\.cloud other-scope [0-9a-f]{8}$/);
    expect(other.out[0].slice(-8)).not.toBe(PHRASE.slice(-8));
  });

  test("--json; a missing URL is a usage error; an invalid spec fails", async () => {
    const j = io({ NB_SETBUILD_CONVEX_URL: "https://happy-otter-123.convex.cloud" });
    expect(await main(["confirm-phrase", "--spec", await specFile(), "--json"], j)).toBe(0);
    expect(JSON.parse(j.out.join("\n"))).toEqual({
      phrase: PHRASE,
      host: "happy-otter-123.convex.cloud",
      scope: "e2e-baseline",
      digest: PHRASE.slice(-8),
    });
    expect(await main(["confirm-phrase", "--spec", await specFile()], io())).toBe(2);
    expect(await main(["confirm-phrase", "--spec", await specFile({ version: 2 }), "--convex-url", "https://x-1.convex.cloud"], io())).toBe(1);
    expect(sent()).toBe(0);
  });
});

describe("setbuild schema", () => {
  test("prints the spec's JSON Schema", async () => {
    const a = io();
    expect(await main(["schema"], a)).toBe(0);
    const schema = JSON.parse(a.out.join("\n"));
    expect(JSON.stringify(schema)).toContain("SetBuildSpec");
  });
});

describe("setbuild draft-set / build-set", () => {
  const SET = "Baseball/2024/Topps/Topps Chrome Black";

  test("build-set without a terminal is refused before any network call, under either auth", async () => {
    for (const env of [ENV, TESTING_ENV]) {
      const a = io(env);
      expect(await main(["build-set", "--path", SET], a)).toBe(2);
      expect(a.err.join("\n")).toContain(BUILD_SET_NEEDS_TTY);
      expect([...a.out, ...a.err].join("\n")).not.toMatch(/ak_secret_value|tes_secret_value_123/);
    }
    expect(sent()).toBe(0);
  });

  test("build-set takes no --confirm: the phrase is only ever typed at its prompt", async () => {
    const a = ttyIo(ENV, "never asked");
    expect(await main(["build-set", "--path", SET, "--confirm", "BUILD x y 00000000"], a)).toBe(2);
    expect(a.err.join("\n")).toMatch(/confirm/);
    expect(sent()).toBe(0);
  });

  test("build-set on a terminal drafts first (read-only): no phrase is asked before the draft", async () => {
    const a = ttyIo(TESTING_ENV, "q");
    expect(await main(["build-set", "--path", SET], a)).toBe(1);
    expect(a.asked).toEqual([]);
    expect(sent()).toBeGreaterThan(0);
  });

  test("draft-set usage errors come before any network call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setbuild-draft-"));
    const out = join(dir, "draft.json");
    expect(await main(["draft-set", "--path", SET], io(ENV))).toBe(2);
    expect(await main(["draft-set", "--out", out], io(ENV))).toBe(2);
    expect(await main(["draft-set", "--path", "Baseball/2024/Topps", "--out", out], io(ENV))).toBe(2);
    expect(await main(["draft-set", "--path", SET, "--out", out, "--team-lookup-budget", "-1"], io(ENV))).toBe(2);
    expect(await main(["draft-set", "--path", SET, "--out", out, "--team-lookup-budget", "999999"], io(ENV))).toBe(2);
    expect(await main(["draft-set", "--path", SET, "--out", out, "--detail", "everything"], io(ENV))).toBe(2);
    expect(sent()).toBe(0);
  });

  test("draft-set is a read: it needs no phrase and no terminal, even with machine auth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setbuild-draft-"));
    const a = io(ENV);
    // The fake server refuses the sign-in, so the run fails past the gate.
    expect(await main(["draft-set", "--path", SET, "--out", join(dir, "draft.json")], a)).toBe(1);
    expect(sent()).toBeGreaterThan(0);
    expect(a.err.join("\n")).not.toContain("ak_secret_value");
  });
});

describe("draftMarkdown", () => {
  const report = {
    status: "drafted",
    target: { convexUrl: "https://happy-otter-123.convex.cloud", host: "happy-otter-123.convex.cloud" },
    path: { sport: "Baseball", year: "2014", manufacturer: "Topps", set: "Topps Chrome" },
    pathText: "Baseball/2014/Topps/Topps Chrome",
    scope: "Baseball/2014/Topps/Topps Chrome",
    spec: { version: 1, scope: "Baseball/2014/Topps/Topps Chrome", steps: [] },
    proposals: Array.from({ length: 12 }, (_, i) => ({ at: `steps[0].p${i}`, kind: "build", detail: `build row ${i}` })),
    openDecisions: { names: [], baseCandidates: [], reconcile: [], review: { players: [], teams: [], leagues: [] }, slReview: [], conflicts: [], grouping: [] },
    openCount: 0,
    template: null,
    confirmPhrase: null,
    steps: [],
    notes: [],
    leftUnasked: [
      {
        at: "steps[0].variants[0].sync.pending",
        type: "Insert",
        outsideScope: 970,
        pairedElsewhere: 2,
        outsideScopeSets: Array.from({ length: 970 }, (_, i) => ({ id: `9${i}`, name: `Heritage ${i}` })),
      },
    ],
    marketplaceCalls: 4,
    durationMs: 1000,
  } as unknown as DraftedReport;

  test("the summary prints the first few proposals, the full count and how to see the rest; full prints all", () => {
    const short = draftMarkdown(compactDraftReport(report));
    expect(short).toContain("### 12 proposals");
    expect(short).toContain("build row 4");
    expect(short).not.toContain("build row 5");
    expect(short).toContain("… and 7 more (build 12)");
    expect(short).toContain("970 SportLots set(s) outside this set's SportLots filter (90 Heritage 0;");
    expect(short).not.toContain("Heritage 5;");
    expect(short).toContain('detail "full"');
    const full = draftMarkdown(compactDraftReport(report, "full"));
    expect(full).toContain("build row 11");
    expect(full).toContain("Heritage 969");
    expect(full).not.toContain('detail "full"');
  });
});
