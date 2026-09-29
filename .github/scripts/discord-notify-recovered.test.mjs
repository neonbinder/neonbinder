// Tiny coverage for the NEO-310 recovery-check script. Stubs `gh` on PATH —
// no real GitHub API call, no network. Node built-ins only, matching the
// house style in scripts/*.test.mjs (see scripts/test/stubs.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "discord-notify-recovered.sh");

// Builds a `gh` stub that answers `gh run list ... --json conclusion,databaseId`
// with `runsJson`.
function makeGhStub(runsJson) {
  const dir = mkdtempSync(join(tmpdir(), "nb-gh-stub-"));
  writeFileSync(join(dir, "runs.json"), JSON.stringify(runsJson));
  const stub = `#!/usr/bin/env bash
set -eo pipefail
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "list" ]; then
  cat "${dir}/runs.json"
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`;
  const ghPath = join(dir, "gh");
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);
  return dir;
}

function run(args, { runsJson, runId = "999" }) {
  const stubDir = makeGhStub(runsJson);
  const result = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, GITHUB_RUN_ID: runId },
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("no previous completed run: not recovered", () => {
  const r = run(["revision-gc.yml", "schedule", "main"], { runsJson: [] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "recovered=false");
});

test("previous run succeeded: not recovered", () => {
  const r = run(["revision-gc.yml", "schedule", "main"], {
    runsJson: [{ conclusion: "success", databaseId: 100 }],
  });
  assert.equal(r.stdout.trim(), "recovered=false");
});

test("previous run failed: recovered", () => {
  const r = run(["revision-gc.yml", "schedule", "main"], {
    runsJson: [{ conclusion: "failure", databaseId: 100 }],
  });
  assert.equal(r.stdout.trim(), "recovered=true");
});

test("current run id is excluded even if gh includes it", () => {
  // Only row IS the current run (still shows up because the stub doesn't
  // implement --status filtering) — after excluding it there is no previous
  // run, so recovered must be false, not a false positive on its own row.
  const r = run(["revision-gc.yml", "schedule", "main"], {
    runsJson: [{ conclusion: "failure", databaseId: 999 }],
    runId: "999",
  });
  assert.equal(r.stdout.trim(), "recovered=false");
});
