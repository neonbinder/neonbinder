// Tiny coverage for the NEO-310 matrix-leg-listing script. Stubs `gh` on
// PATH — no real GitHub API call, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "discord-notify-failed-legs.sh");

function makeGhStub({ ok = true, jobsJson = { jobs: [] } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nb-gh-legs-stub-"));
  const stub = ok
    ? `#!/usr/bin/env bash\nset -eo pipefail\necho '${JSON.stringify(jobsJson)}'\nexit 0\n`
    : `#!/usr/bin/env bash\nexit 1\n`;
  const ghPath = join(dir, "gh");
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);
  return dir;
}

function run(args, stubOpts) {
  const stubDir = makeGhStub(stubOpts);
  const result = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, GITHUB_RUN_ID: "123" },
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("lists only the failed legs matching the prefix, in order", () => {
  const r = run(["GC ", "gc"], {
    jobsJson: {
      jobs: [
        { name: "GC neonbinder-browser dev", conclusion: "success" },
        { name: "GC neonbinder-browser prod", conclusion: "failure" },
        { name: "GC neonbinder-preprocess dev", conclusion: "success" },
        { name: "GC neonbinder-preprocess prod", conclusion: "failure" },
        { name: "Notify Discord", conclusion: "success" },
      ],
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout.trim(),
    "failed-legs=GC neonbinder-browser prod, GC neonbinder-preprocess prod",
  );
});

test("falls back to the plain name when nothing matches", () => {
  const r = run(["GC ", "gc"], { jobsJson: { jobs: [{ name: "Notify Discord", conclusion: "failure" }] } });
  assert.equal(r.stdout.trim(), "failed-legs=gc");
});

test("falls back to the plain name when `gh run view` itself fails", () => {
  const r = run(["GC ", "gc"], { ok: false });
  assert.equal(r.stdout.trim(), "failed-legs=gc");
});
