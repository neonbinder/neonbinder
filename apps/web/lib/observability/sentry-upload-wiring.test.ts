// @vitest-environment node
/**
 * NEO-439 wiring guard. sentry-upload-gate.test.ts proves the predicate; this
 * proves vite.config.ts still USES it: that the Sentry plugin is the real one
 * only on a Vercel build, and the inert noop otherwise.
 *
 * Each case loads the REAL config with vite's own loader in a CHILD process.
 * That is deliberate: the config mutates process.env (`Object.assign(process.env,
 * loadEnv(...))`) and reads VERCEL at module scope, so an in-process load would
 * leak into other files and a second load could be served from cache. The child
 * gets a hermetic environment (no inherited SENTRY_*, no developer .env.local:
 * its cwd is an empty temp dir, which is where loadEnv looks). It only LOADS
 * the config; nothing is built and no build hook runs, so no release is created
 * and nothing is uploaded, and no token is needed. In the VERCEL=1 case the real
 * plugin is constructed, and its own SDK telemetry could fire from that; SENTRY_URL below keeps it off.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CONFIG_PATH = path.resolve(__dirname, "../../vite.config.ts");
const APP_ROOT = path.dirname(CONFIG_PATH);

// The child runs from a temp cwd, so hand it vite's ESM entry by absolute URL.
const VITE_ENTRY = pathToFileURL(
  path.join(
    path.dirname(createRequire(CONFIG_PATH).resolve("vite/package.json")),
    "dist/node/index.js",
  ),
).href;

const REAL_PLUGIN = "sentry-vite-plugin";
const NOOP_PLUGIN = "sentry-noop-plugin";

// Runs inside the child: load the config, flatten plugins, print the Sentry ones.
const CHILD_SCRIPT = `
const [viteEntry, configPath, appRoot] = process.argv.slice(1);
const { loadConfigFromFile } = await import(viteEntry);
const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" }, configPath, appRoot);
const flat = (list) => list.flat(Infinity).filter(Boolean);
const names = flat(loaded.config.plugins ?? []).map((p) => p.name);
console.log("PLUGINS:" + JSON.stringify(names.filter((n) => /sentry/.test(n))));
console.log("SOURCEMAP:" + JSON.stringify(loaded.config.build?.sourcemap));
`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function loadWiring(
  realEnv: Record<string, string>,
  envFiles: Record<string, string> = {},
): { plugins: string[]; sourcemap: unknown } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nb-sentry-wiring-"));
  tempDirs.push(cwd);
  for (const [file, body] of Object.entries(envFiles)) {
    fs.writeFileSync(path.join(cwd, file), body);
  }
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", CHILD_SCRIPT, VITE_ENTRY, CONFIG_PATH, APP_ROOT],
    {
      cwd,
      encoding: "utf8",
      timeout: 90_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        VITE_DEV_DISABLE_HTTPS: "1", // keep mkcert out of the load
        // Points the real plugin at a dead local address so its telemetry gate
        // (which only opens for sentry.io) stays closed. No production option.
        SENTRY_URL: "http://127.0.0.1:9",
        ...realEnv,
      },
    },
  );
  expect(result.status, `child failed:\n${result.stderr}`).toBe(0);
  const line = result.stdout.split("\n").find((l) => l.startsWith("PLUGINS:"));
  expect(line, `no PLUGINS line in:\n${result.stdout}`).toBeDefined();
  const smLine = result.stdout.split("\n").find((l) => l.startsWith("SOURCEMAP:"));
  expect(smLine, `no SOURCEMAP line in:\n${result.stdout}`).toBeDefined();
  return {
    plugins: JSON.parse(line!.slice("PLUGINS:".length)) as string[],
    sourcemap: JSON.parse(smLine!.slice("SOURCEMAP:".length)),
  };
}

function sentryPluginNames(
  realEnv: Record<string, string>,
  envFiles: Record<string, string> = {},
): string[] {
  return loadWiring(realEnv, envFiles).plugins;
}

describe("vite.config.ts Sentry upload wiring (NEO-439)", () => {
  it("uses the noop Sentry plugin when VERCEL is unset (a local build)", () => {
    expect(sentryPluginNames({})).toEqual([NOOP_PLUGIN]);
  });

  it.each(["", "0"])("uses the noop Sentry plugin when VERCEL=%j", (value) => {
    expect(sentryPluginNames({ VERCEL: value })).toEqual([NOOP_PLUGIN]);
  });

  it("uses the real Sentry plugin when VERCEL=1 (a hosted build)", () => {
    expect(sentryPluginNames({ VERCEL: "1" })).toEqual([REAL_PLUGIN]);
  });

  it("is not switched on by VERCEL=1 that only an env file carries", () => {
    const names = sentryPluginNames(
      {},
      { ".env.local": "VERCEL=1\nSENTRY_AUTH_TOKEN=dummy\n" },
    );
    expect(names).toEqual([NOOP_PLUGIN]);
  });

  it("emits source maps only when the real plugin is wired (it deletes them after upload)", () => {
    const off = loadWiring({});
    expect(off.plugins).toEqual([NOOP_PLUGIN]);
    expect(off.sourcemap).toBe(false);

    const envFileOnly = loadWiring({}, { ".env.local": "VERCEL=1\nSENTRY_AUTH_TOKEN=dummy\n" });
    expect(envFileOnly.plugins).toEqual([NOOP_PLUGIN]);
    expect(envFileOnly.sourcemap).toBe(false);

    const on = loadWiring({ VERCEL: "1" });
    expect(on.plugins).toEqual([REAL_PLUGIN]);
    expect(on.sourcemap).toBe(true);
  });
}, 120_000);
