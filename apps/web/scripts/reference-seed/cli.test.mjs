// NEO-330 — the CLI front door: argument parsing and the refusals that must
// fire before anything is spawned. `main` never calls process.exit, so these
// call it directly. node:child_process is wrapped (not replaced) so a test can
// prove that a refusal returned before the Convex CLI (`npx`) was ever started.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync), spawn: vi.fn(actual.spawn) };
});

import { spawn, spawnSync } from "node:child_process";
import { PROD_DEPLOYMENT_NAME, makeTempDir, zipDir } from "./lib.mjs";
import { main, parseArgs, RefusedError, UsageError, SELECTOR_DEPENDANT_TABLES, SELECTOR_DEPENDANT_UNDRAINED_TABLES } from "./cli.mjs";
import { BUNDLE_TABLES } from "./lib.mjs";
import schema from "../../convex/schema";
import { makeFixtureExport } from "./make-fixture.mjs";

let dir;
let bundleZip;
let brokenZip;

beforeAll(async () => {
  dir = makeTempDir("cli-test");
  const fx = makeFixtureExport(path.join(dir, "export.zip"));
  bundleZip = path.join(dir, "bundle.zip");
  expect(await main(["build", fx.path, bundleZip], { log: () => {}, error: () => {} })).toBe(0);

  // A ZIP that is not a bundle: a table outside the eight.
  const staging = path.join(dir, "broken");
  mkdirSync(path.join(staging, "_tables"), { recursive: true });
  mkdirSync(path.join(staging, "users"), { recursive: true });
  writeFileSync(path.join(staging, "_tables", "documents.jsonl"), '{"name":"users","id":10001}\n');
  writeFileSync(path.join(staging, "users", "documents.jsonl"), "");
  brokenZip = path.join(dir, "broken.zip");
  zipDir(staging, brokenZip);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const io = () => {
  const out = [];
  const err = [];
  return { out, err, log: (s) => out.push(s), error: (s) => err.push(s) };
};

/** Commands the run spawned, as "bin" (zip/unzip are fine; npx is the Convex CLI). */
const spawned = () => [...spawnSync.mock.calls, ...spawn.mock.calls].map((c) => c[0]);

function setTty(value) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

let ttyBefore;
beforeEach(() => {
  ttyBefore = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  spawnSync.mockClear();
  spawn.mockClear();
});
afterEach(() => {
  if (ttyBefore) Object.defineProperty(process.stdin, "isTTY", ttyBefore);
  else delete process.stdin.isTTY;
});

describe("parseArgs", () => {
  test("build and check take their positional paths", () => {
    expect(parseArgs(["build", "e.zip", "b.zip"])).toEqual({ cmd: "build", exportZip: "e.zip", bundleZip: "b.zip" });
    expect(parseArgs(["check", "b.zip"])).toEqual({ cmd: "check", zip: "b.zip" });
  });

  test("load needs a deployment and a sports mode, and accepts =value form", () => {
    expect(parseArgs(["load", "b.zip", "--deployment=happy-animal-123", "--sports", "remap", "--dry-run", "-y"])).toEqual({
      cmd: "load",
      bundle: "b.zip",
      deployment: "happy-animal-123",
      sports: "remap",
      dryRun: true,
      yes: true,
    });
    expect(() => parseArgs(["load", "b.zip", "--sports", "import"])).toThrow(UsageError);
    expect(() => parseArgs(["load", "b.zip", "--deployment", "happy-animal-123"])).toThrow(/--sports/);
    expect(() => parseArgs(["load", "b.zip", "--deployment", "happy-animal-123", "--sports", "both"])).toThrow(UsageError);
  });

  test.each([
    [["load", "b.zip", "--deployment", "happy-animal-123", "--sports", "import", "--prod"]],
    [["load", "b.zip", "--prod=true", "--deployment", "happy-animal-123", "--sports", "import"]],
    [["clear", "--deployment", "happy-animal-123", "--prod"]],
  ])("refuses --prod anywhere: %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow(RefusedError);
  });

  test("--prod in command position is refused like any other --prod (never runs)", () => {
    expect(() => parseArgs(["--prod"])).toThrow(RefusedError);
  });

  test("rejects unknown commands, unknown flags and flags a command does not take", () => {
    expect(() => parseArgs([])).toThrow(/no command/);
    expect(() => parseArgs(["frobnicate"])).toThrow(/unknown command/);
    expect(() => parseArgs(["check", "b.zip", "--bogus"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["check", "b.zip", "--yes"])).toThrow(/takes no --yes/);
    expect(() => parseArgs(["build", "e.zip", "b.txt"])).toThrow(/\.zip/);
    expect(() => parseArgs(["clear", "x"])).toThrow(/no positional/);
  });

  test("a flag that wants a value does not swallow the next flag", () => {
    expect(() => parseArgs(["clear", "--deployment", "--yes"])).toThrow(/requires a value/);
  });
});

describe("main: refusals return before the Convex CLI is spawned", () => {
  test("--prod exits 3 and spawns nothing", async () => {
    const o = io();
    const code = await main(["load", bundleZip, "--deployment", "happy-animal-123", "--sports", "import", "--prod", "--yes"], { env: {}, ...o });
    expect(code).toBe(3);
    expect(o.err.join("\n")).toMatch(/--prod is never allowed/);
    expect(spawned()).toEqual([]);
  });

  test("no TTY and no --yes exits 3 for load, and for clear, before any convex call", async () => {
    setTty(false);
    for (const argv of [
      ["load", bundleZip, "--deployment", "happy-animal-123", "--sports", "import"],
      ["clear", "--deployment", "happy-animal-123"],
    ]) {
      spawnSync.mockClear();
      spawn.mockClear();
      const o = io();
      const code = await main(argv, { env: {}, ...o });
      expect(code, argv[0]).toBe(3);
      expect(o.err.join("\n")).toMatch(/no TTY to confirm on/);
      expect(spawned().filter((b) => b === "npx"), argv[0]).toEqual([]);
    }
  });

  test.each([
    ["the production slug", PROD_DEPLOYMENT_NAME],
    ["a prod: prefix", "prod:happy-animal-123"],
    ["a dev: prefix", "dev:happy-animal-123"],
    ["not a plain name", "Happy Animal"],
  ])("a --deployment that is %s exits 3 even with --yes and --dry-run, and spawns no npx", async (_label, name) => {
    for (const cmd of [
      ["load", bundleZip, "--deployment", name, "--sports", "import", "--dry-run"],
      ["load", bundleZip, "--deployment", name, "--sports", "remap", "--yes"],
      ["clear", "--deployment", name, "--yes"],
    ]) {
      spawnSync.mockClear();
      spawn.mockClear();
      const o = io();
      expect(await main(cmd, { env: {}, ...o }), cmd.join(" ")).toBe(3);
      expect(spawned().filter((b) => b === "npx")).toEqual([]);
    }
  });

  test.each([
    ["a prod: key", "prod:happy-animal-123|tok"],
    ["a project: key", "project:acme|tok"],
    ["a key naming the production slug", `dev:${PROD_DEPLOYMENT_NAME}|tok`],
    ["a dev key for another deployment", "dev:other-animal-9|tok"],
  ])("%s in the environment exits 3 and spawns no npx", async (_label, key) => {
    const o = io();
    const code = await main(["load", bundleZip, "--deployment", "happy-animal-123", "--sports", "import", "--dry-run"], { env: { CONVEX_DEPLOY_KEY: key }, ...o });
    expect(code).toBe(3);
    expect(spawned().filter((b) => b === "npx")).toEqual([]);
    expect(o.err.join("\n")).not.toContain(key);
  });

  test("CONVEX_SELF_HOSTED_URL is refused before any convex call", async () => {
    const o = io();
    const code = await main(["clear", "--deployment", "happy-animal-123", "--yes"], { env: { CONVEX_SELF_HOSTED_URL: "http://x" }, ...o });
    expect(code).toBe(3);
    expect(spawned().filter((b) => b === "npx")).toEqual([]);
  });

  test("the fixture bundle (under the floors) exits 3 as hollow before any spawn of npx", async () => {
    const o = io();
    const code = await main(["load", bundleZip, "--deployment", "happy-animal-123", "--sports", "import", "--dry-run"], {
      env: { CONVEX_DEPLOY_KEY: "dev:happy-animal-123|tok" },
      ...o,
    });
    expect(code).toBe(3);
    expect(o.err.join("\n")).toMatch(/too hollow/);
    expect(o.out.join("\n")).toMatch(/too few rows: players: 3/);
    expect(spawned().filter((b) => b === "npx")).toEqual([]);
  });

  test("a bundle that fails its own check is refused with exit 3, not loaded", async () => {
    // A dev key gets past the name and key guards without the dashboard probe
    // (which would spawn npx); the broken bundle is then refused next.
    const o = io();
    const code = await main(["load", brokenZip, "--deployment", "happy-animal-123", "--sports", "import", "--dry-run"], {
      env: { CONVEX_DEPLOY_KEY: "dev:happy-animal-123|tok" },
      ...o,
    });
    expect(code).toBe(3);
    expect(o.err.join("\n")).toMatch(/fails its own check/);
    expect(spawned().filter((b) => b === "npx")).toEqual([]);
  });
});

describe("main: usage and check", () => {
  test("a usage error exits 2 and prints the usage", async () => {
    const o = io();
    expect(await main(["load"], { env: {}, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/usage:/);
  });

  test("check exits 0 on the built bundle and 1 on a ZIP that fails", async () => {
    const good = io();
    expect(await main(["check", bundleZip], good)).toBe(0);
    expect(good.out.join("\n")).toMatch(/check: ok \(bundle\)/);
    const bad = io();
    expect(await main(["check", brokenZip], bad)).toBe(1);
    expect(bad.out.join("\n")).toMatch(/PROBLEM: unexpected table users/);
  });

  test("check on a missing file is a failure (1), not a crash", async () => {
    const o = io();
    expect(await main(["check", path.join(dir, "nope.zip")], o)).toBe(1);
  });
});

/** Every table in the schema export with a field that is an id into `target`. */
function tablesPointingInto(exported, target) {
  const found = new Set();
  const walk = (node, table) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "id" && node.tableName === target) found.add(table);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((x) => walk(x, table));
      else walk(v, table);
    }
  };
  for (const t of exported.tables) walk(t.documentType, t.tableName);
  return found;
}

describe("selectorOptions dependants vs convex/schema.ts", () => {
  const exported = JSON.parse(schema.export());
  const dependants = [...tablesPointingInto(exported, "selectorOptions")].filter((t) => !BUNDLE_TABLES.includes(t)).sort();

  test("the schema walk finds the dependants it should (guards the walker itself)", () => {
    expect(dependants).toEqual(expect.arrayContaining(["cardChecklist", "slSetReviews"]));
    expect(tablesPointingInto(exported, "selectorOptions").has("leagues")).toBe(true);
  });

  test("every table holding a selectorOptions id is in exactly one of the two lists, so a new table cannot slip past the import guard", () => {
    const listed = [...SELECTOR_DEPENDANT_TABLES, ...SELECTOR_DEPENDANT_UNDRAINED_TABLES];
    expect([...listed].sort()).toEqual(dependants);
    expect(new Set(listed).size).toBe(listed.length);
  });

  test("none of the listed tables is in the reference set", () => {
    for (const t of [...SELECTOR_DEPENDANT_TABLES, ...SELECTOR_DEPENDANT_UNDRAINED_TABLES]) expect(BUNDLE_TABLES).not.toContain(t);
  });
});
