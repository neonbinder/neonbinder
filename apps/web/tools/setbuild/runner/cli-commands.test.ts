import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

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

import { main, type CliIO } from "../cli";
import { parsePathArg } from "./cli-commands";

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

describe("setbuild apply", () => {
  test("without --confirm (no TTY) it names the phrase and exits 2 before any network call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setbuild-"));
    const spec = join(dir, "spec.json");
    await writeFile(spec, JSON.stringify({ version: 1, scope: "e2e-baseline", steps: [] }));
    const a = io(ENV);
    const stdinTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      expect(await main(["apply", "--spec", spec], a)).toBe(2);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: stdinTty, configurable: true });
    }
    expect(a.err.join("\n")).toContain('--confirm "BUILD happy-otter-123.convex.cloud e2e-baseline"');
    expect(fetchSpy.calls).toBe(0);
  });

  test("a wrong --confirm is refused before any network call, and no secret is printed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setbuild-"));
    const spec = join(dir, "spec.json");
    await writeFile(spec, JSON.stringify({ version: 1, scope: "e2e-baseline", steps: [] }));
    const a = io(ENV);
    expect(await main(["apply", "--spec", spec, "--confirm", "BUILD prod.convex.cloud e2e-baseline"], a)).toBe(1);
    expect(a.err.join("\n")).toMatch(/ConfirmMismatch/);
    expect([...a.out, ...a.err].join("\n")).not.toContain("ak_secret_value");
    expect(fetchSpy.calls).toBe(0);
  });

  test("a missing --spec is a usage error", async () => {
    const a = io(ENV);
    expect(await main(["plan"], a)).toBe(2);
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
